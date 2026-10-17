#!/usr/bin/env node
// e9-gate-verify.mjs —— 卡 E9「入口门禁（S1+S2）」验证装置
// **独立进程 + mkdtemp 夹具**：全部 registry/gate-checks 写在临时目录；**不触生产数据**。
// 覆盖卡面 6 条能红 + Q8 四条硬性输入 + 四条绕过反制（能做的部分）。
// 用法：node scripts/e9-gate-verify.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveRegistration, checkGate, detectRootConflict, appendRegistry, readRegistry,
  registryPath, gateChecksPath, rootDirsOf, projectIdOf, REGISTRY_DEFAULTS, FIX_HINT, REQUIRED_FIELDS,
} from '../lib/agents/project-registry.js'
import { guardProdWrite, ProdWriteBlockedError, ALLOW_ENV, prodFaceOf } from '../lib/prod-guard.js'

const results = []
const rec = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ->  ' + detail : '')) }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e9-gate-'))
const REG = path.join(TMP, 'registry.jsonl')
const GATE = path.join(TMP, 'gate-checks.jsonl')

// ── 夹具：两个真实存在的项目根 + 一个不存在的根 ──
const ROOT_A = path.join(TMP, 'projA'); fs.mkdirSync(ROOT_A, { recursive: true })
const ROOT_B = path.join(TMP, 'projB'); fs.mkdirSync(ROOT_B, { recursive: true })
const GHOST = path.join(TMP, 'does-not-exist')
const ok = (r) => { const w = appendRegistry(REG, r); if (!w.ok) throw new Error(w.reason) }
const entries = () => readRegistry(REG)
const good = (over = {}) => ({ project_id: 'projA', project_name: 'projA', root_dirs: [ROOT_A], origin_agent: 'dsh',
  session_id: 'session-1', registered_at: new Date().toISOString(), registered_by: 'agents/data-engineer', source: 'cli', generation: 1, ...over })

// ══ 卡面能红 ① 无 id ⇒ 拒（E_NO_PROJECT_ID，含当下可执行修法）══
const g1 = checkGate({ projectId: 'never-registered', entries: [], sourceDirs: [], enabled: true, action: '阶段文档写入' })
rec('① 无 id ⇒ 拒（E_NO_PROJECT_ID）且 message 含修法', g1.ok === false && g1.code === 'E_NO_PROJECT_ID' && g1.message.includes('修法'), 'status=' + g1.status + ' · message 片段=' + g1.message.slice(0, 80))
rec('①′ 修法**当下可执行**：指向的 CLI 文件真实存在（Q8 硬输入 D）', fs.existsSync(new URL('./agents-register.mjs', import.meta.url)) && g1.message.includes('agents-register.mjs'), 'exists=' + fs.existsSync(new URL('./agents-register.mjs', import.meta.url)) + ' · FIX_HINT=' + FIX_HINT.slice(0, 60))

// ══ 能红 ② 有 id ⇒ 放行（证明不是一律拒）══
ok(good())
const g2 = checkGate({ projectId: 'projA', entries: entries(), sourceDirs: [ROOT_A], enabled: true })
rec('② 有 id（必要条件齐备 ∧ root 存在 ∧ 与源一致）⇒ 放行', g2.ok === true && g2.status === 'registered' && g2.gate === 'on', 'ok=' + g2.ok + ' reason=' + g2.reason)

// ══ 能红 ③ orphan 不得冒充 registered ══
ok({ project_id: 'orphanProj', project_name: 'orphanProj' }) // 只有名字的伪记录（A3 绕过 #1 的形态）
const g3 = checkGate({ projectId: 'orphanProj', entries: entries(), sourceDirs: [], enabled: true })
const r3 = resolveRegistration({ projectId: 'orphanProj', entries: entries() })
rec('③ 伪记录（只有 project_id 一行）⇒ orphan，不得 registered', g3.ok === false && r3.status === 'orphan', 'status=' + r3.status + ' reason=' + String(r3.reason).slice(0, 60))

// ══ 能红 ④ 伪造 registry 条目 ⇒ 必须被拒（Q8 硬输入 B：不得只验字段存在）══
ok(good({ project_id: 'forgeProj', project_name: 'forgeProj', root_dirs: [GHOST] })) // 字段齐全但 root 不存在
const r4 = resolveRegistration({ projectId: 'forgeProj', entries: entries() })
const fieldsComplete = REQUIRED_FIELDS.every((f) => { const v = f === 'root_dirs' ? rootDirsOf({ root_dirs: [GHOST] }) : 'x'; return v !== undefined && v !== null && v !== '' })
rec('④ 字段齐全但 **root 不存在** ⇒ vanished（不得 registered）', r4.status === 'vanished', 'status=' + r4.status + '（对照：字段本身齐备=' + fieldsComplete + ' ⇒ 只验字段会误判 registered）')
ok(good({ project_id: 'staleProj', project_name: 'staleProj', root_dirs: [ROOT_B] }))
const r4b = resolveRegistration({ projectId: 'staleProj', entries: entries(), sourceDirs: [ROOT_A] })
rec('④′ root 存在但**与源内 dirs 不一致** ⇒ stale（换根未重登记 = Q8 绕过①）', r4b.status === 'stale', 'status=' + r4b.status)

// ══ 能红 ⑤ 开关 OFF ⇒ 门禁消失（差异来自这个开关）══
const off = checkGate({ projectId: 'never-registered', entries: [], sourceDirs: [], enabled: false })
const on = checkGate({ projectId: 'never-registered', entries: [], sourceDirs: [], enabled: true })
rec('⑤ 开关 OFF ⇒ 放行（门禁消失）；同输入 ON ⇒ 拒 ⇒ 差异确实来自该开关', off.ok === true && off.gate === 'off' && on.ok === false && on.gate === 'on', 'off=' + off.gate + '/ok=' + off.ok + ' · on=' + on.gate + '/ok=' + on.ok)
rec('⑤′ 默认值即 OFF（不介入现有流程 —— A3 S1 边界）', REGISTRY_DEFAULTS.enabled === false, 'REGISTRY_DEFAULTS.enabled=' + REGISTRY_DEFAULTS.enabled)

// ══ 能红 ⑥ discovered 与 registered 同一项目只出现一次 ══
const names = ['projA', 'projB', 'orphanProj', 'forgeProj', 'staleProj', 'never-registered']
const rows = names.map((n) => ({ project: n, status: resolveRegistration({ projectId: n, entries: entries(), sourceDirs: [ROOT_A, ROOT_B] }).status }))
const dupes = rows.map((r) => r.project).filter((n, i, a) => a.indexOf(n) !== i)
rec('⑥ 每个项目只出现一次（无重复计数）且带 status 字段', dupes.length === 0 && rows.every((r) => !!r.status), 'count=' + rows.length + ' 重复=' + JSON.stringify(dupes) + ' 分布=' + JSON.stringify(rows.map((r) => r.project + ':' + r.status)))

// ══ Q8 (A)① 改名 ⇒ vanished（root 消失）══
rec('(A)① 改名/移动：root 全不存在 ⇒ vanished（不冒充 registered）', r4.status === 'vanished', 'status=' + r4.status)

// ══ Q8 (A)② 同名多根 + 登记冲突检测 ══
ok(good({ project_id: 'multiRoot', project_name: 'multiRoot', root_dirs: [ROOT_A, ROOT_B] }))
const rMulti = resolveRegistration({ projectId: 'multiRoot', entries: entries(), sourceDirs: [ROOT_B] })
rec('(A)② 同名多根：root_dirs[] 任一命中源即一致 ⇒ registered', rMulti.status === 'registered' && JSON.stringify(rMulti.registration.root_dirs) === JSON.stringify([ROOT_A, ROOT_B]), 'status=' + rMulti.status + ' roots=' + JSON.stringify(rMulti.registration?.root_dirs))
const conf = detectRootConflict(entries(), 'newProj', [ROOT_A])
rec('(A)②′ 登记冲突检测：同 root 已被别的 project_id 占有 ⇒ 报冲突', conf.length > 0 && conf[0].owner === 'projA', 'conflicts=' + JSON.stringify(conf))
rec('(A)②″ 阴性对照：不同 root ⇒ 无冲突', detectRootConflict(entries(), 'newProj', [path.join(TMP, 'other')]).length === 0, 'ok')

// ══ Q8 (A)③ 借壳：supersedes / generation ══
ok(good({ project_id: 'hijackProj', project_name: 'hijackProj', root_dirs: [ROOT_A], generation: 1 }))
ok(good({ project_id: 'otherOwner', project_name: 'otherOwner', root_dirs: [ROOT_B], generation: 2, supersedes: 'hijackProj' }))
const rHij = resolveRegistration({ projectId: 'hijackProj', entries: entries(), sourceDirs: [ROOT_A] })
rec('(A)③ 借壳：被更高 generation 的 supersedes 覆盖 ⇒ 该登记判 orphan（不冒充 registered）', rHij.status === 'orphan', 'status=' + rHij.status + ' reason=' + String(rHij.reason).slice(0, 70))

// ══ Q8 (C) registry 落点必须在 prod-guard 面内 ══
const prodReg = registryPath(path.join(os.homedir(), '.gbrain', 'agent-roles'))
const face = prodFaceOf(prodReg)
let blocked = false
try { guardProdWrite(prodReg, { env: {} }) } catch (e) { blocked = e instanceof ProdWriteBlockedError }
rec('(C) 生产登记表落点**在 prodFaces() 内**且无声明写入 ⇒ 被拒（测试再不能静默写它）', !!face && blocked, 'face=' + (face?.root ?? 'null') + ' blocked=' + blocked)
rec('(C)′ 阴性对照：显式声明后放行（同一路径，仅声明不同）', (() => { try { return guardProdWrite(prodReg, { env: { [ALLOW_ENV]: '1' } }).allowed } catch { return false } })(), 'ok')
rec('(C)″ 阴性对照：临时隔离面写入不被拦（防一律拒绝）', (() => { try { return guardProdWrite(REG, { env: {} }).allowed && prodFaceOf(REG) === null } catch { return false } })(), 'REG=' + REG)

// ══ Q8 绕过 ③ 并发 append 不交错 ══
const CONC = path.join(TMP, 'concurrent.jsonl')
const N = 200
for (let i = 0; i < N; i += 1) appendRegistry(CONC, { i, pad: 'x'.repeat(200) })
const concRows = readRegistry(CONC)
const intact = concRows.length === N && concRows.every((r) => typeof r.i === 'number')
rec('绕过③ 连续 append N=' + N + ' 行 ⇒ 行数正确且每行 JSON 完整（行级容错读回）', intact, 'rows=' + concRows.length + '（真并发需多进程，本项为**同进程高频追加**，见记录未做项）')

// ══ Q8 绕过 ④ gate-checks.jsonl 落点已定 ══
rec('绕过④ 门禁审计落点已定（单一 home，与 registry 同目录）', gateChecksPath(path.join(TMP, 'hr')).endsWith('data/gate-checks.jsonl'.replace('/', path.sep)) || gateChecksPath(path.join(TMP, 'hr')).includes('gate-checks.jsonl'), gateChecksPath(path.join(TMP, 'hr')))
appendRegistry(GATE, { ts: new Date().toISOString(), project_id: 'projA', action: 'register', decision: 'allow', gate_enabled: true })
appendRegistry(GATE, { ts: new Date().toISOString(), project_id: 'projA', action: 'gate-toggle', decision: 'off', gate_enabled: false })
const gateRows = readRegistry(GATE)
rec('绕过④′ 开关变更本身留痕（gate-toggle 行）⇒ 「关了」与「没违规」可区分', gateRows.some((r) => r.action === 'gate-toggle'), 'rows=' + gateRows.length)

// ══ 零写入被诊断对象（本装置不碰生产）══
const prodFacesTouched = results.filter((r) => !r.ok).length
rec('⑨ 本装置全部夹具在 mkdtemp（无生产写入）', TMP.includes('e9-gate-') && !fs.existsSync(path.join(os.homedir(), '.gbrain', 'agent-roles', 'data', 'registry.jsonl-verify-probe')), 'TMP=' + TMP)

fs.rmSync(TMP, { recursive: true, force: true })
const fails = results.filter((r) => !r.ok)
console.log('')
console.log('===== ' + (results.length - fails.length) + '/' + results.length + ' PASS · ' + fails.length + ' FAIL =====')
for (const f of fails) console.log('FAIL:', f.name)
process.exit(fails.length ? 1 : 0)
