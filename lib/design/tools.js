// 设计部（huahua-design）模型侧工具（设计部集成 · P2）
// 9 个工具，直打设计部 REST API（http://host:port/api/*）——设计部侧零改动。
// 注册口：installDesignTools(ctx, manager, opts)（由 installDesign 在 designEnabled 时调用）。
// 工具命名：design_ 前缀（对齐上游 ramify_* → design_* 的改名映射）。
const ARTIFACT_TYPES = ['html', 'svg', 'image', 'video', 'audio', 'pdf', 'markdown', 'text', 'link', 'iframe']

export function installDesignTools(ctx, manager, opts = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = Number(opts.port) || 9531
  const base = `http://${host}:${port}`

  async function api(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && data.error) ? `${data.error}（${data.code ?? res.status}）` : `HTTP ${res.status}`
      throw new Error(msg)
    }
    return data
  }

  async function ensureRunning() {
    const st = manager.status()
    if (st.state !== 'running') await manager.start()
    if (manager.status().state !== 'running') throw new Error('设计部服务未能启动，请到设计部 Tab 手动启动或检查日志')
  }

  const toolDefs = [
    { name: 'design_start', description: '启动/连接设计部画布服务（幂等）。其它 design_* 工具会自动确保服务在跑，一般无需手动调用。',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const before = manager.status()
        await ensureRunning()
        const st = manager.status()
        return { ready: true, reused: before.state === 'running', url: st.url, port: st.port, pid: st.pid, owned: st.owned }
      } },
    { name: 'design_project_create', description: '新建设计部项目：根据 prompt 生成根节点 + count（1-5）个分支占位节点（「方案 N（生成中）」）。返回 { id, rootId, nodeIds }。',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: '创意描述（必填）' }, count: { type: 'number', description: '分支方案数（1-5，默认 3）' }, title: { type: 'string', description: '项目名（可选）' } }, required: ['prompt'] },
      async execute(args) {
        await ensureRunning()
        const body = { prompt: String(args.prompt ?? '').trim() }
        if (!body.prompt) throw new Error('prompt 必填')
        if (args.count !== undefined) body.count = Number(args.count)
        if (args.title) body.title = String(args.title)
        return api('POST', '/api/projects', body)
      } },
    { name: 'design_project_list', description: '列出设计部全部项目（id/标题/节点数/时间）。',
      inputSchema: { type: 'object', properties: {} },
      async execute() { await ensureRunning(); return api('GET', '/api/projects') } },
    { name: 'design_project_tree', description: '读一个项目的整棵节点树（id/父子/标题/类型/产物修订）。改节点前先读树拿 nodeId。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
      async execute(args) { await ensureRunning(); return api('GET', `/api/projects/${encodeURIComponent(args.projectId)}/tree`) } },
    { name: 'design_node_add', description: '在父节点下新增子节点。可带 artifact+artifactType 直接产出内容，或 content 填纯文本（两者互斥）。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, parentId: { type: 'string', description: '父节点 id' }, title: { type: 'string', description: '节点标题' }, artifactType: { type: 'string', description: 'html/svg/markdown/text 等' }, artifact: { type: 'string', description: '产物源码' }, content: { type: 'string', description: '纯文本内容' } }, required: ['projectId', 'parentId', 'title'] },
      async execute(args) {
        await ensureRunning()
        const body = { title: String(args.title ?? '').trim() }
        if (!body.title) throw new Error('title 必填')
        if (args.artifactType !== undefined) body.artifactType = args.artifactType
        if (args.artifact !== undefined) body.artifact = args.artifact
        if (args.content !== undefined) body.content = args.content
        return api('POST', `/api/projects/${encodeURIComponent(args.projectId)}/nodes`, body)
      } },
    { name: 'design_node_batch', description: '批量创建节点（≤100），nodes[].key 同批互引（后续节点 parentId 可引用同批 key）。一次性铺多级结构时用。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, nodes: { type: 'array', description: '{ key, parentId, title, artifactType?, artifact? } 数组；parentId 可填根节点 id 或同批 key' } }, required: ['projectId', 'nodes'] },
      async execute(args) {
        await ensureRunning()
        if (!Array.isArray(args.nodes) || args.nodes.length === 0) throw new Error('nodes 必须是非空数组')
        return api('POST', `/api/projects/${encodeURIComponent(args.projectId)}/nodes/batch`, { nodes: args.nodes })
      } },
    { name: 'design_node_update', description: '更新节点：改标题 / 改纯文本正文（content，节点变 text 类型）/ 移动父节点（根节点不可移动）。',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, parentId: { type: 'string' } }, required: ['nodeId'] },
      async execute(args) {
        await ensureRunning()
        const body = {}
        if (args.title !== undefined) body.title = args.title
        if (args.content !== undefined) body.content = args.content
        if (args.parentId !== undefined) body.parentId = args.parentId
        return api('PUT', `/api/nodes/${encodeURIComponent(args.nodeId)}`, body)
      } },
    { name: 'design_node_complete', description: '填充/替换节点产物（核心工具）：把「方案 N（生成中）」占位节点变成真实内容。html 传完整 HTML 文档；expectedUpdatedAt 乐观锁（409 冲突时重读树再试）。',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, artifactType: { type: 'string', description: 'html/svg/markdown/text 等' }, artifact: { type: 'string', description: '产物源码（html 传完整文档）' }, expectedUpdatedAt: { type: 'string', description: '树里读到的 updated_at（可选）' } }, required: ['nodeId', 'artifactType', 'artifact'] },
      async execute(args) {
        await ensureRunning()
        if (!ARTIFACT_TYPES.includes(args.artifactType)) throw new Error('artifactType 必须是：' + ARTIFACT_TYPES.join(' / '))
        const body = { artifactType: args.artifactType, artifact: String(args.artifact ?? '') }
        if (args.expectedUpdatedAt) body.expectedUpdatedAt = args.expectedUpdatedAt
        return api('PUT', `/api/nodes/${encodeURIComponent(args.nodeId)}/artifact`, body)
      } },
    { name: 'design_settings', description: '读/改设计部界面设置（theme: light/dark/system；locale: zh-CN/en/ja/es/de）。不传参=只读。',
      inputSchema: { type: 'object', properties: { theme: { type: 'string' }, locale: { type: 'string' } } },
      async execute(args) {
        await ensureRunning()
        if (args.theme !== undefined) return api('PUT', '/api/settings/theme', { theme: args.theme })
        if (args.locale !== undefined) return api('PUT', '/api/settings/locale', { locale: args.locale })
        return api('GET', '/api/settings')
      } },
  ]

  // DSH 新版工具协议：必须声明 output { schema, render }（实测缺失即 TypeError 拒注）。
  // 设计部各工具返回结构不一（项目对象/树/节点/布尔包装），统一用宽松 schema + JSON 文本渲染。
  // 设计部各工具返回结构不一：对象（项目/树）、数组（list）、标量（ok:true）。
  // output.schema 若写死 type:'object'，数组返回值会被宿主判为「invalid output」（实测）。
  // 用 anyOf 覆盖三种形态。
  const looseOutput = {
    schema: {
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'array' },
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
      ],
    },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 1),
    }],
  }

  const disposers = []
  for (const def of toolDefs) {
    const dispose = ctx.tools.register({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      output: def.output ?? looseOutput,
      async execute(args) {
        try {
          return await def.execute(args ?? {})
        } catch (error) {
          return { ok: false, error: String(error instanceof Error ? error.message : error) }
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  return () => { for (const d of disposers.splice(0)) { try { d() } catch { /* 幂等 */ } } }
}
