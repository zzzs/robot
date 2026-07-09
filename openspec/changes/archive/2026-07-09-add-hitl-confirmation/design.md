## Context

当前 `LangGraphOrchestrator` 的 graph 流程:
```
START → agent → (有 tool_calls?) → tools → agent → ... → END
```
用户发一条消息,agent 一路跑到底,结果通过 SSE 流式返回。没有"暂停等确认"的能力。

LangGraph 的 HITL 通过 `MemorySaver`(checkpoint 持久化)+ `interrupt`(节点暂停)实现:
1. Graph 在指定节点暂停,状态存入 MemorySaver
2. 前端收到 interrupt 事件,显示确认 UI
3. 用户确认后,后端从 MemorySaver 恢复状态,继续执行

**现有基础设施:**
- `@langchain/langgraph@1.4.7` — 内置 `MemorySaver` + `interrupt` + `getState` / `updateState`
- `ChatStreamEvent` envelope — 可扩展新事件类型
- `ChatHistoryService` — 按 sessionId 管理对话历史

## Goals / Non-Goals

**Goals:**
- 集成 MemorySaver 到 LangGraphOrchestrator(状态持久化)
- 在 stock analysis 结果展示前暂停,要求用户确认"了解风险"
- 前端渲染确认对话框;用户确认后无缝恢复
- 用 `thread_id` = sessionId 做 checkpoint 标识
- 保持非 stock 类问题(闲聊、新闻)不触发 interrupt(只有高风险操作才暂停)

**Non-Goals:**
- **不做持久化 DB checkpoint** — MemorySaver 是内存的,重启后丢。生产用 SqliteSaver/PostgresSaver
- **不做 time travel** — 不支持回退到历史 checkpoint
- **不改 manual / supervisor orchestrator** — HITL 是 LangGraph 专有能力
- **不做 interrupt_before / interrupt_after 的通用框架** — 只做一个"风险确认"场景
- **不阻断新闻检索** — search_news 不触发 interrupt(只有 analyze_stock 触发)

## Decisions

### D1. 用 `interrupt()` 函数式 API(不用 interrupt_before)

LangGraph 有两种 HITL 模式:

| 方式 | 用法 | 适合 |
|---|---|---|
| `interrupt_before: ['nodeName']` | 编译时指定在哪个节点前暂停 | 固定位置暂停 |
| `interrupt(value)` | 在节点函数内部调用,返回值传给恢复者 | 动态/条件暂停 |

**选择 `interrupt()`** —— 因为只在"agent 调了 analyze_stock"时才暂停,不是每次都暂停。用条件判断更灵活。

### D2. 暂停时机:tools 节点之后、第二次 agent 调用之前

```
agent → tools (拉数据+算指标) → [CONFIRM NODE] → agent (写总结) → END
                                    ↑
                              interrupt 在这里
```

为什么不在 agent 之前:第一次 agent 调用是为了决定调哪个工具,没必要确认。
为什么不在 agent 之后:总结已经写完了,确认就没意义了。

### D3. interrupt 条件:只对 analyze_stock 触发

```ts
const confirmNode = async (state) => {
  // 只有调了 analyze_stock 才需要确认
  const hasStockAnalysis = state.emittedCharts.length > 0;
  if (!hasStockAnalysis) return {}; // 直接跳过,不 interrupt

  // interrupt:暂停,等用户确认
  const userInput = interrupt({
    reason: '技术分析仅供参考,不构成投资建议。确认继续查看分析结果?',
    confirmLabel: '我了解风险,继续',
    cancelLabel: '取消',
  });

  if (userInput === 'confirmed') {
    return {}; // 继续
  }
  // 用户取消 → 不继续到 agent,直接结束
  return { cancelled: true };
};
```

### D4. MemorySaver 的 thread_id = sessionId

```ts
const checkpointer = new MemorySaver();
const compiled = graph.compile({ checkpointer });

// stream / invoke 时传 configurable.thread_id
await compiled.stream(
  { messages: [...] },
  { configurable: { thread_id: sessionId } }
);
```

这样每个 session 有独立的 checkpoint,互不干扰。

### D5. 恢复执行:POST /api/chat/resume

```ts
// POST /api/chat/resume?sessionId=xxx&action=confirm
@Post('resume')
async resume(@Query() dto: ResumeDto) {
  // 从 MemorySaver 恢复状态
  const config = { configurable: { thread_id: dto.sessionId } };
  const state = await compiled.getState(config);

  if (!state || !state.next.length) {
    throw new NotFoundException('no pending interrupt');
  }

  // 注入用户响应
  await compiled.updateState(config, {
    values: { /* interrupt 的返回值 */ },
  });

  // 恢复执行
  return this.streamResume(dto);
}
```

### D6. SSE 事件:新增 `interrupt` 类型

```ts
// 新增到 ChatStreamEvent union
| { type: 'interrupt'; reason: string; confirmLabel: string; cancelLabel: string }
```

前端收到 `interrupt` 事件后:
1. 停止等待更多事件
2. 渲染确认对话框
3. 用户确认 → `POST /api/chat/resume?sessionId=...&action=confirm`
4. 用户取消 → 不调 resume,显示"已取消"

### D7. 前端确认 UI

简单的气泡内嵌按钮:
```
┌─────────────────────────────────┐
│ ⚠️ 技术分析仅供参考,不构成投资   │
│    建议。投资有风险,请独立决策。│
│                                 │
│  [我了解风险,继续]  [取消]     │
└─────────────────────────────────┘
```

## Risks / Trade-offs

- **[风险] MemorySaver 重启丢数据** —— 进程重启后所有 pending interrupt 消失。用户需要重新问。可接受(v1 学习项目)。
- **[风险] 前端两步交互** —— 从"一问一答"变成"一问→确认→继续"。需要改 useChat 的状态机。
- **[权衡] 只对 analyze_stock 暂停** —— search_news 不暂停。新闻"风险"较低(只读信息),股票分析直接影响交易决策。
- **[权衡] interrupt() 是 LangGraph 1.x 新 API** —— 比 interrupt_before 更灵活但文档较少。学习价值高。

## Migration Plan

1. 加 MemorySaver + confirm 节点到 LangGraphOrchestrator
2. 加 `interrupt` SSE 事件类型
3. 加 `POST /api/chat/resume` 端点
4. 前端 useChat 处理 interrupt + 调 resume
5. 前端 App.tsx 渲染确认对话框
6. 测试:问"分析 300033" → 应该暂停 → 确认 → 继续 → 出图表+总结

## Open Questions

- **Q1** interrupt 后 SSE 流怎么"挂起"? *建议:interrupt 事件发完后 close SSE 连接。resume 时开新 SSE 连接流式拿后续结果。*
- **Q2** 用户不确认怎么办? *建议:超时 5 分钟自动取消,或用户发新消息时自动取消旧 interrupt。*
- **Q3** 多轮对话中每次分析都要确认吗? *建议:v1 每次都确认。后续可加"本次会话不再提醒"选项。*
