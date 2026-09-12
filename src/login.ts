/**
 * dsh-zhihu — QR login orchestration.
 *
 * `zhihu login --qrcode` blocks until the user scans with the Zhihu app. That
 * does not fit a tool call, so the plugin starts it detached with output
 * redirected to a log file, then polls for the cookie file the CLI writes on
 * success. The QR PNG (written by the CLI to <cliHome>/login_qrcode.png) is
 * handed to the agent, which can show it to the user.
 *
 * A small record under the plugin's data directory tracks the running login so
 * a second tool call waits on the existing process instead of spawning a
 * second QR code.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { cliEnv, isAlive, resolveExecutable, sleep, startDetached } from './exec.ts'
import { dataDir, REQUIRED_COOKIES, type LoginState, type ZhihuStore } from './store.ts'

/** Persisted handle to a detached login process. */
export interface LoginRecord {
  /** Process id of the detached CLI. */
  pid: number
  /** ISO timestamp when the login was started. */
  startedAt: string
  /** QR PNG the CLI writes. */
  qrcodePath: string
  /** Log file capturing the CLI's output. */
  logPath: string
}

/** Outcome of requesting a QR login. */
export interface StartOutcome {
  /** True when this call spawned a new login process. */
  started: boolean
  /** True when a login process (new or pre-existing) is running. */
  alive: boolean
  /** Process id, or 0 when unknown. */
  pid: number
  /** QR PNG path. */
  qrcodePath: string
  /** Whether the QR PNG currently exists. */
  qrcodePresent: boolean
  /** Log file path. */
  logPath: string
  /** Failure reason, '' on success. */
  error: string
}

/** Path of the login record file. */
function recordPath(): string {
  return path.join(dataDir(), 'login.json')
}

/** Read the login record (null when absent or malformed). */
export async function readLoginRecord(): Promise<LoginRecord | null> {
  try {
    const raw = await readFile(recordPath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const pid = typeof parsed.pid === 'number' ? parsed.pid : 0
    if (pid <= 0) return null
    return {
      pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      qrcodePath: typeof parsed.qrcodePath === 'string' ? parsed.qrcodePath : '',
      logPath: typeof parsed.logPath === 'string' ? parsed.logPath : '',
    }
  } catch {
    return null
  }
}

/** Persist the login record. */
async function writeLoginRecord(record: LoginRecord): Promise<void> {
  await mkdir(dataDir(), { recursive: true })
  await writeFile(recordPath(), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
}

/** Remove the login record (best effort). */
export async function clearLoginRecord(): Promise<void> {
  try {
    await rm(recordPath(), { force: true })
  } catch {
    // Nothing to remove.
  }
}

/** Tail of the login log, for reporting a failure reason. */
export async function loginLogTail(maxChars = 600): Promise<string> {
  try {
    const raw = await readFile(recordPath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const logPath = typeof parsed.logPath === 'string' ? parsed.logPath : ''
    if (logPath === '') return ''
    const text = await readFile(logPath, 'utf8')
    return text.slice(-maxChars).trim()
  } catch {
    return ''
  }
}

/** Outcome of accepting a pasted cookie string. */
export interface CookieSaveOutcome {
  /** True when the cookie file was written. */
  ok: boolean
  /** Failure reason, '' on success. */
  error: string
  /** Required cookie names that were missing from the pasted string. */
  missing: string[]
  /** Cookie file path. */
  cookiePath: string
}

/** Parse a `k=v; k2=v2` cookie string into a map. */
export function parseCookieString(raw: string): Record<string, string> {
  const jar: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key !== '') jar[key] = value
  }
  return jar
}

/**
 * Persist a pasted cookie string in the CLI's own cookie file.
 *
 * The plugin writes the file directly instead of shelling out to
 * `zhihu login --cookie <value>`, so the session token never appears in the
 * process table. The file shape (`{"cookies": {...}}`, mode 0600) and the
 * required keys mirror the CLI's `save_cookies` exactly; the caller then
 * verifies the session online through `zhihu whoami`.
 * @param store - config/login-state store.
 * @param raw - the pasted cookie string.
 * @returns the save outcome.
 */
export async function saveCookieString(
  store: ZhihuStore,
  raw: string,
): Promise<CookieSaveOutcome> {
  const cookiePath = await store.cookiePath()
  const jar = parseCookieString(raw)
  const missing = REQUIRED_COOKIES.filter((key) => jar[key] === undefined || jar[key] === '')
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'Cookie 缺少必需字段：' + missing.join('、') + '（知乎要求同时包含 z_c0 / _xsrf / d_c0）。',
      missing,
      cookiePath,
    }
  }
  try {
    await mkdir(path.dirname(cookiePath), { recursive: true })
    await writeFile(cookiePath, JSON.stringify({ cookies: jar }, null, 2) + '\n', { mode: 0o600 })
    return { ok: true, error: '', missing: [], cookiePath }
  } catch (error) {
    return { ok: false, error: '写入 Cookie 文件失败：' + (error as Error).message, missing: [], cookiePath }
  }
}

/**
 * Delete the CLI's cookie file and the login record.
 * @param store - config/login-state store.
 * @returns the removed paths.
 */
export async function clearCredentials(store: ZhihuStore): Promise<string[]> {
  const removed: string[] = []
  const cookiePath = await store.cookiePath()
  try {
    await rm(cookiePath, { force: true })
    removed.push(cookiePath)
  } catch {
    // Already gone.
  }
  await clearLoginRecord()
  return removed
}

/**
 * Start (or reuse) a detached QR login.
 *
 * The previous QR PNG is deleted first so the caller never hands the user a
 * stale code.
 * @param store - config/login-state store.
 * @returns the start outcome including the QR PNG path.
 */
export async function startQrLogin(store: ZhihuStore): Promise<StartOutcome> {
  const state = await store.loginState()
  const qrcodePath = state.qrcodePath
  const logPath = store.logPath()

  const existing = await readLoginRecord()
  if (existing !== null && isAlive(existing.pid)) {
    return {
      started: false,
      alive: true,
      pid: existing.pid,
      qrcodePath: existing.qrcodePath === '' ? qrcodePath : existing.qrcodePath,
      qrcodePresent: (await store.loginState()).qrcodePresent,
      logPath: existing.logPath === '' ? logPath : existing.logPath,
      error: '',
    }
  }

  const binary = await store.binary()
  const resolved = resolveExecutable(binary)
  if (resolved === null) {
    return {
      started: false,
      alive: false,
      pid: 0,
      qrcodePath,
      qrcodePresent: false,
      logPath,
      error:
        '找不到知乎 CLI「' +
        binary +
        '」。请先安装：uv tool install pyzhihu-cli（或 pipx install pyzhihu-cli），装好后可用 zhihu_config 指定 cliPath。',
    }
  }

  // Drop the previous QR so we never show a stale one.
  try {
    await rm(qrcodePath, { force: true })
  } catch {
    // Ignore: the CLI overwrites it anyway.
  }

  const config = await store.read()
  const env = cliEnv(config.proxy, await store.cliHome())
  const handle = startDetached({ binary: resolved, args: ['login', '--qrcode'], env, logPath })
  if (handle.error !== '') {
    return {
      started: false,
      alive: false,
      pid: 0,
      qrcodePath,
      qrcodePresent: false,
      logPath: handle.logPath,
      error: '启动二维码登录失败：' + handle.error,
    }
  }

  await writeLoginRecord({
    pid: handle.pid,
    startedAt: new Date().toISOString(),
    qrcodePath,
    logPath: handle.logPath,
  })

  // Wait briefly for the CLI to fetch and write the QR image.
  const deadline = Date.now() + 8000
  let qrcodePresent = false
  while (Date.now() < deadline) {
    const now = await store.loginState()
    if (now.qrcodePresent) {
      qrcodePresent = true
      break
    }
    if (!isAlive(handle.pid)) break
    await sleep(400)
  }

  return {
    started: true,
    alive: isAlive(handle.pid),
    pid: handle.pid,
    qrcodePath,
    qrcodePresent,
    logPath: handle.logPath,
    error: qrcodePresent ? '' : '二维码图片尚未生成（可查看日志 ' + handle.logPath + '）',
  }
}

/** Outcome of waiting for a QR scan. */
export interface WaitOutcome {
  /** True once the CLI wrote a cookie file containing every required key. */
  authenticated: boolean
  /** Login state at the end of the wait. */
  state: LoginState
  /** True when the detached login process exited before succeeding. */
  processExited: boolean
  /** Log tail, populated when the process exited without success. */
  logTail: string
}

/**
 * Poll the cookie file until login succeeds, the process dies, or time is up.
 * @param store - config/login-state store.
 * @param waitMs - maximum time to wait in milliseconds.
 * @returns the wait outcome.
 */
export async function waitForLogin(store: ZhihuStore, waitMs: number): Promise<WaitOutcome> {
  const record = await readLoginRecord()
  const deadline = Date.now() + Math.max(0, waitMs)
  let state = await store.loginState()
  while (state.hasRequired !== true && Date.now() < deadline) {
    if (record !== null && !isAlive(record.pid)) break
    await sleep(1000)
    state = await store.loginState()
  }
  if (state.hasRequired) {
    await clearLoginRecord()
    return { authenticated: true, state, processExited: false, logTail: '' }
  }
  const processExited = record !== null && !isAlive(record.pid)
  return {
    authenticated: false,
    state,
    processExited,
    logTail: processExited ? await loginLogTail() : '',
  }
}
