/**
 * dsh-zhihu — loopback HTTP routes for the web panel.
 *
 * Route family: /api/dsh-zhihu/*. Every route is loopback-only
 * (127.0.0.1 / ::1, same-origin), matching the other dsh-* panels. The panel
 * reads status/config, drives QR login, and runs quick hot-list / search
 * lookups through the same CLI layer the agent tools use.
 */

import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { isAlive } from './exec.ts'
import { call } from './invoke.ts'
import { readChromeZhihuCookies } from './browser-cookie.ts'
import { buildTools } from './tools.ts'
import { clearCredentials, readLoginRecord, saveCookieString, startQrLogin } from './login.ts'
import { compactList, compactProfile, emptyProfile, type CompactItem, type CompactProfile } from './parse.ts'
import type { ZhihuStore } from './store.ts'

/** Route paths. */
export const ZHIHU_API = {
  status: '/api/dsh-zhihu/status',
  config: '/api/dsh-zhihu/config',
  login: '/api/dsh-zhihu/login',
  browserLogin: '/api/dsh-zhihu/browser-login',
  qrcode: '/api/dsh-zhihu/qrcode',
  logout: '/api/dsh-zhihu/logout',
  whoami: '/api/dsh-zhihu/whoami',
  hot: '/api/dsh-zhihu/hot',
  search: '/api/dsh-zhihu/search',
  // 1:1 mirrors of the agent tools, so the panel and the model get identical
  // payloads (the earlier hand-wired subset is how the panel ended up thinner
  // than the plugin's actual capability).
  question: '/api/dsh-zhihu/question',
  answer: '/api/dsh-zhihu/answer',
  user: '/api/dsh-zhihu/user',
  feed: '/api/dsh-zhihu/feed',
  topic: '/api/dsh-zhihu/topic',
  notifications: '/api/dsh-zhihu/notifications',
  collections: '/api/dsh-zhihu/collections',
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** Cap on the QR PNG we are willing to inline as a data URL. */
const MAX_QRCODE_BYTES = 512 * 1024

/** Status payload returned to the panel. */
export interface ZhihuStatusPayload {
  ok: true
  cliAvailable: boolean
  cliVersion: string
  cliPath: string
  authenticated: boolean
  cookiePresent: boolean
  missingCookies: string[]
  savedAt: string
  qrcodePresent: boolean
  /** Whether the detached QR-login process is still running. */
  loginAlive: boolean
  /** Pid of the detached QR-login process (0 when none). */
  loginPid: number
  readOnly: boolean
  readOnlySource: string
  proxy: string
  proxyMode: string
  timeoutMs: number
  loginWaitMs: number
  cliHome: string
  configPath: string
  cookiePath: string
  qrcodePath: string
  logPath: string
}

/** Strict loopback fence for every route (the panel is same-origin only). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body (undefined when invalid). */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Route dependencies. */
export interface RouteContext {
  store: ZhihuStore
}

/** Build the route list for ctx.webServer.register. */
export function makeRoutes(deps: RouteContext) {
  const { store } = deps

  /**
   * The plugin's own read tools, invoked directly by the routes. Routing the
   * panel through the same ToolDefinition the model calls is what keeps the two
   * surfaces from drifting.
   */
  const readOnlyTools = buildTools({ store, readOnly: true })
  const toolByName = new Map(readOnlyTools.map((tool) => [tool.name, tool]))
  const runTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = toolByName.get(name)
    if (tool === undefined) return { ok: false, message: '未知工具：' + name }
    try {
      const value = await tool.execute(args, {
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof tool.execute>[1])
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : { ok: true }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  /** Cached `zhihu --version` (spawning Python on every 2s poll would be silly). */
  let versionCache: { value: string; at: number } | null = null
  const VERSION_TTL_MS = 5 * 60 * 1000

  const cliVersion = async (resolvedPath: string): Promise<string> => {
    if (resolvedPath === '') return ''
    if (versionCache !== null && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.value
    const result = await call(store, ['--version'])
    const value = result.stdout.split('\n')[0]?.trim() ?? ''
    versionCache = { value, at: Date.now() }
    return value
  }

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const queryOf = (req: IncomingMessage): URLSearchParams =>
    new URL(req.url ?? '/', 'http://127.0.0.1').searchParams

  /** Clamp a query parameter into a range. */
  const intParam = (params: URLSearchParams, key: string, fallback: number, min: number, max: number): number => {
    const raw = Number(params.get(key) ?? '')
    if (!Number.isFinite(raw)) return fallback
    return Math.max(min, Math.min(max, Math.floor(raw)))
  }

  return [
    {
      kind: 'exact' as const,
      path: ZHIHU_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const view = await store.view()
        const state = await store.loginState()
        const record = await readLoginRecord()
        const loginPid = record !== null && isAlive(record.pid) ? record.pid : 0
        const payload: ZhihuStatusPayload = {
          ok: true,
          cliAvailable: view.resolvedCliPath !== '',
          cliVersion: await cliVersion(view.resolvedCliPath),
          cliPath: view.resolvedCliPath,
          authenticated: state.hasRequired,
          cookiePresent: state.cookiePresent,
          missingCookies: state.missing,
          savedAt: state.savedAt,
          qrcodePresent: state.qrcodePresent,
          loginAlive: loginPid !== 0,
          loginPid,
          readOnly: view.readOnly,
          readOnlySource: view.readOnlySource,
          proxy: view.proxy,
          proxyMode: view.proxyMode,
          timeoutMs: view.timeoutMs,
          loginWaitMs: view.loginWaitMs,
          cliHome: view.cliHome,
          configPath: view.configPath,
          cookiePath: state.cookiePath,
          qrcodePath: state.qrcodePath,
          logPath: view.logPath,
        }
        writeJson(res, 200, payload)
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.config,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, await store.view())
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const patch: Parameters<ZhihuStore['patch']>[0] = {}
          if (typeof body.readOnly === 'boolean') patch.readOnly = body.readOnly
          if (typeof body.cliPath === 'string') patch.cliPath = body.cliPath
          if (typeof body.proxy === 'string') patch.proxy = body.proxy
          if (typeof body.cliHome === 'string') patch.cliHome = body.cliHome
          if (typeof body.timeoutMs === 'number') patch.timeoutMs = body.timeoutMs
          if (typeof body.loginWaitMs === 'number') patch.loginWaitMs = body.loginWaitMs
          if (body.reset === true) patch.reset = true
          writeJson(res, 200, await store.patch(patch))
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.qrcode,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const state = await store.loginState()
        if (!state.qrcodePresent) {
          writeJson(res, 200, { ok: true, qrcode: false, dataUrl: '', mtimeMs: 0 })
          return
        }
        try {
          const info = await stat(state.qrcodePath)
          if (info.size > MAX_QRCODE_BYTES) {
            writeJson(res, 200, { ok: false, qrcode: true, dataUrl: '', mtimeMs: info.mtimeMs, error: '二维码文件异常偏大' })
            return
          }
          const buffer = await readFile(state.qrcodePath)
          writeJson(res, 200, {
            ok: true,
            qrcode: true,
            dataUrl: 'data:image/png;base64,' + buffer.toString('base64'),
            mtimeMs: info.mtimeMs,
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, qrcode: false, dataUrl: '', mtimeMs: 0, error: (error as Error).message })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.login,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const outcome = await startQrLogin(store)
        writeJson(res, 200, {
          ok: outcome.error === '' || outcome.alive,
          started: outcome.started,
          alive: outcome.alive,
          pid: outcome.pid,
          qrcodePresent: outcome.qrcodePresent,
          error: outcome.error,
        })
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.browserLogin,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const imported = await readChromeZhihuCookies()
        if (!imported.ok) {
          writeJson(res, 200, { ok: false, error: imported.error })
          return
        }
        const raw = Object.entries(imported.cookies)
          .map(([name, value]) => name + '=' + value)
          .join('; ')
        const saved = await saveCookieString(store, raw)
        if (!saved.ok) {
          writeJson(res, 200, { ok: false, error: saved.error })
          return
        }
        const verify = await call(store, ['whoami', '--json'], { json: true })
        if (!verify.ok) {
          await clearCredentials(store)
          writeJson(res, 200, { ok: false, error: '导入的 Cookie 校验失败：' + verify.error })
          return
        }
        const profile = compactProfile(verify.json)
        writeJson(res, 200, {
          ok: true,
          error: '',
          profile: imported.profile,
          cookieCount: imported.names.length,
          account: profile.name,
        })
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.logout,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const cli = await call(store, ['logout'])
        const removed = await clearCredentials(store)
        writeJson(res, 200, { ok: true, removed, cliOk: cli.ok })
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.whoami,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const result = await call(store, ['whoami', '--json'], { json: true })
        if (!result.ok) {
          writeJson(res, 200, { ok: false, error: result.error, profile: emptyProfile() })
          return
        }
        const profile: CompactProfile = compactProfile(result.json)
        writeJson(res, 200, { ok: true, error: '', profile })
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.hot,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const limit = intParam(queryOf(req), 'limit', 10, 1, 50)
        const result = await call(store, ['hot', '-l', String(limit), '-a', '0', '--json'], { json: true })
        if (!result.ok) {
          writeJson(res, 200, { ok: false, error: result.error, items: [] })
          return
        }
        const items: CompactItem[] = compactList(result.json)
        writeJson(res, 200, { ok: true, error: '', items })
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.question,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_question', {
          questionId: params.get('id') ?? '',
          answers: params.get('answers') !== '0',
          limit: intParam(params, 'limit', 5, 1, 50),
          sort: params.get('sort') ?? 'default',
        }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.answer,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_answer', {
          answerId: params.get('id') ?? '',
          comments: params.get('comments') === '1',
          limit: intParam(params, 'limit', 20, 0, 200),
        }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.user,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_user', {
          urlToken: params.get('token') ?? '',
          include: params.get('include') ?? 'profile',
          limit: intParam(params, 'limit', 10, 1, 50),
        }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.feed,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_feed', {
          limit: intParam(params, 'limit', 10, 1, 50),
          withComments: params.get('withComments') === '1',
          commentLimit: intParam(params, 'commentLimit', 10, 0, 50),
        }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.topic,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_topic', {
          topicId: params.get('id') ?? '',
          hotQuestions: params.get('hot') === '1',
        }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.notifications,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_notifications', {
          limit: intParam(params, 'limit', 10, 1, 50),
          offset: intParam(params, 'offset', 0, 0, 10000),
        }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.collections,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        writeJson(res, 200, await runTool('zhihu_collections', { limit: intParam(params, 'limit', 10, 1, 50) }))
      },
    },
    {
      kind: 'exact' as const,
      path: ZHIHU_API.search,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        const query = (params.get('q') ?? '').trim()
        if (query === '') {
          writeJson(res, 400, { error: 'missing q' })
          return
        }
        const limit = intParam(params, 'limit', 5, 1, 20)
        const result = await call(store, ['search', query, '-l', String(limit), '--json'], { json: true })
        if (!result.ok) {
          writeJson(res, 200, { ok: false, error: result.error, items: [] })
          return
        }
        const items: CompactItem[] = compactList(result.json)
        writeJson(res, 200, { ok: true, error: '', items })
      },
    },
  ]
}
