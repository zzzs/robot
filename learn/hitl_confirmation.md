# HITL + MemorySaver 学习指南

> 配套代码:
> - `backend/src/chat/langgraph-orchestrator.ts` — MemorySaver + confirm 节点 + interrupt + resume
> - `backend/src/chat/chat.controller.ts` — `GET /api/chat/resume` 端点
> - `backend/src/chat/chat-stream.types.ts` — `interrupt` 事件类型
> - `frontend/src/hooks/useChat.ts` — interrupt 事件处理 + resume 方法
> - `frontend/src/App.tsx` — 确认对话框 UI

---

## 一、什么是 HITL

HITL (Human-in-the-Loop) = 人在回路中。Agent 在关键步骤**暂停**,等待人类确认后继续。

典型场景:
- 股票分析:结果展示前要用户确认"了解风险"
- 交易下单:执行前要用户确认订单详情
- 邮件发送:发送前要用户确认收件人和内容

没有 HITL,agent 一路跑到底,用户无法干预。有了 HITL,agent 可以:
1. 跑到一半暂停
2. 把问题抛给用户
3. 等用户回答
4. 根据回答继续或终止

---

## 二、三个核心概念

### 1. MemorySaver (Checkpoint 持久化)

把 graph 的完整状态(消息、chart、confirmed 等)存下来,以便中断后恢复:

```ts
import { MemorySaver } from '@langchain/langgraph';

const checkpointer = new MemorySaver();
const compiled = graph.compile({ checkpointer });

// 每次调用传 thread_id,就是 checkpoint 的 key
await compiled.stream(
  { messages: [...] },
  { configurable: { thread_id: sessionId } }
);
```

**MemorySaver vs SqliteSaver vs PostgresSaver:**
- MemorySaver: 进程内存,重启丢(学习/开发用)
- SqliteSaver: 本地文件,重启不丢(单机生产)
- PostgresSaver: 数据库,多实例共享(集群生产)

### 2. interrupt() (暂停执行)

在节点函数内部调用 `interrupt(value)`,graph 会暂停:
- `value` 传给前端(描述为什么暂停 + 选项)
- graph 状态自动存入 MemorySaver
- stream 结束(不 yield done)
- 前端收到 interrupt 事件,显示确认 UI

```ts
const confirmNode = (state) => {
  if (state.emittedCharts.length === 0) return {}; // 不需要确认
  
  const userResponse = interrupt({
    reason: '⚠️ 技术分析仅供参考...',
    confirmLabel: '我了解风险,继续',
    cancelLabel: '取消',
  });
  
  // 这行代码只在 resume 后执行
  // userResponse 的值来自 Command({ resume: value })
  return { confirmed: userResponse === 'confirmed' };
};
```

### 3. Command({ resume }) (恢复执行)

用户确认后,后端用 `Command` 恢复 graph:

```ts
import { Command } from '@langchain/langgraph';

// 用户点了"确认"
const stream = await compiled.stream(
  new Command({ resume: 'confirmed' }),
  { configurable: { thread_id: sessionId } }
);
// graph 从 interrupt 处继续,confirmNode 收到 'confirmed'
// → confirmed=true → 路由到 agent → 写总结 → END
```

---

## 三、完整流程图

```
用户发 "分析 300033"
    ↓
GET /api/chat/stream?sessionId=abc&message=分析300033
    ↓
graph: agent → tools (拉K线+算指标)
    ↓
graph: confirm 节点
    ├─ emittedCharts 非空 → interrupt()
    │   ↓
    │  MemorySaver 存 checkpoint(thread_id=abc)
    │   ↓
    │  SSE emit { type: 'interrupt', reason: '⚠️...' }
    │  SSE 关闭(不 emit done)
    │
    └─ emittedCharts 空 → 跳过(闲聊/新闻直接到 agent → END)
    ↓
前端: 收到 interrupt 事件
    ├─ 渲染确认气泡 [我了解风险,继续] [取消]
    ├─ 输入框禁用
    └─ awaitingConfirm = true
    ↓
用户点"继续"
    ↓
GET /api/chat/resume?sessionId=abc&action=confirm
    ↓
后端: compiled.stream(new Command({ resume: 'confirmed' }), { thread_id: abc })
    ↓
graph 从 MemorySaver 恢复 → confirmNode 收到 'confirmed'
    ↓
confirmed=true → 路由到 agent → 写总结
    ↓
SSE emit { type: 'text', ... } + { type: 'done' }
    ↓
前端: 总结正常渲染
```

---

## 四、Graph 拓扑变化

**改之前:**
```
START → agent → (有tool_calls?) → tools → agent → ... → END
```

**改之后:**
```
START → agent → (有tool_calls?) → tools → confirm → agent → ... → END
                                             ↑
                                        interrupt 在这里
```

confirm 节点的条件边:
- `confirmed === true` → 继续到 agent(写总结)
- `confirmed === false` → END(用户取消)

---

## 五、关键代码位置

| 功能 | 文件 | 关键行 |
|---|---|---|
| MemorySaver 创建 | `langgraph-orchestrator.ts` | `new MemorySaver()` + `compile({ checkpointer })` |
| confirm 节点 | `langgraph-orchestrator.ts` | `confirmNode` 函数 |
| interrupt() 调用 | `langgraph-orchestrator.ts` | `interrupt({ reason, confirmLabel, cancelLabel })` |
| thread_id 传递 | `langgraph-orchestrator.ts` | `configurable: { thread_id: dto.sessionId }` |
| 检测 interrupt | `langgraph-orchestrator.ts` | `getState(config).next.length > 0` |
| resume 方法 | `langgraph-orchestrator.ts` | `compiled.stream(new Command({ resume }), config)` |
| SSE interrupt 事件 | `chat-stream.types.ts` | `{ type: 'interrupt', reason, confirmLabel, cancelLabel }` |
| resume HTTP 端点 | `chat.controller.ts` | `@Sse('resume')` |
| 前端 interrupt 处理 | `useChat.ts` | `case 'interrupt': setAwaitingConfirm(true)` |
| 前端 resume 方法 | `useChat.ts` | `resume(action: 'confirm' \| 'cancel')` |
| 前端确认 UI | `App.tsx` | confirm bubble + confirm/cancel 按钮 |

---

## 六、interrupt() vs interrupt_before

| 方式 | 用法 | 适合 |
|---|---|---|
| `interrupt(value)` | 在节点函数内部调用 | **动态/条件暂停**(本项目用) |
| `interrupt_before: ['nodeName']` | compile 时指定 | 固定位置暂停 |

本项目用 `interrupt()` 因为:
- 只有 `analyze_stock`(有 chart)才需要确认
- 闲聊和新闻检索不暂停
- 用条件判断比固定位置更灵活

---

## 七、试用

```bash
# 1. 启动后端
cd backend && npm run start:dev

# 2. 启动前端
cd frontend && npm run dev

# 3. 在 UI 里:
#    - 发 "分析一下 300033" → 应该出现确认框
#    - 点"我了解风险,继续" → 图表+总结正常显示
#    - 发 "你好" → 不出现确认框,直接回复
#    - 发 "茅台最近有什么新闻" → 不出现确认框(新闻不触发 interrupt)
```

**测试取消:**
```bash
# 发 "分析 300033" → 出现确认框 → 点"取消" → 显示"已取消"
```

---

## 八、注意事项

- **MemorySaver 是内存的** —— 后端重启后所有 pending interrupt 消失,用户需要重新问
- **每次分析都要确认** —— v1 设计如此。未来可加"本次会话不再提醒"
- **resume 端点用 SSE** —— 跟 stream 端点格式一致(text/chart/done),前端复用相同的事件处理逻辑
- **非 langgraph 模式** —— manual / supervisor 模式的 `resume()` 返回提示"HITL 仅在 LangGraph 模式下可用"
