/**
 * dsh-zhihu panel — the visible entry for the Zhihu CLI plugin.
 *
 * Rendered in two places from one component: as a settings-page section
 * (`settings.section` slot, variant="settings") and inside the floating panel
 * opened from the bottom-right ball (variant="floating"). It shows login state,
 * drives QR-code login with the code rendered inline, exposes the read-only
 * switch, and offers quick hot-list / search lookups.
 *
 * Plain React, inline styles only, theme-agnostic (colors are inherited where
 * possible so light/dark both work), no emoji.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ZhihuApi, type ZhihuItem, type ZhihuProfile, type ZhihuStatus, type ZhihuToolResult } from './api.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new ZhihuApi()

/** Zhihu brand blue — used only for identity and primary actions. */
const ACCENT = '#056DE8'

/**
 * Zhihu QR codes are short-lived (~2 minutes). The panel stops waiting once
 * this elapses, so the user is told to fetch a fresh code instead of staring at
 * an expired one. The host's `loginAlive` flag short-circuits this when present.
 */
const QR_EXPIRY_MS = 150_000

/** One shared style sheet (tiny and theme-agnostic). */
const s: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxWidth: '640px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
    boxSizing: 'border-box',
  },
  floatCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    width: '380px',
    maxHeight: '72vh',
    overflowY: 'auto',
    padding: '14px 16px',
    borderRadius: '12px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
    boxSizing: 'border-box',
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none', background: '#c9cdd4' },
  title: { fontWeight: 600, fontSize: '13px', margin: 0, flex: 1 },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingTop: '10px',
    borderTop: '1px solid rgba(128,128,128,0.22)',
  },
  sectionTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.9, margin: 0 },
  row: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: '12px', opacity: 0.85, minWidth: '92px' },
  input: {
    flex: 1,
    minWidth: '120px',
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  },
  select: {
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  },
  button: {
    padding: '5px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(128,128,128,0.14)',
    color: 'inherit',
    fontSize: '12px',
  },
  buttonPrimary: {
    padding: '5px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid ' + ACCENT,
    background: ACCENT,
    color: '#fff',
    fontSize: '12px',
  },
  buttonDisabled: { opacity: 0.5, cursor: 'default' },
  text: { fontSize: '12px', opacity: 0.88, lineHeight: 1.65, wordBreak: 'break-word' },
  muted: { fontSize: '11px', opacity: 0.65, wordBreak: 'break-all' },
  warn: { fontSize: '12px', color: '#c9763a', lineHeight: 1.6 },
  error: { fontSize: '12px', color: '#d0433b', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  qr: {
    width: '184px',
    height: '184px',
    borderRadius: '8px',
    border: '1px solid rgba(128,128,128,0.3)',
    background: '#fff',
    alignSelf: 'center',
  },
  qrWrap: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center', padding: '4px 0' },
  list: { display: 'flex', flexDirection: 'column', gap: '6px' },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '6px 8px',
    borderRadius: '6px',
    background: 'rgba(128,128,128,0.08)',
  },
  itemTitle: { fontSize: '12px', color: 'inherit', textDecoration: 'none', fontWeight: 500 },
  itemMeta: { fontSize: '11px', opacity: 0.65 },
  checkRow: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' },
  footer: { fontSize: '11px', opacity: 0.6, display: 'flex', gap: '8px', alignItems: 'center' },
  pre: {
    margin: 0,
    padding: '8px 10px',
    borderRadius: '6px',
    background: 'rgba(128,128,128,0.10)',
    fontSize: '11px',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '260px',
    overflowY: 'auto',
    fontFamily: 'inherit',
  },
}

/** Counts rendered the Chinese way (1.2万 / 3.4亿). */
function fmtCount(value: number): string {
  if (value >= 100_000_000) return (value / 100_000_000).toFixed(1) + '亿'
  if (value >= 10_000) return (value / 10_000).toFixed(1) + '万'
  return String(value)
}

/** One-line login summary from the status payload. */
function loginText(status: ZhihuStatus | null): string {
  if (status === null) return '加载中…'
  if (!status.cliAvailable) return '未找到知乎 CLI —— 请先安装 pyzhihu-cli'
  if (status.authenticated) return '已登录'
  if (status.cookiePresent) return 'Cookie 不完整（缺少 ' + status.missingCookies.join('、') + '）'
  return '未登录'
}

/** Dot color for the header status indicator. */
function dotColor(status: ZhihuStatus | null): string {
  if (status === null) return '#c9cdd4'
  if (status.authenticated) return '#2ea44f'
  if (!status.cliAvailable) return '#d0433b'
  return '#c9763a'
}

/** Props: the panel adapts its chrome to where it is mounted. */
export interface ZhihuPanelProps {
  /** 'settings' renders a settings-page card; 'floating' fills the popover. */
  variant?: 'settings' | 'floating'
  /** Called by the floating variant's close button. */
  onClose?: () => void
}

/** The panel component. */
export function ZhihuPanel({ variant = 'settings', onClose }: ZhihuPanelProps) {
  const [status, setStatus] = useState<ZhihuStatus | null>(null)
  const [profile, setProfile] = useState<ZhihuProfile | null>(null)
  const [qrcode, setQrcode] = useState('')
  const [waiting, setWaiting] = useState(false)
  /** Bumped on every login start so the polling effect restarts its clock. */
  const [waitNonce, setWaitNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [hot, setHot] = useState<ZhihuItem[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ZhihuItem[]>([])
  const [lookupKind, setLookupKind] = useState<'question' | 'answer' | 'user' | 'topic'>('question')
  const [lookupId, setLookupId] = useState('')
  const [result, setResult] = useState<ZhihuToolResult | null>(null)
  const [proxyDraft, setProxyDraft] = useState('')
  const [timeoutDraft, setTimeoutDraft] = useState('')

  /** Set once so the initial load only runs on mount. */
  const bootstrapped = useRef(false)

  const loadStatus = useCallback(async (): Promise<ZhihuStatus | null> => {
    try {
      const next = await api.status()
      setStatus(next)
      setProxyDraft((current) => (current === '' ? next.proxy : current))
      setTimeoutDraft((current) => (current === '' ? String(next.timeoutMs) : current))
      return next
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [])

  const loadProfile = useCallback(async (): Promise<void> => {
    try {
      const result = await api.whoami()
      setProfile(result.ok ? result.profile : null)
    } catch {
      setProfile(null)
    }
  }, [])

  const loadHot = useCallback(async (): Promise<void> => {
    try {
      const result = await api.hot(10)
      if (result.ok) setHot(result.items)
      else setError(result.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // Initial load.
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void (async () => {
      const next = await loadStatus()
      if (next?.authenticated === true) {
        await loadProfile()
        await loadHot()
      }
    })()
  }, [loadStatus, loadProfile, loadHot])

  // While waiting for a scan: poll the QR image and the login state.
  useEffect(() => {
    if (!waiting) return undefined
    const startedAt = Date.now()
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (cancelled) return
      try {
        const qr = await api.qrcode()
        if (!cancelled && qr.qrcode && qr.dataUrl !== '') setQrcode(qr.dataUrl)
      } catch {
        // The QR is not ready yet; the next tick retries.
      }
      const next = await loadStatus()
      if (cancelled) return
      if (next?.authenticated === true) {
        setWaiting(false)
        setQrcode('')
        setMessage('登录成功')
        await loadProfile()
        await loadHot()
        return
      }
      if (next === null) return
      // Stop waiting when the login process is gone, or when the code has
      // certainly expired — otherwise the panel shows a dead QR forever.
      const processGone = next.loginAlive === false
      const timedOut = Date.now() - startedAt > QR_EXPIRY_MS
      if (processGone || timedOut) {
        setWaiting(false)
        setQrcode('')
        setMessage(
          processGone
            ? '二维码登录进程已退出（未完成扫码），请重新获取二维码'
            : '二维码已过期（约 2 分钟有效），请重新获取二维码',
        )
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [waiting, waitNonce, loadStatus, loadProfile, loadHot])

  /** Start the QR flow and begin polling. */
  const startLogin = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    setQrcode('')
    try {
      const result = await api.startLogin()
      if (!result.ok && result.error !== '') {
        setError(result.error)
        return
      }
      setWaiting(true)
      setWaitNonce((value) => value + 1)
      setMessage('正在获取二维码…请用知乎 App 扫码（约 2 分钟内有效）')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  /** Lift the session the local Chrome already has. */
  const importFromBrowser = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('正在从 Chrome 读取知乎登录态…')
    try {
      const result = await api.browserLogin()
      if (!result.ok) {
        setMessage('')
        setError(result.error)
        return
      }
      setWaiting(false)
      setQrcode('')
      setMessage('已从 Chrome（' + result.profile + '）导入 ' + result.cookieCount + ' 个 Cookie，登录成功')
      await loadStatus()
      await loadProfile()
      await loadHot()
    } catch (cause) {
      setMessage('')
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [loadStatus, loadProfile, loadHot])

  /** Delete the saved session. */
  const logout = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.logout()
      setProfile(null)
      setHot([])
      setResults([])
      setQrcode('')
      setWaiting(false)
      setMessage('已退出登录')
      await loadStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [loadStatus])

  /** Flip the read-only switch. */
  const toggleReadOnly = useCallback(async (next: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.setConfig({ readOnly: next })
      setMessage(next ? '已切回只读：写工具不再注册' : '已放开写操作：发布/赞同/关注/删除工具已注册')
      await loadStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [loadStatus])

  /** Persist proxy / timeout edits. */
  const saveAdvanced = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const patch: { proxy?: string; timeoutMs?: number } = { proxy: proxyDraft.trim() }
      const parsed = Number(timeoutDraft)
      if (Number.isFinite(parsed) && parsed > 0) patch.timeoutMs = Math.floor(parsed)
      await api.setConfig(patch)
      setMessage('已保存高级设置')
      await loadStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [proxyDraft, timeoutDraft, loadStatus])

  /** Run a search and list the results. */
  const runSearch = useCallback(async (): Promise<void> => {
    const trimmed = query.trim()
    if (trimmed === '') return
    setBusy(true)
    setError('')
    try {
      const result = await api.search(trimmed, 5)
      if (result.ok) setResults(result.items)
      else setError(result.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [query])

  /** Run one of the id-based lookups (问题 / 回答 / 用户 / 话题). */
  const runLookup = useCallback(async (): Promise<void> => {
    const id = lookupId.trim()
    if (id === '') return
    setBusy(true)
    setError('')
    try {
      const next =
        lookupKind === 'question'
          ? await api.question({ id, answers: true, limit: 5 })
          : lookupKind === 'answer'
            ? await api.answer({ id, comments: true, limit: 10 })
            : lookupKind === 'user'
              ? await api.user({ token: id, include: 'profile' })
              : await api.topic({ id, hot: true })
      setResult(next)
      if (next.ok !== true) setError(next.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [lookupKind, lookupId])

  /** Run one of the list-shaped lookups (推荐流 / 通知 / 收藏夹). */
  const runQuick = useCallback(
    async (kind: 'feed' | 'notifications' | 'collections'): Promise<void> => {
      setBusy(true)
      setError('')
      try {
        const next =
          kind === 'feed'
            ? await api.feed({ limit: 10 })
            : kind === 'notifications'
              ? await api.notifications({ limit: 10 })
              : await api.collections(10)
        setResult(next)
        if (next.ok !== true) setError(next.message)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const cardStyle = variant === 'floating' ? { ...s.card, ...s.floatCard } : s.card
  const disabled = busy || status?.cliAvailable === false

  /**
   * Render one tool result. Items win over the plain-text summary when both are
   * present (showing both would just repeat the same information).
   */
  const renderResult = (res: ZhihuToolResult | null): React.ReactNode => {
    if (res === null) return null
    const primary: ZhihuItem[] = [res.question, res.answer, res.topic].filter(
      (item): item is ZhihuItem => item !== undefined && item.title !== '',
    )
    const all = [...primary, ...(Array.isArray(res.items) ? res.items : [])]
    const profile = res.profile !== undefined && res.profile.name !== '' ? res.profile : null
    return (
      <div style={s.section}>
        {profile !== null ? (
          <div style={s.text}>
            {[profile.name, profile.urlToken !== '' ? '@' + profile.urlToken : '', profile.headline]
              .filter((bit) => bit !== '')
              .join(' · ')}
          </div>
        ) : null}
        {all.length > 0 ? renderItems(all) : null}
        {all.length === 0 && profile === null && res.message !== '' ? <div style={s.text}>{res.message}</div> : null}
        {res.text !== undefined && res.text !== '' ? <pre style={s.pre}>{res.text.slice(0, 4000)}</pre> : null}
      </div>
    )
  }

  /** Render a list of normalized items. */
  const renderItems = (items: ZhihuItem[]): React.ReactNode => (
    <div style={s.list}>
      {items.map((item, index) => (
        <div key={(item.id || String(index)) + '-' + String(index)} style={s.item}>
          {item.url !== '' ? (
            <a style={s.itemTitle} href={item.url} target="_blank" rel="noreferrer noopener">
              {item.title !== '' ? item.title : item.excerpt}
            </a>
          ) : (
            <span style={s.itemTitle}>{item.title !== '' ? item.title : item.excerpt}</span>
          )}
          <span style={s.itemMeta}>
            {[
              item.author !== '' ? item.author : '',
              item.voteupCount > 0 ? '赞同 ' + fmtCount(item.voteupCount) : '',
              item.answerCount > 0 ? '回答 ' + fmtCount(item.answerCount) : '',
              item.commentCount > 0 ? '评论 ' + fmtCount(item.commentCount) : '',
            ]
              .filter((bit) => bit !== '')
              .join(' · ')}
          </span>
        </div>
      ))}
    </div>
  )

  return (
    <div style={cardStyle}>
      <div style={s.head}>
        <span style={{ ...s.dot, background: dotColor(status) }} />
        <h3 style={s.title}>知乎</h3>
        {variant === 'floating' && onClose !== undefined ? (
          <button type="button" style={s.button} onClick={onClose}>
            收起
          </button>
        ) : null}
      </div>

      <div style={s.text}>
        {loginText(status)}
        {status !== null && status.authenticated && status.savedAt !== '' ? (
          <span style={s.muted}>（Cookie 更新于 {status.savedAt.slice(0, 19).replace('T', ' ')}）</span>
        ) : null}
      </div>

      {status !== null && !status.cliAvailable ? (
        <div style={s.warn}>
          未找到知乎 CLI（当前命令：{status.cliPath !== '' ? status.cliPath : 'zhihu'}）。
          <br />
          安装：uv tool install pyzhihu-cli —— 装好后重开本面板。
        </div>
      ) : null}

      {status !== null && status.cliAvailable && !status.authenticated ? (
        <div style={s.section}>
          <h4 style={s.sectionTitle}>登录</h4>
          {status.cookiePresent ? <div style={s.warn}>已有 Cookie 文件但缺少：{status.missingCookies.join('、')}</div> : null}
          <div style={s.row}>
            <button
              type="button"
              style={busy ? { ...s.buttonPrimary, ...s.buttonDisabled } : s.buttonPrimary}
              disabled={disabled}
              onClick={() => void importFromBrowser()}
            >
              从 Chrome 导入登录态
            </button>
          </div>
          <div style={s.muted}>
            读取本机 Chrome 里已登录的知乎会话（用钥匙串密钥解密，只写入插件自己的 Cookie 文件，不外传）。首次可能弹一次钥匙串授权，点「允许」即可。
          </div>
          <div style={s.row}>
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={disabled} onClick={() => void startLogin()}>
              {waiting ? '重新获取二维码' : '改用二维码登录'}
            </button>
          </div>
          <div style={s.warn}>
            二维码登录常失败：知乎对未登录的轮询请求有风控（403 / code 40352），CLI 会静默重试到超时，看起来就像「扫了没反应」。优先用上面的浏览器导入。
          </div>
          {waiting && qrcode !== '' ? (
            <div style={s.qrWrap}>
              <img src={qrcode} alt="知乎登录二维码" style={s.qr} />
              <div style={s.muted}>用知乎 App「扫一扫」，扫码后手机上确认登录</div>
            </div>
          ) : null}
          {waiting && qrcode === '' ? <div style={s.muted}>二维码生成中…</div> : null}
          <div style={s.muted}>
            说明：知乎 CLI 的所有命令都需要先登录（未登录连热榜都会失败）。
          </div>
        </div>
      ) : null}

      {status !== null && status.authenticated ? (
        <div style={s.section}>
          <h4 style={s.sectionTitle}>账号</h4>
          <div style={s.text}>
            {profile !== null && (profile.name !== '' || profile.urlToken !== '')
              ? [
                  profile.name,
                  profile.urlToken !== '' ? '@' + profile.urlToken : '',
                  profile.headline,
                  profile.answerCount > 0 ? '回答 ' + fmtCount(profile.answerCount) : '',
                  profile.followerCount > 0 ? '关注者 ' + fmtCount(profile.followerCount) : '',
                ]
                  .filter((bit) => bit !== '')
                  .join(' · ')
              : '已登录（读取账号资料中…）'}
          </div>
          <div style={s.row}>
            <button
              type="button"
              style={busy ? { ...s.buttonPrimary, ...s.buttonDisabled } : s.buttonPrimary}
              disabled={busy}
              onClick={() => void importFromBrowser()}
            >
              刷新登录态（从 Chrome）
            </button>
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={busy} onClick={() => void loadProfile()}>
              刷新资料
            </button>
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={busy} onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </div>
      ) : null}

      {status !== null && status.cliAvailable ? (
        <div style={s.section}>
          <h4 style={s.sectionTitle}>能力</h4>
          <label style={s.checkRow}>
            <input
              type="checkbox"
              checked={status.readOnly}
              disabled={busy}
              onChange={(event) => void toggleReadOnly(event.target.checked)}
            />
            <span>
              只读模式（默认开启）
              <span style={s.muted}> —— 关闭后才会注册发布 / 赞同 / 关注 / 删除工具</span>
            </span>
          </label>
          <div style={s.row}>
            <span style={s.label}>代理</span>
            <select
              style={s.select}
              value={status.proxyMode === 'off' ? 'none' : status.proxyMode === 'custom' ? 'custom' : 'inherit'}
              onChange={(event) => {
                const next = event.target.value
                if (next === 'inherit') setProxyDraft('')
                else if (next === 'none') setProxyDraft('none')
                else if (proxyDraft === '' || proxyDraft === 'none') setProxyDraft('http://127.0.0.1:7897')
              }}
            >
              <option value="inherit">继承环境变量</option>
              <option value="none">不走代理</option>
              <option value="custom">自定义</option>
            </select>
            <input
              style={s.input}
              placeholder="http://host:port 或 none"
              value={proxyDraft}
              onChange={(event) => setProxyDraft(event.target.value)}
            />
          </div>
          <div style={s.row}>
            <span style={s.label}>超时(ms)</span>
            <input style={s.input} value={timeoutDraft} onChange={(event) => setTimeoutDraft(event.target.value)} />
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={busy} onClick={() => void saveAdvanced()}>
              保存
            </button>
          </div>
          <div style={s.muted}>配置：{status.configPath}</div>
        </div>
      ) : null}

      {status !== null && status.cliAvailable && status.authenticated ? (
        <div style={s.section}>
          <h4 style={s.sectionTitle}>热榜</h4>
          <div style={s.row}>
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={busy} onClick={() => void loadHot()}>
              刷新热榜
            </button>
          </div>
          {hot.length > 0 ? renderItems(hot) : <div style={s.muted}>暂无数据</div>}
        </div>
      ) : null}

      {status !== null && status.cliAvailable && status.authenticated ? (
        <div style={s.section}>
          <h4 style={s.sectionTitle}>更多能力</h4>
          <div style={s.row}>
            <select
              style={s.select}
              value={lookupKind}
              onChange={(event) => setLookupKind(event.target.value as 'question' | 'answer' | 'user' | 'topic')}
            >
              <option value="question">问题</option>
              <option value="answer">回答</option>
              <option value="user">用户</option>
              <option value="topic">话题</option>
            </select>
            <input
              style={s.input}
              placeholder={
                lookupKind === 'user'
                  ? 'url_token（如 zheng-jun-yao-55）'
                  : lookupKind === 'question'
                    ? '问题 id'
                    : lookupKind === 'answer'
                      ? '回答 id'
                      : '话题 id'
              }
              value={lookupId}
              onChange={(event) => setLookupId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runLookup()
              }}
            />
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={busy} onClick={() => void runLookup()}>
              查询
            </button>
          </div>
          <div style={s.row}>
            {(
              [
                ['feed', '推荐流'],
                ['notifications', '通知'],
                ['collections', '收藏夹'],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                style={busy ? { ...s.button, ...s.buttonDisabled } : s.button}
                disabled={busy}
                onClick={() => void runQuick(kind)}
              >
                {label}
              </button>
            ))}
          </div>
          {renderResult(result)}
        </div>
      ) : null}

      {status !== null && status.cliAvailable && status.authenticated ? (
        <div style={s.section}>
          <h4 style={s.sectionTitle}>搜索</h4>
          <div style={s.row}>
            <input
              style={s.input}
              placeholder="搜索知乎内容"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch()
              }}
            />
            <button type="button" style={busy ? { ...s.button, ...s.buttonDisabled } : s.button} disabled={busy} onClick={() => void runSearch()}>
              搜索
            </button>
          </div>
          {results.length > 0 ? renderItems(results) : null}
        </div>
      ) : null}

      {message !== '' ? <div style={s.text}>{message}</div> : null}
      {error !== '' ? <div style={s.error}>{error}</div> : null}

      <div style={s.footer}>
        <span>
          {status?.cliVersion !== undefined && status.cliVersion !== '' ? status.cliVersion : 'zhihu CLI'}
          {status?.readOnly === true ? ' · 只读' : status?.readOnly === false ? ' · 读写' : ''}
        </span>
      </div>
    </div>
  )
}
