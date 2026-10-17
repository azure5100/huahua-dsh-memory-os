// project-registry.js —— 「入口门禁」登记数据面（卡 E9 · 按 A3 设计 · S1+S2）
//
// 命名说明：人事部**角色副本** registry 已在 lib/agents/registry.js（t9）⇒ 本模块另起名 `project-registry`。
//   两者语义不同：前者 = 角色副本目录索引；后者 = **项目存在性登记**。
//
// 边界（严格守住 A3 §5.6.3）：本模块只提供 **只读校验 + 登记写路径 + 数据面**。
//   · **不阻断任何现有流程**（S3 观察 / S4 强制 = 需批准门行，本卡不启用）。
//   · 门禁开关 registrationGateEnabled **默认 false** ⇒ 门禁对现有流程不可见。
//   · 唯一写路径 = 登记 CLI（scripts/agents-register.mjs）；**读侧永不产生 registered**。
//
// 单一 home：registry.jsonl（登记）· gate-checks.jsonl（审计）· 默认值在本文件 REGISTRY_DEFAULTS。
//
// 吸收 A3 复核 4 条硬性输入（Q8）：
//   (A) ①改名→stale/vanished ②同名多根→root_dirs[] + detectRootConflict ③借壳→supersedes/generation
//   (B) registered 判据并入「root 真实存在」+「与源内 dirs 一致」（不得只验字段存在）
//   (C) 落点 ~/.gbrain/agent-roles/data 已加入 E5 prod-guard prodFaces()
//   (D) 修法指向的 scripts/agents-register.mjs 本卡已落地 ⇒ 指路有效
import { ensureAgentRolesDir } from './platform-paths.js' // E157：建档分流（显式配置缺失 ⇒ 拒写；默认缺失 ⇒ 创建 + notice）
import fs from 'node:fs'
import path from 'node:path'

/** 默认值（**唯一 home**）。 */
export const REGISTRY_DEFAULTS = {
  enabled: false,
  enforce: false,
  registryFile: null,
  gateChecksFile: null,
}

/** 必填字段（A3 §5.1.2 七项；缺一 ⇒ orphan）。 */
export const REQUIRED_FIELDS = ['project_id', 'project_name', 'root_dirs', 'origin_agent', 'session_id', 'registered_at', 'registered_by']

/** E_NO_PROJECT_ID 的修法文本（**当下可执行** —— 指向本卡已落地的 CLI）。 */
export const FIX_HINT = 'node scripts/agents-register.mjs register --name <项目名> --root <项目根绝对路径> --agent <claude|codex|opencode|hermes|dsh> --session <会话 id> --by agents/<角色>'

export function projectIdOf(name) { return String(name ?? '').trim() }
export function registryPath(hrDir) { return path.join(String(hrDir), 'data', 'registry.jsonl') }
export function gateChecksPath(hrDir) { return path.join(String(hrDir), 'data', 'gate-checks.jsonl') }

export function readRegistry(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

export function appendRegistry(file, rec) {
  try {
    // ★ E157（队长裁定）：建档**分流 + 明示** —— 显式配置路径缺失 ⇒ 拒写并报错；默认 home 路径缺失 ⇒ 创建并带 notice
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) {
      const res = ensureAgentRolesDir(dir)
      if (!res.ok) return { ok: false, code: res.code, reason: res.reason }
      if (res.notice) return { ok: true, created: true, notice: res.notice }
    }
    fs.writeFileSync(file, JSON.stringify(rec) + '\n', { encoding: 'utf8', flag: 'a' })
    return { ok: true }
  } catch (e) { return { ok: false, reason: String(e?.message ?? e) } }
}

export function appendGateCheck(file, rec) { return appendRegistry(file, rec) }

export function rootDirsOf(rec) {
  if (Array.isArray(rec?.root_dirs) && rec.root_dirs.length) return rec.root_dirs.map((d) => String(d).trim()).filter(Boolean)
  if (typeof rec?.root_dir === 'string' && rec.root_dir.trim()) return [rec.root_dir.trim()]
  return []
}

/**
 * 解析登记状态（**纯函数**；磁盘探测经 opts.exists 注入 ⇒ 可测、零隐式 IO）。
 * status ∈ discovered | registered | orphan | stale | vanished | revoked
 */
export function resolveRegistration(o) {
  const id = projectIdOf(o.projectId)
  const exists = o.exists ?? ((p) => { try { return fs.existsSync(p) } catch { return false } })
  const srcDirs = (o.sourceDirs ?? []).map(String)
  const entries = o.entries ?? []
  const hits = entries.filter((r) => projectIdOf(r.project_id) === id)
  if (!hits.length) return { status: 'discovered', reason: 'registry 无此 project_id' }
  const last = hits[hits.length - 1]
  if (last.revoked_at) return { status: 'revoked', reason: '最后一行是撤销记录', row: last }
  const sup = entries.find((r) => projectIdOf(r.supersedes) === id && Number(r.generation ?? 0) > Number(last.generation ?? 0))
  if (sup) return { status: 'orphan', reason: '已被更新的 generation=' + sup.generation + ' 取代（owner=' + sup.project_id + '）', row: last }
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = f === 'root_dirs' ? rootDirsOf(last) : last[f]
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  })
  if (missing.length) return { status: 'orphan', reason: 'registry 行不完整（缺 ' + missing.join('/') + '）⇒ 不得当 registered', row: last }
  const roots = rootDirsOf(last)
  const alive = roots.filter((d) => exists(d))
  if (alive.length === 0) return { status: 'vanished', reason: '登记的所有 root 均不存在（项目被删/移动？）', row: last }
  const consistent = srcDirs.length === 0 ? true : alive.some((d) => srcDirs.some((s) => path.resolve(s) === path.resolve(d)))
  if (!consistent) return { status: 'stale', reason: '登记 root 与源内 dirs 不一致（换根未重登记？）', row: last }
  return { status: 'registered', reason: '必要条件齐备 ∧ root 真实存在 ∧ 与源内 dirs 一致', registration: {
    status: 'registered', registered_at: last.registered_at, registered_by: last.registered_by,
    origin_agent: last.origin_agent, root_dirs: roots, source: last.source ?? null, generation: last.generation ?? 1 } }
}

/**
 * 门禁判定（**纯函数**；本卡不接入任何现有流程的拦截）。
 * @returns {{ok:boolean, status:string, code?:string, message?:string, gate:'on'|'off'}}
 */
export function checkGate(o) {
  const action = o.action ?? '阶段文档写入'
  const id = projectIdOf(o.projectId)
  if (o.enabled !== true) return { ok: true, status: 'gate-off', gate: 'off', reason: '门禁开关关闭 ⇒ 门禁消失' }
  const st = resolveRegistration(o)
  if (st.status === 'registered') return { ok: true, status: 'registered', gate: 'on', reason: st.reason, registration: st.registration }
  const message = '拒（' + action + '）：项目「' + (id || '(未命名)') + '」未登记（registration_status=' + st.status + '）。修法：先登记 —— ' + FIX_HINT + '；登记后本动作方可执行。'
  return { ok: false, status: st.status, gate: 'on', code: 'E_NO_PROJECT_ID', message, detail: st }
}

/** 登记冲突检测（A② 同名多根）：同一 root 已被别的 project_id 占有 ⇒ 报冲突。 */
export function detectRootConflict(entries, projectId, rootDirs) {
  const id = projectIdOf(projectId)
  const out = []
  for (const r of entries ?? []) {
    const other = projectIdOf(r.project_id)
    if (!other || other === id || r.revoked_at) continue
    for (const d of rootDirsOf(r)) {
      if ((rootDirs ?? []).some((x) => path.resolve(String(x)) === path.resolve(d))) out.push({ root: d, owner: other })
    }
  }
  return out
}
