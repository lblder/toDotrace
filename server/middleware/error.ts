import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ApiError, internalError, notFound } from '../lib/errors.js'

/** 未命中任何路由：统一 404（不含任何「哪个路径存在」的信息）。 */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound())
}

interface BodyParserError extends Error {
  type?: string
  status?: number
}

/**
 * 统一错误信封（ADR-008 §1）——响应体只有 { error: { code, message } } 一种形态。
 * 未预期的异常一律 500 + 泛化文案，细节只进服务端日志，不外泄。
 */
export function createErrorHandler(options: { log?: (message: string, detail: unknown) => void } = {}) {
  const log = options.log ?? ((message: string, detail: unknown) => console.error(message, detail))

  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) {
      // 响应已开始写出，只能中断连接。
      res.end()
      return
    }

    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } })
      return
    }

    const bodyError = err as BodyParserError
    if (bodyError && typeof bodyError.type === 'string') {
      if (bodyError.type === 'entity.parse.failed') {
        res.status(400).json({
          error: { code: 'validation/invalid-input', message: '请求体不是合法 JSON' },
        })
        return
      }
      if (bodyError.type === 'entity.too.large') {
        res.status(400).json({
          error: { code: 'validation/invalid-input', message: '请求体过大' },
        })
        return
      }
    }

    const apiError = internalError()
    log(`[error] ${req.method} ${req.path} 未预期异常`, err)
    res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } })
  }
}
