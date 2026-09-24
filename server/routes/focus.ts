import { Router, type Request, type RequestHandler } from 'express'
import { isDayKey } from '@shared/time'
import type { Db } from '../db/connection.js'
import { addToFocusToday, focusToday, removeFromFocusToday } from '../focus/service.js'
import { invalidInput } from '../lib/errors.js'
import { assertNoBody } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'

function pathParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string' || value.length === 0) throw invalidInput(`路径参数 ${name} 不能为空`)
  return value
}

function occurrenceKeyParam(req: Request): string {
  const value = pathParam(req, 'occurrenceKey')
  if (!isDayKey(value)) throw invalidInput('occurrenceKey 必须是真实日历日（YYYY-MM-DD）')
  return value
}

export function focusRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/today', (req, res) => {
    res.json(focusToday(db, getAuth(req).user.id, new Date()))
  })

  router.put('/today/:taskId/:occurrenceKey', (req, res) => {
    assertNoBody(req.body)
    const accountId = getAuth(req).user.id
    const taskId = pathParam(req, 'taskId')
    const occurrenceKey = occurrenceKeyParam(req)
    const result = db.transaction(() =>
      addToFocusToday(db, accountId, new Date(), taskId, occurrenceKey),
    )()
    res.status(200).json(result)
  })

  router.delete('/today/:taskId/:occurrenceKey', (req, res) => {
    assertNoBody(req.body)
    const accountId = getAuth(req).user.id
    const taskId = pathParam(req, 'taskId')
    const occurrenceKey = occurrenceKeyParam(req)
    const result = db.transaction(() =>
      removeFromFocusToday(db, accountId, new Date(), taskId, occurrenceKey),
    )()
    res.status(200).json(result)
  })

  return router
}
