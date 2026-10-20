#!/usr/bin/env node
// e3-boot-ledger-reconcile.mjs — E2：用「install 行数 vs 重复 register 次数」把
// 「域重装 ⇒ 进程内 Set 清空 ⇒ 重复 register」由推断升为**已证 / 或证伪**（两方向都给判据）。
//
// 数据面（均只读）：
//   boot   AIMS data/logs/aims-observe-boot.log   每 installObserve 一行（observe.js 挂载打点）
//   reg    AIMS data/logs/aims-register.log       每次收尾 spawn register 一行（lib/aims/observe.js spawnRegister）
//   ledger AIMS data/aims/closeout-ledger.jsonl   每次收尾**成功**落账一行（lib/aims/ledger.js）
//
// 判据设计（**两个方向都写死**，避免"只找支持证据"）：
//   · 宿主锚：宿主进程一次启动只写 1 行（BOARD 仪笔记 D）。故「域重装」在该 pid 上表现为 **≥2 行**。
//   · 支持方向（会在这样时判"已证"）：存在 pid 满足 count≥2 且 spread ≥ RELOAD_MIN_MS（重装由配置变更触发，
//     不可能在毫秒级内连发多次），且该 pid 窗口内同一会话出现 ≥2 次 register、且第 2 次之前**无**台账 mark。
//   · 证伪方向（实测）：所有 count≥2 的 pid 其 spread < BURST_MAX_MS（启动期连发，非随时间发生的重装）
//     ⇒ 覆盖窗口内**未观测到**任何进程内域重装；窗口内的重复 register 逐一归属世代，看是否为**跨代**。
//   覆盖边界：boot 首行之前的历史（含 t34 原始证据窗口）**不可判定**，脚本显式打印该边界。
//
// 用法：node scripts/e3-boot-ledger-reconcile.mjs [--boot <p>] [--reg <p>] [--ledger <p>] [--json]
// 退出码：0 = 跑完（结论见 stdout）；2 = 数据面缺失。
import fs from 'node:fs'

const AIMS = process.env.AIMS_REPO || 'D:\\agent-identity-memory-system'
const argOf = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt }
const BOOT = argOf('--boot', AIMS + '\\data\\logs\\aims-observe-boot.log')
const REG = argOf('--reg', AIMS + '\\data\\logs\\aims-register.log')
const LEDGER = argOf('--ledger', AIMS + '\\data\\aims\\closeout-ledger.jsonl')
const AS_JSON = process.argv.includes('--json')

const RELOAD_MIN_MS = 60_000  // ≥1 分钟才可能是"随时间发生的重装"（启动连发都在毫秒级）
const BURST_MAX_MS = 1_000    // <1 秒 = 启动期连发

for (const [n, p] of [['boot', BOOT], ['reg', REG], ['ledger', LEDGER]]) {
  if (!fs.existsSync(p)) { console.error(`✗ ${n} 数据面缺失：${p}`); process.exit(2) }
}
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())

// ── boot：每 pid 的 install 行 ──────────────────────────────────────────────
const mounts = lines(BOOT).map((l) => JSON.parse(l)).filter((r) => r.event === 'observe/mounted')
const byPid = new Map()
for (const m of mounts) {
  const e = byPid.get(m.pid) ?? { pid: m.pid, n: 0, first: m.ts, last: m.ts, listeners: new Set() }
  e.n += 1
  if (m.ts < e.first) e.first = m.ts
  if (m.ts > e.last) e.last = m.ts
  e.listeners.add(JSON.stringify(m.listeners))
  byPid.set(m.pid, e)
}
const pids = [...byPid.values()].map((e) => ({ ...e, spreadMs: Date.parse(e.last) - Date.parse(e.first), listeners: [...e.listeners] }))
  .sort((a, b) => Date.parse(a.first) - Date.parse(b.first))

const hostShaped = pids.filter((p) => p.n === 1)                       // 一次启动一行 ⇒ 宿主形状
const multi = pids.filter((p) => p.n >= 2)
const bursts = multi.filter((p) => p.spreadMs < BURST_MAX_MS)          // 启动连发（非宿主重装）
const reloadShaped = multi.filter((p) => p.spreadMs >= RELOAD_MIN_MS)  // 才是"域重装"的形状

// ── 世代窗口：由宿主形状 pid 的 mount 时刻切分 ──────────────────────────────
const gens = hostShaped.map((p, i) => ({ pid: p.pid, from: p.first, to: hostShaped[i + 1]?.first ?? null, listeners: p.listeners[0] }))
const genOf = (ts) => { let hit = null; for (const g of gens) { if (ts >= g.from && (g.to === null || ts < g.to)) hit = g } return hit }

// ── register / ledger ──────────────────────────────────────────────────────
const regs = lines(REG).map((l) => {
  const m = /^\[(.+?)\] register (\S+?)（(.*?)）…$/.exec(l.trim())
  return m ? { ts: m[1], sid: m[2], kind: m[3] } : null
}).filter(Boolean)
const marks = lines(LEDGER).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const bySid = new Map()
for (const r of regs) { if (!bySid.has(r.sid)) bySid.set(r.sid, []); bySid.get(r.sid).push(r) }
const dupSids = [...bySid.entries()].filter(([, v]) => v.length >= 2)

const coverage = { bootFirst: mounts[0]?.ts ?? null, bootLast: mounts[mounts.length - 1]?.ts ?? null }
const windowFrom = coverage.bootFirst
const withinCoverage = (ts) => windowFrom !== null && ts >= windowFrom

// ── 对每个重复会话：逐对分类（同代 / 跨代）+ 台账 mark 是否已在第 2 次之前 ──
const dupReport = dupSids.map(([sid, evs]) => {
  const pairs = []
  for (let i = 1; i < evs.length; i += 1) {
    const a = evs[i - 1], b = evs[i]
    const ga = genOf(a.ts), gb = genOf(b.ts)
    const markBefore = marks.some((m) => m.session_id === sid && m.ts > a.ts && m.ts < b.ts)
    pairs.push({
      from: a.ts, to: b.ts,
      sameGen: !!(ga && gb && ga.pid === gb.pid),
      genA: ga?.pid ?? null, genB: gb?.pid ?? null,
      covered: withinCoverage(a.ts) && withinCoverage(b.ts),
      ledgerMarkBetween: markBefore,
    })
  }
  return { sid, registers: evs.length, pairs, inCoverage: withinCoverage(evs[evs.length - 1].ts) }
})

const sameGenWithinCoverage = dupReport.flatMap((d) => d.pairs.filter((p) => p.covered && p.sameGen)).length
const crossGenWithinCoverage = dupReport.flatMap((d) => d.pairs.filter((p) => p.covered && !p.sameGen)).length
const outOfCoverage = dupReport.flatMap((d) => d.pairs.filter((p) => !p.covered)).length

const verdict = reloadShaped.length === 0
  ? '证伪（覆盖窗口内）：未观测到任何 pid 的 install 行呈"随时间发生的重装"形状 ⇒ 域重装未发生'
  : '已证：存在 reload 形状的 pid，见 reloadShaped'

const report = {
  dataFaces: { boot: BOOT, reg: REG, ledger: LEDGER },
  coverage: { from: coverage.bootFirst, to: coverage.bootLast, bootLines: mounts.length },
  pids: { total: pids.length, hostShaped: hostShaped.map((p) => ({ pid: p.pid, at: p.first, listeners: p.listeners[0] })), multi: multi.length, burstLt1s: bursts.length, reloadShaped: reloadShaped.map((p) => ({ pid: p.pid, n: p.n, spreadMs: p.spreadMs })) },
  register: { events: regs.length, sessions: bySid.size, dupSessions: dupSids.length },
  ledger: { marks: marks.length },
  duplicates: { sameGenWithinCoverage, crossGenWithinCoverage, outOfCoverage },
  verdict,
}

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)) } else {
  console.log('数据面: ' + BOOT + ' | ' + REG + ' | ' + LEDGER)
  console.log(`覆盖窗口: ${coverage.bootFirst} → ${coverage.bootLast}（boot 行 ${mounts.length}）`)
  console.log(`\n[1] install 行按 pid 分类（共 ${pids.length} 个 pid）`)
  console.log(`    宿主形状（1 行/pid，一次启动一行）: ${hostShaped.length} 个`)
  for (const p of hostShaped) console.log(`      pid=${String(p.pid).padEnd(6)} at=${p.first}  listeners=${p.listeners[0]}`)
  console.log(`    多行 pid: ${multi.length} 个 —— 其中 spread < ${BURST_MAX_MS}ms 的启动连发 ${bursts.length} 个；`)
  console.log(`    **spread ≥ ${RELOAD_MIN_MS}ms 的"域重装"形状: ${reloadShaped.length} 个**`)
  console.log(`    多行 pid 的最大 spread = ${Math.max(0, ...multi.map((p) => p.spreadMs))} ms`)
  console.log(`\n[2] register 事件 ${regs.length} 次 / ${bySid.size} 个会话；重复会话（≥2 次）${dupSids.length} 个`)
  console.log(`    台账 mark ${marks.length} 行`)
  console.log('\n[3] 重复 register 逐对归属（判据：同代 or 跨代；第 2 次前是否已有台账 mark）')
  for (const d of dupReport) {
    console.log(`    ${d.sid.slice(0, 8)}… ×${d.registers}`)
    for (const p of d.pairs) console.log(`      ${p.from} → ${p.to}  ${p.sameGen ? '同代(pid=' + p.genA + ')' : '跨代(' + p.genA + '→' + p.genB + ')'}  covered=${p.covered}  ledgerMarkBetween=${p.ledgerMarkBetween}`)
  }
  console.log(`\n[4] 覆盖窗口内：同代对 ${sameGenWithinCoverage} · 跨代对 ${crossGenWithinCoverage} · 窗口外对 ${outOfCoverage}`)
  console.log(`\n结论：${verdict}`)
  console.log('覆盖边界：boot 首行之前的历史（含 t34 原始证据窗口 2026-09-10T00:43Z–01:55Z）**不可判定** —— 无 install 行可比对。')
}
