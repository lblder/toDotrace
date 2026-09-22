import { expect, test, type Page } from '@playwright/test'
import { seedMember, seedOwner } from './harness/api'
import { gotoHash, HASH, expectScreen, trackHashTrail, hashTrail, type RouteName } from './harness/routes'
import { signInAs } from './harness/session'
import { serverLogOnFailure, startStack, type Stack } from './harness/stack'

/**
 * 路由守卫矩阵。
 *
 * 五种状态下、每个白名单地址的**去向**：地址栏最终落在哪个 hash，
 * 以及那一屏是不是真的渲染出来了（两者都要）。
 *
 * 本文件用两套栈，因为「未就绪」是建号**之前**的状态，建完就不复存在：
 *   fresh  —— 空库（needsOwner = true）
 *   seeded —— 已建 owner、已注册一名 member
 * 两套栈各有自己的临时库与端口，互不影响。
 */

const ROUTES: readonly RouteName[] = [
  'home',
  'checkin',
  'setup',
  'login',
  'register',
  'invites',
]

let fresh: Stack
let seeded: Stack
let ownerToken = ''
let memberToken = ''

// 本文件有两套栈（未就绪 / 已就绪），失败时两边的服务端日志都要留下——
// 出了问题首先要分清是哪一套栈、哪个请求。见 harness/stack.ts 的 serverLogOnFailure。
serverLogOnFailure(() => [fresh, seeded])

test.beforeAll(async () => {
  ;[fresh, seeded] = await Promise.all([startStack(), startStack()])
  const owner = await seedOwner(seeded)
  ownerToken = owner.token
  memberToken = (await seedMember(seeded, ownerToken)).member.token
})

test.afterAll(async () => {
  await Promise.all([fresh?.stop(), seeded?.stop()])
})

/* ---------------------------------------------------------------------------
   一、未就绪：库里还没有 owner
   --------------------------------------------------------------------------- */

test.describe('未就绪（空库）', () => {
  for (const route of ROUTES) {
    test(`${HASH[route]} → #/setup`, async ({ page }) => {
      await gotoHash(page, fresh.baseUrl, HASH[route])
      await expectScreen(page, 'setup')
    })
  }
})

/* ---------------------------------------------------------------------------
   二、已就绪、未登录
   --------------------------------------------------------------------------- */

test.describe('已就绪 · 未登录', () => {
  const expected: Readonly<Record<RouteName, RouteName>> = {
    home: 'login',
    checkin: 'login',
    setup: 'login',
    login: 'login',
    // 注册是唯一对未登录开放的页面（凭邀请码，无鉴权）
    register: 'register',
    invites: 'login',
  }

  for (const route of ROUTES) {
    test(`${HASH[route]} → ${HASH[expected[route]]}`, async ({ page }) => {
      await gotoHash(page, seeded.baseUrl, HASH[route])
      await expectScreen(page, expected[route])
    })
  }
})

/* ---------------------------------------------------------------------------
   三、已登录 · owner
   --------------------------------------------------------------------------- */

test.describe('已登录 · owner', () => {
  const expected: Readonly<Record<RouteName, RouteName>> = {
    home: 'home',
    checkin: 'checkin',
    setup: 'home',
    login: 'home',
    register: 'home',
    invites: 'invites',
  }

  for (const route of ROUTES) {
    test(`${HASH[route]} → ${HASH[expected[route]]}`, async ({ page }) => {
      await signInAs(page, ownerToken)
      await gotoHash(page, seeded.baseUrl, HASH[route])
      await expectScreen(page, expected[route])
    })
  }
})

/* ---------------------------------------------------------------------------
   四、已登录 · member：邀请码页是 owner 专属，member 进不去
   --------------------------------------------------------------------------- */

test.describe('已登录 · member', () => {
  const expected: Readonly<Record<RouteName, RouteName>> = {
    home: 'home',
    // 打卡是每个账号自己的事，不分角色
    checkin: 'checkin',
    setup: 'home',
    login: 'home',
    register: 'home',
    invites: 'home',
  }

  for (const route of ROUTES) {
    test(`${HASH[route]} → ${HASH[expected[route]]}`, async ({ page }) => {
      await signInAs(page, memberToken)
      await gotoHash(page, seeded.baseUrl, HASH[route])
      await expectScreen(page, expected[route])
    })
  }

  test('导航里不出现「邀请码」入口', async ({ page }) => {
    await signInAs(page, memberToken)
    await gotoHash(page, seeded.baseUrl, HASH.home)
    await expectScreen(page, 'home')
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '邀请码' })).toHaveCount(0)
  })

  test('owner 的导航里有「邀请码」入口', async ({ page }) => {
    await signInAs(page, ownerToken)
    await gotoHash(page, seeded.baseUrl, HASH.home)
    await expectScreen(page, 'home')
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '邀请码' })).toHaveCount(1)
  })
})

/* ---------------------------------------------------------------------------
   五、深链接刷新：地址栏原样保留，且**从未**被改写过
   ---------------------------------------------------------------------------
   这是修过的那个 bug 的回归线。当时 App 在「首启状态 / 会话」都还没回来时
   就调用了 resolveRoute：那一刻 authenticated 与 isOwner 都是 false，
   于是 #/invites 被判成非法地址，被改写成 #/login、再被改写成 #/。
   用户按一次刷新，地址和页面一起没了。
   --------------------------------------------------------------------------- */

/** 把 /api/auth/me 拖慢，保证「未就绪」那个窗口一定被走到（否则时序太快，测不稳）。 */
async function slowSession(page: Page): Promise<void> {
  await page.route('**/api/auth/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      await route.continue()
    } catch {
      // 页面在延迟期间被关掉了
    }
  })
}

test.describe('深链接刷新', () => {
  test('owner 刷新 #/invites 留在原地，页面内容可用', async ({ page }) => {
    await slowSession(page)
    await trackHashTrail(page)
    await signInAs(page, ownerToken)
    await gotoHash(page, seeded.baseUrl, HASH.invites)

    await expectScreen(page, 'invites')

    // 地址栏从头到尾只有 #/invites 一个值：守卫没有先改写、再改回来
    expect(await hashTrail(page)).toEqual([HASH.invites])

    // 「没被甩掉」不只是地址还在——那一屏的数据也要真的取到了。
    // 这套栈里 seedMember 用过一枚码，所以列表必然有一条记录。
    await expect(page.getByRole('heading', { name: '签发记录' })).toBeVisible()
    await expect(page.locator('.ta-invites__item')).toHaveCount(1)
  })

  test('owner 刷新 #/checkin 留在原地，今日状态真的取到了', async ({ page }) => {
    await slowSession(page)
    await trackHashTrail(page)
    await signInAs(page, ownerToken)
    await gotoHash(page, seeded.baseUrl, HASH.checkin)

    await expectScreen(page, 'checkin')

    // 与 #/invites 那条同一个回归：守卫没有先改写、再改回来
    expect(await hashTrail(page)).toEqual([HASH.checkin])

    // 「页面还在」不只是标题在：今日状态要真的从服务端取回来。
    // 这位 owner 在本文件里从没打过卡，所以今天必然呈现为休息日——
    // 停在「正在读取今日状态…」的话这条会失败。
    await expect(page.locator('.ta-checkin__restMain')).toHaveText('今天偷偷懒')
  })

  test('member 刷新 #/invites 被送到 #/（该页 owner 专属）', async ({ page }) => {
    await slowSession(page)
    await trackHashTrail(page)
    await signInAs(page, memberToken)
    await gotoHash(page, seeded.baseUrl, HASH.invites)

    await expectScreen(page, 'home')

    const trail = await hashTrail(page)
    expect(trail[trail.length - 1]).toBe(HASH.home)
    // 中间不能经过登录页：令牌一直在手上，没有理由路过未登录态
    expect(trail).not.toContain(HASH.login)
  })

  test('未登录刷新 #/invites 落到登录页', async ({ page }) => {
    await slowSession(page)
    await gotoHash(page, seeded.baseUrl, HASH.invites)
    await expectScreen(page, 'login')
  })
})
