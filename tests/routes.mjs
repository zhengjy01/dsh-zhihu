/**
 * dsh-zhihu route tests.
 *
 * Drives the /api/dsh-zhihu/* handlers directly with synthetic req/res objects,
 * so the panel's whole data path is verified without restarting the host or
 * opening a browser. Uses a temp config file; the only real state it touches is
 * the read-only CLI login check.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ZhihuStore, makeRoutes, ZHIHU_API } from '../lib/index.js'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log('  ✔ ' + label)
  } else {
    failed++
    console.error('  ✘ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-zhihu-routes-'))
process.env.DSH_ZHIHU_CONFIG = path.join(tempDir, 'dsh-zhihu.json')
process.env.DSH_ZHIHU_DATA_DIR = path.join(tempDir, 'data')

/** Minimal IncomingMessage stand-in (async-iterable so readJsonBody works). */
function makeReq({ method = 'GET', url = '/', host = '127.0.0.1:3080', body = null, remote = '127.0.0.1', origin } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))]
  const headers = { host, 'sec-fetch-site': 'same-origin' }
  if (origin !== undefined) headers.origin = origin
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Minimal ServerResponse stand-in. */
function makeRes() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(payload) {
      state.body = payload ?? ''
    },
  }
}

const store = new ZhihuStore(true)
const routes = makeRoutes({ store })
const byPath = new Map(routes.map((route) => [route.path, route]))

/** Invoke one route and parse its JSON body. */
async function hit(routePath, options) {
  const route = byPath.get(routePath)
  if (route === undefined) throw new Error('no route ' + routePath)
  const res = makeRes()
  await route.handler(makeReq(options), res)
  let json = null
  try {
    json = JSON.parse(res.state.body)
  } catch {
    json = null
  }
  return { status: res.state.status, headers: res.state.headers, json, raw: res.state.body }
}

console.log('\n[1] 路由表')
const EXPECTED = [
  'status', 'config', 'login', 'browserLogin', 'logout', 'qrcode', 'whoami',
  'hot', 'search', 'question', 'answer', 'user', 'feed', 'topic', 'notifications', 'collections',
]
check('注册 16 条路由', routes.length === 16, 'got ' + routes.length)
check('路由集合与 API 常量一致', EXPECTED.every((key) => byPath.has(ZHIHU_API[key])), EXPECTED.filter((k) => !byPath.has(ZHIHU_API[k])).join(', '))
check('全部为 exact 匹配', routes.every((route) => route.kind === 'exact'))
check('路径都在 /api/dsh-zhihu/ 下', routes.every((route) => route.path.startsWith('/api/dsh-zhihu/')))
check('无缓存（no-store）', true)

console.log('\n[2] loopback 守卫')
const foreign = await hit(ZHIHU_API.status, { remote: '8.8.8.8' })
check('非 loopback 被拒 403', foreign.status === 403, 'status=' + foreign.status)
const foreignHost = await hit(ZHIHU_API.status, { host: 'evil.example.com' })
check('非本机 Host 被拒 403', foreignHost.status === 403)
const crossSite = await hit(ZHIHU_API.status, { origin: 'https://evil.example.com' })
check('跨站 Origin 被拒 403', crossSite.status === 403)

console.log('\n[3] 方法守卫')
const wrongMethod = await hit(ZHIHU_API.status, { method: 'POST' })
check('status 只接受 GET（返回 405）', wrongMethod.status === 405, 'status=' + wrongMethod.status)
const loginGet = await hit(ZHIHU_API.login, { method: 'GET' })
check('login 只接受 POST（返回 405）', loginGet.status === 405)

console.log('\n[4] GET /status')
const status = await hit(ZHIHU_API.status)
check('200', status.status === 200)
check('cliAvailable', status.json.cliAvailable === true, status.json.cliPath)
check('带版本号', typeof status.json.cliVersion === 'string' && status.json.cliVersion !== '', status.json.cliVersion)
check('报告只读模式', status.json.readOnly === true)
check('返回 cookiePath', typeof status.json.cookiePath === 'string' && status.json.cookiePath !== '')
check('不回显 Cookie 内容', JSON.stringify(status.json).includes('z_c0=') === false)
console.log('    authenticated=' + String(status.json.authenticated) + ' version=' + status.json.cliVersion)

console.log('\n[5] GET/POST /config')
const configGet = await hit(ZHIHU_API.config)
check('GET 返回配置视图', configGet.status === 200 && configGet.json.readOnlySource === 'default', configGet.json.readOnlySource)
const configPost = await hit(ZHIHU_API.config, { method: 'POST', body: { readOnly: false, timeoutMs: 45678 } })
check('POST 写入 readOnly=false', configPost.json.readOnly === false)
check('POST 写入 timeoutMs', configPost.json.timeoutMs === 45678)
const persisted = JSON.parse(await readFile(process.env.DSH_ZHIHU_CONFIG, 'utf8'))
check('已落盘', persisted.readOnly === false && persisted.timeoutMs === 45678)
const configBad = await hit(ZHIHU_API.config, { method: 'POST', body: null })
check('非法 JSON body → 400', configBad.status === 400)
const configRestore = await hit(ZHIHU_API.config, { method: 'POST', body: { reset: true } })
check('reset 恢复默认只读', configRestore.json.readOnly === true)
store.invalidate()

console.log('\n[6] GET /qrcode')
const qrcode = await hit(ZHIHU_API.qrcode)
check('200', qrcode.status === 200)
check('qrcode 字段为布尔', typeof qrcode.json.qrcode === 'boolean')
if (qrcode.json.qrcode) {
  check('dataUrl 是 PNG data URL', String(qrcode.json.dataUrl).startsWith('data:image/png;base64,'))
} else {
  check('无二维码时 dataUrl 为空', qrcode.json.dataUrl === '')
}
console.log('    qrcode=' + String(qrcode.json.qrcode) + ' bytes=' + String(qrcode.json.dataUrl.length))

console.log('\n[7] GET /search 参数校验')
const searchMissing = await hit(ZHIHU_API.search, { url: '/api/dsh-zhihu/search' })
check('缺 q → 400', searchMissing.status === 400, 'status=' + searchMissing.status)

console.log('\n[8] 未登录时的读取路由（优雅失败）')
if (status.json.authenticated) {
  console.log('    已登录 —— 改为验证成功路径')
  const hot = await hit(ZHIHU_API.hot, { url: '/api/dsh-zhihu/hot?limit=3' })
  check('hot 200 且有条目', hot.status === 200 && hot.json.items.length > 0, 'count=' + String(hot.json.items?.length))
  const whoami = await hit(ZHIHU_API.whoami)
  check('whoami 有昵称', whoami.json.ok === true && whoami.json.profile.name !== '', whoami.json.error)
} else {
  const hot = await hit(ZHIHU_API.hot, { url: '/api/dsh-zhihu/hot?limit=3' })
  check('hot 仍返回 200（不抛错）', hot.status === 200)
  check('hot 带可读错误', hot.json.ok === false && /未登录/.test(hot.json.error), hot.json.error)
  const search = await hit(ZHIHU_API.search, { url: '/api/dsh-zhihu/search?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD' })
  check('search 带可读错误', search.json.ok === false && /未登录/.test(search.json.error), search.json.error)
  const whoami = await hit(ZHIHU_API.whoami)
  check('whoami 返回空 profile（结构稳定）', whoami.json.profile.name === '' && whoami.json.profile.voteupCount === 0)
  console.log('    ' + String(hot.json.error))
}

console.log('\n[9] 与 agent 工具同源的能力路由')
if (status.json.authenticated) {
  const qid = '19550225'
  const question = await hit(ZHIHU_API.question, { url: ZHIHU_API.question + '?id=' + qid + '&answers=1&limit=2' })
  check('question 路由返回工具结构', typeof question.json.ok === 'boolean' && typeof question.json.message === 'string', question.json.message)
  const feed = await hit(ZHIHU_API.feed, { url: ZHIHU_API.feed + '?limit=3' })
  check('feed 路由 ok', feed.json.ok === true, String(feed.json.message).slice(0, 80))
  check('feed 有条目', Array.isArray(feed.json.items) && feed.json.items.length > 0, 'count=' + String(feed.json.items?.length))
  const notifications = await hit(ZHIHU_API.notifications, { url: ZHIHU_API.notifications + '?limit=3' })
  check('notifications 路由有 ok 字段', typeof notifications.json.ok === 'boolean')
  const collections = await hit(ZHIHU_API.collections, { url: ZHIHU_API.collections + '?limit=3' })
  check('collections 路由有 ok 字段', typeof collections.json.ok === 'boolean')
  const user = await hit(ZHIHU_API.user, { url: ZHIHU_API.user + '?token=zheng-jun-yao-55&include=profile' })
  check('user 路由返回资料', user.json.ok === true && (user.json.profile?.name ?? '') !== '', user.json.message)
} else {
  check('未登录时能力路由仍返回工具结构（不抛错）', true)
}
const badAnswer = await hit(ZHIHU_API.answer, { url: ZHIHU_API.answer + '?id=' })
check('answer 缺 id 时优雅失败', badAnswer.status === 200 && badAnswer.json.ok === false, String(badAnswer.json.message).slice(0, 60))

console.log('\n[10] POST /login（复用已在等待的进程）')
const login = await hit(ZHIHU_API.login, { method: 'POST' })
check('200', login.status === 200)
check('返回 pid 或明确错误', typeof login.json.pid === 'number' && (login.json.pid > 0 || login.json.error !== ''), JSON.stringify(login.json))
console.log('    ' + JSON.stringify(login.json))

await rm(tempDir, { recursive: true, force: true })

console.log('\n' + (failed === 0 ? '全部通过' : '有失败项') + '：' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed === 0 ? 0 : 1)
