/**
 * Sidebar entry for dsh-zhihu.
 *
 * The entry mounts into the left sidebar's settings area
 * (`[class*="settingsArea"]`), which the shell renders as a VERTICAL block: an
 * entry appended straight to it takes a whole row of its own, so the sidebar
 * ends up with one full-width row per plugin.
 *
 * Every sidebar entry therefore shares ONE horizontal row
 * (`.dsh-sidebar-row`, `display:flex`) inside that area. The row is created by
 * whichever entry mounts first and adopted by the rest — it must not be keyed
 * on another plugin's DOM (the WeChat ball it originally waited for is not
 * installed in every profile, which left every entry stacked).
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

/** The settings area this entry mounts into. */
const SETTINGS_AREA_SELECTOR = '[class*="settingsArea"]'

/** The shared footer row every sidebar entry converges on. */
const ROW_CLASS = 'dsh-sidebar-row'

/** Any row a sibling plugin may have made — legacy names included, so a partial upgrade still merges. */
const ROW_SELECTORS = ['.' + ROW_CLASS, '.dsh-zhihu-row', '.dshupd-row', '.dshrst-row']

/** The entries that belong in that row, in the order they should read. */
const ROW_ENTRIES: ReadonlyArray<{ selector: string; order: number }> = [
  { selector: '.dshwx-ball', order: 10 },
  { selector: '#dsh-zhihu-floating-entry', order: 20 },
  { selector: '#dsh-updater-entry', order: 30 },
  { selector: '#dsh-restart-entry', order: 40 },
]

/** This entry's place in the row (fixed, so mount order never reshuffles it). */
const ROW_ORDER = 20

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
  // The shared row keeps every sidebar entry side by side inside the (vertical)
  // settings area, instead of stacking them; it wraps only when it must.
  '.' + ROW_CLASS + '{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;',
  'gap:2px;flex:1 1 auto;min-width:0;box-sizing:border-box}',
  // Inline placement: a plain 36px flex item sitting in that row.
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + '{display:flex;align-items:center;flex:none}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dsh-zhihu-ball{position:static;width:36px;height:36px;',
  'margin:0;flex:none;box-shadow:none;font-size:15px;display:inline-flex;vertical-align:middle}',
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

/** Find the shared row, whichever plugin made it. */
function findRow(area: Element): HTMLElement | null {
  for (const selector of ROW_SELECTORS) {
    const row = area.querySelector<HTMLElement>(selector)
    if (row !== null) return row
  }
  return null
}

/**
 * Put `container` into the shared footer row, creating the row when none exists.
 *
 * The shell's settings area is a vertical block, so an entry appended straight
 * to it takes a whole row of its own. The row is what makes the entries read as
 * one horizontal line, and creating it must not depend on any other plugin: the
 * WeChat bridge is not installed in every profile, and keying creation on its
 * ball is what used to leave every entry stacked.
 *
 * Idempotent — it mutates only while something is out of place, so the
 * placement observer settles instead of looping.
 * @param container - this plugin's entry container.
 * @param area - the sidebar's settings area.
 */
function joinRow(container: HTMLElement, area: HTMLElement): void {
  let row = findRow(area)
  if (row === null) {
    row = document.createElement('div')
    row.className = ROW_CLASS
    row.dataset.plugin = 'dsh-sidebar-row'
  } else {
    // Normalise a row another plugin (or an older build) created, so the shared
    // flex styling applies to it as well.
    row.classList.add(ROW_CLASS)
  }
  // Fold duplicate rows into this one (two plugins can mount in the same tick),
  // then adopt every known entry still parked in the vertical settings area.
  for (const selector of ROW_SELECTORS) {
    for (const other of Array.from(area.querySelectorAll<HTMLElement>(selector))) {
      if (other === row) continue
      for (const child of Array.from(other.children)) row.appendChild(child)
      other.remove()
    }
  }
  for (const entry of ROW_ENTRIES) {
    for (const node of Array.from(area.querySelectorAll<HTMLElement>(entry.selector))) {
      if (node.parentElement !== row) row.appendChild(node)
      // Fixed order, so mount order and observer ticks never reshuffle the row.
      node.style.order = String(entry.order)
    }
  }
  if (container.parentElement !== row) row.appendChild(container)
  container.style.order = String(ROW_ORDER)
  // The row reads below the settings button, and has to be mounted.
  if (row.parentElement !== area || area.lastElementChild !== row) area.appendChild(row)
}

/**
 * Place the container: inline in the sidebar's shared footer row when the
 * settings area exists, else fixed at the bottom-right corner.
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
  joinRow(container, area)
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
  // The row is shared, so it is dropped only when nothing else is using it.
  for (const selector of ROW_SELECTORS) {
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (row.childElementCount === 0) row.remove()
    }
  }
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
