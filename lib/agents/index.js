// huahua-os · 人事部融合 阶段 1A：lib/agents 能力域装配（docs/89 §7.1 + docs/81 §3.1）
// 职责：组装核心只读模块（registry=读副本 agents/ · trace=读源 access.jsonl）供调用侧使用
//       （observe expert 分支 / 未来 dispatch / routes 依赖注入）。本文件**不挂 HTTP 路由**——
//       端点族由 lib/agents/routes.js（阶段 1B，t10）挂载；lib/index.js 的 agentsEnabled
//       总门控经 agentsCtrl.sync 调 installAgentsRoutes（docs/73 §四：lib/index.js 共享热点
//       由 t10 独占，本域不重复接线）。
// 红线：本域对源三目录只 fs 读零写（QA S2）；trace 永不 append（QA S3）。
import { createRegistry, defaultAgentsDir, resolveAgentsDir, parseFrontmatter, deriveEntry, normalizeRoleKey } from './registry.js'
import { createTrace, resolveAccessPath, expertRoleKeyOf, normalizeSessionId } from './trace.js'
import { createDispatcher } from './dispatch.js'
import { createSyncManager, getSyncManager, treeSignature } from './sync.js'

export { createRegistry, defaultAgentsDir, resolveAgentsDir, parseFrontmatter, deriveEntry, normalizeRoleKey }
export { createTrace, resolveAccessPath, expertRoleKeyOf, normalizeSessionId }
export { createDispatcher }
export { createSyncManager, getSyncManager, treeSignature }

/**
 * 纯工厂：组装 registry + trace + dispatcher（无 ctx 依赖，routes/测试可注入 fake 替代）。
 * @param {object} [config] 解析后配置（agentsDir/agentsHrDir/agentsAccessPath；null → 默认）
 * @param {{ getRuntime?: () => object }} [opts] 运行时读取（可空——config 已含路径键时无需）
 * @returns {{ registry: object, trace: object, dispatcher: object, status: () => object, dispose: () => void }}
 */
export function createAgentsDomain(config = {}, opts = {}) {
  const cfg = config ?? {}
  const getRuntime = opts.getRuntime ?? (() => cfg)
  const rt = { agentsDir: null, agentsHrDir: null, agentsAccessPath: null }
  // runtime 覆盖优先（与 routes.js cfgOf pick 同序：runtime → config → 默认）
  for (const k of ['agentsDir', 'agentsHrDir', 'agentsAccessPath']) {
    const v = (getRuntime() ?? {})[k] ?? cfg[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') rt[k] = v
  }
  const registry = createRegistry({ agentsDir: rt.agentsDir ?? defaultAgentsDir() })
  const trace = createTrace({ accessPath: resolveAccessPath(rt) })
  const dispatcher = createDispatcher({ registry })

  return {
    registry,
    trace,
    dispatcher,
    status: () => ({ agentsDir: registry.agentsDir, registry: registry.health(), trace: trace.health() }),
    dispose: () => {}, // 纯只读域无注册资源；未来扩展（调度/写面）在此挂 disposer
  }
}

/**
 * 插件侧安装入口（t9 骨架语义）：组装 domain 并挂 ctx 生命周期 disposer。
 * 注意：本版不挂任何事件/路由（避免与 t10 routes.js 双挂）；installAgents 供
 * 需要「agentsEnabled 门控内的域句柄」的调用侧（如 observe）复用 createAgentsDomain。
 * @param {object} ctx cordis ctx（本次仅用于生命周期 effect 兜底）
 * @param {object} [config]
 * @param {{ getRuntime?: () => object }} [opts]
 * @returns {{ dispose: () => void, registry: object, trace: object, dispatcher: object, status: () => object }}
 */
export function installAgents(ctx, config = {}, opts = {}) {
  const domain = createAgentsDomain(config, opts)
  const cfg = config ?? {}
  const getRuntime = opts.getRuntime ?? (() => cfg)
  // t22 副本自动同步：单例管理器（与 routes 复用同一实例）；agentsAutoSync 默认开，仅漂移时同步副本
  const syncMgr = getSyncManager({ ...cfg, agentsHrDir: cfg.agentsHrDir }, { logger: opts.logger })
  const wantAuto = ((getRuntime() ?? {}).agentsAutoSync ?? cfg.agentsAutoSync) !== false
  syncMgr.setAutoSync(wantAuto)
  if (wantAuto) syncMgr.start()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    syncMgr.stop() // 停 timer（副本数据保留；手动同步端点随路由卸载不可用）
    domain.dispose()
  }
  try {
    ctx.effect?.(() => dispose, 'dsh-memory-evolve: agents domain (registry/trace/dispatch/sync)')
  } catch { /* 非 cordis ctx（测试直调）→ dispose 由调用方管理 */ }
  return { dispose, registry: domain.registry, trace: domain.trace, dispatcher: domain.dispatcher, sync: syncMgr, status: domain.status }
}
