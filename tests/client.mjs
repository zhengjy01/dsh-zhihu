/**
 * dsh-zhihu client-bundle tests.
 *
 * Executes the emitted lib/client.js inside a synthetic
 * `window.__ModuleLoader__` + a small fake DOM, so the browser half is verified
 * without a browser or a host restart: bundle shape, factory execution,
 * settings.section registration, and — most importantly — the sidebar entry's
 * **placement** (it must sit inline in the settings area next to the WeChat
 * ball, not float on the opposite side of the screen).
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

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

/* ------------------------------------------------------------------ */
/* A tiny fake DOM, enough for placement + class assertions            */
/* ------------------------------------------------------------------ */

/** Minimal selector support: `[class*="x"]` and `.x`. */
function matchesSelector(node, selector) {
  const bracket = /\[class\*="([^"]+)"\]/.exec(selector)
  if (bracket !== null) return node.className.includes(bracket[1])
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
  return false
}

function makeNode(tag) {
  const classes = new Set()
  const node = {
    tagName: tag,
    dataset: {},
    style: {},
    id: '',
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) {
      child.parentNode = node
      node.children.push(child)
      return child
    },
    insertBefore(child, reference) {
      const index = reference === null ? node.children.length : node.children.indexOf(reference)
      if (index < 0) throw new Error('insertBefore: reference is not a child')
      child.parentNode = node
      node.children.splice(index, 0, child)
      return child
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    querySelector(selector) {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) return child
        const nested = child.querySelector(selector)
        if (nested !== null) return nested
      }
      return null
    },
    get nextSibling() {
      if (node.parentNode === null) return null
      const siblings = node.parentNode.children
      return siblings[siblings.indexOf(node) + 1] ?? null
    },
    classList: {
      add(name) {
        classes.add(name)
      },
      remove(name) {
        classes.delete(name)
      },
      contains(name) {
        return classes.has(name)
      },
    },
    get className() {
      return [...classes].join(' ')
    },
    set className(value) {
      classes.clear()
      for (const part of String(value).split(/\s+/).filter(Boolean)) classes.add(part)
    },
  }
  return node
}

const documentRoot = makeNode('html')
const head = makeNode('head')
const body = makeNode('body')
documentRoot.appendChild(head)
documentRoot.appendChild(body)

/** Build a fresh document stub; optionally with a settings area holding the WeChat ball. */
function makeDocument({ withSettingsArea = true, wechatBall = true } = {}) {
  head.children.length = 0
  body.children.length = 0
  for (const child of body.children) child.parentNode = null
  const documentStub = {
    head,
    body,
    documentElement: { classList: { contains: () => false }, dataset: {} },
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => {
      const walk = (node) => {
        for (const child of node.children) {
          if (child.id === id) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(documentRoot)
    },
    querySelector: (selector) => {
      if (selector.includes('settingsArea')) return withSettingsArea ? findSettingsArea() : null
      return body.querySelector(selector)
    },
  }
  if (withSettingsArea) {
    const area = makeNode('div')
    area.className = 'Sidebar_settingsArea__abc123'
    body.appendChild(area)
    if (wechatBall) {
      const ball = makeNode('button')
      ball.className = 'dshwx-ball dshwx-inline'
      area.appendChild(ball)
    }
  }
  return documentStub
}

function findSettingsArea() {
  return body.querySelector('[class*="settingsArea"]')
}

/** A MutationObserver stub that records registration and can be fired manually. */
const observers = []
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.targets = []
  }
  observe(target, options) {
    this.targets.push({ target, options })
    observers.push(this)
  }
  disconnect() {
    this.targets = []
  }
  fire() {
    this.callback([], this)
  }
}

const code = await readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')

console.log('\n[1] bundle 形状')
check('带 __ModuleLoader__.load 包裹', code.includes('window.__ModuleLoader__.load('))
check('带 closure-factory require', code.includes('factory: (require) =>'))
check('footer 返回 module.exports', code.includes('return module.exports;'))
check('声明了插件 id', code.includes('"@zhengjunyao/dsh-zhihu"') || code.includes("'@zhengjunyao/dsh-zhihu'"))
check('不含 node 内建 require（fs/path）', !/require\(["'](?:node:)?(?:fs|path|os)["']\)/.test(code))
check('内联了侧栏锚点选择器', code.includes('settingsArea'))
check('内联了微信球选择器（保持顺序）', code.includes('dshwx-ball'))
check('内联了共用的横向行容器', code.includes('dsh-zhihu-row'))

console.log('\n[2] 外部依赖白名单')
const requiredModules = [...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
const outsideTable = requiredModules.filter((id) => ![
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
].includes(id))
check('只 require 模块表里的包', outsideTable.length === 0, outsideTable.join(', '))
console.log('    requires: ' + [...new Set(requiredModules)].join(', '))

/** Evaluate the bundle against one document stub. */
function evaluate(documentStub) {
  const React = require('react')
  const jsxRuntime = require('react/jsx-runtime')
  const recorded = { loaded: null, registered: [], roots: 0 }
  const fakeRequire = (id) => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return jsxRuntime
    if (id === 'react-dom/client') {
      return {
        createRoot: () => {
          recorded.roots++
          return { render: () => undefined, unmount: () => undefined }
        },
      }
    }
    if (id === 'react-dom') return {}
    throw new Error('unexpected require in client bundle: ' + id)
  }
  const windowStub = {
    __ModuleLoader__: { load: (spec) => { recorded.loaded = spec } },
    matchMedia: () => ({ matches: false }),
  }
  const moduleStub = { exports: {} }
  const factoryFn = new Function(
    'require', 'module', 'exports', 'window', 'document', 'getComputedStyle', 'MutationObserver', 'setTimeout',
    code,
  )
  factoryFn(
    fakeRequire, moduleStub, moduleStub.exports, windowStub, documentStub,
    () => ({ backgroundColor: 'rgba(0, 0, 0, 0)' }), MutationObserverStub, (fn) => fn(),
  )
  const exports = recorded.loaded.factory(fakeRequire)
  const slotCalls = []
  const ctx = {
    slots: {
      inject: (name, callback) => { slotCalls.push(name); callback() },
      register: (descriptor, component) => {
        recorded.registered.push({ descriptor, component })
        return () => undefined
      },
    },
  }
  return { exports, recorded, slotCalls, ctx }
}

console.log('\n[3] 在合成的 loader 中执行')
const documentA = makeDocument({ withSettingsArea: true, wechatBall: true })
const runA = evaluate(documentA)
check('loader.load 被调用一次', runA.recorded.loaded !== null)
check('bundle id 等于包名', runA.recorded.loaded?.id === '@zhengjunyao/dsh-zhihu', String(runA.recorded.loaded?.id))
check('导出 inject 含 slots', Array.isArray(runA.exports.inject) && runA.exports.inject.includes('slots'))
check('导出 apply 函数', typeof runA.exports.apply === 'function')

console.log('\n[4] apply() 行为与挂载点')
runA.exports.apply(runA.ctx)
check('注册到 settings.section', runA.slotCalls.includes('settings.section'), runA.slotCalls.join(', '))
const entry = runA.recorded.registered[0]
check('section id 为 zhihu', entry?.descriptor?.id === 'zhihu', String(entry?.descriptor?.id))
check('label() 返回「知乎」', entry?.descriptor?.label() === '知乎', String(entry?.descriptor?.label?.()))
check('注入了样式标签', head.children.some((node) => node.tagName === 'style'))

const container = documentA.getElementById('dsh-zhihu-floating-entry')
check('入口容器已创建', container !== null)
const area = findSettingsArea()
const row = area.querySelector('.dsh-zhihu-row')
check('与微信球共用一个横向行容器', row !== null && container?.parentNode === row, String(container?.parentNode?.className))
check('行挂在侧栏 settingsArea 内', row?.parentNode === area)
check('容器带 inline 标记类', container?.classList.contains('dsh-zhihu-inline') === true)
const wechatBall = area.querySelector('.dshwx-ball')
check('微信球也被收进行里（避免上下叠）', wechatBall?.parentNode === row)
check('行内顺序：微信球在左、知球在右', row?.children[0] === wechatBall && row?.children[1] === container)

console.log('\n[5] 观察器与自愈')
const watched = observers[observers.length - 1]
check('注册了 MutationObserver', watched !== undefined)
check(
  '观察 body 的 childList + subtree',
  watched?.targets[0]?.target === body &&
    watched?.targets[0]?.options?.childList === true &&
    watched?.targets[0]?.options?.subtree === true,
)
// Simulate a React re-render that replaces the whole sidebar.
const area2 = makeNode('div')
area2.className = 'Sidebar_settingsArea__xyz'
const ball2 = makeNode('button')
ball2.className = 'dshwx-ball dshwx-inline'
area2.appendChild(ball2)
body.children.length = 0
body.appendChild(area2)
watched.fire()
const row2 = area2.querySelector('.dsh-zhihu-row')
check('侧栏重建后自动重新挂回', container?.parentNode === row2, String(container?.parentNode?.className))
check('重建后又造了一个共用的行', row2 !== null && ball2.parentNode === row2)
check('重建后顺序仍为微信球在左、知球在右', row2?.children[0] === ball2 && row2?.children[1] === container)

console.log('\n[6] 没有 settingsArea 时回退右下角')
observers.length = 0
const documentB = makeDocument({ withSettingsArea: false })
const runB = evaluate(documentB)
runB.exports.apply(runB.ctx)
const containerB = documentB.getElementById('dsh-zhihu-floating-entry')
check('回退挂到 body', containerB?.parentNode === body)
check('回退时去掉 inline 标记', containerB?.classList.contains('dsh-zhihu-inline') === false)
check('回退时不造多余的行', body.querySelector('.dsh-zhihu-row') === null)

console.log('\n[7] 重复 apply 不叠加')
runA.exports.apply(runA.ctx)
const containers = (() => {
  let count = 0
  const walk = (node) => {
    for (const child of node.children) {
      if (child.id === 'dsh-zhihu-floating-entry') count++
      walk(child)
    }
  }
  walk(documentRoot)
  return count
})()
check('整棵树里只有一个入口容器', containers === 1, 'got ' + containers)

console.log('\n[8] apply() 失败不抛出')
let threw = false
try {
  runA.exports.apply({ slots: { inject: () => { throw new Error('boom') }, register: () => () => undefined } })
} catch {
  threw = true
}
check('注册失败时被吞掉（不炸 GUI 引导）', threw === false)

console.log('\n' + (failed === 0 ? '全部通过' : '有失败项') + '：' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed === 0 ? 0 : 1)
