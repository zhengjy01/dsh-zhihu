/**
 * dsh-zhihu — output parsing and shaping.
 *
 * The CLI prints raw Zhihu API JSON for `--json` commands, human-oriented Rich
 * tables otherwise. Raw payloads are far too large to hand to the model
 * wholesale, so this module extracts a compact, uniform item shape (id / type
 * / title / url / author / excerpt / counts) plus small helpers for the
 * text-mode commands (comments, feed-with-comments, topic hot questions) whose
 * JSON mode is not implemented by the CLI.
 */

/** One normalized Zhihu object. Every field is always present. */
export type CompactItem = {
  /** Object id (question / answer / article / pin / topic id, or url_token). */
  id: string
  /** Zhihu object type: question, answer, article, pin, people, topic, collection… */
  type: string
  /** Best-effort human title (HTML stripped). */
  title: string
  /** Canonical public URL when one can be derived, else ''. */
  url: string
  /** Author display name ('' when not applicable). */
  author: string
  /** Short plain-text excerpt (HTML stripped, capped). */
  excerpt: string
  /** Upvote count. */
  voteupCount: number
  /** Comment count. */
  commentCount: number
  /** Answer count. */
  answerCount: number
  /** Follower count. */
  followerCount: number
  /** Creation time as an ISO string ('' when unknown). */
  created: string
}

/** Excerpt cap in characters, to keep tool results compact. */
export const EXCERPT_LIMIT = 300

/** Strip ANSI escape sequences (Rich colors) from captured CLI text. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** Remove HTML tags and decode the handful of entities Zhihu emits. */
export function stripHtml(input: string): string {
  const withoutTags = input.replace(/<[^>]*>/g, '')
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
}

/** Decode the common named and numeric HTML entities. */
function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number(code)
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match
    })
}

/** Truncate to a character budget, appending an ellipsis when cut. */
export function truncate(input: string, limit: number = EXCERPT_LIMIT): string {
  const text = input.trim()
  if (text.length <= limit) return text
  return text.slice(0, limit) + '…'
}

/**
 * Parse the CLI's `--json` payload.
 *
 * The CLI echoes a single JSON document, but a startup banner or a Rich error
 * line can precede it, so fall back to slicing from the first `{` or `[`.
 * @param stdout - captured stdout.
 * @returns the parsed value, or null when no JSON document was found.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripAnsi(stdout).trim()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Fall through to the slice attempt.
  }
  const objectAt = text.indexOf('{')
  const arrayAt = text.indexOf('[')
  const candidates = [objectAt, arrayAt].filter((index) => index >= 0)
  if (candidates.length === 0) return null
  const start = Math.min(...candidates)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

/** Read a nested property by path, returning undefined when absent. */
export function getPath(root: unknown, ...segments: string[]): unknown {
  let cursor: unknown = root
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** First string-ish value found at the given paths. */
function firstString(root: unknown, paths: readonly string[][]): string {
  for (const segments of paths) {
    const value = getPath(root, ...segments)
    if (typeof value === 'string' && value.trim() !== '') return value
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/** First finite number found at the given paths (0 when absent). */
function firstNumber(root: unknown, paths: readonly string[][]): number {
  for (const segments of paths) {
    const value = getPath(root, ...segments)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

/** Convert an epoch-seconds / epoch-ms / ISO value to an ISO string. */
function toIso(root: unknown, paths: readonly string[][]): string {
  for (const segments of paths) {
    const value = getPath(root, ...segments)
    if (typeof value === 'string' && value.trim() !== '') {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && value.trim() !== '') {
        return epochToIso(numeric)
      }
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) return epochToIso(value)
  }
  return ''
}

/** Seconds vs milliseconds heuristic for Zhihu timestamps. */
function epochToIso(value: number): string {
  if (value <= 0) return ''
  const ms = value < 1e12 ? value * 1000 : value
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/** Build the canonical Zhihu URL for an object when the type is known. */
export function itemUrl(type: string, id: string): string {
  if (id === '') return ''
  switch (type) {
    case 'question':
      return 'https://www.zhihu.com/question/' + id
    case 'answer':
      return 'https://www.zhihu.com/answer/' + id
    case 'article':
      return 'https://zhuanlan.zhihu.com/p/' + id
    case 'pin':
      return 'https://www.zhihu.com/pin/' + id
    case 'people':
      return 'https://www.zhihu.com/people/' + id
    case 'topic':
      return 'https://www.zhihu.com/topic/' + id
    case 'collection':
      return 'https://www.zhihu.com/collection/' + id
    default:
      return ''
  }
}

/**
 * Unwrap a feed/search/hot-list wrapper entry down to the object it describes.
 *
 * Zhihu nests the payload under different keys depending on the endpoint and on
 * whether the request was anonymous: search uses `object`, the anonymous feed
 * uses `target`, and the authenticated hot list uses `question`. Missing one
 * collapses every derived field (id, url, counts) to its empty default.
 */
function unwrap(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const record = raw as Record<string, unknown>
  for (const key of ['object', 'target', 'question']) {
    const inner = record[key]
    if (typeof inner === 'object' && inner !== null) return inner
  }
  return raw
}

/**
 * Normalize one raw Zhihu object (feed entry, search hit, answer, profile…)
 * into the compact uniform shape.
 * @param raw - one entry from a Zhihu API `data` array, or a bare object.
 * @returns the compact item.
 */
export function compactItem(raw: unknown): CompactItem {
  const obj = unwrap(raw)
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const type = firstString(obj, [['type']]) || firstString(raw, [['type']]) || ''
  const id =
    firstString(obj, [['id'], ['url_token'], ['token']]) ||
    firstString(raw, [['id']])
  const title =
    firstString(obj, [['title'], ['name'], ['question', 'title']]) ||
    truncate(stripHtml(firstString(obj, [['excerpt'], ['content']])), 80)
  const author =
    firstString(obj, [['author', 'name'], ['actor', 'name'], ['author', 'url_token']]) || ''
  const excerpt = truncate(
    stripHtml(
      firstString(obj, [
        ['excerpt'],
        ['content'],
        ['headline'],
        ['description'],
        ['introduction'],
        ['detail'],
        ['text'],
        ['title'],
      ]),
    ),
  )
  const explicitUrl = firstString(obj, [['url'], ['link', 'url']])
  // Only trust an explicit URL that is a real public Zhihu link; the API also
  // returns api.zhihu.com endpoints which are not useful to hand a user.
  const publicUrl = explicitUrl.startsWith('https://api.zhihu.com') ? '' : explicitUrl
  const kind = type !== '' ? type : id !== '' ? 'question' : ''
  const url = publicUrl !== '' ? publicUrl : itemUrl(kind, id)
  const heat = firstString(record, [['detail_text']])
  return {
    id,
    type,
    title: stripHtml(title),
    url,
    author,
    excerpt: heat !== '' && excerpt === '' ? heat : excerpt,
    voteupCount: firstNumber(obj, [['voteup_count'], ['voteupCount']]),
    commentCount: firstNumber(obj, [['comment_count'], ['commentCount']]),
    answerCount: firstNumber(obj, [['answer_count'], ['question', 'answer_count']]),
    followerCount: firstNumber(obj, [['follower_count'], ['followers_count']]),
    created: toIso(obj, [['created'], ['created_time'], ['updated_time'], ['createdAt']]),
  }
}

/** One normalized Zhihu profile (people object / whoami). */
export type CompactProfile = {
  /** User id. */
  id: string
  /** Display name. */
  name: string
  /** url_token (the handle used in zhihu.com/people/<token>). */
  urlToken: string
  /** Profile URL. */
  url: string
  /** Headline (one-line bio). */
  headline: string
  /** Longer description. */
  description: string
  /** Answer count. */
  answerCount: number
  /** Article count. */
  articlesCount: number
  /** Follower count. */
  followerCount: number
  /** Following count. */
  followingCount: number
  /** Received upvotes. */
  voteupCount: number
  /** Received thanks. */
  thankedCount: number
}

/** An all-empty profile, so tool results always carry the declared shape. */
export function emptyProfile(): CompactProfile {
  return {
    id: '',
    name: '',
    urlToken: '',
    url: '',
    headline: '',
    description: '',
    answerCount: 0,
    articlesCount: 0,
    followerCount: 0,
    followingCount: 0,
    voteupCount: 0,
    thankedCount: 0,
  }
}

/**
 * Normalize a Zhihu people object (whoami / user profile) into a flat shape.
 * @param raw - the parsed profile payload.
 * @returns the compact profile; an empty profile when the payload is unusable.
 */
export function compactProfile(raw: unknown): CompactProfile {
  if (typeof raw !== 'object' || raw === null) return emptyProfile()
  const urlToken = firstString(raw, [['url_token'], ['urlToken']])
  const id = firstString(raw, [['id'], ['uid']])
  const explicitUrl = firstString(raw, [['url'], ['profile_url']])
  return {
    id,
    name: firstString(raw, [['name'], ['nickname']]),
    urlToken,
    url: explicitUrl !== '' ? explicitUrl : itemUrl('people', urlToken !== '' ? urlToken : id),
    headline: firstString(raw, [['headline']]),
    description: truncate(stripHtml(firstString(raw, [['description'], ['bio']]))),
    answerCount: firstNumber(raw, [['answer_count']]),
    articlesCount: firstNumber(raw, [['articles_count']]),
    followerCount: firstNumber(raw, [['follower_count'], ['followers_count']]),
    followingCount: firstNumber(raw, [['following_count']]),
    voteupCount: firstNumber(raw, [['voteup_count']]),
    thankedCount: firstNumber(raw, [['thanked_count']]),
  }
}

/** Render a compact profile as a one-line summary. */
export function describeProfile(profile: CompactProfile): string {
  if (profile.name === '' && profile.id === '') return '（未取得资料）'
  return [
    profile.name !== '' ? profile.name + (profile.urlToken !== '' ? '(@' + profile.urlToken + ')' : '') : '',
    profile.headline !== '' ? profile.headline : '',
    profile.answerCount > 0 ? '回答 ' + profile.answerCount : '',
    profile.articlesCount > 0 ? '文章 ' + profile.articlesCount : '',
    profile.followerCount > 0 ? '关注者 ' + profile.followerCount : '',
    profile.followingCount > 0 ? '关注了 ' + profile.followingCount : '',
    profile.voteupCount > 0 ? '获赞 ' + profile.voteupCount : '',
  ]
    .filter((bit) => bit !== '')
    .join(' · ')
}

/**
 * Extract and normalize the `data` array of a Zhihu listing response.
 * @param payload - the parsed `--json` payload.
 * @returns compact items (empty when the payload has no list).
 */
export function compactList(payload: unknown): CompactItem[] {
  const data = getPath(payload, 'data')
  const entries = Array.isArray(data) ? data : Array.isArray(payload) ? payload : []
  // Zhihu interleaves non-content cards (type "major" / "hot_timing" promo
  // banners) into search and feed payloads; they carry no id/title/excerpt and
  // would otherwise render as "(无标题)" rows.
  return entries.map((entry) => compactItem(entry)).filter(isContentItem)
}

/**
 * Whether a normalized entry carries readable content. Promo cards (type
 * "major" / "hot_timing") do have an outer id but no title or excerpt, so keying
 * on the text fields — not the id — is what actually filters them out.
 */
function isContentItem(item: CompactItem): boolean {
  return item.title !== '' || item.excerpt !== ''
}

/**
 * Render compact items as a numbered plain-text block for the model.
 * @param items - normalized items.
 * @param options - optional heading cap and whether to include the URL.
 * @returns one item per line.
 */
export function renderItems(
  items: readonly CompactItem[],
  options: { max?: number } = {},
): string {
  const max = options.max ?? 20
  return items
    .slice(0, max)
    .map((item, index) => {
      const head = item.title !== '' ? item.title : item.excerpt
      const bits = [
        String(index + 1) + '. ' + (head === '' ? '(无标题)' : head),
        item.author !== '' ? '作者 ' + item.author : '',
        item.voteupCount > 0 ? '赞同 ' + item.voteupCount : '',
        item.answerCount > 0 ? '回答 ' + item.answerCount : '',
        item.commentCount > 0 ? '评论 ' + item.commentCount : '',
        item.url !== '' ? item.url : '',
      ].filter((bit) => bit !== '')
      return bits.join(' · ')
    })
    .join('\n')
}

/**
 * Reject CLI output that indicates the command failed, so callers can surface
 * a real reason instead of an empty result.
 *
 * The CLI writes Rich errors to stdout ("✗ Not authenticated …") and exits 1.
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @param code - exit code.
 * @returns a human reason when the run failed, else ''.
 */
export function failureReason(stdout: string, stderr: string, code: number): string {
  const text = stripAnsi(stdout + '\n' + stderr)
  if (/Not authenticated/i.test(text)) {
    return '知乎未登录：请先用 zhihu_login（二维码扫码或粘贴 Cookie）完成登录。'
  }
  // 知乎把「匿名 + 机器人指纹」的请求整段拦在 /account/unhuman（HTTP 403 + code 40352）。
  // pyzhihu-cli 的扫码轮询会把这个 403 静默吞掉，表面只剩「超时」——所以这里先认它，
  // 给出可操作的下一步，而不是让用户对着二维码干等。
  if (/unhuman|40352|系统监测到您的网络环境|安全验证/i.test(text)) {
    return '知乎风控拦截（HTTP 403 / code 40352）：请用 zhihu_login({ mode: "browser" }) 从本机 Chrome 导入真实登录态（或稍后重试），不要靠扫码轮询。'
  }
  // 部分接口（话题详情，以及问题详情）要求 x-zse-96 签名，匿名与登录态都返回 403 code 10003。
  if (/x-zse-96|zse96|"code"\s*:\s*10003|code\s+10003/i.test(text)) {
    return '知乎接口要求 x-zse-96 签名（HTTP 403 / code 10003）：本插件读不到该接口（话题详情不可用；问题详情已自动降级为回答列表）。'
  }
  if (/Timed out|timeout/i.test(text)) return '知乎请求超时（网络或风控）。'
  if (code === 124) return 'CLI 执行超时（可调大 zhihu_config 的 timeoutMs）。'
  const line = text
    .split('\n')
    .map((entry) => entry.replace(/^\s*[✗✔·]\s*/, '').trim())
    .filter((entry) => entry !== '' && !entry.startsWith('hint:'))
    .pop()
  if (line !== undefined) return line.slice(0, 400)
  return 'CLI 退出码 ' + code
}

/** Count helper for messages. */
export function count(n: number, unit: string): string {
  return String(n) + ' ' + unit
}
