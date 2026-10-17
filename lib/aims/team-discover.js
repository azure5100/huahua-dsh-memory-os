// AIMS 团队沉淀 · 成员发现（t72 · docs/70 §一）
// 职责：遍历 <teamsRoot>/<team>/team.json（排除 archive）→ 成员会话身份字典
//       {teamId, captainSessionId, memberIds, nameById} + mtime 缓存（stat 低频重扫）
//       isTeamMemberSession(sessionId) → 匹配数组（多团队返回多个）。
// teamsRoot 缺省 = `defaultTeamsRoot()`（**唯一 home**：lib/agents/platform-paths.js；平台中立 + 保留 config 覆盖）。
import fs from 'node:fs'
import path from 'node:path'
import { defaultTeamsRoot } from '../agents/platform-paths.js'   // E131：teams 根默认值**唯一 home**（原此处写死盘符）

// E131：**删掉写死盘符的模块常量** —— 默认值改由 platform-paths.js 的 defaultTeamsRoot() 提供
//   （原值 'D:\\Deepseek-harness\\.agent-teams' 是「三处各写一份」中的一份，现与 flow.js / routes.js 同源）

/** 成员短名（V5 roleCn 逻辑：shepherd-牧羊人 → shepherd；只取首个英文词，不含尾部 -） */
export function shortNameOf(name) {
  const m = /^([a-z0-9]+)/i.exec(String(name || '').trim())
  return m ? m[1] : String(name || 'team')
}

/**
 * 团队成员短名 → 丽丽协作角色面（docs/74 §一 口径修订：agent_id 恒 lili、角色是维度）。
 * 映射与 docs/74 §一 表格一致；未映射成员（新团队/未知角色）→ general 兜底（matched:false，
 * 由调用方记 warn——不猜新角色，docs/74 §六）。
 */
export const TEAM_ROLE_MAP = {
  shepherd: { role_key: 'project-shepherd', display: '项目牧羊人' },
  identity: { role_key: 'identity-graph', display: '身份图谱' },
  architect: { role_key: 'backend-architect', display: '后端架构' },
  engineer: { role_key: 'data-engineer', display: '数据工程' },
  optimizer: { role_key: 'db-optimizer', display: '数据库优化' },
  qa: { role_key: 'qa', display: '验证测试' },
  ui: { role_key: 'frontend-dev', display: '前端开发' },
}

/** 成员名 → 协作角色（含 display/matched）；captain 由调用方排除（保留 general，docs/74 §一） */
export function roleForMember(name) {
  const short = shortNameOf(name)
  const hit = TEAM_ROLE_MAP[short]
  return hit ? { role_key: hit.role_key, display: hit.display, matched: true } : { role_key: 'general', display: '通用经历', matched: false }
}

/**
 * 团队发现实例。
 * @param {{ teamsRoot?: string, onReload?: (teams) => void }} opts
 */
export function createTeamDiscover(opts = {}) {
  const teamsRoot = opts.teamsRoot || defaultTeamsRoot()
  let teams = [] // [{teamId, name, mtimeMs, captainSessionId, memberIds:Set, nameById:Map, shortById:Map}]
  let lastStatMs = 0

  function loadOne(dir) {
    const tf = path.join(dir, 'team.json')
    if (!fs.existsSync(tf)) return null
    const st = fs.statSync(tf)
    let raw
    try { raw = JSON.parse(fs.readFileSync(tf, 'utf8')) } catch { return null }
    const memberIds = new Set()
    const nameById = new Map()
    const shortById = new Map()
    for (const m of Array.isArray(raw.members) ? raw.members : []) {
      if (m?.id) {
        memberIds.add(m.id)
        nameById.set(m.id, m.name ?? m.id)
        shortById.set(m.id, shortNameOf(m.name ?? m.id))
      }
    }
    const captainId = raw.captainSessionId ?? null
    if (captainId) memberIds.add(captainId)
    return {
      teamId: raw.id ?? path.basename(dir),
      name: raw.name ?? path.basename(dir),
      dir,
      mtimeMs: st.mtimeMs,
      captainSessionId: captainId,
      memberIds,
      nameById,
      shortById,
    }
  }

  function rescan() {
    const next = []
    try {
      if (!fs.existsSync(teamsRoot)) { teams = next; return teams }
      for (const entry of fs.readdirSync(teamsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'archive') continue // 归档团队不再沉淀（docs/70 §1.1）
        const t = loadOne(path.join(teamsRoot, entry.name))
        if (t) next.push(t)
      }
    } catch { /* 扫描失败保持旧缓存 */ }
    teams = next
    return teams
  }

  /** 低频 stat 重扫（mtime 变化才 reload；stat 毫秒级） */
  function refreshIfStale(force = false) {
    const now = Date.now()
    if (!force && now - lastStatMs < 30000) return teams // 30s 节流
    lastStatMs = now
    try {
      const dirs = fs.readdirSync(teamsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'archive')
      let changed = false
      const live = new Map(teams.map((t) => [t.dir, t.mtimeMs]))
      for (const d of dirs) {
        const tf = path.join(teamsRoot, d.name, 'team.json')
        if (!fs.existsSync(tf)) { changed = true; break }
        const ms = fs.statSync(tf).mtimeMs
        if (!live.has(path.join(teamsRoot, d.name)) || live.get(path.join(teamsRoot, d.name)) !== ms) { changed = true; break }
      }
      if (changed || teams.length !== dirs.length) rescan()
    } catch { /* stat 失败不重扫 */ }
    return teams
  }

  /** 判定：sessionId 属于任一团队（captain 或成员）→ 匹配数组（多团队多元素） */
  function isTeamMemberSession(sessionId) {
    refreshIfStale()
    if (!sessionId) return []
    const out = []
    for (const t of teams) {
      if (!t.memberIds.has(sessionId)) continue
      const isCaptain = sessionId === t.captainSessionId
      out.push({
        teamId: t.teamId,
        teamName: t.name,
        member: true,
        captain: isCaptain,
        name: isCaptain ? 'captain' : (t.nameById.get(sessionId) ?? sessionId),
        shortName: isCaptain ? 'captain' : (t.shortById.get(sessionId) ?? shortNameOf(sessionId)),
      })
    }
    return out
  }

  rescan()
  return {
    teamsRoot,
    teams: () => teams,
    rescan,
    refreshIfStale,
    isTeamMemberSession,
    roleForMember,
    _test: { shortNameOf, TEAM_ROLE_MAP },
  }
}
