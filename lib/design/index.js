// 设计部（huahua-design）集成功能域装配（设计部集成 · node 侧）
// installDesign(ctx, config, { getRuntime })：设计部画布服务生命周期托管 +
// 服务控制路由 + 数据目录纳管。
// 纪律：设计部侧（app/、lib/、tests/）零改动——本域只 spawn/托管/探活 server.mjs，
//       不直读 design.db、不复制查询层。
// 对照：本文件结构与 lib/aims/index.js 同构（AIMS 是 HOS 托管外部服务的标准样板）。
import path from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDesignManager } from './manager.js'
import { installDesignRoutes } from './routes.js'
import { installDesignTools } from './tools.js'

export { DESIGN_API_BASE } from './routes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 解析设计部 vendor 根（<HOS>/vendor/huahua-design）。
 * 本文件位于 <HOS>/lib/design/index.js ⇒ 上溯两级到 <HOS>，再进 vendor。
 */
export function defaultDesignRoot() {
  return path.resolve(HERE, '..', '..', 'vendor', 'huahua-design')
}

/**
 * 安装设计部集成域。
 * @param {object} ctx - cordis ctx（webServer 经 ctx.inject 解析）
 * @param {object} config - 插件 resolved config（含 designRepo/designPort/designHost/designAutoStart/designDataDir）
 * @param {{ getRuntime?: () => object }} [opts] - 运行时配置读取
 * @returns {{ dispose: () => void, status: () => object, manager: object }}
 */
export function installDesign(ctx, config, opts = {}) {
  // INC-2026-10-25-02 探针：证明 installDesign 是否被调用
  try {
    mkdirSync('D:\\DSH\\design-probe', { recursive: true });
    appendFileSync('D:\\DSH\\design-probe\\install-probe.log', new Date().toISOString() + ' CALLED cwd=' + process.cwd() + '\n');
  } catch (e) { console.warn('[design-probe] write fail:', String(e)) }
  const designRepo = config.designRepo ?? defaultDesignRoot()
  const host = config.designHost ?? '127.0.0.1'
  const port = Number(config.designPort) || 9531
  const autoStart = config.designAutoStart === true
  const getRuntime = opts.getRuntime ?? (() => config)

  const appDir = path.join(designRepo, 'app')
  const serverPath = path.join(appDir, 'dist', 'server.mjs')
  // 数据纳管：默认落在设计部 vendor 下的 data/（随 HOS 一起备份/复制即可迁移）
  const dataDir = config.designDataDir ?? path.join(designRepo, 'data')

  const manager = createDesignManager({
    serverPath,
    appDir,
    dataDir,
    host,
    port,
    version: config.designVersion ?? '0.1.0',
    logFile: path.join(designRepo, 'data', 'logs', 'design-service.log'),
    pidFile: path.join(designRepo, 'data', 'design-service.pid'),
    spawnEnv: {},
  })

  // HTTP 控制路由（web-only，inject webServer——对齐 aims/canvas 挂载模式）
  const disposeRoutes = installDesignRoutes(ctx, manager)

  // 模型侧工具（P2）：design_* 9 个，直打 REST API。
  // ⚠️ 必须用 ctx.effect 惰性注册（与 HOS 主流程 ctx.effect(() => ctx.tools.register(...)) 同款）：
  //    装配点同步调 ctx.tools.register 会因服务注入时序失败（实测：apply 时 ctx.tools
  //    尚不可用 → 新会话工具列表里没有 design_*，而 HOS 原生工具有）。effect 回调在
  //    tools 服务就绪后执行；disposer 由 cordis 统一管理。
  let disposeTools = () => {}
  try {
    // 诊断落盘（INC-2026-10-25-02）：effect 是否执行/是否抛错，写文件取证
    const diagFile = path.join(designRepo, 'data', 'logs', 'tools-diag.log')
    const diag = (line) => { try { mkdirSync(path.dirname(diagFile), { recursive: true }); appendFileSync(diagFile, new Date().toISOString() + ' ' + line + '\n') } catch {} }
    diag('effect registered; ctx.tools=' + typeof ctx.tools + ' register=' + typeof ctx.tools?.register)
    disposeTools = ctx.effect(() => {
      try {
        diag('effect FIRED; registering 9 tools; ctx.tools=' + typeof ctx.tools)
        const d = installDesignTools(ctx, manager, { host, port })
        diag('register OK; ' + typeof d)
        return d
      } catch (toolsError) {
        diag('register FAILED: ' + String(toolsError))
        return () => {}
      }
    }, 'dsh-memory-evolve: design model tools')
    diag('ctx.effect returned: ' + typeof disposeTools)
  } catch (effectError) {
    diag('effect SETUP FAILED: ' + String(effectError))
  }

  // 轮询探活（5s）：状态灯 / 外部进程退出后自动反映 stopped
  const pollTimer = setInterval(() => {
    manager.refresh().catch(() => {})
  }, 5000)
  if (typeof pollTimer.unref === 'function') pollTimer.unref()

  const dispose = () => {
    try { disposeRoutes() } catch { /* 幂等 */ }
    try { disposeTools() } catch { /* 幂等 */ }
    clearInterval(pollTimer)
    manager.dispose() // 只停自己 spawn 的子进程（owned 语义）
  }
  // 插件生命周期兜底（cordis 卸载/重载走 ctx.effect disposer）
  ctx.effect(() => dispose, 'dsh-memory-evolve: design service manager')

  // autoStart（config.designAutoStart）：开启即托管（异步起服不阻塞 apply）
  if (autoStart) {
    manager.start().catch(() => {})
  }

  return {
    dispose,
    status: () => manager.status(),
    manager,
  }
}
