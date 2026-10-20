// huahua-os · 阶段1 副本自动同步（t22 · docs/89 §1.3 落地 + 主人反馈「源更新 UI 会同步吗」）
// 职责：检测源（~/.gbrain/agent-roles/source）与副本（仓库 agents/source）漂移 → 复用 scripts/agents-sync.mjs
//       （--check 只读判漂移 / --apply 同步；其内部含「源零改动」红色自断言）→ 状态透出给 UI。
// 触发：① installAgents 后启动（延迟首次 + tick，均 unref，不阻塞宿主）② 状态端点按需检（节流）
//       ③ 手动 POST /agents/sync（强制 apply）。
// 红线：本模块对源只 fs 读（statSync/readFileSync）；同步由 agents-sync 脚本执行（只写副本）。
// 状态落盘：agents/.ops/sync-state.json（.ops 已 gitignore，属运行时审计区）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveAgentsDir, expandHome } from './registry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SYNC_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'agents-sync.mjs')
import { defaultAgentRolesRoot } from './platform-paths.js' // E157：gbrain 源根唯一 home
const DEFAULT_HR_DIR = () => defaultAgentRolesRoot()   // E157：唯一 home（原为本地各写一份）
const DEFAULT_TICK_MS = 30 * 60 * 1000 // 30min（低频资产；unref）
const DEFAULT_THROTTLE_MS = 60 * 1000 // 端点按需检节流 60s
const SCRIPT_TIMEOUT_MS = 180 * 1000

const hrDirOf = (cfg = {}) => {
  const v = cfg.agentsHrDir
  return v && String(v).trim() ? expandHome(String(v).trim()) : DEFAULT_HR_DIR()
}

/** 递归 md 清单（相对 source/；仅统计，不读内容）。 */
function walkMd(dir) {
  const out = []
  const walk = (rel) => {
    let entries = []
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git') continue
      const relE = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(relE); continue }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
      try {
        const st = fs.statSync(path.join(dir, relE.replace(/\//g, path.sep)))
        out.push({ rel: relE, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
      } catch { /* 并发变动忽略 */ }
    }
  }
  walk('')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 源/副本签名（轻量：文件数 + 总大小 + 最大 mtime + 聚合 digest）。
 * 不比较两侧 mtime（copyFileSync 会改写副本 mtime）——副本侧只取 count/totalSize 做集合级对齐判定。
 * @param {string} root agent-roles 根（取其 source/）或副本根（取其 source/）
 */
export function treeSignature(root) {
  const files = walkMd(path.join(root, 'source'))
  const h = crypto.createHash('sha1')
  let totalSize = 0
  let maxMtimeMs = 0
  for (const f of files) {
    totalSize += f.size
    if (f.mtimeMs > maxMtimeMs) maxMtimeMs = f.mtimeMs
    h.update(`${f.rel}\0${f.size}\0${f.mtimeMs}\n`)
  }
  return { count: files.length, totalSize, maxMtimeMs, digest: h.digest('hex') }
}

/** 执行 agents-sync.mjs（--check / --apply）；返回 {code, stdout, stderr, ms}。 */
function runSyncScript(args, timeoutMs = SCRIPT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SYNC_SCRIPT)) return resolve({ code: -1, stdout: '', stderr: `agents-sync.mjs 不存在: ${SYNC_SCRIPT}`, ms: 0 })
    const t0 = Date.now()
    const child = spawn(process.execPath, [SYNC_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    const fin = (code) => { if (!done) { done = true; resolve({ code, stdout, stderr, ms: Date.now() - t0 }) } }
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => { stderr += `spawn error: ${e.message}`; fin(-1) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } fin(-2) }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('close', (code) => { clearTimeout(timer); fin(code ?? -1) })
  })
}

/** 从 --check stdout 解析漂移计数（'新增 N / 变更 N / 删除 N'）。 */
function parseDrift(stdout) {
  const num = (re) => { const m = re.exec(String(stdout ?? '')); return m ? Number(m[1]) : null }
  return {
    added: num(/新增\s*(\d+)/),
    changed: num(/变更\s*(\d+)/),
    removed: num(/删除\s*(\d+)/),
  }
}

const stateFileOf = (agentsDir) => path.join(agentsDir, '.ops', 'sync-state.json')

/**
 * 同步管理器（每 agentsDir 单例——installAgents 与 routes 复用同一实例，避免双 timer/双写）。
 * @param {{ agentsDir?:string, hrDir?:string, autoSync?:boolean, tickMs?:number, throttleMs?:number, logger?:object }} [opts]
 */
export function createSyncManager(opts = {}) {
  const agentsDir = resolveAgentsDir(opts.agentsDir)
  const hrDir = opts.hrDir ? expandHome(String(opts.hrDir)) : DEFAULT_HR_DIR()
  const tickMs = Number.isInteger(opts.tickMs) && opts.tickMs > 0 ? opts.tickMs : DEFAULT_TICK_MS
  const throttleMs = Number.isInteger(opts.throttleMs) && opts.throttleMs >= 0 ? opts.throttleMs : DEFAULT_THROTTLE_MS
  const logger = opts.logger ?? console

  let autoSync = opts.autoSync === true
  let timer = null
  let startupTimer = null
  let applying = null // in-flight syncNow promise
  let lastCheck = null // {drifted, mode, added, changed, removed, checkedAt, error}
  let lastSync = null // {ok, at, ms, added?, changed?, removed?, error?}
  let lastError = null

  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFileOf(agentsDir), 'utf8')) } catch { return null }
  }
  function writeState(patch) {
    try {
      const dir = path.join(agentsDir, '.ops')
      fs.mkdirSync(dir, { recursive: true })
      const cur = readState() ?? {}
      fs.writeFileSync(stateFileOf(agentsDir), JSON.stringify({ ...cur, ...patch }, null, 1) + '\n', 'utf8')
    } catch { /* 状态落盘失败不影响同步 */ }
  }

  function manifestInfo() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(agentsDir, 'MANIFEST.json'), 'utf8'))
      return { syncedAt: m.syncedAt ?? null, sourceCount: m.sourceCount ?? null, copyCount: m.copyCount ?? null, roleIndexCount: m.roleIndexCount ?? null }
    } catch { return { syncedAt: null, sourceCount: null, copyCount: null, roleIndexCount: null } }
  }

  /**
   * 漂移检测（节流；force=true 必检）。
   * 快路径：源签名与上次记录一致 + 副本 md 数与源一致 → 无漂移（零 spawn）。
   * 慢路径：签名变化/首次/副本数不齐 → spawn `agents-sync --check`（只读，含逐文件 sha256）确证。
   */
  async function check({ force = false } = {}) {
    const now = Date.now()
    if (!force && lastCheck && now - Date.parse(lastCheck.checkedAt) < throttleMs) return lastCheck
    let src
    let copy
    try {
      src = treeSignature(hrDir)
      copy = treeSignature(agentsDir)
    } catch (e) {
      lastCheck = { drifted: false, mode: 'error', checkedAt: new Date().toISOString(), error: `签名读取失败: ${e.message}` }
      lastError = lastCheck.error
      return lastCheck
    }
    const st = readState()
    const sigMatch = st?.sourceSignature?.digest === src.digest
    if (sigMatch && copy.count === src.count && copy.totalSize === src.totalSize) {
      lastCheck = { drifted: false, mode: 'signature', added: 0, changed: 0, removed: 0, checkedAt: new Date().toISOString(), source: src, copyCount: copy.count }
      return lastCheck
    }
    // 慢路径：脚本 --check（只读确证；exit 0=无漂移 1=漂移）
    const r = await runSyncScript(['--check', '--source', hrDir, '--target', agentsDir])
    const d = parseDrift(r.stdout)
    const drifted = r.code !== 0
    lastCheck = { drifted, mode: 'check-script', ...d, checkedAt: new Date().toISOString(), source: src, copyCount: copy.count, exitCode: r.code }
    if (!drifted) writeState({ sourceSignature: src, checkedAt: lastCheck.checkedAt, syncedAt: manifestInfo().syncedAt }) // 无漂移 → 记录当前源签名
    return lastCheck
  }

  /** 立即同步（强制 apply；in-flight 去重）。 */
  function syncNow() {
    if (applying) return applying
    const t0 = Date.now()
    applying = (async () => {
      const before = await check({ force: true }).catch(() => null)
      const r = await runSyncScript(['--apply', '--source', hrDir, '--target', agentsDir])
      const ok = r.code === 0
      const after = await check({ force: true }).catch(() => null)
      const man = manifestInfo()
      if (ok) {
        writeState({ sourceSignature: treeSignature(hrDir), syncedAt: man.syncedAt, checkedAt: new Date().toISOString() })
      } else {
        lastError = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300)
      }
      lastSync = { ok, at: new Date().toISOString(), ms: Date.now() - t0, driftBefore: before ? { added: before.added, changed: before.changed, removed: before.removed } : null, driftAfter: after ? { drifted: after.drifted, added: after.added, changed: after.changed, removed: after.removed } : null, error: ok ? null : lastError }
      if (ok) logger.log?.(`[agents-sync] 副本已同步（${lastSync.ms}ms）· syncedAt ${man.syncedAt}`)
      else logger.error?.(`[agents-sync] 同步失败: ${lastError}`)
      return { ok, durationMs: lastSync.ms, driftBefore: lastSync.driftBefore, driftAfter: lastSync.driftAfter, manifest: man, stdout: r.stdout.trim().split('\n').slice(-3), error: lastSync.error }
    })().finally(() => { applying = null })
    return applying
  }

  /** 自动同步一轮（tick/启动用）：仅检测到漂移才 apply。 */
  async function maybeAutoSync() {
    if (!autoSync) return { skipped: true, reason: 'autoSync=false' }
    try {
      const c = await check({ force: true })
      if (!c.drifted) return { skipped: true, reason: 'no-drift' }
      logger.log?.(`[agents-sync] 检测到漂移 → 自动同步（added ${c.added ?? '?'} / changed ${c.changed ?? '?'} / removed ${c.removed ?? '?'}）`)
      return syncNow()
    } catch (e) {
      lastError = e?.message ?? String(e)
      logger.error?.(`[agents-sync] 自动同步异常: ${lastError}`)
      return { ok: false, error: lastError }
    }
  }

  function startTimers() {
    if (timer || startupTimer) return
    // 启动后延迟首检（不阻塞宿主 boot；unref 不阻止进程退出）
    startupTimer = setTimeout(() => { startupTimer = null; maybeAutoSync().catch(() => {}) }, 3000)
    if (typeof startupTimer.unref === 'function') startupTimer.unref()
    timer = setInterval(() => { maybeAutoSync().catch(() => {}) }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  function stopTimers() {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null }
    if (timer) { clearInterval(timer); timer = null }
  }

  function setAutoSync(next) {
    const want = next === true
    if (want === autoSync) return
    autoSync = want
    if (want) startTimers()
    else stopTimers()
  }

  function status() {
    const man = manifestInfo()
    return {
      autoSync,
      hrDir,
      agentsDir,
      syncedAt: man.syncedAt,
      sourceCount: man.sourceCount,
      copyCount: man.copyCount ?? null,
      roleIndexCount: man.roleIndexCount ?? null,
      drifted: lastCheck ? lastCheck.drifted : null,
      lastCheck: lastCheck ? { mode: lastCheck.mode, added: lastCheck.added ?? null, changed: lastCheck.changed ?? null, removed: lastCheck.removed ?? null, checkedAt: lastCheck.checkedAt, error: lastCheck.error ?? null } : null,
      lastSync,
      applying: applying !== null,
      tickMs,
      lastError,
      script: SYNC_SCRIPT,
    }
  }

  return {
    check, syncNow, maybeAutoSync, setAutoSync, status,
    start() { if (autoSync) startTimers() },
    stop: stopTimers,
    _test: { treeSignature, hrDirOf, SYNC_SCRIPT },
  }
}

/** 进程内单例（键 = agentsDir|hrDir）：installAgents 与 routes 复用同一管理器（防双 timer）。 */
const managers = new Map()
export function getSyncManager(cfg = {}, opts = {}) {
  const agentsDir = resolveAgentsDir(cfg.agentsDir)
  const hrDir = hrDirOf(cfg)
  const key = `${agentsDir}|${hrDir}`
  if (!managers.has(key)) {
    const autoSync = cfg.agentsAutoSync === undefined ? true : cfg.agentsAutoSync === true // 默认开（主人期望自动跟随；仅漂移时动副本）
    managers.set(key, createSyncManager({ agentsDir, hrDir, autoSync, logger: opts.logger ?? console, tickMs: opts.tickMs, throttleMs: opts.throttleMs }))
  }
  return managers.get(key)
}
