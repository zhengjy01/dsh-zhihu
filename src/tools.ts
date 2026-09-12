/**
 * dsh-zhihu — model-facing tools.
 *
 * Read tools wrap the CLI's `--json` commands and normalize the raw Zhihu API
 * payload into compact items plus a one-line summary. A few CLI commands only
 * support their human-readable form (comments, feed-with-comments, topic hot
 * questions), so those return ANSI-stripped text instead of pretending to have
 * structured data.
 *
 * Write tools (publish / vote / follow / delete) are only built when the
 * effective readOnly switch is off.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { readChromeZhihuCookies } from './browser-cookie.ts'
import { call, plainText } from './invoke.ts'
import { clearCredentials, clearLoginRecord, saveCookieString, startQrLogin, waitForLogin } from './login.ts'
import {
  compactItem,
  compactList,
  compactProfile,
  describeProfile,
  emptyProfile,
  failureReason,
  getPath,
  itemUrl,
  parseJsonOutput,
  renderItems,
  stripAnsi,
  truncate,
  type CompactItem,
} from './parse.ts'
import { DEFAULT_CLI_PATH, type LoginState, type ZhihuStore } from './store.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Shape of one normalized item, shared by every list-shaped result. */
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    author: { type: 'string' },
    excerpt: { type: 'string' },
    voteupCount: { type: 'number' },
    commentCount: { type: 'number' },
    answerCount: { type: 'number' },
    followerCount: { type: 'number' },
    created: { type: 'string' },
  },
} as const

/** Shape of one normalized user profile. */
const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    urlToken: { type: 'string' },
    url: { type: 'string' },
    headline: { type: 'string' },
    description: { type: 'string' },
    answerCount: { type: 'number' },
    articlesCount: { type: 'number' },
    followerCount: { type: 'number' },
    followingCount: { type: 'number' },
    voteupCount: { type: 'number' },
    thankedCount: { type: 'number' },
  },
} as const

/** A list-of-items property. */
const ITEMS_SCHEMA = { type: 'array', items: ITEM_SCHEMA } as const

/** Shared tool dependencies. */
export interface ToolContext {
  /** Config + login-state store. */
  store: ZhihuStore
  /** Effective read-only flag at mount time (write tools are skipped when true). */
  readOnly: boolean
  /** Invoked after a config change that alters the tool roster. */
  onConfigChanged?: () => void
}

/** Failure result shared by every tool. */
function fail(message: string): { ok: false; message: string } {
  return { ok: false, message }
}

/** Shared `render` implementation: the message is the model-facing text. */
function renderMessage(_args: unknown, value: Record<string, unknown>): ContentBlock[] {
  return text(String(value.message ?? ''))
}

/** Login-state summary line. */
function loginLine(state: LoginState): string {
  if (state.hasRequired) {
    return '已登录（Cookie ' + state.cookiePath + (state.savedAt !== '' ? '，更新于 ' + state.savedAt : '') + '）'
  }
  if (state.cookiePresent) {
    return 'Cookie 文件存在但缺少必需字段：' + state.missing.join('、')
  }
  return '未登录'
}

/** Clamp a model-supplied integer. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** Restrict a model-supplied string to a known set. */
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/* ------------------------------------------------------------------ */
/* Management tools                                                    */
/* ------------------------------------------------------------------ */

/** Tool: plugin + CLI + login status. */
export function zhihuStatusTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_status',
    description:
      '查看 dsh-zhihu 插件状态：知乎 CLI（pyzhihu-cli）是否可用及版本、登录态（是否已有含 z_c0/_xsrf/d_c0 的 Cookie）、当前是否只读、CLI/配置路径与超时。不会回显任何 Cookie 内容。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          cliAvailable: { type: 'boolean' },
          cliVersion: { type: 'string' },
          cliPath: { type: 'string' },
          authenticated: { type: 'boolean' },
          cookiePath: { type: 'string' },
          cookiePresent: { type: 'boolean' },
          missingCookies: { type: 'array' },
          qrcodePath: { type: 'string' },
          readOnly: { type: 'boolean' },
          readOnlySource: { type: 'string' },
          proxyMode: { type: 'string' },
          timeoutMs: { type: 'number' },
          configPath: { type: 'string' },
          logPath: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(_args: unknown, exec) {
      const view = await ctx.store.view()
      const state = await ctx.store.loginState()
      let cliVersion = ''
      if (view.resolvedCliPath !== '') {
        const version = await call(ctx.store, ['--version'], { signal: exec.signal })
        cliVersion = version.stdout.split('\n')[0]?.trim() ?? ''
      }
      const cliAvailable = view.resolvedCliPath !== ''
      const parts = [
        '知乎 CLI：' + (cliAvailable ? '可用' + (cliVersion !== '' ? '（' + cliVersion + '）' : '') : '不可用（未找到 ' + (view.cliPath !== '' ? view.cliPath : DEFAULT_CLI_PATH) + '）'),
        loginLine(state),
        '模式：' + (view.readOnly ? '只读（写操作工具未注册）' : '读写（已开放发布/互动/删除）'),
        '代理：' + (view.proxyMode === 'off' ? '已关闭' : view.proxyMode === 'custom' ? view.proxy : '继承环境变量'),
        '超时：' + view.timeoutMs + 'ms',
        '配置：' + view.configPath,
      ]
      return {
        ok: true,
        message: 'dsh-zhihu：' + parts.join('；') + '。',
        cliAvailable,
        cliVersion,
        cliPath: view.resolvedCliPath,
        authenticated: state.hasRequired,
        cookiePath: state.cookiePath,
        cookiePresent: state.cookiePresent,
        missingCookies: state.missing,
        qrcodePath: state.qrcodePath,
        readOnly: view.readOnly,
        readOnlySource: view.readOnlySource,
        proxyMode: view.proxyMode,
        timeoutMs: view.timeoutMs,
        configPath: view.configPath,
        logPath: view.logPath,
      }
    },
  })
}

/** Tool: read/write configuration. */
export function zhihuConfigTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_config',
    description:
      '配置 dsh-zhihu：readOnly 控制是否只注册读取类工具（true=只读，默认；false 才会注册发布/赞同/关注/删除等写工具）；cliPath 指定知乎 CLI 命令名或绝对路径（默认 zhihu）；timeoutMs 单次 CLI 超时（默认 90000）；loginWaitMs 二维码登录时等待扫码的毫秒数（默认 15000）；proxy 代理设置（空=继承环境变量，none=强制不走代理，或填代理 URL）；cliHome 指定 CLI 配置目录（默认 ~/.zhihu-cli）。传 reset: true 恢复默认。配置存 ~/.dsh/dsh-zhihu.json（0600）。不带任何参数调用即返回当前配置。',
    parameters: {
      readOnly: { type: 'boolean', description: '是否只读：true 只注册读取工具；false 放开写工具' },
      cliPath: { type: 'string', description: '知乎 CLI 命令名或绝对路径（默认 zhihu）' },
      timeoutMs: { type: 'number', description: '单次 CLI 超时毫秒数（默认 90000）' },
      loginWaitMs: { type: 'number', description: '二维码登录等待扫码毫秒数（默认 15000）' },
      proxy: { type: 'string', description: '代理：空=继承环境变量；none=不走代理；或 http://host:port' },
      cliHome: { type: 'string', description: 'CLI 配置目录（默认 ~/.zhihu-cli）' },
      reset: { type: 'boolean', description: '设为 true 恢复默认配置' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          readOnly: { type: 'boolean' },
          readOnlySource: { type: 'string' },
          cliPath: { type: 'string' },
          resolvedCliPath: { type: 'string' },
          timeoutMs: { type: 'number' },
          loginWaitMs: { type: 'number' },
          proxyMode: { type: 'string' },
          cliHome: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: {
      readOnly?: boolean
      cliPath?: string
      timeoutMs?: number
      loginWaitMs?: number
      proxy?: string
      cliHome?: string
      reset?: boolean
    }) {
      const before = await ctx.store.readOnly()
      const touched = Object.keys(args).length > 0
      const view = touched ? await ctx.store.patch(args) : await ctx.store.view()
      if (touched && view.readOnly !== before.value) ctx.onConfigChanged?.()
      const parts = [
        '模式：' + (view.readOnly ? '只读（写工具未注册）' : '读写（已开放写工具）') + '（来源：' + view.readOnlySource + '）',
        'CLI：' + (view.resolvedCliPath !== '' ? view.resolvedCliPath : (view.cliPath !== '' ? view.cliPath : DEFAULT_CLI_PATH) + '（未找到）'),
        '超时：' + view.timeoutMs + 'ms',
        '登录等待：' + view.loginWaitMs + 'ms',
        '代理：' + (view.proxyMode === 'off' ? '已关闭' : view.proxyMode === 'custom' ? view.proxy : '继承环境变量'),
        'CLI 配置目录：' + view.cliHome,
        touched ? '已更新配置' : '当前配置未改动',
      ]
      return {
        ok: true,
        message: 'dsh-zhihu：' + parts.join('；') + '。',
        readOnly: view.readOnly,
        readOnlySource: view.readOnlySource,
        cliPath: view.cliPath,
        resolvedCliPath: view.resolvedCliPath,
        timeoutMs: view.timeoutMs,
        loginWaitMs: view.loginWaitMs,
        proxyMode: view.proxyMode,
        cliHome: view.cliHome,
        configPath: view.configPath,
      }
    },
  })
}

/** Tool: login (QR scan or pasted cookie). */
export function zhihuLoginTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_login',
    description:
      '登录知乎。mode=browser（推荐）：从本机 Chrome 里读取已登录的知乎会话（读取 Chrome 的 Cookie 数据库并用钥匙串密钥解密，只取 cookie、不外传），写入 CLI 的 Cookie 文件并联网校验——因为知乎对**匿名** API 请求有风控（403 code 40352），扫码流程在受限网络下几乎必然会超时，这是最可靠的方式。mode=qrcode：启动 `zhihu login --qrcode` 并返回二维码图片路径（~/.zhihu-cli/login_qrcode.png），但注意匿名轮询会被风控拦截。mode=cookie：直接传入 Cookie 字符串（必须含 z_c0、_xsrf、d_c0），插件写入 CLI 的 Cookie 文件并联网校验，令牌不会出现在进程列表里。',
    parameters: {
      mode: {
        type: 'string',
        enum: ['browser', 'qrcode', 'cookie'],
        description: 'browser=从本机 Chrome 导入登录态（推荐）；qrcode=扫码；cookie=粘贴 Cookie',
      },
      cookie: { type: 'string', description: 'mode=cookie 时的 Cookie 字符串（含 z_c0、_xsrf、d_c0）' },
      waitMs: { type: 'number', description: '等待扫码的毫秒数（默认取配置 loginWaitMs，最大 180000）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          mode: { type: 'string' },
          authenticated: { type: 'boolean' },
          started: { type: 'boolean' },
          pid: { type: 'number' },
          qrcodePath: { type: 'string' },
          qrcodePresent: { type: 'boolean' },
          cookiePath: { type: 'string' },
          logPath: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { mode?: string; cookie?: string; waitMs?: number }, exec) {
      const mode = pick(args.mode, ['browser', 'qrcode', 'cookie'] as const, 'browser')
      const state0 = await ctx.store.loginState()

      if (mode === 'browser') {
        const imported = await readChromeZhihuCookies()
        if (!imported.ok) {
          return {
            ...fail('从浏览器导入登录态失败：' + imported.error),
            mode,
            authenticated: state0.hasRequired,
            started: false,
            pid: 0,
            qrcodePath: state0.qrcodePath,
            qrcodePresent: state0.qrcodePresent,
            cookiePath: state0.cookiePath,
            logPath: ctx.store.logPath(),
          }
        }
        const raw = Object.entries(imported.cookies)
          .map(([name, value]) => name + '=' + value)
          .join('; ')
        const saved = await saveCookieString(ctx.store, raw)
        if (!saved.ok) {
          return {
            ...fail('导入的 Cookie 不可用：' + saved.error),
            mode,
            authenticated: false,
            started: false,
            pid: 0,
            qrcodePath: state0.qrcodePath,
            qrcodePresent: state0.qrcodePresent,
            cookiePath: saved.cookiePath,
            logPath: ctx.store.logPath(),
          }
        }
        const verify = await call(ctx.store, ['whoami', '--json'], { json: true, signal: exec.signal })
        const state = await ctx.store.loginState()
        if (!verify.ok) {
          await clearCredentials(ctx.store)
          return {
            ...fail('已从 Chrome（' + imported.profile + '）导入 Cookie，但联网校验失败：' + verify.error + ' 已清除。'),
            mode,
            authenticated: false,
            started: false,
            pid: 0,
            qrcodePath: state0.qrcodePath,
            qrcodePresent: state0.qrcodePresent,
            cookiePath: saved.cookiePath,
            logPath: ctx.store.logPath(),
          }
        }
        const profile = compactProfile(verify.json)
        return {
          ok: true,
          message:
            'dsh-zhihu：已从 Chrome（' + imported.profile + '）导入 ' +
            imported.names.length + ' 个 Cookie 并校验通过，' + describeProfile(profile) + '。',
          mode,
          authenticated: state.hasRequired,
          started: false,
          pid: 0,
          qrcodePath: state.qrcodePath,
          qrcodePresent: state.qrcodePresent,
          cookiePath: state.cookiePath,
          logPath: ctx.store.logPath(),
        }
      }

      if (mode === 'cookie') {
        if (typeof args.cookie !== 'string' || args.cookie.trim() === '') {
          return {
            ...fail('mode=cookie 需要提供 cookie（浏览器 DevTools 里复制完整 Cookie 字符串）。'),
            mode,
            authenticated: state0.hasRequired,
            started: false,
            pid: 0,
            qrcodePath: state0.qrcodePath,
            qrcodePresent: state0.qrcodePresent,
            cookiePath: state0.cookiePath,
            logPath: ctx.store.logPath(),
          }
        }
        const saved = await saveCookieString(ctx.store, args.cookie)
        if (!saved.ok) {
          return {
            ...fail('保存 Cookie 失败：' + saved.error),
            mode,
            authenticated: false,
            started: false,
            pid: 0,
            qrcodePath: state0.qrcodePath,
            qrcodePresent: state0.qrcodePresent,
            cookiePath: saved.cookiePath,
            logPath: ctx.store.logPath(),
          }
        }
        const verify = await call(ctx.store, ['whoami', '--json'], { json: true, signal: exec.signal })
        const state = await ctx.store.loginState()
        if (!verify.ok) {
          await clearCredentials(ctx.store)
          return {
            ...fail('Cookie 已写入但联网校验失败（可能已过期）：' + verify.error + ' 已清除该 Cookie。'),
            mode,
            authenticated: false,
            started: false,
            pid: 0,
            qrcodePath: state0.qrcodePath,
            qrcodePresent: state0.qrcodePresent,
            cookiePath: saved.cookiePath,
            logPath: ctx.store.logPath(),
          }
        }
        const profile = compactProfile(verify.json)
        return {
          ok: true,
          message: 'dsh-zhihu：Cookie 登录成功，' + describeProfile(profile) + '。',
          mode,
          authenticated: state.hasRequired,
          started: false,
          pid: 0,
          qrcodePath: state.qrcodePath,
          qrcodePresent: state.qrcodePresent,
          cookiePath: state.cookiePath,
          logPath: ctx.store.logPath(),
        }
      }

      if (state0.hasRequired) {
        return {
          ok: true,
          message:
            'dsh-zhihu：已经存在登录 Cookie（' +
            state0.cookiePath +
            '，更新于 ' +
            state0.savedAt +
            '）。如需重新登录，先调用 zhihu_logout 再扫码。',
          mode,
          authenticated: true,
          started: false,
          pid: 0,
          qrcodePath: state0.qrcodePath,
          qrcodePresent: state0.qrcodePresent,
          cookiePath: state0.cookiePath,
          logPath: ctx.store.logPath(),
        }
      }

      const started = await startQrLogin(ctx.store)
      if (started.error !== '' && !started.alive) {
        return {
          ...fail(started.error),
          mode,
          authenticated: false,
          started: started.started,
          pid: started.pid,
          qrcodePath: started.qrcodePath,
          qrcodePresent: started.qrcodePresent,
          cookiePath: state0.cookiePath,
          logPath: started.logPath,
        }
      }

      const config = await ctx.store.read()
      const waitMs = clampInt(args.waitMs, config.loginWaitMs, 0, 180_000)
      const waited = await waitForLogin(ctx.store, waitMs)
      const state = waited.state

      if (waited.authenticated) {
        return {
          ok: true,
          message: 'dsh-zhihu：扫码登录成功，Cookie 已保存到 ' + state.cookiePath + '。',
          mode,
          authenticated: true,
          started: started.started,
          pid: started.pid,
          qrcodePath: started.qrcodePath,
          qrcodePresent: started.qrcodePresent,
          cookiePath: state.cookiePath,
          logPath: started.logPath,
        }
      }

      if (waited.processExited) {
        return {
          ...fail(
            '二维码登录进程已退出但仍未取得 Cookie' +
              (waited.logTail !== '' ? '。日志：' + truncate(waited.logTail, 400) : '。'),
          ),
          mode,
          authenticated: false,
          started: started.started,
          pid: started.pid,
          qrcodePath: started.qrcodePath,
          qrcodePresent: started.qrcodePresent,
          cookiePath: state.cookiePath,
          logPath: started.logPath,
        }
      }

      return {
        ok: true,
        message:
          'dsh-zhihu：二维码已生成，等待扫码（' +
          waitMs +
          'ms 内未完成）。请展示图片 ' +
          started.qrcodePath +
          ' 让用户用知乎 App 扫描；扫完后再次调用 zhihu_login（不带参数即可）继续等待，或用 zhihu_status 检查登录态。' +
          (started.qrcodePresent ? '' : '（注意：二维码图片尚未出现，请查看日志 ' + started.logPath + '）'),
        mode,
        authenticated: false,
        started: started.started,
        pid: started.pid,
        qrcodePath: started.qrcodePath,
        qrcodePresent: started.qrcodePresent,
        cookiePath: state.cookiePath,
        logPath: started.logPath,
      }
    },
  })
}

/** Tool: logout. */
export function zhihuLogoutTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_logout',
    description: '退出知乎登录：删除 CLI 保存的 Cookie 文件（并清理登录记录）。之后所有需要登录的命令都会失败，直到重新 zhihu_login。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          removed: { type: 'array' },
          authenticated: { type: 'boolean' },
        },
      },
      render: renderMessage,
    },
    async execute(_args: unknown, exec) {
      const before = await ctx.store.loginState()
      const cli = await call(ctx.store, ['logout'], { signal: exec.signal })
      const removed = await clearCredentials(ctx.store)
      await clearLoginRecord()
      const state = await ctx.store.loginState()
      const detail = cli.ok ? plainText(cli.stdout) : ''
      return {
        ok: true,
        message:
          'dsh-zhihu：已退出登录' +
          (state.hasRequired ? '（警告：Cookie 文件仍然存在）' : '') +
          '。删除：' +
          (removed.length > 0 ? removed.join('、') : '（无）') +
          (before.cookiePresent && detail !== '' ? '。CLI 输出：' + truncate(detail, 200) : ''),
        removed,
        authenticated: state.hasRequired,
      }
    },
  })
}

/** Tool: current account profile. */
export function zhihuWhoamiTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_whoami',
    description: '查看当前登录的知乎账号资料（昵称、url_token、签名、回答/文章/关注者数量）。需要已登录。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          profile: PROFILE_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(_args: unknown, exec) {
      const result = await call(ctx.store, ['whoami', '--json'], { json: true, signal: exec.signal })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_whoami 失败：' + result.error, profile: emptyProfile() }
      }
      const profile = compactProfile(result.json)
      return {
        ok: true,
        message: '当前知乎账号：' + describeProfile(profile) + (profile.url !== '' ? '（' + profile.url + '）' : '') + '。',
        profile,
      }
    },
  })
}

/* ------------------------------------------------------------------ */
/* Read tools                                                          */
/* ------------------------------------------------------------------ */

/** Tool: search. */
export function zhihuSearchTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_search',
    description: '搜索知乎内容（问题 / 回答 / 文章），返回归一条目（标题、作者、赞同数、回答数、链接）。type 可选 general（综合，默认）/ people（用户）/ topic（话题）。需要已登录。',
    parameters: {
      query: { type: 'string', description: '搜索关键词', required: true },
      type: { type: 'string', enum: ['general', 'people', 'topic'], description: '搜索范围（默认 general）' },
      limit: { type: 'number', description: '返回条数（默认 10，最大 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          query: { type: 'string' },
          total: { type: 'number' },
          items: ITEMS_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(args: { query: string; type?: string; limit?: number }, exec) {
      if (typeof args.query !== 'string' || args.query.trim() === '') {
        return { ok: false, message: '请提供搜索关键词（query）。', query: '', total: 0, items: [] }
      }
      const query = args.query.trim()
      const type = pick(args.type, ['general', 'people', 'topic'] as const, 'general')
      const limit = clampInt(args.limit, 10, 1, 50)
      const result = await call(ctx.store, ['search', query, '-t', type, '-l', String(limit), '--json'], {
        json: true,
        signal: exec.signal,
      })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_search 失败：' + result.error, query, total: 0, items: [] }
      }
      const items: CompactItem[] = compactList(result.json)
      return {
        ok: true,
        message:
          '知乎搜索「' + query + '」（' + type + '）返回 ' + items.length + ' 条：\n' + renderItems(items) || '（无结果）',
        query,
        total: items.length,
        items,
      }
    },
  })
}

/** Tool: hot list. */
export function zhihuHotTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_hot',
    description: '查看知乎热榜（热门问题），返回问题标题、热量/浏览量、链接。需要已登录。',
    parameters: {
      limit: { type: 'number', description: '热榜条数（默认 30，最大 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          total: { type: 'number' },
          items: ITEMS_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(args: { limit?: number }, exec) {
      const limit = clampInt(args.limit, 30, 1, 50)
      const result = await call(ctx.store, ['hot', '-l', String(limit), '-a', '0', '--json'], {
        json: true,
        signal: exec.signal,
      })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_hot 失败：' + result.error, total: 0, items: [] }
      }
      const items = compactList(result.json)
      return {
        ok: true,
        message: '知乎热榜 ' + items.length + ' 条：\n' + renderItems(items, { max: 30 }),
        total: items.length,
        items,
      }
    },
  })
}

/** Tool: question detail (+ optional answer list). */
export function zhihuQuestionTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_question',
    description: '查看知乎问题详情（标题、描述、回答数、关注者、浏览量）；answers=true 时同时拉取该问题下的回答列表（可指定 limit 与 sort）。需要已登录。',
    parameters: {
      questionId: { type: 'string', description: '问题 id（数字，如 19550225；也可给知乎问题 URL）', required: true },
      answers: { type: 'boolean', description: '是否同时获取回答列表（默认 false）' },
      limit: { type: 'number', description: '回答条数（默认 5，最大 50）' },
      sort: { type: 'string', enum: ['default', 'created'], description: '回答排序（默认 default）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          question: ITEM_SCHEMA,
          answers: ITEMS_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(args: { questionId: string; answers?: boolean; limit?: number; sort?: string }, exec) {
      const id = normalizeId(args.questionId)
      if (id === '') {
        return { ok: false, message: '请提供问题 id（questionId）。', question: emptyItem(), answers: [] }
      }
      const limit = clampInt(args.limit, 5, 1, 50)
      const sort = pick(args.sort, ['default', 'created'] as const, 'default')
      let note = ''
      let question = emptyItem()
      let answers: CompactItem[] = []

      const detail = await call(ctx.store, ['question', id, '--json'], { json: true, signal: exec.signal })
      if (detail.ok) {
        question = compactItem(detail.json)
      } else {
        note =
          '（注意：知乎已对「问题详情」接口加签名要求，CLI 取不到，已改用回答列表；接口返回：' +
          truncate(detail.error, 120) +
          '）'
      }

      // The answer list works even when the detail endpoint is blocked, and each
      // answer embeds question.{id,title} — so the question is still identifiable.
      if (detail.ok !== true || args.answers === true) {
        const list = await call(
          ctx.store,
          ['answers', id, '-l', String(limit), '--sort', sort, '--json'],
          { json: true, signal: exec.signal },
        )
        if (list.ok) {
          answers = compactList(list.json)
          if (question.title === '') {
            const nested = getPath(list.json, 'data', '0', 'question')
            if (nested !== undefined) {
              question = { ...compactItem(nested), url: itemUrl('question', id) }
            }
          }
        } else if (detail.ok !== true) {
          return {
            ok: false,
            message: 'zhihu_question 失败：' + detail.error + '；回答列表也失败：' + list.error,
            question: emptyItem(),
            answers: [],
          }
        }
      }

      const lines = [
        '问题：' + (question.title !== '' ? question.title : id),
        question.excerpt !== '' ? '描述：' + question.excerpt : '',
        question.answerCount > 0 || question.followerCount > 0
          ? '回答 ' + question.answerCount + ' · 关注者 ' + question.followerCount
          : '',
        question.url,
        note,
        answers.length > 0 ? '回答列表：\n' + renderItems(answers) : '',
      ].filter((line) => line !== '')
      return { ok: true, message: lines.join('\n'), question, answers }
    },
  })
}

/** Tool: one answer (+ optional comments). */
export function zhihuAnswerTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_answer',
    description:
      '查看某条回答的正文（作者、全文、赞同数、评论数）。comments=true 时额外拉取评论——注意 CLI 的 --json 模式不返回评论，此时本工具改用文本模式并把评论以纯文本返回（text 字段）。需要已登录。',
    parameters: {
      answerId: { type: 'string', description: '回答 id（数字，也可给知乎回答 URL）', required: true },
      comments: { type: 'boolean', description: '是否同时获取评论（默认 false）' },
      limit: { type: 'number', description: '评论条数（0=全部，默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          answer: ITEM_SCHEMA,
          text: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { answerId: string; comments?: boolean; limit?: number }, exec) {
      const id = normalizeId(args.answerId)
      if (id === '') {
        return { ok: false, message: '请提供回答 id（answerId）。', answer: emptyItem(), text: '' }
      }
      const detail = await call(ctx.store, ['answer', id, '--json'], { json: true, signal: exec.signal })
      if (!detail.ok) {
        return { ok: false, message: 'zhihu_answer 失败：' + detail.error, answer: emptyItem(), text: '' }
      }
      const answer = compactItem(detail.json)
      const lines = [
        '回答（' + (answer.author !== '' ? answer.author : '匿名') + '）：' + (answer.title !== '' ? answer.title : ''),
        answer.excerpt,
        '赞同 ' + answer.voteupCount + ' · 评论 ' + answer.commentCount,
        answer.url,
      ].filter((line) => line !== '')
      let commentText = ''
      if (args.comments === true) {
        const limit = clampInt(args.limit, 20, 0, 200)
        const run = await call(ctx.store, ['answer', id, '-c', '-l', String(limit)], { signal: exec.signal })
        if (run.ok) {
          commentText = plainText(run.stdout)
          lines.push('', '评论：', commentText)
        } else {
          lines.push('', '评论获取失败：' + run.error)
        }
      }
      return { ok: true, message: lines.join('\n'), answer, text: commentText }
    },
  })
}

/** Tool: user profile / their content. */
export function zhihuUserTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_user',
    description:
      '查看知乎用户：include=profile（默认）返回资料；answers / articles / followers / following 分别返回该用户的回答、文章、粉丝、关注列表。urlToken 是用户主页 zhihu.com/people/<urlToken> 里的那段。需要已登录。',
    parameters: {
      urlToken: { type: 'string', description: '用户的 url_token（或直接给主页 URL）', required: true },
      include: {
        type: 'string',
        enum: ['profile', 'answers', 'articles', 'followers', 'following'],
        description: '要获取的内容（默认 profile）',
      },
      limit: { type: 'number', description: '列表条数（默认 10，最大 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          include: { type: 'string' },
          profile: PROFILE_SCHEMA,
          items: ITEMS_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(args: { urlToken: string; include?: string; limit?: number }, exec) {
      const token = normalizeUrlToken(args.urlToken)
      if (token === '') {
        return { ok: false, message: '请提供 urlToken。', include: 'profile', profile: emptyProfile(), items: [] }
      }
      const include = pick(
        args.include,
        ['profile', 'answers', 'articles', 'followers', 'following'] as const,
        'profile',
      )
      const limit = clampInt(args.limit, 10, 1, 50)
      if (include === 'profile') {
        const result = await call(ctx.store, ['user', token, '--json'], { json: true, signal: exec.signal })
        if (!result.ok) {
          return { ok: false, message: 'zhihu_user 失败：' + result.error, include, profile: emptyProfile(), items: [] }
        }
        const profile = compactProfile(result.json)
        return {
          ok: true,
          message: '@' + token + '：' + describeProfile(profile) + (profile.url !== '' ? '（' + profile.url + '）' : '') + '。',
          include,
          profile,
          items: [],
        }
      }
      const command =
        include === 'answers'
          ? 'user-answers'
          : include === 'articles'
            ? 'user-articles'
            : include
      const result = await call(ctx.store, [command, token, '-l', String(limit), '--json'], {
        json: true,
        signal: exec.signal,
      })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_user 失败：' + result.error, include, profile: emptyProfile(), items: [] }
      }
      const items = compactList(result.json)
      return {
        ok: true,
        message: '@' + token + ' 的' + includeLabel(include) + ' ' + items.length + ' 条：\n' + renderItems(items),
        include,
        profile: emptyProfile(),
        items,
      }
    },
  })
}

/** Tool: recommended feed. */
export function zhihuFeedTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_feed',
    description:
      '查看知乎首页推荐流（结构化条目）。withComments=true 时改用 CLI 的 "feeds" 命令（推荐+评论），该命令只支持文本输出，结果放在 text 字段。需要已登录。',
    parameters: {
      limit: { type: 'number', description: '条数（默认 10，withComments 时默认 6）' },
      withComments: { type: 'boolean', description: '是否连同评论一起抓取（文本模式，默认 false）' },
      commentLimit: { type: 'number', description: 'withComments 时每条回答的评论数（默认 10）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          total: { type: 'number' },
          items: ITEMS_SCHEMA,
          text: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { limit?: number; withComments?: boolean; commentLimit?: number }, exec) {
      if (args.withComments === true) {
        const limit = clampInt(args.limit, 6, 1, 30)
        const commentLimit = clampInt(args.commentLimit, 10, 0, 50)
        const result = await call(
          ctx.store,
          ['feeds', '-l', String(limit), '-c', String(commentLimit)],
          { signal: exec.signal },
        )
        if (!result.ok) {
          return { ok: false, message: 'zhihu_feed 失败：' + result.error, total: 0, items: [], text: '' }
        }
        const body = plainText(result.stdout)
        return {
          ok: true,
          message: '知乎推荐流（含评论，文本模式）：\n' + truncate(body, 4000),
          total: 0,
          items: [],
          text: body.slice(0, 20_000),
        }
      }
      const limit = clampInt(args.limit, 10, 1, 50)
      const result = await call(ctx.store, ['feed', '-l', String(limit), '--json'], {
        json: true,
        signal: exec.signal,
      })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_feed 失败：' + result.error, total: 0, items: [], text: '' }
      }
      const items = compactList(result.json)
      return {
        ok: true,
        message: '知乎推荐流 ' + items.length + ' 条：\n' + renderItems(items),
        total: items.length,
        items,
        text: '',
      }
    },
  })
}

/** Tool: topic. */
export function zhihuTopicTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_topic',
    description:
      '查看知乎话题详情（名称、简介、关注者数、问题数）；hotQuestions=true 时额外返回该话题的热门问题——CLI 的 --json 模式不含热门问题，此时改用文本模式放在 text 字段。需要已登录。',
    parameters: {
      topicId: { type: 'string', description: '话题 id（数字，也可给话题 URL）', required: true },
      hotQuestions: { type: 'boolean', description: '是否同时获取话题下的热门问题（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          topic: ITEM_SCHEMA,
          text: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { topicId: string; hotQuestions?: boolean }, exec) {
      const id = normalizeId(args.topicId)
      if (id === '') {
        return { ok: false, message: '请提供话题 id（topicId）。', topic: emptyItem(), text: '' }
      }
      const detail = await call(ctx.store, ['topic', id, '--json'], { json: true, signal: exec.signal })
      if (!detail.ok) {
        return { ok: false, message: 'zhihu_topic 失败：' + detail.error, topic: emptyItem(), text: '' }
      }
      const topic = compactItem(detail.json)
      const lines = [
        '话题：' + (topic.title !== '' ? topic.title : id),
        topic.excerpt !== '' ? '简介：' + topic.excerpt : '',
        '关注者 ' + topic.followerCount + ' · 问题 ' + topic.answerCount,
        topic.url,
      ].filter((line) => line !== '')
      let body = ''
      if (args.hotQuestions === true) {
        const run = await call(ctx.store, ['topic', id], { signal: exec.signal })
        if (run.ok) {
          body = plainText(run.stdout)
          lines.push('', '话题页（含热门问题）：', truncate(body, 3000))
        } else {
          lines.push('', '热门问题获取失败：' + run.error)
        }
      }
      return { ok: true, message: lines.join('\n'), topic, text: body.slice(0, 20_000) }
    },
  })
}

/** Tool: notifications. */
export function zhihuNotificationsTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_notifications',
    description: '查看知乎通知（赞同/评论/关注等），返回归一条目。limit 控制条数，offset 用于翻页（来自上一页的 paging.next）。需要已登录。',
    parameters: {
      limit: { type: 'number', description: '条数（默认 10，最大 50）' },
      offset: { type: 'number', description: '分页偏移（默认 0）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          total: { type: 'number' },
          items: ITEMS_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(args: { limit?: number; offset?: number }, exec) {
      const limit = clampInt(args.limit, 10, 1, 50)
      const offset = clampInt(args.offset, 0, 0, 10_000)
      const result = await call(
        ctx.store,
        ['notifications', '-l', String(limit), '--offset', String(offset), '--json'],
        { json: true, signal: exec.signal },
      )
      if (!result.ok) {
        return { ok: false, message: 'zhihu_notifications 失败：' + result.error, total: 0, items: [] }
      }
      const items = compactList(result.json)
      return {
        ok: true,
        message: '知乎通知 ' + items.length + ' 条（offset ' + offset + '）：\n' + renderItems(items),
        total: items.length,
        items,
      }
    },
  })
}

/** Tool: collections. */
export function zhihuCollectionsTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_collections',
    description: '列出当前账号的知乎收藏夹（名称、条目数、关注者）。需要已登录。',
    parameters: {
      limit: { type: 'number', description: '条数（默认 10，最大 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          total: { type: 'number' },
          items: ITEMS_SCHEMA,
        },
      },
      render: renderMessage,
    },
    async execute(args: { limit?: number }, exec) {
      const limit = clampInt(args.limit, 10, 1, 50)
      const result = await call(ctx.store, ['collections', '-l', String(limit), '--json'], {
        json: true,
        signal: exec.signal,
      })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_collections 失败：' + result.error, total: 0, items: [] }
      }
      const items = compactList(result.json)
      return {
        ok: true,
        message: '收藏夹 ' + items.length + ' 个：\n' + renderItems(items),
        total: items.length,
        items,
      }
    },
  })
}

/* ------------------------------------------------------------------ */
/* Write tools (only mounted when readOnly is off)                     */
/* ------------------------------------------------------------------ */

/** Tool: publish a question / pin / article. */
export function zhihuPublishTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_publish',
    description:
      '在知乎发布内容（真实对外发布，谨慎使用）。kind=ask 发布提问（title 必填，detail 为描述，topics 为话题 id）；kind=pin 发布想法（title 必填，content 为正文）；kind=article 发布文章（title 与 content 均必填，topics 为话题 id）。images 为本地图片绝对路径（可多张）。dryRun=true 只回显将要执行的命令，不真正发布。',
    parameters: {
      kind: { type: 'string', enum: ['ask', 'pin', 'article'], description: '发布类型', required: true },
      title: { type: 'string', description: '标题（提问/想法/文章均必填）', required: true },
      content: { type: 'string', description: '正文：article 必填；pin 可选（想法正文）' },
      detail: { type: 'string', description: 'ask 的补充描述' },
      topics: { type: 'array', items: { type: 'string' }, description: '话题 id 列表（ask / article 可用）' },
      images: { type: 'array', items: { type: 'string' }, description: '本地图片绝对路径列表' },
      dryRun: { type: 'boolean', description: 'true 时只回显命令，不发布（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          kind: { type: 'string' },
          dryRun: { type: 'boolean' },
          command: { type: 'string' },
          output: { type: 'string' },
          url: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(
      args: {
        kind: string
        title: string
        content?: string
        detail?: string
        topics?: string[]
        images?: string[]
        dryRun?: boolean
      },
      exec,
    ) {
      const kind = pick(args.kind, ['ask', 'pin', 'article'] as const, 'ask')
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      const content = typeof args.content === 'string' ? args.content : ''
      const detail = typeof args.detail === 'string' ? args.detail : ''
      const topics = Array.isArray(args.topics) ? args.topics.filter((t) => typeof t === 'string' && t !== '') : []
      const images = Array.isArray(args.images) ? args.images.filter((i) => typeof i === 'string' && i !== '') : []
      if (title === '') {
        return { ok: false, message: 'title 不能为空。', kind, dryRun: args.dryRun === true, command: '', output: '', url: '' }
      }
      if (kind === 'article' && content.trim() === '') {
        return { ok: false, message: 'kind=article 需要提供 content（文章正文）。', kind, dryRun: args.dryRun === true, command: '', output: '', url: '' }
      }
      const argv: string[] = kind === 'ask' ? ['ask', title] : kind === 'pin' ? ['pin', title] : ['article', title, content]
      if (kind === 'ask' && detail !== '') argv.push('-d', detail)
      if (kind === 'pin' && content !== '') argv.push('-c', content)
      if (kind !== 'pin') for (const topic of topics) argv.push('-t', topic)
      for (const image of images) argv.push('-i', image)

      if (args.dryRun === true) {
        return {
          ok: true,
          message: '（dryRun）将执行：zhihu ' + argv.map(shellQuote).join(' ') + '。确认后去掉 dryRun 即可真实发布。',
          kind,
          dryRun: true,
          command: 'zhihu ' + argv.map(shellQuote).join(' '),
          output: '',
          url: '',
        }
      }

      const result = await call(ctx.store, argv, { signal: exec.signal })
      if (!result.ok) {
        return { ok: false, message: 'zhihu_publish 失败：' + result.error, kind, dryRun: false, command: 'zhihu ' + argv.map(shellQuote).join(' '), output: '', url: '' }
      }
      const body = plainText(result.stdout)
      const id = extractPublishedId(body)
      const url = id === '' ? '' : kind === 'article' ? 'https://zhuanlan.zhihu.com/p/' + id : kind === 'pin' ? 'https://www.zhihu.com/pin/' + id : 'https://www.zhihu.com/question/' + id
      return {
        ok: true,
        message: '发布成功（' + kind + '）：' + truncate(body, 400) + (url !== '' ? '\n' + url : ''),
        kind,
        dryRun: false,
        command: 'zhihu ' + argv.map(shellQuote).join(' '),
        output: body.slice(0, 4000),
        url,
      }
    },
  })
}

/** Tool: vote on an answer. */
export function zhihuVoteTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_vote',
    description: '对知乎回答点赞/取消点赞（真实写操作）。action=up 赞同（默认），action=neutral 取消赞同。',
    parameters: {
      answerId: { type: 'string', description: '回答 id', required: true },
      action: { type: 'string', enum: ['up', 'neutral'], description: 'up=赞同（默认）；neutral=取消赞同' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          answerId: { type: 'string' },
          action: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { answerId: string; action?: string }, exec) {
      const id = normalizeId(args.answerId)
      const action = pick(args.action, ['up', 'neutral'] as const, 'up')
      if (id === '') return { ok: false, message: '请提供回答 id（answerId）。', answerId: '', action }
      const flag = action === 'up' ? '--up' : '--neutral'
      const result = await call(ctx.store, ['vote', id, flag], { signal: exec.signal })
      if (!result.ok) return { ok: false, message: 'zhihu_vote 失败：' + result.error, answerId: id, action }
      return {
        ok: true,
        message: '已' + (action === 'up' ? '赞同' : '取消赞同') + '回答 ' + id + '。',
        answerId: id,
        action,
      }
    },
  })
}

/** Tool: follow / unfollow a question. */
export function zhihuFollowQuestionTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_follow_question',
    description: '关注/取消关注知乎问题（真实写操作）。unfollow=true 为取消关注。',
    parameters: {
      questionId: { type: 'string', description: '问题 id', required: true },
      unfollow: { type: 'boolean', description: 'true 取消关注（默认 false=关注）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          questionId: { type: 'string' },
          unfollow: { type: 'boolean' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { questionId: string; unfollow?: boolean }, exec) {
      const id = normalizeId(args.questionId)
      const unfollow = args.unfollow === true
      if (id === '') return { ok: false, message: '请提供问题 id（questionId）。', questionId: '', unfollow }
      const argv = ['follow-question', id]
      if (unfollow) argv.push('--unfollow')
      const result = await call(ctx.store, argv, { signal: exec.signal })
      if (!result.ok) return { ok: false, message: 'zhihu_follow_question 失败：' + result.error, questionId: id, unfollow }
      return { ok: true, message: (unfollow ? '已取消关注' : '已关注') + '问题 ' + id + '。', questionId: id, unfollow }
    },
  })
}

/** Tool: delete own content. */
export function zhihuDeleteTool(ctx: ToolContext) {
  return defineTool({
    name: 'zhihu_delete',
    description:
      '删除自己在知乎发布的内容（不可恢复）。kind=question/pin/article，id 为对应 id。必须显式传 confirm: true 才会真正删除（映射 CLI 的 -y），否则只回显将要执行的命令。',
    parameters: {
      kind: { type: 'string', enum: ['question', 'pin', 'article'], description: '要删除的内容类型', required: true },
      id: { type: 'string', description: '内容 id', required: true },
      confirm: { type: 'boolean', description: '必须为 true 才真正删除（默认 false，仅回显命令）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          kind: { type: 'string' },
          id: { type: 'string' },
          deleted: { type: 'boolean' },
          command: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: { kind: string; id: string; confirm?: boolean }, exec) {
      const kind = pick(args.kind, ['question', 'pin', 'article'] as const, 'question')
      const id = normalizeId(args.id)
      const command = 'zhihu delete-' + kind + ' ' + id + ' -y'
      if (id === '') return { ok: false, message: '请提供要删除的内容 id。', kind, id: '', deleted: false, command: '' }
      if (args.confirm !== true) {
        return {
          ok: true,
          message: '（未删除）确认无误后带 confirm: true 再调用，将执行：' + command + '。',
          kind,
          id,
          deleted: false,
          command,
        }
      }
      const result = await call(ctx.store, ['delete-' + kind, id, '-y'], { signal: exec.signal })
      if (!result.ok) return { ok: false, message: 'zhihu_delete 失败：' + result.error, kind, id, deleted: false, command }
      return {
        ok: true,
        message: '已删除' + kind + ' ' + id + '：' + truncate(plainText(result.stdout), 200),
        kind,
        id,
        deleted: true,
        command,
      }
    },
  })
}

/* ------------------------------------------------------------------ */
/* Helpers + roster                                                    */
/* ------------------------------------------------------------------ */

/** An all-empty item, so results keep the declared shape. */
function emptyItem(): CompactItem {
  return {
    id: '',
    type: '',
    title: '',
    url: '',
    author: '',
    excerpt: '',
    voteupCount: 0,
    commentCount: 0,
    answerCount: 0,
    followerCount: 0,
    created: '',
  }
}

/** Extract a bare numeric id from a raw id or a Zhihu URL. */
function normalizeId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/^\d+$/.test(trimmed)) return trimmed
  const match = /(\d{3,})/.exec(trimmed)
  return match?.[1] ?? ''
}

/** Extract a url_token from a raw token or a zhihu.com/people URL. */
function normalizeUrlToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  const match = /\/people\/([^/?#]+)/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/** Chinese label for a user-content section. */
function includeLabel(include: string): string {
  switch (include) {
    case 'answers':
      return '回答'
    case 'articles':
      return '文章'
    case 'followers':
      return '粉丝'
    case 'following':
      return '关注'
    default:
      return '内容'
  }
}

/** Quote a shell argument for display only (never executed through a shell). */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9._:/@-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'"
}

/** Pull the published object id out of the CLI's success line. */
function extractPublishedId(output: string): string {
  const labelled = /ID:\s*(\d+)/.exec(output)
  if (labelled !== null) return labelled[1] ?? ''
  const urlMatch = /zhihu\.com\/(?:question|pin)\/(\d+)|zhuanlan\.zhihu\.com\/p\/(\d+)/.exec(output)
  return urlMatch?.[1] ?? urlMatch?.[2] ?? ''
}

/** Build every tool for the current mode. */
export function buildTools(ctx: ToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    zhihuStatusTool(ctx),
    zhihuConfigTool(ctx),
    zhihuLoginTool(ctx),
    zhihuLogoutTool(ctx),
    zhihuWhoamiTool(ctx),
    zhihuSearchTool(ctx),
    zhihuHotTool(ctx),
    zhihuQuestionTool(ctx),
    zhihuAnswerTool(ctx),
    zhihuUserTool(ctx),
    zhihuFeedTool(ctx),
    zhihuTopicTool(ctx),
    zhihuNotificationsTool(ctx),
    zhihuCollectionsTool(ctx),
  ]
  if (!ctx.readOnly) {
    tools.push(
      zhihuPublishTool(ctx),
      zhihuVoteTool(ctx),
      zhihuFollowQuestionTool(ctx),
      zhihuDeleteTool(ctx),
    )
  }
  return tools
}

/** Names of the tools that only exist when readOnly is off. */
export const WRITE_TOOL_NAMES: readonly string[] = [
  'zhihu_publish',
  'zhihu_vote',
  'zhihu_follow_question',
  'zhihu_delete',
]
