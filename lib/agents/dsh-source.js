// dsh-source.js —— 流程视图**第 5 源：DSH 自身会话**（卡 A5 · M6-1）
//
// 背景：DSH 的会话落在 `<DSH_HOME>/sessions/<project-slug>/<sessionId>/session.jsonl.zstd`，
//   slug 是**编码后的绝对路径**（连字符既作分隔符又出现在目录名里）⇒ **不可解码**：
//   实测朴素解码 6/6 全错（A5 装置 §4，如 `.dsh/dsh-chat` 被劈成 `.dsh/dsh/chat`）。
//   ⇒ **权威 cwd 只有一个来源 = 会话第一帧的 `cwd` 字段**（不推断、不解码）。
//
// 不造第二套（本项目已立纪律）：
//   · 会话枚举与**多帧 zstd 切帧** 复用 lib/aims/log-scan.js（listSessionLogs / scanZstdFrames / sessionsRoot）；
//   · **排除规则**复用 lib/agents/project-scan.js 的 isExcludedPath（同一张表，不另立）。
//
// 成本分层：只读每个会话文件**前 PREFIX_BYTES 字节**（第一帧必在其内），不解压整文件；TTL 缓存防每次请求全盘读。
// 只读、零写入。默认 **enabled:false** ⇒ 未显式开启时对既有输出**零影响**（A5 判据②）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { listSessionLogs, scanZstdFrames, sessionsRoot } from '../aims/log-scan.js'
import { isExcludedPath, DEFAULT_SCAN } from './project-scan.js'

/** 默认配置（**配置项定义**；实际取值经插件 config 覆盖，不硬编码在调用点）。 */
export const DEFAULT_DSH_SOURCE = {
  enabled: false,          // 默认关：未显式开启时对既有输出零影响
  cacheTtlMs: 60_000,
  prefixBytes: 262_144,    // 只读前 256 KB（第一帧必在其内）
  maxSessions: 2_000,
}

/** 从插件 config 归一（缺项回落 DEFAULT_DSH_SOURCE）。 */
export function normalizeDshConfig(cfg = {}) {
  const ttl = Number(cfg.dshSessionsCacheTtlMs ?? DEFAULT_DSH_SOURCE.cacheTtlMs)
  return {
    enabled: cfg.dshSessionsEnabled === undefined ? DEFAULT_DSH_SOURCE.enabled : cfg.dshSessionsEnabled === true,
    cacheTtlMs: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_DSH_SOURCE.cacheTtlMs,
    prefixBytes: DEFAULT_DSH_SOURCE.prefixBytes,
    maxSessions: DEFAULT_DSH_SOURCE.maxSessions,
  }
}

/**
 * 取一个会话文件的**权威 cwd**：只读前缀 → 复用 scanZstdFrames 切帧 → 只解**第一帧** → 取 cwd 字段。
 * @returns {{ok:boolean, cwd?:string, why?:string}}
 */
export function headCwd(file, prefixBytes = DEFAULT_DSH_SOURCE.prefixBytes) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(prefixBytes)
  let n = 0
  try { n = fs.readSync(fd, buf, 0, prefixBytes, 0) } finally { fs.closeSync(fd) }
  const bounds = scanZstdFrames(buf.subarray(0, n))   // ← 单一 home，不另造帧切分
  if (!bounds.length) return { ok: false, why: 'no-frame-in-prefix' }
  const [s, e] = bounds[0]
  let text = ''
  try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch (err) { return { ok: false, why: 'decode-fail' } }
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o.cwd === 'string' && o.cwd) return { ok: true, cwd: o.cwd }
    } catch { /* 非 JSON 行跳过 */ }
  }
  return { ok: false, why: 'no-cwd-in-first-frame' }
}

/**
 * 建 DSH 源（**惰性 + TTL 缓存**）。
 * @param {{enabled?:boolean, cacheTtlMs?:number, roots?:string, now?:Function}} [opts]
 * @returns {{scan:Function, invalidate:Function, stats:Function, config:Function}}
 */

/**
 * 项目归属判定（A5R · 落队长裁定② + 统一边界口径）。
 *
 * **只有两种来源可成为项目**：
 *   (i)  **扫描根内**：cwd 落在某个扫描根之下 ⇒ 归并到**该根下第 1 层目录名**（= E8 的项目名口径），
 *        且**该第 1 层目录必须存在**；**cwd 恰等于扫描根 ⇒ 无归属**（**不得造以根为名的假项目**）。
 *   (ii) **扫描根外**：cwd 不在任何扫描根之下 ⇒ **自成项目**（名 = cwd basename），**来源标 `cwd`**。
 * 其余（**目录不存在** / 第 1 层目录不存在 / cwd == 扫描根）⇒ 无项目归属，**不造项目**。
 *
 * @param {string} cwd 会话的权威 cwd（来自会话第一帧，**不是**由 slug 解码）
 * @param {string[]} roots 扫描根（单一 home = project-scan.js 的 DEFAULT_SCAN.roots）
 * @param {(p:string)=>boolean} [exists] 存在性判定（可注入，便于夹具）
 * @returns {{ok:true,name:string,source:'e8-merge'|'cwd',firstDir?:string}|{ok:false,why:string}}
 */
export function resolveProjectName(cwd, roots, exists = fs.existsSync) {
  const abs = path.resolve(String(cwd))
  if (!exists(abs)) return { ok: false, why: 'dir-not-exist' }
  const segs = (Array.isArray(roots) ? roots : []).map((r) => path.resolve(String(r)))
  for (const root of segs) {
    const rel = path.relative(root, abs)
    if (rel === '') return { ok: false, why: 'cwd-is-scan-root' }
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    const seg = rel.split(path.sep).filter(Boolean)[0]
    if (!seg) return { ok: false, why: 'cwd-is-scan-root' }
    const firstDir = path.join(root, seg)
    if (!exists(firstDir)) return { ok: false, why: 'first-level-dir-not-exist' }
    return { ok: true, name: seg, source: 'e8-merge', firstDir }
  }
  const base2 = path.basename(abs)
  if (!base2) return { ok: false, why: 'no-basename' }
  return { ok: true, name: base2, source: 'cwd' }
}

export function createDshSource(opts = {}) {
  const cfg = {
    enabled: opts.enabled !== false && opts.enabled !== undefined ? opts.enabled === true : DEFAULT_DSH_SOURCE.enabled,
    cacheTtlMs: Number.isFinite(opts.cacheTtlMs) ? opts.cacheTtlMs : DEFAULT_DSH_SOURCE.cacheTtlMs,
    prefixBytes: Number.isInteger(opts.prefixBytes) ? opts.prefixBytes : DEFAULT_DSH_SOURCE.prefixBytes,
    maxSessions: Number.isInteger(opts.maxSessions) ? opts.maxSessions : DEFAULT_DSH_SOURCE.maxSessions,
  }
  const root = opts.sessionsRoot ?? sessionsRoot()
  // 扫描根（裁定②要用它判「cwd 在不在扫描根之下」）—— **单一 home = E8 的 DEFAULT_SCAN.roots**
  const scanRoots = (Array.isArray(opts.scanRoots) && opts.scanRoots.length ? opts.scanRoots : DEFAULT_SCAN.roots)
    .map((r) => path.resolve(String(r)))
  const clock = opts.now ?? (() => Date.now())
  let cache = null

  function coldScan() {
    const t0 = clock()
    const logs = listSessionLogs(root).slice(0, cfg.maxSessions)
    const bySlug = new Map()
    for (const l of logs) {
      if (!bySlug.has(l.slug)) bySlug.set(l.slug, [])
      bySlug.get(l.slug).push(l)
    }
    const rows = []
    const skipped = { noCwd: 0, excluded: 0 }
    for (const [slug, arr] of bySlug) {
      const latest = arr.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      let h
      try { h = headCwd(latest.file, cfg.prefixBytes) } catch { h = { ok: false, why: 'read-fail' } }
      if (!h.ok) { skipped.noCwd++; continue }
      // **排除规则复用 project-scan.js 的同一张表**（不另立）
      if (isExcludedPath(h.cwd)) { skipped.excluded++; continue }
      // A5R：归属判定（归并到 E8 项目 / 根外自成项目 / 无归属）
      const res = resolveProjectName(h.cwd, scanRoots)
      if (!res.ok) { skipped[res.why] = (skipped[res.why] || 0) + 1; continue }
      rows.push({
        name: res.name,
        source: res.source,
        cwd: h.cwd,
        slug,
        sessions: arr.length,
        latestMtimeMs: Math.max.apply(null, arr.map((x) => x.mtimeMs)),
        // 归并来源 ⇒ dirs 指向**扫描根下第 1 层目录**（= E8 的项目根，避免与第 4 源重复计入）
        // 根外来源 ⇒ dirs 指向 cwd 自身
        dirs: [path.normalize(res.firstDir || h.cwd)],
      })
    }
    // 同名归并（同一 cwd 的多个 slug，或不同目录同名）⇒ 合成一条，dirs 全留
    const byName = new Map()
    for (const r of rows) {
      const cur = byName.get(r.name)
      if (!cur) { byName.set(r.name, r) } else {
        cur.sessions += r.sessions
        if (r.latestMtimeMs > cur.latestMtimeMs) cur.latestMtimeMs = r.latestMtimeMs
        for (const d of r.dirs) if (!cur.dirs.includes(d)) cur.dirs.push(d)
      }
    }
    const out = [...byName.values()].map((r) => ({ ...r, dirs: r.dirs.slice().sort() })).sort((a, b) => a.name.localeCompare(b.name))
    return { rows: out, ms: clock() - t0, slugs: bySlug.size, logs: logs.length, skipped }
  }

  function scan(o = {}) {
    if (!cfg.enabled) return { rows: [], mode: 'disabled', ms: 0, slugs: 0, logs: 0, skipped: { noCwd: 0, excluded: 0 } }
    const now = clock()
    if (!o.fresh && cache && (now - cache.at) < cfg.cacheTtlMs) {
      return { rows: cache.rows, mode: 'warm', ms: 0, ageMs: now - cache.at, slugs: cache.slugs, logs: cache.logs, skipped: cache.skipped }
    }
    const r = coldScan()
    cache = { at: clock(), rows: r.rows, slugs: r.slugs, logs: r.logs, skipped: r.skipped }
    return { rows: r.rows, mode: 'cold', ms: r.ms, slugs: r.slugs, logs: r.logs, skipped: r.skipped }
  }

  function invalidate() { cache = null }
  function stats() { return { ...cfg, root, cached: !!cache, cachedRows: cache ? cache.rows.length : 0 } }
  function config() { return { ...cfg, root } }
  return { scan, invalidate, stats, config }
}
