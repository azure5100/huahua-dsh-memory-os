#!/usr/bin/env node
// e4-review-gate-probe.mjs — E4：在**独立进程 + 隔离数据面（生产面只读拷贝）**里验证 `reviewEnabled` 门。
//
// 铁律遵守：不重启宿主 · 不开探针 · 不改配置 · **不动生产数据**（生产文件只读拷贝；所有写入只落 mkdtemp 目录）。
// 层位（TEAM-A §7 第 4 关，分开写不得冒充）：
//   A/B/C = **装配级**（真调 lib/index.js apply()，看 tools.register 实际注册了什么）
//   D/E/F/G = **装配级**（直装 lib/review.js reviewTurnCounter —— 与 index.js:1469 同一函数）
//   H = **写盘面**（隔离副本上的 SuggestionQueue）
//   I = **源码级**（读源码文本做断言，不执行）
//
// 用法：node scripts/e4-review-gate-probe.mjs [--json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { apply } from '../lib/index.js'
import { reviewTurnCounter, reviewStatusTool, suggestToolDefinition } from '../lib/review.js'
import { SuggestionQueue } from '../lib/store.js'
import { guardProdWrite, assertIsolated, ProdWriteBlockedError, ALLOW_ENV } from '../lib/prod-guard.js' // E5·B 硬护栏

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const now = () => new Date().toISOString()
const PROD_MEM = path.join(os.homedir(), '.dsh', 'memories')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const results = []
const rec = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}  @${now()}`) }

// ── 隔离数据面：生产面**只读拷贝** ───────────────────────────────────────────
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-review-'))
const faces = ['plugin-state.json', 'SUGGESTIONS.jsonl']
const faceBefore = {}
for (const f of faces) {
  const src = path.join(PROD_MEM, f)
  const dst = path.join(ISO, f)
  if (fs.existsSync(src)) {
    const buf = fs.readFileSync(src)
    fs.writeFileSync(dst, buf)
    faceBefore[f] = { bytes: buf.length, sha256: sha256(buf), rows: buf.toString('utf8').split('\n').filter((l) => l.trim()).length }
  } else faceBefore[f] = null
}
console.log('=== 环境 ===')
console.log(`node=${process.version}  cwd=${process.cwd()}`)
console.log(`隔离数据面 ISO=${ISO}（mkdtemp；生产面只读拷贝）`)
console.log(`生产 memoryDir=${PROD_MEM}`)
for (const f of faces) console.log(`  拷贝 ${f}: ${faceBefore[f] ? `bytes=${faceBefore[f].bytes} rows=${faceBefore[f].rows} sha256=${faceBefore[f].sha256.slice(0, 16)}` : '不存在'}`)
console.log(`lib/index.js sha256=${sha256(fs.readFileSync(path.join(REPO, 'lib', 'index.js'))).slice(0, 16)} · lib/review.js sha256=${sha256(fs.readFileSync(path.join(REPO, 'lib', 'review.js'))).slice(0, 16)}`)
const runAt = now()

// ── 生产面哨兵（**自证「不动生产数据」**）：AIMS boot log 的字节数 + 行数必须前后不变 ──
const AIMS_BOOT = path.join('D:\\agent-identity-memory-system', 'data', 'logs', 'aims-observe-boot.log')
const bootSnap = () => { try { const b = fs.readFileSync(AIMS_BOOT); return { bytes: b.length, lines: b.toString('utf8').split('\n').filter((l) => l.trim()).length, sha256: sha256(b) } } catch { return null } }
const bootBefore = bootSnap()
console.log(`生产面哨兵 AIMS boot log: ${bootBefore ? 'bytes=' + bootBefore.bytes + ' lines=' + bootBefore.lines + ' sha256=' + bootBefore.sha256.slice(0, 16) : '不可读'}`)

// ── stub ctx（模型同 tests/plugin.test.js:40-86，逐字段对齐） ─────────────────
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => { const i = state.tools.indexOf(def); if (i >= 0) state.tools.splice(i, 1) } }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, cb) => (deps.every((d) => services[d] !== undefined) ? { dispose: cb(ctx) ?? (() => {}) } : { dispose: () => {} }),
    effect: (fn) => fn() ?? (() => {}),
    get: (k) => services[k],
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

// 安全装配配置：**把一切会写生产面的重模块显式关掉**（否则 aimsEnabled 等默认 true 会写 AIMS 仓）
const SAFE = {
  memoryDir: ISO,
  injectMemory: false, memoryTabEnabled: false, perTurnDailyWrites: false, perTurnProjectWrites: false, perTurnKeyWrites: false,
  coiEnabled: false, broadcastEnabled: false, sessionEnabled: false, uiSettingsEnabled: false, notifyEnabled: false,
  canvasEnabled: false, aimsEnabled: false, agentsEnabled: false, advisorEnabled: false, modelsEnabled: false,
  searchDocsEnabled: false, sessionSearchEnabled: false, promptsEnabled: false, bookmarkEnabled: false, syncEnabled: false,
}
const toolNames = (ctx) => ctx.state.tools.map((t) => t.name).sort()
const REVIEW_TOOLS = ['memory_review_status', 'memory_suggest']

// ── A 装配级：门开 ──────────────────────────────────────────────────────────
// ⚠️ arm A 必须用**消毒过的**隔离 state（空对象）：若直接复用生产 state 拷贝，
// 其中的 aimsEnabled/agentsEnabled/coiEnabled… 会被 apply 读入并安装 ⇒ 写生产面。
const isoA = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-a-'))
fs.writeFileSync(path.join(isoA, 'plugin-state.json'), '{}\n')
const ctxA = fakeCtx(); apply(ctxA, { ...SAFE, memoryDir: isoA, reviewEnabled: true })
const namesA = toolNames(ctxA)
rec('A 装配级·门开：reviewEnabled=true ⇒ memory_suggest + memory_review_status 已注册', REVIEW_TOOLS.every((n) => namesA.includes(n)), `tools=${JSON.stringify(namesA)}`)

// ── B 装配级·阴性对照：门关（且无 state） ───────────────────────────────────
const isoB = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-b-'))
const ctxB = fakeCtx(); apply(ctxB, { ...SAFE, memoryDir: isoB, reviewEnabled: false })
const namesB = toolNames(ctxB)
rec('B 装配级·**阴性对照**·门关：两件审查工具**不得**注册', REVIEW_TOOLS.every((n) => !namesB.includes(n)), `tools=${JSON.stringify(namesB)}`)
rec('B′ 阴性对照有判别力：A 与 B 的工具集**确实不同**', JSON.stringify(namesA) !== JSON.stringify(namesB), `A=${namesA.length} 件 · B=${namesB.length} 件`)

// ── C 装配级：config 静态关、但 state（装载时读入）为开 ─────────────────────
const isoC = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-c-'))
fs.writeFileSync(path.join(isoC, 'plugin-state.json'), JSON.stringify({ reviewEnabled: true }) + '\n')
const ctxC = fakeCtx(); apply(ctxC, { ...SAFE, memoryDir: isoC, reviewEnabled: false })
const namesC = toolNames(ctxC)
rec('C 装配级·state 副本 reviewEnabled=true ⇒ 两件审查工具注册（注册判定读**装载时**的 runtime）', REVIEW_TOOLS.every((n) => namesC.includes(n)), `tools=${JSON.stringify(namesC)}`)

// ── D/E/F/G 装配级：计数行为（reviewTurnCounter，index.js:1469 同一函数） ────
const feed = (ctx, sid, turn, opts = {}) => {
  const { origin = 'main', reasonKind = 'completed', triggerKind = 'message', events } = opts
  const session = {
    id: sid,
    header: { origin, title: 'E4 探针' },
    events: events ?? [{ type: 'turn/start', seq: 0, data: { turn, trigger: { kind: triggerKind } } }],
  }
  for (const h of (ctx.state.listeners['session/event'] ?? [])) h(session, { type: 'turn/end', data: { turn, reason: { kind: reasonKind } } })
}
const mkCounter = (enabled, interval = 5) => {
  const ctx = fakeCtx()
  const rt = { reviewEnabled: enabled, reviewInterval: interval, reviewMode: 'suggest', skillReviewEnabled: false }
  const counter = reviewTurnCounter(ctx, () => rt)
  return { ctx, counter, rt }
}
const SID = 'e4-probe-session-0001'

const on = mkCounter(true)
const seqOn = []
for (let t = 1; t <= 5; t += 1) { feed(on.ctx, SID, t); seqOn.push(on.counter.turnsOf({ id: SID })) }
const stOn = await reviewStatusTool(() => on.rt, on.counter).execute({ action: 'check' }, { agent: { id: SID } })
rec('D 装配级·门开：5 个 message 回合 ⇒ 计数 1,2,3,4,5', JSON.stringify(seqOn) === JSON.stringify([1, 2, 3, 4, 5]), `turnsOf=(${seqOn.join(',')}) @${now()}`)
rec('D′ 门开·到期判定：turns(5) ≥ interval(5) ⇒ due=true', stOn.due === true, `due=${stOn.due} turnsSinceReview=${stOn.turnsSinceReview} interval=${stOn.interval} mode=${stOn.mode}`)

const off = mkCounter(false)
const seqOff = []
for (let t = 1; t <= 5; t += 1) { feed(off.ctx, SID, t); seqOff.push(off.counter.turnsOf({ id: SID })) }
const stOff = await reviewStatusTool(() => off.rt, off.counter).execute({ action: 'check' }, { agent: { id: SID } })
rec('E 装配级·**阴性对照**·门关：同样 5 个回合 ⇒ 计数**恒 0**、due=false', seqOff.every((v) => v === 0) && stOff.due === false, `turnsOf=(${seqOff.join(',')}) due=${stOff.due}`)
rec('E′ 差异确实来自这道门（同输入同序列，仅门不同）', seqOn[4] === 5 && seqOff[4] === 0, `门开末值=${seqOn[4]} · 门关末值=${seqOff[4]} @${now()}`)

const neg = mkCounter(true)
const negCases = [
  ['subagent 会话', { origin: 'subagent' }],
  ['reason=aborted', { reasonKind: 'aborted' }],
  ['reason=interrupted', { reasonKind: 'interrupted' }],
  ['reason=blocked', { reasonKind: 'blocked' }],
  ['trigger≠message（注入）', { triggerKind: 'injection' }],
  ['无对应 turn/start', { events: [] }],
]
const negOut = []
for (const [label, o] of negCases) { const before = neg.counter.turnsOf({ id: SID }); feed(neg.ctx, SID, 9, o); negOut.push(`${label}: ${before}→${neg.counter.turnsOf({ id: SID })}`) }
rec('F 装配级·门开但不该计数的 6 类回合 ⇒ 计数不变', negOut.every((s) => { const m = /: (\d+)→(\d+)$/.exec(s); return m && m[1] === m[2] }), negOut.join(' · '))
const negCount = neg.counter.turnsOf({ id: SID })
rec('F′ 反例后补一个**正常** message 回合 ⇒ 计数必须 +1（证明反例是"不计数"而非"计数器坏了"）', (() => { feed(neg.ctx, SID, 10); return neg.counter.turnsOf({ id: SID }) === negCount + 1 })(), `${negCount}→${neg.counter.turnsOf({ id: SID })}`)

const rst = await reviewStatusTool(() => on.rt, on.counter).execute({ action: 'complete' }, { agent: { id: SID } })
rec('G 装配级·complete 复位：复位后计数归 0', on.counter.turnsOf({ id: SID }) === 0 && /已复位/.test(rst.message), `turnsOf=${on.counter.turnsOf({ id: SID })} msg=${rst.message}`)
const early = mkCounter(true)
feed(early.ctx, SID, 1)
const earlyRes = await reviewStatusTool(() => early.rt, early.counter).execute({ action: 'complete' }, { agent: { id: SID } })
rec('G′ 未到期时 complete 不误复位（review.js:144 早退）', early.counter.turnsOf({ id: SID }) === 1, `turnsOf=${early.counter.turnsOf({ id: SID })} msg=${earlyRes.message}`)

// ── H 写盘面：建议队列（隔离副本） ──────────────────────────────────────────
const sf = path.join(ISO, 'SUGGESTIONS.jsonl')
const beforeH = (() => { const b = fs.existsSync(sf) ? fs.readFileSync(sf) : Buffer.alloc(0); return { bytes: b.length, sha256: sha256(b), rows: b.toString('utf8').split('\n').filter((l) => l.trim()).length } })()
const q = new SuggestionQueue(sf)
const sug = suggestToolDefinition({ suggestToolName: 'memory_suggest' }, q)
const r1 = await sug.execute({ target: 'memory', content: 'E4 探针：门开时 memory_suggest 会写队列（隔离副本）', reason: 'E4 影响面取证' }, { agent: { id: SID } })
const after1 = (() => { const b = fs.readFileSync(sf); return { bytes: b.length, rows: b.toString('utf8').split('\n').filter((l) => l.trim()).length } })()
// ⚠️ 断言必须**结构性/增量**（纪律 38：不断言计数本身）：副本里可能已有他人写入的建议行
// （实测 2026-09-11T07:19:22Z 秘书会话写入 1 行 key 建议 ⇒ 若断言「0→1」会假红）
const r2 = await sug.execute({ target: 'memory', content: 'E4 探针：门开时 memory_suggest 会写队列（隔离副本）', reason: 'E4 影响面取证（重复）' }, { agent: { id: SID } })
const after2 = (() => { const b = fs.readFileSync(sf); return { bytes: b.length, rows: b.toString('utf8').split('\n').filter((l) => l.trim()).length } })()
rec('H 写盘面：memory_suggest 第 1 次 ⇒ 副本 SUGGESTIONS.jsonl **行数 +1**（增量断言，非绝对计数）', after1.rows === beforeH.rows + 1, `${beforeH.rows}→${after1.rows} 行 · ${beforeH.bytes}→${after1.bytes} B · sha256 ${beforeH.sha256.slice(0, 16)}→${sha256(fs.readFileSync(sf)).slice(0, 16)}`)
rec('H′ 重复内容去重：第 2 次不得新增行（hits 累加）', after2.rows === after1.rows && r2.queued === r1.queued, `r1.queued=${r1.queued} r2.queued=${r2.queued} rows=${after1.rows}→${after2.rows}`)
rec('H″ **写盘被证明落在隔离副本内**（未触碰生产 memoryDir）', sf.startsWith(ISO) && path.resolve(sf) !== path.resolve(path.join(PROD_MEM, 'SUGGESTIONS.jsonl')), `写入路径=${sf}`)

// ── I 源码级：注册判定是装载期常量；运行中翻转不补注册 ─────────────────────
const idxSrc = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
const lines = idxSrc.split(/\r?\n/)
const reviewWantedLine = lines.findIndex((l) => /const reviewWanted = /.test(l)) + 1
const ifWantedLine = lines.findIndex((l) => /^\s*if \(reviewWanted\) \{/.test(l)) + 1
const patchStart = lines.findIndex((l) => /const applyRuntimePatch = /.test(l)) + 1
const patchEnd = patchStart + 30
const patchBody = lines.slice(patchStart - 1, patchEnd).join('\n')
const guardOk = reviewWantedLine > 0 && ifWantedLine > 0 && /config\.reviewEnabled \|\| runtime\.reviewEnabled/.test(lines[reviewWantedLine - 1])
rec('I 源码级：reviewWanted 在 apply() 体内**仅求值一次**（装载期），条件=config||runtime', guardOk, `lib/index.js:${reviewWantedLine} "${(lines[reviewWantedLine - 1] ?? '').trim()}" · 判据分支 lib/index.js:${ifWantedLine}`)
const syncMentionsReview = /review/i.test(patchBody)
rec('I′ 源码级：applyRuntimePatch 内**无** review 同步 ⇒ 运行中翻转 reviewEnabled **不会**补注册工具', !syncMentionsReview, `applyRuntimePatch 起 lib/index.js:${patchStart}，扫 ${patchBody.split('\n').length} 行，含 review=${syncMentionsReview}`)
rec('I″ 源码级：reviewTurnCounter 的门在处理器内、注册**无条件**（门是行为门，不是注册门）', /ctx\.effect\(\(\) => ctx\.on\('session\/event'/.test(fs.readFileSync(path.join(REPO, 'lib', 'review.js'), 'utf8')), 'lib/review.js:90 ctx.effect(() => ctx.on(\'session/event\', …)) 无 if 包裹')

// ── 收尾 ────────────────────────────────────────────────────────────────────
// ── K·E5 硬护栏接入自证（**真用上**，不是摆设） ───────────────────────────────
// K1：对**真实生产路径**的写入必须被护栏拒绝（红得起来的阴性对照）
let kBlocked = false
try { guardProdWrite(path.join(PROD_MEM, 'SUGGESTIONS.jsonl'), { env: {} }) } catch (e) { kBlocked = e instanceof ProdWriteBlockedError }
rec('K1 E5 硬护栏：写真实生产面（无 ' + ALLOW_ENV + ' 声明）⇒ 被 ProdWriteBlockedError 拒绝', kBlocked, 'lib/prod-guard.js · 用例 tests/prod-guard.test.js ①')
// K2：显式声明后才放行（同一路径，仅声明不同 ⇒ 证明拒绝来自声明，不是恒拒）
let kAllowed = false
try { kAllowed = guardProdWrite(path.join(PROD_MEM, 'SUGGESTIONS.jsonl'), { env: { [ALLOW_ENV]: '1' } }).allowed } catch { kAllowed = false }
rec('K2 E5 硬护栏：同路径 + 显式声明 ' + ALLOW_ENV + '=1 ⇒ 放行（非"一律拒绝"）', kAllowed, '判别力对照')
// K3：本装置自己的写目标必须钉在隔离面内（否则装置本人就是污染源）
rec('K3 本装置写目标全部在隔离面内', (() => { try { assertIsolated(sf, ISO); return true } catch { return false } })(), 'sf=' + sf)

// ── 隔离自证（**会红的**守卫：违反即 FAIL） ──────────────────────────────────
const bootAfter = bootSnap()
rec('J 生产面哨兵：AIMS boot log 字节数/行数/sha256 前后**完全不变**（证「不动生产数据」）',
  !!bootBefore && !!bootAfter && bootBefore.sha256 === bootAfter.sha256,
  `before=${bootBefore?.bytes}B/${bootBefore?.lines}行 · after=${bootAfter?.bytes}B/${bootAfter?.lines}行`)
const UNSAFE = /^de_(coi|broadcast|canvas|notify|session|channel_send)|^memory$|^skill_manage$|^dtodo$/
const leaked = namesA.filter((n) => UNSAFE.test(n) && !['memory', 'skill_manage', 'dtodo', 'de_channel_send'].includes(n))
rec('J′ 隔离自证：arm A 装配未安装任何生产侧模块（无 de_coi_* / de_broadcast / de_canvas / de_notify / de_session）',
  leaked.length === 0, `疑似泄漏工具=${JSON.stringify(leaked)} · 实际装配=${JSON.stringify(namesA)}`)

const fails = results.filter((r) => !r.ok)
console.log(`\n===== 隔离数据面用量：${ISO}（本进程写入仅此目录） =====`)
console.log(`===== ${results.length - fails.length}/${results.length} PASS · ${fails.length} FAIL · 开工 ${runAt} / 收工 ${now()} =====`)
fs.rmSync(ISO, { recursive: true, force: true })
fs.rmSync(isoB, { recursive: true, force: true })
fs.rmSync(isoC, { recursive: true, force: true })
fs.rmSync(isoA, { recursive: true, force: true })
if (fails.length) { for (const f of fails) console.log('FAIL:', f.name); process.exit(1) }
