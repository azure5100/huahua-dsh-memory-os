// E59 · B1 插桩（被动采样 · 三项读数：CPU / 事件循环延迟 / 单进程内并发任务数）
// 来源：A12 自陈前置 ② 批 B1（插桩+重启）；主人已批该重启窗口。
// 卡面要点：① 三项齐 ② 机器取（JSONL） ③ 两态可区分 ④ 插桩开销可测 ⑤ 被动：只读 process/os/perf_hooks，写盘失败不致命，timer.unref()
import { monitorEventLoopDelay } from "node:perf_hooks"
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import os from "node:os"

export const DEFAULT_INTERVAL_MS = 1000
// E59 扩展（2026-09-23 · 队长已准）：卡住「当时」抓线程等待原因 + 外围计数器。
// 判据：loop.maxMs > STALL_MS && cpu.pct < STALL_CPU_PCT（CPU 低 ⇒ 疑似等内核对象/换页，而非纯 CPU 忙）。
// ⚠ 两条保留（必须随读数一起报）：
//   ① 部分线程 WaitReason 读成 Unknown —— 「读不出」不等于「没在等」；
//   ② 必须卡住当时抓 —— loop.maxMs 是阻塞结束后才读到的 ⇒ 只在 tick 里触发会拿到「事后状态」。
//      **兑现方式 = 常驻看门狗进程 + 环形缓冲**：装载时起独立 powershell 每 ~250ms 记录宿主线程状态；
//      事后按阻塞时间戳回查那一行 ⇒ 样本产生于卡住当时，**回查窗 ±250ms 必须写进读数**。
export const STALL_MS = 3000
export const STALL_CPU_PCT = 2
export const WATCHER_INTERVAL_MS = 250
const r3 = (n) => Math.round(Number(n) * 1000) / 1000

export function createHostProbe(opts = {}) {
  const intervalMs = Number(opts.intervalMs || DEFAULT_INTERVAL_MS)
  const outFile = String(opts.outFile || "")
  const liveAgents = typeof opts.liveAgents === "function" ? opts.liveAgents : null
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  let seq = 0
  let lastCpu = process.cpuUsage()
  let lastT = process.hrtime.bigint()
  let timer = null
  const rows = []

  function tick() {
    const t0 = process.hrtime.bigint()
    const loop = { meanMs: r3(h.mean / 1e6), maxMs: r3(h.max / 1e6), p99Ms: r3(h.percentile(99) / 1e6) }
    h.reset()
    const cpu = process.cpuUsage(lastCpu)
    lastCpu = process.cpuUsage()
    const tNow = process.hrtime.bigint()
    const elapsedMs = Number(tNow - lastT) / 1e6
    lastT = tNow
    const cpuPct = elapsedMs > 0 ? r3(((cpu.user + cpu.system) / 1000) / elapsedMs * 100) : 0
    let res = []
    try { res = process.getActiveResourcesInfo() || [] } catch (e) { res = [] }
    const byType = {}
    for (const x of res) byType[x] = (byType[x] || 0) + 1
    let agents = null
    if (liveAgents) { try { agents = Number(liveAgents()) } catch (e) { agents = null } }
    const mem = process.memoryUsage()
    const overheadMs = r3(Number(process.hrtime.bigint() - t0) / 1e6)
    const row = {
      ts: Date.now(), seq: seq++,
      loop: loop,
      cpu: { pct: cpuPct, userMs: r3(cpu.user / 1000), sysMs: r3(cpu.system / 1000), cores: os.cpus().length },
      conc: { activeResources: res.length, byType: byType, liveAgents: agents },
      mem: { rssMB: r3(mem.rss / 1048576) },
      overheadMs: overheadMs,
    }
    // E59 扩展：卡住标记（**事后标记** —— 线程状态由看门狗在「当时」写，本标记只用于时间轴对齐/回查）
    if (loop.maxMs > STALL_MS && cpuPct < STALL_CPU_PCT) {
      row.stall = true
      if (outFile) {
        try { appendFileSync(outFile, JSON.stringify({ type: "stall", ts: row.ts, loopMaxMs: loop.maxMs, cpuPct: cpuPct }) + "\n") } catch (e) { /* 不致命 */ }
      }
    }
    rows.push(row)
    if (outFile) {
      try { mkdirSync(dirname(outFile), { recursive: true }); appendFileSync(outFile, JSON.stringify(row) + "\n") } catch (e) { /* 采不到不致命 */ }
    }
    return row
  }

  return {
    intervalMs: intervalMs,
    get rows() { return rows },
    tick: tick,
    start() { if (timer) return; timer = setInterval(tick, intervalMs); if (typeof timer.unref === "function") timer.unref() },
    stop() { if (timer) clearInterval(timer); timer = null; try { h.disable() } catch (e) {} },
  }
}

export function readProbe(file, opts = {}) {
  const sinceMs = Number(opts.sinceMs || 0)
  const untilMs = Number(opts.untilMs || Number.MAX_SAFE_INTEGER)
  const limit = Number(opts.limit || 200000)
  if (!existsSync(file)) return []
  const out = []
  const lines = readFileSync(file, "utf8").split("\n")
  for (const line of lines) {
    if (!line.trim()) continue
    let row = null
    try { row = JSON.parse(line) } catch (e) { continue }
    if (!row || typeof row.ts !== "number") continue
    if (row.ts < sinceMs || row.ts > untilMs) continue
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

function pick(rows, f) {
  const a = []
  for (const r of rows) { const v = f(r); if (typeof v === "number" && Number.isFinite(v)) a.push(v) }
  a.sort((x, y) => x - y)
  return a
}
function stat(arr) {
  if (!arr.length) return { n: 0, p50: null, p95: null, max: null }
  const at = (p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]
  return { n: arr.length, p50: r3(at(0.5)), p95: r3(at(0.95)), max: r3(arr[arr.length - 1]) }
}
/** E59 扩展 · B 类窗口判定（队长 2026-09-24 修订）：连续采样 + 稳定性 + 单调计数器。
 *  - 「5 次采样」≠「5 次成功」：读不出（Unknown）如实计，不补齐、不丢；
 *  - 「稳定停留」定义写死：**5 次中 ≥ 4 次为同一 WaitReason** ⇒ stable=true；
 *  - 单调计数器 = 看门狗**同批**记录的 `cpuMs.total`（进程总处理器时间，单调不减）⇒ 取窗口前后差值。
 */
export function readThreadWindow(file, ts, n = 5) {
  const rows = readProbe(file).filter((r) => r.type === "threads")
  if (!rows.length) return { samples: [], note: "未取到：线程看门狗文件无样本" }
  const copy = rows.slice().sort((a, b) => a.ts - b.ts)
  let best = 0, bestD = Infinity
  for (let i = 0; i < copy.length; i++) { const d = Math.abs(copy[i].ts - ts); if (d < bestD) { bestD = d; best = i } }
  const from = Math.max(0, best - Math.floor(n / 2))
  return { samples: copy.slice(from, from + n), note: null }
}

// 基线等待态（正常空闲，不构成诊断信号）：诊断要看「非基线」的等待原因。
export const BASELINE_WAITS = ["Wait, UserRequest", "Running, -"]
export const NO_SIGNAL = "(无诊断信号)"

/** 稳定停留判定（纯函数 · 定义写死）：
 *  ① 每一样本取「count 最大的**非基线**等待原因」（基线见 BASELINE_WAITS；若样本里 Top10 全为基线 ⇒ 记 NO_SIGNAL）；
 *  ② **稳定停留 = 5 次中 ≥4 次为同一诊断值 且 该值 ≠ NO_SIGNAL**；
 *  ③ `Wait, Unknown` **如实计入**（既不补齐成别的值，也不丢）并单独给 unknownCount。
 */
export function stableWait(samples, opts = {}) {
  const baseline = Array.isArray(opts.baseline) ? opts.baseline : BASELINE_WAITS
  const names = []
  for (const s of samples || []) {
    const list = (s.threads || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0))
    const diag = list.find((x) => !baseline.includes(String(x.name)))
    names.push(diag ? String(diag.name) : NO_SIGNAL)
  }
  const counts = {}
  for (const x of names) counts[x] = (counts[x] || 0) + 1
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0]
  const unknown = names.filter((x) => /Unknown/i.test(x)).length
  const stable = names.length >= 5 && top[1] >= 4 && top[0] !== NO_SIGNAL
  return { names: names, mode: top[0], modeCount: top[1], n: names.length, stable: stable, unknownCount: unknown, baseline: baseline }
}

/** 单调计数器读数（cpuMs.total）：窗口前后差值；不足两点 ⇒ 未取到（不拿「某个数变了」充数）。 */
export function monotonicDelta(samples) {
  const v = (samples || []).map((s) => (s.cpuMs && typeof s.cpuMs.total === "number" ? s.cpuMs.total : null)).filter((x) => x !== null)
  if (v.length < 2) return { ok: false, note: "未取到：窗口内不足两点 cpuMs.total（单调计数器）" }
  let monotonic = true
  for (let i = 1; i < v.length; i++) if (v[i] < v[i - 1]) monotonic = false
  return { ok: true, from: v[0], to: v[v.length - 1], delta: Math.round((v[v.length - 1] - v[0]) * 1000) / 1000, monotonic: monotonic, n: v.length }
}

/** 常驻线程看门狗（win32）：每 intervalMs 记录一次宿主线程状态到 outFile（环形缓冲）。 */
export function startThreadWatcher(opts = {}) {
  if (process.platform !== "win32") return { ok: false, reason: "win32-only" }
  const pid = Number(opts.pid || process.pid)
  const outFile = String(opts.outFile || "")
  const intervalMs = Number(opts.intervalMs || WATCHER_INTERVAL_MS)
  if (!outFile) return { ok: false, reason: "outFile-required" }
  let ps1 = ""
  try { ps1 = fileURLToPath(new URL("./host-probe-watch.ps1", import.meta.url)) } catch (e) { return { ok: false, reason: "ps1-resolve-failed" } }
  try {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Target", String(pid), "-Out", outFile, "-EveryMs", String(intervalMs)]
    const child = spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: true })
    if (typeof child.unref === "function") child.unref()
    return { ok: true, watcherPid: child.pid, ps1: ps1, outFile: outFile }
  } catch (e) { return { ok: false, reason: "spawn-failed:" + String(e && e.message) } }
}

/**
 * E76 · 宿主内线程/资源看门狗（**不 spawn 子进程** ⇒ 可在本进程内当场验证）。
 * 为什么需要它：`startThreadWatcher` 走 detached powershell，本环境实测「node 派生的静默子进程会被回收」
 *   （返回 pid、不落文件、进程消失）⇒ 接线 ≠ 生效。本函数给出**能当场验**的那一版。
 * 口径（必须随读数一起报）：`threads[]` 在这里是 **Node 活动资源直方图**（getActiveResourcesInfo），
 *   **不是** OS 线程（OS 线程名/数只有外部 powershell 版能给）⇒ 两种来源用 `source` 字段区分（"in-process" | "powershell"）。
 * 边界：只读 process.*；写盘失败不致命；timer.unref()。
 */
export function startInProcessThreadSampler(opts = {}) {
  const outFile = String(opts.outFile || "")
  if (!outFile) return { ok: false, reason: "outFile-required" }
  const intervalMs = Number(opts.intervalMs || WATCHER_INTERVAL_MS)
  const pid = Number(opts.pid || process.pid)
  let timer = null, stopped = false
  const prev = process.cpuUsage()
  let prevAt = Date.now()
  const sample = () => {
    const now = Date.now()
    const cpu = process.cpuUsage(prev)
    prev.user = 0; prev.system = 0
    const totalMs = Math.round((cpu.user + cpu.system) / 1000 * 1000) / 1000
    const wall = Math.max(1, now - prevAt)
    let hist = {}
    try { for (const name of process.getActiveResourcesInfo()) hist[name] = (hist[name] || 0) + 1 } catch (e) { hist = {} }
    const threads = Object.keys(hist).sort().map((name) => ({ count: hist[name], name: name }))
    const row = {
      ts: now, type: "threads", pid: pid, source: "in-process",
      overheadMs: 0,
      cpuMs: { total: totalMs, user: Math.round(cpu.user / 1000 * 1000) / 1000, priv: Math.round(cpu.system / 1000 * 1000) / 1000, wallMs: wall },
      handles: threads.length,
      rssMB: Math.round(((process.memoryUsage && process.memoryUsage().rss) || 0) / 1048576 * 1000) / 1000,
      threads: threads,
    }
    try { mkdirSync(dirname(outFile), { recursive: true }); appendFileSync(outFile, JSON.stringify(row) + String.fromCharCode(10), "utf8") } catch (e) { /* 写盘失败不致命 */ }
    prevAt = now
  }
  try {
    timer = setInterval(sample, intervalMs)
    if (typeof timer.unref === "function") timer.unref()
    sample()
  } catch (e) { return { ok: false, reason: "start-failed:" + String(e && e.message) } }
  return { ok: true, source: "in-process", outFile: outFile, intervalMs: intervalMs, pid: pid, stop: () => { stopped = true; if (timer) clearInterval(timer); timer = null }, isStopped: () => stopped }
}

export function summarize(rows) {
  return {
    loopMax: stat(pick(rows, (r) => r.loop && r.loop.maxMs)),
    loopP99: stat(pick(rows, (r) => r.loop && r.loop.p99Ms)),
    cpu: stat(pick(rows, (r) => r.cpu && r.cpu.pct)),
    resources: stat(pick(rows, (r) => r.conc && r.conc.activeResources)),
    overhead: stat(pick(rows, (r) => r.overheadMs)),
  }
}
