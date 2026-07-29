/**
 * GLMChatClient —— 直接调 GLM chat API(用于 Query Rewriting + Rerank)
 *
 * 跟 chat 主链路(ChatAnthropic + DashScope)解耦:
 *   - 主链路用于 agent 对话(多轮、tool 调用)
 *   - 这里用于 RAG 内部的一次性 LLM 调用(改写 query、给候选打分)
 *   - 用 GLM 是因为跟 embedding 共用 key,简单 + 便宜
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class GLMChatClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;

  constructor(opts: { apiKey: string; baseURL?: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4';
    this.model = opts.model ?? 'glm-4-flash'; // 便宜版,改写/打分够用
  }

  /**
   * 一次性 chat 调用,返纯文本
   */
  async chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const url = `${this.baseURL}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 500,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`GLM chat API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('GLM chat API returned empty content');
    }
    return content;
  }
}
