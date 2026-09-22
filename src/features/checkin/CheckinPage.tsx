import { useState } from 'react'
import { DEFAULT_DAY_START_HOUR } from '@shared/time'
import { useCheckin } from '../../hooks/use-checkin'
import type { CheckinMutation } from '../../hooks/use-checkin'
import { errorMessage } from '../../lib/api-client'
import type { CheckinResult, DayRow } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import { formatClock, formatInstant } from '../../lib/datetime'
import { IconAlert, IconInfo } from '../common/Icons'
import './checkin.css'

/** 动作结果的一条如实反馈 */
interface Feedback {
  readonly tone: 'info' | 'error'
  readonly text: string
}

/**
 * 今日打卡（01 FR1 / ADR-012）。
 *
 * 三种状态各有各的呈现，**都不是错误态**：
 *   · `day === null` —— 今天还没有到达记录 = 休息日：中性文案「今天偷偷懒」，
 *     下面就是「到达实验室」按钮（02 §3 的流程图：休息日正是打卡的起点）；
 *   · 有到达、无离开 —— 压在纸上的那枚章 + 可选的离开动作；
 *   · 有到达、有离开 —— 今天的记录已闭合，不再提供任何写入入口。
 *
 * 本阶段的边界（ADR-012 §1 / §7）：
 *   · **没有备注输入**——推迟到阶段 4，这里连输入框都不摆；
 *   · **没有撤销 / 编辑**——撤销入口属阶段 5，本阶段用户没有任何更正手段，
 *     所以界面上不会出现一个按了没用的「撤销」按钮；
 *   · **不显示时长**——`left_at - arrived_at` 的统计属阶段 6，
 *     这里只如实列出两个时刻，不替用户算（FR1：无离开记录则时长未知）。
 */
export function CheckinPage() {
  const { day, streak, isLoading, isError, error, refetch, arrive, leave } = useCheckin()

  const [feedback, setFeedback] = useState<Feedback | null>(null)
  /**
   * 本次会话里刚压下的那次到达。
   *
   * 它只用来决定**入场动效跑不跑**：刷新、重取、幂等命中都不会重放仪式。
   * 存的是到达时刻而不是布尔值——换了一天、或换了另一次到达，等值判断自然失效。
   */
  const [pressedAt, setPressedAt] = useState<string | null>(null)

  function runAction(action: CheckinMutation, describe: (result: CheckinResult) => Feedback): void {
    if (action.isPending) return
    setFeedback(null)
    action.mutate(undefined, {
      onSuccess: (result) => {
        setFeedback(describe(result))
      },
      onError: (cause) => {
        setFeedback({ tone: 'error', text: errorMessage(cause) })
      },
    })
  }

  function handleArrive(): void {
    runAction(arrive, (result) => {
      if (!result.created) {
        // 幂等命中（ADR-012 §3）：服务端没有写新记录，界面也**不能**演一遍刚打上的戏。
        // 说出那次真实到达的时刻——它来自响应，不是此刻的时钟。
        setPressedAt(null)
        return { tone: 'info', text: `你今天 ${formatClock(result.day.arrivedAt)} 已经打过卡了。` }
      }
      setPressedAt(result.day.arrivedAt)
      return { tone: 'info', text: `已记录到达：${formatClock(result.day.arrivedAt)}。` }
    })
  }

  function handleLeave(): void {
    runAction(leave, (result) => {
      // 时刻取自响应里的 leftAt——它是**服务端记录的那一刻**，不是此刻的时钟。
      const at = result.day.leftAt === null ? null : formatClock(result.day.leftAt)
      if (!result.created) {
        // 幂等命中（ADR-012 §5 v1.2：分流键是「有无到达」，最近那条已闭合就返回它）。
        // 与到达同一条纪律：不演「刚记上」，而说出第一次记录的时刻。
        return { tone: 'info', text: at === null ? '今天已经记过离开了。' : `你今天 ${at} 已经记过离开了。` }
      }
      return { tone: 'info', text: at === null ? '已记录离开。' : `已记录离开：${at}。` }
    })
  }

  return (
    <>
      <section className="ta-card ta-checkin__today" aria-labelledby="checkin-heading">
        <p className="ta-checkin__eyebrow ta-mono">CHECK-IN</p>
        <h1 className="ta-checkin__heading" id="checkin-heading">
          今日打卡
        </h1>
        <p className="ta-checkin__subtitle">
          到达记一次，离开可选。一天至多一条记录，重复打卡不会写第二条。
        </p>

        {isLoading ? (
          <p className="ta-checkin__hint">正在读取今日状态…</p>
        ) : isError ? (
          <div className="ta-checkin__error">
            <p className="ta-banner ta-banner--error" role="alert">
              <IconAlert size={18} />
              <span>{errorMessage(error)}</span>
            </p>
            <button type="button" className="ta-btn ta-btn--secondary" onClick={refetch}>
              重试
            </button>
          </div>
        ) : day === null ? (
          <RestDay onArrive={handleArrive} pending={arrive.isPending} />
        ) : (
          <ArrivedDay
            day={day}
            animate={pressedAt !== null && pressedAt === day.arrivedAt}
            onLeave={handleLeave}
            pending={leave.isPending}
          />
        )}

        {feedback === null ? null : (
          <p
            className={
              feedback.tone === 'error' ? 'ta-banner ta-banner--error' : 'ta-banner ta-banner--info'
            }
            role={feedback.tone === 'error' ? 'alert' : 'status'}
          >
            {feedback.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
            <span>{feedback.text}</span>
          </p>
        )}
      </section>

      {/* 读数卡依赖 /today 的成功结果：没拿到就不摆一个编出来的 0 */}
      {isLoading || isError ? null : (
        <section className="ta-card ta-checkin__streak" aria-labelledby="checkin-streak-heading">
          <h2 className="ta-checkin__sectionHeading" id="checkin-streak-heading">
            连续打卡
          </h2>
          <p className="ta-checkin__streakValue">
            <span className="ta-checkin__streakNumber ta-readout">{streak}</span>
            <span className="ta-checkin__streakUnit">天</span>
          </p>
          <p className="ta-checkin__streakNote">
            按有到达记录的日子往回数：今天还没到达就从昨天数起，当天尚未打卡不会立刻清零；
            中间断了就从断掉的地方重新开始。
          </p>
        </section>
      )}

      <p className="ta-checkin__footnote">
        一天的边界默认为凌晨 {DEFAULT_DAY_START_HOUR}:00：
        在这个时刻之前的到达会记入前一天。归属日在写入时确定，此后不再重算。
      </p>
    </>
  )
}

/* -------------------------------------------------------------------------
   休息日：无到达记录的一天（ADR-002 §3 / ADR-012 §5）
   ------------------------------------------------------------------------- */

/**
 * 休息日**不是**错误态、不是缺失态，是结构上就有的一种正常状态。
 * 因此文案与视觉都不带评判：说清「今天还没有到达记录」「不计入打卡天数」，
 * 再把打卡入口摆在下面——它就是这一天开始的方式。
 */
function RestDay({ onArrive, pending }: { onArrive: () => void; pending: boolean }) {
  return (
    <div className="ta-checkin__body">
      <div className="ta-checkin__rest">
        <p className="ta-checkin__restMain">今天偷偷懒</p>
        <p className="ta-checkin__restNote">
          今天还没有到达记录。这一天不计入打卡天数，也不会写进任何统计。
        </p>
      </div>

      <div className="ta-checkin__actions">
        <button
          type="button"
          className="ta-btn ta-btn--primary"
          onClick={onArrive}
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? '正在记录…' : '到达实验室'}
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------
   已到达：印章 + 事实 + （可选的）离开
   ------------------------------------------------------------------------- */

function ArrivedDay({
  day,
  animate,
  onLeave,
  pending,
}: {
  day: DayRow
  animate: boolean
  onLeave: () => void
  pending: boolean
}) {
  return (
    <div className="ta-checkin__body">
      <div className="ta-checkin__stampStage">
        <Stamp day={day} animate={animate} />
      </div>

      <dl className="ta-checkin__facts">
        <div className="ta-checkin__fact">
          <dt>归属日</dt>
          <dd className="ta-mono">{day.dayKey}</dd>
        </div>
        <div className="ta-checkin__fact">
          <dt>到达</dt>
          <dd className="ta-mono">{formatInstant(day.arrivedAt)}</dd>
        </div>
        <div className="ta-checkin__fact">
          <dt>离开</dt>
          <dd className="ta-mono">
            {day.leftAt === null ? '未记录' : formatInstant(day.leftAt)}
          </dd>
        </div>
      </dl>

      {day.leftAt === null ? (
        <>
          <div className="ta-checkin__actions">
            <button
              type="button"
              className="ta-btn ta-btn--secondary"
              onClick={onLeave}
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? '正在记录…' : '离开实验室'}
            </button>
          </div>
          <p className="ta-checkin__hint">
            离开可以不点：不点的话这一天只记到达时刻，时长按「未知」处理，不自动闭合、不猜。
          </p>
        </>
      ) : (
        <p className="ta-checkin__hint">今天的到达与离开都已记录，不会再有新的写入。</p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------
   印章 —— 到达时压下的一枚章（03 §7 的签名元素）
   ------------------------------------------------------------------------- */

/**
 * 两条纪律写在结构里，而不是写在注释里：
 *
 * 1. **静态即终态**：`transform: rotate(-6deg)` 那套就是「章已经压好了」的样子，
 *    动效只负责入场（`@keyframes` 只有 `from`）。所以 reduced-motion 下时长归零时，
 *    看到的就是这枚章本身——不会出现「先消失、再瞬间蹦出来」。
 * 2. **只压一次**：跑不跑动效由调用方按 `created === true` 决定，
 *    刷新、重取、幂等命中都不重放。仪式只属于真正落笔的那一下（§7：其余动效克制）。
 *
 * 对读屏器隐藏：同样的信息在下面的「到达」一行里是文本，结果也由 role=status 播报，
 * 这里只是把它**画**出来。
 */
function Stamp({ day, animate }: { day: DayRow; animate: boolean }) {
  return (
    <div
      className={cx('ta-checkin__stamp', animate && 'ta-checkin__stamp--press')}
      aria-hidden="true"
    >
      <span className="ta-checkin__stampRing" />
      <span className="ta-checkin__stampLabel">到达</span>
      <span className="ta-checkin__stampTime ta-mono">{formatClock(day.arrivedAt)}</span>
    </div>
  )
}
