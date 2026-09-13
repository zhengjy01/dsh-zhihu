/**
 * dsh-zhihu — Zhihu (知乎) for DeepSeek Harness. Host half.
 *
 * Wraps the local pyzhihu-cli CLI (`zhihu`): the read-only surface (status,
 * login/logout, whoami, search, hot list, question, answer, user, feed, topic,
 * notifications, collections) is always mounted; publishing, voting, following
 * and deletion are mounted only when the effective readOnly switch is off.
 * Login lives with the CLI (~/.zhihu-cli/cookies.json, QR PNG at
 * ~/.zhihu-cli/login_qrcode.png) and this plugin's own config is stored in
 * <DSH_HOME>/dsh-zhihu.json (mode 0600, DSH_HOME falls back to ~/.dsh).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { makeRoutes } from './routes.ts'
import { ZhihuStore } from './store.ts'
import { buildTools, type ToolContext } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'zhihu'

/** Services required before the plugin surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 214

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const ZHIHU_GUIDANCE =
  '本机已安装 dsh-zhihu 插件（知乎 CLI 连接）：包装本机命令行工具 pyzhihu-cli（命令名 `zhihu`），把知乎读取能力做成 zhihu_* 工具——' +
  'zhihu_status（状态：CLI 是否可用、是否已登录）、zhihu_config（配置：readOnly/cliPath/timeoutMs/loginWaitMs/proxy/cliHome）、' +
  'zhihu_login（二维码扫码或粘贴 Cookie 登录，二维码 PNG 在 ~/.zhihu-cli/login_qrcode.png，可展示给用户扫）、zhihu_logout、zhihu_whoami、' +
  'zhihu_search（搜问题/回答/文章）、zhihu_hot（热榜）、zhihu_question（问题详情+可选回答列表）、zhihu_answer（回答正文+可选评论）、' +
  'zhihu_user（用户资料/回答/文章/粉丝/关注）、zhihu_feed（推荐流）、zhihu_topic（话题+热门问题）、zhihu_notifications（通知）、zhihu_collections（收藏夹）。' +
  '重要限制：① **知乎 CLI 的所有命令都要求先登录**，未登录连热榜都会失败，所以首次使用必须先 zhihu_login 扫码（图片路径返回后展示给用户）；' +
  '② 默认 readOnly=true，只注册读取类工具；发布提问·想法·文章、赞同、关注、删除等写工具（zhihu_publish / zhihu_vote / zhihu_follow_question / zhihu_delete）' +
  '仅在 zhihu_config 把 readOnly 设为 false 后才会注册，删除还需显式 confirm: true；' +
  '③ 部分命令（评论、推荐+评论、话题热门问题）CLI 只有文本模式，工具会把结果放在 text 字段。' +
  '用户提到「知乎 / zhihu / 知乎热榜 / 知乎搜索 / 发知乎」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (tools, prompt section). */
  enabled?: boolean
  /**
   * Seed for the read-only switch. The real switch lives in
   * <DSH_HOME>/dsh-zhihu.json; this value applies only until the store has an
   * explicit opinion (mirrors dsh-xianyu).
   */
  readOnly?: boolean
}

/**
 * Mount the Zhihu tools and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const store = new ZhihuStore(config?.readOnly !== false)

  let disposeTools: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (!enabled) return
    // The roster depends on readOnly, which is a synchronous file read, so the
    // whole rebuild can stay inside one synchronous pass.
    const readOnly = store.readOnlySync().value
    const toolContext: ToolContext = {
      store,
      readOnly,
      onConfigChanged: () => {
        // Rebuild after the in-flight tool call settles, so the registry is not
        // mutated while it is still dispatching.
        setTimeout(sync, 0)
      },
    }
    disposeTools = ctx.effect(
      () => {
        const disposers = buildTools(toolContext).map((tool) => ctx.tools.register(tool))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-zhihu: tools',
    )
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes({ store }).map((route) => ctx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-zhihu: routes',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-zhihu',
        order: SECTION_ORDER,
        text: ZHIHU_GUIDANCE,
      })
    }
  }

  sync()
}

/** Re-exports for host consumers and the smoke tests. */
export { dshHome, pluginPath } from './home.ts'
export {
  DEFAULT_CONFIG_FILE,
  DEFAULT_DATA_DIR,
  DEFAULT_LOGIN_WAIT_MS,
  DEFAULT_TIMEOUT_MS,
  REQUIRED_COOKIES,
  ZhihuStore,
  configPath,
  dataDir,
  type LoginState,
  type ZhihuConfig,
  type ZhihuConfigView,
} from './store.ts'
export {
  cliEnv,
  defaultCliHome,
  isAlive,
  proxyMode,
  resolveExecutable,
  runCli,
  startDetached,
  type CliResult,
  type RunOptions,
} from './exec.ts'
export {
  clearCredentials,
  clearLoginRecord,
  parseCookieString,
  readLoginRecord,
  saveCookieString,
  startQrLogin,
  waitForLogin,
  type LoginRecord,
  type StartOutcome,
  type WaitOutcome,
} from './login.ts'
export {
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
  stripHtml,
  truncate,
  type CompactItem,
  type CompactProfile,
} from './parse.ts'
export { ZHIHU_API, makeRoutes, type RouteContext, type ZhihuStatusPayload } from './routes.ts'
export {
  chromeRoot,
  decryptValue,
  deriveKey,
  listChromeProfiles,
  readChromeKey,
  readChromeZhihuCookies,
  type BrowserCookieResult,
  type ChromeProfile,
} from './browser-cookie.ts'
export { call, plainText, ready, type Call, type Ready } from './invoke.ts'
export {
  WRITE_TOOL_NAMES,
  buildTools,
  zhihuAnswerTool,
  zhihuCollectionsTool,
  zhihuConfigTool,
  zhihuDeleteTool,
  zhihuFeedTool,
  zhihuFollowQuestionTool,
  zhihuHotTool,
  zhihuLoginTool,
  zhihuLogoutTool,
  zhihuNotificationsTool,
  zhihuPublishTool,
  zhihuQuestionTool,
  zhihuSearchTool,
  zhihuStatusTool,
  zhihuTopicTool,
  zhihuUserTool,
  zhihuVoteTool,
  zhihuWhoamiTool,
  type ToolContext,
} from './tools.ts'
