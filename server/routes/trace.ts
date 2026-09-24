import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { TracePeriod } from '@shared/trace/types'
import type { Db } from '../db/connection.js'
import { invalidInput } from '../lib/errors.js'
import { parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'
import { getTrace, type TraceQuery } from '../trace/service.js'

const querySchema = z.object({
  period: z.enum(['week', 'month', '90d', 'all', 'project']).default('month'),
  projectId: z.string().min(1).optional(),
  goalMinutes: z.coerce.number().int().min(60).max(720).default(360),
}).strict()

/** 只接受 ADR-018 列出的三个查询参数；项目标识与 period 必须成对出现。 */
export function parseTraceQuery(query: unknown): TraceQuery {
  const parsed = parseInput(querySchema, query)
  if (parsed.period === 'project' && parsed.projectId === undefined) {
    throw invalidInput('period=project 时必须提供 projectId')
  }
  if (parsed.period !== 'project' && parsed.projectId !== undefined) {
    throw invalidInput('projectId 只可用于 period=project')
  }
  return { period: parsed.period as TracePeriod, projectId: parsed.projectId, goalMinutes: parsed.goalMinutes }
}

export function traceRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)
  router.get('/', (req, res) => {
    const accountId = getAuth(req).user.id
    res.json(getTrace(db, accountId, new Date(), parseTraceQuery(req.query)))
  })
  return router
}
