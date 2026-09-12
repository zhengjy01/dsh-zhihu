/**
 * Sidebar entry for dsh-zhihu.
 *
 * Mirrors how the WeChat bridge mounts its ball: the entry joins the WeChat
 * entry in the left sidebar's settings area (`[class*="settingsArea"]`).
 *
 * That area is a VERTICAL container, so simply appending there stacks the two
 * balls on top of each other. Instead the two balls are moved into one shared
 * horizontal row (`.dsh-zhihu-row`) so they read as a pair — WeChat on the
 * left, Zhihu on the right — and the popover opens bottom-left to match.
 *
 * If the settings area never appears (a shell without it), the entry falls back
 * to a fixed bottom-right ball.
 *
 * Self-healing: the sidebar is React-rendered and can be re-created at any
 * time, which would orphan the entry. A MutationObserver re-places it whenever
 * the anchor changes — placement is idempotent, so a correct DOM produces no
 * further mutation and the observer settles.
 */
import { useState } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ZhihuPanel } from './ZhihuPanel.tsx'

/** Zhihu brand blue — the entry's identity colour. */
const ACCENT = '#056DE8'

/** Container id, so a hot reload does not stack copies. */
const CONTAINER_ID = 'dsh-zhihu-floating-entry'

/** Styles injected once into <head>. */
const STYLE_ID = 'dsh-zhihu-floating/styles'

/** Class marking the inline (sidebar) placement. */
const INLINE_CLASS = 'dsh-zhihu-inline'

/** The settings row the WeChat entry also mounts into. */
const SETTINGS_AREA_SELECTOR = '[class*="settingsArea"]'

/** The WeChat entry's ball; the two entries share one row. */
const WECHAT_BALL_SELECTOR = '.dshwx-ball'

/** The horizontal row that holds the WeChat ball and ours side by side. */
const ROW_CLASS = 'dsh-zhihu-row'
const ROW_SELECTOR = '.' + ROW_CLASS

/** Debounce for the placement observer (ms). */
const PLACEMENT_DEBOUNCE_MS = 250

/** The entry's styling (panel internals use inline styles). */
const CSS = [
  '#dsh-zhihu-floating-entry .dsh-zhihu-ball{position:fixed;right:24px;bottom:24px;width:52px;height:52px;',
  'border-radius:50%;border:none;outline:none;cursor:pointer;z-index:2147483000;',
  'background:' + ACCENT + ';color:#fff;font-size:19px;font-weight:600;line-height:1;',
  'display:flex;align-items:center;justify-content:center;',
  'box-shadow:0 6px 20px rgba(5,109,232,.35);transition:transform .15s}',
  '#dsh-zhihu-floating-entry .dsh-zhihu-ball:hover{transform:scale(1.06)}',
  // The shared row keeps the two entries side by side inside the (vertical)
  // settings area, instead of stacking them.
  '.' + ROW_CLASS + '{display:flex;align-items:center;justify-content:flex-start}',
  // Inline placement: a plain 36px flex item sitting next to the WeChat ball.
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + '{display:flex;align-items:center;flex:none}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dsh-zhihu-ball{position:static;width:36px;height:36px;',
  'margin:0 0 0 8px;flex:none;box-shadow:none;font-size:15px;display:inline-flex;vertical-align:middle}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dsh-zhihu-ball:hover{transform:scale(1.08)}',
  '#dsh-zhihu-floating-entry .dsh-zhihu-pop{position:fixed;right:24px;bottom:88px;z-index:2147483001;',
  'border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.22);overflow:hidden;color:inherit}',
  // Popover anchored to the left when the entry lives in the left sidebar.
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dsh-zhihu-pop{right:auto;left:24px;bottom:92px}',
].join('')

/** Inject the stylesheet once. */
function injectStyles(): void {
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-zhihu'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * Sample the shell's surface colour so the popover matches the active theme.
 * Falls back to a dark/light guess when nothing is painted.
 */
function surfaceColor(): string {
  const isOpaque = (value: string): boolean =>
    value !== '' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)'
  const body = getComputedStyle(document.body).backgroundColor
  if (isOpaque(body)) return body
  const html = getComputedStyle(document.documentElement).backgroundColor
  if (isOpaque(html)) return html
  const root = document.documentElement
  const prefersDark =
    root.classList.contains('dark') ||
    root.dataset.theme === 'dark' ||
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  return prefersDark ? '#1c1c1e' : '#ffffff'
}

/** The entry button plus its popover. */
function FloatingEntry() {
  const [open, setOpen] = useState(false)
  return createElement(
    'div',
    null,
    open
      ? createElement(
          'div',
          { className: 'dsh-zhihu-pop', style: { background: surfaceColor() } },
          createElement(ZhihuPanel, { variant: 'floating', onClose: () => setOpen(false) }),
        )
      : null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-zhihu-ball',
        title: open ? '收起知乎面板' : '打开知乎面板',
        'aria-label': '打开知乎面板',
        onClick: () => setOpen((value) => !value),
      },
      '知',
    ),
  )
}

/** Live React root and placement observer, so a remount replaces rather than stacks. */
let root: Root | null = null
let observer: MutationObserver | null = null
let scheduled = false

/**
 * Place the container: inline in the sidebar settings area when it exists
 * (immediately after the WeChat ball when present), else fixed bottom-right.
 *
 * Idempotent — it mutates only when the current position is wrong, so the
 * placement observer settles instead of looping.
 * @param container - the entry container.
 */
function place(container: HTMLElement): void {
  const area = document.querySelector<HTMLElement>(SETTINGS_AREA_SELECTOR)
  if (area === null) {
    container.classList.remove(INLINE_CLASS)
    if (container.parentNode !== document.body) document.body.appendChild(container)
    return
  }
  container.classList.add(INLINE_CLASS)

  const wechatBall = area.querySelector<HTMLElement>(WECHAT_BALL_SELECTOR)
  if (wechatBall === null) {
    // No sibling entry to pair with: sit directly in the settings area.
    if (container.parentNode !== area) area.appendChild(container)
    return
  }

  // The settings area is a vertical container, so the two balls must share one
  // horizontal row or they stack. The row takes the WeChat ball's slot so the
  // pair stays where it already was.
  let row = area.querySelector<HTMLElement>(ROW_SELECTOR)
  if (row === null) {
    row = document.createElement('div')
    row.className = ROW_CLASS
    if (wechatBall.parentNode === area) area.insertBefore(row, wechatBall)
    else area.appendChild(row)
  } else if (row.parentNode !== area) {
    area.appendChild(row)
  }

  if (wechatBall.parentNode !== row) row.appendChild(wechatBall)
  if (container.parentNode !== row) row.appendChild(container)
  // Deterministic left-to-right order, independent of mount order.
  if (container.previousSibling !== wechatBall) row.insertBefore(container, wechatBall.nextSibling)
}

/** Debounced re-placement (the sidebar re-renders often). */
function schedulePlacement(container: HTMLElement): void {
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    place(container)
  }, PLACEMENT_DEBOUNCE_MS)
}

/** Tear down a previous mount (hot reload / repeated apply). */
function teardown(): void {
  observer?.disconnect()
  observer = null
  // Unwind the shared row: give the WeChat ball back to the settings area and
  // drop the wrapper, so a hot reload leaves no orphan row behind.
  const area = document.querySelector<HTMLElement>(SETTINGS_AREA_SELECTOR)
  const row = document.querySelector<HTMLElement>(ROW_SELECTOR)
  if (row !== null) {
    const wechatBall = row.querySelector<HTMLElement>(WECHAT_BALL_SELECTOR)
    if (wechatBall !== null && area !== null) area.appendChild(wechatBall)
    if (row.parentNode !== null) row.parentNode.removeChild(row)
  }
  const current = root
  root = null
  if (current !== null) {
    try {
      current.unmount()
    } catch {
      // Already unmounted.
    }
  }
  const node = document.getElementById(CONTAINER_ID)
  if (node !== null && node.parentNode !== null) node.parentNode.removeChild(node)
}

/**
 * Mount the sidebar entry into the page.
 * @returns a disposer that unmounts it (safe to call twice).
 */
export function mountFloatingEntry(): () => void {
  if (typeof document === 'undefined') return () => undefined
  injectStyles()
  teardown()

  const container = document.createElement('div')
  container.id = CONTAINER_ID
  // Start on body so React has a stable host, then place it.
  document.body.appendChild(container)
  root = createRoot(container)
  root.render(createElement(FloatingEntry))
  place(container)

  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => schedulePlacement(container))
    observer.observe(document.body, { childList: true, subtree: true })
  }

  return () => {
    teardown()
  }
}
