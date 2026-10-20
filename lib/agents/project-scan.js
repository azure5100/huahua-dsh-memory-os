// project-scan.js —— 流程视图**第 4 源：工作目录根扫描**（卡 E8）
//
// 背景：/flow 与 projectDetail 原先只认 3 个**登记源**（.agent-teams 团队工作区 ·
//   projects.jsonl 台账 · data/projects|orchestrator/teams 施工目录），**从不查工作目录** ⇒
//   主人用其它工具（如 Claude Code）做的真实项目完全不可见（首例 D:\Astock-trade-huahua：
//   该目录确有 L1 蓝图 + L2 施工文件，喂 classifyEvidence 会命中，只是**不在源集合内**）。
//
// 本模块是这第 4 源的**唯一 home**：候选判据、排除规则、缓存都在这里；阶段推断仍由
//   flow.js 的 classifyEvidence / inferStage 负责（**不新造阶段判据**，单一 home）。
//
// 判据（与卡 E8 逐字对应）：某目录**直接含** `L1_项目蓝图.md` **或** `L2_施工文件/` ⇒ 项目候选。
// 排除（防把归档/系统目录当项目——同族于 E7 抓到的「过期断言」教训）：
//   任一路径段命中 archive / _void* / _retired / .开头 / node_modules / 系统目录 ⇒ 跳过。
// 只读、零写入；扫描有缓存（TTL）+ 惰性（首次调用才扫），不得每次请求全盘扫。
import fs from 'node:fs'
import path from 'node:path'
import { defaultScanRoots } from './platform-paths.js'   // E131：扫描根默认值的**唯一 home**（平台中立）

/** 默认配置（**配置项定义**；实际取值经插件 config 覆盖，不硬编码在调用点）。 */
export const DEFAULT_SCAN = {
  enabled: true,
  roots: defaultScanRoots(),   // E131：平台中立（win32 = 现存盘符根 ⇒ 本机含 D:\ ⇒ 现机行为不变）
  maxDepth: 2,
  cacheTtlMs: 60_000,
  maxVisitedDirs: 20_000,
}

/** 候选标记（唯一 home；卡 E8 指定）。 */
export const SCAN_MARKERS = { file: 'L1_项目蓝图.md', dir: 'L2_施工文件' }

/** 排除：路径段整段匹配（不区分大小写）。 */
export const EXCLUDED_SEGMENTS = [
  'archive', 'node_modules', 'System Volume Information',
  '$RECYCLE.BIN', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData',
]

/** 排除：段名以这些前缀开头（.开头=隐藏目录；_void-* / _retired* 变体）。 */
export const EXCLUDED_PREFIXES = ['.', '_void', '_retired']

/** 单段是否被排除。 */
/** E8 表（原表，未增补）：排除名与前缀两族。A7 增补已于 2026-09-13 撤回（队长裁定：零名字黑名单）。 */
export function isExcludedSegment(seg) {
  const s = String(seg ?? '')
  if (!s) return false
  const low = s.toLowerCase()
  if (EXCLUDED_SEGMENTS.some((x) => x.toLowerCase() === low)) return true
  if (EXCLUDED_PREFIXES.some((p) => low.startsWith(p.toLowerCase()))) return true
  return false
}

/**
 * 路径是否命中排除。
 * @param {string} p 待判路径
 * @param {string|null} [root] 扫描根 —— **给了 root 就只判 root 之下的相对段**。
 * ⚠️ 不加 root 时判**整条绝对路径**，会把系统目录段（如 AppData）也算进去，导致
 *    「临时目录下的正常路径」被误判（本模块自带用例 ② 抓到过）。扫描主流程用的是
 *    `isExcludedSegment(子项名)`，只判**直接子项名**，故不受此影响。
 */
export function isExcludedPath(p, root = null) {
  let rel = String(p)
  if (root) {
    const r = path.resolve(String(root))
    const abs = path.resolve(String(p))
    rel = abs.startsWith(r) ? abs.slice(r.length) : abs
  }
  return rel.split(/[\\/]+/).filter(Boolean).some(isExcludedSegment)
}

/** 目录是否**直接**含候选标记；返回 {blueprint, build, hit, mtime}。 */
export function hasProjectMarker(dir) {
  let blueprint = false
  let build = false
  let mtime = null
  const fp = path.join(dir, SCAN_MARKERS.file)
  try { const st = fs.statSync(fp); if (st.isFile()) { blueprint = true; mtime = st.mtime.toISOString() } } catch { /* 无 */ }
  const dp = path.join(dir, SCAN_MARKERS.dir)
  try { const st = fs.statSync(dp); if (st.isDirectory()) { build = true; if (!mtime) mtime = st.mtime.toISOString() } } catch { /* 无 */ }
  return { blueprint, build, hit: blueprint || build, mtime }
}

/** 从插件 config 归一扫描配置（缺项回落 DEFAULT_SCAN）。 */
export function normalizeScanConfig(cfg = {}) {
  const rootsRaw = cfg.projectScanRoots ?? DEFAULT_SCAN.roots
  const roots = (Array.isArray(rootsRaw) ? rootsRaw : [rootsRaw])
    .map((r) => String(r ?? '').trim()).filter(Boolean)
  const depth = Number(cfg.projectScanDepth ?? DEFAULT_SCAN.maxDepth)
  const ttl = Number(cfg.projectScanCacheTtlMs ?? DEFAULT_SCAN.cacheTtlMs)
  return {
    enabled: cfg.projectScanEnabled === undefined ? DEFAULT_SCAN.enabled : cfg.projectScanEnabled === true,
    roots,
    maxDepth: Number.isInteger(depth) && depth >= 0 && depth <= 6 ? depth : DEFAULT_SCAN.maxDepth,
    cacheTtlMs: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_SCAN.cacheTtlMs,
    maxVisitedDirs: DEFAULT_SCAN.maxVisitedDirs,
  }
}

/**
 * 建扫描器（**惰性 + TTL 缓存**）。
 * @param {{enabled?:boolean, roots?:string[], maxDepth?:number, cacheTtlMs?:number, now?:Function, maxVisitedDirs?:number}} opts
 * @returns {{scan:Function, invalidate:Function, stats:Function, config:Function}}
 */
export function createProjectScanner(opts = {}) {
  const roots = (Array.isArray(opts.roots) && opts.roots.length ? opts.roots : DEFAULT_SCAN.roots).map((r) => path.resolve(String(r)))
  const cfg = {
    enabled: opts.enabled !== false,
    roots,
    maxDepth: Number.isInteger(opts.maxDepth) ? opts.maxDepth : DEFAULT_SCAN.maxDepth,
    cacheTtlMs: Number.isFinite(opts.cacheTtlMs) ? opts.cacheTtlMs : DEFAULT_SCAN.cacheTtlMs,
    maxVisitedDirs: Number.isInteger(opts.maxVisitedDirs) ? opts.maxVisitedDirs : DEFAULT_SCAN.maxVisitedDirs,
  }
  const clock = opts.now ?? (() => Date.now())
  let cache = null // { at, rows }
  let visits = 0

  function walkInto(dir, level, out, topName) {
    if (visits >= cfg.maxVisitedDirs) return
    visits += 1
    const mk = hasProjectMarker(dir)
    if (mk.hit) {
      // **项目名归属**：取扫描根下**第 1 层目录名**为项目名（= 用户口中的"那个项目"），
      // 标记所在目录只作施工目录。实证（2026-09-11 真机）：D:\\Astock-trade-huahua 自己
      // 不含标记，标记在 D:\\Astock-trade-huahua\\huahua-trading\\ 内 ⇒ 若用标记目录 basename
      // 会产出项目名 "huahua-trading"，与卡面验收「D:\\Astock-trade-huahua 出现在列表」不符。
      // 标记直接落在第 1 层时 topName == basename(dir)，两种口径在此重合（无歧义）。
      const name = topName || (level === 0 ? path.basename(path.resolve(dir)) : path.basename(dir))
      out.push({ name, root: null, dir, dirs: [dir], depth: level, markers: { blueprint: mk.blueprint, build: mk.build }, mtime: mk.mtime })
    }
    if (level >= cfg.maxDepth) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (isExcludedSegment(e.name)) continue
      walkInto(path.join(dir, e.name), level + 1, out, topName || e.name)
    }
  }

  /** 真扫（冷路径）。 */
  function coldScan() {
    const t0 = clock()
    visits = 0
    const out = []
    for (const root of cfg.roots) {
      if (!fs.existsSync(root)) continue
      walkInto(root, 0, out)
    }
    // 同名归并：一个项目下可能有**多个**含标记的子目录 ⇒ 合成一条，dirs 全留（不丢证据）
    const byName = new Map()
    for (const r of out) {
      const cur = byName.get(r.name)
      if (!cur) { byName.set(r.name, { ...r }) } else if (!cur.dirs.includes(r.dir)) { cur.dirs.push(r.dir) }
    }
    const rows = [...byName.values()]
      .map((r) => ({ ...r, dirs: r.dirs.slice().sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { rows, ms: clock() - t0, visited: visits }
  }

  /** 取候选（缓存命中则零 IO）。@param {{fresh?:boolean}} [o] */
  function scan(o = {}) {
    if (!cfg.enabled) return { rows: [], mode: 'disabled', ms: 0, visitedDirs: 0 }
    const now = clock()
    if (!o.fresh && cache && (now - cache.at) < cfg.cacheTtlMs) {
      return { rows: cache.rows, mode: 'warm', ms: 0, visitedDirs: 0, ageMs: now - cache.at }
    }
    const r = coldScan()
    cache = { at: clock(), rows: r.rows }
    return { rows: r.rows, mode: 'cold', ms: r.ms, visitedDirs: r.visited }
  }

  function invalidate() { cache = null }
  function stats() { return { ...cfg, cached: !!cache, cachedRows: cache ? cache.rows.length : 0 } }
  function config() { return { ...cfg } }
  return { scan, invalidate, stats, config }
}
