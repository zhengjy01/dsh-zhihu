/**
 * dsh-zhihu — one CLI invocation, normalized.
 *
 * Shared by the agent tools and the web panel routes so both surfaces resolve
 * the CLI, build its environment and interpret failures identically.
 */

import { cliEnv, resolveExecutable, runCli } from './exec.ts'
import { failureReason, parseJsonOutput, stripAnsi } from './parse.ts'
import type { ZhihuStore } from './store.ts'

/** Why a CLI invocation could not run. */
export interface Ready {
  binary: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  error: string
}

/** Resolve the CLI and build its environment. */
export async function ready(store: ZhihuStore): Promise<Ready> {
  const config = await store.read()
  const binary = await store.binary()
  const env = cliEnv(config.proxy, await store.cliHome())
  const resolved = resolveExecutable(binary)
  if (resolved === null) {
    return {
      binary,
      env,
      timeoutMs: config.timeoutMs,
      error:
        '找不到知乎 CLI「' +
        binary +
        '」。请先安装：uv tool install pyzhihu-cli（或 pipx install pyzhihu-cli）；也可用 zhihu_config 的 cliPath 指定绝对路径。',
    }
  }
  return { binary: resolved, env, timeoutMs: config.timeoutMs, error: '' }
}

/** One normalized CLI call. */
export interface Call {
  ok: boolean
  /** Human failure reason ('' when ok). */
  error: string
  stdout: string
  code: number
  /** Parsed `--json` payload (null unless requested and available). */
  json: unknown
}

/**
 * Run one CLI command and normalize the outcome.
 * @param store - config store.
 * @param args - command and flags.
 * @param options - `json: true` parses stdout as JSON; signal cancels the child.
 */
export async function call(
  store: ZhihuStore,
  args: readonly string[],
  options: { json?: boolean; signal?: AbortSignal } = {},
): Promise<Call> {
  const resolved = await ready(store)
  if (resolved.error !== '') {
    return { ok: false, error: resolved.error, stdout: '', code: -1, json: null }
  }
  const runOptions: Parameters<typeof runCli>[0] = {
    binary: resolved.binary,
    args,
    timeoutMs: resolved.timeoutMs,
    env: resolved.env,
  }
  if (options.signal !== undefined) runOptions.signal = options.signal
  const result = await runCli(runOptions)
  if (result.spawnError !== '') {
    return {
      ok: false,
      error: 'CLI 启动失败：' + result.spawnError,
      stdout: result.stdout,
      code: result.code,
      json: null,
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      error: failureReason(result.stdout, result.stderr, result.code),
      stdout: result.stdout,
      code: result.code,
      json: null,
    }
  }
  return {
    ok: true,
    error: '',
    stdout: result.stdout,
    code: result.code,
    json: options.json === true ? parseJsonOutput(result.stdout) : null,
  }
}

/** Plain-text rendering of a CLI run (for text-mode commands and write results). */
export function plainText(stdout: string): string {
  return stripAnsi(stdout)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim()
}
