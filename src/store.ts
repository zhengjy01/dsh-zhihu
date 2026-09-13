/**
 * dsh-zhihu — configuration store and login-state reader.
 *
 * Owns <DSH_HOME>/dsh-zhihu.json (mode 0600) and every path the plugin derives
 * from it. The harness home is `DSH_HOME` when set (some machines relocate it),
 * falling back to ~/.dsh. Credentials are never stored here: the CLI keeps the Zhihu cookies
 * in <cliHome>/cookies.json (the CLI itself chmods that file 0600) and this
 * module only ever reports whether the required cookies are present.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { pluginPath } from './home.ts'
import { defaultCliHome, proxyMode, resolveExecutable } from './exec.ts'

/** Re-exported for host consumers (the shared home resolver lives in home.ts). */
export { dshHome } from './home.ts'

/** Machine-wide config location (mode 0600). */
export const DEFAULT_CONFIG_FILE = pluginPath(undefined, 'dsh-zhihu.json')

/** Plugin scratch directory (login log). */
export const DEFAULT_DATA_DIR = pluginPath(undefined, 'dsh-zhihu')

/** Cookies the CLI refuses to work without. */
export const REQUIRED_COOKIES: readonly string[] = ['z_c0', '_xsrf', 'd_c0']

/** Default CLI invocation timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 90_000

/** Default wait for a QR scan before handing control back to the agent (ms). */
export const DEFAULT_LOGIN_WAIT_MS = 15_000

/** Default command name when config.cliPath is empty. */
export const DEFAULT_CLI_PATH = 'zhihu'

/** Config location: DSH_ZHIHU_CONFIG → DSH_HOME → ~/.dsh (mode 0600). */
export function configPath(): string {
  return pluginPath(process.env.DSH_ZHIHU_CONFIG, 'dsh-zhihu.json')
}

/** Scratch dir: DSH_ZHIHU_DATA_DIR → DSH_HOME → ~/.dsh. */
export function dataDir(): string {
  return pluginPath(process.env.DSH_ZHIHU_DATA_DIR, 'dsh-zhihu')
}

/** Persisted configuration. */
export interface ZhihuConfig {
  /**
   * When true, only read-only tools are registered. `undefined` means "not
   * decided here" — the composition row's seed then applies, else true.
   */
  readOnly: boolean | undefined
  /** CLI command name or absolute path ('' means DEFAULT_CLI_PATH). */
  cliPath: string
  /** Hard timeout for one CLI invocation (ms). */
  timeoutMs: number
  /** How long `zhihu_login` waits for a QR scan before returning (ms). */
  loginWaitMs: number
  /** '' inherits proxy env vars, 'none' strips them, else a proxy URL. */
  proxy: string
  /** CLI config directory ('' means ~/.zhihu-cli). */
  cliHome: string
}

/** Public, secret-free configuration view. */
export interface ZhihuConfigView {
  configured: boolean
  readOnly: boolean
  /** Where the effective readOnly came from: 'store' | 'row' | 'default'. */
  readOnlySource: 'store' | 'row' | 'default'
  cliPath: string
  resolvedCliPath: string
  timeoutMs: number
  loginWaitMs: number
  proxy: string
  proxyMode: 'inherit' | 'off' | 'custom'
  cliHome: string
  cookiePath: string
  qrcodePath: string
  logPath: string
  configPath: string
}

/** Login state derived from the CLI's own cookie file. */
export interface LoginState {
  /** Path of the CLI cookie file. */
  cookiePath: string
  /** Whether the cookie file exists. */
  cookiePresent: boolean
  /** Whether every required cookie key is present. */
  hasRequired: boolean
  /** Required cookie names that are missing. */
  missing: string[]
  /** Last modification time of the cookie file (ISO, '' when absent). */
  savedAt: string
  /** QR PNG path the CLI writes during `login --qrcode`. */
  qrcodePath: string
  /** Whether the QR PNG currently exists. */
  qrcodePresent: boolean
}

/** Empty configuration record. */
function empty(): ZhihuConfig {
  return {
    readOnly: undefined,
    cliPath: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    loginWaitMs: DEFAULT_LOGIN_WAIT_MS,
    proxy: '',
    cliHome: '',
  }
}

/** Coerce unknown JSON into a ZhihuConfig, ignoring malformed fields. */
function coerce(raw: unknown): ZhihuConfig {
  const base = empty()
  if (typeof raw !== 'object' || raw === null) return base
  const obj = raw as Record<string, unknown>
  return {
    readOnly: typeof obj.readOnly === 'boolean' ? obj.readOnly : undefined,
    cliPath: typeof obj.cliPath === 'string' ? obj.cliPath : base.cliPath,
    timeoutMs:
      typeof obj.timeoutMs === 'number' && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
        ? Math.floor(obj.timeoutMs)
        : base.timeoutMs,
    loginWaitMs:
      typeof obj.loginWaitMs === 'number' && Number.isFinite(obj.loginWaitMs) && obj.loginWaitMs >= 0
        ? Math.floor(obj.loginWaitMs)
        : base.loginWaitMs,
    proxy: typeof obj.proxy === 'string' ? obj.proxy : base.proxy,
    cliHome: typeof obj.cliHome === 'string' ? obj.cliHome : base.cliHome,
  }
}

/** Configuration patch accepted from the tools layer. */
export interface ConfigPatch {
  readOnly?: boolean
  cliPath?: string
  timeoutMs?: number
  loginWaitMs?: number
  proxy?: string
  cliHome?: string
  reset?: boolean
}

/**
 * Config + login-state store with lazy cached reads.
 *
 * `rowReadOnly` is the composition row's seed, applied when the store has no
 * explicit opinion (mirrors how dsh-xianyu seeds its readOnly from the row).
 */
export class ZhihuStore {
  private cached: ZhihuConfig | null = null

  /** Current config file path (honors the DSH_ZHIHU_CONFIG override). */
  readonly file: string = configPath()

  /**
   * @param rowReadOnly - seed from the composition row (default true).
   */
  constructor(private readonly rowReadOnly: boolean = true) {}

  /** Read the config (lazy, cached; never throws). */
  async read(): Promise<ZhihuConfig> {
    return this.readSync()
  }

  /**
   * Synchronous read, so the plugin mount path can resolve the effective
   * readOnly without deferring cordis effect registration into a microtask.
   */
  readSync(): ZhihuConfig {
    if (this.cached !== null) return this.cached
    try {
      const raw = readFileSync(this.file, 'utf8')
      this.cached = coerce(JSON.parse(raw) as unknown)
    } catch {
      // Missing or corrupt config: fall back to defaults rather than crashing.
      this.cached = empty()
    }
    return this.cached
  }

  /** Effective readOnly plus its provenance. */
  async readOnly(): Promise<{ value: boolean; source: 'store' | 'row' | 'default' }> {
    return this.readOnlySync()
  }

  /** Synchronous effective readOnly plus its provenance. */
  readOnlySync(): { value: boolean; source: 'store' | 'row' | 'default' } {
    const config = this.readSync()
    if (config.readOnly !== undefined) return { value: config.readOnly, source: 'store' }
    if (this.rowReadOnly === false) return { value: false, source: 'row' }
    return { value: true, source: 'default' }
  }

  /** CLI command name or path to resolve. */
  async binary(): Promise<string> {
    const config = await this.read()
    return config.cliPath.trim() === '' ? DEFAULT_CLI_PATH : config.cliPath.trim()
  }

  /** Effective CLI config directory. */
  async cliHome(): Promise<string> {
    const config = await this.read()
    return config.cliHome.trim() === '' ? defaultCliHome() : path.resolve(config.cliHome.trim())
  }

  /** Path of the CLI cookie file. */
  async cookiePath(): Promise<string> {
    return path.join(await this.cliHome(), 'cookies.json')
  }

  /** Path of the QR PNG the CLI writes during `login --qrcode`. */
  async qrcodePath(): Promise<string> {
    return path.join(await this.cliHome(), 'login_qrcode.png')
  }

  /** Path of the detached-login log file. */
  logPath(): string {
    return path.join(dataDir(), 'login.log')
  }

  /** Read the CLI's login state from its cookie file. */
  async loginState(): Promise<LoginState> {
    const cookiePath = await this.cookiePath()
    const qrcodePath = await this.qrcodePath()
    let cookiePresent = false
    let savedAt = ''
    let missing: string[] = [...REQUIRED_COOKIES]
    try {
      const raw = await readFile(cookiePath, 'utf8')
      cookiePresent = true
      const info = await stat(cookiePath)
      savedAt = info.mtime.toISOString()
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const jar = parsed.cookies
      const keys =
        typeof jar === 'object' && jar !== null ? Object.keys(jar as Record<string, unknown>) : []
      missing = REQUIRED_COOKIES.filter((key) => !keys.includes(key))
    } catch {
      cookiePresent = false
    }
    let qrcodePresent = false
    try {
      await stat(qrcodePath)
      qrcodePresent = true
    } catch {
      qrcodePresent = false
    }
    return {
      cookiePath,
      cookiePresent,
      hasRequired: cookiePresent && missing.length === 0,
      missing,
      savedAt,
      qrcodePath,
      qrcodePresent,
    }
  }

  /** Public secret-free view. */
  async view(): Promise<ZhihuConfigView> {
    const config = await this.read()
    const readOnly = await this.readOnly()
    const binary = await this.binary()
    const hasStoredValue =
      config.readOnly !== undefined ||
      config.cliPath !== '' ||
      config.proxy !== '' ||
      config.cliHome !== '' ||
      config.timeoutMs !== DEFAULT_TIMEOUT_MS ||
      config.loginWaitMs !== DEFAULT_LOGIN_WAIT_MS
    return {
      configured: hasStoredValue,
      readOnly: readOnly.value,
      readOnlySource: readOnly.source,
      cliPath: config.cliPath,
      resolvedCliPath: resolveExecutable(binary) ?? '',
      timeoutMs: config.timeoutMs,
      loginWaitMs: config.loginWaitMs,
      proxy: config.proxy,
      proxyMode: proxyMode(config.proxy),
      cliHome: await this.cliHome(),
      cookiePath: await this.cookiePath(),
      qrcodePath: await this.qrcodePath(),
      logPath: this.logPath(),
      configPath: this.file,
    }
  }

  /** Persist a patch, or clear everything with reset. */
  async patch(patch: ConfigPatch): Promise<ZhihuConfigView> {
    const current = await this.read()
    let next: ZhihuConfig
    if (patch.reset === true) {
      next = empty()
    } else {
      next = {
        readOnly: patch.readOnly !== undefined ? patch.readOnly : current.readOnly,
        cliPath: patch.cliPath !== undefined ? patch.cliPath.trim() : current.cliPath,
        timeoutMs:
          patch.timeoutMs !== undefined && patch.timeoutMs > 0
            ? Math.floor(patch.timeoutMs)
            : current.timeoutMs,
        loginWaitMs:
          patch.loginWaitMs !== undefined && patch.loginWaitMs >= 0
            ? Math.floor(patch.loginWaitMs)
            : current.loginWaitMs,
        proxy: patch.proxy !== undefined ? patch.proxy.trim() : current.proxy,
        cliHome: patch.cliHome !== undefined ? patch.cliHome.trim() : current.cliHome,
      }
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    // readOnly: undefined is meaningful (fall back to the row seed) but JSON
    // drops undefined keys, which is exactly the wire shape we want.
    const serializable: Record<string, unknown> = {}
    if (next.readOnly !== undefined) serializable.readOnly = next.readOnly
    serializable.cliPath = next.cliPath
    serializable.timeoutMs = next.timeoutMs
    serializable.loginWaitMs = next.loginWaitMs
    serializable.proxy = next.proxy
    serializable.cliHome = next.cliHome
    await writeFile(this.file, JSON.stringify(serializable, null, 2) + '\n', { mode: 0o600 })
    this.cached = next
    return this.view()
  }

  /** Drop the cached config (used after external edits in tests). */
  invalidate(): void {
    this.cached = null
  }
}
