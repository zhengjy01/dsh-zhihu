/**
 * dsh-zhihu smoke tests.
 *
 * Exercises the config store (round-trip in a temp file), the CLI resolver and
 * runner against the real `zhihu` binary (--version / status — both offline),
 * the JSON/HTML/ANSI parsing helpers, and the cookie-file writer.
 *
 * Safety: DSH_ZHIHU_CONFIG / DSH_ZHIHU_DATA_DIR point into a temp dir, and the
 * CLI home is patched to the temp dir BEFORE anything writes a cookie, so the
 * real ~/.zhihu-cli is never touched (asserted at the end).
 *
 * Commands that need a logged-in session are skipped when no session exists.
 */

import { createCipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ZhihuStore,
  cliEnv,
  compactItem,
  compactList,
  compactProfile,
  configPath,
  dataDir as resolveDataDir,
  decryptValue,
  deriveKey,
  describeProfile,
  dshHome,
  emptyProfile,
  failureReason,
  parseCookieString,
  listChromeProfiles,
  parseJsonOutput,
  readChromeZhihuCookies,
  renderItems,
  resolveExecutable,
  runCli,
  saveCookieString,
  stripAnsi,
  stripHtml,
  truncate,
} from '../lib/index.js'

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

function eq(label, actual, expected) {
  check(label, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}

// Snapshot the real CLI home first, so we can prove the tests never wrote to it.
const realCliHome = path.join(process.env.HOME, '.zhihu-cli')
let realBefore = null
try {
  realBefore = await readFile(path.join(realCliHome, 'cookies.json'), 'utf8')
} catch {
  realBefore = null
}

const here = path.dirname(fileURLToPath(import.meta.url))

const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-zhihu-smoke-'))
const configFile = path.join(tempDir, 'dsh-zhihu.json')
const dataDir = path.join(tempDir, 'data')
const cliHome = path.join(tempDir, '.zhihu-cli')

process.env.DSH_ZHIHU_CONFIG = configFile
process.env.DSH_ZHIHU_DATA_DIR = dataDir

console.log('\n[1] 解析与清洗')
eq('stripAnsi 去掉颜色码', stripAnsi('\u001B[1m知乎\u001B[0m'), '知乎')
eq('stripHtml 去标签并解实体', stripHtml('<p>你好&nbsp;<b>世界</b></p>'), '你好 世界')
eq('truncate 截断加省略号', truncate('abcdefghij', 4), 'abcd…')
eq('truncate 不截断短串', truncate('abc', 4), 'abc')

console.log('\n[2] JSON 解析')
const parsed = parseJsonOutput('{"a":1,"b":[2,3]}')
check('纯 JSON', parsed !== null && parsed.a === 1)
const prefixed = parseJsonOutput('  ✗ 一些提示\n{"data":[{"id":7}]}\n')
check('从噪声后提取 JSON', prefixed !== null && prefixed.data[0].id === 7)
eq('无 JSON 时返回 null', parseJsonOutput('not json at all'), null)

console.log('\n[3] 条目归一化')
const item = compactItem({
  type: 'answer',
  object: {
    id: 12345,
    excerpt: '<p>这是<b>回答</b>摘要</p>',
    voteup_count: 42,
    comment_count: 7,
    author: { name: '张三' },
    created_time: 1700000000,
  },
})
eq('unwrap object 取到 id', item.id, '12345')
eq('type 保留', item.type, 'answer')
eq('excerpt 已去 HTML', item.excerpt, '这是回答摘要')
eq('voteupCount', item.voteupCount, 42)
eq('author', item.author, '张三')
eq('url 由 type+id 拼出', item.url, 'https://www.zhihu.com/answer/12345')
check('created 转 ISO', item.created.startsWith('2023-11-'), item.created)

const hotItem = compactItem({ target: { title: '热榜问题', id: 999 }, detail_text: '1234 万热度' })
eq('热榜标题', hotItem.title, '热榜问题')
eq('热榜 url', hotItem.url, 'https://www.zhihu.com/question/999')

const list = compactList({ data: [{ target: { id: 1, title: 'A' } }, { target: { id: 2, title: 'B' } }] })
eq('compactList 条数', list.length, 2)
check('renderItems 生成编号行', renderItems(list).startsWith('1. A'))

const profile = compactProfile({
  id: 'u1',
  name: '李四',
  url_token: 'lisi',
  headline: '签名',
  answer_count: 10,
  articles_count: 2,
  follower_count: 300,
  voteup_count: 88,
})
eq('profile urlToken', profile.urlToken, 'lisi')
eq('profile url', profile.url, 'https://www.zhihu.com/people/lisi')
check('describeProfile 含昵称与关注者', describeProfile(profile).includes('李四') && describeProfile(profile).includes('300'))
check('空 profile 全默认', emptyProfile().name === '' && emptyProfile().voteupCount === 0)

console.log('\n[4] 失败原因识别')
check('未登录被识别', failureReason('  ✗ Not authenticated — run zhihu login', '', 1).includes('未登录'))
check('退出码 124 → 超时提示', failureReason('', '', 124).includes('超时'))
check('风控 40352/unhuman 被识别', failureReason('{"error":{"code":40352,"message":"系统监测到您的网络环境存在异常"}}', '', 1).includes('风控'))
check('x-zse-96 签名 403/10003 被识别', failureReason('✗ 403 code 10003 (x-zse-96)', '', 1).includes('签名'))

console.log('\n[5] 配置读写与只读开关')
const store = new ZhihuStore(true)
check('默认只读', store.readOnlySync().value === true)
eq('只读来源 default', store.readOnlySync().source, 'default')

const view0 = await store.view()
eq('未配置 cliHome → 默认 ~/.zhihu-cli', view0.cliHome, path.join(process.env.HOME, '.zhihu-cli'))

const patched = await store.patch({ readOnly: false, timeoutMs: 12345, proxy: 'none', cliHome })
eq('readOnly 生效', patched.readOnly, false)
eq('readOnly 来源 store', patched.readOnlySource, 'store')
eq('timeoutMs 落盘', patched.timeoutMs, 12345)
eq('proxyMode=off', patched.proxyMode, 'off')
eq('cliHome 落盘', patched.cliHome, cliHome)

const onDisk = JSON.parse(await readFile(configFile, 'utf8'))
eq('文件里 readOnly 是布尔', onDisk.readOnly, false)
eq('文件权限 0600', (await stat(configFile)).mode & 0o777, 0o600)

store.invalidate()
eq('重新读取仍为读写', store.readOnlySync().value, false)
eq('cliHome 改变后 cookiePath 跟随', (await store.loginState()).cookiePath, path.join(cliHome, 'cookies.json'))

const reset = await store.patch({ reset: true })
eq('reset 回到默认只读', reset.readOnly, true)
eq('reset 后来源 default', reset.readOnlySource, 'default')

// Re-point the CLI home into the temp dir before any cookie write.
await store.patch({ cliHome })

console.log('\n[6] Cookie 解析与写入（沙箱在临时目录）')
const jar = parseCookieString('z_c0=abc; _xsrf=def; d_c0=ghi')
eq('解析三个键', Object.keys(jar).length, 3)
eq('z_c0 值', jar.z_c0, 'abc')
eq('缺分隔符的行被忽略', Object.keys(parseCookieString('nonsense; a=1')).length, 1)

const saved = await saveCookieString(store, 'z_c0=x; _xsrf=y; d_c0=z')
check('cookie 写入成功', saved.ok, saved.error)
check('写入路径在临时目录内', saved.cookiePath.startsWith(tempDir), saved.cookiePath)
eq('cookie 文件权限 0600', (await stat(saved.cookiePath)).mode & 0o777, 0o600)
const writtenJar = JSON.parse(await readFile(saved.cookiePath, 'utf8'))
check('文件结构为 {cookies:{...}}', writtenJar.cookies !== undefined && writtenJar.cookies.z_c0 === 'x')

const missing = await saveCookieString(store, 'z_c0=x')
check('缺字段被拒绝', missing.ok === false && missing.missing.includes('_xsrf'))

const afterLogin = await store.loginState()
check('loginState 识别为已登录', afterLogin.hasRequired, JSON.stringify(afterLogin.missing))

console.log('\n[7] CLI 解析与环境')
const binary = resolveExecutable('zhihu')
check('能解析到 zhihu 可执行文件', binary !== null, String(binary))
check('解析结果含路径分隔符', (binary ?? '').includes(path.sep))
eq('不存在的命令返回 null', resolveExecutable('definitely-not-a-real-binary-xyz'), null)

const envOff = cliEnv('none', '')
check('proxy=none 清掉代理变量', envOff.HTTPS_PROXY === undefined && envOff.https_proxy === undefined)
const envCustom = cliEnv('http://127.0.0.1:7897', '')
eq('proxy=custom 写入大写', envCustom.HTTPS_PROXY, 'http://127.0.0.1:7897')
eq('proxy=custom 写入小写', envCustom.https_proxy, 'http://127.0.0.1:7897')
eq('cliHome 覆盖会改写子进程 HOME', cliEnv('', cliHome).HOME, tempDir)

if (binary !== null) {
  console.log('\n[8] 真实 CLI 调用')
  const version = await runCli({ binary, args: ['--version'], timeoutMs: 30000, env: cliEnv('', '') })
  check('--version 退出码 0', version.ok, 'code=' + version.code + ' err=' + version.stderr)
  check('--version 输出含 zhihu-cli', /zhihu-cli/i.test(version.stdout), version.stdout.trim())

  const status = await runCli({ binary, args: ['status'], timeoutMs: 30000, env: cliEnv('', '') })
  check('status 跑得通（0=已登录 / 1=未登录）', status.code === 0 || status.code === 1, 'code=' + status.code)

  const bogus = await runCli({ binary, args: ['answer'], timeoutMs: 30000, env: cliEnv('', '') })
  check('缺参数时非 0 退出', bogus.code !== 0, 'code=' + bogus.code)

  const slow = await runCli({ binary, args: ['status'], timeoutMs: 1, env: cliEnv('', '') })
  check('超时被标记', slow.timedOut === true, 'timedOut=' + slow.timedOut)

  // Drop the temp overrides so this store reflects the REAL CLI home.
  delete process.env.DSH_ZHIHU_CONFIG
  delete process.env.DSH_ZHIHU_DATA_DIR
  const realStore = new ZhihuStore(true)
  const realLogin = await realStore.loginState()
  if (realLogin.hasRequired) {
    console.log('\n[9] 已登录会话：真实读取')
    const hot = await runCli({
      binary,
      args: ['hot', '-l', '3', '-a', '0', '--json'],
      timeoutMs: 60000,
      env: cliEnv('', ''),
    })
    const items = compactList(parseJsonOutput(hot.stdout))
    check('热榜返回条目', items.length > 0, 'count=' + items.length + ' code=' + hot.code)
    check('热榜条目有标题', items.length > 0 && items[0].title !== '')
    check('热榜条目有 url', items.length > 0 && items[0].url !== '')
  } else {
    console.log('\n[9] 未登录 —— 跳过真实读取（先跑 zhihu login --qrcode）')
  }
} else {
  console.log('\n[8] 未找到 zhihu CLI —— 跳过真实调用（uv tool install pyzhihu-cli）')
}

console.log('\n[10] 浏览器登录态导入')
// Chrome stores v10 values as AES-128-CBC(iv=16 spaces) over a 32-byte domain
// hash followed by the value, keyed by PBKDF2 of the Keychain password. Round-
// trip a synthetic blob so the decryptor is verified without touching Chrome.
const testKey = deriveKey(Buffer.from('test-password'))
const prefix = Buffer.alloc(32, 0xab)
const iv = Buffer.alloc(16, 0x20)
const seal = (text) => {
  const cipher = createCipheriv('aes-128-cbc', testKey, iv)
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.concat([prefix, Buffer.from(text, 'utf8')])),
    cipher.final(),
  ])
}
eq('v10 解密往返正确', decryptValue(seal('zhihu-cookie-测试值'), testKey), 'zhihu-cookie-测试值')
eq('空 blob 返回空串', decryptValue(Buffer.alloc(0), testKey), '')
eq('尾部控制字符被清除', decryptValue(seal('abc\u0000\u0000'), testKey), 'abc')
check('非 v10 blob 走明文分支', decryptValue(Buffer.from('plain-value'), testKey) === 'plain-value')

const profiles = await listChromeProfiles()
check('能枚举 Chrome profile（或为空）', Array.isArray(profiles))
if (profiles.length > 0) {
  const imported = await readChromeZhihuCookies()
  check('导入结果结构正确', typeof imported.ok === 'boolean' && typeof imported.error === 'string')
  if (imported.ok) {
    check('导入含 z_c0', typeof imported.cookies.z_c0 === 'string' && imported.cookies.z_c0 !== '')
    check('导出值无尾部控制字符', Object.values(imported.cookies).every((value) => !/[\u0000-\u001f\u007f]$/.test(value)))
    check('names 与 cookies 数量一致', imported.names.length === Object.keys(imported.cookies).length)
    check('报出来源 profile', imported.profile !== '' && imported.source.includes('Cookies'))
    console.log('    从 ' + imported.profile + ' 导入 ' + imported.names.length + ' 个 cookie（值不外显）')
  } else {
    console.log('    未导入：' + imported.error)
  }
}

console.log('\n[11] 发布物一致性（包名 ↔ bundle 契约）')
const pkgJson = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'))
const patchYml = await readFile(path.join(here, '..', 'cordis.patch.yml'), 'utf8')
const nameMatch = /^\s*name:\s*(.+)$/m.exec(patchYml)
const rawName = (nameMatch?.[1] ?? '').trim()
const patchName = rawName.replace(/^['"]|['"]$/g, '')
eq('cordis.patch.yml 的 name 等于包名', patchName, pkgJson.name)
check('scoped 包名在 YAML 里必须加引号（否则 YAML 解析失败）',
  !rawName.startsWith('@'), 'raw=' + rawName)
check('clientBundle id 在 tsdown 配置里等于包名',
  (await readFile(path.join(here, '..', 'tsdown.config.ts'), 'utf8')).includes("'" + pkgJson.name + "'"),
  pkgJson.name)
check('files 声明含 cordis.patch.yml / lib / CHANGELOG.md',
  ['lib', 'cordis.patch.yml', 'CHANGELOG.md'].every((entry) => pkgJson.files.includes(entry)),
  JSON.stringify(pkgJson.files))
check('三层兼容性声明齐备（engines.node / dsh.engines.dsh / peer 并集）',
  typeof pkgJson.engines?.node === 'string' &&
    typeof pkgJson.dsh?.engines?.dsh === 'string' &&
    Object.keys(pkgJson.peerDependencies ?? {}).some((k) => k.startsWith('@deepseek-ai/dsh-')),
  JSON.stringify({ engines: pkgJson.engines, dshEngines: pkgJson.dsh?.engines }))

console.log('\n[12] 沙箱检查')
let realAfter = null
try {
  realAfter = await readFile(path.join(realCliHome, 'cookies.json'), 'utf8')
} catch {
  realAfter = null
}
check('真实 ~/.zhihu-cli/cookies.json 内容未被改动', realAfter === realBefore, realCliHome)

console.log('\n[13] DSH_HOME 感知（可移植性清单要求 插件覆盖变量 → DSH_HOME → ~/.dsh）')
{
  const savedHome = process.env.DSH_HOME
  const savedConfig = process.env.DSH_ZHIHU_CONFIG
  const savedData = process.env.DSH_ZHIHU_DATA_DIR
  const put = (key, value) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const fakeHome = path.join(tempDir, 'relocated-dsh-home')
  const overrideFile = path.join(tempDir, 'explicit-override.json')
  process.env.DSH_HOME = fakeHome
  delete process.env.DSH_ZHIHU_CONFIG
  delete process.env.DSH_ZHIHU_DATA_DIR
  eq('dshHome() 认 DSH_HOME', dshHome(), fakeHome)
  eq('configPath() 落到 DSH_HOME 下', configPath(), path.join(fakeHome, 'dsh-zhihu.json'))
  eq('dataDir() 落到 DSH_HOME 下', resolveDataDir(), path.join(fakeHome, 'dsh-zhihu'))
  process.env.DSH_ZHIHU_CONFIG = overrideFile
  eq('插件覆盖变量仍优先于 DSH_HOME', configPath(), overrideFile)
  put('DSH_HOME', savedHome)
  put('DSH_ZHIHU_CONFIG', savedConfig)
  put('DSH_ZHIHU_DATA_DIR', savedData)
}

await rm(tempDir, { recursive: true, force: true })

console.log('\n' + (failed === 0 ? '全部通过' : '有失败项') + '：' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed === 0 ? 0 : 1)
