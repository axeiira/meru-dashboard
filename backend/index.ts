import express from 'express'
import cookieParser from 'cookie-parser'
import { randomUUID } from 'node:crypto'
import { config } from './config'
import { assertRlsRole } from './db'
import { Authed, errorHandler } from './http'
import { platformRouter } from './routes/platform'
import { authRouter } from './routes/auth'
import { membersRouter } from './routes/members'
import { clientsRouter } from './routes/clients'
import { projectsRouter } from './routes/projects'
import { boqRouter } from './routes/boq'
import { scheduleRouter } from './routes/schedule'
import { progressRouter } from './routes/progress'
import { ticketsRouter } from './routes/tickets'

const app = express()
app.use(express.json())
app.use(cookieParser())
app.use((req, _res, next) => {
  ;(req as Authed).id = `req_${randomUUID()}`
  next()
})

app.get('/api/v1/health', (_req, res) => res.json({ ok: true }))

app.use('/api/v1/platform', platformRouter)
app.use('/api/v1/auth', authRouter)
app.use('/api/v1', membersRouter)
app.use('/api/v1', clientsRouter)
app.use('/api/v1', projectsRouter)
app.use('/api/v1', boqRouter)
app.use('/api/v1', scheduleRouter)
app.use('/api/v1', progressRouter)
app.use('/api/v1', ticketsRouter)

app.use(errorHandler)

assertRlsRole()
  .then(() =>
    app.listen(config.PORT, () =>
      console.log(`API listening on http://localhost:${config.PORT}/api/v1`),
    ),
  )
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
