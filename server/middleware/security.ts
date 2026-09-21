import type { RequestHandler } from 'express'

/**
 * 安全响应头（ADR-008 §6）。
 *
 * style-src 需要 'unsafe-inline' 是因为 React 内联样式与 CSS 变量注入；
 * script-src 不给任何例外（架构文档 §9 必做 8：自包含静态资源，外网请求一律拒绝）。
 * 逐字符照抄 ADR，改动必须先改 ADR。
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    next()
  }
}
