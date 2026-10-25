// 设计部（huahua-design）服务生命周期管理器（设计部集成 · node 侧）
// 职责：spawn/托管 <vendor>/app/dist/server.mjs 子进程，health probe（/api/health，
//       500ms 超时）→ 状态机，owned 语义（只 kill 自己 spawn 的；外源占用端口 →
//       running owned:false 不杀），日志 append + pid 文件。零 cordis 依赖（纯 node）。
// 纪律：设计部侧（app/、lib/、tests/）零改动——本域只 spawn/托管/探活，不直读 design.db。
// 对照：本文件结构与 lib/aims/manager.js 同构（AIMS 是 HOS 托管外部服务的标准样板）。
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const PROBE_TIMEOUT_MS = 500

/**
 * @param {object} opts
 * @param {string}  opts.serverPath   设计部 app/dist/server.mjs 绝对路径
 * @param {string}  [opts.appDir]     设计部 app 目录（HUAHUA_DESIGN_APP_DIR）
 * @param {string}  [opts.dataDir]    数据目录（HUAHUA_DESIGN_DATA_DIR，纳入 HOS 数据根）
 * @param {string}  [opts.host='127.0.0.1']
 * @param {number}  [opts.port=9531]  设计部默认端口（上游硬编码 9531；本域可用 PORT 覆盖）
 * @param {string}  [opts.version]    HUAHUA_DESIGN_VERSION
 * @param {string}  [opts.logFile]    服务日志（append）
 * @param {string}  [opts.pidFile]    pid 文件（记录自启子进程）
 * @param {object}  [opts.spawnEnv]   传给子进程的额外 env
 */
export function createDesignManager(opts) {
  const host = opts.host ?? '127.0.0.1'
  const port = Number(opts.port) || 9531
  const serverPath = opts.serverPath
  const appDir = opts.appDir
  const dataDir = opts.dataDir
  const version = opts.version ?? '0.1.0'
  const logFile = opts.logFile
  const pidFile = opts.pidFile
  const spawnEnv = opts.spawnEnv

  const state = {
    state: 'stopped', // stopped | starting | running | error
    ownedPid: null,
    owned: false,
    startedAt: null,
    lastError: null,
    instanceId: null,
  }

  function baseUrl() { return `http://${host}:${port}` }

  /** 探测设计部服务健康（GET /api/health，500ms 超时）。 */
  async function probe() {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
      const r = await fetch(`${baseUrl()}/api/health`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!r.ok) return null
      const j = await r.json()
      return j && typeof j === 'object' && j.service === 'design' ? j : null
    } catch {
      return null
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
    // 同步 append：异步 WriteStream 在进程退出/测试结束时未 flush 会抛
    // ERR_STREAM_DESTROYED（实测）。日志不是热路径，同步写更稳。
    try {
      mkdirSync(path.dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] [${prefix}] ${text}\n`)
    } catch { /* 日志失败不影响主流程 */ }
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
      instanceId: state.instanceId,
      serverPath,
      dataDir: dataDir ?? null,
      url: baseUrl(),
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
    const health = await probe()
    if (health !== null) {
      state.state = 'running'
      state.owned = false
      state.ownedPid = null
      state.lastError = null
      state.instanceId = typeof health.instanceId === 'string' ? health.instanceId : null
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
      state.lastError = `设计部 server 不存在: ${serverPath}`
      return snapshot()
    }
    const occupied = await probe()
    if (occupied !== null) {
      // 外源已在跑：复用，标记非 owned（不 kill）
      state.state = 'running'
      state.owned = false
      state.ownedPid = null
      state.startedAt = null
      state.instanceId = typeof occupied.instanceId === 'string' ? occupied.instanceId : null
      logLine('start', `port ${port} 已被外源进程占用 —— 复用（owned:false，不托管不杀）`)
      return snapshot()
    }
    state.state = 'starting'
    state.owned = false
    const instanceId = `hos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(spawnEnv ?? {}),
        PORT: String(port),
        HOST: host,
        ...(appDir ? { HUAHUA_DESIGN_APP_DIR: appDir } : {}),
        ...(dataDir ? { HUAHUA_DESIGN_DATA_DIR: dataDir } : {}),
        HUAHUA_DESIGN_VERSION: version,
        HUAHUA_DESIGN_INSTANCE_ID: instanceId,
      },
    })
    state.owned = true
    state.ownedPid = child.pid ?? null
    state.child = child
    state.startedAt = Date.now()
    state.lastError = null
    state.instanceId = instanceId
    child.unref()
    if (state.ownedPid) writePid()
    let outBuf = ''
    if (child.stdout) child.stdout.on('data', (d) => {
      outBuf += String(d)
      if (outBuf.includes('\n') || outBuf.length > 2048) { logLine('server', outBuf.trim()); outBuf = '' }
    })
    if (child.stderr) child.stderr.on('data', (d) => logLine('server', String(d).trim()))
    child.on('error', (e) => { state.state = 'error'; state.lastError = e.message; logLine('spawn-error', e.message) })
    child.on('exit', (code, signal) => {
      if (!state.owned) return
      state.state = 'stopped'
      state.owned = false
      state.ownedPid = null
      state.startedAt = null
      state.child = null
      clearPid()
      logLine('exit', `code=${code} signal=${signal}`)
    })
    // 等到 health 报出**自己这个 instanceId** 才算就绪
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      const health = await probe()
      if (health !== null && health.instanceId === instanceId) {
        state.state = 'running'
        state.lastError = null
        logLine('start', `started on ${baseUrl()} instanceId=${instanceId}`)
        return snapshot()
      }
      if (child.exitCode !== null) {
        state.state = 'error'
        state.lastError = `子进程启动即退出（code=${child.exitCode}）`
        state.owned = false
        state.ownedPid = null
        clearPid()
        return snapshot()
      }
    }
    // 超时：自杀，不留半死进程
    state.lastError = '启动超时（15s 内未就绪）'
    await stop()
    state.state = 'error'
    return snapshot()
  }

  /** 停止：只杀自己 spawn 的（owned 语义）；外源进程不碰。 */
  async function stop() {
    if (!state.owned || state.ownedPid === null) {
      // 外源或未运行：不改状态，避免误杀
      if (state.state === 'running' && !state.owned) {
        return { ok: false, code: 409, error: '外源进程不托管，无法停止' }
      }
      return snapshot()
    }
    const pid = state.ownedPid
    const child = state.child
    try {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        const exited = await waitExit(child, 3000)
        if (!exited) await killTree(pid)
      } else {
        await killTree(pid)
      }
    } catch { /* 已退出 */ }
    state.state = 'stopped'
    state.owned = false
    state.ownedPid = null
    state.startedAt = null
    state.instanceId = null
    state.child = null
    clearPid()
    logLine('stop', `pid ${pid} stopped`)
    return snapshot()
  }

  async function restart() {
    await stop()
    await new Promise((r) => setTimeout(r, 300))
    return start()
  }

  function status() { return snapshot() }

  function dispose() {
    // 卸载时只停自己 spawn 的
    if (state.owned && state.ownedPid !== null) {
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(state.ownedPid), '/T', '/F'], { windowsHide: true }, () => {})
        } else {
          process.kill(state.ownedPid, 'SIGTERM')
        }
      } catch { /* 已退出 */ }
    }
  }

  return { start, stop, restart, refresh, status, dispose, probe, _state: state }
}
