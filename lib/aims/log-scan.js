// 会话日志读取与「空闲收尾候选」重建（architect docs/112 §2.2 注 6 · v1.3）
//
// 为什么存在：`turn/end` **同时是持久化事件**（落会话日志）⇒ 收尾判定不必依赖进程内状态：
//   进程启动时 / 每日 tick 时扫一遍各会话日志，取**最后一条 turn/end 的时间**，凡「静默 ≥ N 分钟
//   且台账未命中」的会话即可补一次幂等收尾 register。这样**天然抗重启、抗域重装**；
//   进程内计时器（observe.js 的 scheduleIdleFlush）只作低延迟优化，不再是唯一依赖。
//
// 存储事实（本机实测 2026-09-11）：
//   路径 = `<DSH_HOME>/sessions/<project-slug>/<sessionId>/session.jsonl.zstd`
//   文件是**多帧 zstd 流**（每次 append 一帧）⇒ `zlib.zstdDecompressSync()` 只解出**第一帧**
//   （实测 12.8MB 文件仅得 258B、只有 `{"type":"session",…}` 头帧）⇒ 必须用**流式**解压才能拿到全部事件。
//
// 成本分层：`stat` 快路径（不解压）先排除「仍活跃」与「已落账」的会话；只有候选才真解压取详情
//   （每个会话最多被解压一次——落账后即被台账挡住）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { normalizeSessionId } from '../agents/trace.js'

/** DSH 会话根目录（可被 DSH_HOME 覆盖，便于测试与多实例）。 */
export function sessionsRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/**
 * 列出会话日志（`<root>/<slug>/<sid>/session.jsonl.zstd`）。
 * @param {string} [root] 会话根目录（缺省 `sessionsRoot()`）
 * @returns {Array<{sessionId: string, slug: string, file: string, mtimeMs: number, bytes: number}>}
 */
export function listSessionLogs(root = sessionsRoot()) {
  const out = []
  let slugs = []
  try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return out }
  for (const slug of slugs) {
    const slugDir = path.join(root, slug.name)
    let sids = []
    try { sids = fs.readdirSync(slugDir, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const sid of sids) {
      const file = path.join(slugDir, sid.name, 'session.jsonl.zstd')
      try {
        const st = fs.statSync(file)
        out.push({ sessionId: normalizeSessionId(sid.name), rawId: sid.name, slug: slug.name, file, mtimeMs: st.mtimeMs, bytes: st.size })
      } catch { /* 无日志的会话目录跳过 */ }
    }
  }
  return out
}

/** zstd 帧 magic（每个 append 一帧 ⇒ 文件里会重复出现）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 扫描全部帧边界：返回每个帧的起始偏移（末尾补 length 作为最后一帧的结束）。 */
export function scanZstdFrames(buf) {
  const starts = []
  let idx = -1
  while ((idx = buf.indexOf(ZSTD_MAGIC, idx + 1)) !== -1) starts.push(idx)
  const bounds = starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : buf.length])
  return bounds.filter(([s, e]) => e > s + 4)
}

/** 逐帧解压（Node 的同步 zstd API 只吃第一帧；多帧流必须按帧推进，与平台 `zstd.ts` 的 scanZstdFrames 同语义）。 */
function decodeFrames(buf, bounds) {
  const out = []
  for (const [s, e] of bounds) {
    try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')) } catch { /* 假 magic / 坏帧：跳过（单帧损坏不影响其它帧） */ }
  }
  return out
}

/**
 * 读取会话日志详情：**头部记录取自第一帧**，事件取自**从末尾向前的若干帧**（内存受 `maxTailBytes` 约束）。
 * 为什么反向取帧：单会话日志可达 12MB+/1.4 万帧，整篇解压既慢又占内存；而收尾只需要
 * 「最后一条 turn/end 的时间 + 首条用户文本 + header（title/cwd/origin）」。
 * @param {string} file `session.jsonl.zstd`
 * @param {{tailEvents?: number, maxTailBytes?: number}} [opts]
 * @returns {{header: object|null, events: object[], frames: number, tailBytes: number}}
 */
export function readSessionDetail(file, opts = {}) {
  const tailEvents = opts.tailEvents ?? 400
  const maxTailBytes = opts.maxTailBytes ?? 2 * 1024 * 1024
  const raw = fs.readFileSync(file)
  const bounds = scanZstdFrames(raw)
  const header = bounds.length ? (() => {
    try { return JSON.parse(decodeFrames(raw, [bounds[0]])[0].split('\n').find(Boolean) ?? 'null') } catch { return null }
  })() : null

  const texts = []
  let tailBytes = 0
  for (let i = bounds.length - 1; i >= 1; i -= 1) {
    const chunk = decodeFrames(raw, [bounds[i]])[0]
    if (!chunk) continue
    texts.unshift(chunk)
    tailBytes += chunk.length
    if (tailBytes >= maxTailBytes) break
  }
  const events = []
  for (const t of texts) {
    for (const line of t.split('\n')) {
      if (!line) continue
      try {
        const o = JSON.parse(line)
        if (o?.type === 'session') continue
        events.push(o)
      } catch { /* 跨帧半行：忽略（帧边界处可能是被截断的行） */ }
    }
  }
  return { header, events: events.slice(-tailEvents), frames: bounds.length, tailBytes }
}

/**
 * 「空闲收尾候选」重建（**只读**：不做任何 register、不写任何文件）。
 * 快路径用 `stat.mtimeMs` 排除仍活跃者；台账命中者由调用方 `hasCloseout` 判定（避免本模块依赖台账实现）。
 * @param {{root?: string, idleMinutes: number, now?: number, hasCloseout?: (sid: string) => boolean}} args
 * @returns {{scanned: number, active: number, done: number, candidates: Array<object>}}
 */
export function scanIdleCandidates({ root = sessionsRoot(), idleMinutes, now = Date.now(), hasCloseout = () => false }) {
  const logs = listSessionLogs(root)
  const idleMs = idleMinutes * 60_000
  const candidates = []
  let active = 0
  let done = 0
  for (const log of logs) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) break
    if (now - log.mtimeMs < idleMs) { active += 1; continue }
    if (hasCloseout(log.sessionId)) { done += 1; continue }
    candidates.push({ ...log, idleMs: now - log.mtimeMs })
  }
  candidates.sort((a, b) => b.idleMs - a.idleMs)
  return { scanned: logs.length, active, done, candidates }
}

/** 从事件序列里取最后一条 `turn/end` 的时间（ISO 或 epoch ms）。 */
export function lastTurnEndAt(events = []) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type !== 'turn/end') continue
    const t = e.time ?? e.ts ?? null
    if (t === null || t === undefined) continue
    return typeof t === 'number' ? new Date(t).toISOString() : String(t)
  }
  return null
}
