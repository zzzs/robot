import type { Pool, QueryResult } from 'pg';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { BaseChatMessageHistory } from '@langchain/core/chat_history';

/**
 * Postgres-backed chat message history.
 * 继承 LangChain 的 BaseChatMessageHistory 接口,跟 ChatHistoryService 对接。
 *
 * Schema(在 migrations/001_init_messages.sql 建好):
 *   messages (id, session_id, role, content_json, additional_kwargs_json,
 *            tool_calls_json, created_at)
 *
 * content_json 兼容两种形态:
 *   - string(简单文本)
 *   - content-blocks 数组([{type:'text', text:'...'}])
 * 这两种都是 JSONB 友好的,直接 JSON.stringify 即可。
 *
 * additional_kwargs_json 存 __summary 标记等元数据。
 * tool_calls_json 仅 AIMessage 用。
 */
export class PostgresChatMessageHistory extends BaseChatMessageHistory {
  lc_namespace: string[] = ['langchain', 'stores', 'message'];

  constructor(
    private readonly pool: Pool,
    private readonly sessionId: string,
  ) {
    super();
  }

  async getMessages(): Promise<BaseMessage[]> {
    const res: QueryResult<{
      role: string;
      content_json: unknown;
      additional_kwargs_json: unknown;
      tool_calls_json: unknown;
    }> = await this.pool.query(
      `SELECT role, content_json, additional_kwargs_json, tool_calls_json
       FROM messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
      [this.sessionId],
    );
    return res.rows.map((row) => deserializeRow(row));
  }

  async addMessage(message: BaseMessage): Promise<void> {
    const role = message.getType();  // 'human' / 'ai' / 'system' / 'tool'
    // ToolMessage 的 name 在 message.name 字段,不在 additional_kwargs 里
    // 存进 additional_kwargs.name,反序列化时恢复
    const mergedKwargs = { ...(message.additional_kwargs ?? {}) };
    if (role === 'tool' && message.name) {
      mergedKwargs.name = message.name;
    }
    await this.pool.query(
      `INSERT INTO messages (session_id, role, content_json, additional_kwargs_json, tool_calls_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        this.sessionId,
        role,
        JSON.stringify(message.content),
        JSON.stringify(mergedKwargs),
        // AIMessage.tool_calls 单独存一份,方便查询
        role === 'ai' && (message as AIMessage).tool_calls
          ? JSON.stringify((message as AIMessage).tool_calls)
          : null,
      ],
    );
  }

  async addUserMessage(content: string): Promise<void> {
    await this.addMessage(new HumanMessage(content));
  }

  async addAIMessage(content: string): Promise<void> {
    await this.addMessage(new AIMessage(content));
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM messages WHERE session_id = $1', [
      this.sessionId,
    ]);
  }
}

/**
 * 把 DB row 还原成 BaseMessage 子类。
 *
 * content_json 可能是 string 或 content-blocks 数组,
 * 构造 message 时用 cast 告诉 TS"已经知道是合法 content 类型"。
 */
function deserializeRow(row: {
  role: string;
  content_json: unknown;
  additional_kwargs_json: unknown;
  tool_calls_json: unknown;
}): BaseMessage {
  // JSONB 取出来后,反序列化时 TS 看到的类型是 unknown
  // 构造 message 用类型断言绕开(LangChain 的 content 类型很复杂,我们只是 JSON round-trip)
  const content = row.content_json as string | Array<Record<string, unknown>>;
  const additional_kwargs =
    (row.additional_kwargs_json as Record<string, unknown> | null) ?? {};
  const tool_calls = Array.isArray(row.tool_calls_json)
    ? (row.tool_calls_json as Array<Record<string, unknown>>)
    : undefined;

  switch (row.role) {
    case 'human':
      return new HumanMessage({
        content: content as never,
        additional_kwargs,
      });
    case 'system':
      return new SystemMessage({
        content: content as never,
        additional_kwargs,
      });
    case 'tool': {
      // ToolMessage 需要 tool_call_id + name(从 additional_kwargs 取)
      const toolCallId =
        (additional_kwargs.tool_call_id as string | undefined) ?? '';
      const name = (additional_kwargs.name as string | undefined) ?? '';
      return new ToolMessage({
        content: content as never,
        additional_kwargs,
        tool_call_id: toolCallId,
        name,
      });
    }
    case 'ai':
    default:
      return new AIMessage({
        content: content as never,
        additional_kwargs,
        tool_calls,
      } as ConstructorParameters<typeof AIMessage>[0]);
  }
}
