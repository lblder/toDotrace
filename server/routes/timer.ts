import { Router, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { isDayKey } from '@shared/time'
import type { Db } from '../db/connection.js'
import { invalidInput } from '../lib/errors.js'
import { isUuidV7 } from '../lib/uuid.js'
import { parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'
import { configureTimer, pauseTimer, startTimer, timerSnapshot } from '../timer/service.js'

const uuid = z.string().refine(isUuidV7, '必须是 UUIDv7')
const startSchema = z.object({
  taskId: uuid,
  occurrenceKey: z.string().refine(isDayKey, '必须是真实日历日'),
}).strict()
const pauseSchema = z.object({ sessionId: uuid }).strict()
const configureSchema = z.object({ enabled: z.boolean() }).strict()

function taskIdParam(req: Request): string {
  const taskId = req.params.taskId
  if (typeof taskId !== 'string' || !isUuidV7(taskId)) throw invalidInput('taskId 必须是 UUIDv7')
  return taskId
}

export function timerRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/', (req, res) => {
    res.json(timerSnapshot(db, getAuth(req).user.id, new Date()))
  })

  router.put('/tasks/:taskId', (req, res) => {
    const taskId = taskIdParam(req)
    const { enabled } = parseInput(configureSchema, req.body ?? {})
    const accountId = getAuth(req).user.id
    res.json(db.transaction(() => configureTimer(db, accountId, new Date(), taskId, enabled))())
  })

  router.post('/start', (req, res) => {
    const { taskId, occurrenceKey } = parseInput(startSchema, req.body ?? {})
    const accountId = getAuth(req).user.id
    res.json(db.transaction(() => startTimer(db, accountId, new Date(), taskId, occurrenceKey))())
  })

  router.post('/pause', (req, res) => {
    const { sessionId } = parseInput(pauseSchema, req.body ?? {})
    const accountId = getAuth(req).user.id
    res.json(db.transaction(() => pauseTimer(db, accountId, new Date(), sessionId))())
  })

  return router
}
