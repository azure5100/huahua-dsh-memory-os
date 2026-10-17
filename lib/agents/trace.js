// huahua-os · 人事部融合 阶段 1A：lib/agents/trace.js —— access.jsonl 读侧（docs/89 §1.4/§3.1）
// 职责：读源 ~/.gbrain/agent-roles/data/access.jsonl（**读源不复制、永不 append**——事件流单一
//       真源，跨环境共用追加日志；本模块只 fs 读，QA S3 断言 read 侧不写）。
// 缓存：文件 size+mtimeMs 变化才重读（append-only 低频全量重读；行级 JSON 容错，旧行无
//       session_id 兼容——解析 `?? null` 不崩，docs/82 §3.3）。
// 零依赖；ESM。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expandHome } from './registry.js'

const HOME = os.homedir()
import { defaultAgentRolesRoot } from './platform-paths.js' // E157：gbrain 源根唯一 home
const DEFAULT_HR = () => defaultAgentRolesRoot()   // E157：唯一 home（原为本地各写一份）

/** access.jsonl 默认位（可被 agentsHrDir/agentsAccessPath 覆盖）。 */
export function defaultAccessPath(hrDir) {
  return path.join(hrDir || DEFAULT_HR(), 'data', 'access.jsonl')
}

/**
 * access 路径归一：显式 agentsAccessPath 优先（'~' 展开）；否则 agentsHrDir/data/access.jsonl；
 * 再否则默认 ~/.gbrain/agent-roles/data/access.jsonl。
 * @param {{ agentsAccessPath?: string|null, agentsHrDir?: string|null }} [cfg]
 */
export function resolveAccessPath(cfg = {}) {
  const explicit = cfg.agentsAccessPath && String(cfg.agentsAccessPath).trim()
  if (explicit) return expandHome(String(explicit).trim())
  const hr = cfg.agentsHrDir && String(cfg.agentsHrDir).trim()
  return defaultAccessPath(hr ? expandHome(String(hr).trim()) : DEFAULT_HR())
}

/** access 行 role → 纯 kebab role_key（'agents/<slug>' → '<slug>'；非 agents/ 前缀 → null）。 */
export function expertRoleKeyOf(role) {
  const s = String(role ?? '')
  const m = /^agents\/([a-z][a-z0-9-]*)$/.exec(s)
  return m ? m[1] : null
}

/**
 * **会话 id 归一函数**——spec 出处：docs/112 §一.2（AIMS 侧唯一实现 `lib/session-id.mjs`；
 * 本模块按同一语义本地复制，不跨仓 import——docs/62 边界；两侧一致性由 parity 断言守护）。
 *
 * 规范形式 = **去 `session-` 前缀**（裸 uuid）：库内多数形态（1585/1609）与导入器按目录名入库的
 * 历史形态一致，迁移面最小。只剥前缀，不做任何其它改写（不改大小写/不去连字符/不做 uuid 校验）——
 * "顺手清洗"可能把两个不同 id 折叠成一个。
 *
 * t28 修订：t27 曾取「加前缀」（规范 session-<uuid>）+ 写侧归一，但 AIMS 侧未同步迁移 ⇒ 同一会话
 * 「裸 uuid 行（导入器）+ 前缀行（register）」并存（实测 pairs=6、重复链 6 条）。现与 AIMS 侧统一为
 * 去前缀，且迁移先行（scripts/session-id-norm.mjs）后写侧才启用归一口径。
 * @param {string} v 任意形态会话 id
 * @returns {string} 去前缀后的规范 id（非前缀形态原样返回）| ''（空输入）
 */
export function normalizeSessionId(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/** 解析 access 全文 → 全部合法行（含无 session_id 旧行；行级容错跳过坏行；附归一 id 供 1:1 对拍）。 */
function parseAccessLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    let o
    try { o = JSON.parse(t) } catch { continue }
    const role = String(o.role ?? '')
    out.push({
      role,
      role_key: expertRoleKeyOf(role) ?? null,
      ts: o.ts ?? null,
      project: o.project ?? null,
      session_id: o.session_id ?? null,
      session_id_norm: o.session_id ? normalizeSessionId(o.session_id) : null,
      action: o.action ?? null,
    })
  }
  return out
}

/**
 * access 读侧工厂。
 * @param {{ accessPath?: string }} [opts] accessPath 缺省 → 默认位（见 resolveAccessPath）
 * @returns {{ accessPath, sessionActivations, expertOf, hasExpertTrace, health, _test: { reload } }}
 */
export function createTrace(opts = {}) {
  const accessPath = opts.accessPath ? expandHome(String(opts.accessPath).trim()) : defaultAccessPath()

  let cacheKey = null
  let bySession = new Map() // session_id → [{ role, role_key, ts, project, session_id, raw }]
  let total = 0
  let error = null

  const statKey = () => {
    try {
      const st = fs.statSync(accessPath)
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }

  /** 全量重读（文件变化才执行；行级容错）。 */
  function reload() {
    const k = statKey()
    if (k === cacheKey) return bySession
    cacheKey = k
    bySession = new Map()
    total = 0
    error = null
    if (k === 'missing') {
      error = `access.jsonl 不存在（${accessPath}）——read 侧降级：expert 判据 b 无证据（docs/89 R4 → 判据 a 兜底）`
      return bySession
    }
    try {
      for (const row of parseAccessLines(fs.readFileSync(accessPath, 'utf8'))) {
        const sid = row.session_id
        if (!sid) continue // 旧行无 session_id：无法关联会话 → 忽略（docs/72 §1.1 兼容；all() 全量含旧行）
        total += 1
        // t27：按**归一键**分组（裸 uuid 与 session-<uuid> 同桶）——M1 1:1 对拍成立的前提
        const key = normalizeSessionId(sid)
        const arr = bySession.get(key)
        if (arr) arr.push(row)
        else bySession.set(key, [row])
      }
    } catch (e) {
      error = `access 读取失败: ${e.message}`
    }
    return bySession
  }

  /** 该会话全部 access 行（含非 agents/* 行；无则空数组；入参裸 uuid / session-<uuid> 均可）。 */
  function sessionActivations(sessionId) {
    if (!sessionId) return []
    const map = reload()
    const key = normalizeSessionId(sessionId)
    const hit = map.get(key)
    if (hit) return hit
    return map.get(String(sessionId)) ?? [] // 非 uuid 形态（如 'import-xxx'）按原值兜底
  }

  /**
   * 专家判定 b（docs/72 §二）：会话在 access.jsonl 有 `agents/<slug>` 行 = 走人事部流程硬证据。
   * @param {string} sessionId
   * @returns {{ role_key:string, role:string, ts:string|null, project:string|null } | null} 最近一条；无 → null
   */
  function expertOf(sessionId) {
    const rows = sessionActivations(sessionId)
    if (!rows.length) return null
    const experts = rows.filter((r) => r.role_key)
    if (!experts.length) return null
    const sorted = [...experts].sort((a, b) => {
      const ta = a.ts ? Date.parse(a.ts) : 0
      const tb = b.ts ? Date.parse(b.ts) : 0
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })
    const top = sorted[0]
    return { role_key: top.role_key, role: top.role, ts: top.ts, project: top.project }
  }

  /** 专家判据 b 布尔（observe 短路用）。 */
  function hasExpertTrace(sessionId) {
    return expertOf(sessionId) !== null
  }

  /**
   * 全量时间线（GET /access 语义，t10 契约）：含无 session_id 旧行；每次现读现滤（不污染会话缓存）。
   * @param {{ role?: string, since?: string, limit?: number }} [f]
   *   role：'agents/<slug>' / '<slug>'（归一匹配）；since：ISO 起（ts >= since，Date.parse）；limit：截断（≤1000）
   * @returns {Array<{role:string, role_key:string|null, ts:string|null, project:string|null, session_id:string|null, action?:string|null}>}
   */
  function all(f = {}) {
    let rows = []
    try {
      if (statKey() === 'missing') return rows
      rows = parseAccessLines(fs.readFileSync(accessPath, 'utf8'))
    } catch { return rows }
    const role = String(f.role ?? '').trim()
    if (role) {
      const want = role.replace(/^agents\//, '')
      rows = rows.filter((r) => (r.role_key ?? '') === want || (r.role ?? '').replace(/^agents\//, '') === want)
    }
    const since = f.since ? Date.parse(String(f.since)) : NaN
    if (Number.isFinite(since)) rows = rows.filter((r) => (r.ts ? Date.parse(r.ts) : 0) >= since)
    // 时间倒序（新在前）
    rows.sort((a, b) => (b.ts ? Date.parse(b.ts) : 0) - (a.ts ? Date.parse(a.ts) : 0))
    if (Number.isInteger(f.limit) && f.limit > 0) rows = rows.slice(0, Math.min(f.limit, 1000))
    return rows
  }

  /** trace 健康摘要（只读侧状态；不写）。 */
  function health() {
    reload()
    return { accessPath, ok: cacheKey !== 'missing' && !error, total, error }
  }

  return { accessPath, sessionActivations, expertOf, hasExpertTrace, all, health, _test: { reload, parseAccessLines, bySessionOf: () => bySession } }
}
