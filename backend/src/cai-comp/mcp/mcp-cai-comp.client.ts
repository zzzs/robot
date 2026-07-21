import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * McpCaiCompClient —— spawn mcp-servers/cai-comp 作为子进程,通过 stdio 调用工具。
 * 完全仿 McpStockClient 模式。
 *
 * 失败降级:如果子进程起不来,MCP 客户端不可用,isAvailable() 返 false。
 * orchestrator 检测到后让 CAI_COMP_*_TOOL 返 stub,不挂工具进 agent。
 */
@Injectable()
export class McpCaiCompClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpCaiCompClient.name);
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private started = false;
  private starting: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.start();
  }

  async onModuleDestroy() {
    await this.stop();
  }

  isAvailable(): boolean {
    return this.started && this.client !== null;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      try {
        const command = this.config.get<string>('caiComp.mcpCommand') ?? 'node';
        const argsRaw = this.config.get<string>('caiComp.mcpArgs') ?? '';
        const args = argsRaw
          ? argsRaw.split(',').map((a) => a.trim()).filter(Boolean)
          : [];

        // 把当前进程的 env 作为 base (PATH 等),再覆盖 CAI_* + LANGCHAIN_*
        const childEnv: Record<string, string> = {
          ...process.env,
          CAI_COMP_BASE_URL: this.config.get<string>('caiComp.baseUrl') ?? '',
          CAI_COMP_UID: process.env.CAI_COMP_UID ?? '',
          CAI_ATOM_TOKEN: process.env.CAI_ATOM_TOKEN ?? '',
          CAI_SSO_TOKEN: process.env.CAI_SSO_TOKEN ?? '',
          CAI_CONGRESS: process.env.CAI_CONGRESS ?? '',
          CAI_ONLINE_TICKET: process.env.CAI_ONLINE_TICKET ?? '',
          CAI_ACCESS_CODE: process.env.CAI_ACCESS_CODE ?? '',
          CAI_ACCESS_USER: process.env.CAI_ACCESS_USER ?? '',
          CAI_AUTHORIZATION: process.env.CAI_AUTHORIZATION ?? '',
          CAI_COMP_TIMEOUT_MS: String(this.config.get<number>('caiComp.timeoutMs') ?? 10000),
          CAI_COMP_MAX_RETRIES: String(this.config.get<number>('caiComp.maxRetries') ?? 1),
        };

        this.transport = new StdioClientTransport({
          command,
          args,
          env: childEnv,
          stderr: 'pipe',
        });
        this.transport.onclose = () => {
          this.logger.warn('cai-comp MCP child process closed');
          this.started = false;
        };
        this.transport.onerror = (err: Error) => {
          this.logger.error(`cai-comp MCP transport error: ${err.message}`);
        };

        this.client = new Client(
          { name: 'robot-cai-comp-client', version: '1.0.0' },
          { capabilities: {} },
        );
        await this.client.connect(this.transport);
        this.started = true;
        this.logger.log(`cai-comp MCP client started (pid via ${command} ${args.join(' ')})`);
      } catch (err) {
        this.logger.error(
          `Failed to start cai-comp MCP client: ${(err as Error).message}. ` +
            `CAI_COMP_*_TOOL will be stubbed out. ` +
            `Run: cd mcp-servers/cai-comp && npm install && npm run build`,
        );
        this.started = false;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private async stop(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
    this.started = false;
  }

  /**
   * 调一个 MCP 工具,返回其 text content 拼接成的字符串(JSON 形式)。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.started || !this.client) {
      return JSON.stringify({
        ok: false,
        status: 'unavailable',
        reason: 'cai-comp MCP server not running',
      });
    }
    try {
      const res = await this.client.callTool({ name, arguments: args });
      const content = res.content;
      if (Array.isArray(content)) {
        return content
          .map((c) =>
            typeof c === 'string' ? c : ((c as { text?: string }).text ?? ''),
          )
          .join('');
      }
      if (typeof content === 'string') return content;
      return '';
    } catch (err) {
      this.logger.warn(`cai-comp MCP callTool(${name}) failed: ${(err as Error).message}`);
      return JSON.stringify({
        ok: false,
        status: 'mcp-error',
        message: (err as Error).message,
      });
    }
  }
}
