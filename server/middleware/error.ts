import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { AnchorInvariantError } from '@shared/recurrence'
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
 * `AnchorInvariantError` 上那个**由服务端附加**的 `taskId`（见 `tasks/sources.ts`）。
 *
 * 它在错误对象上是可选属性，故这里读到的可能是 `undefined`：从重建、导入等
 * **没有任务上下文**的路径抛出来时它本来就该缺席——那时「不知道是哪条任务」是事实，
 * 而不是缺陷。
 */
function taskIdOf(error: AnchorInvariantError): string {
  const value = (error as { taskId?: unknown }).taskId
  return typeof value === 'string' && value.length > 0 ? value : '(未知任务)'
}

/**
 * 统一错误信封（ADR-008 §1）——响应体只有 { error: { code, message } } 一种形态。
 * 未预期的异常一律 500 + 泛化文案，细节只进服务端日志，不外泄。
 *
 * ## `AnchorInvariantError` 的分支（ADR-017 §2）
 *
 * 它是**读时抛出**的：`deriveRounds` 发现某条完成事件固化的锚点不满足 ADR-011 §5 的
 * 不变式（`nextAnchorDate <= originalPlannedDate`）时抛错，而**写入路径不拦它**
 * （事件层照收，`events-recurrence.test.ts` 明文锁定）。于是症状是
 * **一条坏的完成事件会让整个 `GET /api/tasks` 返回 500**，而用户看到的是
 * 「待办列表打不开」，没有任何线索指向那条事件。
 *
 * 本 ADR 的处置（**不开新码**）：
 *
 * - 落成 `500 server/internal-error`（**不降级成 4xx**）；
 * - **日志里带上 `taskId` 与 `originalPlannedDate`**（该错误对象上后者本来就有，
 *   前者由 `tasks/sources.ts` 在缝合时附上）——使「哪条事件坏了」从猜测变成可查的事实；
 * - **不吞掉后返回部分结果**：吞掉会让错误的轮次**静默消失**，
 *   而「静默失真」正是本项目一路在防的东西。
 *
 * 单独写一个分支（而不是交给下面的通用分支）只有一个理由：**日志要结构化**。
 * 通用分支把整个 error 对象丢给日志出口，而测试与运维需要的三个字段
 * （`taskId` / `originalPlannedDate` / `nextAnchorDate`）散在对象的可见属性里。
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

    if (err instanceof AnchorInvariantError) {
      log(`[error] ${req.method} ${req.path} 锚点不变式被破坏（ADR-011 §5 / ADR-017 §2）`, {
        taskId: taskIdOf(err),
        originalPlannedDate: err.originalPlannedDate,
        nextAnchorDate: err.nextAnchorDate,
        message: err.message,
      })
      const apiError = internalError()
      res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } })
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
