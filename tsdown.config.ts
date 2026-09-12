/**
 * dsh-zhihu build config: node-half lib bundle plus the browser client bundle
 * (lib/client.js — the closure-factory artifact for the GUI's
 * __ModuleLoader__, served at /plugins/dsh-zhihu/client.js).
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('@zhengjy01/dsh-zhihu', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
  ],
})
