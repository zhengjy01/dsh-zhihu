/**
 * Browser-side API client for the /api/dsh-zhihu route family. The only data
 * access path the panel uses — plain fetch, same origin.
 */

/** One normalized Zhihu item (mirrors the host contract). */
export interface ZhihuItem {
  id: string
  type: string
  title: string
  url: string
  author: string
  excerpt: string
  voteupCount: number
  commentCount: number
  answerCount: number
  followerCount: number
  created: string
}

/** Normalized user profile (mirrors the host contract). */
export interface ZhihuProfile {
  id: string
  name: string
  urlToken: string
  url: string
  headline: string
  description: string
  answerCount: number
  articlesCount: number
  followerCount: number
  followingCount: number
  voteupCount: number
  thankedCount: number
}

/** Status payload from GET /api/dsh-zhihu/status. */
export interface ZhihuStatus {
  ok: boolean
  cliAvailable: boolean
  cliVersion: string
  cliPath: string
  authenticated: boolean
  cookiePresent: boolean
  missingCookies: string[]
  savedAt: string
  qrcodePresent: boolean
  /** Whether the detached QR-login process is still running (absent on older hosts). */
  loginAlive?: boolean
  /** Pid of the detached QR-login process (absent on older hosts). */
  loginPid?: number
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

/** QR payload from GET /api/dsh-zhihu/qrcode. */
export interface ZhihuQrcode {
  ok: boolean
  qrcode: boolean
  dataUrl: string
  mtimeMs: number
  error?: string
}

/**
 * Result shape shared by every read route. The panel talks to the same
 * ToolDefinitions the model calls, so these fields are exactly what the agent
 * receives — no second, thinner implementation to drift out of sync.
 */
export interface ZhihuToolResult {
  ok: boolean
  message: string
  items?: ZhihuItem[]
  text?: string
  question?: ZhihuItem
  answer?: ZhihuItem
  topic?: ZhihuItem
  profile?: ZhihuProfile
  total?: number
  query?: string
  include?: string
}

/** Error carrying the route's JSON error message. */
export class ZhihuApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZhihuApiError'
  }
}

/** Plain fetch helper with an error wrapper. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new ZhihuApiError('网络请求失败: ' + String(error instanceof Error ? error.message : error))
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ZhihuApiError('HTTP ' + response.status + ': 响应不是合法 JSON')
  }
  if (!response.ok) {
    // The host registers plugin routes at boot, so a route added since the last
    // start falls through to the shell's auth handler (401/404) instead of
    // reaching the plugin. Say that plainly rather than showing a bare code.
    if (response.status === 401 || response.status === 404) {
      throw new ZhihuApiError('该能力需要重启 dsh web 后才能用（host 端路由尚未注册）。当前可用：登录状态、热榜、搜索、账号资料。')
    }
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'HTTP ' + response.status
    throw new ZhihuApiError(message)
  }
  return body as T
}

/** The dsh-zhihu panel API. */
export class ZhihuApi {
  /** Plugin + CLI + login status. */
  async status(): Promise<ZhihuStatus> {
    return request<ZhihuStatus>('/api/dsh-zhihu/status')
  }

  /** Persist a config patch; returns the fresh status. */
  async setConfig(patch: {
    readOnly?: boolean
    cliPath?: string
    proxy?: string
    timeoutMs?: number
    loginWaitMs?: number
    reset?: boolean
  }): Promise<unknown> {
    return request<unknown>('/api/dsh-zhihu/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  /** Start (or reuse) the detached QR login. */
  async startLogin(): Promise<{ ok: boolean; started: boolean; alive: boolean; pid: number; qrcodePresent: boolean; error: string }> {
    return request('/api/dsh-zhihu/login', { method: 'POST' })
  }

  /** The current QR PNG as a data URL (empty until the CLI writes it). */
  async qrcode(): Promise<ZhihuQrcode> {
    return request<ZhihuQrcode>('/api/dsh-zhihu/qrcode')
  }

  /** Import the logged-in session from the local Chrome profile. */
  async browserLogin(): Promise<{ ok: boolean; error: string; profile: string; cookieCount: number; account: string }> {
    return request('/api/dsh-zhihu/browser-login', { method: 'POST' })
  }

  /** Delete the saved cookie file. */
  async logout(): Promise<{ ok: boolean; removed: string[] }> {
    return request('/api/dsh-zhihu/logout', { method: 'POST' })
  }

  /** The logged-in account profile. */
  async whoami(): Promise<{ ok: boolean; error: string; profile: ZhihuProfile }> {
    return request('/api/dsh-zhihu/whoami')
  }

  /** Hot list items. */
  async hot(limit = 10): Promise<{ ok: boolean; error: string; items: ZhihuItem[] }> {
    return request('/api/dsh-zhihu/hot?limit=' + String(limit))
  }

  /** Search results. */
  async search(query: string, limit = 5): Promise<{ ok: boolean; error: string; items: ZhihuItem[] }> {
    return request('/api/dsh-zhihu/search?q=' + encodeURIComponent(query) + '&limit=' + String(limit))
  }

  /** Question detail (+ answers). */
  async question(params: { id: string; answers?: boolean; limit?: number }): Promise<ZhihuToolResult> {
    const q = new URLSearchParams({ id: params.id, limit: String(params.limit ?? 5) })
    q.set('answers', params.answers === false ? '0' : '1')
    return request<ZhihuToolResult>('/api/dsh-zhihu/question?' + q.toString())
  }

  /** Answer body (+ comments, returned as text). */
  async answer(params: { id: string; comments?: boolean; limit?: number }): Promise<ZhihuToolResult> {
    const q = new URLSearchParams({ id: params.id, limit: String(params.limit ?? 10) })
    q.set('comments', params.comments === false ? '0' : '1')
    return request<ZhihuToolResult>('/api/dsh-zhihu/answer?' + q.toString())
  }

  /** User profile or their content. */
  async user(params: { token: string; include?: string; limit?: number }): Promise<ZhihuToolResult> {
    const q = new URLSearchParams({
      token: params.token,
      include: params.include ?? 'profile',
      limit: String(params.limit ?? 10),
    })
    return request<ZhihuToolResult>('/api/dsh-zhihu/user?' + q.toString())
  }

  /** Topic detail (+ hot questions as text). */
  async topic(params: { id: string; hot?: boolean }): Promise<ZhihuToolResult> {
    const q = new URLSearchParams({ id: params.id, hot: params.hot === false ? '0' : '1' })
    return request<ZhihuToolResult>('/api/dsh-zhihu/topic?' + q.toString())
  }

  /** Recommended feed. */
  async feed(params: { limit?: number; withComments?: boolean } = {}): Promise<ZhihuToolResult> {
    const q = new URLSearchParams({ limit: String(params.limit ?? 10) })
    q.set('withComments', params.withComments === true ? '1' : '0')
    return request<ZhihuToolResult>('/api/dsh-zhihu/feed?' + q.toString())
  }

  /** Notifications. */
  async notifications(params: { limit?: number; offset?: number } = {}): Promise<ZhihuToolResult> {
    const q = new URLSearchParams({ limit: String(params.limit ?? 10), offset: String(params.offset ?? 0) })
    return request<ZhihuToolResult>('/api/dsh-zhihu/notifications?' + q.toString())
  }

  /** Collections. */
  async collections(limit = 10): Promise<ZhihuToolResult> {
    return request<ZhihuToolResult>('/api/dsh-zhihu/collections?limit=' + String(limit))
  }
}
