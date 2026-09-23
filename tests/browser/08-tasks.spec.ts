import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { addDays, diffDays, formatDayKey, weekEnd, weekStart } from '@shared/time'
import { describeDay, describeWeek } from '@shared/quickadd'
import {
  createProject,
  createTask,
  deleteTask,
  getSettings,
  itemByTitle,
  listProjectTasks,
  listTasks,
  patchSettings,
  seedOwner,
  setTaskStatus,
  undoBatch,
} from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'

/**
 * 阶段 4 的任务界面（01 FR2 / ADR-013 / 014 / 015 / 016 / 017）。
 *
 * 与 07-checkin 同一套写法与深度：**测真实交互与失败路径**，不是「渲染出来了」。
 * 本文件里几条特别值得看的用例：
 *
 * - **快速录入的三层逃生舱**（ADR-014 §2 / FR2.3 v1.3）——尤其要证
 *   「`×` 之后原文**回到标题**」而不是被静默删掉，以及「不解析的那两层一个字都不动」；
 * - **已放弃之后，完成历史仍然看得见**（01 FR2.1 v1.4 / ADR-013 §2）：
 *   这是「放弃不抹除历史」这条裁决在界面上的唯一证据；
 * - **`today` 必须是服务端回带的那个**（ADR-015 §6）：本文件用「改 `dayStartHour` →
 *   触发 `focus` 重取」来证明界面显示的 `today` 随服务端变，而**没有重载页面**；
 * - **勾选属于某一轮实例**（ADR-013 §4.12 / ADR-017 §1.2）：断言界面发出去的
 *   `toggle` 请求确实带上了这一行的 `occurrenceKey`——不带它服务端会 400，
 *   而「回落成任务的 indexDate」在界面上没有任何症状。
 */

/** 行定位：按标题找那一行（不断言 DOM 结构，只断言这一行里有什么） */
function rowOf(page: Page, title: string) {
  return page.locator('.ta-tasks__row').filter({ hasText: title })
}

/** 完成复选框：用可访问名区分它与「选中用于批量顺延」那个复选框 */
function completeBox(row: ReturnType<typeof rowOf>, title: string) {
  return row.getByRole('checkbox', { name: new RegExp(`^(取消)?完成《${title}》$`) })
}

/*
 * 为什么完成复选框用 `.click()` 而不是 `.check()`：
 * 它是**受控**输入，勾上与否要等服务端那次往返回来（完成是一条事件，不是本地一个勾）。
 * Playwright 的 `.check()` 点一下之后立刻验状态，会撞在这次往返上并报
 * 「Clicking the checkbox did not change its state」——那会把「异步」误报成「没生效」。
 * 所以这里点一下，再用**会重试的** `toBeChecked()` 断言结果。
 */

/** 快速录入：清空后重打（清空会重置抑制集，见 ADR-014 §2 的坐标约束） */
async function typeQuickAdd(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('写点什么')
  await input.fill('')
  await input.fill(text)
}

/** 录入并提交，等「已添加」那条反馈 */
async function submitQuickAdd(page: Page, text: string): Promise<void> {
  await typeQuickAdd(page, text)
  await page.getByRole('button', { name: '添加' }).click()
  await expect(page.getByTestId('quick-add-feedback')).toContainText('已添加')
}

test.describe.serial('任务链路', () => {
  const stackOf = useStack()

  let context: BrowserContext
  let page: Page
  let token = ''
  /** 服务端回带的「今天」——本文件里所有相对日期的期望值都由它算出来 */
  let serverToday = ''

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'zh-CN' })
  })

  test.afterAll(async () => {
    if (page !== undefined) await page.close()
    await context?.close()
  })

  test('1. 建号进任务页：空态如实，且「今天」显示的是服务端回带的那个', async () => {
    const owner = await seedOwner(stackOf())
    token = owner.token

    page = await context.newPage()
    await signInAs(page, token)
    await gotoHash(page, stackOf().baseUrl, HASH.tasks)
    await expectScreen(page, 'tasks')

    // 空态不是错误态：说清「这里没有任务」，并给出一条能用的输入示例
    await expect(page.locator('.ta-tasks__empty')).toContainText('这个视图下没有任务')

    const listed = await listTasks(stackOf(), token, 'today')
    serverToday = listed.today

    /*
     * ADR-017 §10 末段：界面**必须显示响应里的 `today`**。
     * 只重取不显示的话，用户在一个五分钟的窗口里看到的仍是旧数据而无从察觉。
     */
    await expect(page.getByTestId('server-today')).toHaveText(serverToday)
  })

  test('2. 快速录入：预览显示解析后的绝对日期，且粒度跟着用户给的粒度走', async () => {
    const chipText = page.locator('.ta-tasks__chipText')

    // ① 日粒度：`明天` → 计划日 = 明天那一天，括号里给相对词
    await typeQuickAdd(page, '明天 写实验报告')
    await expect(page.getByTestId('quick-add-title')).toHaveText('写实验报告')
    const tomorrow = addDays(serverToday, 1)
    await expect(chipText).toHaveText(`计划日 ${describeDay(tomorrow, serverToday)}(明天)`)

    // ② 周粒度：`下周` → **计划周**（不是计划日），措辞是「9月28日那一周」
    const nextWeekMonday = addDays(weekStart(serverToday), 7)
    await typeQuickAdd(page, '下周 交周报')
    await expect(page.getByTestId('quick-add-title')).toHaveText('交周报')
    await expect(chipText).toHaveText(`计划周 ${describeWeek(nextWeekMonday)}`)
    // 粒度错了比不显示更糟（ADR-014 §4.3）：这一格必须**不出现**「计划日」
    await expect(page.getByTestId('quick-add-adopted')).not.toContainText('计划日')

    // ③ 同一个词不会在两个字段之间摇摆：`下周三` 由另一条规则收下，落**计划日**
    const nextWednesday = addDays(weekStart(serverToday), 7 + 2)
    await typeQuickAdd(page, '下周三 开组会')
    await expect(chipText).toHaveText(
      `计划日 ${describeDay(nextWednesday, serverToday)}(${relativeText(nextWednesday, serverToday)})`,
    )
    await expect(page.getByTestId('quick-add-adopted')).not.toContainText('计划周')

    // ④ 无法解析的文本一个字都不动（FR2.3）：`实验9-23组` 里的 9-23 是编号，不是日期
    await typeQuickAdd(page, '实验9-23组 交材料')
    await expect(page.getByTestId('quick-add-title')).toHaveText('实验9-23组 交材料')
    await expect(page.locator('.ta-tasks__chip')).toHaveCount(0)
  })

  test('3. 三层逃生舱：整串引号 / 反斜杠 / 点 ×（取消后原文回到标题）', async () => {
    // 层①：整串引号 —— 剥引号，其余一个字都不解析
    await typeQuickAdd(page, '"明天 写报告"')
    await expect(page.getByTestId('quick-add-title')).toHaveText('明天 写报告')
    await expect(page.locator('.ta-tasks__chip')).toHaveCount(0)
    await expect(page.locator('.ta-tasks__previewNote')).toContainText('整串引号')

    // 层②：单 token 反斜杠 —— 只保护它命中的那个片段
    await typeQuickAdd(page, '\\明天 写报告')
    await expect(page.getByTestId('quick-add-title')).toHaveText('明天 写报告')
    await expect(page.locator('.ta-tasks__chip')).toHaveCount(0)

    // 层③：`×` 取消 —— **原文回到标题**，不是被删掉
    await typeQuickAdd(page, '明天 写报告')
    await expect(page.locator('.ta-tasks__chip')).toHaveCount(1)
    await page.getByRole('button', { name: '取消识别「明天」，它的原文会回到标题' }).click()
    await expect(page.getByTestId('quick-add-title')).toHaveText('明天 写报告')
    await expect(page.locator('.ta-tasks__chip')).toHaveCount(0)

    // 提交之后服务端拿到的必须是「没有计划日」——取消是真的取消了，不只是显示上不见了
    await page.getByRole('button', { name: '添加' }).click()
    await expect(page.getByTestId('quick-add-feedback')).toContainText('已添加')
    const afterCancel = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(afterCancel, '明天 写报告').plannedDate, '取消识别之后不该有计划日').toBeNull()

    /*
     * 层③的另一半：**取消一个覆盖者会让被它盖住的碎片自动重新生效**（§4.4）。
     * 这不是副作用，是「采纳集」模型的直接结果——`×` 因此不需要任何专门代码。
     */
    await typeQuickAdd(page, '明天 周五 写报告')
    const friday = nextWeekday(serverToday, 4)
    await expect(page.locator('.ta-tasks__released')).toContainText('明天')
    await expect(page.getByTestId('quick-add-adopted')).toContainText(describeDay(friday, serverToday))

    await page.getByRole('button', { name: /^取消识别「周五」/ }).click()
    // 取消 `周五` 之后：`明天` 重新生效，而 `周五` 的原文回到标题
    await expect(page.getByTestId('quick-add-adopted')).toContainText(
      describeDay(addDays(serverToday, 1), serverToday),
    )
    await expect(page.getByTestId('quick-add-title')).toHaveText('周五 写报告')
  })

  test('4. 勾选完成 → 刷新仍在；取消完成 → 刷新仍未完成', async () => {
    await submitQuickAdd(page, '今天 交材料')
    await expect(rowOf(page, '交材料')).toHaveCount(1)

    // 勾选完成（复选框）
    await completeBox(rowOf(page, '交材料'), '交材料').click()
    await expect(rowOf(page, '交材料').getByTestId(/^bucket-/)).toHaveText('已完成')

    // 刷新之后仍在：完成态是**事件**，不是内存里的一个勾
    await page.reload()
    await expectScreen(page, 'tasks')
    await expect(completeBox(rowOf(page, '交材料'), '交材料')).toBeChecked()
    await expect(rowOf(page, '交材料').getByTestId(/^bucket-/)).toHaveText('已完成')

    // 服务端侧：本实例的完成归属日 = 服务端的今天
    const listed = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(listed, '交材料').completedDayKey).toBe(serverToday)

    // 取消完成 —— 它是**追加一条事件**，不是删除（ADR-013 §4.7）
    await completeBox(rowOf(page, '交材料'), '交材料').click()
    await expect(rowOf(page, '交材料').getByTestId(/^bucket-/)).not.toHaveText('已完成')

    // 刷新后仍未完成：这一条挡的是「存在任意一条完成事件即算完成」的退化实现
    await page.reload()
    await expectScreen(page, 'tasks')
    await expect(completeBox(rowOf(page, '交材料'), '交材料')).not.toBeChecked()
    const afterUncheck = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(afterUncheck, '交材料').completedDayKey).toBeNull()
  })

  test('5. 「进行中」只能显式触发：打开详情、改字段都不改变状态', async () => {
    await submitQuickAdd(page, '今天 整理数据')

    const row = rowOf(page, '整理数据')
    const inProgress = row.getByTestId(/^in-progress-/)

    // 打开详情 + 改重要性 + 保存 —— 这些都不该改变状态（01 FR2.1 v1.3）
    await row.getByRole('button', { name: '详情' }).click()
    await row.getByLabel('重要性').selectOption('high')
    await row.getByRole('button', { name: '保存定义' }).click()
    await expect(row.getByTestId('detail-feedback')).toContainText('已保存')
    await expect(inProgress).toHaveAttribute('aria-pressed', 'false')

    const beforeExplicit = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(beforeExplicit, '整理数据').status, '绝不自动推断').toBe('not_started')

    // 显式按下「标记进行中」才是唯一入口
    await inProgress.click()
    await expect(inProgress).toHaveAttribute('aria-pressed', 'true')
    const afterExplicit = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(afterExplicit, '整理数据').status).toBe('in_progress')

    // 刷新后仍在（它是写进事件流的状态，不是界面上的一个开关）
    await page.reload()
    await expectScreen(page, 'tasks')
    await expect(rowOf(page, '整理数据').getByTestId(/^in-progress-/)).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // 重复任务的「进行中」不可达（ADR-013 §2）：按钮禁用，且**说得出理由**
    await submitQuickAdd(page, '每天 写日记')
    const recurring = rowOf(page, '写日记')
    await expect(recurring.getByTestId(/^in-progress-/)).toBeDisabled()
    await expect(recurring.getByTestId(/^in-progress-/)).toHaveAttribute('title', /重复任务/)
  })

  test('6. 步骤：N/M 进度、单独勾选，且勾选带上这一轮的实例键', async () => {
    // 步骤的定义只能经 API 造（快速录入不产出步骤，ADR-014 §6 末段）
    const taskId = '0198a000-0000-7000-8000-000000000001'
    await createTask(stackOf(), token, {
      taskId,
      title: '写论文第三章',
      plannedDate: serverToday,
      steps: [
        { id: '0198a000-0000-7000-8000-0000000000a1', title: '列提纲' },
        { id: '0198a000-0000-7000-8000-0000000000a2', title: '写初稿' },
        { id: '0198a000-0000-7000-8000-0000000000a3', title: '改图' },
      ],
    })

    await page.reload()
    await expectScreen(page, 'tasks')
    const row = rowOf(page, '写论文第三章')
    await expect(row.getByTestId(/^steps-progress-/)).toHaveText('步骤 0/3')

    // 单独勾选一个步骤，并**截住请求**看它带了什么
    const requestPromise = page.waitForRequest(
      (request) => request.url().includes('/steps/') && request.url().includes('/toggle'),
    )
    await row.getByRole('checkbox', { name: /步骤「列提纲」/ }).click()
    const toggleRequest = await requestPromise
    const body = toggleRequest.postDataJSON() as { originalPlannedDate?: string; checked?: boolean }

    /*
     * ⚠️ ADR-017 §1.2：`originalPlannedDate` **是必填的**——省略即 400，
     * **不回落成「任务的 indexDate」**（那样的回落对单轮任务看起来正常，
     * 对重复任务则每次都在勾第一轮，症状是「勾了没反应」）。
     * 这里断言它确实被发了出去，而且等于**这一行**的实例键。
     */
    expect(body.originalPlannedDate, 'toggle 必须带上这一轮的实例键').toBe(
      await row.getAttribute('data-occurrence-key'),
    )
    expect(body.checked).toBe(true)

    await expect(row.getByTestId(/^steps-progress-/)).toHaveText('步骤 1/3')

    // 刷新后勾选仍在（勾选是事件，不是界面状态）
    await page.reload()
    await expectScreen(page, 'tasks')
    await expect(rowOf(page, '写论文第三章').getByTestId(/^steps-progress-/)).toHaveText('步骤 1/3')
  })

  test('7. 项目视图是**归属**判定：区间外的任务仍然出现，并被标注出来', async () => {
    const projectId = '0198a000-0000-7000-8000-000000000002'
    await createProject(stackOf(), token, {
      projectId,
      name: '秋季课题',
      startsOn: addDays(serverToday, -10),
      endsOn: addDays(serverToday, -3),
    })

    // 一条排期远在项目区间**之后**、但归属该项目的任务（ADR-016 §10 的调和方案）
    await createTask(stackOf(), token, {
      taskId: '0198a000-0000-7000-8000-000000000003',
      title: '十月的实验',
      projectId,
      plannedDate: addDays(serverToday, 30),
    })

    const listed = await listProjectTasks(stackOf(), token, projectId)
    expect(
      listed.items.some((item) => item.title === '十月的实验'),
      '区间判定会让它永远不出现——那正是 ADR-015 §5 要修掉的错误',
    ).toBe(true)

    // 新项目是带外建的，页面上的项目列表要重新读一次才看得到（与「切回来时重取」同一个道理）
    await page.reload()
    await expectScreen(page, 'tasks')

    await page.getByRole('tab', { name: '项目' }).click()
    // 还没有当前项目：此时界面**不渲染清单**，而是说清「先选一个项目」——
    // 退回「全部」会让标签页写着「项目」却列着全部任务，那是一件说了假话的界面。
    await expect(page.getByRole('status')).toContainText('还没有当前项目')
    await expect(page.locator('.ta-tasks__list')).toHaveCount(0)

    await page.getByLabel('查看哪个项目').selectOption(projectId)

    await expect(rowOf(page, '十月的实验')).toHaveCount(1)
    // 分组标题解释了「它为什么在这里」，而不是让它看起来像 bug
    await expect(page.locator('.ta-tasks__groupHeading')).toContainText('排期在项目区间之外')
  })

  test('8. 批量顺延：一个请求一个批次，重复任务整批拒绝', async () => {
    await submitQuickAdd(page, '今天 批量甲')
    await submitQuickAdd(page, '今天 批量乙')

    await page.getByRole('tab', { name: '全部' }).click()
    await page.getByLabel('状态筛选').selectOption('active')

    await rowOf(page, '批量甲').getByRole('checkbox', { name: /^选中/ }).check()
    await rowOf(page, '批量乙').getByRole('checkbox', { name: /^选中/ }).check()

    const target = addDays(serverToday, 5)
    await page.getByLabel('顺延到').fill(target)
    await page.getByRole('button', { name: '顺延', exact: true }).click()
    await expect(page.getByTestId('board-banner')).toContainText('同一个批次')

    const listed = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(listed, '批量甲').plannedDate).toBe(target)
    expect(itemByTitle(listed, '批量乙').plannedDate).toBe(target)

    // 重复任务不能被顺延：整批会被服务端 409 挡下，故界面先挡，并说清是谁
    await page.getByRole('checkbox', { name: /^选中《写日记》/ }).check()
    await page.getByLabel('顺延到').fill(addDays(serverToday, 6))
    await page.getByRole('button', { name: '顺延', exact: true }).click()
    await expect(page.getByTestId('board-banner')).toContainText('重复任务')
    await expect(page.getByTestId('board-banner')).toContainText('整批拒绝')

    // 它没被挪动（整批都没写进去）
    const after = await listTasks(stackOf(), token, 'all')
    expect(itemByTitle(after, '写日记').plannedDate ?? null).toBeNull()
  })

  test('9. 删除是软删除且可撤销（撤销走 POST /api/undo，按批次）', async () => {
    await submitQuickAdd(page, '今天 待删除的任务')

    await page.getByRole('tab', { name: '全部' }).click()
    await rowOf(page, '待删除的任务').getByRole('button', { name: '删除《待删除的任务》' }).click()

    // 撤销窗口只在界面上，服务端能撤销任何批次（ADR-017 §8）
    await expect(page.getByTestId('undo-delete')).toBeVisible()
    await expect(rowOf(page, '待删除的任务')).toHaveCount(0)

    await page.getByTestId('undo-delete').click()
    await expect(page.getByTestId('board-banner')).toContainText('已撤销删除')

    // 逐字段还原：任务回来了
    const restored = await listTasks(stackOf(), token, 'all')
    expect(
      restored.items.some((item) => item.title === '待删除的任务'),
      '撤销之后它必须重新出现在列表里',
    ).toBe(true)

    // 另一个方向：带外删除 + 撤销（证明「撤销 = 撤销那个批次」，与界面无关）
    const apiDeleted = await deleteTask(stackOf(), token, '0198a000-0000-7000-8000-000000000001')
    const hidden = await listTasks(stackOf(), token, 'all')
    expect(hidden.items.some((item) => item.title === '写论文第三章')).toBe(false)
    await undoBatch(stackOf(), token, apiDeleted.batchId)
    const visible = await listTasks(stackOf(), token, 'all')
    expect(visible.items.some((item) => item.title === '写论文第三章')).toBe(true)
  })

  test('10. 跨零点：界面显示的 `today` 跟着服务端变，且不重载页面', async () => {
    /*
     * 这条用例要证的是 ADR-015 §6 + ADR-017 §10 两件事的**合取**：
     *
     *   · 界面显示的「今天」只能来自服务端响应（前端不得自行计算用于提交）；
     *   · `focus` 是三个重取时机之一。
     *
     * 做法是让**服务端自己**换一天：把 `dayStartHour` 改成一个会让归属日回退的值
     * （`toDayKey` 的规则：本地小时 < dayStartHour 时归前一天），
     * 然后触发窗口 `focus`，断言页面上的日期变成服务端新回带的那个——**没有 reload**。
     */
    const before = await getSettings(stackOf(), token)
    await expect(page.getByTestId('server-today')).toHaveText(before.affectsFrom)

    const flip = await patchSettings(stackOf(), token, { dayStartHour: 23 })

    // 真实事件派发，走的是页面里那个监听器（不是调某个内部函数）
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })

    const listed = await listTasks(stackOf(), token, 'today')
    // ① 界面显示的就是 `/api/tasks` 回带的那个（ADR-015 §6 的**唯一**判据）
    await expect(page.getByTestId('server-today')).toHaveText(listed.today)
    // ② 而它同时是设置接口回带的 `affectsFrom`（ADR-017 §7：两处是同一个服务端口径）
    expect(listed.today, '设置响应里的 affectsFrom 就是该账号当前的 today').toBe(flip.affectsFrom)
    // ③ 归属日真的翻了：界面在同一次页面生命周期里跟着翻了，说明它没有自己算
    expect(listed.today, 'dayStartHour=23 应当让归属日回退一天').toBe(addDays(serverToday, -1))

    // 复原，免得影响后面的用例
    await patchSettings(stackOf(), token, { dayStartHour: before.dayStartHour })
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByTestId('server-today')).toHaveText(serverToday)
  })

  test('11. 失败路径：服务端拒绝时界面如实报出来，而不是静默失败', async () => {
    /*
     * 把一条任务带外改成「已放弃」，再让**还蒙在鼓里**的页面去勾完成：
     * 页面缓存里它还是未开始，于是这一下必然打到服务端，
     * 而服务端会以 409 `conflict/task-not-completable` 拒绝。
     * 这正是「按钮是亮的、点下去报错」的形状——界面必须把它说清楚。
     */
    const taskId = '0198a000-0000-7000-8000-000000000004'
    await createTask(stackOf(), token, {
      taskId,
      title: '会被带外放弃的任务',
      plannedDate: serverToday,
    })
    await page.reload()
    await expectScreen(page, 'tasks')

    const row = rowOf(page, '会被带外放弃的任务')
    await expect(row).toHaveCount(1)

    // 带外放弃（另一台设备 / 另一个标签页）
    await setTaskStatus(stackOf(), token, taskId, 'abandoned')

    await completeBox(row, '会被带外放弃的任务').click()
    await expect(row.getByRole('alert')).toBeVisible()

    // 服务端侧也没有被写进去
    const listed = await listTasks(stackOf(), token, 'all')
    const item = itemByTitle(listed, '会被带外放弃的任务')
    expect(item.status).toBe('abandoned')
    expect(item.completedDayKey).toBeNull()
  })
  /*
   * ⚠️ **这一条是「整集交给前端」那条契约的回归测试**。
   *
   * 写它的时候服务端的 `scope=all` 还带着**默认状态筛选**（`queryItems` 不传 `status`
   * 时走 `filter.ts` 的默认视图判据，把已放弃的滤掉了），于是「已放弃」筛选在前端
   * **永远是空的**、用户无法重新打开一条已放弃的任务——ADR-015 §4 明令它必须能被找到。
   * 已上报；服务端随后在 `listTasks` 的每个分支补了 `status: 'all'`（整集交出去，
   * 状态筛选归前端），这一条随之转绿。**它留着，是为了钉住那个修复。**
   */
  test('12. 已完成 → 放弃：历史区仍显示完成过，而它不再呈现为已完成', async () => {
    await submitQuickAdd(page, '今天 磨金相')
    await completeBox(rowOf(page, '磨金相'), '磨金相').click()
    await expect(rowOf(page, '磨金相').getByTestId(/^bucket-/)).toHaveText('已完成')

    // 从详情里放弃（已完成 → 已放弃 是**合法迁移**，且**只写一条状态事件**）
    await rowOf(page, '磨金相').getByRole('button', { name: '详情' }).click()
    await rowOf(page, '磨金相').getByTestId(/^abandon-/).click()

    /*
     * 放弃会让这一行**立刻从默认视图消失**（§4 的优先级表），所以确认必须来自
     * 页面级的那条横幅——行内的反馈会跟着行一起不见。这一条断言正是在钉住
     * 「用户不会看到『点了一下，东西没了，什么都没说』」。
     */
    await expect(page.getByTestId('board-banner')).toContainText('完成记录一条都没有被删')
    await expect(rowOf(page, '磨金相')).toHaveCount(0)

    /*
     * 要找到它得显式筛「已放弃」——这也正是「已放弃的任务仍然要能被找到，
     * 否则用户无法重新打开它」那条要求的落点。
     */
    await page.getByRole('tab', { name: '全部' }).click()
    await page.getByLabel('状态筛选').selectOption('abandoned')
    const abandoned = rowOf(page, '磨金相')
    await expect(abandoned).toHaveCount(1)

    // ① 不呈现为已完成：复选框**不勾**、档位理由不是「已完成」、状态徽标说已放弃
    await expect(completeBox(abandoned, '磨金相')).not.toBeChecked()
    await expect(abandoned.getByTestId(/^bucket-/)).toHaveText('已放弃')
    await expect(abandoned.locator('.ta-tasks__statusBadge')).toHaveText('已放弃')

    // ② 历史区**仍然显示完成过**——这是「放弃不抹除历史」在界面上的证据
    await expect(abandoned.getByTestId(/^history-/)).toContainText('完成历史')
    await expect(abandoned.getByTestId(/^history-/)).toContainText(serverToday)

    // ③ 服务端侧同一条事实：完成记录还在，只是 status 变了
    const listed = await listTasks(stackOf(), token, 'all')
    const item = itemByTitle(listed, '磨金相')
    expect(item.status).toBe('abandoned')
    expect(item.completedDayKey, '放弃不该抹掉完成记录').toBe(serverToday)
    expect(item.overdue, '已放弃的任务不再被催（overdue 恒为 false，ADR-015 §理由）').toBe(false)

    // ④ 它**不在**「已完成」筛选里
    await page.getByLabel('状态筛选').selectOption('completed')
    await expect(rowOf(page, '磨金相')).toHaveCount(0)

    // ⑤ 重新打开之后回到正常清单。详情面板一直是展开的（它在上面那一步被打开过，
    //    行被筛掉又筛回来时 `expanded` 状态仍在），故这里直接点「重新打开」。
    await page.getByLabel('状态筛选').selectOption('abandoned')
    await expect(rowOf(page, '磨金相').locator('.ta-tasks__detail')).toBeVisible()
    await rowOf(page, '磨金相').getByRole('button', { name: '重新打开（回到未开始）' }).click()
    // 重开之后它回到了未开始，于是又**从「已放弃」筛选里消失**——确认同样只能来自
    // 页面级那条横幅。这与放弃那一步是同一个理由，两个方向各验一次。
    await expect(page.getByTestId('board-banner')).toContainText('已重新打开')
    await page.getByLabel('状态筛选').selectOption('default')
    await expect(rowOf(page, '磨金相')).toHaveCount(1)
  })


  /*
   * 视图切换的**区间边界**（ADR-015 §5）：周视图是闭区间 `[weekStart(today), weekEnd(today)]`，
   * **两端都含**。这里用两条任务把两端各钉一次，且不依赖「今天是星期几」——
   * 期望值全部由服务端回带的 `today` 折出来。
   */
  test('13. 本周视图是闭区间：周日那条在，下周一那条不在；而它俩都不在「今日」里', async () => {
    const weekEndDay = weekEnd(serverToday)
    const nextMonday = addDays(weekEndDay, 1)

    await createTask(stackOf(), token, {
      taskId: '0198a000-0000-7000-8000-000000000005',
      title: '本周日的事',
      plannedDate: weekEndDay,
    })
    await createTask(stackOf(), token, {
      taskId: '0198a000-0000-7000-8000-000000000006',
      title: '下周一的事',
      plannedDate: nextMonday,
    })

    await page.getByRole('tab', { name: '今日' }).click()
    await page.getByLabel('状态筛选').selectOption('default')

    // 今天（或更早）才算「今日」：周末那两条都还没到期，因此一条都不该在这儿
    if (weekEndDay !== serverToday) {
      await expect(rowOf(page, '本周日的事')).toHaveCount(0)
    }
    await expect(rowOf(page, '下周一的事')).toHaveCount(0)

    await page.getByRole('tab', { name: '本周' }).click()
    await expect(page.getByTestId('server-today')).toHaveText(serverToday)
    // 表头给出这一周的两端——用户据此知道「本周」是哪一段
    await expect(page.locator('.ta-tasks__todayLine')).toContainText(
      `${formatDayKey(weekStart(serverToday))} – ${formatDayKey(weekEndDay)}`,
    )
    // 右端（周日）**在内**；区间外的下周一**不在**
    await expect(rowOf(page, '本周日的事')).toHaveCount(1)
    await expect(rowOf(page, '下周一的事')).toHaveCount(0)
  })

  /*
   * 重复规则的编辑（ADR-017 §4 + ADR-013 §3.1）。
   *
   * 这条路的难点在**两步写入**：重复任务的三个日期锚点恒为空，而清锚点只能走
   * `/reschedule`（`PATCH` 不收那三个字段）。故界面必须「先清锚点、再写规则」，
   * 顺序反了服务端会以 400 拒绝。这一条把它端到端跑一遍。
   */
  test('14. 打开重复：先清空三个日期锚点，再写规则（ADR-013 §3.1 的两步写入）', async () => {
    await page.getByRole('tab', { name: '今日' }).click()
    await page.getByLabel('状态筛选').selectOption('default')
    await submitQuickAdd(page, '今天 整理记录')

    const row = rowOf(page, '整理记录')
    await row.getByRole('button', { name: '详情' }).click()

    // 开启「每天」——此时这条任务还带着 `plannedDate`
    await row.getByLabel('重复频率').selectOption('daily')
    await row.getByRole('button', { name: '保存定义' }).click()
    // 确认来自**页面级**横幅：这两次写入之间本行会短暂离开今日视图（先清锚点、再写规则），
    // 行内的那条反馈会随行一起卸载——用户看到的会是「点了保存，什么都没说」。
    await expect(page.getByTestId('board-banner')).toContainText('已保存')

    const listed = await listTasks(stackOf(), token, 'all')
    const item = itemByTitle(listed, '整理记录')
    expect(item.recurring, '规则写进去了').toBe(true)
    expect(item.plannedDate, '重复任务的日期锚点必须被清空（否则服务端 400）').toBeNull()
    expect(item.dueDate).toBeNull()

    // 行上出现「重复」徽标，且「进行中」对它不可达（ADR-013 §2）
    // 标题旁的「重复」徽标（用 class 定位：详情面板里还有一个「重复」的字段标签，两者不同）
    await expect(rowOf(page, '整理记录').locator('.ta-tasks__title .ta-badge')).toHaveText('重复')
    await expect(rowOf(page, '整理记录').getByTestId(/^in-progress-/)).toBeDisabled()
  })

  /*
   * 无障碍基线（需求 §4）。已有的 05-a11y 只覆盖登录页的焦点环与动效令牌，
   * 而这一页是**表单最密**的一页——每个控件都得有可访问名，否则读屏器只会念「编辑框」。
   * 逐个数、不抽样：漏一个就是漏一个。
   *
   * 判据用 Playwright 的 `toHaveAccessibleName`（真按 accname 算法算）。
   * ⚠️ **不要改用 `label.textContent` 一类的手工判据**——本用例初稿就是那么写的，
   * 试红时才发现它对「包裹式 `<label>` + `<select>`」永远通过：`textContent` 把
   * `<option>` 的文字也算成标签，于是「标签被清空」这种真缺陷判不出来。
   * 一条抓不到缺陷的断言，比没有断言更糟——它占着位置让人以为覆盖到了。
   */
  test('15. 任务页的每个表单控件都有可访问名（读屏器不念「编辑框」）', async () => {
    // 展开一条任务的详情，把里面那一批控件也算进来
    const row = rowOf(page, '写论文第三章')
    if ((await row.count()) > 0) {
      const toggle = row.getByRole('button', { name: /详情|收起/ })
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    }

    const controls = page.locator('input:visible, select:visible, textarea:visible')
    const total = await controls.count()
    expect(total, '页面上应当有表单控件可查').toBeGreaterThan(5)

    const unnamed: string[] = []
    for (let index = 0; index < total; index += 1) {
      const control = controls.nth(index)
      try {
        await expect(control).toHaveAccessibleName(/\S/, { timeout: 1_000 })
      } catch {
        unnamed.push(await control.evaluate((el) => el.outerHTML.slice(0, 140)))
      }
    }

    expect(unnamed, `这些控件没有可访问名：\n${unnamed.join('\n')}`).toEqual([])
  })
})

/* -------------------------------------------------------------------------
   小工具
   ------------------------------------------------------------------------- */

/** `[dow]` = 0（周一）… 6（周日）；取「下一个到来的星期 dow，含今天」（ADR-014 §4.1） */
function nextWeekday(today: string, dow: number): string {
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = addDays(today, offset)
    if (diffDays(weekStart(candidate), candidate) === dow) return candidate
  }
  throw new Error(`算不出星期 ${dow}`)
}

/** 预览里的相对词（与界面的 `relativeHint` 同一判据；这里只用于断言，不参与实现） */
function relativeText(dk: string, today: string): string {
  const days = diffDays(today, dk)
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  if (days === 2) return '后天'
  if (days === 3) return '大后天'
  return days > 0 ? `${days} 天后` : `${-days} 天前`
}
