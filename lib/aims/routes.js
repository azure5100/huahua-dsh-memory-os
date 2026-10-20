// AIMS 服务控制 HTTP 路由（AIMS 集成 node 侧 · t60）
// 挂载 /memory-evolve/api/aims/*（对齐 lib/canvas.js webServer.register prefix 模式）：
//   GET  /memory-evolve/api/aims/status    → { state, port, owned, pid, startedAt, lastError, serverPath }
//   POST /memory-evolve/api/aims/start     → { ...status }（幂等）
//   POST /memory-evolve/api/aims/stop      → 200 status / 409（外源 owned:false 不杀）
//   POST /memory-evolve/api/aims/restart   → { ...status }
export const AIMS_API_BASE = '/memory-evolve/api/aims'

/** 发送 JSON 响应（对齐 lib/canvas.js sendJson）。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * @param {object} ctx - cordis ctx（webServer 服务经 ctx.inject(['webServer']) 解析）
 * @param {object} manager - createAimsManager() 返回值
 * @returns {() => void} disposer
 */
export function installAimsRoutes(ctx, manager) {
  let cancel = () => {}
  // web-only（对齐 canvas：TUI 上 inject 不触发，自动待机无副作用）
  ctx.inject(['webServer'], (webCtx) => {
    cancel = webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: AIMS_API_BASE,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        try {
          if (path === `${AIMS_API_BASE}/status`) {
            const st = await manager.refresh()
            sendJson(res, 200, { ok: true, ...st })
            return
          }
          if (path === `${AIMS_API_BASE}/start`) {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            const st = await manager.start()
            sendJson(res, 200, { ok: true, ...st })
            return
          }
          if (path === `${AIMS_API_BASE}/stop`) {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            const st = await manager.stop()
            if (st.ok === false) return sendJson(res, st.code ?? 409, { ok: false, error: st.error, ...manager.status() })
            sendJson(res, 200, { ok: true, ...st })
            return
          }
          if (path === `${AIMS_API_BASE}/restart`) {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            const st = await manager.restart()
            sendJson(res, 200, { ok: true, ...st })
            return
          }
          sendJson(res, 404, { ok: false, error: `unknown aims api path: ${path}` })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: `aims api error: ${e.message}` })
        }
      },
    }), 'dsh-memory-evolve: aims service control routes')
  })
  return () => { cancel() }
}
