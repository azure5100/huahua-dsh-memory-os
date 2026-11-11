#!/usr/bin/env node
// HOS 发版自检门禁（1.6.7 起随包提供）
// 用法：npm run verify  （内部已带 --experimental-vm-modules）
// 判据：① lib 全量 ESM 语法编译 0 错 ② 整包 import 冒烟成功 ③ 数据目录不在包内（仅告警）
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");
let failed = false;

// ① 语法编译
const bad = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!entry.endsWith(".js")) continue;
    try { new vm.SourceTextModule(readFileSync(p, "utf8"), { identifier: p }); }
    catch (e) { bad.push(p.slice(ROOT.length + 1) + " :: " + String(e.message).slice(0, 120)); }
  }
};
walk(LIB);
if (bad.length) { failed = true; console.error("[verify] 语法错误 " + bad.length + " 个"); for (const b of bad) console.error("  " + b); }
else console.log("[verify] 语法编译 OK（lib/**/*.js 全部通过）");

// ② import 冒烟
try {
  await import(pathToFileURL(join(LIB, "index.js")).href);
  console.log("[verify] import 冒烟 OK（lib/index.js 可加载）");
} catch (e) { failed = true; console.error("[verify] import 失败：" + String(e.message).slice(0, 300)); }

// ②b 配置键自检（2026-11-11 教训：加了 config 但插件不认识 ⇒ apply 抛错 ⇒ 整插件不加载）
try {
  const mod = await import(pathToFileURL(join(LIB, 'index.js')).href);
  const probeCfg = { designDataDir: 'D:/DSH/dsh-home/design-data' };
  mod.resolveConfig(probeCfg);
  console.log('[verify] 配置键自检 OK（designDataDir 被 resolveConfig 接受）');
} catch (e) { failed = true; console.error('[verify] 配置键自检失败：' + String(e.message).slice(0, 200)); }

// ③ 数据目录位置（只看不拦）
const envDir = process.env.HUAHUA_DESIGN_DATA_DIR;
const pkgData = join(ROOT, "vendor", "huahua-design", "data");
if (!envDir) console.warn("[verify] 警告：未设置 HUAHUA_DESIGN_DATA_DIR，设计部数据将落在包内 " + pkgData + "（重装可能丢数据）");
else console.log("[verify] 数据目录 OK：" + envDir);

process.exit(failed ? 1 : 0);