// huahua-os · 流程视图真实数据后端（t23 · docs/102）
// 职责：把「流程大屏」从演示数据切到**真实工程源**——三源项目聚合 + 阶段推断 + 真实事件流。
// 真实数据源（只读，零写入；docs/89 红线）：
//   ① 运行中团队 D:\Deepseek-harness\.agent-teams\<team>\team.json
//      {name, description, captainSessionId, createdAt, members[], tasks[{id,subject,status,assignee,
//       createdAt,updatedAt,dependencies,attempt}]}——**真实进度源**（时间戳为 epoch ms，实测 23 任务）
//   ② orchestrator 正式项目记录 <agentsHrDir>/data/projects.jsonl（{project,status,stages,
//      completed_stages,started_at,deliverables}）+ data/projects/<name>/ 施工文件（L1/L2/L3/任命书/任务卡/gate 日志）
//   ③ 角色调用留痕 access.jsonl（{role,ts,project}）
// 输出契约 = UI FlowView 的 PvProject/PvEvent（src/client/agents/AgentsTabView.tsx §7 数据模型）：
//   PvProject {project,status,started_at,completed_stages,deliverables?,activeCode,stageNote?,
//              stByCode,gates,tasks?,events}
//   PvEvent {ts(ISO),kind:'stage'|'gate'|'role'|'system',text}
// 阶段定义 FLOW_DEF 与 orchestrator SKILL.md 逐字一致（10 阶段 + 5 门禁）；tests/agents-flow.test.js
// 对 SKILL.md 解析做 parity 断言防漂移。所有时间戳均取自真实源，不做任何虚构。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createProjectScanner, normalizeScanConfig } from './project-scan.js' // E8：第 4 源（工作目录根扫描）
import { createDshSource, normalizeDshConfig } from './dsh-source.js' // A5：第 5 源（DSH 自身会话）
import { readRegistry, registryPath, resolveRegistration, gateChecksPath } from './project-registry.js' // E9：登记状态（只读）
import { defaultTeamsRoot, missingRoots, defaultAgentRolesRoot } from './platform-paths.js' // E131：teams 根唯一 home + 扫描根缺因明示；E157：gbrain 源根唯一 home
import { gateStageDoc, emitGateCheck, parseFrontmatter, credentialFilter } from './entry-gate.js' // E37/E64：M1b 入口门禁 + 硬凭证门（本卡只接 **S3 观察**，不拦）

/** 10 阶段 + 5 门禁定义（与 orchestrator SKILL.md 权威口径一致；parity 由测试守护）。 */
export const FLOW_DEF = [
  { code: '0', name: '项目预检', gate: null },
  { code: '0.5', name: '需求澄清', gate: null },
  { code: '0.8', name: '可行性判断', gate: { id: 1, label: '用户确认' } },
  { code: '①', name: '方案设计', gate: { id: 2, label: '用户审批' } },
  { code: '②', name: '分工派活', gate: null },
  { code: '③', name: '并行交付', gate: { id: 3, label: '质量门禁' } },
  { code: '④', name: '任务验收', gate: { id: 4, label: '验收确认' } },
  { code: '⑤', name: '联调验证', gate: { id: 5, label: '验证确认' } },
  { code: '⑥', name: '项目交付', gate: null },
  { code: '⑦', name: '报告归档', gate: null },
]

const FLOW_CODES = FLOW_DEF.map((f) => f.code)
const GATE_IDS = [1, 2, 3, 4, 5]

const iso = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return new Date(v).toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const readJsonIfExists = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const listFiles = (dir, depth = 2) => {
  const out = []
  const walk = (d, level) => {
    let items = []
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const full = path.join(d, it.name)
      if (it.isDirectory()) { if (level > 0) walk(full, level - 1); continue }
      let st = null
      try { st = fs.statSync(full) } catch { /* 忽略 */ }
      out.push({ name: it.name, rel: path.relative(dir, full).replace(/\\/g, '/'), full, size: st?.size ?? 0, mtime: st ? st.mtime.toISOString() : null })
    }
  }
  walk(dir, depth)
  return out
}

/** 施工文件证据分类（文件存在性 → 阶段证据；docs/88 §⑦ 实例阶段推断）。 */
export function classifyEvidence(files) {
  const has = (re) => files.some((f) => re.test(f.name))
  return {
    blueprint: has(/^L1/i),
    build: has(/^L2/i),
    minutes: has(/^L3/i),
    appointment: has(/任命书/),
    stageCard: has(/任务卡/),
    acceptance: has(/验收|acceptance/i),
    gateLog: has(/gate|门禁/i),
    handoff: has(/handoff/i),
    archive: has(/归档|archive/i),
    counts: {
      blueprint: files.filter((f) => /^L1/i.test(f.name)).length,
      build: files.filter((f) => /^L2/i.test(f.name)).length,
      minutes: files.filter((f) => /^L3/i.test(f.name)).length,
      appointment: files.filter((f) => /任命书/.test(f.name)).length,
      stageCard: files.filter((f) => /任务卡/.test(f.name)).length,
      total: files.length,
    },
  }
}

/**
 * 阶段推断纯函数（证据 → 阶段/门禁/依据/缺口；无证据不猜）。
 * @param {{files?:Array, teamTasks?:Array, jsonl?:object|null}} input 真实证据（文件表/团队任务/项目台账行）
 * @returns {{status:string, activeCode:string|null, completedStages:number, stByCode:object, gates:object,
 *            basis:string[], gaps:string[], confidence:string, stageNote:string|null}}
 */
export function inferStage(input = {}) {
  const files = input.files ?? []
  const tasks = input.teamTasks ?? []
  const jsonl = input.jsonl ?? null
  const ev = classifyEvidence(files)
  const basis = []
  const gaps = []
  const done = new Set()

  if (jsonl?.completed_stages >= 10 || jsonl?.status === 'completed') {
    for (const c of FLOW_CODES) done.add(c)
    basis.push(`orchestrator 台账 completed_stages=${jsonl.completed_stages ?? '—'} / status=${jsonl.status ?? '—'}`)
  } else {
    if (ev.blueprint) { done.add('0'); done.add('0.5'); done.add('0.8'); done.add('①'); basis.push(`L1 蓝图 ×${ev.counts.blueprint} → Stage 0~① 已过`) }
    if (ev.appointment) { done.add('②'); basis.push(`角色任命书 ×${ev.counts.appointment} → Stage② 分工派活已过`) }
    if (tasks.length) { done.add('0'); done.add('0.5'); done.add('0.8'); done.add('①'); done.add('②'); basis.push(`团队任务台账 ${tasks.length} 条 → Stage② 已过`) }
    if (ev.stageCard) basis.push(`阶段任务卡 ×${ev.counts.stageCard}`)
    // 后续阶段证据（施工/验收/纪要/归档）以前置链存在为前提——仅凭后段文件不跳级推断
    // （实测教训 2026-09-10：孤 L3 纪要项目被误推 Stage⑤/⑥；现改为记缺口并降置信）
    const chainStarted = ev.blueprint || tasks.length > 0 || !!jsonl
    if (!chainStarted && (ev.build || ev.acceptance || ev.minutes || ev.archive)) {
      gaps.push('存在后段产物（L2/L3/验收/归档）但缺 L1 蓝图与任务台账——前置链缺失，不据此推断阶段')
    }
    const doneTasks = tasks.filter((t) => t.status === 'completed').length
    const allTasksDone = tasks.length > 0 && doneTasks === tasks.length
    if (chainStarted && (ev.build || allTasksDone)) { done.add('③'); basis.push(ev.build ? `L2 施工文件 ×${ev.counts.build} → Stage③ 并行交付` : `团队 ${tasks.length} 任务全部完成 → Stage③ 并行交付`) }
    else if (tasks.length) basis.push(`团队 ${doneTasks}/${tasks.length} 任务完成 · 仍有进行中 → Stage③ 并行交付进行中`)
    if (chainStarted && ev.acceptance) { done.add('④'); basis.push('验收报告 → Stage④ 任务验收') }
    if (chainStarted && ev.minutes) { done.add('⑤'); done.add('⑥'); basis.push(`L3 项目纪要 ×${ev.counts.minutes} → Stage⑤/⑥ 已完成`) }
    if (chainStarted && ev.archive) { done.add('⑦'); basis.push('归档记录存在 → Stage⑦ 报告归档已完成') }
    if (jsonl?.completed_stages > 0 && jsonl.completed_stages < 10) basis.push(`orchestrator 台账 completed_stages=${jsonl.completed_stages}`)
    if (ev.gateLog) basis.push('存在 gate 日志（门禁记录）')
    if (!ev.build && (done.has('③') || tasks.some((t) => t.status === 'in_progress' || t.status === 'claimed'))) gaps.push('缺 L2 施工文件（并行交付阶段产物未落盘）')
    if (!ev.acceptance && done.has('③')) gaps.push('缺验收报告（Stage④ 未启动）')
    if (!ev.blueprint && !tasks.length) gaps.push('缺 L1 蓝图与任务台账（可能处于预检/需求期）')
  }

  // 团队任务实况（真实计数，不虚构）
  const running = tasks.filter((t) => t.status === 'in_progress' || t.status === 'claimed')
  const doneCount = tasks.filter((t) => t.status === 'completed').length
  const blocked = tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').length

  // 阶段终态与当前阶段
  let status = 'in_progress'
  let activeCode = FLOW_CODES.find((c) => !done.has(c)) ?? null
  if (done.size === FLOW_CODES.length) { status = 'completed'; activeCode = null }
  else if (!tasks.length && ev.blueprint && !ev.appointment) {
    // 方案设计完成但无分工产物/任务 → 卡在门禁 2 审批（真实证据驱动的等待态）
    status = 'waiting_gate'
    activeCode = null
    basis.push('L1 蓝图在而无分工产物/任务台账 → 推断卡在 🚦门禁2 用户审批')
  } else if (!tasks.length && !files.length && jsonl) {
    status = jsonl.status === 'waiting_gate' ? 'waiting_gate' : 'in_progress'
  }

  // 门禁状态：通过=有下游产物证据；pending=当前等待的下一道门禁；其余 todo
  const gates = {}
  for (const id of GATE_IDS) gates[id] = 'todo'
  if (done.has('①')) gates[1] = 'passed'
  if (done.has('②') || done.has('③') || ev.appointment) gates[2] = 'passed'
  if (ev.acceptance || ev.minutes) { gates[3] = 'passed'; gates[4] = 'passed' }
  if (done.has('⑤') || status === 'completed') gates[5] = 'passed'
  if (status === 'waiting_gate') {
    const nextPending = GATE_IDS.find((id) => gates[id] !== 'passed')
    if (nextPending) gates[nextPending] = 'pending'
  } else if (status !== 'completed') {
    // 进行中：下一道未通过门禁标记 pending（提示主人关注）
    const nextPending = GATE_IDS.find((id) => gates[id] !== 'passed')
    if (nextPending) gates[nextPending] = 'pending'
  }

  const stByCode = {}
  for (const code of FLOW_CODES) stByCode[code] = code === activeCode ? 'active' : done.has(code) ? 'done' : 'todo'

  const noteParts = []
  if (tasks.length) noteParts.push(`团队 ${tasks.length} 任务：${doneCount} 完成 · ${running.length} 进行中${blocked ? ` · ${blocked} 阻塞` : ''}`)
  if (activeCode) noteParts.push(`推断当前 Stage${activeCode} ${FLOW_DEF.find((f) => f.code === activeCode)?.name ?? ''}`)
  if (status === 'waiting_gate') noteParts.push('等待门禁审批')

  const confidence = jsonl || (ev.blueprint && (ev.appointment || tasks.length)) ? 'high'
    : (ev.blueprint || tasks.length || files.length) ? 'medium' : 'low'

  return {
    status,
    activeCode,
    completedStages: done.size,
    stByCode,
    gates,
    basis,
    gaps,
    confidence,
    stageNote: noteParts.length ? noteParts.join(' · ') : null,
  }
}

/** 团队任务 → PvTask（真实状态映射；progress 由真实状态派生，非虚构精度）。 */
function taskToPv(t, members = []) {
  const status = t.status === 'completed' ? 'done'
    : t.status === 'in_progress' ? 'running'
      : t.status === 'claimed' ? 'running'
        : t.status === 'failed' || t.status === 'blocked' ? 'blocked'
          : 'warning'
  const member = members.find((m) => m.name === t.assignee)
  return {
    display: t.assignee ?? (member?.role ?? '未指派'),
    action: String(t.subject ?? t.id ?? ''),
    status,
    progress: status === 'done' ? 1 : status === 'running' ? 0.5 : 0,
    retries: Number(t.attempt ?? 1) > 1 ? Number(t.attempt) - 1 : 0,
    retry_limit: 3,
    id: t.id,
  }
}

/** 团队任务 → 真实事件（created/updated 时间戳原样转换，不虚构）。 */
function taskEvents(teamName, tasks) {
  const out = []
  for (const t of tasks) {
    const created = iso(t.createdAt)
    if (created) out.push({ ts: created, kind: 'role', text: `任务派发：${t.subject ?? t.id} → ${t.assignee ?? '未指派'}`, ref: t.id, source: 'team.json' })
    const updated = iso(t.updatedAt)
    if (updated && t.status && t.status !== 'pending') {
      const label = t.status === 'completed' ? '完成' : t.status === 'in_progress' ? '进行中' : t.status === 'claimed' ? '已认领' : t.status
      out.push({ ts: updated, kind: 'role', text: `${t.assignee ?? '未指派'} ${label}：${t.subject ?? t.id}`, ref: t.id, source: 'team.json' })
    }
  }
  return out
}

/**
 * 读取单个团队工作区（`<teamsRoot>/<name>/team.json`）——**共享 helper**：/flow 与项目详情
 * （t25）同一实现，禁止各处复制解析（docs/99 t20 教训：聚合范围与详情判定必须同源）。
 * @param {string} teamsRoot .agent-teams 根
 * @param {string} name 团队/项目名（目录名）
 * @returns {{dir:string, file:string, teamPath:string, team:object, tasks:Array, members:Array,
 *            memberList:Array, taskStats:object|null, events:Array}|null} 无 team.json → null
 */
export function readTeamWorkspace(teamsRoot, name) {
  const dir = path.join(teamsRoot, name)
  const file = path.join(dir, 'team.json')
  const team = readJsonIfExists(file)
  if (!team) return null
  const tasks = Array.isArray(team.tasks) ? team.tasks : []
  const members = Array.isArray(team.members) ? team.members : []
  return {
    dir,
    file,
    teamPath: file,
    team,
    tasks,
    members,
    memberList: members.map((m) => ({ name: m.name, role: m.role ?? null, id: m.id })),
    taskStats: tasks.length ? taskStatsOf(tasks) : null,
    // 归一事件（团队成立 + 任务 created/updated），与 projects() 同源同序
    events: [
      ...(iso(team.createdAt) ? [{ ts: iso(team.createdAt), kind: 'system', text: `团队成立 ${team.name ?? name}（${members.length} 成员 · 队长 ${String(team.captainSessionId ?? '').slice(0, 18)}）`, source: 'team.json' }] : []),
      ...taskEvents(team.name ?? name, tasks),
    ],
  }
}

/** 团队任务统计（真实计数；共享 helper 与 /flow taskStats 同口径）。 */
function taskStatsOf(tasks) {
  const ts = tasks.map((t) => t.updatedAt).filter(Boolean).sort()
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress' || t.status === 'claimed').length,
    blocked: tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').length,
    updatedAt: ts.length ? iso(ts[ts.length - 1]) : null,
  }
}

/**
 * 流程数据 provider（真实三源）。
 * @param {{teamsRoot?:string, agentsHrDir?:string, agentsDir?:string, accessPath?:string}} opts
 * @returns {{projects:Function, timelineOf:Function, sources:Function}}
 */
export function createFlowProvider(opts = {}) {
  const teamsRoot = opts.teamsRoot ?? defaultTeamsRoot()   // E131：原为三处各写一份（此处那份含写死盘符）⇒ 统一到唯一 home
  const hrDir = opts.agentsHrDir ?? defaultAgentRolesRoot()   // E157：唯一 home
  const agentsDir = opts.agentsDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents')
  const accessPath = opts.accessPath ?? path.join(hrDir, 'data', 'access.jsonl')
  const projectsJsonl = path.join(hrDir, 'data', 'projects.jsonl')
  // ── 第 4 源：工作目录根扫描（E8）────────────────────────────────────────────
  // 配置经插件 config 传入（projectScanRoots / projectScanDepth / projectScanEnabled /
  // projectScanCacheTtlMs），默认值唯一定义在 project-scan.js 的 DEFAULT_SCAN。
  // 惰性：只有 projects() 被调用时才扫；TTL 缓存：同 TTL 内复用，不每次请求全盘扫。
  const scanner = opts.scanner ?? createProjectScanner(normalizeScanConfig(opts.projectScan ?? {}))
  // ── 第 5 源：DSH 自身会话（A5 · M6-1）────────────────────────────────────────
  // 配置经插件 config 传入（dshSessionsEnabled / dshSessionsCacheTtlMs），默认值唯一定义在
  // dsh-source.js 的 DEFAULT_DSH_SOURCE。**默认关**（enabled:false）⇒ 未显式开启时对既有输出**零影响**。
  // 惰性 + TTL 缓存，与第 4 源同形；会话枚举与多帧 zstd 切帧一律复用 log-scan.js（不造第二套）。
  const dshSource = opts.dshSource ?? createDshSource(normalizeDshConfig(opts.dsh ?? {}))
  // ── E9 登记表（只读；**读侧永不产生 registered** —— A3 §5.3.2）──────────────
  const registryFile = opts.registryFile ?? registryPath(hrDir)
  // ── E37 · M1b 入口门禁（**只接 S3 观察**）──────────────────────────────────
  // ① **未显式配置** `registrationGateEnabled` ⇒ 门未安装（不判定、不留痕 —— 避免每个请求刷屏）；
  // ② **显式配置**时**即使开关为 off 也留一行**（硬边界②：否则「关了开关」与「没违规」不可区分）；
  // ③ 观察层**任何异常都吞掉**，且**绝不改变 projects() 的返回值**（S3 = 只记不拦）。
  // ④ **本卡不接 S4（拦）** —— 那需要另行批准（A4 §5.5.3 硬边界①：S3 必须存在，不得 S2 跳 S4）。
  const gateChecksFile = opts.gateChecksFile ?? gateChecksPath(hrDir)
  const gateConfigured = Object.prototype.hasOwnProperty.call(opts, 'registrationGateEnabled')
  const gateEnabled = opts.registrationGateEnabled === true
  const STAGE_DOC_RE = /^L1|^L2|^L3|^S\d|任命书|任务卡/i
  function observeStageGate(name, files, dirs) {
    if (!gateConfigured) return
    try {
      const entries = readRegistry(registryFile)
      const naming = entries.filter((r) => String(r.project_id) === String(name)).pop()?.naming
      for (const f of files) {
        if (!STAGE_DOC_RE.test(f.name) || !/\.md$/i.test(f.name)) continue
        let doc = {}
        try { const fm = parseFrontmatter(fs.readFileSync(f.full, 'utf8')); if (fm.ok) doc = fm.doc } catch { /* 读不到 ⇒ 当无 frontmatter */ }
        const v = gateStageDoc({
          doc, projectId: name, entries, sourceDirs: dirs.map((d) => d.dir), naming,
          enabled: gateEnabled, enforce: false, action: '阶段文档进入流程（/flow 装配点）',
        })
        emitGateCheck(gateChecksFile, v.record)
      }
    } catch { /* 观察层绝不影响既有流程 */ }
  }

  const readTeams = () => {
    const out = []
    let entries = []
    try { entries = fs.readdirSync(teamsRoot, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'archive') continue
      const ws = readTeamWorkspace(teamsRoot, e.name) // 共享 helper（与项目详情同源）
      if (ws) out.push(ws)
    }
    return out
  }

  const readProjectsJsonl = () => {
    const rows = []
    try {
      for (const line of fs.readFileSync(projectsJsonl, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
    } catch { /* 无台账 */ }
    return rows
  }

  /** 项目目录候选（三登记源 ∪ 第 4 源工作目录；同一 dir 只出现一次）。 */
  const projectDirCandidates = (name, scannedOf = new Map(), dshOf = new Map()) => {
    const hit = scannedOf.get(name)
    const dsh = dshOf.get(name)
    return [
      { dir: path.join(hrDir, 'data', 'projects', name), source: 'data/projects' },
      { dir: path.join(agentsDir, 'projects', name), source: 'agents/projects' },
      { dir: path.join(hrDir, 'orchestrator', 'teams', name), source: 'orchestrator/teams' },
      ...(hit ? (hit.dirs ?? [hit.dir]).map((d) => ({ dir: d, source: 'workdir-scan' })) : []), // 一个项目可有多个含标记的目录
      ...(dsh ? (dsh.dirs ?? [dsh.cwd]).map((d) => ({ dir: d, source: 'dsh-sessions' })) : []), // A5 第 5 源：会话 cwd
    ].filter((c) => fs.existsSync(c.dir))
  }

  const accessRowsFor = (name) => {
    let rows = []
    try {
      for (const line of fs.readFileSync(accessPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if (r?.project === name && r.ts) rows.push(r)
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 无 access */ }
    return rows
  }

  /** 全量项目（三源并集；每个项目输出 PvProject 契约）。 */
  function projects() {
    const teams = readTeams()
    const jsonlRows = readProjectsJsonl()
    // 第 4 源：一次取（内部走 TTL 缓存），本次调用全程复用
    const scanRes = scanner.scan()
    const scannedOf = new Map(scanRes.rows.map((r) => [r.name, r]))
    // 第 5 源（A5）：一次取（内部 TTL 缓存），本次调用全程复用
    const dshRes = dshSource.scan()
    const dshOf = new Map(dshRes.rows.map((r) => [r.name, r]))
    const regEntries = readRegistry(registryFile) // 每轮读一次（行级容错；文件缺失=空）
    const names = new Set()
    for (const t of teams) names.add(t.team.name ?? path.basename(t.dir))
    for (const r of jsonlRows) if (r.project) names.add(r.project)
    // **去重判据**：以 project（= 目录 basename）为主键 —— 与既有三源同名即**同一项目**，
    // Set 天然合并且**不新增条目**；该源的目录只是**并入** localDirs（见 projectDirCandidates）。
    for (const r of scanRes.rows) if (r.name) names.add(r.name)
    for (const r of dshRes.rows) if (r.name) names.add(r.name) // A5 第 5 源（同名即同一项目：只并入 localDirs，不新增重复条目）
    for (const byDir of [[hrDir, 'data', 'projects'], [agentsDir, 'projects'], [hrDir, 'orchestrator', 'teams']]) {
      try {
        for (const e of fs.readdirSync(path.join(...byDir), { withFileTypes: true })) if (e.isDirectory()) names.add(e.name)
      } catch { /* 目录缺失 */ }
    }

    const out = []
    for (const name of names) {
      const team = teams.find((t) => (t.team.name ?? path.basename(t.dir)) === name) ?? null
      const jsonl = jsonlRows.find((r) => r.project === name) ?? null
      const dirs = projectDirCandidates(name, scannedOf, dshOf)
      const allFiles = dirs.flatMap((d) => listFiles(d.dir).map((f) => ({ ...f, source: d.source })))
      // ── M1b（E64）硬凭证门：**无条件**（不受 registrationGateEnabled 影响 · 「开关不算门」）──
      // 无项目 id / 无上游凭证 的 stage 文档 **不进流程与验收**（从 files 剔除，且行上留 gateBlocked）
      const cred = credentialFilter(allFiles, (f) => { try { return fs.readFileSync(f.full, "utf8") } catch (e) { return null } })
      if (cred.blocked.length) {
        try {
          for (const v of cred.checks) if (!v.ok) emitGateCheck(gateChecksFile, { ts: new Date().toISOString(), mode: "credential", action: "硬凭证门（M1b/E64）", project: name, ok: false, failures: v.failures, switch_source: "none" })
        } catch (e) { /* 留痕失败不反噬 */ }
      }
      const files = cred.files
      observeStageGate(name, files, dirs) // E37 · S3 观察：判定 + 留痕，**不改下方任何取值**
      const access = accessRowsFor(name)
      const tasks = team?.tasks ?? []
      const inf = inferStage({ files, teamTasks: tasks, jsonl })
      const events = [
        ...(jsonl?.started_at ? [{ ts: iso(jsonl.started_at), kind: 'stage', text: `项目立项（orchestrator 台账）· status=${jsonl.status ?? '—'}`, source: 'projects.jsonl' }] : []),
        ...(team ? team.events : []), // 团队成立 + 任务事件（共享 helper 归一）
        ...access.map((r) => ({ ts: iso(r.ts), kind: 'role', text: `角色激活 ${r.role}${r.session_id ? `（会话 ${String(r.session_id).slice(0, 12)}…）` : ''}`, source: 'access.jsonl' })),
        ...files.filter((f) => /^L1|^L2|^L3|任命书|任务卡/i.test(f.name)).map((f) => ({
          ts: f.mtime,
          kind: /任命书|任务卡/.test(f.name) ? 'role' : 'stage',
          text: `产出文件：${f.rel}（${f.source}）`,
          source: f.source,
        })),
        ...files.filter((f) => /gate|门禁/i.test(f.name)).map((f) => ({ ts: f.mtime, kind: 'gate', text: `门禁记录：${f.rel}`, source: f.source })),
      ].filter((e) => e.ts).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))

      // E9：登记状态（**不新增条目**，只是同一条项目的字段 ⇒ 满足「同一项目只出现一次」）
      const reg = resolveRegistration({ projectId: name, entries: regEntries, sourceDirs: dirs.map((d) => d.dir) })
      out.push({
        project: name,
        registration: { status: reg.status, ...(reg.registration ?? {}) },
        gateBlocked: cred.blocked.length ? cred.blocked : undefined, // M1b/E64：被硬凭证门拦下的文件（可观测）
        status: inf.status,
        started_at: iso(jsonl?.started_at) ?? iso(team?.team?.createdAt) ?? (files.length ? files.map((f) => f.mtime).sort()[0] : null),
        completed_stages: inf.completedStages,
        deliverables: jsonl?.deliverables ?? files.length,
        activeCode: inf.activeCode,
        stageNote: inf.stageNote,
        stByCode: inf.stByCode,
        gates: inf.gates,
        tasks: tasks.length ? tasks.slice(0, 40).map((t) => taskToPv(t, team?.members ?? [])) : undefined,
        events: events.slice(0, 80),
        // 真实性/可溯源附注（UI 可折叠展示）
        inference: { basis: inf.basis, gaps: inf.gaps, confidence: inf.confidence },
        sources: {
          team: team?.teamPath ?? null,
          jsonl: jsonl ? projectsJsonl : null,
          localDirs: dirs.map((d) => d.dir),
          accessRows: access.length,
        },
        members: team ? team.memberList : [],
        taskStats: team ? team.taskStats : null,
      })
    }
    // 排序：运行中团队优先（真实实况置顶），其余按 started_at 倒序
    return out.sort((a, b) => (b.sources.team ? 1 : 0) - (a.sources.team ? 1 : 0)
      || String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')))
  }

  /** 单项目真实时间线（等价于 /agents/projects/:name/timeline）。 */
  function timelineOf(name) {
    const p = projects().find((x) => x.project === name)
    if (!p) return null
    return { ok: true, project: name, inference: p.inference, events: p.events, taskStats: p.taskStats }
  }

  /** E9：按项目名取登记状态（供 projectDetail 复用；与 /flow 同一 registry 读点）。 */
  function registrationOf(name, sourceDirs = []) {
    return resolveRegistration({ projectId: name, entries: readRegistry(registryFile), sourceDirs })
  }

  /** 第 4 源：按项目名取工作目录候选（与 /flow 同源同缓存；E8 —— 供 projectDetail 复用）。 */
  function workdirRow(name) {
    return scanner.scan().rows.find((r) => r.name === name) ?? null
  }

  function sources() {
    const st = scanner.stats()
    // E131：**不许静默空** —— 扫描根不存在/不可读时给出**缺因**（换机/改名 ⇒ 一眼看出为何没有项目）
    const missRoots = missingRoots(st.roots)
    // E157：**gbrain 源根缺席同样不许静默** —— 出了明示降级（照 AIMS 服务缺席样板：用户看得见原因 + 补法）
    const hrMiss = missingRoots([hrDir])
    return {
      teamsRoot,
      agentsHrDir: hrDir,
      agentsHrDirExists: hrMiss.length === 0,
      agentsDir,
      accessPath,
      projectsJsonl,
      registryFile, // E9：登记表落点（只读面）
      // 第 4 源（E8）：配置 + 缓存现状（便于 QA 核对「可配置 / 有缓存」）
      workdirScan: Object.assign({ enabled: st.enabled, roots: st.roots, maxDepth: st.maxDepth, cacheTtlMs: st.cacheTtlMs, cached: st.cached, cachedRows: st.cachedRows },
        missRoots.length ? { missingRoots: missRoots, reason: '扫描根不存在/不可读：' + missRoots.join(' · ') + ' ⇒ 这些根**贡献 0 个项目**（config 项 projectScanRoots 可覆盖；默认值唯一定义见 lib/agents/platform-paths.js）' } : {}),
      // E157（**只增不改**：原字段语义一字未动）：gbrain 源根缺席 ⇒ 明示缺因 + 补法
      ...(hrMiss.length ? { missingHrDir: hrMiss, hrReason: 'gbrain 源根不存在：' + hrDir + ' ⇒ 人事部档案（registry/access/role 副本）读不到（可设 agentsHrDir 指向实际位置，或安装 gbrain；默认值唯一定义见 lib/agents/platform-paths.js）' } : {}),
    }
  }

  return { projects, timelineOf, sources, workdirRow, registrationOf }
}
