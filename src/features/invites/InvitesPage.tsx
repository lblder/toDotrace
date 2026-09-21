import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useCreateInvite, useInvites, useMembers } from '../../hooks/use-invites'
import { errorMessage, type InviteSummary } from '../../lib/api-client'
import { formatInstant, isPastInstant } from '../../lib/datetime'
import { Field } from '../common/Field'
import { IconAlert, IconCheck } from '../common/Icons'
import './invites.css'

const DEFAULT_DAYS = 7
const MIN_DAYS = 1
const MAX_DAYS = 30

/**
 * 有效期天数：ADR-008 §8 补遗冻结为 1–30 的整数，缺省 7 天。
 * 这里**只校验能离线判断的部分**；签发失败的原因（频率、权限）只有服务端知道。
 */
function checkDays(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return `请输入有效期天数（${MIN_DAYS}–${MAX_DAYS}）`
  if (!/^\d+$/.test(trimmed)) return '有效期要填整数天'
  const days = Number(trimmed)
  if (days < MIN_DAYS || days > MAX_DAYS) {
    return `有效期需在 ${MIN_DAYS}–${MAX_DAYS} 天之间`
  }
  return null
}

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * 邀请码（owner 专属，ADR-008 §2）。
 *
 * 一条硬规则：**明文 code 只在签发响应里出现一次**——列表接口不返回它，
 * 服务端只存 SHA-256。所以签发成功后必须当场把码交给用户，
 * 并且明说「只显示这一次」。离开本页即丢失，不做任何持久化。
 */
export function InvitesPage() {
  const { invites, isLoading, isError, error } = useInvites()
  const createInvite = useCreateInvite()
  // 没有任何「已使用」的记录时不必问服务端要成员表
  const { memberById } = useMembers(invites.some((invite) => invite.usedBy !== null))

  const [days, setDays] = useState(String(DEFAULT_DAYS))
  const [daysError, setDaysError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const daysRef = useRef<HTMLInputElement>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (createInvite.isPending) return

    const problem = checkDays(days)
    setDaysError(problem)
    if (problem !== null) {
      daysRef.current?.focus()
      return
    }

    setBanner(null)
    setCopyState('idle')
    createInvite.mutate(
      { expiresInDays: Number(days.trim()) },
      {
        onSuccess: (payload) => {
          // 明文只此一次，就地持有；不进 React Query 缓存
          setIssued({ code: payload.invite.code, expiresAt: payload.invite.expiresAt })
        },
        onError: (cause) => {
          setBanner(errorMessage(cause))
        },
      },
    )
  }

  async function copyCode() {
    if (issued === null) return
    try {
      await navigator.clipboard.writeText(issued.code)
      setCopyState('copied')
    } catch {
      // 剪贴板可能被权限或非安全上下文挡下——如实说，并给出退路
      setCopyState('failed')
    }
  }

  return (
    <>
      <section className="ta-card ta-invites__head" aria-labelledby="invites-heading">
        <p className="ta-invites__eyebrow ta-mono">INVITES</p>
        <h1 className="ta-invites__heading" id="invites-heading">
          邀请码
        </h1>
        <p className="ta-invites__subtitle">
          签发一枚邀请码，把它交给实验室同伴，对方即可凭码注册一个成员账号。
          邀请码有有效期，用过一次即失效；签发后不可撤销。
        </p>
      </section>

      <section className="ta-card ta-invites__issue" aria-labelledby="invites-issue-heading">
        <h2 className="ta-invites__sectionHeading" id="invites-issue-heading">
          签发新邀请码
        </h2>

        <form className="ta-invites__form" onSubmit={handleSubmit} noValidate>
          <Field
            label="有效期（天）"
            value={days}
            onChange={(value) => {
              setDays(value)
              setDaysError(null)
              setBanner(null)
            }}
            error={daysError}
            hint={`${MIN_DAYS}–${MAX_DAYS} 天，默认 ${DEFAULT_DAYS} 天`}
            disabled={createInvite.isPending}
            inputRef={daysRef}
            mono
          />

          <button
            type="submit"
            className="ta-btn ta-btn--primary"
            disabled={createInvite.isPending}
            aria-busy={createInvite.isPending}
          >
            {createInvite.isPending ? '正在签发…' : '签发邀请码'}
          </button>
        </form>

        {banner === null ? null : (
          <p className="ta-banner ta-banner--error" role="alert">
            <IconAlert size={18} />
            <span>{banner}</span>
          </p>
        )}

        {issued === null ? null : (
          <div className="ta-invites__issued" role="status" aria-live="polite">
            <p className="ta-invites__issuedTitle">
              <IconCheck size={18} />
              邀请码已签发
            </p>
            <code className="ta-invites__code ta-mono">{issued.code}</code>
            <p className="ta-invites__warn" role="alert">
              此码只显示这一次，请立即复制。离开本页后将无法再次查看。
            </p>
            <p className="ta-invites__expiry">
              有效期至 <span className="ta-mono">{formatInstant(issued.expiresAt)}</span>
            </p>
            <div className="ta-invites__issuedActions">
              <button type="button" className="ta-btn ta-btn--secondary" onClick={copyCode}>
                {copyState === 'copied' ? '已复制' : '复制邀请码'}
              </button>
              <button
                type="button"
                className="ta-btn ta-btn--ghost"
                onClick={() => {
                  setIssued(null)
                  setCopyState('idle')
                }}
              >
                我已保存，隐藏
              </button>
            </div>
            {copyState === 'failed' ? (
              <p className="ta-invites__hint">
                浏览器拒绝了剪贴板访问，请手动选中上方邀请码复制。
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="ta-card ta-invites__list" aria-labelledby="invites-list-heading">
        <h2 className="ta-invites__sectionHeading" id="invites-list-heading">
          签发记录
        </h2>

        {isLoading ? (
          <p className="ta-invites__hint">正在载入…</p>
        ) : isError ? (
          <p className="ta-banner ta-banner--error" role="alert">
            <IconAlert size={18} />
            <span>{errorMessage(error)}</span>
          </p>
        ) : invites.length === 0 ? (
          <p className="ta-invites__hint">还没有签发过邀请码。</p>
        ) : (
          <ul className="ta-invites__items">
            {invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} nameOf={memberById} />
            ))}
          </ul>
        )}

        <p className="ta-invites__footnote">
          列表只显示元信息。明文邀请码在签发后不再保留——服务端只存它的哈希。
        </p>
      </section>
    </>
  )
}

type InviteStatus = 'used' | 'expired' | 'open'

function statusOf(invite: InviteSummary): InviteStatus {
  if (invite.usedBy !== null) return 'used'
  return isPastInstant(invite.expiresAt) ? 'expired' : 'open'
}

const STATUS_LABEL: Readonly<Record<InviteStatus, string>> = {
  used: '已使用',
  expired: '已过期',
  open: '待使用',
}

/** 复用 components.css 的徽标修饰符，不再新造一套状态色 */
const STATUS_BADGE: Readonly<Record<InviteStatus, string>> = {
  used: 'ta-badge ta-badge--success',
  expired: 'ta-badge ta-badge--overdue',
  open: 'ta-badge ta-badge--primary',
}

function InviteRow({
  invite,
  nameOf,
}: {
  invite: InviteSummary
  nameOf: ReadonlyMap<string, { displayName: string; username: string }>
}) {
  const status = statusOf(invite)
  // null = 这枚码还没被用；undefined 由 ?? 收敛成 null = 用了但成员表里查不到
  const usedBy = invite.usedBy === null ? null : (nameOf.get(invite.usedBy) ?? null)

  return (
    <li className="ta-invites__item">
      <div className="ta-invites__itemHead">
        {/* 状态用文字 + 颜色双重表达，不单靠颜色 */}
        <span className={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</span>
        <span className="ta-invites__itemTime ta-mono">
          签发 {formatInstant(invite.createdAt)}
        </span>
      </div>
      <dl className="ta-invites__itemFacts">
        <div>
          <dt>有效期至</dt>
          <dd className="ta-mono">{formatInstant(invite.expiresAt)}</dd>
        </div>
        <div>
          <dt>使用者</dt>
          <dd>
            {invite.usedBy === null ? (
              '—'
            ) : usedBy === null ? (
              // 成员表还没回来或查不到：退回到 id，不编造名字
              <span className="ta-mono">{invite.usedBy}</span>
            ) : (
              `${usedBy.displayName}（@${usedBy.username}）`
            )}
          </dd>
        </div>
        {invite.usedAt === null ? null : (
          <div>
            <dt>使用时间</dt>
            <dd className="ta-mono">{formatInstant(invite.usedAt)}</dd>
          </div>
        )}
      </dl>
    </li>
  )
}
