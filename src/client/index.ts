/**
 * dsh-zhihu — browser half.
 *
 * Two visible entries, both fed by the same panel component:
 *   1. `settings.section` 「知乎」card in the web settings page.
 *   2. A bottom-right floating ball (see ./floating.tsx) reachable from any
 *      page, matching the WeChat bridge's entry style.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external plugin
 * must not take the GUI down.
 */
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry) and the client runtime Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mountFloatingEntry } from './floating.tsx'
import { ZhihuPanel } from './ZhihuPanel.tsx'

/** Required services. */
export const inject = ['slots']

/**
 * Register the settings card and mount the floating entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'zhihu',
      order: 336,
      label: () => '知乎',
    }, ZhihuPanel))
  } catch (error) {
    console.warn('[dsh-zhihu] settings panel registration failed:', error)
  }
  try {
    mountFloatingEntry()
  } catch (error) {
    console.warn('[dsh-zhihu] floating entry mount failed:', error)
  }
}
