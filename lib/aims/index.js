// AIMS 集成功能域装配（AIMS 集成 node 侧 · t60 + 动态闭环 t68）
// installAims(ctx, config, { getRuntime })：AIMS UI 服务生命周期托管 + 服务控制路由 +
// 动态闭环观察域（observe：T0/T1/收尾 register）+ 每日调度域（daily：aimsDailySyncTime 增量导入；默认 22:00，t29 修订）。
// 纪律：AIMS 侧（库/UI/CLI/MCP）零改动——本域只 spawn/托管/探活 server.mjs + 观察事件 +
//       spawn AIMS 幂等 CLI；不直读 aims-index.db、不复制查询层（docs/62 §二 数据面边界）。
//       动态闭环全由 aimsDailySyncEnabled 门控（默认关，docs/67 §五）。
import path from 'node:path'
import { defaultAimsRepo } from '../agents/platform-paths.js' // E160：外部 AIMS 仓根唯一 home（**补漏 import** —— 本次红即此）
import { createAimsManager } from './manager.js'
import { installAimsRoutes } from './routes.js'
import { installObserve } from './observe.js'
import { installDaily } from './daily.js'
import { createTeamDiscover } from './team-discover.js'
import { createAgentsDomain } from '../agents/index.js'

export { AIMS_API_BASE } from './routes.js'

/**
 * 安装 AIMS 集成域。
 * @param {object} ctx - cordis ctx（webServer 经 ctx.inject 解析；on/effect 事件总线）
 * @param {object} config - 插件 resolved config（含 aimsRepo/aimsPort/aimsHost/aimsAutoStart）
 * @param {{ getRuntime?: () => object }} [opts] - 运行时配置读取（t68：aimsDailySyncEnabled 等）
 * @returns {{ dispose: () => void, status: () => object, manager: object }}
 */
export function installAims(ctx, config, opts = {}) {
  const aimsRepo = config.aimsRepo ?? defaultAimsRepo()   // E160：平台中立（原为硬编码 D:\…；现机解析值同为 D:\… ⇒ 不破现机）
  const host = config.aimsHost ?? '127.0.0.1'
  const port = Number(config.aimsPort) || 8710
  const autoStart = config.aimsAutoStart === true
  const getRuntime = opts.getRuntime ?? (() => config)

  const manager = createAimsManager({
    serverPath: path.join(aimsRepo, 'ui', 'server.mjs'),
    host,
    port,
    logFile: path.join(aimsRepo, 'data', 'logs', 'aims-service.log'),
    pidFile: path.join(aimsRepo, 'data', 'aims-service.pid'),
    // 子进程沿用宿主 env（AIMS_DB/AIMS_HOME 可经此覆盖，默认直读 ~/.dsh/aims）
    spawnEnv: {},
  })

  // HTTP 控制路由（web-only，inject webServer——对齐 canvas 挂载模式）
  const disposeRoutes = installAimsRoutes(ctx, manager)

  // t68 动态闭环：观察域（settled/disposed → T0/T1 activation + 收尾 register spawn）
  // t72 团队沉淀：teamDiscover（.agent-teams/*/team.json）注入 observe——aimsTeamAutoRegister 门控
  // t9 人事部专家：agentsDomain（registry=读副本 agents/ · trace=读源 access.jsonl）注入 observe——
  //     expert 分支由 agentsEnabled 门控（默认关；AIMS 侧零改动，docs/89 §3.2）
  const teamDiscover = createTeamDiscover({ teamsRoot: config.aimsTeamsRoot })
  const agentsDomain = createAgentsDomain(config, { getRuntime })
  const aimsRuntime = { getRuntime, aimsRepo, teams: teamDiscover, registry: agentsDomain.registry, trace: agentsDomain.trace }
  const daily = installDaily(ctx, aimsRuntime)
  // 首回合 guard：observe 首个主会话 completed 回合触发 runOnceIfDue（当天未跑且已过窗 → 补跑）
  const observe = installObserve(ctx, aimsRuntime, {
    onFirstSettled: () => { daily.runOnceIfDue().catch(() => {}) },
  })

  // 轮询探活（5s）：状态灯/外部进程退出后自动反映 stopped
  const pollTimer = setInterval(() => {
    manager.refresh().catch(() => {})
  }, 5000)
  if (typeof pollTimer.unref === 'function') pollTimer.unref()
  // 每日 15min tick（unref；到 aimsDailySyncTime 窗（默认 22:00，t29 修订）且当日未跑才执行任务链）
  // 同 tick 兼做 **L3 零触发监听告警**：那类"注册了却从未响应"的死监听（历史案例留痕 docs/rules.md:80），只能靠
  // "注册后是否 fire 过"这条信号暴露；阈值 10 分钟（更短的进程不足以判定），每个事件名只告警一次。
  const dailyTick = setInterval(() => {
    daily.tick().catch(() => {})
    try { observe.eventHealth?.checkNeverFired?.({ afterMs: 10 * 60 * 1000 }) } catch { /* 告警失败不影响主流程 */ }
  }, 15 * 60 * 1000)
  if (typeof dailyTick.unref === 'function') dailyTick.unref()

  const disposers = [disposeRoutes, () => observe.dispose(), () => daily.dispose(), () => clearInterval(dailyTick)]
  const dispose = () => {
    for (const fn of disposers.splice(0)) { try { fn() } catch { /* 幂等 */ } }
    clearInterval(pollTimer)
    manager.dispose() // 只停自己 spawn 的子进程（owned 语义）
  }
  // 插件生命周期兜底（cordis 卸载/重载走 ctx.effect disposer）
  ctx.effect(() => dispose, 'dsh-memory-evolve: aims service manager')

  // autoStart（config.aimsAutoStart）：开启即托管（异步起服不阻塞 apply）
  if (autoStart) {
    manager.start().catch(() => {})
  }

  return {
    dispose,
    status: () => ({ ...manager.status(), observe: observe.status(), daily: daily.status() }),
    manager,
    _test: { observe, daily }, // 冒烟出口
  }
}
