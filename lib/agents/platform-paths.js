// lib/agents/platform-paths.js —— E131：**平台中立默认路径的唯一 home**
//
// 病灶（P2「绑死本机」三处 · 队长已核 + 我复核）：
//   ① `lib/agents/project-scan.js:21` `DEFAULT_SCAN.roots = ['D:\']`
//   ② `lib/agents/claude-source.js:23` / `:58` 默认参 `roots = ['D:\']`
//   ③ `lib/aims/team-discover.js:9` `DEFAULT_TEAMS_ROOT = 'D:\Deepseek-harness\.agent-teams'`
//      而 `lib/agents/flow.js:275` 与 `lib/agents/routes.js:47` **各写了一份** `win32 ? 'D:\…' : homedir()`
//      ⇒ **同一概念三份口径**（禁双 home 违规）。
//   ⇒ 本模块 = 这两类默认值的**唯一定义**；调用点只 import，**不再各写一份**。
//
// 平台中立口径（**且不改现机行为** —— 默认值变更的红线见 E131 卡）：
//   · **扫描根**：win32 ⇒ **现存盘符根**（C:\ … Z:\，逐个探测可读）；其他平台 ⇒ `[homedir()]`。
//     ⇒ 本机（D:\ 存在）解出包含 `D:\` ⇒ **与旧默认的现机读数一致**（记录 §4 有前后对照）。
//   · **teams 根**：显式 config ⇒ `~/.agent-teams`（存在）⇒ `$DSH_HARNESS_ROOT/.agent-teams`（存在）
//     ⇒ win32 旧位 `D:\Deepseek-harness\.agent-teams`（**仅当存在**，`kind='legacy-win32'` 明示）
//     ⇒ 全无 ⇒ 返回**第一候选**并带 `candidates`（**不静默空**：调用方须把 kind 打进读数）。
//   · **orchestrator 子目录名**：唯一口径 = `templates` / `teams`（**旧名 `team-templates` 不在链上** ⇒
//     本模块提供 `orchestratorNameDrift()` 让端点**显式报告**「旧名存在但不会被读」——原名漂移的静默无效改明示）。
// 层位：`lib/**` ⇒ **装载期读取 ⇒ 改动需重启宿主才生效**。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const canRead = (p) => { try { fs.accessSync(p, fs.constants.R_OK); return true } catch { return false } }

/** 扫描根默认值（平台中立）：win32 = 现存盘符根；其他平台 = homedir()。deps 可注入（测试）。 */
export function defaultScanRoots(deps = {}) {
  const platform = deps.platform || process.platform
  const exists = deps.exists || canRead
  const home = deps.homedir || os.homedir()
  if (platform === 'win32') {
    const out = []
    for (let c = 67; c <= 90; c++) {           // C: … Z:（A/B 软驱不探）
      const root = String.fromCharCode(c) + ':' + String.fromCharCode(92)
      if (exists(root)) out.push(root)
    }
    return out.length ? out : [path.parse(home).root]
  }
  return [home]
}

/** 给定 roots 里**不存在/不可读**的那些（用于「不许静默空」的缺因明示；全在 ⇒ 空数组）。 */
export function missingRoots(roots, deps = {}) {
  const exists = deps.exists || canRead
  return (Array.isArray(roots) ? roots : [roots]).filter((r) => !exists(r))
}

/** ★ E160：**外部 AIMS 仓根的唯一 home**（平台中立 + **不破现机**）。
 *  候选链：env `AIMS_REPO`（显式）⇒ `<home>/agent-identity-memory-system` ⇒ win32 旧位 `D:\agent-identity-memory-system`（**仅当存在** · kind='legacy-win32' 明示）。
 *  返回 { dir, kind, exists, candidates }：**缺席不静默**（消费方须把 exists/kind 打进读数）。 */
export function aimsRepoResolve(deps = {}) {
  const home = deps.homedir || os.homedir()
  const env = deps.env || process.env
  const exists = deps.exists || canRead
  const cands = []
  if (env.AIMS_REPO) cands.push({ dir: env.AIMS_REPO, kind: 'env' })
  cands.push({ dir: path.join(home, 'agent-identity-memory-system'), kind: 'home' })
  if ((deps.platform || process.platform) === 'win32') cands.push({ dir: 'D:' + String.fromCharCode(92) + 'agent-identity-memory-system', kind: 'legacy-win32' })
  for (const c of cands) if (exists(c.dir)) return { dir: c.dir, kind: c.kind, exists: true, candidates: cands }
  return { dir: cands[0].dir, kind: cands[0].kind, exists: false, candidates: cands }
}

/** 消费侧便捷函数（只给 dir）。 */
export function defaultAimsRepo(deps = {}) { return aimsRepoResolve(deps).dir }

/** ★ 缺席时的**明示文案**（照 AIMS 服务 502 样板：用户看得见原因 + 补法）。存在 ⇒ null。 */
export function aimsRepoReason(res) {
  const r = res || aimsRepoResolve()
  if (r.exists) return null
  return '外部 AIMS 仓不存在：' + r.dir + ' ⇒ 其数据面（logs/aims/provenance）与 CLI 读不到；可设 config.aimsRepo 或 env AIMS_REPO 指向实际位置，或克隆 agent-identity-memory-system'
}

/** ★ E157：**gbrain 源根（\`<home>/.gbrain/agent-roles\`）的唯一 home**。
 *  病灶：同一口径**5 处各写一份**（claude-source:199 · flow:277 · routes:47,48 · sync:18 · trace:13）
 *  ⇒ 「禁双 home」同族违规（E131 治过扫描根/teams 根那一半，这一半未治）。
 *  返回 { dir, kind, exists, candidates }：**缺席不静默** —— 消费方须把 exists/kind 打进读数（同 teams 根口径）。 */
export function agentRolesRootResolve(deps = {}) {
  const home = deps.homedir || os.homedir()
  const exists = deps.exists || canRead
  const cands = [{ dir: path.join(home, '.gbrain', 'agent-roles'), kind: 'home' }]
  for (const c of cands) if (exists(c.dir)) return { dir: c.dir, kind: c.kind, exists: true, candidates: cands }
  return { dir: cands[0].dir, kind: cands[0].kind, exists: false, candidates: cands }
}

/** 消费侧便捷函数（**只给 dir**；要明示存在性请用 agentRolesRootResolve / agentRolesRootReason）。 */
export function defaultAgentRolesRoot(deps = {}) { return agentRolesRootResolve(deps).dir }

/** ★ 缺席时的**明示降级文案**（照 AIMS 服务缺席样板：用户看得见原因）。存在 ⇒ null。 */
export function agentRolesRootReason(res) {
  const r = res || agentRolesRootResolve()
  if (r.exists) return null
  return 'gbrain 源根不存在：' + r.dir + ' ⇒ 人事部档案（registry/access/role 副本）读不到；可设 agentsHrDir 指向实际位置，或安装 gbrain'
}

/** ★ E157（队长 2026-09-28 裁定）：**建档必须分流 + 明示**。
 *  · **显式配置**的路径不存在 ⇒ **不创建**，**明示报错**（替用户猜 = 把「配置错」改写成「已就绪」）。
 *  · **默认 home 路径**不存在 ⇒ 可创建（首次使用建数据目录合理），但**必须明示「已自动创建 <dir>」**。
 *  ⇒ 两条都**不许**表现为「空的人事部面 + 零提示」。返回 { ok, created?, notice?, code?, reason? }。 */
export function ensureAgentRolesDir(target, deps = {}) {
  const dir = String(target || '')
  if (!dir) return { ok: false, code: 'EMPTY_DIR', reason: '源根路径为空' }
  const exists = deps.exists || canRead
  if (exists(dir)) return { ok: true, created: false }
  const def = path.resolve(deps.defaultDir || defaultAgentRolesRoot(deps))
  const isDefault = path.resolve(dir) === def
  if (!isDefault) return { ok: false, code: 'CONFIGURED_DIR_MISSING', reason: '你配置的目录不存在：' + dir + ' ⇒ 不会在**显式配置**的路径上替你创建：请改配置或先建好该目录' }
  fs.mkdirSync(dir, { recursive: true })
  const notice = '已自动创建 ' + dir + '（默认数据目录 · 首次使用）'
  try { console.warn('[memory-evolve] ' + notice) } catch { /* 日志不可用不影响主流程 */ }
  return { ok: true, created: true, notice }
}

/** teams 根解析（**唯一口径**）：返回 { dir, kind, exists, candidates }。 */
export function teamsRootResolve(deps = {}) {
  const platform = deps.platform || process.platform
  const home = deps.homedir || os.homedir()
  const env = deps.env || process.env
  const exists = deps.exists || canRead
  const cands = [{ dir: path.join(home, '.agent-teams'), kind: 'home' }]
  if (env.DSH_HARNESS_ROOT) cands.push({ dir: path.join(env.DSH_HARNESS_ROOT, '.agent-teams'), kind: 'host-env' })
  if (platform === 'win32') cands.push({ dir: 'D:' + String.fromCharCode(92) + 'Deepseek-harness' + String.fromCharCode(92) + '.agent-teams', kind: 'legacy-win32' })
  for (const c of cands) if (exists(c.dir)) return { dir: c.dir, kind: c.kind, exists: true, candidates: cands }
  return { dir: cands[0].dir, kind: cands[0].kind, exists: false, candidates: cands }
}

/** teams 根（字符串简写 · 兼容既有签名）。 */
export function defaultTeamsRoot(deps = {}) { return teamsRootResolve(deps).dir }

/** orchestrator 子目录名的**唯一口径**（代码读这两个名字；旧名见 LEGACY）。 */
export const ORCH_SUBDIR = { templates: 'templates', teams: 'teams' }
/** 旧名（**不在读取链上**）：源根那份曾用 `team-templates` ⇒ 名字漂移 ⇒ 静默无效。 */
export const ORCH_LEGACY_SUBDIR = { templates: 'team-templates' }

/** 名字漂移探测：候选根里存在旧名而**不存在正名** ⇒ 返回读数（供端点**显式**报告「不会被读」）。 */
export function orchestratorNameDrift(roots, deps = {}) {
  const exists = (p) => { try { return (deps.stat || fs.statSync)(p).isDirectory() } catch { return false } }
  const out = []
  for (const root of (Array.isArray(roots) ? roots : [roots])) {
    if (!root) continue
    const canonical = path.join(root, ORCH_SUBDIR.templates)
    const legacy = path.join(root, ORCH_LEGACY_SUBDIR.templates)
    if (exists(legacy) && !exists(canonical)) out.push({ root, legacy, canonical, note: '旧名 ' + ORCH_LEGACY_SUBDIR.templates + ' 存在但**不在读取链上** ⇒ 该份不会被读' })
  }
  return out
}
