// huahua-os · 人事部融合 阶段 1B：lib/agents HTTP API 端点族（t10 · docs/89 §六 C1-C6 + docs/88 §四）
// 挂载 /memory-evolve/api/agents/*（对齐 lib/aims/routes.js 的 webServer.register prefix 模式）。
//   读：GET /catalog（副本角色目录：分页/部门过滤/检索，可选 ?aims=1 JOIN AIMS 激活态）
//       GET /catalog/:slug（单角色：frontmatter + 正文摘要 + 可选 access 行）
//       GET /access（access.jsonl 读侧：时间线/频率/按 role|project 过滤）
//       GET /teams（三源：.agent-teams 运行中 + orchestrator/templates 模板库 + orchestrator/teams 固化）
//       GET /projects（项目留痕聚合：access project ∪ agent-roles data/projects ∪ AIMS by cwd 计数）
//       GET /projects/:name（t18：施工文件树 + 交付物路径清单 + 聚合；?aims=1 转发 AIMS 会话/交付物）
//       GET /projects/:name/file?rel=<相对路径>（t18：项目文件内容预览，safeJoin 防逃逸）
//       GET /orchestrator（机制只读解析：SKILL.md 阶段/门禁/规则 + team-project.yaml 六步）
//       GET /aims-role · /aims-roles（AIMS 联动：HTTP 转发 8710 只读——docs/62 §2.4 方案 C）
//       GET /sync-status（t22：副本同步状态——autoSync/syncedAt/drifted/lastCheck/lastSync；?force=1 强制检）
//       GET /ledger（U2B：看板台账只读读面——读 **已提交内容**（HEAD 树）的 cards/verdicts/records +
//         rev/committedAt；**不读工作副本** ⇒ 蓝图 §11.4-4；?force=1 绕缓存强制真读）
//   写：POST /catalog（模块②角色库管理唯一写口：写副本 custom/<slug>.md + .ops/ops.jsonl 留痕 +
//       tombstone 软删；**只写 huahua-os 副本，源零改动**——docs/87 决策 4A 红线）
//       POST /sync（t22：立即同步——复用 scripts/agents-sync.mjs --apply，只读源写副本）
//       POST /teams/reuse · /teams/:name/reuse（t18：团队一键复用配方——template/solid/running 三源，
//       body {type,name} 或路径 + ?type=；只读源 + 副本 .ops 留痕；spawn 执行由 UI/调用侧引导）
// 数据面纪律：目录/角色读副本 agents/（agentsDir 可配）；access/orchestrator/teams/projects 源数据
//   读 ~/.gbrain/agent-roles（agentsHrDir，只读）；宿主不直读 aims-index.db（docs/62）。
// registry/trace 复用：默认 dynamic import('./registry.js') / ('./trace.js') 懒加载——engineer 1A
//   （t9）落盘后自动生效；未落盘时 catalog 系返回 503 + 引导提示。测试可经 createAgentsHandler 注入
//   deps.registry / deps.trace / deps.config（fake），不依赖真实 1A 文件。
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createFlowProvider, readTeamWorkspace } from './flow.js'
// E131：teams 根默认值 / orchestrator 子目录名 = **唯一 home**（platform-paths.js）
import { defaultTeamsRoot, defaultAgentRolesRoot, ORCH_SUBDIR, ORCH_LEGACY_SUBDIR, orchestratorNameDrift } from '../agents/platform-paths.js'

export const AGENTS_API_BASE = '/memory-evolve/api/agents'
const BODY_MAX_BYTES = 256 * 1024
const AIMS_TIMEOUT_MS = 1500
const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 200
const BODY_PREVIEW_CHARS = 2000

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 副本默认位 = <memory-evolve 仓库根>/agents（docs/89 §1.1；符号链接安装态等价源）。 */
export function defaultAgentsDir() {
  return path.resolve(__dirname, '..', '..', 'agents')
}
// E157：gbrain 源根默认值的本地定义**已删除**（原为 5 处各写一份）⇒ 改用 platform-paths.js 的唯一 home
const defaultHrDir = () => defaultAgentRolesRoot()
const defaultAccessPath = () => path.join(defaultAgentRolesRoot(), 'data', 'access.jsonl')
// E131：teams 根默认值的本地定义**已删除**（原为「三处各写一份」的一份）⇒ 改用 platform-paths.js 的 defaultTeamsRoot()

/** @param {{getRuntime?:()=>object, config?:object}} deps */
function cfgOf(deps) {
  const rt = deps.getRuntime?.() ?? {}
  const c = deps.config ?? {}
  const pick = (key, dflt) => rt[key] ?? c[key] ?? dflt
  return {
    agentsDir: pick('agentsDir', null) || defaultAgentsDir(),
    agentsHrDir: pick('agentsHrDir', null) || defaultHrDir(),
    agentsAccessPath: pick('agentsAccessPath', null) || defaultAccessPath(),
    agentsAimsUrl: pick('agentsAimsUrl', null) || 'http://127.0.0.1:8710',
    agentsTeamsRoot: pick('agentsTeamsRoot', null) || pick('aimsTeamsRoot', null) || defaultTeamsRoot(),
    agentsAutoSync: pick('agentsAutoSync', undefined), // t22：undefined→默认开（sync.js 内判）
    // ── E8 第 4 源（工作目录扫描）配置**必须经此透传** ──
    // 本函数是**白名单**：不列在这里的键会被丢弃，插件配置项就永远到不了 flow provider
    // （本次自曝：漏列时 "关掉该源" 的对照恒失败 = 配置不生效）。默认给 undefined ⇒
    // normalizeScanConfig 回落 lib/agents/project-scan.js 的 DEFAULT_SCAN（单一定义处）。
    projectScanEnabled: pick('projectScanEnabled', undefined),
    projectScanRoots: pick('projectScanRoots', undefined),
    projectScanDepth: pick('projectScanDepth', undefined),
    projectScanCacheTtlMs: pick('projectScanCacheTtlMs', undefined),
    // ── A5 第 5 源（DSH 自身会话）配置**必须经此透传**（白名单：漏列则配置到不了 provider）──
    // 默认 undefined ⇒ normalizeDshConfig 回落 dsh-source.js 的 DEFAULT_DSH_SOURCE（单一定义处）。
    dshSessionsEnabled: pick('dshSessionsEnabled', undefined),
    dshSessionsCacheTtlMs: pick('dshSessionsCacheTtlMs', undefined),
    // ── E9 入口门禁（同上：白名单必须列出，否则配置到不了 provider）──
    registrationGateEnabled: pick('registrationGateEnabled', undefined),
    projectRegistryPath: pick('projectRegistryPath', undefined),
  }
}

/** 归一角色键：'agents/<slug>' | '<slug>.md' | '<dept>-<name>' → 纯 kebab role_key。 */
export function normalizeRoleKey(v) {
  let s = String(v ?? '').trim()
  if (!s) return ''
  s = s.replace(/^agents\//, '').replace(/\.md$/i, '')
  return /^[a-z][a-z0-9-]*$/.test(s) ? s : ''
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req, maxBytes = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`body 超限（>${maxBytes} bytes）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 路径包含检查：rel 必须落在 root 内（防写口逃逸副本目录）。 */
function safeJoin(root, rel) {
  const base = path.resolve(root)
  const full = path.resolve(base, rel)
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`路径逃逸副本目录: ${rel}`)
  }
  return full
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * frontmatter 极简解析（--- 首块内 k: v 行）——角色 md 定义用（docs/89 §2.1）。
 * @param {string} text md 全文
 * @param {boolean} [full] true=body 返回完整正文（?full=1 单角色详情用，不截断）；
 *                         false=body 截断 BODY_PREVIEW_CHARS（默认轻量）
 * @returns {{ frontmatter: Record<string,string>, body: string }}
 */
function parseFrontmatter(text, full = false) {
  const fm = {}
  const src = String(text ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  const cap = (s) => (full ? s : s.slice(0, BODY_PREVIEW_CHARS))
  if (!m) return { frontmatter: fm, body: cap(src) }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { frontmatter: fm, body: cap(src.slice(m[0].length).trim()) }
}

// ---------- access.jsonl 读侧（只读源；行格式 {role, ts, project?, session_id?}，旧行无 extra 兼容） ----------
function parseAccess(file) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return []
  }
  const rows = []
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      if (!row || typeof row.role !== 'string' || !row.ts) continue
      rows.push({ role: row.role, role_key: normalizeRoleKey(row.role), ts: row.ts, project: row.project ?? null, session_id: row.session_id ?? null })
    } catch {
      // 坏行跳过（append-only 流容忍）
    }
  }
  return rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
}

// ---------- AIMS 联动：HTTP 转发 8710（只读，不直读库） ----------
async function aimsGet(aimsUrl, apiPath, timeoutMs = AIMS_TIMEOUT_MS) {
  try {
    const url = new URL(apiPath, aimsUrl)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(url, { signal: ctrl.signal })
      if (!resp.ok) return { ok: false, status: resp.status }
      return { ok: true, body: await resp.json() }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { ok: false, error: 'AIMS server 不可达（8710 未启动或超时）' }
  }
}

// ---------- teams/projects/orchestrator 源扫描（只读，容忍缺目录） ----------
// orchestrator 内容分散多副本（实测 2026-09-09）：~/.gbrain/agent-roles/orchestrator 有
// SKILL.md/team-project.yaml/teams（固化）但缺 templates/；~/.agents/skills/agent-roles/
// orchestrator 有 templates/（31 yaml）。子目录级回退链：agentsHrDir/orchestrator →
// 副本镜像 agentsDir/orchestrator（未来 U2 同步）→ ~/.agents 技能源。单测 fixture 的
// agentsHrDir/orchestrator 存在且非空即独占（不探测真实源——隔离性）。
const secondaryOrchRoot = () => path.join(homedir(), '.agents', 'skills', 'agent-roles', 'orchestrator')

/** orchestrator 子目录解析：返回第一个存在且非空的候选；全缺 → null。 */
function orchSubDir(cfg, sub) {
  const candidates = [
    path.join(cfg.agentsHrDir, 'orchestrator', sub),
    path.join(cfg.agentsDir, 'orchestrator', sub),
    path.join(secondaryOrchRoot(), sub),
  ]
  for (const d of candidates) {
    try {
      if (fs.existsSync(d) && fs.readdirSync(d).length > 0) return d
    } catch { /* 不可读 → 试下一个 */ }
  }
  return null
}

/** orchestrator 机制目录（含 SKILL.md / team-project.yaml 之一）；全缺 → null。 */
function orchMetaDir(cfg) {
  const candidates = [
    path.join(cfg.agentsHrDir, 'orchestrator'),
    path.join(cfg.agentsDir, 'orchestrator'),
    secondaryOrchRoot(),
  ]
  for (const d of candidates) {
    try {
      if (fs.existsSync(path.join(d, 'SKILL.md')) || fs.existsSync(path.join(d, 'team-project.yaml'))) return d
    } catch { /* 忽略 */ }
  }
  return null
}

function scanRunningTeams(teamsRoot) {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(teamsRoot, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(teamsRoot, e.name, 'team.json')
    const tj = readJsonIfExists(file)
    if (!tj) continue
    out.push({
      type: 'running', id: tj.id ?? e.name, name: tj.name ?? e.name,
      description: tj.description ?? '',
      captainSessionId: tj.captainSessionId ?? null,
      members: (tj.members ?? []).map((m) => ({ name: m.name, id: m.id, role: m.role ?? null })),
      taskCount: Array.isArray(tj.tasks) ? tj.tasks.length : null,
      source: file,
    })
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** 扫描 templates 根目录下的 yaml（根级 + 子目录分组）。root 由 orchSubDir 解析。 */
function scanTemplateYamls(root) {
  const out = []
  if (!root || !fs.existsSync(root)) return out
  const walk = (dir, group) => {
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (it.isDirectory()) { walk(path.join(dir, it.name), it.name); continue }
      if (it.isFile() && it.name.endsWith('.yaml')) {
        out.push({ type: 'template', name: it.name.replace(/\.yaml$/, ''), group: group ?? 'root', file: path.join(dir, it.name) })
      }
    }
  }
  walk(root, null)
  return out.sort((a, b) => String(a.group).localeCompare(String(b.group)) || String(a.name).localeCompare(String(b.name)))
}

/** 扫描固化团队根目录（teams/<name>/README.md…）。root 由 orchSubDir 解析。 */
function scanSolidTeams(root) {
  const out = []
  if (!root || !fs.existsSync(root)) return out
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const readme = path.join(root, e.name, 'README.md')
    const files = []
    try { files = fs.readdirSync(path.join(root, e.name)).filter((f) => f.endsWith('.md')) } catch { /* 忽略 */ }
    out.push({
      type: 'solid', name: e.name,
      summary: fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8').slice(0, 300) : '',
      docs: files, dir: path.join(root, e.name),
    })
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function scanProjects(hrDir, projectsDataDir) {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(projectsDataDir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(projectsDataDir, e.name)
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => /\.md$/.test(f)) } catch { /* 忽略 */ }
    out.push({
      type: 'project', name: e.name, dir,
      hasBlueprint: files.some((f) => /^L1/i.test(f)),
      hasBuild: files.some((f) => /^L2/i.test(f)),
      hasMinutes: files.some((f) => /^L3/i.test(f)),
      hasAppointment: files.some((f) => f.includes('任命书')),
      files: files.slice(0, 50),
    })
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** orchestrator 机制只读解析：SKILL.md 阶段/门禁/规则行 + team-project.yaml 步骤 id 序列。 */
function parseOrchestrator(orchDir) {
  const out = { source: orchDir, stages: [], gates: [], rules: [], lifecycleSteps: [], lifecycleRoles: [] }
  const skill = path.join(orchDir, 'SKILL.md')
  if (fs.existsSync(skill)) {
    const text = fs.readFileSync(skill, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const st = /^\s*Stage\s+([\d.]+|[\d.]+[①-⑩]?|[①-⑩])\s*[:：]?\s*(.*)$/i.exec(line)
      if (st) out.stages.push({ id: st[1], name: (st[2] || '').trim() })
      const gt = /(门禁\s*\d+)\s*[（(]?([^）)\n]*)/.exec(line)
      if (gt) out.gates.push({ id: gt[1].replace(/\s+/g, ''), name: gt[2].trim() })
      const ru = /^\s*(\d+)\.\s*(.+)$/.exec(line)
      if (ru && /规则|产出|偏差|用户|角色|归档/.test(ru[2])) out.rules.push(ru[2].trim())
    }
  }
  const yaml = path.join(orchDir, 'team-project.yaml')
  if (fs.existsSync(yaml)) {
    const text = fs.readFileSync(yaml, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const id = /^\s*-\s*id:\s*(\S+)/.exec(line)
      if (id) out.lifecycleSteps.push(id[1])
      const role = /^\s*role:\s*"?([^"#\s]+)/.exec(line)
      if (role) out.lifecycleRoles.push(role[1])
    }
  }
  return out
}

// ---------- registry/trace 懒加载（engineer 1A 复用；deps 注入优先） ----------
// 按 agentsDir 键控缓存且只缓存成功（模块未落盘/目录未同步不缓存——1A 落盘后无需重启即生效；
// 单测用多个临时副本目录互不串扰）。
const coreCache = new Map()
async function loadCore(cfg) {
  const key = cfg.agentsDir
  if (coreCache.has(key)) return coreCache.get(key)
  const pending = Promise.allSettled([
    import('./registry.js').then((m) => m.createRegistry?.({ agentsDir: cfg.agentsDir }) ?? null),
    import('./trace.js').then((m) => m.createTrace?.({ accessPath: cfg.agentsAccessPath }) ?? null),
  ]).then(([reg, trc]) => {
    const core = {
      registry: reg.status === 'fulfilled' && reg.value ? reg.value : null,
      trace: trc.status === 'fulfilled' && trc.value ? trc.value : null,
    }
    if (core.registry || core.trace) coreCache.set(key, core)
    return core
  })
  return pending
}

function coreUnavailable(res, name) {
  sendJson(res, 503, { ok: false, error: `阶段1A lib/agents ${name} 未落盘（engineer t9 进行中）；落盘后本端点自动生效` })
}

// ---------- 端点实现 ----------
async function listCatalog(deps, cfg, url, res) {
  const core = await loadCore(cfg)
  const registry = deps.registry ?? core.registry
  if (!registry?.list) return coreUnavailable(res, 'registry')
  const q = url.searchParams.get('q')?.trim() || ''
  const dept = url.searchParams.get('dept')?.trim() || ''
  const page = Math.max(Number(url.searchParams.get('page')) || 1, 1)
  const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  let listed
  try {
    listed = await registry.list({ q, dept, page, pageSize })
  } catch (e) {
    return sendJson(res, 503, { ok: false, error: `registry.list 失败（副本可能未同步）: ${e.message}` })
  }
  // 归一 registry 返回（engineer 1A createRegistry.list → {total,page,pageSize,roles}；
  // 兼容旧/第三方实现返回 rows）
  const roles = listed?.roles ?? listed?.rows ?? []
  const payload = {
    ok: true,
    syncedAt: null,
    total: listed?.total ?? roles.length,
    page: listed?.page ?? page,
    pageSize: listed?.pageSize ?? pageSize,
    roles,
  }
  const man = readJsonIfExists(path.join(cfg.agentsDir, 'MANIFEST.json'))
  if (man) payload.syncedAt = man.syncedAt ?? null
  // 可选 AIMS 激活态 JOIN（?aims=1）：只读转发 8710 /api/roles
  if (url.searchParams.get('aims') === '1') {
    const hit = await aimsGet(cfg.agentsAimsUrl, '/api/roles?agent_id=lili')
    if (hit.ok) {
      const map = new Map((hit.body?.rows ?? []).map((r) => [r.role_key, {
        nature: r.nature, status: r.status, sessionCount: r.sessionCount,
        outputCount: r.outputCount, memoryCount: r.memoryCount, display_name: r.display_name,
      }]))
      payload.roles = payload.roles.map((r) => ({ ...r, aims: map.get(r.role_key) ?? null }))
      payload.aimsSource = 'forward:lili'
    } else {
      payload.aimsSource = null
    }
  }
  return sendJson(res, 200, payload)
}

async function roleDetail(deps, cfg, url, res, slugRaw) {
  const core = await loadCore(cfg)
  const registry = deps.registry ?? core.registry
  const roleKey = normalizeRoleKey(slugRaw)
  if (!roleKey) return sendJson(res, 400, { ok: false, error: `非法 slug: ${slugRaw}` })
  const full = url.searchParams.get('full') === '1' // 主人反馈：角色详情需完整 prompt——?full=1 返回完整正文（单角色可控）
  let entry = null
  if (registry?.resolve) {
    try { entry = await registry.resolve(roleKey) } catch { entry = null }
  }
  const payload = { ok: true, role_key: roleKey, slug: `agents/${roleKey}`, entry: entry ?? null }
  if (entry?.file) {
    for (const sub of ['source', 'custom']) {
      const file = safeJoin(path.join(cfg.agentsDir, sub), entry.file)
      if (fs.existsSync(file)) {
        const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'), full)
        payload.frontmatter = parsed.frontmatter
        payload.bodyPreview = full ? parsed.body.slice(0, BODY_PREVIEW_CHARS) : parsed.body
        if (full) payload.body = parsed.body // 完整 prompt 正文（默认路径不返回，保持轻量）
        payload.definitionPath = file
        break
      }
    }
  }
  if (!entry && !payload.definitionPath) {
    // custom 回退（模块② POST /catalog 写的 custom md 不在 role-index 内）：
    // 直接读 custom/<roleKey>.md 提供详情（registry.resolve 未命中不报 404）
    const customFile = safeJoin(path.join(cfg.agentsDir, 'custom'), `${roleKey}.md`)
    if (fs.existsSync(customFile)) {
      const parsed = parseFrontmatter(fs.readFileSync(customFile, 'utf8'), full)
      payload.custom = true
      payload.frontmatter = parsed.frontmatter
      payload.bodyPreview = full ? parsed.body.slice(0, BODY_PREVIEW_CHARS) : parsed.body
      if (full) payload.body = parsed.body
      payload.definitionPath = customFile
      return sendJson(res, 200, payload)
    }
    return sendJson(res, 404, { ok: false, error: `目录层无角色: ${roleKey}（未激活未同步均可能）` })
  }
  if (url.searchParams.get('includeAccess') === '1') {
    const rows = parseAccess(cfg.agentsAccessPath).filter((r) => r.role_key === roleKey)
    payload.access = { total: rows.length, recent: rows.slice(0, 20) }
  }
  return sendJson(res, 200, payload)
}

async function accessFeed(cfg, url, res) {
  const rows = parseAccess(cfg.agentsAccessPath)
  const role = url.searchParams.get('role')?.trim() || ''
  const project = url.searchParams.get('project')?.trim() || ''
  const since = url.searchParams.get('since')?.trim() || ''
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
  let filtered = rows
  if (role) {
    const rk = normalizeRoleKey(role)
    filtered = filtered.filter((r) => r.role === role || r.role_key === rk || r.role_key === role.replace(/^agents\//, ''))
  }
  if (project) filtered = filtered.filter((r) => r.project === project)
  if (since) filtered = filtered.filter((r) => r.ts >= since)
  const byRole = new Map()
  for (const r of filtered) {
    const k = r.role
    if (!byRole.has(k)) byRole.set(k, { role: k, count: 0, lastTs: null })
    const agg = byRole.get(k)
    agg.count += 1
    if (!agg.lastTs || r.ts > agg.lastTs) agg.lastTs = r.ts
  }
  const freq = [...byRole.values()].sort((a, b) => b.count - a.count)
  return sendJson(res, 200, { ok: true, total: filtered.length, file: cfg.agentsAccessPath, freq, rows: filtered.slice(0, limit) })
}

async function teamsFeed(cfg, url, res) {
  const body = {
    ok: true,
    running: scanRunningTeams(cfg.agentsTeamsRoot),
    templates: scanTemplateYamls(orchSubDir(cfg, ORCH_SUBDIR.templates)),
    solid: scanSolidTeams(orchSubDir(cfg, ORCH_SUBDIR.teams)),
    sources: {
      running: cfg.agentsTeamsRoot,
      orch: path.join(cfg.agentsHrDir, 'orchestrator'),
      // E131：**实际被读的那一份**（修「读数失真」：原 sources.orch 是硬编码声明位，回退发生时与事实不符）
      resolved: { templates: orchSubDir(cfg, ORCH_SUBDIR.templates), teams: orchSubDir(cfg, ORCH_SUBDIR.teams) },
      templatesDirName: ORCH_SUBDIR.templates,
      // E131：目录名**唯一口径** = templates（代码只读这个名字）；旧名 team-templates 在位时**显式报告「不在读取链上」**（原来静默无效）
      nameDrift: orchestratorNameDrift([path.join(cfg.agentsHrDir, 'orchestrator'), path.join(cfg.agentsDir, 'orchestrator'), secondaryOrchRoot()]),
      note: 'templates/teams 子目录回退链：agentsHrDir/orchestrator → agentsDir/orchestrator(副本镜像) → ~/.agents/skills/agent-roles/orchestrator（只读，未改动源）；目录名唯一口径 = ' + ORCH_SUBDIR.templates + '/' + ORCH_SUBDIR.teams + '（旧名 ' + ORCH_LEGACY_SUBDIR.templates + ' 只报不读）',
    },
  }
  return sendJson(res, 200, body)
}

async function projectsFeed(cfg, url, res) {
  const hrProjects = path.join(cfg.agentsHrDir, 'data', 'projects')
  // ① access project 字段去重
  const accessProjects = new Map()
  for (const r of parseAccess(cfg.agentsAccessPath)) {
    if (r.project) {
      if (!accessProjects.has(r.project)) accessProjects.set(r.project, { name: r.project, activationCount: 0, lastTs: null })
      const agg = accessProjects.get(r.project)
      agg.activationCount += 1
      if (!agg.lastTs || r.ts > agg.lastTs) agg.lastTs = r.ts
    }
  }
  const byAccess = [...accessProjects.values()]
  // ② orchestrator data/projects 施工留痕目录
  const byOrch = scanProjects(cfg.agentsHrDir, hrProjects)
  // ③ 归一合并
  const seen = new Set()
  const projects = []
  const add = (p) => { if (!seen.has(p.name)) { seen.add(p.name); projects.push({ ...p, aimCount: null, sources: [] }) } }
  for (const p of byAccess) { add({ name: p.name, activationCount: p.activationCount, lastTs: p.lastTs }); const t = projects.find((x) => x.name === p.name); t.sources.push('access') }
  for (const p of byOrch) { add({ ...p }); const t = projects.find((x) => x.name === p.name); t.sources.push('orchestrator-data') }
  // ④ 本地施工目录可用性（t20：UI 据此区分「有施工记录」与「仅 access 调用留痕」，详情降级不报错）
  for (const p of projects) {
    const dirs = projectDirsOf(cfg, p.name)
    p.tree = {
      available: dirs.length > 0,
      files: dirs.length > 0 ? dirs.reduce((n, d) => n + scanProjectTree(d.dir).length, 0) : 0,
    }
    p.degraded = dirs.length === 0 ? 'access-only' : null
    if (!p.dir && dirs.length) p.dir = dirs[0].dir
  }
  // AIMS by cwd 计数（?aims=1 且项目数 ≤20：逐项目转发 /api/sessions?project= 拿 total——只读）
  if (url.searchParams.get('aims') === '1' && projects.length <= 20) {
    for (const p of projects) {
      const hit = await aimsGet(cfg.agentsAimsUrl, `/api/sessions?project=${encodeURIComponent(p.name)}&limit=1`)
      if (hit.ok) { p.aimCount = hit.body?.total ?? 0; p.sources.push('aims-cwd') }
    }
  }
  return sendJson(res, 200, { ok: true, total: projects.length, projects: projects.sort((a, b) => String(a.name).localeCompare(String(b.name))) })
}

async function orchestratorMeta(cfg, url, res) {
  const orchDir = orchMetaDir(cfg)
  if (!orchDir) {
    return sendJson(res, 404, { ok: false, error: `orchestrator 机制源缺失（查 agentsHrDir/agentsDir/~/.agents 技能源均无 SKILL.md/team-project.yaml）` })
  }
  return sendJson(res, 200, { ok: true, ...parseOrchestrator(orchDir) })
}

async function aimsRole(deps, cfg, url, res) {
  const agent = url.searchParams.get('agent')?.trim() || 'lili'
  const roleRaw = url.searchParams.get('role')?.trim() || url.searchParams.get('role_key')?.trim() || ''
  if (!roleRaw) return sendJson(res, 400, { ok: false, error: '缺少 role（role_key 或 agents/<slug>）' })
  const roleKey = normalizeRoleKey(roleRaw)
  const hit = await aimsGet(cfg.agentsAimsUrl, `/api/roles/${encodeURIComponent(agent)}/${encodeURIComponent(roleKey)}`)
  if (!hit.ok) return sendJson(res, 502, { ok: false, error: hit.error ?? `AIMS 转发失败 (HTTP ${hit.status})`, forwarded: `/api/roles/${agent}/${roleKey}` })
  return sendJson(res, 200, { ok: true, agent, role_key: roleKey, aggregate: hit.body })
}

async function aimsRolesList(deps, cfg, url, res) {
  const agent = url.searchParams.get('agent')?.trim() || 'lili'
  const hit = await aimsGet(cfg.agentsAimsUrl, `/api/roles?agent_id=${encodeURIComponent(agent)}`)
  if (!hit.ok) return sendJson(res, 502, { ok: false, error: hit.error ?? `AIMS 转发失败 (HTTP ${hit.status})` })
  return sendJson(res, 200, { ok: true, agent, rows: hit.body?.rows ?? [] })
}

async function postCatalog(deps, cfg, req, res) {
  let bodyText
  try { bodyText = await readBody(req) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
  let body
  try { body = JSON.parse(bodyText || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'body 必须是 JSON' }) }
  const action = String(body.action ?? 'create')
  const roleKey = normalizeRoleKey(body.slug ?? body.role_key ?? body.role ?? '')
  if (!roleKey) return sendJson(res, 400, { ok: false, error: '缺少合法 role_key/slug' })
  if (!['create', 'update', 'delete'].includes(action)) {
    return sendJson(res, 400, { ok: false, error: 'action 必须是 create/update/delete' })
  }
  const customDir = path.join(cfg.agentsDir, 'custom')
  const opsDir = path.join(cfg.agentsDir, '.ops')
  try {
    fs.mkdirSync(customDir, { recursive: true })
    fs.mkdirSync(path.join(opsDir, 'trash'), { recursive: true })
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `副本目录不可写: ${e.message}` })
  }
  const target = safeJoin(customDir, `${roleKey}.md`)
  const stamp = new Date().toISOString()
  const op = { op: action, role_key: roleKey, ts: stamp, session_id: body.session_id ?? null }
  try {
    if (action === 'delete') {
      if (fs.existsSync(target)) fs.renameSync(target, path.join(opsDir, 'trash', `${roleKey}-${stamp.replace(/[:.]/g, '-')}.md`))
      fs.appendFileSync(path.join(opsDir, 'tombstones.jsonl'), JSON.stringify({ ...op, tombstonesAt: stamp }) + '\n')
      return sendJson(res, 200, { ok: true, op, file: target, tombstoned: true })
    }
    const name = String(body.name ?? roleKey)
    const desc = String(body.description ?? body.desc ?? '')
    const emoji = String(body.emoji ?? '')
    const color = String(body.color ?? '')
    const content = String(body.content ?? `# ${name}\n\n${desc ? `> ${desc}\n\n` : ''}（huahua-os custom 角色 · ${stamp}）\n`)
    const md = `---\nname: ${name}\ndescription: ${desc}\nemoji: ${emoji}\ncolor: "${color}"\ncustom: true\n---\n\n${content}\n`
    fs.writeFileSync(target, md, 'utf8')
    fs.appendFileSync(path.join(opsDir, 'ops.jsonl'), JSON.stringify(op) + '\n')
    return sendJson(res, 200, { ok: true, op, file: target, role_key: roleKey })
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `写副本失败: ${e.message}` })
  }
}

// ---------- t18 验收修复B：团队一键复用配方 + 项目详情（docs/88 模块③/④ · 主人反馈①④） ----------
// 复用配方：读固化团队/模板（只读源）→ 结构化配方（阵容/流程/蓝图范本/spawnPlan）返回；
//   实际执行（按阵容 de_session spawn）由 UI/调用侧引导（docs/88 模块⑤ 桥 + 降级复制，v0.2 无公开 spawn HTTP）。
// 项目详情：施工记录文件树（data/projects/<p>/ ∪ orchestrator/teams/<p>/ 实际文件）+ 交付物路径清单
//   （AIMS outputs by cwd/project + 项目目录「交付物/」轨，只读）；AIMS 不可达 → 优雅降级（aims:null）。

/** 表格行单元（'| a | b |' → ['a','b']）。 */
const tblCells = (line) => String(line).trim().slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean)
const isTblSep = (line) => {
  const c = tblCells(line)
  return c.length >= 1 && c.every((x) => /^:?-{1,}:?$/.test(x))
}

/**
 * 取「表头首格匹配 pred」的 markdown 表数据行（跳过表头/分隔行；遇非表格行结束）。
 * 按表格结构锚定（而非全文 indexOf）——防「阶段」等词出现在正文导致错抓后续表。
 * @param {string} text md 全文
 * @param {(headerCells: string[]) => boolean} pred 表头行判定（如 c[0]==='角色'）
 */
function mdTableSection(text, pred) {
  const out = []
  let mode = 0 // 0=找表头 1=跳分隔 2=收数据
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) { if (mode === 2) break; mode = 0; continue }
    if (mode === 2) { out.push(tblCells(line)); continue }
    if (mode === 1) { if (isTblSep(line)) mode = 2; else mode = 0; continue }
    if (isTblSep(line)) continue
    const c = tblCells(line)
    if (typeof pred === 'function' ? pred(c) : String(c[0] ?? '').includes(String(pred))) mode = 1
  }
  return out
}

/** team-templates yaml 极简解析（实测 corpus：name/description/llm/concurrency/inputs/steps[id,role,task,output,depends_on]）。 */
function parseTeamTemplateYaml(text) {
  const out = { name: '', description: '', llm: { provider: '', model: '' }, concurrency: null, inputs: [], steps: [], roles: [] }
  let step = null
  let inInputs = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const s = raw.trim()
    if (/^inputs:/.test(s)) { inInputs = true; continue }
    if (/^steps:/.test(s)) { inInputs = false; continue }
    let m
    if ((m = /^name:\s*"?([^"\n]+)"?$/.exec(s))) out.name = m[1].trim()
    else if ((m = /^description:\s*"?([^"\n]+)"?$/.exec(s))) out.description = m[1].trim()
    else if ((m = /^concurrency:\s*(\d+)/.exec(s))) out.concurrency = Number(m[1])
    else if ((m = /^provider:\s*"?([^"\n]+)"?$/.exec(s))) out.llm.provider = m[1].trim()
    else if ((m = /^model:\s*"?([^"\n]+)"?$/.exec(s))) out.llm.model = m[1].trim()
    else if (inInputs && (m = /^-\s*name:\s*"?([^"\n]+)"?$/.exec(s))) out.inputs.push(m[1].trim())
    else if ((m = /^-\s*id:\s*(\S+)/.exec(s))) { step = { id: m[1], role: '', task: '', output: '', dependsOn: [] }; out.steps.push(step) }
    else if (step && (m = /^role:\s*"?([^"\n]+)"?$/.exec(s))) step.role = m[1].trim()
    else if (step && (m = /^output:\s*"?([^"\n]+)"?$/.exec(s))) step.output = m[1].trim()
    else if (step && (m = /^depends_on:\s*\[([^\]]*)\]/.exec(s))) step.dependsOn = m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    else if (step && (m = /^task:\s*(\S.*)$/.exec(s))) step.task = String(m[1]).slice(0, 160)
  }
  out.roles = [...new Set(out.steps.map((st) => st.role).filter(Boolean))]
  return out
}

/** 固化团队目录 → 主文档（README.md 优先 → <dir>.md → 首个 md）。 */
function solidTeamDocPath(dir) {
  try {
    if (!fs.existsSync(dir)) return null
    const name = path.basename(dir)
    for (const f of ['README.md', `${name}.md`]) {
      const p = path.join(dir, f)
      if (fs.existsSync(p)) return p
    }
    const md = fs.readdirSync(dir).find((f) => f.endsWith('.md'))
    return md ? path.join(dir, md) : null
  } catch { return null }
}

/** 模板 yaml 查找（name 支持 'xxx' / 'group/xxx'）：遍历 team-templates 递归；未命中 null。 */
function findTemplateYaml(templatesRoot, nameRaw) {
  const name = String(nameRaw ?? '').replace(/\.yaml$/i, '').trim()
  if (!name || !templatesRoot || !fs.existsSync(templatesRoot)) return null
  let hit = null
  const walk = (dir, rel) => {
    if (hit) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), e.name); continue }
      if (!e.isFile() || !e.name.endsWith('.yaml')) continue
      const stem = e.name.replace(/\.yaml$/, '')
      if (stem === name || `${rel}/${stem}` === name || e.name === nameRaw) { hit = path.join(dir, e.name); return }
    }
  }
  walk(templatesRoot, '')
  return hit
}

/** document-templates 蓝图范本（L1_项目蓝图.md）预览（≤800 字）。 */
function blueprintTemplate(cfg) {
  const dt = orchSubDir(cfg, 'document-templates')
  if (!dt) return { available: false, file: null, preview: '' }
  const f = path.join(dt, 'L1_项目蓝图.md')
  if (!fs.existsSync(f)) return { available: false, file: null, preview: '' }
  try {
    const text = fs.readFileSync(f, 'utf8')
    return { available: true, file: f, preview: text.slice(0, 800) }
  } catch { return { available: false, file: null, preview: '' } }
}

/** ops 留痕（写副本 agents/.ops —— 副本可写区，非源；失败静默）。 */
function appendReuseOp(cfg, op) {
  try {
    const dir = path.join(cfg.agentsDir, '.ops')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'ops.jsonl'), JSON.stringify({ ...op, ts: new Date().toISOString() }) + '\n', 'utf8')
  } catch { /* 留痕失败不阻断复用响应 */ }
}

/** body 可选读取（路径式复用无 body → 短窗后回 '{}'；防无 data/end 挂起——body 对复用端点本就可缺省）。 */
function readBodyMaybe(req, waitMs = 60) {
  return new Promise((resolve) => {
    let done = false
    const fin = (v) => { if (!done) { done = true; resolve(v) } }
    readBody(req).then(fin).catch(() => fin('{}'))
    setTimeout(() => fin('{}'), waitMs).unref?.()
  })
}

/** POST /agents/teams/reuse（body {type,name}）· POST /agents/teams/:name/reuse（?type=，默认 solid） */
async function reuseTeam(cfg, req, res, nameHint) {
  let body = {}
  if (req.method === 'POST') {
    try { body = JSON.parse((await readBodyMaybe(req)) || '{}') } catch { body = {} }
  }
  const type = String(body.type ?? 'solid')
  const name = String(body.name ?? nameHint ?? '').trim()
  if (!name) return sendJson(res, 400, { ok: false, error: '缺少团队/模板名（name 或路径 /teams/:name/reuse）' })
  if (!['template', 'solid', 'running'].includes(type)) {
    return sendJson(res, 400, { ok: false, error: 'type 必须是 template（模板库）/ solid（固化团队）/ running（运行中）' })
  }
  const base = { action: 'reuse', source: { type, name }, ok: true }

  if (type === 'template') {
    const tplRoot = orchSubDir(cfg, 'team-templates')
    const file = findTemplateYaml(tplRoot, name)
    if (!file) return sendJson(res, 404, { ok: false, error: `模板库无 ${name}.yaml（team-templates 根级或部门组）` })
    let parsed
    try { parsed = parseTeamTemplateYaml(fs.readFileSync(file, 'utf8')) } catch { parsed = null }
    if (!parsed) return sendJson(res, 500, { ok: false, error: `模板解析失败: ${file}` })
    const bp = blueprintTemplate(cfg)
    appendReuseOp(cfg, { op: 'team-reuse', type, name, session_id: body.session_id ?? null })
    return sendJson(res, 200, {
      ...base,
      recipe: {
        kind: 'template',
        name: parsed.name || name,
        description: parsed.description,
        llm: parsed.llm,
        concurrency: parsed.concurrency,
        inputs: parsed.inputs,
        steps: parsed.steps.map((st) => ({ id: st.id, role: st.role, output: st.output, depends_on: st.dependsOn })),
        roster: parsed.roles.map((role) => {
          const first = parsed.steps.find((st) => st.role === role)
          return { role, duty: first?.task?.slice(0, 120) ?? '', source: normalizeRoleKey(role.split('/').pop() ?? role) || null }
        }),
        file,
      },
      blueprint: bp,
      spawnPlan: {
        engine: 'memory-evolve-session-orch (de_session)',
        note: '前端/模型按 roster 逐角色 de_session spawn（prompt=角色任命 + task）；桥未就绪时降级复制 prompt（docs/88 模块⑤）',
        roles: parsed.roles.map((role) => {
          const first = parsed.steps.find((st) => st.role === role)
          return { role, promptHead: `你是${role}…任务：${first?.task ?? ''}` }
        }),
      },
    })
  }

  if (type === 'solid') {
    const teamsRoot = orchSubDir(cfg, 'teams')
    const dir = teamsRoot ? path.join(teamsRoot, name) : null
    const doc = dir ? solidTeamDocPath(dir) : null
    if (!dir || !fs.existsSync(dir) || !doc) {
      return sendJson(res, 404, { ok: false, error: `固化团队无 ${name}（orchestrator/teams/<name>/）` })
    }
    const text = fs.readFileSync(doc, 'utf8')
    const roster = mdTableSection(text, (c) => String(c[0] ?? '') === '角色').map((cells) => {
      const role = cells[0] ?? ''
      return { role, duty: cells[1] ?? '', source: cells[2] ? (normalizeRoleKey(cells[2]) || cells[2]) : null }
    }).filter((r) => r.role)
    const stages = mdTableSection(text, (c) => String(c[0] ?? '').includes('阶段')).map((cells) => ({ id: cells[0] ?? '', content: cells[1] ?? '', gate: cells[2] ?? null })).filter((s) => s.id)
    const tmpl = /典型模板[:：]?\s*`?([^\n`]+)`.?/.exec(text)
    const bp = blueprintTemplate(cfg)
    appendReuseOp(cfg, { op: 'team-reuse', type, name, session_id: body.session_id ?? null })
    return sendJson(res, 200, {
      ...base,
      recipe: {
        kind: 'solid',
        name,
        file: doc,
        summary: text.slice(0, 600),
        roster,
        stages,
        suggestedTemplate: tmpl ? tmpl[1].trim() : null,
        projectDocs: fs.readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, 30),
      },
      blueprint: bp,
      spawnPlan: {
        engine: 'memory-evolve-session-orch (de_session)',
        note: '一键复用 = 按阵容批量 de_session spawn（prompt 含 README 职能说明）或复制阵容/模板参数（docs/88 模块③ 流 3）',
        roles: roster.map((r) => ({ role: r.role, promptHead: `你是${r.role}（职责：${r.duty}）…` })),
      },
    })
  }

  // running：.agent-teams/<name>/team.json
  const file = path.join(cfg.agentsTeamsRoot, name, 'team.json')
  const tj = readJsonIfExists(file)
  if (!tj) return sendJson(res, 404, { ok: false, error: `运行中团队无 ${name}（.agent-teams/<name>/team.json）` })
  const members = (tj.members ?? []).map((m) => ({ name: m.name ?? m.id, role: m.role ?? null }))
  appendReuseOp(cfg, { op: 'team-reuse', type, name, session_id: body.session_id ?? null })
  return sendJson(res, 200, {
    ...base,
    recipe: {
      kind: 'running',
      name: tj.name ?? name,
      id: tj.id ?? name,
      description: tj.description ?? '',
      captainSessionId: tj.captainSessionId ?? null,
      roster: members,
      taskCount: Array.isArray(tj.tasks) ? tj.tasks.length : null,
      file,
    },
    blueprint: { available: false, file: null, preview: '' },
    spawnPlan: {
      engine: 'memory-evolve-session-orch (de_session)',
      note: '运行中团队配方 = 按 roster 复制会话/任务；归档复用建议转固化团队（solid）',
      roles: members.map((m) => ({ role: m.role ?? m.name, promptHead: `你是${m.name}…` })),
    },
  })
}

/** 文件分类（施工文件树 kind 启发式——对齐 docs/88 模块④ document-templates 三级体系；rel 含目录名）。 */
function projectKindOf(rel) {
  const n = String(rel)
  if (n.includes('handoff')) return 'handoff'
  if (/施工|^L2/.test(n)) return 'build'
  if (n.includes('任命书')) return 'appointment'
  if (/任务卡/.test(n)) return 'taskcard'
  if (/验收/.test(n)) return 'acceptance'
  if (/^L1|蓝图/.test(n)) return 'blueprint'
  if (/^L3|纪要/.test(n)) return 'minutes'
  if (/^stage/i.test(n)) return 'stage'
  if (/^gate/i.test(n)) return 'gate'
  return 'doc'
}

/** 项目目录候选（data/projects/<p> ∪ orchestrator/teams/<p>）。 */
function projectDirsOf(cfg, name) {
  const out = []
  const dataDir = path.join(cfg.agentsHrDir, 'data', 'projects', name)
  if (fs.existsSync(dataDir)) out.push({ source: 'data/projects', dir: dataDir })
  const teamsRoot = orchSubDir(cfg, 'teams')
  const teamDir = teamsRoot ? path.join(teamsRoot, name) : null
  if (teamDir && fs.existsSync(teamDir)) out.push({ source: 'orchestrator/teams', dir: teamDir })
  // 第 4 源（E8）：工作目录扫描命中的同名目录 —— 与 /flow 共用同一 provider ⇒ 同一份缓存，
  // 因此**多查一个源不增加扫描次数**；扫描不可用时不阻断详情（降级为三源）。
  try {
    const hit = flowProvider(cfg).workdirRow?.(name)
    if (hit && fs.existsSync(hit.dir) && !out.some((d) => d.dir === hit.dir)) out.push({ source: 'workdir-scan', dir: hit.dir })
  } catch { /* noop */ }
  return out
}

/** 递归文件树（rel 正斜杠；防巨目录：cap 300）。 */
function scanProjectTree(dir) {
  const files = []
  const walk = (rel) => {
    if (files.length >= 300) return
    let entries = []
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const relE = rel ? `${rel}/${e.name}` : e.name
      const full = path.join(dir, relE.replace(/\//g, path.sep))
      if (e.isDirectory()) walk(relE)
      else if (e.isFile()) {
        try { files.push({ rel: relE, size: fs.statSync(full).size, kind: projectKindOf(relE) }) } catch { /* 忽略 */ }
      }
    }
  }
  walk('')
  return files.sort((a, b) => String(a.rel).localeCompare(String(b.rel)))
}

/** 本地「交付物/」轨扫描（cwd 存在时，一级子目录匹配 交付物|deliverables|artifacts）。 */
function scanLocalDeliverables(cwd) {
  const rows = []
  if (!cwd || !fs.existsSync(cwd)) return rows
  let entries = []
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }) } catch { return rows }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!/^(交付物|deliverables|artifacts|outputs)$/i.test(e.name)) continue
    const dd = path.join(cwd, e.name)
    let fs2 = []
    try { fs2 = fs.readdirSync(dd, { withFileTypes: true }) } catch { continue }
    for (const f of fs2) {
      if (!f.isFile()) continue
      const full = path.join(dd, f.name)
      try { rows.push({ path: full, size: fs.statSync(full).size, source: 'local-deliverables', status: null }) } catch { /* 忽略 */ }
    }
  }
  return rows
}

const extType = (p) => {
  const e = path.extname(String(p)).replace('.', '').toLowerCase()
  return e || 'file'
}

/**
 * GET /agents/projects/:name → 施工文件树 + access 调用行 + 交付物 + 聚合 + 团队工作区。
 * 源集合（t25 修正：与 /flow 项目对象同源——docs/99 t20 教训：聚合范围与详情判定必须一致）：
 *   ① 本地施工目录（data/projects/<p> ∪ orchestrator/teams/<p>）
 *   ② access.jsonl 该项目调用行
 *   ③ 团队工作区 `.agent-teams/<p>/team.json`（复用 lib/agents/flow.js readTeamWorkspace 共享 helper）
 * 三源皆无 → 404；仅 access → degradation.code='access-only'；有团队工作区但无本地目录 →
 * degradation.code='team-workspace'（note 为事实描述，不再误报「仅 access 调用留痕」）。
 * AIMS 不可达 → 优雅降级 aims:null。
 */
async function projectDetail(cfg, url, res, nameRaw) {
  const name = String(nameRaw ?? '').trim()
  if (!name) return sendJson(res, 400, { ok: false, error: '缺少项目名' })
  const dirs = projectDirsOf(cfg, name)
  const acc = parseAccess(cfg.agentsAccessPath).filter((r) => r.project === name)
  const teamWs = readTeamWorkspace(cfg.agentsTeamsRoot, name) // ③ 团队工作区（共享 helper，与 /flow 同源）
  if (!dirs.length && !acc.length && !teamWs) {
    return sendJson(res, 404, { ok: false, error: `无项目留痕: ${name}（本地施工目录 · access 调用行 · 团队工作区 三源均无：data/projects · orchestrator/teams · access.jsonl · .agent-teams）` })
  }
  const tree = dirs.flatMap((d) => scanProjectTree(d.dir).map((f) => ({ ...f, source: d.source, dir: d.dir })))
  const localAvailable = dirs.length > 0

  // 团队工作区段：有团队时取 /flow 同源项目对象（activeCode/stageNote/taskStats/events/inference 与流程视图完全一致）
  let team = null
  if (teamWs) {
    const pv = (() => { try { return flowProvider(cfg).projects().find((p) => p.project === name) ?? null } catch { return null } })()
    const stats = pv?.taskStats ?? teamWs.taskStats
    const events = pv?.events ?? teamWs.events
    team = {
      teamPath: teamWs.teamPath,
      dir: teamWs.dir,
      name: teamWs.team.name ?? name,
      description: teamWs.team.description ?? '',
      captainSessionId: teamWs.team.captainSessionId ?? null,
      createdAt: (() => { const v = teamWs.team.createdAt; if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString() })(),
      members: pv?.members ?? teamWs.memberList,
      memberCount: (pv?.members ?? teamWs.memberList).length,
      taskStats: stats,
      activeCode: pv?.activeCode ?? null,
      stageNote: pv?.stageNote ?? null,
      status: pv?.status ?? null,
      completed_stages: pv?.completed_stages ?? null,
      inference: pv?.inference ?? null,
      eventCount: events.length,
      events: events.slice(0, 20),
      sources: pv?.sources ?? { team: teamWs.teamPath },
    }
  }

  // 降级标记（仅本地目录缺失时出现；有团队工作区则用区分性 code + 事实描述）
  const stats = team?.taskStats ?? null
  const degradation = localAvailable ? null
    : team
      ? {
        code: 'team-workspace',
        note: `无本地施工目录；有团队工作区（${stats ? `${stats.completed}/${stats.total} 任务` : '任务台账未就绪'}${team.activeCode ? ` · Stage ${team.activeCode}` : ''}）`,
        hint: '施工文件树/交付物为空属预期；进度以 team 段（团队工作区）与 /agents/flow 为准',
      }
      : {
        code: 'access-only',
        note: '该项目无本地施工目录（data/projects · orchestrator/teams 均无），仅 access 调用留痕；施工文件树/交付物为空属预期',
        hint: '如需施工记录：走 orchestrator 流程归档项目目录，或经 ?aims=1 查看 AIMS 会话聚合',
      }

  // C 聚合：access project 行
  const roleFreq = new Map()
  for (const r of acc) { if (r.role_key) roleFreq.set(r.role_key, (roleFreq.get(r.role_key) ?? 0) + 1) }

  // B 交付物 + C AIMS 会话（?aims=1 才转发——默认轻量；?aims=1 才有 aims/session/deliverable 聚合）
  const deliverables = []
  let aims = null
  if (url.searchParams.get('aims') === '1') {
    const hit = await aimsGet(cfg.agentsAimsUrl, `/api/sessions?project=${encodeURIComponent(name)}&limit=50`)
    if (hit.ok && hit.body?.rows) {
      const rows = hit.body.rows ?? []
      aims = { sessionTotal: hit.body.total ?? rows.length, sessions: rows.map((r) => ({ session_id: r.session_id, title: r.title, role_key: r.role_key, cwd: r.cwd ?? null, status: r.status ?? null, n_out: r.n_out ?? 0, started_at: r.started_at ?? null })) }
      const withOut = rows.filter((r) => (r.n_out ?? 0) > 0).slice(0, 12)
      const cwds = new Set()
      for (const s of rows) { if (s.cwd && fs.existsSync(s.cwd)) cwds.add(s.cwd) }
      for (const cwd of [...cwds].slice(0, 3)) deliverables.push(...scanLocalDeliverables(cwd))
      for (const s of withOut) {
        const d = await aimsGet(cfg.agentsAimsUrl, `/api/session/${encodeURIComponent(s.session_id)}`)
        if (d.ok && Array.isArray(d.body?.outputs)) {
          for (const o of d.body.outputs) {
            deliverables.push({ path: o.path ?? o.title ?? '', title: o.title ?? null, type: o.type ?? extType(o.path), status: o.status ?? 'current', source: 'aims-outputs', session_id: s.session_id })
          }
        }
      }
    } else if (!hit.ok) {
      aims = null // AIMS 不可达：交付物聚合仅剩本地轨（不报错，C1/C2 主视图不受阻）
    }
  }

  const seenPath = new Set()
  const dlRows = deliverables.filter((r) => r.path && !seenPath.has(r.path) && (seenPath.add(r.path), true))
  return sendJson(res, 200, {
    ok: true,
    project: { name, dirs: dirs.map((d) => ({ source: d.source, dir: d.dir })) },
    tree: {
      available: localAvailable,
      total: tree.length,
      files: tree,
      ...(localAvailable ? {} : { note: team ? '该项目无本地施工目录；进度以团队工作区为准（见 team 段）' : '该项目无本地施工目录，仅 access 调用留痕' }),
    },
    // 团队工作区段（t25：字段名与 /flow 项目对象一致——teamPath/taskStats/activeCode/stageNote/事件）
    team,
    // access 调用行（access-only 项目的主视图数据源；本地项目也返回便于 C 附栏）
    access: {
      total: acc.length,
      rows: acc.slice(0, 100).map((r) => ({ role: r.role, role_key: r.role_key, ts: r.ts, session_id: r.session_id ?? null, project: r.project ?? null })),
    },
    degradation,
    // E9：登记状态（同 A3 §5.3.3 的 PvRegistration；**只加字段，不改既有字段**）
    registration: (() => { try { const g = flowProvider(cfg).registrationOf?.(name, dirs.map((d) => d.dir)); return g ? { status: g.status, ...(g.registration ?? {}) } : null } catch { return null } })(),
    deliverables: { total: dlRows.length, rows: dlRows.slice(0, 100).map((r) => ({ path: r.path, type: r.type ?? extType(r.path), title: r.title ?? null, status: r.status ?? null, size: r.size ?? null, source: r.source, session_id: r.session_id ?? null })) },
    aggregates: { accessRoles: [...roleFreq.entries()].map(([role_key, count]) => ({ role_key, count })).sort((a, b) => b.count - a.count), accessTotal: acc.length, aims },
  })
}

/** GET /agents/projects/:name/file?rel=<相对路径> → md 内容（预览/结构化渲染数据源）。 */
function projectFile(cfg, url, res, nameRaw) {
  const name = String(nameRaw ?? '').trim()
  const rel = String(url.searchParams.get('rel') ?? '').trim()
  if (!name || !rel) return sendJson(res, 400, { ok: false, error: '缺少项目名或 rel' })
  for (const d of projectDirsOf(cfg, name)) {
    try {
      const full = safeJoin(d.dir, rel.replace(/\//g, path.sep))
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue
      const size = fs.statSync(full).size
      if (size > 512 * 1024) return sendJson(res, 413, { ok: false, error: '文件过大（>512KB），不支持预览' })
      return sendJson(res, 200, { ok: true, project: name, source: d.source, rel, path: full, kind: projectKindOf(path.basename(full)), size, content: fs.readFileSync(full, 'utf8') })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: `非法 rel（路径逃逸）: ${e.message}` })
    }
  }
  return sendJson(res, 404, { ok: false, error: `项目文件不存在: ${name}/${rel}` })
}

// ---------- t22 副本自动同步状态/触发（docs/89 §1.3；管理器在 lib/agents/sync.js，与 installAgents 单例复用） ----------
/** 懒加载 sync 管理器（deps.sync 注入优先——单测用 fake；否则 dynamic import 单例）。 */
async function loadSync(cfg, deps) {
  if (deps?.sync) return deps.sync
  try {
    const m = await import('./sync.js')
    return m.getSyncManager?.(cfg) ?? null
  } catch { return null }
}

/** GET /agents/sync-status → {autoSync, syncedAt, drifted, lastCheck, lastSync, applying…}（按需检，节流；?force=1 强制检）。 */
async function syncStatus(cfg, url, res, deps) {
  const mgr = await loadSync(cfg, deps)
  if (!mgr) return sendJson(res, 503, { ok: false, error: 'lib/agents/sync.js 不可用' })
  const wantAuto = cfg.agentsAutoSync === undefined ? true : cfg.agentsAutoSync === true
  mgr.setAutoSync(wantAuto) // runtime 键变化热对齐（幂等）
  if (url.searchParams.get('check') !== '0') await mgr.check({ force: url.searchParams.get('force') === '1' })
  return sendJson(res, 200, { ok: true, ...mgr.status() })
}

/** POST /agents/sync → 立即同步（强制 apply；只读源写副本，红线由 agents-sync 内自断言）。 */
async function syncNowHandler(cfg, res, deps) {
  const mgr = await loadSync(cfg, deps)
  if (!mgr) return sendJson(res, 503, { ok: false, error: 'lib/agents/sync.js 不可用' })
  const r = await mgr.syncNow()
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error ?? '同步失败', ...r })
  return sendJson(res, 200, { ok: true, ...r, status: mgr.status() })
}

// ---------- 流程视图真实数据（t23 · docs/102）：/agents/flow + /agents/projects/:name/timeline ----------
// 数据源 = 运行中团队 team.json ∪ orchestrator projects.jsonl ∪ data/projects 施工文件 ∪ access 留痕
// ——全部真实时间戳（team.json epoch ms → ISO），无演示/虚构数据（lib/agents/flow.js 纯 provider）。
let flowProviderCache = null
let flowProviderKey = null
function flowProvider(cfg) {
  // E8：扫描配置进 key ⇒ 改配置（root/深度/开关/TTL）即重建 provider（连带清扫描缓存）
  const key = `${cfg.agentsTeamsRoot}|${cfg.agentsHrDir}|${cfg.agentsDir}|${cfg.agentsAccessPath}`
    + `|${JSON.stringify(cfg.projectScanRoots ?? null)}|${cfg.projectScanDepth ?? ''}|${cfg.projectScanEnabled ?? ''}|${cfg.projectScanCacheTtlMs ?? ''}`
      + `|dsh:${cfg.dshSessionsEnabled ?? ''}|${cfg.dshSessionsCacheTtlMs ?? ''}` // A5 第 5 源：配置变 ⇒ provider 重建
  if (flowProviderKey !== key) {
    flowProviderCache = createFlowProvider({
      teamsRoot: cfg.agentsTeamsRoot,
      agentsHrDir: cfg.agentsHrDir,
      agentsDir: cfg.agentsDir,
      accessPath: cfg.agentsAccessPath,
      projectScan: cfg, // 第 4 源（E8）：projectScan* 直接取自插件 config
      dsh: cfg, // 第 5 源（A5）：dshSessions* 直接取自插件 config
      registryFile: cfg.projectRegistryPath ?? undefined, // E9：登记表落点（null ⇒ 默认 <agentsHrDir>/data/registry.jsonl）
    })
    flowProviderKey = key
  }
  return flowProviderCache
}

/** GET /agents/flow?project=<name>&events=<n> → 真实项目列表（PvProject 契约）+ 可选单项目时间线。 */
async function flowFeed(cfg, url, res) {
  const p = flowProvider(cfg)
  const projects = p.projects()
  const only = url.searchParams.get('project')?.trim() || ''
  const eventsCap = Math.min(Math.max(Number(url.searchParams.get('events')) || 0, 0), 200)
  const selected = only ? projects.filter((x) => x.project === only) : projects
  if (only && eventsCap) {
    for (const proj of selected) proj.events = proj.events.slice(0, eventsCap)
  }
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    total: selected.length, // ?project= 过滤后计数（全量时为项目总数）
    projects: selected,
    sources: p.sources(),
  }
  return sendJson(res, 200, payload)
}

/** GET /agents/projects/:name/timeline → 单项目真实事件流 + 阶段推断依据（前端可直接消费）。
 * `total` = 截断前的真实事件总数（前端可显示「共 N 条 · 展示最近 M 条」）；`events` 受 ?events= 限制。 */
async function projectTimeline(cfg, url, res, nameRaw) {
  const name = String(nameRaw ?? '').trim()
  if (!name) return sendJson(res, 400, { ok: false, error: '缺少项目名' })
  const r = flowProvider(cfg).timelineOf(name)
  if (!r) return sendJson(res, 404, { ok: false, error: `无该项目：${name}（团队/台账/施工目录/access 四源均无）` })
  const cap = Math.min(Math.max(Number(url.searchParams.get('events')) || 80, 1), 200)
  return sendJson(res, 200, { ...r, total: r.events.length, events: r.events.slice(0, cap), generatedAt: new Date().toISOString() })
}

// ---------- U2B 看板台账读面（GET /ledger · 只读「已提交内容」· 不读工作副本）----------
/** 懒加载 ledger 读面（deps.ledger 注入优先——装置/单测用 fake；否则 dynamic import ⇒ 未落盘时优雅降级）。 */
async function loadLedger(deps) {
  if (deps && deps.ledger) return deps.ledger
  try {
    const m = await import('./ledger.js')
    return typeof m.readLedger === 'function' ? m : null
  } catch (e) { return null }
}

/** GET /agents/ledger → {ok,generatedAt,rev,committedAt,cards[],verdicts[],records[],sources{}}。
 *  **只读**：全部走 git 只读命令（log/ls-tree/cat-file，异步 + --no-optional-locks）⇒ 不写任何文件、
 *  不新建存储、不读 ops/BOARD.md（秘书单写者面）。字段口径逐字沿用 board-gen 的 CARD_FIELDS/VERIFY_FIELDS。
 *  ?force=1 = 绕过缓存做一次真读（两态取证用：证明读数来自 HEAD 而非工作副本）。 */
async function ledgerFeed(cfg, url, res, deps) {
  const mod = await loadLedger(deps)
  if (!mod) return sendJson(res, 503, { ok: false, error: 'lib/agents/ledger.js 不可用（未落盘）——端点族其余读面不受影响' })
  const out = await mod.readLedger({ force: url.searchParams.get('force') === '1' })
  if (!out.ok) return sendJson(res, 502, { ok: false, error: out.error })
  return sendJson(res, 200, out)
}

/**
 * POST /agents/register —— E111 · M6 **写入口**（登记 → 读侧采纳）。
 * 三态**如实回传**：written ⇒ 200 · rejected ⇒ 409 · unjudgeable ⇒ 503（**不静默跳过**；拒绝带可照抄修法）。
 * ⚠ **层位**：本函数是 lib/** 的改动 ⇒ **需重启宿主才生效**；未重启前该端点不存在（源码级 ≠ 端点级）。
 */
async function registerFeed(deps, cfg, req, res) {
  let bodyText
  try { bodyText = await readBody(req) } catch (e) { return sendJson(res, 413, { ok: false, state: 'rejected', code: 'E_BODY_TOO_LARGE', error: e.message }) }
  let body
  try { body = JSON.parse(bodyText || '{}') } catch (e) { return sendJson(res, 400, { ok: false, state: 'rejected', code: 'E_BAD_JSON', error: 'body 不是合法 JSON：' + e.message }) }
  const mod = await import('./claude-source.js')
  const out = mod.registerClaudeProject(
    {
      projectId: body.projectId ?? body.project_id ?? body.name,
      roots: body.roots ?? body.root ?? body.root_dirs,
      agent: body.agent, sessionId: body.sessionId ?? body.session_id, by: body.by, action: body.action,
      gateEnabled: body.gateEnabled, gateEnforce: body.gateEnforce,
    },
    { hrDir: cfg.agentsHrDir },
  )
  const status = out.state === mod.INGEST_STATES.WRITTEN ? 200 : (out.state === mod.INGEST_STATES.UNJUDGEABLE ? 503 : 409)
  return sendJson(res, status, out)
}

// ---------- 请求分派 ----------
async function dispatch(deps, cfg, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname
  const rest = p.startsWith(AGENTS_API_BASE) ? p.slice(AGENTS_API_BASE.length) : p
  const segs = rest.split('/').filter(Boolean)
  const [head, second] = segs
  try {
    if (req.method === 'GET' && head === 'catalog' && second === undefined) return listCatalog(deps, cfg, url, res)
    if (req.method === 'GET' && head === 'catalog' && second) return roleDetail(deps, cfg, url, res, decodeURIComponent(second))
    if (req.method === 'GET' && head === 'access') return accessFeed(cfg, url, res)
    if (req.method === 'GET' && head === 'teams') return teamsFeed(cfg, url, res)
    if (req.method === 'POST' && head === 'teams' && second === 'reuse') return reuseTeam(cfg, req, res, null)
    if (req.method === 'POST' && head === 'teams' && segs[2] === 'reuse') return reuseTeam(cfg, req, res, decodeURIComponent(second))
    if (req.method === 'GET' && head === 'projects' && second === undefined) return projectsFeed(cfg, url, res)
    if (req.method === 'GET' && head === 'projects' && second && segs[2] === undefined) return projectDetail(cfg, url, res, decodeURIComponent(second))
    if (req.method === 'GET' && head === 'projects' && second && segs[2] === 'file') return projectFile(cfg, url, res, decodeURIComponent(second))
    if (req.method === 'GET' && head === 'flow') return flowFeed(cfg, url, res)
    if (req.method === 'GET' && head === 'ledger') return ledgerFeed(cfg, url, res, deps) // U2B
    if (req.method === 'POST' && head === 'register') return registerFeed(deps, cfg, req, res) // E111 · M6 写入口（登记 → 读侧采纳）
    if (req.method === 'GET' && head === 'projects' && second && segs[2] === 'timeline') return projectTimeline(cfg, url, res, decodeURIComponent(second))
    if (req.method === 'GET' && head === 'orchestrator') return orchestratorMeta(cfg, url, res)
    if (req.method === 'GET' && head === 'aims-role') return aimsRole(deps, cfg, url, res)
    if (req.method === 'GET' && head === 'aims-roles') return aimsRolesList(deps, cfg, url, res)
    if (req.method === 'GET' && head === 'sync-status') return syncStatus(cfg, url, res, deps)
    if (req.method === 'POST' && head === 'sync') return syncNowHandler(cfg, res, deps)
    if (req.method === 'POST' && head === 'catalog') return postCatalog(deps, cfg, req, res)
    return sendJson(res, 404, { ok: false, error: `unknown agents api path: ${AGENTS_API_BASE}${rest}` })
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `agents api error: ${e.message}` })
  }
}

/**
 * 纯请求处理器（无 ctx 依赖）——单测/直测入口；installAgentsRoutes 内部使用。
 * @param {{getRuntime?:()=>object, config?:object, registry?:object, trace?:object}} deps
 * @returns {(req:object, res:object) => Promise<void>}
 */
export function createAgentsHandler(deps = {}) {
  const cfg = cfgOf(deps)
  return (req, res) => dispatch(deps, cfg, req, res)
}

/**
 * 挂载 /memory-evolve/api/agents/*（web-only；对齐 lib/aims/routes.js 的
 * webServer.register prefix 模式）。engineer 1A 的 lib/agents/index.js
 * installAgents 组装时调用本函数即可（或在测试中直接使用 createAgentsHandler）。
 * @param {object} ctx - cordis ctx（webServer 经 ctx.inject(['webServer']) 解析）
 * @param {{getRuntime?:()=>object, config?:object, registry?:object, trace?:object}} [opts]
 * @returns {() => void} disposer
 */
export function installAgentsRoutes(ctx, opts = {}) {
  let cancel = () => {}
  ctx.inject(['webServer'], (webCtx) => {
    cancel = webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: AGENTS_API_BASE,
      handler: createAgentsHandler(opts),
    }), 'dsh-memory-evolve: huahua-os agents api routes')
  })
  return () => { cancel() }
}
