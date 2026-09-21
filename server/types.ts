import type { SessionRow } from './repo/sessions.js'
import type { UserRow } from './repo/users.js'

/** 鉴权通过后挂在请求上的身份上下文（架构文档 §3.2：鉴权后请求携带账号身份）。 */
export interface AuthContext {
  user: UserRow
  session: SessionRow
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}
