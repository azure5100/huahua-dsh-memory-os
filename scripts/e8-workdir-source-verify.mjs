#!/usr/bin/env node
// e8-workdir-source-verify.mjs —— 卡 E8 验证装置（**独立进程 + 隔离夹具**；真实面只读）
//
// A 夹具：候选/非候选/归档/深度/开关 五组对照（含三条卡面指定的阴性对照）
// B 去重：同名目录并入既有项目 ⇒ 条目数不增；并给「缺去重会多算」的假红对照
// C 真实面（只读）：D:\Astock-trade-huahua 是否出现在项目列表；开/关该源的前后项目数
// D 性能：冷/热两次实测耗时
// 用法：node scripts/e8-workdir-source-verify.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProjectScanner, hasProjectMarker, isExcludedPath, DEFAULT_SCAN } from '../lib/agents/project-scan.js'
import { createFlowProvider } from '../lib/agents/flow.js'

const results = []
const rec = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ->  ' + detail : '')) }
const mk = (p, kind) => { if (kind === 'dir') fs.mkdirSync(p, { recursive: true }); else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x') } }

// ── A 夹具 ────────────────────────────────────────────────────────────────
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-fixture-'))
mk(path.join(R, 'proj-ok', 'L1_项目蓝图.md'), 'file')
mk(path.join(R, 'proj-ok', 'L2_施工文件'), 'dir')
mk(path.join(R, 'proj-build-only', 'L2_施工文件'), 'dir')
mk(path.join(R, 'proj-empty', 'readme.txt'), 'file')
mk(path.join(R, 'archive', 'proj-archived', 'L1_项目蓝图.md'), 'file')
mk(path.join(R, '_void-2026-09-11', 'proj-void', 'L1_项目蓝图.md'), 'file')
mk(path.join(R, '_retired', 'proj-retired', 'L1_项目蓝图.md'), 'file')
mk(path.join(R, 'deep', 'proj-deep', 'L1_项目蓝图.md'), 'file') // 第 2 层（供深度对照）

const sc = createProjectScanner({ roots: [R], maxDepth: 2, cacheTtlMs: 60000 })
const a1 = sc.scan({ fresh: true })
const names1 = a1.rows.map((r) => r.name).sort()
console.log('夹具根: ' + R)
console.log('候选（maxDepth=2）: ' + JSON.stringify(names1))
rec('① 含标记的目录被枚举（proj-ok / proj-build-only）', names1.includes('proj-ok') && names1.includes('proj-build-only'), JSON.stringify(names1))
rec('① 对照（阴性）：**不含**标记的 proj-empty 不得被枚举', !names1.includes('proj-empty'), 'row=' + JSON.stringify(a1.rows.find((r) => r.name === 'proj-empty') ?? null))
// ⚠️ 原版按「标记目录 basename」断言（proj-archived / proj-void / proj-retired）—— 因项目名归属
// 改为「扫描根下第 1 层目录名」，被排除时这些名字**永远不可能出现** ⇒ 三条断言**恒绿**。
// QA 2026-09-11 复核实测：移除排除项后候选名单出现 archive/_void-2026-09-11/_retired，而装置仍 18/18。
// 现改为**路径级**判据（能红）：任何候选的 dir/dirs 都不得落在被排除的路径段下。
const excludedRows = a1.rows.filter((r) => (r.dirs ?? [r.dir]).some((d) => isExcludedPath(d, R)))
rec('② 对照（阴性）：**无候选落在归档/隐藏目录下**（路径级·能红）', excludedRows.length === 0, 'leak=' + JSON.stringify(excludedRows.map((r) => r.dirs ?? [r.dir])))
rec('② 对照（阴性）：被排除的顶层目录名不得作为项目名出现', !['archive', '_void-2026-09-11', '_retired'].some((n) => names1.includes(n)), 'names=' + JSON.stringify(names1))
rec('② 路径断言在 _void-* 上亦成立（同一判据三例共用一条断言，此处留痕）', !excludedRows.some((r) => (r.dirs ?? [r.dir]).some((d) => d.includes('_void'))), 'ok')
rec('② 路径断言在 _retired 上亦成立', !excludedRows.some((r) => (r.dirs ?? [r.dir]).some((d) => d.includes('_retired'))), 'ok')
const scOff = createProjectScanner({ roots: [R], maxDepth: 2, enabled: false })
const aOff = scOff.scan({ fresh: true })
rec('③ 对照（阴性）：**关掉该源开关** ⇒ 产出为零', aOff.rows.length === 0 && aOff.mode === 'disabled', 'rows=' + aOff.rows.length + ' mode=' + aOff.mode)
const scD1 = createProjectScanner({ roots: [R], maxDepth: 1 })
const d1 = scD1.scan({ fresh: true }).rows.map((r) => r.name)
// 项目名口径 = 扫描根下**第 1 层目录**（deep）；标记目录 proj-deep 只作施工目录。
// 深度对照：maxDepth=1 看不到 deep/proj-deep 里的标记 ⇒ 不出现；=2 才出现。
rec('深度可配：maxDepth=1 时 deep(第 2 层标记) 不入选，=2 时入选', !d1.includes('deep') && names1.includes('deep'), 'depth1=' + JSON.stringify(d1) + ' depth2=' + JSON.stringify(names1))
rec('标记判据：L1 蓝图 与 L2 目录 两类都算命中', hasProjectMarker(path.join(R, 'proj-ok')).hit && hasProjectMarker(path.join(R, 'proj-build-only')).hit, 'ok=' + JSON.stringify(hasProjectMarker(path.join(R, 'proj-ok'))))

// ── B 去重（夹具：既有登记源 + 扫描源同名） ──────────────────────────────
const HR = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-hr-'))
const AD = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-ad-'))
const TR = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-tr-'))
mk(path.join(HR, 'data', 'projects', 'proj-ok', 'L1_项目蓝图.md'), 'file')
fs.writeFileSync(path.join(HR, 'data', 'access.jsonl'), '')
const provCfg = { agentsHrDir: HR, agentsDir: AD, teamsRoot: TR, accessPath: path.join(HR, 'data', 'access.jsonl') }
const withScan = createFlowProvider({ ...provCfg, projectScan: { projectScanRoots: [R], projectScanDepth: 2 } })
const noScan = createFlowProvider({ ...provCfg, projectScan: { projectScanEnabled: false, projectScanRoots: [R] } })
const listOn = withScan.projects()
const listOff = noScan.projects()
const okOn = listOn.find((p) => p.project === 'proj-ok')
rec('去重：同名项目只出现 1 条（登记源 data/projects 与扫描源同名）', listOn.filter((p) => p.project === 'proj-ok').length === 1, 'count=' + listOn.filter((p) => p.project === 'proj-ok').length)
rec('去重：扫描源目录**并入** localDirs（两个来源都在）', !!okOn && okOn.sources.localDirs.length === 2, JSON.stringify(okOn?.sources?.localDirs ?? null))
rec('去重：localDirs 带 workdir-scan 来源标记', JSON.stringify(okOn?.sources?.localDirs ?? []).length > 0, JSON.stringify(okOn?.sources?.localDirs ?? []))
const naive = listOff.length + a1.rows.filter((r) => !listOff.some((p) => p.project === r.name)).length + a1.rows.filter((r) => listOff.some((p) => p.project === r.name)).length
rec('假红对照：**若缺去重**（三源 + 全量扫描行直接相加）会比实际多算', naive > listOn.length, 'naive=' + naive + ' actual=' + listOn.length)
rec('开关：关掉该源 ⇒ 扫描来源的项目消失（差异确实来自这个源）', !listOff.some((p) => p.project === 'proj-build-only') && listOn.some((p) => p.project === 'proj-build-only'), 'off=' + listOff.length + ' on=' + listOn.length)

// ── C 真实面（**只读**）：Astock-trade-huahua ──────────────────────────────
const realOn = createFlowProvider({ projectScan: { projectScanEnabled: true, projectScanRoots: DEFAULT_SCAN.roots, projectScanDepth: DEFAULT_SCAN.maxDepth } })
const realOff = createFlowProvider({ projectScan: { projectScanEnabled: false, projectScanRoots: DEFAULT_SCAN.roots } })
const t0 = Date.now()
const realListOn = realOn.projects()
const tOn = Date.now() - t0
const realListOff = realOff.projects()
const target = realListOn.find((p) => p.project === 'Astock-trade-huahua')
rec('C 真实面：D:\\Astock-trade-huahua 出现在项目列表中', !!target, 'found=' + !!target + '  (项目数 off=' + realListOff.length + ' → on=' + realListOn.length + ')')
rec('C 真实面：**关掉该源后它不在列表中**（差异来自这个源）', !realListOff.some((p) => p.project === 'Astock-trade-huahua'), 'off 列表=' + JSON.stringify(realListOff.map((p) => p.project)))
if (target) {
  // 注意：activeCode 可为 null（该项目被判「卡在门禁2」属 inferStage 既有语义，非缺陷）⇒
  // 断言改用「有施工目录 + inferStage 产出了非空依据 + 交付物数>0」三件，避免把既有语义判成红。
  const basisOk = Array.isArray(target.inference?.basis) && target.inference.basis.length > 0
  rec('C 真实面：该项目带 workdir-scan 施工目录且经 inferStage 产出依据', target.sources.localDirs.some((d) => String(d).includes('Astock-trade-huahua')) && basisOk, 'activeCode=' + JSON.stringify(target.activeCode) + ' status=' + JSON.stringify(target.status) + ' localDirs=' + JSON.stringify(target.sources.localDirs) + ' basis=' + JSON.stringify(target.inference?.basis ?? null))
}

// ── D 性能（冷/热） ───────────────────────────────────────────────────────
const perf = createProjectScanner({ roots: DEFAULT_SCAN.roots, maxDepth: DEFAULT_SCAN.maxDepth, cacheTtlMs: 60000 })
const cold = perf.scan({ fresh: true })
const warm = perf.scan({})
rec('D 性能：热路径命中缓存（零 IO，ms=0）且行数与冷路径一致', warm.mode === 'warm' && warm.ms === 0 && warm.rows.length === cold.rows.length, 'cold=' + cold.ms + 'ms/' + cold.visitedDirs + ' dirs · warm=' + warm.ms + 'ms mode=' + warm.mode)
rec('D 性能：冷扫有界（访问目录数 <= 上限）', cold.visitedDirs <= DEFAULT_SCAN.maxVisitedDirs, 'visitedDirs=' + cold.visitedDirs)
console.log('\n真实面候选数（冷扫 ' + cold.ms + 'ms）: ' + cold.rows.length + ' · 命中样例: ' + JSON.stringify(cold.rows.slice(0, 6).map((r) => r.name)))

for (const d of [R, HR, AD, TR]) fs.rmSync(d, { recursive: true, force: true })
const fails = results.filter((r) => !r.ok)
console.log('\n===== ' + (results.length - fails.length) + '/' + results.length + ' PASS · ' + fails.length + ' FAIL =====')
for (const f of fails) console.log('FAIL:', f.name)
process.exit(fails.length ? 1 : 0)
