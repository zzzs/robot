import { SystemMessage } from '@langchain/core/messages';

/**
 * Prompt Caching helper —— 把长 system prompt 标记为 cacheable
 *
 * Anthropic Claude(及兼容网关)支持 prompt prefix cache:
 *   长 prompt(>1024 tokens)的同 prefix 第二次调用起,只算 10% 价格
 *
 * 实现:在 message content 里加 cache_control: { type: 'ephemeral' },
 * Anthropic API 自动缓存 5 分钟(或直到 cache 满)
 *
 * 兼容性:
 *   - Anthropic 原生 API:支持
 *   - Aliyun 兼容网关:不一定支持(网关可能吞掉 cache_control 字段)
 *   - GLM / 其他 LLM:不支持,加了不会报错,但无效(等同 no-op)
 *
 * 用法:
 *   const sysMsg = cachedSystemPrompt(LONG_SYSTEM_PROMPT);  // 替代 new SystemMessage(LONG_PROMPT)
 *
 * 开关:`PROMPT_CACHE_ENABLED=true`(默认 false,设 true 启用)
 */

const PROMPT_CACHE_ENABLED = process.env.PROMPT_CACHE_ENABLED === 'true';

export function cachedSystemPrompt(text: string): SystemMessage {
  if (!PROMPT_CACHE_ENABLED) {
    return new SystemMessage(text);
  }
  // 用 content blocks 格式,加 cache_control 标记
  // cache_control 不在 LangChain 标准 content block 类型里,
  // 但 Anthropic 接受并使用(其他 LLM 会忽略)
  const block = {
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  } as unknown as { type: 'text'; text: string };
  return new SystemMessage({
    content: [block],
  });
}

/**
 * 是否启用 prompt caching(日志/调试用)
 */
export function isPromptCacheEnabled(): boolean {
  return PROMPT_CACHE_ENABLED;
}
