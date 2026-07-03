# RAG 调通全历程:问题、思路与教训

> 本文档记录了在 robot 项目中走通 RAG(Loader → Splitter → Embed → Store → Retrieve)全链路时遇到的所有问题、尝试过的方案、以及最终解决思路。便于后续复盘和学习。

---

## 一、背景

**目标:** 学习 RAG 基础链路,实现 A 股新闻检索场景。

**技术栈:**
- Loader: `rss-parser`(RSS) 或本地 fixture(JSON)
- Splitter: `RecursiveCharacterTextSplitter`(`@langchain/textsplitters`)
- Embed: 本地 `@huggingface/transformers` 或 GLM `embedding-3` API
- Store: `MemoryVectorStore`(`@langchain/classic`)
- Retrieve: `vectorStore.asRetriever({ k: 5 })`

**最终方案:** GLM `embedding-3` API + fixture 数据 + 完整 RAG 链路。

---

## 二、问题全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                    RAG 调通遇到的 10 个问题                       │
├──────────────┬──────────────────────────────────────────────────┤
│  数据源       │ ① Sina RSS 404  ② RSSHub 超时  ③ fixture 方案   │
│  工具调用      │ ④ executeTools 没处理 search_news               │
│  Embedding   │ ⑤ DashScope 401  ⑥ HF 被墙  ⑦ 镜像不生效        │
│              │ ⑧ ONNX mutex bug  ⑨ Protobuf 解析失败            │
│              │ ⑩ 镜像限速下载不完整                              │
└──────────────┴──────────────────────────────────────────────────┘
```

---

## 三、逐个问题详解

### 问题 ① Sina RSS 返回 404

**现象:** `rss fetch failed for https://finance.sina.com.cn/rss/stock.xml: Status code 404`

**根因:** 新浪财经已下线公开 RSS 服务。国内主流财经网站(新浪、东方财富、腾讯)基本都关闭了 RSS。

**尝试过的方案:**
- 换 RSSHub 公共实例(`https://rsshub.app/cls/telegraph`)→ 超时
- 自部署 RSSHub Docker → 太重,偏离学习目标

**最终解决:** 创建 `fixture:sample` —— 20 篇手写的 A 股新闻 JSON,内置在代码里。NewsLoaderService 支持 `fixture:` URL scheme,读取本地 JSON。

**教训:** 国内数据源生态对开发者不友好。学习项目优先用 fixture 保证"能跑通",真实数据源后续再接。

---

### 问题 ② RSSHub 公共实例超时

**现象:** `curl https://rsshub.app/cls/telegraph` 超时(15 秒无响应)

**根因:** RSSHub 公共实例负载高,经常不稳定。自部署需要 Docker,增加复杂度。

**解决:** 同问题 ①,用 fixture 替代。

**教训:** 依赖外部免费服务做 POC 风险高,准备好 fallback。

---

### 问题 ③ executeTools 没处理 search_news(工具调用)

**现象:** 用户问"茅台最近有什么新闻",模型返回"新闻检索工具未能返回有效数据",但没有 `[GlmNewsService]` 或 `[NewsRetrievalService]` 日志 —— 工具函数**根本没被调用**。

**根因:** LangGraph 和手写 orchestrator 的 `executeTools` 函数只处理 `analyze_stock` / `analyze_stock_free`。模型 emit `search_news` tool_call 后,executeTools 试图从 args 里提取 `ts_code`(不存在,search_news 的参数是 `query`)→ tsCode 为 null → 返回 no-data → 模型看到"失败"后自己编了"工具不可用"的回答。

**排查方法:** 后端日志只有 `iter=0 toolCalls=1 tools=search_news({...})` 但没有 `[NewsRetrievalService] search called...` → 说明 tool_call 被 emit 但 func 没被执行。

**解决:** 在 `executeTools` 的 for-loop 开头加 `search_news` 分支:

```ts
if (tc.name === 'search_news') {
  const query = typeof args.query === 'string' ? args.query : '';
  const result = await this.searchNewsTool.invoke({ query });
  newMessages.push(new ToolMessage({ tool_call_id: tc.id, content: result }));
  continue;
}
```

在 `ChatOrchestrator`(manual)和 `LangGraphOrchestrator` 两处都加。

**教训:** 自定义 executeTools 每加一个新工具就要加一个分支。生产环境应该用 LangGraph 的 `ToolNode`(自动调 `tool.func`),或写一个通用的"非 stock 工具走 tool.func"兜底分支。

---

### 问题 ④ DashScope Embedding API 401

**现象:** `embedding batch attempt 1/2 failed: 401 Incorrect API key provided`

**根因:** 用户的 `DASHSCOPE_API_KEY` 是内部代理 key(`ai-platform.cai-inc.com`),不是真正的 DashScope key。代码指向 `dashscope.aliyuncs.com`(真 DashScope 端点),真端点不认代理 key。

**排查方法:** 看 `.env` 里的 `DASHSCOPE_BASE_URL=https://ai-platform.cai-inc.com/...`(代理) vs 代码里的 `https://dashscope.aliyuncs.com/compatible-mode/v1`(真端点)—— 两边不匹配。

**尝试过的方案:**
- 用代理 URL 做 embedding → 代理不支持 OpenAI 兼容 embedding 端点
- 让用户去 DashScope 注册新 key → 用户已有 GLM plan,不想再管 DashScope

**最终解决:** 换成 GLM `embedding-3` API(用户已有 `GLM_API_KEY` for `open.bigmodel.cn`)。

**教训:** 企业内部代理通常只代理特定协议(如 Anthropic 兼容 chat),不支持所有端点(如 embedding)。API key 的作用域要跟端点匹配。

---

### 问题 ⑤ HuggingFace.co 被墙

**现象:** `curl https://huggingface.co` → 超时(8 秒无响应)

**根因:** HuggingFace 在国内被 GFW 屏蔽。

**解决:** 用中国镜像 `https://hf-mirror.com`:

```ts
env.remoteHost = 'https://hf-mirror.com';
```

**教训:** 国内开发涉及海外 AI 服务,提前查镜像/代理方案。HF 镜像(`hf-mirror.com`)是社区维护的,稳定性不保证。

---

### 问题 ⑥ 镜像设置在 NestJS 里不生效

**现象:** 设置了 `env.remoteHost = 'https://hf-mirror.com'`,但 NestJS 启动后仍然 `fetch failed`(尝试连 `huggingface.co` 而不是镜像)。

**根因:** LangChain 的 `HuggingFaceTransformersEmbeddings` wrapper 内部 import 了 `@huggingface/transformers`。由于 ESM/CJS 双包(dual package hazard),wrapper 和我们的代码可能拿到**不同的 `env` 对象实例**。我们设的 `env.remoteHost` 不影响 wrapper 内部用的那个 `env`。

**排查方法:** 写独立测试脚本(`node test-embedding.js`)直接 `require('@huggingface/transformers')` → 成功。但在 NestJS 里 → 失败。说明模块解析路径不同。

**解决:** 绕过 LangChain wrapper,自己写 `LocalTransformersEmbeddings` 类,直接 import `pipeline` from `@huggingface/transformers`,确保 `env` 是同一个引用:

```ts
import { env, pipeline } from '@huggingface/transformers';

// 模块级设置(最早时机,不放在 constructor 里)
env.remoteHost = 'https://hf-mirror.com';
env.backends.onnx.wasm.numThreads = 1;

class LocalTransformersEmbeddings extends Embeddings {
  async maybeInit() {
    this.extractor = await pipeline('feature-extraction', this.model);
  }
  // embedQuery / embedDocuments 直接调 this.extractor
}
```

**教训:** NestJS + LangChain + ESM-only 包(如 `@huggingface/transformers` v3)容易踩双包坑。绕过中间层、直接 import 底层库是最可靠的方案。

---

### 问题 ⑦ ONNX Runtime mutex lock 崩溃

**现象:**
```
libc++abi: terminating with an uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument
```

**根因:** `onnxruntime-node`(原生 C++ 后端)在 macOS 12.x (Darwin 21.6.0) 上有 pthread 多线程 bug。C++ 标准库的 `mutex` 构造/锁定在特定条件下抛 `system_error`。

**排查方法:** 独立测试脚本能成功计算 embedding(dim: 384),但 `process.exit()` 时崩溃。说明推理本身没问题,崩溃在 ONNX Runtime 的清理阶段。

**解决:** `env.backends.onnx.wasm.numThreads = 1` —— 强制单线程,绕过多线程 mutex 创建:

```ts
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}
```

**效果:** 推理成功,crash 只在 `process.exit` 时触发(不影响 NestJS 长驻进程)。

**教训:** 原生 C++ Node.js 扩展在旧版 macOS 上可能有平台兼容性 bug。单线程是万能 fallback。升级 macOS 或 onnxruntime 版本也可能修复。

---

### 问题 ⑧ Protobuf parsing failed(fp32 模型)

**现象:**
```
Load model from .../model.onnx failed:Protobuf parsing failed.
```

**根因:** ONNX Runtime 无法解析 fp32 格式的 ONNX 模型文件。在 macOS 12.x 上,`onnxruntime-node` 的 protobuf 解析器对大文件(>100MB)有兼容性问题。

**尝试过的方案:**
- `dtype: 'q8'`(量化版,~120MB)→ 独立脚本成功,NestJS 里报 `Float32Array` 类型错误
- 不指定 dtype(默认 fp32,~470MB)→ `Protobuf parsing failed`
- 换不同模型(`bge-small-zh-v1.5`)→ 同样失败

**教训:** ONNX Runtime 的 macOS 兼容性问题不是模型特定的,是 runtime 本身的 bug。fp32 和 q8 都可能触发不同的解析/推理错误。

---

### 问题 ⑨ 镜像限速,下载不完整

**现象:** pipeline 自动下载的 `model_quantized.onnx` 只有 32KB(应该 ~120MB)。手动 `curl -L` 下载 22MB 文件,5 分钟只下了 398KB(速度 ~1.3KB/s)。

**根因:** `hf-mirror.com` 对大文件严重限速。小文件(配置 JSON 等)可以秒下,大文件(ONNX 模型)被限流到几乎不可用。

**排查方法:** 检查缓存文件大小:
```bash
ls -lh node_modules/@huggingface/transformers/.cache/Xenova/.../onnx/model_quantized.onnx
# 32K 而不是 120M → 下载被截断
```

**尝试过的方案:**
- 换更小的模型(`all-MiniLM-L6-v2`,~23MB q8 后 ~12MB)→ 仍然被截断到 129KB
- 手动 `curl -L` 下载 → 速度 ~1KB/s,4 小时才能下完
- 设 `env.allowRemoteModels = false` 用本地文件 → 但本地文件也是截断的

**教训:** 国内镜像对小文件(配置)大文件(模型)的限速策略不同。下载 ONNX 模型这种大文件,需要稳定的高速网络或 VPN。学习项目可以考虑用更小的模型(<5MB),但即使 12MB 也被限速。

---

### 问题 ⑩ 最终方案:GLM Embedding API

**现象:** 本地 embedding 三重阻塞(HF 被墙 + 镜像限速 + ONNX Runtime bug),无法走通。

**解决:** 用 GLM `embedding-3` API 替代本地 embedding:

```ts
this.embeddings = new OpenAIEmbeddings({
  modelName: 'embedding-3',
  openAIApiKey: process.env.GLM_API_KEY,
  configuration: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
});
```

**为什么这个方案可行:**
- `open.bigmodel.cn` 在国内可达,速度快
- 用户已有 GLM plan 套餐,`GLM_API_KEY` 可用
- GLM `embedding-3` 是 OpenAI 兼容接口,LangChain 的 `OpenAIEmbeddings` 直接支持
- 0.5 元/百万 token,20 篇新闻 ~80 chunks 的 ingest 成本约 0.01 元
- 不需要下载模型、不需要 ONNX Runtime、不依赖 HF

**RAG 五个环节完全不变:**
```
fixture:sample (20 篇)           ← 不变
    ↓ RecursiveCharacterTextSplitter  ← 不变
    ↓ GLM embedding-3 (API)          ← 只换这一步
    ↓ MemoryVectorStore              ← 不变
    ↓ asRetriever({k:5})             ← 不变
```

**教训:** 学习 RAG 的核心是理解 Loader/Splitter/Embed/Store/Retrieve 的**流程和接口**,不是纠结 Embed 用本地还是 API。生产 RAG 系统大多数也用 API embedding(OpenAI / Cohere / GLM),本地 ONNX 是成本优化选项,不是必选项。

---

## 四、排查方法论总结

### 1. 分层排查:网络 → 代码 → 运行时

遇到"不工作"时,按层排查:

| 层 | 症状 | 排查方法 |
|---|---|---|
| 网络 | `fetch failed` / 超时 | `curl -v URL` 直接测 |
| 代码 | 工具没被调用 / 逻辑分支错误 | 看日志有没有预期行(`[ServiceName] xxx called`) |
| 运行时 | `Protobuf parsing failed` / `mutex lock failed` | 独立脚本 `node test.js` 验证,排除框架干扰 |

### 2. 独立脚本验证法

**最重要的调试技巧。** 遇到 NestJS 里不工作的问题,写一个 `node test.js` 直接调底层库:

```js
// 排除 NestJS DI / TypeScript 编译 / LangChain wrapper 的干扰
const { env, pipeline } = require('@huggingface/transformers');
env.remoteHost = 'https://hf-mirror.com';
pipeline('feature-extraction', 'model-name', { dtype: 'q8' })
  .then(ext => ext('test', { pooling: 'mean', normalize: true }))
  .then(r => console.log('dim:', r.data.length));
```

如果独立脚本成功 → 问题在 NestJS/LangChain 集成层。
如果独立脚本也失败 → 问题在网络/运行时/模型文件。

### 3. 缓存文件检查法

模型下载失败时,检查缓存文件大小:

```bash
ls -lh node_modules/@huggingface/transformers/.cache/.../onnx/model*.onnx
```

32KB 的 ONNX 文件 = 下载被截断。`file` 命令 + `xxd | head` 看文件头是否是合法 ONNX 格式。

### 4. "不是你的错"清单

以下问题不是代码能修的,需要换方案:

- HuggingFace 被墙 → 换镜像或换 API embedding
- 镜像限速 → 换更小模型或换 API embedding
- ONNX Runtime macOS bug → 换 API embedding 或升级 macOS
- 企业代理 key 不支持 embedding 端点 → 换独立 API key

---

## 五、关键代码位置

| 环节 | 文件 | 关键行 |
|---|---|---|
| Loader(fixture) | `news-loader.service.ts` | `loadOneSource()` 的 `fixture:` 分支 |
| Splitter | `news-embedding.service.ts` | `RecursiveCharacterTextSplitter({ chunkSize: 800, ... })` |
| Embed | `news-embedding.service.ts` | `OpenAIEmbeddings({ modelName: 'embedding-3', ... })` |
| Store | `news-embedding.service.ts` | `MemoryVectorStore(this.embeddings)` |
| Retrieve | `news-retrieval.service.ts` | `vectorStore.asRetriever({ k: 5 }).invoke(query)` |
| 工具 | `tools/search-news.tool.ts` | `DynamicStructuredTool({ name: 'search_news', ... })` |
| 工具执行 | `langgraph-orchestrator.ts` | `executeTools` 的 `search_news` 分支 |
| 工具注册 | `chat.orchestrator.ts` / `langgraph-orchestrator.ts` | `bindTools([..., this.searchNewsTool])` |

---

## 六、如果未来要换回本地 embedding

本地 embedding 被三重阻塞(HF 被墙 + 镜像限速 + ONNX bug)。如果未来想再试,需要同时解决:

1. **网络:** 自部署 RSSHub Docker 或用 VPN 访问 HuggingFace
2. **ONNX Runtime:** 升级到 macOS 13+ 或换 Linux 开发环境
3. **模型下载:** 手动用 `curl -L` 下载(需要稳定高速网络)或用 VPN

换回本地 embedding 只需改 `news-embedding.service.ts` 一个文件 —— 把 `OpenAIEmbeddings` 换成 `HuggingFaceTransformersEmbeddings`(或自定义 `LocalTransformersEmbeddings`)。其他 RAG 环节完全不变。

这就是 LangChain `Embeddings` 接口抽象的价值 —— 上层逻辑不依赖底层实现。
