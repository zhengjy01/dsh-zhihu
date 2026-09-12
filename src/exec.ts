/**
 * dsh-zhihu — CLI execution layer.
 *
 * Resolves the `zhihu` executable (pyzhihu-cli), spawns it with a timeout and
 * an explicit environment, and returns raw stdout/stderr. Nothing here knows
 * about Zhihu semantics — JSON parsing and shaping live in parse.ts.
 *
 * Why a resolver instead of a bare command name: the DSH host can be started
 * by launchd with a minimal PATH, so `zhihu` installed to ~/.local/bin would
 * otherwise be invisible (the dsh-npm plugin hit exactly this class of bug).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Fallback command name when the plugin config does not override it. */
export const DEFAULT_BINARY = 'zhihu'

/** Directories probed after $PATH when resolving the CLI. */
const EXTRA_BIN_DIRS: readonly string[] = [
  path.join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

/** Proxy environment variable names, upper and lower case. */
const PROXY_KEYS: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]

/**
 * Resolve an executable to an absolute path.
 * @param command - a command name (`zhihu`) or a path.
 * @returns the absolute path when it exists and is executable, else null.
 */
export function resolveExecutable(command: string): string | null {
  const probe = (candidate: string): string | null => {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      return null
    }
  }
  if (command === '') return null
  if (command.includes(path.sep)) return probe(command)
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '')
  for (const dir of [...fromPath, ...EXTRA_BIN_DIRS]) {
    const found = probe(path.join(dir, command))
    if (found !== null) return found
  }
  return null
}

/** How the child process should treat proxy environment variables. */
export type ProxyMode = 'inherit' | 'off' | 'custom'

/**
 * Build the child environment.
 * @param proxy - '' inherits the host proxy vars, 'none' strips them, anything
 *   else is exported as HTTP_PROXY/HTTPS_PROXY/ALL_PROXY (both cases).
 * @param cliHome - the CLI config directory. The CLI hardcodes
 *   `Path.home() / '.zhihu-cli'`, so an override is applied by repointing the
 *   child's HOME.
 * @returns the environment for the spawned process.
 */
export function cliEnv(proxy: string, cliHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const normalized = proxy.trim()
  if (normalized === 'none') {
    for (const key of PROXY_KEYS) delete env[key]
  } else if (normalized !== '') {
    for (const key of PROXY_KEYS) env[key] = normalized
  }
  if (cliHome !== '' && path.resolve(cliHome) !== path.resolve(defaultCliHome())) {
    env.HOME = path.dirname(path.resolve(cliHome))
  }
  return env
}

/** Classify a proxy config value for reporting. */
export function proxyMode(proxy: string): ProxyMode {
  const normalized = proxy.trim()
  if (normalized === '') return 'inherit'
  if (normalized === 'none') return 'off'
  return 'custom'
}

/** Default CLI config directory (`~/.zhihu-cli`), honoring an overridden HOME. */
export function defaultCliHome(): string {
  return path.join(homedir(), '.zhihu-cli')
}

/** Result of one CLI invocation. Never throws. */
export interface CliResult {
  /** True when the process exited with code 0 and was not killed. */
  ok: boolean
  /** Exit code (124 when the plugin killed it on timeout, -1 on spawn error). */
  code: number
  /** Captured stdout, truncated to the byte cap. */
  stdout: string
  /** Captured stderr, truncated to the byte cap. */
  stderr: string
  /** True when the plugin killed the process because it exceeded timeoutMs. */
  timedOut: boolean
  /** Spawn-level failure message ('' when the process actually started). */
  spawnError: string
}

/** Options for one CLI invocation. */
export interface RunOptions {
  /** Absolute path or command name of the CLI. */
  binary: string
  /** Command and flags, e.g. ['hot', '--json', '-l', '10']. */
  args: readonly string[]
  /** Hard wall-clock limit in milliseconds. */
  timeoutMs: number
  /** Environment for the child (see cliEnv). */
  env: NodeJS.ProcessEnv
  /** Per-stream capture cap in bytes (default 4 MiB). */
  maxBytes?: number
  /** Extra stdin content, written then closed (rarely needed). */
  stdin?: string
  /** Caller cancellation: kills the child when the tool call is aborted. */
  signal?: AbortSignal
}

/** Default per-stream capture cap. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Run the CLI once and capture its output.
 * @param options - binary, args, timeout and environment.
 * @returns the captured result; never rejects.
 */
export function runCli(options: RunOptions): Promise<CliResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return new Promise<CliResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(options.binary, [...options.args], {
        env: options.env,
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        ok: false,
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: (error as Error).message,
      })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Escalate if the CLI ignores SIGTERM.
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 2000).unref()
    }, options.timeoutMs)

    const onAbort = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const collect = (chunks: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): number => {
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes
      if (used >= maxBytes) return used
      const remaining = maxBytes - used
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(slice)
      return used + slice.length
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdoutChunks, chunk, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderrChunks, chunk, 'stderr')
    })

    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(options.stdin)
    }

    const finish = (code: number, spawnError: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      resolve({
        ok: code === 0 && !timedOut && spawnError === '',
        code: timedOut ? 124 : code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        spawnError,
      })
    }

    child.on('error', (error: Error) => finish(-1, error.message))
    child.on('close', (code: number | null) => finish(code ?? -1, ''))
  })
}

/** Handle to a detached long-running CLI process (QR login). */
export interface DetachedHandle {
  /** Process id of the detached CLI, or 0 when it could not be started. */
  pid: number
  /** Absolute path of the log file capturing the child's output. */
  logPath: string
  /** Spawn error message, '' on success. */
  error: string
}

/**
 * Start a CLI command detached from the host, with output redirected to a log.
 *
 * Used for `zhihu login --qrcode`, which blocks until the user scans: the
 * plugin must return immediately so the agent can hand the QR PNG over.
 * @param options - binary, args, environment and log path.
 * @returns the detached handle (pid 0 plus an error message on failure).
 */
export function startDetached(options: {
  binary: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  logPath: string
}): DetachedHandle {
  try {
    mkdirSync(path.dirname(options.logPath), { recursive: true })
    const fd = openSync(options.logPath, 'a')
    const child = spawn(options.binary, [...options.args], {
      env: options.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    const pid = child.pid ?? 0
    child.unref()
    // The detached child owns its own descriptors now.
    closeSync(fd)
    if (pid === 0) return { pid: 0, logPath: options.logPath, error: 'CLI 进程未能启动（无 pid）' }
    return { pid, logPath: options.logPath, error: '' }
  } catch (error) {
    return { pid: 0, logPath: options.logPath, error: (error as Error).message }
  }
}

/**
 * Whether a pid currently exists (best effort, never throws).
 * @param pid - process id to probe.
 */
export function isAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Sleep helper for the polling loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
