import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { formatClock } from '../../src/lib/datetime'
import {
  arriveCheckin,
  issueInvite,
  leaveCheckin,
  MEMBER,
  OWNER,
  register,
  seedMember,
  todayCheckin,
  type Account,
} from './harness/api'
import { expectScreen, gotoHash, HASH, waitForScreen } from './harness/routes'
import { readStoredToken, signInAs } from './harness/session'
import { useStack } from './harness/stack'

/**
 * 阶段 3 的验收链路（03 §3），全程走界面：
 *
 *   首启建号 → 休息日呈现 → 打卡（印章）→ 刷新 → 重复打卡的提示 → 离开 → 主题切换
 *
 * 另加一条 reduced-motion：03 §7 把印章定为全应用唯一的仪式性动效，
 * 而需求 §4 说了系统要求减少动效时就得关——两件事必须能同时成立。
 *
 * 串行执行（describe.serial）：后一步依赖前一步留下的那个页面与会话，
 * 失败时后面的步骤直接跳过，而不是每条都报一个看不懂的错。
 *
 * owner 的会话跨步骤保留（localStorage 里的令牌），因此显式共用一个上下文——
 * Playwright 默认每条用例发一个全新上下文，等同于每次换一台设备。
 */

/** 亮色 / 暗色下 --c-stamp 的实际色值（tokens.css：印章本体，与 --c-overdue 分开命名） */
const STAMP_DARK = 'rgb(196, 85, 61)'
const STAMP_LIGHT = 'rgb(169, 59, 36)'

/** 印章的计算样式——用它来判断「压章动效到底跑没跑」 */
function stampStyle(
  page: Page,
  prop: 'animation-name' | 'animation-duration' | 'border-top-color',
): Promise<string> {
  return page
    .locator('.ta-checkin__stamp')
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), prop)
}

/** 把 '0s' / '0ms' / '520ms' 一律化成毫秒数 */
function toMs(value: string): number {
  const trimmed = value.trim()
  if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed)
  if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) * 1000
  return Number.NaN
}

test.describe.serial('打卡链路', () => {
  const stackOf = useStack()

  let ownerContext: BrowserContext
  let checkin: Page
  let ownerToken = ''
  /** 带外写入的那次到达（模拟另一台设备先打了卡） */
  let outOfBandArrivedAt = ''
  let outOfBandDayKey = ''

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({ locale: 'zh-CN' })
  })

  test.afterAll(async () => {
    await ownerContext?.close()
  })

  test('1. 首启建号 → 进打卡页，今天还没有到达记录 = 休息日', async () => {
    checkin = await ownerContext.newPage()
    await checkin.goto(`${stackOf().baseUrl}/`)
    await waitForScreen(checkin, 'setup')

    await checkin.getByLabel('用户名', { exact: true }).fill(OWNER.username)
    await checkin.getByLabel('显示名', { exact: true }).fill(OWNER.displayName)
    await checkin.getByLabel('密码', { exact: true }).fill(OWNER.password)
    await checkin.getByRole('button', { name: '创建 owner 并进入' }).click()
    await expectScreen(checkin, 'home')

    // 后面几步要带外打 API，需要这枚真实令牌
    ownerToken = (await readStoredToken(checkin)) ?? ''
    expect(ownerToken, '建号后本地应当持有令牌').not.toBe('')

    await checkin
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '打卡' })
      .click()
    await expectScreen(checkin, 'checkin')

    // 休息日呈现：不是错误态、不是空白，也不带评判（ADR-012 §5 / 01 FR1）
    await expect(checkin.locator('.ta-checkin__restMain')).toHaveText('尚未打卡')
    await expect(checkin.locator('.ta-checkin__streakNumber')).toHaveText('0')
    await expect(checkin.locator('.ta-checkin__totalNumber')).toHaveText('0')

    // 休息日正是打卡的起点：按钮就在这儿（02 §3 的流程图）
    await expect(checkin.getByRole('button', { name: '到达实验室' })).toBeVisible()
    await expect(checkin.getByRole('button', { name: '离开实验室' })).toHaveCount(0)
  })

  test('2. 重复打卡：带外已有一条到达，这个页面点下去必须如实说，而不是假装刚打上', async () => {
    // 带外写入一次到达（另一个标签页 / 另一台设备先打了卡）。
    // 关键：这个页面的缓存里 day 还是 null，它**不知道**——这正是幂等反馈要处理的情形。
    const outOfBand = await arriveCheckin(stackOf(), ownerToken)
    expect(outOfBand.created, '第一次到达应当是新写入的').toBe(true)
    outOfBandArrivedAt = outOfBand.day.arrivedAt
    outOfBandDayKey = outOfBand.day.dayKey

    const arrive = checkin.getByRole('button', { name: '到达实验室' })
    await expect(arrive, '页面还不知道带外那次到达，按钮应当还在').toBeVisible()
    await arrive.click()

    /*
     * 时刻用应用自己的格式化函数拼出来：这条断言要证的是「用的是哪一次到达」
     * （服务端那条既有记录），不是「格式长什么样」。
     * 注意同一分钟内「既有记录」与「此刻」长得一样，所以区分真假靠的是下面
     * 那条 animationName —— 假装刚打上就一定会重放压章动效。
     */
    await expect(checkin.getByRole('status')).toContainText(
      `你今天 ${formatClock(outOfBandArrivedAt)} 已经打过卡了`,
    )

    // 章出现了，但**没有**重放动效：仪式只属于真正落笔的那一下
    await expect(checkin.locator('.ta-checkin__stamp')).toBeVisible()
    expect(await stampStyle(checkin, 'animation-name'), '幂等命中不该压第二次章').toBe('none')
    await expect(checkin.locator('.ta-checkin__quote')).toHaveCount(0)
    await expect(checkin.locator('.ta-checkin__totalNumber')).toHaveText('1')

    // 界面显示的归属日就是服务端固化的那一个（凌晨归前一天之类都由它体现，前端不自己算）
    await expect(checkin.locator('.ta-checkin__fact', { hasText: '归属日' })).toContainText(
      outOfBandDayKey,
    )
    // 服务端也没有写第二条
    const state = await todayCheckin(stackOf(), ownerToken)
    expect(state.day?.arrivedAt, '幂等的到达不该写第二条事件').toBe(outOfBandArrivedAt)
    expect(state.streak, '连续天数由服务端算（前面带外那次到达已计入）').toBe(1)
    await expect(checkin.locator('.ta-checkin__streakNumber')).toHaveText('1')
  })

  test('3. 刷新：章还在、时刻不变，且不会重放压章动效', async () => {
    await checkin.reload()
    await expectScreen(checkin, 'checkin')

    await expect(checkin.locator('.ta-checkin__stamp')).toBeVisible()
    await expect(checkin.locator('.ta-checkin__stampTime')).toHaveText(
      formatClock(outOfBandArrivedAt),
    )
    // 刷新是重取，不是「又打了一次卡」：动效不重放（§7：其余动效克制）
    expect(await stampStyle(checkin, 'animation-name'), '刷新不该重放仪式').toBe('none')
    await expect(checkin.locator('.ta-checkin__quote')).toHaveCount(0)
    await expect(checkin.locator('.ta-checkin__totalNumber')).toHaveText('1')

    // 已经到达，就不再提供到达入口；离开是可选的，入口在
    await expect(checkin.getByRole('button', { name: '到达实验室' })).toHaveCount(0)
    await expect(checkin.getByRole('button', { name: '离开实验室' })).toBeVisible()
    await expect(checkin.locator('.ta-checkin__fact', { hasText: '离开' })).toContainText('未记录')
  })

  test('4. 离开：记下离开时刻，今天的记录闭合', async () => {
    const leave = checkin.getByRole('button', { name: '离开实验室' })
    await leave.click()

    await expect(checkin.getByRole('status')).toContainText('已记录离开')
    await expect(checkin.locator('.ta-checkin__fact', { hasText: '离开' })).not.toContainText(
      '未记录',
    )
    // 闭合之后不再有任何写入入口——本阶段没有撤销（属阶段 5），所以也不摆假按钮
    await expect(checkin.getByRole('button', { name: '离开实验室' })).toHaveCount(0)
    await expect(checkin.getByRole('button', { name: '到达实验室' })).toHaveCount(0)
    await expect(checkin.locator('.ta-checkin__hint')).toContainText('今日打卡已完成')
    await expect(checkin.locator('.ta-checkin__quote')).toBeVisible()
    await expect(checkin.locator('.ta-checkin__totalNumber')).toHaveText('1')
    await checkin.screenshot({ path: test.info().outputPath('checkin-desktop.png'), fullPage: true })
  })

  test('5. 主题切换：印章的颜色跟着令牌走，不是写死的', async () => {
    const themeOf = () => checkin.locator('html').getAttribute('data-theme')

    const before = await themeOf()
    expect(['dark', 'light'], '页面必须已经带上主题属性').toContain(before)
    await expect
      .poll(() => stampStyle(checkin, 'border-top-color'))
      .toBe(before === 'dark' ? STAMP_DARK : STAMP_LIGHT)

    await checkin.getByRole('button', { name: /切换到(亮色|暗色)主题/ }).click()

    const after = await themeOf()
    expect(after, '点一下应当换到另一套主题').not.toBe(before)
    await expect
      .poll(() => stampStyle(checkin, 'border-top-color'))
      .toBe(after === 'dark' ? STAMP_DARK : STAMP_LIGHT)
  })

  test('6. reduced-motion：压章动效关掉，但章本身照常出现', async ({ browser }) => {
    // 换一个今天还没打过卡的账号，才有「到达」这个动作
    const invite = await issueInvite(stackOf(), ownerToken, 7)
    const member = await register(stackOf(), {
      inviteCode: invite.invite.code,
      username: MEMBER.username,
      displayName: MEMBER.displayName,
      password: MEMBER.password,
    })

    const context = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    await signInAs(page, member.token)
    await gotoHash(page, stackOf().baseUrl, HASH.checkin)
    await expectScreen(page, 'checkin')

    await page.getByRole('button', { name: '到达实验室' }).click()
    await expect(page.getByRole('status')).toContainText('已记录到达')
    await expect(page.locator('.ta-checkin__quote')).toBeVisible()
    await expect(page.getByRole('link', { name: '查看出处' })).toHaveCount(0)
    await expect(page.locator('.ta-checkin__totalNumber')).toHaveText('1')
    expect(await page.locator('.ta-checkin__celebration').evaluate(el => getComputedStyle(el).animationName)).toBe('none')

    // 动效关了 ≠ 章没了：静态样式就是终态，信息一点不少
    await expect(page.locator('.ta-checkin__stamp')).toBeVisible()
    await expect(page.locator('.ta-checkin__stampTime')).toBeVisible()
    // 量的是「这一下动效花了多长时间」这个结果，而不是它靠哪一层关掉的：
    // 令牌归零与 checkin.css 里的 @media 各自都能让这个数变成 0，两层都在才算过关。
    expect(
      toMs(await stampStyle(page, 'animation-duration')),
      '减少动效时压章动画的时长必须是 0',
    ).toBe(0)

    await page.setViewportSize({ width: 375, height: 812 })
    await expect(page.getByRole('button', { name: '收起打卡寄语' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('checkin-mobile.png'), fullPage: true })
    await page.getByRole('button', { name: '收起打卡寄语' }).click()
    await expect(page.locator('.ta-checkin__quote')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.ta-checkin__totalNumber')).toHaveText('1')
    await expect(page.locator('.ta-checkin__quote')).toHaveCount(0)
    await page.getByRole('button', { name: '暂离实验室', exact: true }).click()
    await expect(page.getByRole('button', { name: '返回实验室' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: '返回实验室' })).toBeVisible()
    await page.getByRole('button', { name: '返回实验室' }).click()
    await expect(page.getByRole('button', { name: '暂离实验室', exact: true })).toBeVisible()
    await expect(page.locator('.ta-checkin__totalNumber')).toHaveText('1')
    await page.getByRole('button', { name: '暂离实验室', exact: true }).click()
    await expect(page.getByRole('button', { name: '返回实验室' })).toBeVisible()
    await page.getByRole('button', { name: '离开实验室', exact: true }).click()
    await expect(page.getByRole('button', { name: '返回实验室' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '暂离实验室', exact: true })).toHaveCount(0)
    await expect(page.locator('.ta-checkin__totalNumber')).toHaveText('1')
    await context.close()
  })

  test('7. 重复离开：带外已经离开过，这个页面点下去要说「你已经记过离开了」', async ({ page }) => {
    /*
     * ADR-012 §5（v1.2）把 leave 的分流键换成了「有无到达」：
     * 最近那条到达**已闭合**时返回 200 + `created: false`（而不是 409），
     * 于是重复点击与网络重试都落在幂等上而不报错。
     *
     * 「已闭合」这个状态在界面上是无法自己走到的——按钮那时已经收起来了，
     * 所以要复现它，必须让**另一处**先记下离开，再让这个还蒙在鼓里的页面去点。
     * 这正是幂等反馈存在的理由：用户得知道发生了什么，而不是看见一次假的成功。
     */
    const gamma: Account = {
      username: 'member_gamma',
      displayName: '实验员丙',
      password: 'member-pass-1234',
    }
    const { member } = await seedMember(stackOf(), ownerToken, gamma)
    await signInAs(page, member.token)
    await gotoHash(page, stackOf().baseUrl, HASH.checkin)
    await expectScreen(page, 'checkin')

    await page.getByRole('button', { name: '到达实验室' }).click()
    await expect(page.getByRole('status')).toContainText('已记录到达')
    await expect(page.getByRole('button', { name: '离开实验室' })).toBeVisible()

    // 带外记下离开（另一个标签页 / 另一台设备）。这个页面的缓存里 leftAt 还是 null。
    const outOfBand = await leaveCheckin(stackOf(), member.token)
    expect(outOfBand.created, '第一次离开应当是新写入的').toBe(true)
    const firstLeftAt = outOfBand.day.leftAt
    if (firstLeftAt === null) throw new Error('离开写完后 leftAt 不该还是空')

    const leave = page.getByRole('button', { name: '离开实验室' })
    await expect(leave, '页面还不知道带外那次离开，按钮应当还在').toBeVisible()
    await leave.click()

    // 说的是**第一次**记录的时刻（来自响应），不是「刚刚记上了」
    await expect(page.getByRole('status')).toContainText(
      `你今天 ${formatClock(firstLeftAt)} 已经记过离开了`,
    )

    // 服务端没有写第二条离开事件：leftAt 还是带外那一次
    const state = await todayCheckin(stackOf(), member.token)
    expect(state.day?.leftAt, '幂等的离开不该改写既有的 leftAt').toBe(firstLeftAt)

    // 页面收敛到闭合态：事实里有离开时刻，写入入口全部收起
    await expect(page.locator('.ta-checkin__fact', { hasText: '离开' })).not.toContainText('未记录')
    await expect(page.getByRole('button', { name: '离开实验室' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '到达实验室' })).toHaveCount(0)
  })
})
