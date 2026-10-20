#!/usr/bin/env node
// huahua-os · 人事部融合 阶段 1A：scripts/agents-sync.mjs —— 人事部角色库源 → 仓库根 agents/ 副本同步器
// （docs/89 §1.3 版本同步策略；运维工具，非插件运行路径）
//
// 职责：
//   ① source/*.md 只读镜像复制（sha256 幂等跳过未变；跟随删除）
//   ② role-index.json **副本内自举生成**（扫描副本 source/ → md 与索引 1:1，消灭源侧 N2 漂移）
//   ③ MANIFEST.json 自述来源/计数/treeSha256/driftNote；源 mtime/hash 快照基线（.source-baseline.json）
// 红线：对源目录（~/.gbrain/agent-roles 等三源）**只 fs 读零写**；--apply 只写副本侧
//       （内置红线自断言：apply 前后源 md 树 hash 全等，不等 → exit 3）。
//
// 用法：
//   node scripts/agents-sync.mjs --check            # 漂移报告（源↔副本 + 索引 1:1 + 基线漂移），不落盘
//   node scripts/agents-sync.mjs --dry              # 预演（将复制 N / 删除 M / 重生成索引）
//   node scripts/agents-sync.mjs --apply            # 同步副本 + 自举索引 + MANIFEST + 刷新基线
//   node scripts/agents-sync.mjs --baseline         # 只写三源基线快照（.source-baseline.json；源零写）
//   node scripts/agents-sync.mjs --baseline-check   # 只读比对基线 vs 活源（阶段末 QA S1 复跑）
//   --source <根>  角色库源根（默认 ~/.gbrain/agent-roles；.agents/.claude 技能源可切）
//   --target <目录> 副本目标（默认 <仓库根>/agents）
//   --quiet 仅输出摘要
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { deriveEntry } from '../lib/agents/registry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const HOME = os.homedir()

const SRC_ROOTS = [
  path.join(HOME, '.gbrain', 'agent-roles'),
  path.join(HOME, '.agents', 'skills', 'agent-roles'),
  path.join(HOME, '.claude', 'skills', 'agent-roles'),
]
const BASELINE_EXCLUDE_DIRS = new Set(['.git', 'data']) // data/ = access.jsonl 活流 + 派生产物（S3/S2 另断言）
const BASELINE_EXCLUDE_EXT = new Set(['.log'])

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const homeOf = (p) => String(p).replace(HOME, '~') // MANIFEST source 记 '~' 相对（防仓库泄本地路径）

function log(quiet, ...args) {
  if (!quiet) console.log(...args)
}

function walkFiles(dir, opts = {}) {
  const out = []
  const excludeDirs = opts.excludeDirs ?? BASELINE_EXCLUDE_DIRS
  const excludeExt = opts.excludeExt ?? BASELINE_EXCLUDE_EXT
  const skip = opts.skip ?? (() => false)
  ;(function rec(rel) {
    const abs = path.join(dir, rel)
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const relE = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) continue
        rec(relE)
      } else if (e.isFile() && !excludeExt.has(path.extname(e.name).toLowerCase()) && !skip(relE)) {
        out.push(relE)
      }
    }
  })('')
  return out
}

/** 副本源 md 清单（rel of source/，正斜杠）——只取 *.md（docs/89 §1.2 内容矩阵）。 */
function sourceMdList(sourceRoot) {
  const src = path.join(sourceRoot, 'source')
  if (!fs.existsSync(src)) return []
  return walkFiles(src, { excludeDirs: new Set(['.git']), excludeExt: new Set() })
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => p.toLowerCase().endsWith('.md'))
    .sort()
}

function copyMdList(targetDir) {
  const src = path.join(targetDir, 'source')
  if (!fs.existsSync(src)) return []
  return walkFiles(src, { excludeDirs: new Set(['.git']), excludeExt: new Set() })
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => p.toLowerCase().endsWith('.md'))
    .sort()
}

/** md 树 hash 映射 { rel → sha256 }（源根/副本同构；只读）。 */
function mdHashMap(baseDir) {
  const srcDir = path.join(baseDir, 'source')
  const map = new Map()
  if (!fs.existsSync(srcDir)) return map
  const files = walkFiles(srcDir, { excludeDirs: new Set(['.git']), excludeExt: new Set() }).filter((p) => p.toLowerCase().endsWith('.md'))
  for (const rel of files) {
    const relN = rel.split(path.sep).join('/')
    map.set(relN, sha256(fs.readFileSync(path.join(srcDir, rel))))
  }
  return map
}

function treeSha256(relShaMap) {
  const h = crypto.createHash('sha256')
  for (const rel of [...relShaMap.keys()].sort()) {
    h.update(rel)
    h.update('\0')
    h.update(relShaMap.get(rel))
    h.update('\0')
  }
  return h.digest('hex')
}

/** 源三根基线快照（排 .git/data/*.log）；返回 { capturedAt, roots: { <root>: { rel: {size,mtimeMs,sha256} } } }。 */
function snapshotBaseline() {
  const roots = {}
  for (const root of SRC_ROOTS) {
    if (!fs.existsSync(root)) continue
    const files = walkFiles(root)
    const m = {}
    for (const rel of files) {
      const fp = path.join(root, rel)
      try {
        const st = fs.statSync(fp)
        m[rel.split(path.sep).join('/')] = { size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: sha256(fs.readFileSync(fp)) }
      } catch { /* 文件并发变动则跳过该行 */ }
    }
    roots[root] = m
  }
  return { capturedAt: new Date().toISOString(), roots }
}

function compareBaselineLive(base) {
  const drift = [] // [{root, rel, kind:'added'|'removed'|'changed', before?, after?}]
  for (const [root, rows] of Object.entries(base.roots ?? {})) {
    if (!fs.existsSync(root)) { drift.push({ root, rel: '.', kind: 'root-missing' }); continue }
    const live = {}
    for (const rel of walkFiles(root)) {
      const fp = path.join(root, rel)
      try { live[rel.split(path.sep).join('/')] = sha256(fs.readFileSync(fp)) } catch { /* skip */ }
    }
    for (const rel of Object.keys(rows)) if (!(rel in live)) drift.push({ root, rel, kind: 'removed' })
    for (const [rel, h] of Object.entries(live)) {
      if (!(rel in rows)) drift.push({ root, rel, kind: 'added' })
      else if (rows[rel].sha256 !== h) drift.push({ root, rel, kind: 'changed', before: rows[rel].sha256, after: h })
    }
  }
  return drift
}

function readBaseline(targetDir) {
  const p = path.join(targetDir, '.source-baseline.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
function writeBaseline(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, '.source-baseline.json'), JSON.stringify(snapshotBaseline(), null, 1) + '\n', 'utf8')
}

/** 副本侧漂移报告（源 ↔ 副本 + 索引 1:1）——只读。 */
function reportCopyDrift(sourceRoot, targetDir) {
  const expected = sourceMdList(sourceRoot)
  const present = copyMdList(targetDir)
  const expSet = new Set(expected)
  const curSet = new Set(present)
  const srcHashes = mdHashMap(sourceRoot)
  const copyHashes = mdHashMap(targetDir)
  const added = [], changed = [], removed = []
  for (const rel of expected) if (!curSet.has(rel)) added.push(rel)
  for (const rel of present) if (!expSet.has(rel)) removed.push(rel)
  for (const rel of expected) {
    if (curSet.has(rel) && copyHashes.get(rel) !== srcHashes.get(rel)) changed.push(rel)
  }
  // 索引 1:1（读副本 role-index.json vs 副本 md 数）
  let indexCount = 0, indexError = null
  const idxPath = path.join(targetDir, 'role-index.json')
  try {
    const arr = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
    indexCount = Array.isArray(arr) ? arr.length : 0
  } catch { indexError = 'role-index.json 缺失/损坏' }
  const manifest = readManifest(targetDir)
  return { expected: expected.length, present: present.length, added, changed, removed, indexCount, indexError, manifest }
}

function readManifest(targetDir) {
  try { return JSON.parse(fs.readFileSync(path.join(targetDir, 'MANIFEST.json'), 'utf8')) } catch { return null }
}

function parseArgs(argv) {
  const o = { mode: 'check', source: null, target: null, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--check' || a === '--dry' || a === '--apply' || a === '--baseline' || a === '--baseline-check') o.mode = a.slice(2)
    else if (a === '--source') o.source = argv[++i]
    else if (a === '--target') o.target = argv[++i]
    else if (a === '--quiet') o.quiet = true
    else if (a === '--help' || a === '-h') { o.mode = 'help' }
    else { console.error(`✗ 未知参数: ${a}`); o.mode = 'help'; o.bad = true }
  }
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.mode === 'help') {
    console.log(`agents-sync.mjs — 人事部角色库 → agents/ 副本同步器（docs/89 §1.3）
用法: node scripts/agents-sync.mjs [--check|--dry|--apply|--baseline|--baseline-check] [--source <根>] [--target <目录>] [--quiet]
  --check          只读漂移报告（源↔副本 md + 索引 1:1 + 基线 vs 活源），不落盘
  --dry            预演 --apply 将做的改动（零写入）
  --apply          同步副本 source/ + 自举 role-index.json + MANIFEST.json + 刷新基线
  --baseline       只写三源基线快照 agents/.source-baseline.json（源零写）
  --baseline-check 只读比对基线 vs 活源（阶段末 S1 复跑；exit 0=全等 1=漂移 2=无基线）
默认源: ~/.gbrain/agent-roles · 目标: <仓库根>/agents
红线: 对源目录只 fs 读零写（--apply 内置 apply 前后源树 hash 全等断言）`)
    return o.bad ? 2 : 0
  }

  const sourceRoot = o.source ? String(o.source).replace(/^~/, HOME) : SRC_ROOTS[0]
  const targetDir = o.target ? String(o.target).replace(/^~/, HOME) : path.join(REPO_ROOT, 'agents')
  if (!fs.existsSync(path.join(sourceRoot, 'source'))) {
    console.error(`✗ 源根缺 source/: ${sourceRoot}`)
    return 2
  }
  const quiet = o.quiet

  if (o.mode === 'baseline') {
    writeBaseline(targetDir)
    log(quiet, `baseline 已写入 ${path.join(targetDir, '.source-baseline.json')}`)
    return 0
  }
  if (o.mode === 'baseline-check') {
    const base = readBaseline(targetDir)
    if (!base) {
      console.error('✗ 无基线文件（agents/.source-baseline.json）——先运行 --apply 或 --baseline')
      return 2
    }
    const drift = compareBaselineLive(base)
    if (!drift.length) { log(quiet, `S1 源零改动断言 ✅ 全等（capturedAt ${base.capturedAt}）`); return 0 }
    console.error(`✗ S1 源漂移 ${drift.length} 项:`)
    for (const d of drift.slice(0, 20)) console.error(`   [${d.kind}] ${path.basename(d.root)}/${d.rel}`)
    if (drift.length > 20) console.error(`   …另 ${drift.length - 20} 项`)
    return 1
  }

  const drift = reportCopyDrift(sourceRoot, targetDir)
  if (o.mode === 'check') {
    const parts = []
    if (drift.added.length) parts.push(`新增 ${drift.added.length}`)
    if (drift.changed.length) parts.push(`变更 ${drift.changed.length}`)
    if (drift.removed.length) parts.push(`删除 ${drift.removed.length}`)
    const indexOk = drift.indexError ? `索引⚠ ${drift.indexError}` : (drift.indexCount === drift.expected ? `索引 1:1（${drift.indexCount}）✅` : `索引漂移（md ${drift.expected} vs 索引 ${drift.indexCount}）⚠`)
    console.log(`[agents-sync --check] 源 md ${drift.expected} · 副本 md ${drift.present} · ${parts.length ? parts.join(' / ') : '无漂移 ✅'} · ${indexOk}`)
    for (const rel of drift.added.slice(0, 5)) console.log(`  + ${rel}`)
    for (const rel of drift.removed.slice(0, 5)) console.log(`  - ${rel}`)
    for (const rel of drift.changed.slice(0, 5)) console.log(`  ~ ${rel}`)
    // 基线 vs 活源（若基线存在）
    const base = readBaseline(targetDir)
    if (base) {
      const bd = compareBaselineLive(base)
      if (bd.length) {
        console.log(`⚠ 基线 vs 活源漂移 ${bd.length} 项（源被外部改动？）`)
        for (const d of bd.slice(0, 10)) console.log(`   [${d.kind}] ${path.basename(d.root)}/${d.rel}`)
      }
    }
    const dirty = drift.added.length + drift.changed.length + drift.removed.length > 0 || !!drift.indexError || drift.indexCount !== drift.expected
    return dirty ? 1 : 0
  }

  // ---- --dry / --apply ----
  const planAdd = drift.added.length, planChg = drift.changed.length, planDel = drift.removed.length
  console.log(`[agents-sync ${o.mode}] 源 ${homeOf(sourceRoot)} → ${targetDir}：新增 ${planAdd} / 变更 ${planChg} / 删除 ${planDel}`)
  if (o.mode === 'dry') {
    if (planAdd + planChg + planDel === 0) console.log('  无改动（幂等）')
    return 0
  }

  // 红线自断言：apply 前源树 hash（只读）
  const preHashes = mdHashMap(sourceRoot)
  if (preHashes.size !== drift.expected) {
    console.error(`✗ 内部不一致：源 md ${preHashes.size} ≠ 清单 ${drift.expected}`)
    return 3
  }

  // ① 复制 + 幂等跳过 + 跟随删除
  const srcDir = path.join(sourceRoot, 'source')
  let copied = 0
  for (const rel of sourceMdList(sourceRoot)) {
    const from = path.join(srcDir, ...rel.split('/'))
    const to = path.join(targetDir, 'source', ...rel.split('/'))
    if (fs.existsSync(to) && sha256(fs.readFileSync(from)) === sha256(fs.readFileSync(to))) continue // sha256 幂等跳过
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    copied += 1
  }
  // 跟随删除（副本有源无 → 删）
  let removed = 0
  const expSet = new Set(sourceMdList(sourceRoot))
  for (const rel of copyMdList(targetDir)) {
    if (expSet.has(rel)) continue
    fs.rmSync(path.join(targetDir, 'source', ...rel.split('/')), { force: true })
    removed += 1
  }
  // 清空目录
  pruneEmptyDirs(path.join(targetDir, 'source'))

  // 红线自断言：apply 后源树 hash 全等（不等 = 本同步器碰了源，立即报错）
  const postHashes = mdHashMap(sourceRoot)
  let breach = false
  if (postHashes.size !== preHashes.size) breach = true
  for (const [rel, h] of preHashes) if (postHashes.get(rel) !== h) { breach = true; break }
  if (breach) {
    console.error('✗✗ 红线自断言失败：apply 前后源 md 树 hash 不等——本同步器疑似写源！立即停手排查')
    return 3
  }

  // ② 副本内自举 role-index.json（读副本 source/ → md 与索引 1:1）
  //    t26：字节相同则不写（既避免 mtime 抖动触发 registry 重载，也让「幂等」在工作树可验证）
  const copyMds = copyMdList(targetDir)
  const entries = copyMds.map((rel) => deriveEntry(rel, fs.readFileSync(path.join(targetDir, 'source', ...rel.split('/')), 'utf8')))
  entries.sort((a, b) => (a.dept === b.dept ? a.file.localeCompare(b.file) : a.dept.localeCompare(b.dept)))
  const indexPath = path.join(targetDir, 'role-index.json')
  const indexText = JSON.stringify(entries, null, 2) + '\n'
  let indexChanged = true
  try { indexChanged = fs.readFileSync(indexPath, 'utf8') !== indexText } catch { indexChanged = true }
  if (entries.length !== copyMds.length) {
    console.error(`✗ 索引自举断言失败：md ${copyMds.length} ≠ 索引 ${entries.length}`)
    return 3
  }
  if (indexChanged) fs.writeFileSync(indexPath, indexText, 'utf8')

  // ③ MANIFEST.json —— 仅在**内容真变更**时写（t26：无变更不刷新 syncedAt，工作树保持干净；
  //    指纹内容 treeSha256/计数/来源全保留，审计与复现性不受影响）
  const relShaMap = mdHashMap(targetDir)
  const manifestPath = path.join(targetDir, 'MANIFEST.json')
  const prevManifest = readManifest(targetDir)
  const fingerprint = {
    source: homeOf(sourceRoot),
    sourceCount: drift.expected,
    copyCount: relShaMap.size,
    roleIndexCount: entries.length,
    treeSha256: treeSha256(relShaMap),
    driftNote: sourceDriftNote(sourceRoot),
  }
  const fingerprintSame = !!prevManifest && MANIFEST_FINGERPRINT_KEYS.every((k) => JSON.stringify(prevManifest[k] ?? null) === JSON.stringify(fingerprint[k] ?? null))
  const contentChanged = copied > 0 || removed > 0 || indexChanged || !fingerprintSame

  if (!contentChanged) {
    const keep = prevManifest?.syncedAt ?? '(未知)'
    console.log(`[agents-sync --apply] ✅ 无内容变更（幂等）：复制 0 · 删除 0 · role-index ${entries.length} 条未改写 · MANIFEST 保持原样（syncedAt ${keep} 未刷新）`)
    console.log('   源零改动自断言 ✅（apply 前后源树 hash 全等）')
    return 0
  }

  const manifest = { syncedAt: new Date().toISOString(), ...fingerprint, copied, removed }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  // ④ 刷新源基线（源仍零写；仅内容有变更时刷新，与 MANIFEST 同步）
  writeBaseline(targetDir)

  console.log(`[agents-sync --apply] ✅ 完成：复制 ${copied} · 删除 ${removed} · role-index ${entries.length} 条（与 md 1:1）· MANIFEST 已写`)
  console.log(`   源零改动自断言 ✅（apply 前后源树 hash 全等）· 基线已刷新（${manifest.syncedAt}）`)
  return 0
}

/** MANIFEST 指纹字段（t26：与易变元数据 syncedAt/copied/removed 分离——指纹相同即内容未变，不写文件）。 */
const MANIFEST_FINGERPRINT_KEYS = ['source', 'sourceCount', 'copyCount', 'roleIndexCount', 'treeSha256', 'driftNote']

function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    pruneEmptyDirs(path.join(dir, e.name))
    try { fs.rmdirSync(path.join(dir, e.name)) } catch { /* 非空保留 */ }
  }
}

/** 源侧已知漂移注记（只读；role-index.json 计数 vs source md 数——N2 现象记录不阻塞）。 */
function sourceDriftNote(sourceRoot) {
  const srcIdx = path.join(sourceRoot, 'data', 'role-index.json')
  let note = null
  if (fs.existsSync(srcIdx)) {
    try {
      const arr = JSON.parse(fs.readFileSync(srcIdx, 'utf8'))
      const n = Array.isArray(arr) ? arr.length : null
      const mds = sourceMdList(sourceRoot).length
      if (n !== null && n !== mds) note = `源侧 data/role-index.json ${n} vs source md ${mds}（N2 已知漂移，副本自举已免疫）`
    } catch { note = '源侧 data/role-index.json 不可解析（N2 记录）' }
  }
  return note
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => { console.error('✗ agents-sync 异常:', e?.message ?? e); process.exitCode = 2 })
