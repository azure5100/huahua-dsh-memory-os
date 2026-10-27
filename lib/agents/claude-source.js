// claude-source.js —— A6 · Claude Code 接入闭环（**人事部侧** · 单一 home）
//
// 口径同源（A5 已裁 · 队长 2026-09-13 批准）：**项目标记不作准入** · **主键以 E8 为准（扫描根下第 1 层目录名）· cwd 须向上归并**。
// 门语义（队长裁定 · 加强）：**「无项目 id 不得写入」—— 不是「材料齐全才能写」** ⇒ **登记要尽量轻**。
//   · 被拦后**不允许**「先导入、标未登记、不进验收体系」（那会让门退化成**标注门**）。
// 两层准入（**已升为通则**）：**可见性准入 ≠ 验收准入**（**看得见 ≠ 可进验收**）。
// 边界（**改写后的口径**）：本卡**只做人事部侧**；**Claude 侧真正的必经点 = Claude Code 自身的 hook（那是「配置」不是「源码」）⇒ 另卡**。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRegistration, readRegistry, appendRegistry, appendGateCheck, registryPath, gateChecksPath, detectRootConflict, REQUIRED_FIELDS, FIX_HINT } from './project-registry.js'
import { guardProdWrite, ProdWriteBlockedError } from '../prod-guard.js'   // E5 硬护栏：写入口必过（E111）
import { isExcludedSegment } from './project-scan.js'   // A7：import E8 原表（排除表唯一 home），不复制第二份
import { defaultScanRoots, defaultAgentRolesRoot } from './platform-paths.js'   // E131：扫描根默认值**唯一 home**（原此处两处各写 ['D:\\']）

/** 默认 Claude Code 数据根（只读）。 */
export function claudeHome() { return path.join(os.homedir(), '.claude') }

/**
 * E8 主键：把任意 cwd 归并到「扫描根下第 1 层目录」。
 * 扫描根外 ⇒ 返回 { key: <basename 兜底>, source: 'cwd' }（自成项目并标注来源）。
 */
export function projectKeyOfCwd(cwd, roots = defaultScanRoots()) {
  const p = String(cwd || '').replace(/\\/g, '/')
  for (const r of roots) {
    const root = String(r).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!p.toLowerCase().startsWith(root.toLowerCase() + '/')) continue
    const rest = p.slice(root.length + 1).split('/').filter(Boolean)
    if (rest.length >= 1) return { key: rest[0], source: 'scan-root', root, depth2: rest[1] || null }
  }
  const base = p.split('/').filter(Boolean).pop() || ''
  return { key: base, source: 'cwd', root: null, depth2: null }
}

/** 从 Claude 项目目录里取 cwd（读第一条含 cwd 的会话行；退化路径 = 目录名，标注 degraded）。 */
export function cwdOfClaudeProject(dir, readFileImpl) {
  const read = readFileImpl || ((f) => fs.readFileSync(f, 'utf8'))
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { return { cwd: null, degraded: true } }
  for (const f of files.slice(0, 3)) {
    try {
      for (const line of read(path.join(dir, f)).split('\n').slice(0, 20)) {
        if (!line.trim()) continue
        try { const o = JSON.parse(line); if (o && typeof o.cwd === 'string' && o.cwd) return { cwd: o.cwd, degraded: false } } catch { /* 跳畸形行 */ }
      }
    } catch { /* 读不到就下一个 */ }
  }
  return { cwd: null, degraded: true }
}

/**
 * 发现（**只读**）：列出本机 Claude Code 项目 ⇒ 每个给出 { dir, cwd, key, source, sessions }。
 * 不依赖人工登记（目标①）。
 */
export function discoverClaudeProjects(opts = {}) {
  const home = opts.claudeHome || claudeHome()
  const dir = path.join(home, 'projects')
  const roots = opts.roots || defaultScanRoots()
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(dir, e.name)
    let sessions = 0
    try { sessions = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')).length } catch { /* ignore */ }
    const got = cwdOfClaudeProject(full, opts.readFile)
    const cwd = got.cwd
    const k = cwd ? projectKeyOfCwd(cwd, roots) : { key: null, source: 'unresolved', root: null, depth2: null }
    out.push({ dir: full, dirName: e.name, cwd, cwdDegraded: got.degraded, key: k.key, source: k.source, root: k.root, sessions })
  }
  return out.sort((a, b) => String(a.key).localeCompare(String(b.key)))
}

/**
 * 三态（**机械可判** · 复用既有 registry 判定，**不另造词**）：
 *   linked（已登记 ∧ Claude 命中）· registered-only · discovered-only（未登记 ⇒ **不得算作已接入**）。
 */
export function linkStates(discovered, entries, opts = {}) {
  const byKey = new Map()
  for (const d of discovered) {
    if (!d.key) continue
    const cur = byKey.get(d.key) || { key: d.key, sources: new Set(), sessions: 0, dirs: [], roots: new Set() }
    cur.sources.add(d.source); cur.sessions += d.sessions; cur.dirs.push(d.dirName)
    // **归并后的项目根**（用于 resolveRegistration 的「与源内 dirs 一致」判定）：
    //   扫描根内 ⇒ root + 第 1 层目录名；扫描根外 ⇒ cwd 自身。（传目录名会让判定恒 stale —— 我第一版就错在这里。）
    if (d.source === 'scan-root' && d.root) cur.roots.add(String(d.root).replace(/\\/g, '/') + '/' + d.key)
    else if (d.cwd) cur.roots.add(String(d.cwd).replace(/\\/g, '/'))
    byKey.set(d.key, cur)
  }
  const rows = []
  for (const [key, v] of byKey) {
    const reg = resolveRegistration({ projectId: key, entries: entries || [], sourceDirs: [...v.roots], exists: opts.exists })
    const registered = reg.status === 'registered'
    rows.push({
      project: key, sessions: v.sessions, claudeDiscovery: true,
      registration_status: reg.status,
      state: registered ? 'linked' : 'discovered-only',
      source: [...v.sources].join('+'),
    })
  }
  for (const r of entries || []) {
    const id = String(r.project_id || '')
    if (!id || byKey.has(id)) continue
    const reg = resolveRegistration({ projectId: id, entries })
    if (reg.status === 'registered') rows.push({ project: id, sessions: 0, claudeDiscovery: false, registration_status: 'registered', state: 'registered-only', source: 'registry' })
  }
  return rows.sort((a, b) => a.project.localeCompare(b.project))
}

/**
 * 入口门禁（**S3 观察 / S4 拦**）。语义（队长裁定）：**「无项目 id 不得写入」** —— 不要求 7 字段齐备。
 * mode：off（未配置）| observe（S3 · 记但放行）| enforce（S4 · 拦）
 */
export function claudeIngestGate(input = {}) {
  const id = String(input.projectId || '').trim()
  const explicit = Object.prototype.hasOwnProperty.call(input, 'enabled')
  const enabled = (explicit ? input.enabled : false) === true
  const enforce = input.enforce === true
  const mode = !enabled ? 'off' : (enforce ? 'enforce' : 'observe')
  const rec = { gate: 'a6-claude-ingest', action: input.action || 'claude 会话写入人事部', project: id || null, mode, switch_source: explicit ? 'explicit' : 'default' }
  if (mode === 'off') { rec.ok = true; rec.skip_reason = '开关未开（未显式配置）⇒ 门未安装'; return { ok: true, mode, code: null, message: null, record: rec } }
  if (!id) {
    rec.ok = false; rec.code = 'E_NO_PROJECT_ID'
    const message = '拒：**无项目 id 不得写入**（A6 门语义）。修法：先登记 —— `node scripts/agents-register.mjs register --name <项目名> --root <项目根> --agent claude --session <会话 id> --by agents/<角色>`（**登记要尽量轻**：本门不要求材料齐全）。'
    rec.would_block = true
    return { ok: mode === 'observe', mode, code: 'E_NO_PROJECT_ID', message, record: rec }
  }
  rec.ok = true
  return { ok: true, mode, code: null, message: null, record: rec }
}

/** A7 分类（**不许静默过滤**）：每个归并键按「判据出处」分三类。 */
export function classifyKeys(rows) {
  const out = [], counts = { e8: 0, unknown: 0, admitted: 0 }
  for (const r of rows) {
    const seg = String(r.project || '')
    if (isExcludedSegment(seg)) { out.push({ project: seg, cls: 'E8 原表排除', judge: 'project-scan.isExcludedSegment（含 A7 新增两类）' }); counts.e8++; continue }
    if (r.source === 'cwd') { out.push({ project: seg, cls: 'A7UNKNOWN', judge: '扫描根外 cwd ∧ 未命中排除表 ⇒ 无判据可依（逐条打印、不排除）' }); counts.unknown++; continue }
    out.push({ project: seg, cls: '准入通过', judge: '扫描根第 1 层 ∧ 未命中排除表' }); counts.admitted++
  }
  return { rows: out, counts }
}

// ---------------------------------------------------------------- 写入口（E111 · M6）
// 背景（工程 2026-09-27 实测）：门（claudeIngestGate · 本文件 L114）与登记写路径
//   （appendRegistry · project-registry.js:46）在本仓 lib/** 内**零调用点** ⇒ **门在、没人走**。
// 本段把两者**接上线**：写入口 = 唯一登记写路径，门 = 它的**必经点**。
// 形态：纯函数 + 注入式 IO（registryFile / env / faces / exists 全可注入）⇒ 端点直接调、装置可在隔离面复跑。
// 三态（**机械可判**）：written（已写入并留痕）/ rejected（明确拒绝 + 可照抄修法）/ unjudgeable（**判不了** ⇒ 不写、不放行、不拒绝）。

/** 写入口三态（**唯一 home**；消费侧请 import，不要照抄字面量）。 */
export const INGEST_STATES = { WRITTEN: 'written', REJECTED: 'rejected', UNJUDGEABLE: 'unjudgeable' }

/** 写入口拒绝码（**唯一 home**）。 */
export const INGEST_CODES = {
  NO_PROJECT_ID: 'E_NO_PROJECT_ID',
  BAD_ARGS: 'E_BAD_ARGS',
  ROOT_CONFLICT: 'E_ROOT_CONFLICT',
  PROD_BLOCKED: 'E_PROD_WRITE_BLOCKED',
  WRITE_FAILED: 'E_WRITE_FAILED',
  NOT_ADOPTED: 'E_WRITE_NOT_ADOPTED',
  UNJUDGEABLE: 'E_UNJUDGEABLE',
}

/** 可照抄修法（与 project-registry.FIX_HINT **同源**，不重写第二份 —— 纪律：跨面字面量必须 import）。 */
export function ingestFixHint() { return '先登记 —— ' + FIX_HINT }

/**
 * 登记源可判性探针（**第三态的前置**）。
 * 缺文件 = 空表（**可判**：写入口会新建）；存在但是目录 / 不可读 = **判不了**（不得猜成「空表」）。
 */
export function probeRegistrySource(file) {
  try {
    const st = fs.statSync(file)
    if (st.isDirectory()) return { judgeable: false, reason: '登记源是目录（' + file + '）' }
    fs.accessSync(file, fs.constants.R_OK)
    return { judgeable: true, exists: true }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { judgeable: true, exists: false }
    return { judgeable: false, reason: '登记源不可判（' + ((e && e.code) || (e && e.message) || 'unknown') + '）' }
  }
}

/** 门禁审计留痕（同族纪律：留痕失败**不反噬**主流程 —— 与 flow.js 的 emitGateCheck 同款）。 */
function auditIngest(file, env, rec) {
  try { guardProdWrite(file, { action: '写门禁审计', env }); appendGateCheck(file, rec) } catch { /* 审计面被拒/不可写 ⇒ 不反噬 */ }
}

/**
 * E111 · 写入口：登记一个项目（**唯一写路径** = append-only 追加 registry.jsonl 一行）。
 * 判定顺序（**刻意**）：① 判不了（登记源不可判）⇒ ② 门（无项目 id）⇒ ③ 缺参 ⇒ ④ 根冲突 ⇒ ⑤ 生产面护栏 ⇒ ⑥ 写入 ⇒ ⑦ **采纳自证**。
 * @param {{projectId?:string, roots?:string|string[], agent?:string, sessionId?:string, by?:string, action?:string, gateEnabled?:boolean, gateEnforce?:boolean}} input
 * @param {{registryFile?:string, gateChecksFile?:string, hrDir?:string, env?:object, faces?:object[], exists?:Function, now?:Function}} [opts]
 * @returns {{ok:boolean, state:string, code:string|null, message:string|null, fix:string|null, record:object}}
 */
export function registerClaudeProject(input = {}, opts = {}) {
  const hrDir = opts.hrDir || defaultAgentRolesRoot()   // E157：唯一 home（原为本地各写一份）
  const file = opts.registryFile || registryPath(hrDir)
  const gateFile = opts.gateChecksFile || gateChecksPath(hrDir)
  const env = opts.env || process.env
  const now = opts.now || (() => new Date().toISOString())
  const id = String(input.projectId ?? '').trim()
  const roots = (Array.isArray(input.roots) ? input.roots : String(input.roots ?? '').split(','))
    .map((s) => String(s).trim()).filter(Boolean)
  const record = { gate: 'e111-ingest-register', action: input.action || '登记项目（写入口 POST /agents/register）', project: id || null, registry: file, branches: [] }
  const out = (state, code, message, extra = {}) => ({
    ok: state === INGEST_STATES.WRITTEN, state, code: code ?? null, message: message ?? null,
    fix: state === INGEST_STATES.REJECTED ? (extra.fix ?? null) : null,
    record: { ...record, ...(extra.record || {}) },
  })

  // ① 第三态前置：登记源不可判 ⇒ **不写、不放行、也不当「拒绝」**
  record.branches.push('probe')
  const probe = probeRegistrySource(file)
  if (!probe.judgeable) {
    return out(INGEST_STATES.UNJUDGEABLE, INGEST_CODES.UNJUDGEABLE, '判不了：' + probe.reason + ' ⇒ 不写入（既不放行也不拒绝）',
      { record: { judgeable: false, reason: probe.reason } })
  }
  record.registry_exists = probe.exists

  // ② 门（A6 · claudeIngestGate）：语义 = **无项目 id 不得写入**（不是「材料齐全才能写」）
  const gate = claudeIngestGate({ projectId: id, enabled: input.gateEnabled !== false, enforce: input.gateEnforce !== false, action: record.action })
  record.branches.push('gate')
  record.gate_mode = gate.mode
  record.gate_switch_source = gate.record.switch_source
  if (gate.ok === false) {
    return out(INGEST_STATES.REJECTED, gate.code, gate.message, { fix: ingestFixHint(), record: { blocked_by: 'gate' } })
  }
  if (!id) {
    // 硬规则（与门**同源、不受开关影响**）：无 id 的登记行在数据面上是坏行（REQUIRED_FIELDS 缺 project_id ⇒ orphan）
    const message = '拒：**无项目 id 不得写入**（写入口硬规则，不受开关影响）。修法：' + ingestFixHint()
    auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, blocked_by: 'hard-rule', code: INGEST_CODES.NO_PROJECT_ID })
    return out(INGEST_STATES.REJECTED, INGEST_CODES.NO_PROJECT_ID, message, { fix: ingestFixHint(), record: { blocked_by: 'hard-rule' } })
  }

  // ③ 缺参（**空值必须显式拒绝，不得静默写占位** —— E68 §F1 的同形门，本处是**端点侧**）
  record.branches.push('args')
  const missing = []
  if (!roots.length) missing.push('roots')
  if (!input.agent) missing.push('agent')
  if (!input.sessionId) missing.push('sessionId')
  if (!input.by) missing.push('by')
  if (missing.length) {
    const message = '拒：缺参数 ' + missing.join(' / ') + '（空值不得静默落库）。修法：见 ' + REQUIRED_FIELDS.join(',') + ' —— ' + ingestFixHint()
    auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, blocked_by: 'args', code: INGEST_CODES.BAD_ARGS })
    return out(INGEST_STATES.REJECTED, INGEST_CODES.BAD_ARGS, message, { fix: ingestFixHint(), record: { blocked_by: 'args', missing } })
  }

  // ④ 根冲突（A② 同名多根）
  const entries = readRegistry(file)
  record.entries_before = entries.length
  const conflicts = detectRootConflict(entries, id, roots)
  if (conflicts.length) {
    const message = '拒：登记冲突 —— 根 ' + JSON.stringify(conflicts) + ' 已被别的项目登记。修法：先 revoke 占用方，或确认 root 是否填错。'
    auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, blocked_by: 'conflict', code: INGEST_CODES.ROOT_CONFLICT })
    return out(INGEST_STATES.REJECTED, INGEST_CODES.ROOT_CONFLICT, message, { fix: '先 revoke 占用方，或确认 root 是否填错', record: { blocked_by: 'conflict', conflicts } })
  }

  // ⑤ 生产面硬护栏（E5）：登记面是生产面 ⇒ 未在宿主显式声明即拒（fail-closed）
  record.branches.push('prod-guard')
  try {
    guardProdWrite(file, { action: '登记项目（写入口）', env, faces: opts.faces })
  } catch (e) {
    if (e instanceof ProdWriteBlockedError) {
      auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, blocked_by: 'prod-guard', code: INGEST_CODES.PROD_BLOCKED })
      return out(INGEST_STATES.REJECTED, INGEST_CODES.PROD_BLOCKED, e.message,
        { fix: '在宿主环境显式声明 AIMS_ALLOW_PROD=1（或把写入重定向到隔离面）', record: { blocked_by: 'prod-guard', prod_face: e.face ? e.face.root : null } })
    }
    throw e
  }

  // ⑥ 写入（append-only；撤销也是追加一行 ⇒ 读侧取末行）
  const rec = {
    project_id: id, project_name: id, root_dirs: roots, origin_agent: String(input.agent),
    session_id: String(input.sessionId), registered_at: now(), registered_by: String(input.by),
    source: 'write-entry(E111)', generation: entries.filter((r) => String(r.project_id) === id).length + 1,
  }
  record.branches.push('append')
  const w = appendRegistry(file, rec)
  if (!w.ok) {
    auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, blocked_by: 'write', code: INGEST_CODES.WRITE_FAILED, reason: w.reason })
    return out(INGEST_STATES.REJECTED, INGEST_CODES.WRITE_FAILED, '写入失败：' + w.reason,
      { fix: '确认登记表目录可写：' + path.dirname(file), record: { blocked_by: 'write' } })
  }

  // ⑦ 采纳自证（**防「写了但机制没生效」**）：回读 + resolveRegistration 必须判 registered，否则按未交付报
  record.branches.push('adopt')
  const after = readRegistry(file)
  const reg = resolveRegistration({ projectId: id, entries: after, sourceDirs: roots, exists: opts.exists })
  record.entries_after = after.length
  if (reg.status !== 'registered') {
    const message = '已写入 1 行，但**读侧未采纳**（registration_status=' + reg.status + '：' + reg.reason + '）⇒ 按未交付处理'
    auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, blocked_by: 'adopt', code: INGEST_CODES.NOT_ADOPTED, registration_status: reg.status })
    return out(INGEST_STATES.REJECTED, INGEST_CODES.NOT_ADOPTED, message,
      { fix: '检查 root 是否真实存在、是否与源内 dirs 一致 ⇒ 修好后重跑', record: { blocked_by: 'adopt', registration_status: reg.status, generation: rec.generation } })
  }
  record.registration_status = 'registered'
  record.generation = rec.generation
  auditIngest(gateFile, env, { ts: now(), mode: 'ingest', ...record, ok: true })
  return out(INGEST_STATES.WRITTEN, null, null, { record: { registration_status: 'registered', generation: rec.generation, line: rec } })
}
// ------------------------------------------------------------------ 自检（能红 R1–R4）
function runSelftest() {
  let pass = 0, total = 0
  const say = (ok, name, detail) => { total++; if (ok) pass++; console.log('[CASE] ' + (ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail)) }
  console.log('=== claude-source --selftest ===')
  // R2：cwd 归并（同源于 A5）
  const k1 = projectKeyOfCwd('D:\\Astock-trade-huahua\\huahua-trading', ['D:\\'])
  say(k1.key === 'Astock-trade-huahua' && k1.source === 'scan-root', 'R2 归并：D:\\Astock-trade-huahua\\huahua-trading ⇒ Astock-trade-huahua（**不得自成项目**）', JSON.stringify(k1))
  const k2 = projectKeyOfCwd('C:\\Users\\cosmo\\other-proj', ['D:\\'])
  say(k2.key === 'other-proj' && k2.source === 'cwd', 'R2 能红对照：扫描根外 cwd ⇒ 自成项目且 source=cwd', JSON.stringify(k2))
  const k3 = projectKeyOfCwd('D:\\Astock-trade-huahua', ['D:\\'])
  say(k3.key === 'Astock-trade-huahua' && k3.source === 'scan-root', 'R2 边界：恰好是第 1 层 ⇒ 自身即项目', JSON.stringify(k3))
  // R1：登记表空 ∧ 扫描非空 ⇒ linked 必须为 0
  const disc = [{ dir: '/x/p1', dirName: 'p1', cwd: 'D:\\p1', key: 'p1', source: 'scan-root', sessions: 3 }, { dir: '/x/p2', dirName: 'p2', cwd: 'C:\\zz\\p2', key: 'p2', source: 'cwd', sessions: 1 }]
  const rowsEmpty = linkStates(disc, [])
  say(rowsEmpty.every((r) => r.state === 'discovered-only') && rowsEmpty.filter((r) => r.state === 'linked').length === 0,
    'R1 **能红**：登记表空 ∧ 扫描非空 ⇒ **linked 数 = 0**（全部 discovered-only）', JSON.stringify(rowsEmpty.map((r) => r.state)))
  // R3：registered-only 与 linked 不混淆
  const REG = [{ project_id: 'p1', project_name: 'P1', root_dirs: ['D:\\p1'], origin_agent: 'claude', session_id: 's1', registered_at: '2026-09-13T00:00:00Z', registered_by: 'agents/eng' }]
  const ex = () => true
  const rowsMixed = linkStates(disc, REG, { exists: ex }).map((r) => ({ ...r }))
  const p1 = rowsMixed.find((r) => r.project === 'p1'), p2 = rowsMixed.find((r) => r.project === 'p2')
  say(p1 && p1.state === 'linked' && p1.registration_status === 'registered', 'R3：已登记 ∧ Claude 命中 ⇒ linked', JSON.stringify(p1))
  say(p2 && p2.state === 'discovered-only', 'R3：未登记 ⇒ discovered-only（**不得算作已接入**）', JSON.stringify(p2))
  // 门：语义「无项目 id 不得写入」
  const g1 = claudeIngestGate({ enabled: true, enforce: true, projectId: '' })
  say(g1.ok === false && g1.code === 'E_NO_PROJECT_ID', '门（S4）：**无项目 id ⇒ 拒**（不是「材料齐全才能写」）', JSON.stringify(g1.record))
  const g2 = claudeIngestGate({ enabled: true, enforce: true, projectId: 'p1' })
  say(g2.ok === true, '门（S4）：**有项目 id ⇒ 放行**（不要求 7 字段齐备）', JSON.stringify(g2.record))
  const g3 = claudeIngestGate({ enabled: true, enforce: false, projectId: '' })
  say(g3.mode === 'observe' && g3.ok === true && g3.record.would_block === true, '门（S3）：不合规 ⇒ **记录但放行**', JSON.stringify(g3.record))
  const g4 = claudeIngestGate({ projectId: '' })
  say(g4.mode === 'off' && g4.record.switch_source === 'default', '门（off）：未显式配置 ⇒ 门未安装', JSON.stringify(g4.record))
  console.log('自检 = ' + pass + '/' + total + ' PASS')
  return pass === total
}

/** 观察期：真实数据上「若开 S4 会被拦名单 + 理由」（队长裁定的 S3 观察期交付物）。 */
function runObserve() {
  const discovered = discoverClaudeProjects({})
  let entries = []
  try {
    const f = path.join(os.homedir(), '.gbrain', 'agent-roles', 'data', 'registry.jsonl')
    entries = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { /* 无登记表 ⇒ 空 */ }
  const rows = linkStates(discovered, entries)
  console.log('=== A6 观察期：Claude Code 侧（若开 S4 会被拦名单 + 理由）===')
  console.log('Claude 项目目录 = ' + discovered.length + ' · 归并后项目键 = ' + rows.length)
  const willBlock = rows.filter((r) => r.state !== 'linked')
  console.log('**会被拦 = ' + willBlock.length + '** · 已接入(linked) = ' + (rows.length - willBlock.length))
  for (const r of rows) {
    console.log('· ' + r.project + ' | 会话=' + r.sessions + ' | 登记=' + r.registration_status + ' | state=' + r.state + ' | source=' + r.source + (r.state === 'linked' ? '' : ' ⇒ **拦：无项目 id / 未登记**'))
  }
  console.log('环境：node ' + process.version + ' · claudeHome=' + claudeHome() + ' · 时点=' + new Date().toISOString())
  return 0
}

/** A7 独立入口：三类分开打印 + 计数 + 名单（不许静默过滤）。 */
function runClasses() {
  const discovered = discoverClaudeProjects({})
  let entries = []
  try {
    const f = path.join(os.homedir(), '.gbrain', 'agent-roles', 'data', 'registry.jsonl')
    entries = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { /* 无登记表 */ }
  const rows = linkStates(discovered, entries)
  const cls = classifyKeys(rows)
  const pick = (c) => cls.rows.filter((x) => x.cls === c)
  console.log('=== A7 三类名单（Claude 侧 · 真实数据 · 不许静默过滤）===')
  console.log('Claude 项目目录 = ' + discovered.length + ' · 归并后项目键 = ' + rows.length)
  console.log('【计数】E8 原表排除 = ' + cls.counts.e8 + ' · 无法判定 = ' + cls.counts.unknown + ' · 准入通过 = ' + cls.counts.admitted)
  console.log('【① E8 原表排除】' + pick('E8 原表排除').length + ' 项：' + JSON.stringify(pick('E8 原表排除').map((x) => x.project).slice(0, 40)))
  console.log('【② 无法判定·逐条】' + pick('无法判定').length + ' 项：' + JSON.stringify(pick('无法判定').map((x) => x.project)))
  console.log('【③ 准入通过】' + pick('准入通过').length + ' 项：' + JSON.stringify(pick('准入通过').map((x) => x.project)))
  console.log('环境：node ' + process.version + ' · 时点=' + new Date().toISOString())
  return 0
}
function runBaseline() {
  const discovered = discoverClaudeProjects({})
  let entries = []
  try {
    const rf = path.join(os.homedir(), '.gbrain', 'agent-roles', 'data', 'registry.jsonl')
    entries = fs.readFileSync(rf, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch (e) { /* 无登记表 */ }
  const rows = linkStates(discovered, entries)
  const cls = classifyKeys(rows)
  const unknown = cls.rows.filter((x) => x.cls === 'A7UNKNOWN').map((x) => x.project)
  const infoOf = (p) => discovered.filter((d) => d.key === p)
  const RAND = /^[a-z][a-z0-9-]*-[0-9a-z_]{6,}$/i
  const dims = { git: 0, exists: 0, gone: 0, rand: 0, plain: 0, sess: 0 }
  const buckets = new Map()
  for (const p of unknown) {
    const ds = infoOf(p)
    const cwd = ds.map((d) => d.cwd).filter(Boolean)[0] || null
    const onDisk = cwd ? fs.existsSync(cwd) : false
    const isGit = cwd ? fs.existsSync(path.join(cwd, '.git')) : false
    const isRand = RAND.test(p)
    const sessions = ds.reduce((a, d) => a + (d.sessions || 0), 0)
    if (isGit) dims.git++
    if (onDisk) dims.exists++; else dims.gone++
    if (isRand) dims.rand++; else dims.plain++
    dims.sess += sessions
    const b = (isGit ? 'git工作树' : (onDisk ? '在盘非git' : '已不在盘')) + '|' + (isRand ? '带随机后缀' : '无随机后缀')
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(p + '(会话' + sessions + ')' )
  }
  console.log('=== A7 分类基线：无法判定 = ' + unknown.length + ' 项 ===')
  console.log('【四维计数】git工作树=' + dims.git + ' · 在盘=' + dims.exists + ' · 不在盘=' + dims.gone + ' · 带随机后缀=' + dims.rand + ' · 无随机后缀=' + dims.plain + ' · 会话总数=' + dims.sess)
  for (const kv of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length)) {
    console.log('· [' + kv[0] + '] = ' + kv[1].length + ' · 样例：' + JSON.stringify(kv[1].slice(0, 3)))
  }
  console.log('环境：node ' + process.version + ' · 时点=' + new Date().toISOString())
  return 0
}
function runFinal() {
  const discovered = discoverClaudeProjects({})
  let entries = []
  try {
    const rf = path.join(os.homedir(), '.gbrain', 'agent-roles', 'data', 'registry.jsonl')
    entries = fs.readFileSync(rf, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch (e) { /* 无登记表 */ }
  const rows = linkStates(discovered, entries)
  const infoOf = (p) => discovered.filter((d) => d.key === p)
  const RAND = /^[a-z][a-z0-9-]*-[0-9a-z_]{6,}$/i
  const out = { gone: [], real: [], manual: [], human: [] }
  for (const r of rows) {
    const p = r.project
    const ds = infoOf(p)
    const cwd = ds.map((d) => d.cwd).filter(Boolean)[0] || null
    const sessions = ds.reduce((a, d) => a + (d.sessions || 0), 0)
    const synth = cwd ? [{ project_id: p, project_name: p, root_dirs: [cwd], origin_agent: 'a7', session_id: 'a7', registered_at: '2026-09-13T00:00:00Z', registered_by: 'agents/a7' }] : []
const reg = resolveRegistration({ projectId: p, entries: synth, sourceDirs: cwd ? [cwd] : [] })
    if (!cwd || reg.status === 'vanished') { out.gone.push(p); continue }
    const isGit = fs.existsSync(path.join(cwd, '.git'))
    if (isGit && sessions >= 5) { out.real.push(p + top(sessions)); continue }
    if (RAND.test(p)) { out.manual.push(p + top(sessions)); continue }
    out.human.push(p + top(sessions))
  }
  function top(n) { return String.fromCharCode(40) + n + String.fromCharCode(41) }
  const show = (name, arr) => console.log('· ' + name + ' = ' + arr.length + ' · 样例(≤3)：' + JSON.stringify(arr.slice(0, 3)))
  console.log('=== A7 收口：一等判据 = 是否仍在盘（复用 project-registry.js:83-84 的 vanished；不写第二个 fs.existsSync）===')
  console.log('归并键总数 = ' + rows.length + ' · 零名字黑名单 · 谁也不排除、谁也不自动准入')
  show('①出局：已不在盘（状态判据）', out.gone)
  console.log('  ①去向：仍 discovered-only ⇒ 进「待登记池」（A6：准入 = 登记）；本卡不清池，只让池子看得懂')
  show('②疑似真项目（在盘 ∧ git ∧ 会话≥5）', out.real)
  show('③待人工确认（在盘 ∧ 形态像临时）', out.manual)
  show('④人工目录（在盘 ∧ 非临时形态，含 Desktop 类）', out.human)
  console.log('环境：node ' + process.version + ' · 时点=' + new Date().toISOString())
  return 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) process.exit(runSelftest() ? 0 : 1)
  if (process.argv.includes('--observe')) process.exit(runObserve())
  if (process.argv.includes('--classes')) process.exit(runClasses())
  if (process.argv.includes('--baseline')) process.exit(runBaseline())
  if (process.argv.includes('--final')) process.exit(runFinal())
  console.log('用法：--selftest | --observe')
  process.exit(2)
}
