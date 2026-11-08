/**
 * Hot restart — Client half.
 *
 * Renders one round green button in the composer tool row, immediately before the
 * submit action. A click asks the Host half to reconcile the profile, which
 * reloads plugins whose files changed on disk without restarting the process.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-hot-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/hot-restart/run'
    const CLIENT_ERROR_ROUTE = '/hot-restart/client-error'
    const IDLE_HINT = '热重启：重新应用配置并热重载改动过的插件'
    const SETTLE_MS = 2200
    const ERROR_MS = 4200

    // Only failures reach the Host log: a working button writes nothing.
    // Identical messages are reported once per page, so a crash loop cannot flood it.
    const reported = new Set()
    function reportClientError(message) {
      try {
        const text = String(message).slice(0, 500)
        if (reported.has(text)) return
        reported.add(text)
        if (reported.size > 50) reported.clear()
        fetch(CLIENT_ERROR_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // reporting must never break the composer
      }
    }

    const STYLE = `
.dsh-hot-restart {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-state-success-primary);
  color: #fff;
  cursor: pointer;
  transition: filter 140ms ease, transform 90ms ease, background 140ms ease;
}
.dsh-hot-restart:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-hot-restart:active:not(:disabled) { transform: scale(0.94); }
.dsh-hot-restart:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-hot-restart:disabled { cursor: progress; }
.dsh-hot-restart[data-state='running'] svg { animation: dsh-hot-restart-spin 900ms linear infinite; }
.dsh-hot-restart[data-state='error'] { background: var(--dsw-alias-state-error-primary); }
.dsh-hot-restart[data-state='warn'] { background: var(--dsw-alias-state-warn-primary); }
.dsh-hot-restart-crashed { background: var(--dsw-alias-state-idle-primary); cursor: default; }
@keyframes dsh-hot-restart-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-hot-restart[data-state='running'] svg { animation: none; }
}
`

    const refreshGlyph = h('svg', {
      viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': true,
      fill: 'none', stroke: 'currentColor', strokeWidth: 2.2,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
      h('path', { d: 'M20 4v5h-5' }),
    )

    const checkGlyph = h('svg', {
      viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': true,
      fill: 'none', stroke: 'currentColor', strokeWidth: 2.6,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }, h('path', { d: 'M4.5 12.5 9.5 17.5 19.5 6.5' }))

    const errorGlyph = h('svg', {
      viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': true,
      fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round',
    },
      h('path', { d: 'M12 5.5v9' }),
      h('circle', { cx: 12, cy: 18.4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    )

    function HotRestartButton() {
      const [state, setState] = React.useState('idle')
      const [hint, setHint] = React.useState(IDLE_HINT)
      const timer = React.useRef(0)

      React.useEffect(() => () => clearTimeout(timer.current), [])

      const settle = (next, message, delay) => {
        setState(next)
        setHint(message)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          setState('idle')
          setHint(IDLE_HINT)
        }, delay)
      }

      const run = async () => {
        if (state === 'running') return
        setState('running')
        setHint('正在热重启…')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          const result = await response.json()
          if (!response.ok || result === null || typeof result.message !== 'string') {
            throw new Error(`HTTP ${response.status}`)
          }
          if (result.status === 'failed' || result.status === 'unavailable') {
            settle('error', result.message, ERROR_MS)
            return
          }
          if (result.status === 'restart_required') {
            settle('warn', result.message, ERROR_MS)
            return
          }
          settle('done', result.message, SETTLE_MS)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          reportClientError(`request ${detail}`)
          settle('error', `热重启请求失败：${detail}`, ERROR_MS)
        }
      }

      const glyph = state === 'done' ? checkGlyph : state === 'error' || state === 'warn' ? errorGlyph : refreshGlyph

      return h(React.Fragment, null,
        h('style', null, STYLE),
        h('button', {
          type: 'button',
          className: 'dsh-hot-restart',
          'data-state': state,
          title: hint,
          'aria-label': '热重启',
          'aria-busy': state === 'running',
          disabled: state === 'running',
          onClick: run,
        }, glyph),
      )
    }

    /**
     * Keeps a render crash from blanking the slot entry silently: the failure is
     * reported to the Host log and a muted glyph stays in place.
     */
    class ButtonBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { crashed: false }
      }

      static getDerivedStateFromError() {
        return { crashed: true }
      }

      componentDidCatch(error) {
        const name = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error'
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
        reportClientError(`render ${name}: ${message}`)
      }

      render() {
        if (!this.state.crashed) return this.props.children
        return h('span', {
          className: 'dsh-hot-restart dsh-hot-restart-crashed',
          title: '热重启按钮出错，已记录日志',
          'aria-label': '热重启按钮出错',
        }, errorGlyph)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'hot-restart',
          order: 20,
        }, () => h(ButtonBoundary, null, h(HotRestartButton))))
      },
    }
  },
})
