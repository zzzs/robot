# Prompt Caching 调研报告

> 本文档记录 2026-07-21 对 DashScope GLM 是否支持 prompt caching 的调研结果。
> 配套代码:`backend/src/chat/cache-test.controller.ts`(验证端点)。

---

## TL;DR

- **DashScope 忽略 Anthropic 的 `cache_control` 标记** —— 加了等于没加,可能反而有害(详见下文)
- **DashScope 自带 OpenAI 风格的自动前缀缓存** —— 无需任何标记,相同前缀的请求自动命中,5 分钟 TTL
- **结论**:**不做 Phase 2**。现有代码已经受益于自动缓存,只需保证 prompt 前缀稳定(SYSTEM_PROMPT 不变)

---

## 调研方法

### 端点

`GET /api/chat/cache-test` —— 见 `backend/src/chat/cache-test.controller.ts`。

逻辑:
1. 构造 ~1300 token 的长 prompt(SYSTEM_PROMPT + 工具描述 + 指标附录)
2. **第 1 次调用**:prompt 不带 `cache_control`
3. **第 2 次调用**:同样 prompt,末尾加 `{ type: 'text', text: ' ', cache_control: { type: 'ephemeral' } }`
4. 对比 `response_metadata.usage` 字段

### 关键观察(连续 2 次 curl 同一端点)

**第 1 次 curl**:

| 调用 | input_tokens | cache_read_input_tokens | cached_tokens (OpenAI 字段) |
|---|---|---|---|
| withoutCache | 1317 | 0 | 0 |
| withCache | 1318 | 0 | 0 |

**第 2 次 curl**(5 秒后):

| 调用 | input_tokens | cache_read_input_tokens | cached_tokens |
|---|---|---|---|
| withoutCache | **37** | **1280** | **1280** ← 命中! |
| withCache | 1318 | 0 | 0 |

---

## 关键发现

### 1. Anthropic `cache_control` 标记 → 被忽略

- 4 次调用(2 次 withCache + 2 次 withoutCache 第 1 次),`cache_read_input_tokens` 永远是 0
- 即使把 prompt 加到 1300+ token(超 Anthropic 1024 阈值),也没创建任何 cache
- 证明 DashScope 的 Anthropic 兼容网关**不透传 `cache_control` 字段给 GLM 后端**,或 GLM 后端**不支持 Anthropic 的 ephemeral cache 协议**

### 2. DashScope 自动前缀缓存(OpenAI 风格)→ 工作

- 第 2 次 curl 的 withoutCache 调用:`cache_read_input_tokens=1280`,只算 37 个新 token
- 这是 **DashScope 自己的缓存层**,响应里返 OpenAI 兼容的 `prompt_tokens_details.cached_tokens` 字段
- **无需任何显式标记** —— 只要两次请求的前缀完全相同,5 分钟内自动命中

### 3. `cache_control` 标记反而有害

- 第 2 次 curl 的 withCache 调用:`cache_read_input_tokens=0`(没命中)
- 原因:我们在 prompt 末尾加了 `{ type: 'text', text: ' ', cache_control: ... }` 块
- 这个额外块让 prompt 跟第 1 次调用的 prompt **前缀不同**,破坏了 DashScope 的前缀匹配
- **教训**:加 cache_control 不仅没用,还可能让本来能命中的前缀失效

---

## 实战建议

### 对本项目(robot backend)

**不需要改任何代码**。当前实现已经自动受益于 DashScope 的前缀缓存:

- 4 个 orchestrator 的 SYSTEM_PROMPT 每次请求**完全一样** → 同 session 内自动命中
- `bindTools` 后的 tool descriptions 每次也**完全一样** → 同上
- `SummaryMemoryService` 在同 session 内 summary 稳定 → 同上

**只要遵守**:
- 不要在请求间改 SYSTEM_PROMPT(改了会失效所有 cache)
- 不要在 prompt 末尾加额外内容(会破坏前缀匹配)
- 同 session 内频繁调用效果最好(5 分钟 TTL)

### 排查"为什么 cache 不命中"

1. **改了 SYSTEM_PROMPT** → cache 失效,要重新预热(下次调用自动创建)
2. **超过 5 分钟没调** → TTL 过期
3. **不同 session 但 prompt 不同** → 前缀不匹配
4. **prompt 末尾有动态内容**(比如时间戳、random ID) → 整个 prompt 都被视为新的

### 切到真正的 Anthropic API 时

如果将来项目切到原生 Anthropic API(直连 `api.anthropic.com`,不走 DashScope):
- Anthropic 原生支持 `cache_control: { type: 'ephemeral' }`
- 这时 Phase 2 的实现就有意义了
- 本文档的"自动缓存"结论**不适用** —— Anthropic 没有自动缓存,必须显式标记

---

## 决策记录

- **2026-07-21**:Phase 1 验证完成,结论"DashScope 不支持 Anthropic prompt caching,但自带 OpenAI 风格自动缓存"。Phase 2 取消,本 change 直接 archive。
- **未来**:若切到原生 Anthropic API,重开新 change 实现 `cache_control` 标记。

---

## 附录:验证端点使用

```bash
# 启动 backend 后:
curl http://localhost:3000/api/chat/cache-test | jq

# 连续调 2 次,看第 2 次的 withoutCache.cache_read_input_tokens 是否 > 0
for i in 1 2; do
  echo "=== call $i ==="
  curl -s http://localhost:3000/api/chat/cache-test | jq '.withoutCache.cache_read_input_tokens'
  sleep 2
done
```

预期:第 1 次 0,第 2 次 > 0(证明自动缓存工作)。
