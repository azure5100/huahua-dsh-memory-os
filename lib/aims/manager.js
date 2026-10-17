// AIMS UI 服务生命周期管理器（AIMS 集成 node 侧 · t60）
// 职责：spawn/托管 D:\agent-identity-memory-system\ui\server.mjs 子进程，
//       health probe（/api/overview，500ms 超时）→ 状态机，owned 语义
//       （只 kill 自己 spawn 的；外源占用端口 → running owned:false 不杀），
//       日志 append + pid 文件。零 cordis 依赖（纯 node），供 installAims 组装。
import { spawn, execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const PROBE_TIMEOUT_MS = 500

/**
 * @param {object} opts
 * @param {string}  opts.serverPath  AIMS ui/server.mjs 绝对路径
 * @param {string}  [opts.host='127.0.0.1']
 * @param {number}  [opts.port=8710]
 * @param {string}  [opts.logFile]   服务日志（append）
 * @param {string}  [opts.pidFile]   pid 文件（记录自启子进程）
 * @param {object}  [opts.spawnEnv]  传给子进程的额外 env（如 AIMS_DB 演示覆盖）
 */
export function createAimsManager(opts) {
  const host = opts.host ?? '127.0.0.1'
  const port = Number(opts.port) || 8710
  const serverPath = opts.serverPath
  const logFile = opts.logFile
  const pidFile = opts.pidFile
  const spawnEnv = opts.spawnEnv

  const state = {
    state: 'stopped', // stopped | starting | running | error
    ownedPid: null,
    owned: false,
    startedAt: null,
    lastError: null,
  }

  function baseUrl() { return `http://${host}:${port}` }

  /** 探测 8710 服务健康（GET /api/overview，500ms 超时）。 */
  async function probe() {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
      const r = await fetch(`${baseUrl()}/api/overview`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!r.ok) return false
      const j = await r.json()
      return j && typeof j === 'object' && j.agents !== undefined
    } catch {
      return false
    }
  }

  function writePid() {
    if (!pidFile) return
    mkdirSync(path.dirname(pidFile), { recursive: true })
    writeFileSync(pidFile, String(state.ownedPid) + '\n')
  }
  function clearPid() {
    if (!pidFile) return
    try { unlinkSync(pidFile) } catch { /* 文件本就不在 */ }
  }

  function logLine(prefix, text) {
    if (!logFile) return
    mkdirSync(path.dirname(logFile), { recursive: true })
    const s = createWriteStream(logFile, { flags: 'a' })
    s.write(`[${new Date().toISOString()}] [${prefix}] ${text}\n`)
    s.end()
  }

  /** 强杀进程树兜底（Windows taskkill /T /F；POSIX SIGKILL 组）。 */
  function killTree(pid) {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ }
        resolve()
      }
    })
  }

  function waitExit(child, ms) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
      const timer = setTimeout(() => resolve(false), ms)
      child.once('exit', () => { clearTimeout(timer); resolve(true) })
    })
  }

  function snapshot(extra = {}) {
    return {
      state: state.state,
      port,
      host,
      owned: state.owned,
      pid: state.owned ? state.ownedPid : null,
      startedAt: state.startedAt,
      lastError: state.lastError,
      serverPath,
      ...extra,
    }
  }

  /** 状态探测（供 status/轮询）：自启存活 → running owned；否则外源占用 → running owned:false。 */
  async function refresh() {
    if (state.owned && state.ownedPid !== null) {
      try { process.kill(state.ownedPid, 0) } catch {
        state.state = 'stopped'; state.owned = false; state.ownedPid = null; state.startedAt = null
      }
    }
    if (state.state === 'running') return snapshot()
    const up = await probe()
    if (up) {
      state.state = 'running'
      state.owned = false
      state.ownedPid = null
      state.lastError = null
    } else if (state.state !== 'starting') {
      state.state = 'stopped'
    }
    return snapshot()
  }

  /** 启动（幂等）：已 running 返回现状；先探测外源占用（owned:false 不重复 spawn）。 */
  async function start() {
    if (state.state === 'running') return snapshot()
    if (!existsSync(serverPath)) {
      state.state = 'error'
      state.lastError = `AIMS server 不存在: ${serverPath}`
      return snapshot()
    }
    const occupied = await probe()
    if (occupied) {
      // 外源已在跑：复用，标记非 owned（不 kill）
      state.state = 'running'
      state.owned = false
      state.ownedPid = null
      state.startedAt = null
      logLine('start', `port ${port} 已被外源进程占用 —— 复用（owned:false，不托管不杀）`)
      return snapshot()
    }
    state.state = 'starting'
    state.owned = false
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath, '--port', String(port)], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(spawnEnv ?? {}) },
    })
    state.owned = true
    state.ownedPid = child.pid ?? null
    state.startedAt = Date.now()
    state.lastError = null
    child.unref()
    if (state.ownedPid) writePid()
    const log = logLine
    let outBuf = ''
    if (child.stdout) child.stdout.on('data', (d) => {
      outBuf += String(d)
      if (outBuf.includes('\n') || outBuf.length > 2048) { log('server', outBuf.trim()); outBuf = '' }
    })
    if (child.stderr) child.stderr.on('data', (d) => log('server', String(d).trim()))
    child.on('error', (e) => { state.state = 'error'; state.lastError = e.message; log('spawn-error', e.message) })
    child.on('exit', () => {
      if (state.owned && state.ownedPid === child.pid) {
        state.state = 'stopped'
        state.owned = false
        state.ownedPid = null
        state.startedAt = null
        clearPid()
      }
    })
    // 起服轮询：最多 ~3s 确认 running
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 200))
      if (state.state === 'error') break
      if (await probe()) { state.state = 'running'; break }
    }
    if (state.state === 'starting') {
      // 起服超时但进程还在 → 归为 error 让用户查日志
      state.state = 'error'
      state.lastError = '起服超时（3s 内未通过 /api/overview 健康探测），见日志'
    }
    return snapshot()
  }

  /** 停止（仅 owned）：外源/未自启 → 拒绝（409 语义由路由层映射）。 */
  async function stop() {
    const s = await refresh()
    if (!s.owned || s.pid === null) {
      return { ...snapshot(), ok: false, code: 409, error: s.state === 'running' ? '8710 为外源进程（非本插件托管），不杀' : '当前无自启子进程' }
    }
    const childPid = s.pid
    const exited = await new Promise((resolve) => {
      try {
        process.kill(childPid, 'SIGTERM')
      } catch { resolve(true); return }
      // 等待退出（2s），超时树清理兜底
      const timer = setTimeout(() => {
        killTree(childPid).then(() => resolve(true))
      }, 2000)
      const poll = setInterval(() => {
        try { process.kill(childPid, 0) } catch { clearInterval(poll); clearTimeout(timer); resolve(true) }
      }, 200)
    })
    void exited
    state.state = 'stopped'
    state.owned = false
    state.ownedPid = null
    state.startedAt = null
    clearPid()
    logLine('stop', `子进程 ${childPid} 已停`)
    return snapshot()
  }

  async function restart() {
    const before = await refresh()
    if (before.owned && before.pid !== null) await stop()
    return start()
  }

  function dispose() {
    if (state.owned && state.ownedPid !== null) {
      try { process.kill(state.ownedPid, 'SIGTERM') } catch { /* 已退出 */ }
      setTimeout(() => { if (state.ownedPid !== null) killTree(state.ownedPid) }, 1500).unref?.()
    }
    clearPid()
  }

  return { start, stop, restart, refresh, status: () => snapshot(), dispose, _state: state }
}
