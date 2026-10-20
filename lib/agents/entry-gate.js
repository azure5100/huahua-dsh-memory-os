// entry-gate.js —— E37 · M1b 入口门禁 S3/S4（从「加载」到「拦截」）
//
// 输入契约 = ops/records/A4-2026-09-12.md §5.5（七条校验 V1–V7 + 「门不校验什么」+ 四条硬边界）。
// 字段口径 = docs/L1_项目蓝图.md §3.1（**7 字段**，逐字转录，不改口径）：
//   project / stage / role / session_id / ts / upstream / artifact{ptr, sha256}
//
// 三条设计硬约束（本文件自己守住，并由 --selftest 断言）：
//   ① **S3 必须存在**：模式只取三态 off | observe(S3) | enforce(S4)；`enforce` **不得**越过 `enabled` 单独生效
//      （否则就是「S2 直接跳 S4」）。
//   ② **门自身必须留痕**：每次判定都产出 record（含 mode / switch_source / 失败码），由 emitGateCheck 落 gate-checks.jsonl；
//      **关闭开关也要留痕** —— 否则「关了开关」与「没违规」不可区分（A2 §5.4 已证）。
//   ③ **开关来源必须可判**：record 里写 switch_source = 'explicit' | 'default'（REGISTRY_DEFAULTS 是**装载期默认**，
//      调用方每次传入的是**运行期**取值）—— 「装载期 vs 运行期」这个差别必须留下痕迹。
//
// 边界（A4 §5.5.2 · 门不做的事）：**不校验正文语义** · **不校验 stage 与文件名是否一致**（frontmatter.stage 是权威）·
//   **不重复实现 registry 逻辑**（委托 project-registry.js）· **不做存量迁移**（存量走 naming: legacy 分支）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGISTRY_DEFAULTS, resolveRegistration, appendGateCheck } from './project-registry.js'

/** 阶段码集合（**必须与 flow.js FLOW_DEF 逐字一致**；--selftest 会读源文件断言，防契约漂移）。 */
export const STAGE_CODES = ['0', '0.5', '0.8', '①', '②', '③', '④', '⑤', '⑥', '⑦']

/** 7 必填字段（蓝图 §3.1）。 */
export const DOC_FIELDS = ['project', 'stage', 'role', 'session_id', 'ts', 'upstream', 'artifact']

/** 失败码（结构判定用）。 */
export const CODES = {
  NO_PROJECT: 'E_NO_PROJECT_ID',
  MISSING_FIELDS: 'E_MISSING_FIELDS',
  BAD_STAGE: 'E_BAD_STAGE',
  BAD_ROLE: 'E_BAD_ROLE',
  BAD_TS: 'E_BAD_TS',
  UPSTREAM: 'E_UPSTREAM',
  ARTIFACT: 'E_ARTIFACT',
}

export const FIX_HINT = '补齐 frontmatter 的 7 字段（project/stage/role/session_id/ts/upstream/artifact{ptr,sha256}）；边界：本门不校验正文语义、不校验 stage 与文件名是否一致 —— frontmatter.stage 是权威。'

export function isRoleSlug(v) { return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v) }
export function isSha16(v) { return typeof v === 'string' && /^[0-9a-f]{16}$/i.test(v) }
/** ISO8601 **带时区**（口径同 board-gen E19 ②）。 */
export function hasTz(v) {
  if (typeof v !== 'string') return false
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/.test(v.trim())
}

/** 最小 frontmatter 解析器（只认本契约要用的形状；**不改任何既有解析器**）。 */
export function parseFrontmatter(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  if (lines[0] !== '---') return { ok: false, reason: '首行不是 ---' }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { ok: false, reason: '缺少闭合 ---' }
  const doc = {}
  let nested = null
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indented = /^\s+/.test(raw)
    const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (indented && nested) { doc[nested][key] = val.replace(/^['\"]|['\"]$/g, ''); continue }
    if (val === '') { doc[key] = {}; nested = key; continue }
    nested = null
    const inline = val.match(/^\{(.*)\}$/)
    if (inline) {
      const o = {}
      for (const part of inline[1].split(',')) {
        const kv = part.split(':')
        if (kv.length >= 2) o[kv[0].trim()] = kv.slice(1).join(':').trim().replace(/^['\"]|['\"]$/g, '')
      }
      doc[key] = o
      continue
    }
    doc[key] = val.replace(/^['\"]|['\"]$/g, '')
  }
  return { ok: true, doc }
}

/** 文件可核：存在 ∧ 是文件 ∧ 非空（V7 的「指文件非空」）。 */
export function fileProbe(ptr, statFn) {
  const stat = statFn ?? ((p) => { try { return fs.statSync(p) } catch { return null } })
  const st = stat(String(ptr))
  if (!st) return { ok: false, reason: '指针指向的文件不存在' }
  if (typeof st.isFile === 'function' && !st.isFile()) return { ok: false, reason: '指针指向的不是文件（目录？）' }
  if (!(Number(st.size) > 0)) return { ok: false, reason: '指针指向的文件为空（size=0）' }
  return { ok: true, size: Number(st.size) }
}

/**
 * 文档层校验 V2–V7（**纯函数**；IO 全部经 opts 注入）。
 * @returns {{ok:boolean, failures:Array<{code:string,field:string,message:string}>}}
 */
export function validateStageDoc(doc, opts = {}) {
  const failures = []
  const d = doc ?? {}
  // V2 七字段齐备：**列出缺哪些**（不是「有错」）
  const missing = DOC_FIELDS.filter((f) => {
    const v = d[f]
    return v === undefined || v === null || v === '' || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
  })
  if (missing.length) failures.push({ code: CODES.MISSING_FIELDS, field: missing.join(','), message: '缺字段：' + missing.join(' / ') })
  // V3 stage 精确枚举
  if (d.stage !== undefined && !STAGE_CODES.includes(String(d.stage))) {
    failures.push({ code: CODES.BAD_STAGE, field: 'stage', message: 'stage「' + d.stage + '」不在枚举内；合法集合 = ' + STAGE_CODES.join(' ') })
  }
  // V4 role 结构式 slug
  if (d.role !== undefined && !isRoleSlug(d.role)) failures.push({ code: CODES.BAD_ROLE, field: 'role', message: 'role「' + d.role + '」不是 slug（口径 agents/<slug>：小写字母数字与连字符）' })
  // V5 ts 带时区
  if (d.ts !== undefined && !hasTz(d.ts)) failures.push({ code: CODES.BAD_TS, field: 'ts', message: 'ts「' + d.ts + '」不是带时区的 ISO8601（口径同 board-gen E19 ②）' })
  // V6 upstream 链（≠none ⇒ 可解析为上阶段 artifact.ptr 且 sha256 相符；= none ⇒ 仅 stage 0）
  const up = d.upstream
  if (up !== undefined) {
    const isNone = String(up).trim() === 'none'
    if (isNone) {
      if (String(d.stage) !== '0') failures.push({ code: CODES.UPSTREAM, field: 'upstream', message: 'upstream=none 仅允许 stage 0（当前 stage=' + d.stage + '）⇒ 断链' })
    } else {
      const upObj = typeof up === 'object' ? up : null
      const upPtr = upObj ? upObj.ptr : String(up).split('#')[0]
      const upSha = upObj ? upObj.sha256 : String(up).split('#')[1]
      if (!upPtr || !upSha) failures.push({ code: CODES.UPSTREAM, field: 'upstream', message: 'upstream 不可解析为「指针 + 哈希」（应为 <ptr>#<sha16> 或 {ptr, sha256}）' })
      else if (!isSha16(upSha)) failures.push({ code: CODES.UPSTREAM, field: 'upstream', message: 'upstream 哈希不是 16 位 hex：' + upSha })
      else {
        const probe = fileProbe(upPtr, opts.stat)
        if (!probe.ok) failures.push({ code: CODES.UPSTREAM, field: 'upstream', message: 'upstream 指针不可核：' + probe.reason })
        else if (opts.upstreamSha !== undefined && String(opts.upstreamSha).toLowerCase() !== String(upSha).toLowerCase()) {
          failures.push({ code: CODES.UPSTREAM, field: 'upstream', message: 'upstream 哈希与实际上游交付物不符（断链）：' + upSha + ' ≠ ' + opts.upstreamSha })
        }
      }
    }
  }
  // V7 artifact 非空可核
  const art = d.artifact
  if (art !== undefined) {
    if (typeof art !== 'object' || art === null) failures.push({ code: CODES.ARTIFACT, field: 'artifact', message: 'artifact 必须是 {ptr, sha256}' })
    else {
      if (!art.ptr) failures.push({ code: CODES.ARTIFACT, field: 'artifact.ptr', message: 'artifact.ptr 为空' })
      else { const probe = fileProbe(art.ptr, opts.stat); if (!probe.ok) failures.push({ code: CODES.ARTIFACT, field: 'artifact.ptr', message: 'artifact.ptr 不可核：' + probe.reason }) }
      if (!isSha16(art.sha256)) failures.push({ code: CODES.ARTIFACT, field: 'artifact.sha256', message: 'artifact.sha256 不是 16 位 hex：' + art.sha256 })
    }
  }
  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------
// 门本体：S2/S3/S4 三态 + V1（登记）+ V2–V7（文档）+ legacy 分支 + 留痕
// ---------------------------------------------------------------------------
/**
 * 入口门禁判定（**除 opts 注入的 IO 外无副作用**；留痕 record 由调用方 emitGateCheck 落盘 —— 便于测试）。
 * 开关口径（硬边界 3）：`enabled` **显式传入 ⇒ 运行期取值（switch_source='explicit'）**；
 *   未传 ⇒ 用 `REGISTRY_DEFAULTS.enabled`（**装载期默认**，switch_source='default'）—— 两者必须可区分。
 * 模式（硬边界 1）：off | observe(S3) | enforce(S4)；**enforce 不得越过 enabled 单独生效**。
 * legacy（硬边界 4）：载体 = **项目登记处的 `naming` 字段**（裁定：不放 frontmatter、不靠识别器推断）；
 *   缺省按 `new` 处理；**legacy 只豁免文档层 V2–V7，不豁免 V1（未登记照样拒）**。
 */
// ---------------------------------------------------------------------------
// M1b 硬凭证门（E64 · 2026-09-24）—— **「门」不是「禁令」**：
//   口径（队长《硬截止四》）：**无项目 id / 无上游凭证 ⇒ 不进验收**；
//   **判据：能红（造无凭证样本 ⇒ 拒）**；**`registrationGateEnabled` 那类开关不算门**。
//   ⇒ 本函数**结构上不读取任何开关**（不引用 enabled / registrationGateEnabled）—— 因此无法被关掉；
//     两态由「有凭证 ⇒ 放行 / 无凭证 ⇒ 拒」给出（恒红恒绿都不算证据）。
export const CRED_CODES = {
  NO_PROJECT: CODES.NO_PROJECT,
  NO_UPSTREAM: CODES.UPSTREAM,
  NO_FRONTMATTER: 'E_NO_FRONTMATTER',
}

/** 纯函数：判定一份 stage 文档的**硬凭证**（项目 id + 上游凭证）。不做 IO、不读开关。 */
export function credentialGate(input = {}) {
  const doc = input.doc ?? {}
  const failures = []
  // 归一：空对象/空白 一律视为「无」——parseFrontmatter 对 `project:`（空值）会给出 `{}`，
  // 若直接 String() 会得到 "[object Object]" ⇒ 假通过（本装置第一版就被这条咬到）。
  const norm = (v) => {
    if (v === undefined || v === null) return ""
    if (typeof v === "object") return Object.keys(v).length === 0 ? "" : JSON.stringify(v)
    return String(v).trim()
  }
  if (input.hasFrontmatter === false) failures.push({ code: CRED_CODES.NO_FRONTMATTER, field: "frontmatter", message: "无 frontmatter ⇒ 无凭证" })
  const project = norm(doc.project)
  if (!project) failures.push({ code: CRED_CODES.NO_PROJECT, field: "project", message: "无项目 id ⇒ 不进验收" })
  const upRaw = doc.upstream
  const up = norm(upRaw)
  const isNone = up === "none"
  const stage0 = String(doc.stage ?? "").trim() === "0"
  if (!up) failures.push({ code: CRED_CODES.NO_UPSTREAM, field: "upstream", message: "无上游凭证 ⇒ 不进验收" })
  else if (isNone && !stage0) failures.push({ code: CRED_CODES.NO_UPSTREAM, field: "upstream", message: "upstream=none 仅 stage 0 合法（当前 stage=" + String(doc.stage) + "）" })
  else if (!isNone) {
    const ptr = typeof upRaw === "object" && upRaw !== null ? upRaw.ptr : String(up).split("#")[0]
    const sha = typeof upRaw === "object" && upRaw !== null ? upRaw.sha256 : String(up).split("#")[1]
    if (!ptr || !sha) failures.push({ code: CRED_CODES.NO_UPSTREAM, field: "upstream", message: "上游凭证不可解析为 <ptr>#<sha16>" })
    else if (!isSha16(sha)) failures.push({ code: CRED_CODES.NO_UPSTREAM, field: "upstream", message: "上游凭证哈希不是 16 位 hex：" + sha })
  }
  return { ok: failures.length === 0, failures, mode: "credential", project: project || null }
}

/** 过滤一批文件：**无凭证的 stage 文档不进流程**（其余文件原样保留）。留痕由调用方 emitGateCheck。 */
export function credentialFilter(files = [], readText = null) {
  const kept = [], blocked = [], checks = []
  for (const f of files) {
    const isStageDoc = typeof f.name === "string" && /\.md$/i.test(f.name) && /^L1|^L2|^L3|^S\d|任命书|任务卡/i.test(f.name)
    if (!isStageDoc) { kept.push(f); continue }
    let doc = {}, hasFm = false
    try {
      const text = readText ? readText(f) : (f.text ?? null)
      if (typeof text === "string") { const fm = parseFrontmatter(text); hasFm = fm.ok === true; if (fm.ok) doc = fm.doc }
    } catch (e) { /* 读不到 ⇒ 当无 frontmatter */ }
    const v = credentialGate({ doc: doc, hasFrontmatter: hasFm })
    checks.push(v)
    if (v.ok) kept.push(f)
    else blocked.push({ file: f.rel ?? f.name, codes: v.failures.map((x) => x.code) })
  }
  return { files: kept, blocked: blocked, checks: checks }
}

export function gateStageDoc(input = {}) {
  const o = input
  const explicit = Object.prototype.hasOwnProperty.call(o, 'enabled')
  const enabled = (explicit ? o.enabled : REGISTRY_DEFAULTS.enabled) === true
  const enforce = o.enforce === true
  const switch_source = explicit ? 'explicit' : 'default'
  const action = o.action ?? '阶段文档入口'
  const doc = o.doc ?? {}
  const rec = {
    gate: 'm1b-entry',
    action,
    project: doc.project ?? o.projectId ?? null,
    stage: doc.stage ?? null,
    switch_source,
    enabled, enforce,
  }
  // —— 模式（不得 S2 跳 S4）——
  let mode
  if (!enabled) mode = 'off'
  else mode = enforce ? 'enforce' : 'observe'
  rec.mode = mode
  if (mode === 'off') {
    rec.ok = true
    rec.skip_reason = enforce
      ? '开关关闭 ⇒ 门消失；且 enforce=true 不得越过 S3 直接进 S4（本次按 off 处理）'
      : '开关关闭 ⇒ 门消失'
    return { ok: true, mode, branch: null, switch_source, code: null, codes: [], failures: [], message: null, record: rec }
  }
  // —— legacy 载体 = 登记处（缺省 new）——
  const branch = String(o.naming ?? 'new').toLowerCase() === 'legacy' ? 'legacy' : 'new'
  rec.branch = branch
  // —— V1：项目已登记（委托 project-registry，纯函数）——
  const st = resolveRegistration({
    projectId: doc.project ?? o.projectId,
    entries: o.entries ?? [],
    sourceDirs: o.sourceDirs ?? [],
    exists: o.exists,
  })
  rec.registration_status = st.status
  const failures = []
  if (st.status !== 'registered') {
    failures.push({ code: CODES.NO_PROJECT, field: 'project', message: '项目「' + (doc.project ?? o.projectId ?? '(未命名)') + '」未登记（registration_status=' + st.status + '）；修法：' + (o.fixHint ?? '见 project-registry FIX_HINT') })
  }
  // —— V2–V7：文档层 ——
  const dv = validateStageDoc(doc, { stat: o.stat, upstreamSha: o.upstreamSha })
  rec.doc_failures = dv.failures.map((f) => f.code + ':' + f.field)
  const blocking = branch === 'legacy' ? [] : dv.failures
  failures.push(...blocking)
  rec.legacy_waived = branch === 'legacy' ? dv.failures.length : 0
  const wouldBlock = failures.length > 0
  rec.would_block = wouldBlock
  rec.codes = failures.map((f) => f.code)
  const ok = mode === 'observe' ? true : !wouldBlock
  rec.ok = ok
  const message = wouldBlock
    ? '拒（' + action + '）：' + failures.map((f) => '[' + f.code + '] ' + f.message).join('；')
    : null
  if (mode === 'observe' && wouldBlock) rec.observe_note = 'S3 观察：**记录但放行**（本卡不阻断现有流程）'
  return { ok, mode, branch, switch_source, code: wouldBlock ? failures[0].code : null, codes: rec.codes, failures, message, record: rec }
}

/** 留痕（唯一写路径：gate-checks.jsonl）。**关闭开关也必须留痕** —— 否则「关了开关」与「没违规」不可区分。 */
export function emitGateCheck(file, record, ts) {
  return appendGateCheck(file, { ts: ts ?? new Date().toISOString(), ...record })
}

// ---------------------------------------------------------------------------
// 能红自检（判据先证判别力，再证能红）
// ---------------------------------------------------------------------------
function runSelftest() {
  let pass = 0, total = 0
  const say = (ok, name, detail) => { total++; if (ok) pass++; console.log('[CASE] ' + (ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail)) }
  console.log('=== entry-gate --selftest ===')
  const st = (map) => (p) => { const v = map[String(p)]; return v === undefined ? null : { size: v, isFile: () => v >= 0 } }
  const REG = [{ project_id: 'p1', project_name: 'P1', root_dirs: ['/x/p1'], origin_agent: 'dsh', session_id: 's1', registered_at: '2026-09-12T00:00:00Z', registered_by: 'agents/dsh' }]
  const exists = () => true
  const FILES = { '/x/p1/doc.md': 100, '/x/p1/up.md': 200, '/x/p1/empty.md': 0, '/x/p1/art.bin': 50 }
  const good = {
    project: 'p1', stage: '①', role: 'data-eng', session_id: 's1',
    ts: '2026-09-12T22:30:00+08:00', upstream: '/x/p1/up.md#0123456789abcdef',
    artifact: { ptr: '/x/p1/art.bin', sha256: '0123456789abcdef' },
  }
  const base = { projectId: 'p1', entries: REG, exists, stat: st(FILES), naming: 'new', enabled: true, enforce: true }
  const G = (patch) => gateStageDoc({ ...base, doc: { ...good, ...patch } })
  // 0) 契约漂移守卫：阶段码集合必须与 flow.js FLOW_DEF 逐字一致
  const flowSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'flow.js'), 'utf8')
  const codes = [...flowSrc.matchAll(/\{ code: '([^']+)'/g)].map((m) => m[1])
  say(JSON.stringify(codes) === JSON.stringify(STAGE_CODES), '阶段码集合与 flow.js FLOW_DEF 逐字一致（防契约漂移）', JSON.stringify(codes) + ' vs ' + JSON.stringify(STAGE_CODES))
  // 1) 正例
  say(G({}).ok === true, '正例：七字段齐备 + 已登记 ⇒ 放行', JSON.stringify(G({}).codes))
  // 2) V2 缺字段 ⇒ 列出缺哪些
  const miss = G({ ts: undefined, role: undefined })
  say(miss.ok === false && miss.codes.includes(CODES.MISSING_FIELDS) && /ts/.test(miss.message) && /role/.test(miss.message), 'V2：缺字段 ⇒ 拒 且点名缺哪些（列出 ts/role）', JSON.stringify(miss.codes))
  // 3) V3 stage 非法 ⇒ 拒 + 回显合法集合
  const badStage = G({ stage: '⑧' })
  say(badStage.ok === false && badStage.codes.includes(CODES.BAD_STAGE) && /0 0\.5/.test(badStage.message), 'V3：stage 非法 ⇒ 拒 + 回显合法集合', JSON.stringify(badStage.codes))
  // 4) V4 role 非 slug
  say(G({ role: 'Data/Eng' }).codes.includes(CODES.BAD_ROLE), 'V4：role 非 slug ⇒ 拒', JSON.stringify(G({ role: 'Data/Eng' }).codes))
  // 5) V5 ts 带时区
  say(G({ ts: '2026-09-12 22:30:00' }).codes.includes(CODES.BAD_TS), 'V5：ts 无时区 ⇒ 拒', JSON.stringify(G({ ts: '2026-09-12 22:30:00' }).codes))
  say(G({ ts: '2026-09-12T22:30:00Z' }).ok === true, 'V5 正例：ts 带 Z ⇒ 放行', JSON.stringify(G({ ts: '2026-09-12T22:30:00Z' }).codes))
  // 6) V6 upstream 链
  say(G({ stage: '①', upstream: 'none' }).codes.includes(CODES.UPSTREAM), 'V6：stage≠0 却写 none ⇒ 拒（误用 none）', JSON.stringify(G({ stage: '①', upstream: 'none' }).codes))
  say(G({ stage: '0', upstream: 'none' }).ok === true, 'V6 正例：stage 0 + none ⇒ 放行', JSON.stringify(G({ stage: '0', upstream: 'none' }).codes))
  say(G({ upstream: '/x/p1/up.md#zzzz' }).codes.includes(CODES.UPSTREAM), 'V6：upstream 哈希非 16 hex ⇒ 拒', JSON.stringify(G({ upstream: '/x/p1/up.md#zzzz' }).codes))
  say(G({ upstream: '/x/p1/nope.md#0123456789abcdef' }).codes.includes(CODES.UPSTREAM), 'V6：upstream 指针不可核 ⇒ 拒', JSON.stringify(G({ upstream: '/x/p1/nope.md#0123456789abcdef' }).codes))
  say(gateStageDoc({ ...base, upstreamSha: 'ffffffffffffffff', doc: { ...good, upstream: '/x/p1/up.md#0123456789abcdef' } }).codes.includes(CODES.UPSTREAM), 'V6：upstream 哈希与实际上游不符 ⇒ 拒（断链）', '')
  say(gateStageDoc({ ...base, upstreamSha: '0123456789abcdef', doc: { ...good, upstream: '/x/p1/up.md#0123456789abcdef' } }).ok === true, 'V6 正例：哈希相符 ⇒ 放行', '')
  // 7) V7 artifact
  say(G({ artifact: { ptr: '', sha256: '0123456789abcdef' } }).codes.includes(CODES.ARTIFACT), 'V7：artifact.ptr 为空 ⇒ 拒', '')
  say(G({ artifact: { ptr: '/x/p1/art.bin', sha256: 'short' } }).codes.includes(CODES.ARTIFACT), 'V7：sha256 非 16 hex ⇒ 拒', '')
  say(G({ artifact: { ptr: '/x/p1/empty.md', sha256: '0123456789abcdef' } }).codes.includes(CODES.ARTIFACT), 'V7：指针指向空文件 ⇒ 拒', '')
  // 8) 边界（门不做的事）—— 能红对照：这两条必须**放行**
  say(G({ stage: '⑤' }).ok === true, '边界①：stage 与文件名不一致 ⇒ 门不管（frontmatter.stage 是权威）⇒ 放行', '')
  say(gateStageDoc({ ...base, doc: { ...good, body: '正文胡说八道', title: '完全不相干的标题' } }).ok === true, '边界②：正文语义不校验 ⇒ 放行', '')
  // 9) 三态模式 + 不得跳级
  const off = gateStageDoc({ ...base, enabled: false, doc: { project: 'p1' } })
  say(off.ok === true && off.mode === 'off' && off.record.skip_reason, '模式 off：开关关闭 ⇒ 放行 + 留痕写明原因', JSON.stringify(off.record))
  const jump = gateStageDoc({ ...base, enabled: false, enforce: true, doc: { ...good, stage: '⑧' } })
  say(jump.mode === 'off' && jump.ok === true, '硬边界①：enforce=true 而 enabled=false ⇒ **不得跳级进 S4**（按 off 处理）', 'mode=' + jump.mode)
  const obs = gateStageDoc({ ...base, enforce: false, doc: { ...good, stage: '⑧' } })
  say(obs.mode === 'observe' && obs.ok === true && obs.record.would_block === true && obs.record.observe_note, 'S3 观察：不合规 ⇒ **记录但放行**（would_block=true）', JSON.stringify(obs.record))
  const enf = gateStageDoc({ ...base, enforce: true, doc: { ...good, stage: '⑧' } })
  say(enf.mode === 'enforce' && enf.ok === false, 'S4 强制：不合规 ⇒ 拒', 'mode=' + enf.mode)
  // 10) 开关来源可判（装载期 vs 运行期）
  say(gateStageDoc({ ...base, doc: good }).record.switch_source === 'explicit', '硬边界③：显式传 enabled ⇒ switch_source=explicit（运行期）', '')
  const dft = gateStageDoc({ projectId: 'p1', entries: REG, exists, stat: st(FILES), doc: good })
  say(dft.record.switch_source === 'default' && dft.mode === 'off', '硬边界③：未传 enabled ⇒ switch_source=default（装载期默认=false ⇒ off）', JSON.stringify(dft.record))
  // 11) legacy 分支（载体 = 登记处；能红对照两条）
  const badNew = gateStageDoc({ ...base, naming: 'new', doc: { ...good, stage: '⑧' } })
  const badLegacy = gateStageDoc({ ...base, naming: 'legacy', doc: { ...good, stage: '⑧' } })
  say(badNew.ok === false && badLegacy.ok === true && badLegacy.record.legacy_waived > 0, '硬边界④：同一份不合规文档 ⇒ new 拒 / legacy 放行（合法存量不误拒）', 'new=' + badNew.ok + ' legacy=' + badLegacy.ok)
  const legacyUnreg = gateStageDoc({ ...base, naming: 'legacy', entries: [], doc: { ...good, stage: '⑧' } })
  say(legacyUnreg.ok === false && legacyUnreg.codes.includes(CODES.NO_PROJECT), '硬边界④：legacy **只豁免文档层，不豁免 V1** ⇒ 未登记照样拒', JSON.stringify(legacyUnreg.codes))
  const fm = parseFrontmatter(['---', 'project: p1', 'stage: ①', 'artifact:', '  ptr: /x/a', '  sha256: 0123456789abcdef', 'naming: legacy', '---', '', '正文'].join('\n'))
  say(fm.ok === true && fm.doc.artifact && fm.doc.artifact.ptr === '/x/a' && fm.doc.naming === 'legacy', 'frontmatter 最小解析器：嵌套 artifact + 标量', JSON.stringify(fm.doc))
  const fromDocNaming = gateStageDoc({ ...base, naming: 'new', doc: { ...good, stage: '⑧', naming: 'legacy' } })
  say(fromDocNaming.ok === false, '裁定(b)：naming **只认登记处** ⇒ 文档 frontmatter 里写 legacy 不生效（仍拒）', JSON.stringify(fromDocNaming.codes))
  // 12) 留痕落盘
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e37-gate-'))
  const gf = path.join(dir, 'gate-checks.jsonl')
  emitGateCheck(gf, off.record, '2026-09-12T22:30:00+08:00')
  emitGateCheck(gf, enf.record, '2026-09-12T22:30:01+08:00')
  const lines = fs.readFileSync(gf, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  say(lines.length === 2 && lines[0].mode === 'off' && lines[0].skip_reason && lines[1].mode === 'enforce' && lines[1].would_block === true, '留痕：off 与 enforce 各留一行（关了开关也留痕）', JSON.stringify(lines.map((l) => l.mode)))
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('自检 = ' + pass + '/' + total + ' PASS')
  return pass === total
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(process.argv.includes('--selftest') ? (runSelftest() ? 0 : 1) : (console.log('用法：node lib/agents/entry-gate.js --selftest'), 2))
}
