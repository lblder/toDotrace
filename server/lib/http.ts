import type { NextFunction, Request, RequestHandler, Response } from 'express'

/** 异步处理器包装：显式把 rejection 交给错误中间件，不依赖框架版本的隐式行为。 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}
