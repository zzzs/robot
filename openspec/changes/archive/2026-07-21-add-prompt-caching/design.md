## Context

项目用 DashScope 的 Anthropic 兼容网关跑 GLM(`backend/src/chat/providers/chat-chain.provider.ts`)。Anthropic 原生 API 自 2024-08 起支持 prompt caching:

- 在 message content block 上加 `cache_control: { type: 'ephemeral' }` 标记
- Anthropic 后端识别 prefix → 走 cache(5 分钟 TTL,可续期)
- 命中:输入 token 价格打 0.1 折(节省 90%)
- 未命中但可建:正常价格 + 缓存创建费(1.25 折)
- 响应的 `usage` 字段多出 `cache_read_input_tokens` / `cache_creation_input_tokens` —— 可直接观测

但 **DashScope 兼容网关** 是另一回事。Anthropic 网关协议兼容 ≠ cache_control 字段透传 ≠ GLM 后端真支持 ephemeral cache。所以先做 Phase 1 验证,不要直接改 4 个 orchestrator。

## Goals / Non-Goals

**Goals**:
- Phase 1:5 分钟之内能跑出一个"是否支持"的明确结论
- Phase 1:把验证方法 + 结果写到 `learn/prompt_caching.md`,让团队任何人能复现
- Phase 2(若通过):SYSTEM_PROMPT + tool descriptions + summary 三处加 cache_control
- Phase 2:LangSmith trace 能看到 `cache_read_input_tokens`,作为长期观测维度
- Phase 2:总开关 `PROMPT_CACHING_ENABLED`,排查问题时一键关

**Non-Goals**:
- **不做** LangChain 的 RunnableCascade cache / Redis 缓存(那是另一层,跟 prompt caching 是不同概念)
- **不做** 工具结果(observation)缓存(同 session 内重复查同股票的概率低,收益小)
- **不做** 自动 A/B test 比对质量(prompt caching 不影响输出质量,只是省 token)
- **不做** 跨 model 的 cache 复用(GLM-4.6 和 GLM-4.7 的 cache 不通用)

## Decisions

### D1: Phase 1 验证 —— `/api/chat/cache-test` 端点

**选择**:加一个临时 debug controller,**完全独立于 chat 主链路**,只做"发 2 次相同 prompt、第二次加 cache_control、对比 usage 字段"。

```ts
// backend/src/chat/cache-test.controller.ts
@Controller('chat')
export class CacheTestController {
  @Get('cache-test')
  async run(): Promise<{
    withoutCache: Usage;
    withCache: Usage;
    supported: boolean;
  }> {
    const longPrompt = new SystemMessage({
      content: [
        { type: 'text', text: SYSTEM_PROMPT },  // ~1K token
        // 填充到 >= 1024 token(Anthropic cache 最小长度)
        ...toolDescriptionsBlock,  // ~1.5K token
      ],
    });
    const human = new HumanMessage('你好');

    // 第一次:不带 cache_control
    const r1 = await this.model.invoke([longPrompt, human]);

    // 第二次:在 longPrompt 末尾加 cache_control 标记
    const cachedPrompt = new SystemMessage({
      content: [
        ...(longPrompt.content as object[]),
        { type: 'text', text: ' ', cache_control: { type: 'ephemeral' } },
      ],
    });
    const r2 = await this.model.invoke([cachedPrompt, human]);

    const u1 = (r1.response_metadata as { usage?: Usage }).usage;
    const u2 = (r2.response_metadata as { usage?: Usage }).usage;
    return {
      withoutCache: u1,
      withCache: u2,
      supported:
        (u2.cache_read_input_tokens ?? 0) > 0 ||
        (u2.cache_creation_input_tokens ?? 0) > 0,
    };
  }
}
```

返回的 `supported: true/false` 就是 Phase 1 的决定性结论。

**为什么独立端点而不是在 orchestrator 里测**:
- orchestrator 改动太多(4 个 + summary-memory),Phase 1 只是想验证协议
- 独立端点零侵入,验证完可直接删
- 任何团队成员 curl 一下就知道结果

**备选**:
- 在 orchestrator 里加临时 cache + flag —— 拒绝,改动大、不易回滚
- 写个 standalone script(`scripts/test-cache.ts`)—— 可行但不如 HTTP 端点方便

### D2: Phase 1 最小 prompt 长度 —— 必须凑到 1024 token

**选择**:把 SYSTEM_PROMPT + 工具描述拼起来,确保 >= 1024 token。Anthropic 文档说少于 1024 token 的 prefix 不会被 cache。

**实现**:
- 拼 SYSTEM_PROMPT (~1K) + 6 个工具 description (~1.5K) ≈ 2.5K token,稳超阈值
- 用 `tiktoken` 或本地估算验证长度

**备选**:
- 故意写 1K 字符的填充文本 —— 太 hack
- 等真实历史累积到 1K+ 再测 —— 不可控

### D3: Phase 2 缓存标记位置 —— SYSTEM_PROMPT 末尾 + tool descriptions + summary

**选择**(若 Phase 1 通过):

```
[SystemMessage(SYSTEM_PROMPT)]                    ← content block 末尾加 cache_control
[tool descriptions(via bindTools)]                ← LangChain 自动处理?需验证
[SystemMessage(summary, __summary=true)]          ← content block 末尾加 cache_control
[...recentK messages]                              ← 不加(每条都不同)
[HumanMessage(current query)]
```

**为什么这样分**:
- SYSTEM_PROMPT 每次请求**完全一样** → cache hit 率最高,优先缓存
- tool descriptions 每次请求**完全一样**(只要工具集不变) → 同上
- summary 在同 session 内**多轮稳定**(只在压缩时变) → 同 session 内 cache hit
- recentK 每轮都变 → 不缓存

**实现挑战**:
- ChatAnthropic v1.x 对 `cache_control` 的支持需要验证:
  - `SystemMessage({ content: [{ type: 'text', text: '...', cache_control: { type: 'ephemeral' } }] })` 是否被正确序列化到 API 请求?
  - `bindTools` 后 tool descriptions 是否自动加 cache_control?(LangChain 文档说有 `cacheControl` 选项)
- SummaryMemoryService 返回的 SystemMessage 也要改 content 形态(从 string 改为 content-blocks 数组)

**备选**:
- 只缓存 SYSTEM_PROMPT —— 拒绝,小于 1024 token,Anthropic 不接
- 把工具描述手动拼进 SYSTEM_PROMPT —— 拒绝,违背 LangChain 的 tool-calling 设计

### D4: LangSmith 观测 —— usage 字段进 metadata

**选择**:每次 LLM 调用后,把 `usage.cache_read_input_tokens` / `cache_creation_input_tokens` 抽出来,塞到 LangSmith run 的 metadata 里。

```ts
// 在 orchestrator 里(以 langgraph 为例)
const response = await bound.invoke(messages, config);
const usage = response.response_metadata?.usage;
if (usage) {
  this.logger.log(
    `cache hit=${usage.cache_read_input_tokens ?? 0} ` +
    `creation=${usage.cache_creation_input_tokens ?? 0} ` +
    `input=${usage.input_tokens ?? 0} ` +
    `output=${usage.output_tokens ?? 0}`,
  );
}
```

不强行做 dashboard,日志能看到就够了。如果团队后续要做命中率统计,从 LangSmith 导出。

**备选**:
- 写到自定义 metrics endpoint —— 过度工程
- 不观测 —— 拒绝,不知道有没有用就没意义

### D5: 回滚开关 —— `PROMPT_CACHING_ENABLED`

**选择**:`.env` 加 `PROMPT_CACHING_ENABLED=true`(默认),`false` 时所有 cache_control 标记都不加。

实现:在 `withCacheControl(message)` helper 里检查:

```ts
export function withCacheControl(message: SystemMessage): SystemMessage {
  if (!process.env.PROMPT_CACHING_ENABLED || process.env.PROMPT_CACHING_ENABLED === 'false') {
    return message;  // 透传,不加 cache_control
  }
  // 把 content 转 content-blocks 数组,末尾加 cache_control
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
    : [...(message.content as object[]), { type: 'text', text: ' ', cache_control: { type: 'ephemeral' } }];
  return new SystemMessage({ content: blocks, additional_kwargs: message.additional_kwargs });
}
```

**为什么默认开**:
- Anthropic 不收额外费用(cache miss 不贵,cache hit 大幅省钱)
- 不影响输出质量
- 出问题(罕见)直接改 env 重启

**备选**:
- 默认关 —— 拒绝,这样跟没做一样

### D6: 配置项汇总

```env
# Prompt caching (Anthropic ephemeral cache)
PROMPT_CACHING_ENABLED=true  # 默认开,排查问题时设 false
```

加到 `backend/src/config/configuration.ts` 的 `promptCaching` 段。

## Risks / Trade-offs

- **[Risk] DashScope 不透传 cache_control** → Phase 1 验证会发现。若不支持:archive 本 change,在 `learn/prompt_caching.md` 记录结论,等待官方支持后再启
- **[Risk] Anthropic API 突然改 cache_control 协议** → 低,Anthropic 已稳定 1 年
- **[Risk] LangChain `@langchain/anthropic` 升级后 content-block 序列化方式变** → 在 cache-test 集成测试里固定测试
- **[Risk] 5 分钟 TTL 内 prompt 改了**(比如开发者改 SYSTEM_PROMPT) → cache 自动失效,重新创建,正常行为
- **[Trade-off] 加 cache_control 增加代码复杂度** —— content 从 string 变 content-blocks 数组,所有读取 content 的地方要适配(`contentToString` 已经支持两种形态)
- **[Trade-off] Phase 2 改 4 个 orchestrator + SummaryMemoryService** —— 工作量 ~3 小时,但有 helper 函数后模式化

## Migration Plan

**Phase 1(独立部署,无破坏)**:
1. 加 `cache-test.controller.ts`
2. 加 `learn/prompt_caching.md` 文档骨架(待填验证结果)
3. 启动 backend,curl `/api/chat/cache-test`
4. 把结果(支持/不支持 + sample usage 字段)贴到文档
5. **决策点**:支持 → 进 Phase 2;不支持 → archive,记结论

**Phase 2(若通过)**:
1. 写 `prompt-cache.util.ts` helper(`withCacheControl`)
2. 在 `chat.orchestrator.ts` 用 helper 包 SYSTEM_PROMPT,启动 backend,curl 一次 chat,看 LangSmith trace
3. 同样改 langgraph / supervisor / create-agent orchestrator
4. 改 `SummaryMemoryService.wrap()` 给 summary SystemMessage 加 cache_control
5. 跑单测,确认现有逻辑不回归
6. 长跑 5 分钟(同 session),确认 cache 命中率持续提升
7. 更新 checklist + learn 文档

**回滚**:`PROMPT_CACHING_ENABLED=false`,无代码 revert。

## Open Questions

- **Q1**: DashScope 兼容网关是否真支持 `cache_control`?**TBD**: Phase 1 验证
- **Q2**: LangChain `@langchain/anthropic` v1.5+ 对 `cache_control` 的支持程度?**TBD**: Phase 1 跑通时确认 —— 是 content-block 数组形式,还是有 `cacheControl` 配置项
- **Q3**: 工具描述(tool descriptions)能否自动被 cache?**TBD**: Anthropic API 文档说支持,但 LangChain 的 `bindTools` 是否自动加 cache_control 标记要实测
- **Q4**: 5 分钟 TTL 是否够用?**TBD**: 如果用户交互间隔 > 5 分钟,cache 会失效。Anthropic 支持 "1h TTL" 选项(beta),需要 `anthropic-beta: extended-cache-ttl-2025-04-11` header —— 暂不引入
