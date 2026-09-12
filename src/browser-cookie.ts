/**
 * dsh-zhihu — import a logged-in session from the local Chrome profile (macOS).
 *
 * Why this exists: Zhihu's risk control rejects *anonymous* API traffic from
 * non-browser clients, so pyzhihu-cli's QR login can never complete its
 * `scan_info` polling on a flagged machine (it sees HTTP 403 / code 40352 and
 * silently retries until the 120s deadline). With a real `z_c0` cookie the very
 * same requests succeed, so the practical path is to lift the session the
 * browser already has.
 *
 * Reads Chrome's cookie database (a SQLite file) and decrypts its `v10`
 * AES-128-CBC values with the key Chrome keeps in the login Keychain. Only the
 * cookie names are logged; values never leave this module except into the CLI's
 * own cookie file (mode 0600).
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Chrome's per-user data root on macOS. */
export function chromeRoot(): string {
  return path.join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

/** One candidate profile on disk. */
export interface ChromeProfile {
  /** Directory name, e.g. `Default` or `Profile 1`. */
  name: string
  /** Absolute path of the profile's Cookies database. */
  cookiesDb: string
}

/** Outcome of a browser cookie import. */
export interface BrowserCookieResult {
  ok: boolean
  /** Failure reason, '' on success. */
  error: string
  /** Profile the cookies came from ('' when none matched). */
  profile: string
  /** Cookie database path used. */
  source: string
  /** Decrypted cookie name → value. */
  cookies: Record<string, string>
  /** Cookie names that were found (values are never reported). */
  names: string[]
}

/** List Chrome profiles that have a Cookies database. */
export async function listChromeProfiles(): Promise<ChromeProfile[]> {
  const root = chromeRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const profiles: ChromeProfile[] = []
  for (const name of entries) {
    if (name !== 'Default' && !name.startsWith('Profile ')) continue
    const cookiesDb = path.join(root, name, 'Cookies')
    try {
      const info = await stat(cookiesDb)
      if (info.isFile()) profiles.push({ name, cookiesDb })
    } catch {
      // No cookie DB in this profile.
    }
  }
  // Default first, then Profile 1, 2, … in order.
  return profiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/**
 * Read Chrome's cookie encryption password from the login Keychain.
 *
 * This may raise a macOS Keychain prompt the first time; the user approving it
 * is the expected flow.
 * @returns the password, or an error message.
 */
export async function readChromeKey(): Promise<{ key: Buffer; error: string }> {
  try {
    const { stdout } = await run('security', [
      'find-generic-password',
      '-w',
      '-s',
      'Chrome Safe Storage',
      '-a',
      'Chrome',
    ])
    const key = Buffer.from(stdout.replace(/\n$/, ''), 'utf8')
    if (key.length === 0) return { key: Buffer.alloc(0), error: 'Keychain 返回了空密钥' }
    return { key, error: '' }
  } catch (error) {
    return {
      key: Buffer.alloc(0),
      error:
        '读取 Chrome 加密密钥失败（' +
        (error as Error).message.split('\n')[0] +
        '）。若看到钥匙串授权弹窗，请点「允许」。',
    }
  }
}

/** Derive Chrome's AES key from the Keychain password. */
export function deriveKey(password: Buffer): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

/**
 * Decrypt one Chrome `encrypted_value` blob.
 *
 * `v10` is AES-128-CBC with a 16-space IV and a 32-byte domain-hash prefix;
 * trailing control characters are stripped because some values carry padding
 * remnants, and a cookie with a trailing \\u0000 is silently rejected upstream.
 * @param blob - raw bytes from the database.
 * @param key - derived 16-byte key.
 * @returns the plaintext cookie value.
 */
export function decryptValue(blob: Buffer, key: Buffer): string {
  if (blob.length === 0) return ''
  if (blob.subarray(0, 3).toString('latin1') === 'v10') {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()])
    const value = plain.subarray(32).toString('utf8')
    return value.replace(/[\u0000-\u001f\u007f]+$/g, '')
  }
  // Unencrypted (rare, typically only a few built-in cookies).
  return blob
    .toString('utf8')
    .replace(/\u0000+$/g, '')
    .replace(/[\u0000-\u001f\u007f]+$/g, '')
}

/** Read `.mode tabs` rows of name + hex(encrypted_value) from a Chrome cookie DB. */
async function queryCookies(dbPath: string): Promise<Array<{ name: string; blob: Buffer }>> {
  const { stdout } = await run(
    'sqlite3',
    [
      '-readonly',
      dbPath,
      ".mode tabs",
      "select name, hex(encrypted_value) from cookies where host_key like '%zhihu%';",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  )
  const rows: Array<{ name: string; blob: Buffer }> = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [name, hex] = line.split('\t')
    if (name === undefined || hex === undefined || hex === '') continue
    rows.push({ name, blob: Buffer.from(hex, 'hex') })
  }
  return rows
}

/**
 * Import the Zhihu session from Chrome.
 *
 * Tries every profile and returns the first one that yields `z_c0`; the
 * database is copied to a temp file first so a running Chrome cannot block the
 * read.
 * @returns decrypted cookies plus the profile they came from.
 */
export async function readChromeZhihuCookies(): Promise<BrowserCookieResult> {
  const empty: BrowserCookieResult = {
    ok: false,
    error: '',
    profile: '',
    source: '',
    cookies: {},
    names: [],
  }
  const profiles = await listChromeProfiles()
  if (profiles.length === 0) {
    return { ...empty, error: '没有找到 Chrome 的 Cookies 数据库（未安装 Chrome 或未使用过）。' }
  }
  const { key, error: keyError } = await readChromeKey()
  if (keyError !== '') return { ...empty, error: keyError }
  const derived = deriveKey(key)

  let lastError = ''
  for (const profile of profiles) {
    const temp = path.join(tmpdir(), 'dsh-zhihu-chrome-cookies-' + process.pid + '.db')
    try {
      await copyFile(profile.cookiesDb, temp)
      const rows = await queryCookies(temp)
      const cookies: Record<string, string> = {}
      for (const row of rows) {
        try {
          const value = decryptValue(row.blob, derived)
          if (value !== '') cookies[row.name] = value
        } catch {
          // Skip values we cannot decrypt (v11 / app-bound encryption).
        }
      }
      const names = Object.keys(cookies).sort()
      if (cookies.z_c0 === undefined || cookies.z_c0 === '') {
        continue
      }
      return { ok: true, error: '', profile: profile.name, source: profile.cookiesDb, cookies, names }
    } catch (error) {
      lastError = (error as Error).message.split('\n')[0]
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
  return {
    ...empty,
    error:
      '在 Chrome 的各 profile 里都没找到可用的知乎登录态（z_c0）' +
      (lastError !== '' ? '。最后一次错误：' + lastError : '。'),
  }
}
