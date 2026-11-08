/**
 * Hot restart — Host half only.
 *
 * `ctx.hmr.reconcileProfile()` is the Harness' own reload path: it recomposes the
 * profile from its manifest and patch files, replaces plugins whose loaded files
 * changed on disk, and starts the stopped entries with the current files and
 * configuration. Calling it on demand gives a hot restart of the plugin layer
 * without restarting the process or the desktop window.
 *
 * The same operation is exposed twice: the `/restart` chat command for the user
 * and the `hot_restart` tool for the model. The package imports nothing from the
 * Harness runtime: a linked bundle resolves no runtime packages, so the tool
 * definition below is a plain JSON-Schema definition.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'hot-restart'
export const inject = ['commands', 'tools']

const TOOL_NAME = 'hot_restart'
const COMMAND_NAME = 'restart'
/** Same-origin route the composer button POSTs to. */
const ROUTE_PATH = '/hot-restart/run'
/** Same-origin route the Client half reports a crashed button to. */
const CLIENT_ERROR_PATH = '/hot-restart/client-error'

/** Failure log. Nothing is written on a successful restart. */
const LOG_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs')
const LOG_FILE = join(LOG_DIR, 'hot-restart.log')
const LOG_MAX_BYTES = 256 * 1024
/** Messages already logged this run, so a crash loop does not flood the file. */
const logged = new Set()

/**
 * Remove the machine-specific parts of a failure message: module URLs and
 * absolute paths never reach the log, because users share it when reporting bugs.
 * @param {unknown} value - error text.
 * @returns {string} a path-free, length-bounded line.
 */
function redact(value) {
  return String(value)
    .replace(/file:\/\/\/\S+/gu, '<path>')
    .replace(/[A-Za-z]:[\\/]\S+/gu, '<path>')
    .replace(/\s+/gu, ' ')
    .slice(0, 500)
}

/**
 * Append one failure line. Best-effort: logging never breaks a restart.
 * @param {string} scope - `host` or `client`.
 * @param {string} status - outcome tag.
 * @param {string} message - failure text.
 */
function logFailure(scope, status, message) {
  const line = redact(`${scope} ${status} ${message}`)
  if (logged.has(line)) return
  logged.add(line)
  if (logged.size > 200) logged.clear()
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      // no previous log, or it cannot be rotated: appending is still useful
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // a read-only home must not break the restart
  }
}

/**
 * One hot restart. Never throws: every outcome is data the command and tool can report.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<{ status: 'reloaded' | 'unchanged' | 'restart_required' | 'unavailable' | 'failed', message: string, reloadedPlugins: number, pendingModules: string[], warnings: string[], elapsedMs: number }>}
 */
async function hotRestart(ctx) {
  const startedAt = Date.now()
  const hmr = ctx.get('hmr')
  if (hmr === undefined) {
    const message = '当前 Profile 没有启用 HMR（dsh-hmr），无法热重载插件；请重启应用来应用更改。'
    logFailure('host', 'unavailable', message)
    return {
      status: 'unavailable',
      message,
      reloadedPlugins: 0,
      pendingModules: [],
      warnings: [],
      elapsedMs: 0,
    }
  }

  let reloadedPlugins = 0
  // `hmr/reload` is only emitted by the file-watch path, never by `reconcileProfile`,
  // so the replacements are counted from the Loader entries themselves: a replaced
  // module leaves a new `moduleNamespace` on its entry.
  const loader = ctx.get('loader')
  const snapshot = () => new Map(loader === undefined ? [] : [...loader.entries()].map((entry) => [entry.id, entry.moduleNamespace]))
  const before = snapshot()

  try {
    // `reconcileProfile()` must run inside the HMR queue, which serializes it with
    // file-watch reloads and Plugin Manager configuration writes.
    const reconciliation = await hmr.runExclusive(() => hmr.reconcileProfile())
    const after = snapshot()
    for (const [id, namespace] of after) if (before.get(id) !== namespace) reloadedPlugins += 1
    const pendingModules = Array.isArray(reconciliation?.pending)
      ? reconciliation.pending.map((entry) => (typeof entry?.url === 'string' ? entry.url : String(entry?.url ?? entry)))
      : []
    const warnings = Array.isArray(reconciliation?.warnings) ? reconciliation.warnings.map(String) : []
    const elapsedMs = Date.now() - startedAt
    const report = { reloadedPlugins, pendingModules, warnings, elapsedMs }

    if (reconciliation?.restartReason !== undefined || pendingModules.length > 0) {
      const reason = reconciliation?.restartReason === 'package-moved'
        ? '有插件包被移动了位置'
        : reconciliation?.restartReason === 'module-comparison'
          ? '有模块无法在进程内安全替换'
          : '有模块属于进程级依赖'
      const list = pendingModules.length > 0 ? `：${pendingModules.join('、')}` : ''
      return {
        status: 'restart_required',
        message: `配置已重新应用，但${reason}，需要重启应用才能生效${list}`,
        ...report,
      }
    }
    if (reloadedPlugins > 0) {
      return {
        status: 'reloaded',
        message: `热重启完成：重载了 ${reloadedPlugins} 个插件，用时 ${elapsedMs}ms。界面插件若有更新，请刷新页面。`,
        ...report,
      }
    }
    return {
      status: 'unchanged',
      message: `热重启完成：配置已重新应用，没有检测到文件改动（用时 ${elapsedMs}ms）。`,
      ...report,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logFailure('host', 'failed', detail)
    return {
      status: 'failed',
      message: `热重启失败：${detail}`,
      reloadedPlugins,
      pendingModules: [],
      warnings: [],
      elapsedMs: Date.now() - startedAt,
    }
  }
}

/**
 * Register the `/restart` command, the `hot_restart` tool, and the Web route the
 * composer button calls.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: '热重启：重新应用 Profile 配置并热重载文件已改动的插件（不重启进程）',
    handler: async () => {
      const result = await hotRestart(ctx)
      return result.status === 'failed' || result.status === 'unavailable'
        ? { kind: 'error', text: result.message }
        : { kind: 'success', text: result.message }
    },
  }), 'hot-restart command')

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: 'Hot-restart the Harness: re-apply the profile composition and reload plugins whose loaded files changed on disk, without restarting the process or the app window. Use it after installing, updating, or editing a plugin or the profile patch when the change must take effect now. It cannot restart the process; a change that needs a process-level restart is reported as `restart_required`.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'message', 'reloadedPlugins', 'pendingModules', 'warnings', 'elapsedMs'],
        properties: {
          status: {
            type: 'string',
            enum: ['reloaded', 'unchanged', 'restart_required', 'unavailable', 'failed'],
            description: 'What the reconciliation settled as.',
          },
          message: {
            type: 'string',
            description: 'Human-readable outcome for the user.',
          },
          reloadedPlugins: {
            type: 'integer',
            description: 'How many plugin modules were replaced during this run.',
          },
          pendingModules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module URLs whose change only takes effect after a process restart.',
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Reconciliation warnings.',
          },
          elapsedMs: {
            type: 'integer',
            description: 'Wall-clock duration of the run.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: () => hotRestart(ctx),
    presentCall: () => ({ card: 'generic', title: 'Hot restart', kind: 'other', rawInput: {} }),
  }), 'hot-restart tool')

  // The composer button (Client half) reaches this Host half over the page's own
  // HTTP carrier: a linked bundle gets no generated Client→Host RPC, and the page
  // is served from this same origin.
  //
  // At boot this plugin starts before the `webServer` service exists, so the route
  // is registered from an injected child context that activates when the service
  // appears. Reading `ctx.get('webServer')` once during `apply()` left the route
  // unregistered after every restart.
  ctx.effect(() => ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        try {
          const result = await hotRestart(ctx)
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          response.end(JSON.stringify(result))
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          logFailure('host', 'route', detail)
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ status: 'failed', message: `热重启失败：${detail}` }))
        }
      },
    }), 'hot-restart route')

    // A crashed composer button is reported here, so a blank slot leaves a trace.
    // Nothing is written when the button works.
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: CLIENT_ERROR_PATH,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 8192) break
        }
        let message = body
        try {
          const parsed = JSON.parse(body)
          message = typeof parsed?.message === 'string' ? parsed.message : body
        } catch {
          // a non-JSON body is logged as-is
        }
        logFailure('client', 'crash', message)
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      },
    }), 'hot-restart client error route')
  }), 'hot-restart route host')
}
