// huahua-os · 人事部融合 阶段 1A：lib/agents/registry.js —— 副本目录层读取（docs/89 §3.1）
// 职责：唯一数据源 = 仓库副本 agents/（role-index.json + source/<dept>/<name>.md），
//       只读副本、绝不读/写源三目录（docs/87 决策 4A 红线；QA S2 断言）。
// 缓存：MANIFEST.json (size+mtimeMs) 变化才重读 role-index.json（低频重扫纪律，docs/89 §3.1）。
// 零依赖；ESM；agent 条目字段对齐 docs/89 §2.1。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()

/** 副本默认位 = <memory-evolve 仓库根>/agents（docs/89 §1.1；符号链接安装态等价源，docs/62）。 */
export function defaultAgentsDir() {
  return path.resolve(__dirname, '..', '..', 'agents')
}

/** '~' 展开（win/posix 双斜杠兼容）。 */
export function expandHome(p) {
  const s = String(p ?? '')
  if (!s) return s
  if (s === '~') return HOME
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(HOME, s.slice(2))
  return s
}

/** agentsDir 归一：空 → 仓库根 agents/；'~' 展开；相对路径按仓库根解析。 */
export function resolveAgentsDir(agentsDir) {
  const raw = agentsDir && String(agentsDir).trim() ? String(agentsDir).trim() : defaultAgentsDir()
  const expanded = expandHome(raw)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(defaultAgentsDir(), '..', expanded)
}

const DESC_MAX = 200 // role-index desc 截断（docs/89 §2.1「description 截断」；UI snippet 用）
const BODY_PREVIEW_MAX = 600 // roleDefinition 正文预览上限

/**
 * frontmatter 极简解析（--- 首块内 `k: v` 行；docs/89 §2.1 字段 name/description/emoji/color）。
 * 兼容：无 frontmatter → 空对象 + 全文作 body；值去包裹引号；多行块取首行。
 * @param {string} text md 全文
 * @returns {{ frontmatter: Record<string,string>, body: string }}
 */
export function parseFrontmatter(text) {
  const fm = {}
  const src = String(text ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!m) return { frontmatter: fm, body: src.slice(0, BODY_PREVIEW_MAX) }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = String(kv[2]).trim().replace(/^["']|["']$/g, '')
  }
  return { frontmatter: fm, body: src.slice(m[0].length).trim().slice(0, BODY_PREVIEW_MAX) }
}

const trunc = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const humanize = (key) => String(key).replace(/[-_]+/g, ' ').trim() || key

/**
 * 由一份角色 md（file = 相对 source/ 的路径，如 marketing/xx.md）派生 role-index 条目。
 * 副本自举生成与 registry 读取共用同一派生函数——md ↔ 索引 1:1（消灭源侧 N2 漂移）。
 * @param {string} file source 相对路径（/ 分隔）
 * @param {string} text md 全文
 * @returns {{slug:string, role_key:string, name:string, dept:string, desc:string, emoji:string, color:string, file:string}}
 */
export function deriveEntry(file, text) {
  const rel = String(file).replace(/\\/g, '/')
  const dept = rel.split('/')[0] ?? ''
  const stem = path.posix.basename(rel, '.md')
  const { frontmatter } = parseFrontmatter(text)
  const name = trunc(frontmatter.name, 80) || humanize(stem)
  return {
    slug: `agents/${stem}`,
    role_key: stem,
    name,
    dept,
    desc: trunc(frontmatter.description, DESC_MAX),
    emoji: frontmatter.emoji ?? '',
    color: frontmatter.color ?? '',
    file: rel,
  }
}

/** 归一角色键：'agents/<slug>' | '<slug>.md' | '<dept>-<name>' → 纯 kebab role_key（与 routes.normalizeRoleKey 同口径）。 */
export function normalizeRoleKey(v) {
  let s = String(v ?? '').trim()
  if (!s) return ''
  s = s.replace(/^agents\//, '').replace(/\.md$/i, '')
  return /^[a-z][a-z0-9-]*$/.test(s) ? s : ''
}

/**
 * 副本 registry 工厂。
 * @param {{ agentsDir?: string }} [opts] agentsDir 缺省 → 仓库根 agents/
 * @returns {{ list, resolve, roleDefinition, roleIndex, health, agentsDir }}
 */
export function createRegistry(opts = {}) {
  const agentsDir = resolveAgentsDir(opts.agentsDir)
  const indexPath = path.join(agentsDir, 'role-index.json')
  const manifestPath = path.join(agentsDir, 'MANIFEST.json')

  let cacheKey = null
  let cache = { roles: [], manifest: null, error: null }

  const statKeyOf = (p) => {
    try {
      const st = fs.statSync(p)
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }
  // 缓存键 = MANIFEST + role-index 双 mtime/size（t22：自动同步先写 role-index 再写 MANIFEST，
  // 任一变化都应触发重读；只看 MANIFEST 在中断/半写场景会漏刷新）
  const manifestKey = () => `${statKeyOf(manifestPath)}|${statKeyOf(indexPath)}`

  /** 载入 role-index（MANIFEST 变化才重读；文件缺失/损坏 → 空表 + error，不 throw——调用方自行 503/降级）。 */
  function load() {
    const mk = manifestKey()
    if (mk === cacheKey && cache.roles.length >= 0) return cache
    cacheKey = mk
    cache = { roles: [], manifest: null, error: null }
    try {
      if (fs.existsSync(indexPath)) {
        const arr = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
        cache.roles = Array.isArray(arr) ? arr : []
      } else {
        cache.error = `副本索引缺失（${indexPath}）——先运行 node scripts/agents-sync.mjs --apply`
      }
      cache.manifest = fs.existsSync(manifestPath)
        ? (() => { try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { return null } })()
        : null
    } catch (e) {
      cache.error = `role-index 读取失败: ${e.message}`
    }
    return cache
  }

  /** 全量索引（已缓存；外部同批多次调用零 IO） */
  function roleIndex() {
    return load().roles
  }

  /**
   * 目录查询。
   * @param {{ q?: string, dept?: string, page?: number, pageSize?: number }} [f]
   * @returns {{ total:number, roles: object[], page:number, pageSize:number }}
   */
  function list(f = {}) {
    const q = String(f.q ?? '').trim().toLowerCase()
    const dept = String(f.dept ?? '').trim().toLowerCase()
    let rows = roleIndex()
    if (dept) rows = rows.filter((r) => String(r.dept ?? '').toLowerCase() === dept)
    if (q) {
      rows = rows.filter((r) =>
        [r.role_key, r.name, r.slug, r.desc, r.dept].some((v) => String(v ?? '').toLowerCase().includes(q)),
      )
    }
    const page = Number.isInteger(f.page) && f.page > 0 ? f.page : 1
    const pageSize = Number.isInteger(f.pageSize) && f.pageSize > 0 ? Math.min(f.pageSize, 500) : 24
    const start = (page - 1) * pageSize
    return { total: rows.length, page, pageSize, roles: rows.slice(start, start + pageSize) }
  }

  /** slug/role_key 双向解析（strip agents/ 前缀；大小写不敏感）；未命中 → null。 */
  function resolve(key) {
    const k = normalizeRoleKey(key)
    if (!k) return null
    return roleIndex().find((r) => r.role_key === k || r.slug === `agents/${k}` || String(r.slug ?? '') === String(key ?? '')) ?? null
  }

  /** 单角色详情：读副本 source/<file> 前段（正文预览 ≤600 字）；缺文件 → { entry, error }。 */
  function roleDefinition(roleKey) {
    const entry = resolve(roleKey)
    if (!entry) return { entry: null, error: `副本无此角色: ${roleKey}` }
    const fp = path.join(agentsDir, 'source', ...String(entry.file).split('/'))
    try {
      const { frontmatter, body } = parseFrontmatter(fs.readFileSync(fp, 'utf8'))
      return { entry, frontmatter, bodyPreview: body }
    } catch (e) {
      return { entry, error: `副本定义读取失败: ${e.message}` }
    }
  }

  /** 副本健康摘要（agentsEnabled UI 状态灯 / 503 引导用）。 */
  function health() {
    const c = load()
    const ok = !!c.manifest && c.roles.length > 0 && !c.error
    return {
      ok,
      agentsDir,
      total: c.roles.length,
      error: c.error,
      syncedAt: c.manifest?.syncedAt ?? null,
      source: c.manifest?.source ?? null,
      sourceCount: c.manifest?.sourceCount ?? null,
      copyCount: c.manifest?.copyCount ?? null,
      driftNote: c.manifest?.driftNote ?? null,
    }
  }

  return { agentsDir, list, resolve, roleDefinition, roleIndex, health, _test: { load } }
}
