/**
 * dsh-zhihu end-to-end verification.
 *
 * Mounts the plugin's own tool roster (the same `buildTools` the host calls)
 * and invokes the tools directly, so the plugin can be verified against the
 * real CLI **without restarting the DSH host**.
 *
 * Read-only checks run always. Session-dependent checks are skipped when no
 * login exists. Pass `--write-roster` to also print the write-tool roster.
 */

import { ZhihuStore, buildTools, WRITE_TOOL_NAMES } from '../lib/index.js'

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

/** Invoke one tool by name from a roster. */
async function invoke(tools, name, args = {}) {
  const tool = tools.find((entry) => entry.name === name)
  if (tool === undefined) return { missing: true }
  return tool.execute(args, { signal: new AbortController().signal })
}

const store = new ZhihuStore(true)

console.log('\n[1] 工具清单（只读模式）')
const readTools = buildTools({ store, readOnly: true })
const readNames = readTools.map((tool) => tool.name)
check('只读注册 14 个工具', readTools.length === 14, 'got ' + readTools.length + ': ' + readNames.join(','))
for (const name of WRITE_TOOL_NAMES) {
  check('只读模式不含 ' + name, !readNames.includes(name))
}
check('含全部读取工具', [
  'zhihu_status', 'zhihu_config', 'zhihu_login', 'zhihu_logout', 'zhihu_whoami',
  'zhihu_search', 'zhihu_hot', 'zhihu_question', 'zhihu_answer', 'zhihu_user',
  'zhihu_feed', 'zhihu_topic', 'zhihu_notifications', 'zhihu_collections',
].every((name) => readNames.includes(name)))

console.log('\n[2] 工具清单（读写模式）')
const writeTools = buildTools({ store, readOnly: false })
const writeNames = writeTools.map((tool) => tool.name)
check('读写注册 18 个工具', writeTools.length === 18, 'got ' + writeTools.length)
check('含全部写工具', WRITE_TOOL_NAMES.every((name) => writeNames.includes(name)))

console.log('\n[3] zhihu_status')
const status = await invoke(readTools, 'zhihu_status')
check('status ok', status.ok === true, status.message)
check('status 报告 CLI 可用', status.cliAvailable === true, status.message)
check('status 版本号非空', typeof status.cliVersion === 'string' && status.cliVersion !== '')
console.log('    ' + status.message)

console.log('\n[4] zhihu_config（只读回显，不改配置）')
const config = await invoke(readTools, 'zhihu_config')
check('config ok', config.ok === true)
check('config 报告只读来源', config.readOnlySource === 'default', config.readOnlySource)
console.log('    ' + config.message)

const loginState = await store.loginState()
if (!loginState.hasRequired) {
  console.log('\n[5] 未登录 —— 跳过真实读取。先执行：zhihu login --qrcode')
  console.log('\n' + (failed === 0 ? '通过' : '有失败') + '：' + passed + ' passed, ' + failed + ' failed\n')
  process.exit(failed === 0 ? 0 : 1)
}

console.log('\n[5] 已登录 —— 真实读取')
const whoami = await invoke(readTools, 'zhihu_whoami')
check('whoami ok', whoami.ok === true, whoami.message)
check('whoami 有昵称', (whoami.profile?.name ?? '') !== '', JSON.stringify(whoami.profile))
console.log('    ' + whoami.message)

const hot = await invoke(readTools, 'zhihu_hot', { limit: 5 })
check('hot ok', hot.ok === true, hot.message)
check('hot 有条目', (hot.items?.length ?? 0) > 0, 'count=' + (hot.items?.length ?? 0))
check('hot 条目含标题与链接', (hot.items?.[0]?.title ?? '') !== '' && (hot.items?.[0]?.url ?? '') !== '')
console.log('    ' + String(hot.message).split('\n').slice(0, 3).join('\n    '))

const search = await invoke(readTools, 'zhihu_search', { query: '人工智能', limit: 3 })
check('search ok', search.ok === true, search.message)
check('search 有结果', (search.items?.length ?? 0) > 0, 'count=' + (search.items?.length ?? 0))
console.log('    ' + String(search.message).split('\n').slice(0, 3).join('\n    '))

// Chain: take a question from the hot list and open it.
const firstQuestion = (hot.items ?? []).find((item) => item.id !== '')
if (firstQuestion !== undefined) {
  console.log('\n[6] 链路：热榜 → 问题详情（id ' + firstQuestion.id + '）')
  const question = await invoke(readTools, 'zhihu_question', {
    questionId: firstQuestion.id,
    answers: true,
    limit: 2,
  })
  check('question ok', question.ok === true, question.message)
  check('question 有标题', (question.question?.title ?? '') !== '', JSON.stringify(question.question))
  console.log('    ' + String(question.message).split('\n').slice(0, 4).join('\n    '))
}

console.log('\n[7] 未登录时的错误信息质量')
// Force a bogus CLI path to confirm the graceful degradation path.
const bogusStore = new ZhihuStore(true)
await bogusStore.patch({ cliPath: 'definitely-not-a-real-cli-xyz' })
const bogusTools = buildTools({ store: bogusStore, readOnly: true })
const bogusStatus = await invoke(bogusTools, 'zhihu_status')
check('CLI 缺失时 status 仍返回结果', bogusStatus.ok === true)
check('CLI 缺失时报告不可用', bogusStatus.cliAvailable === false)
const bogusHot = await invoke(bogusTools, 'zhihu_hot', { limit: 1 })
check('CLI 缺失时 hot 优雅失败', bogusHot.ok === false && String(bogusHot.message).includes('找不到知乎 CLI'), bogusHot.message)
await bogusStore.patch({ reset: true })

if (process.argv.includes('--write-roster')) {
  console.log('\n[8] 写工具签名（dryRun / confirm 安全阀）')
  const dryRun = await invoke(writeTools, 'zhihu_publish', { kind: 'pin', title: '测试标题', dryRun: true })
  check('publish dryRun 不发布', dryRun.ok === true && dryRun.dryRun === true && dryRun.command.includes('zhihu pin'))
  console.log('    ' + dryRun.message)
  const noConfirm = await invoke(writeTools, 'zhihu_delete', { kind: 'pin', id: '123' })
  check('delete 未 confirm 不执行', noConfirm.ok === true && noConfirm.deleted === false)
  console.log('    ' + noConfirm.message)
}

console.log('\n' + (failed === 0 ? '全部通过' : '有失败项') + '：' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed === 0 ? 0 : 1)
