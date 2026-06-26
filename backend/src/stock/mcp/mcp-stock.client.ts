import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { traceable } from 'langsmith/traceable';
import { Bar, FetchResult, RealtimeQuote } from '../stock.types';
import { parseKLineText, parseRealtimeText } from './daily-parser';

export const MCP_STOCK_OPTIONS = Symbol('MCP_STOCK_OPTIONS');

export interface McpStockOptions {
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  maxRetries: number;
  retryBackoffMs: number;
}

interface ToolCallPayload {
  name: string;
  args: Record<string, unknown>;
}

@Injectable()
export class McpStockClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpStockClient.name);
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private started = false;
  private starting: Promise<void> | null = null;

  constructor(
    @Inject(MCP_STOCK_OPTIONS) private readonly opts: McpStockOptions,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    if (!this.opts.enabled) {
      this.logger.warn('TUSHARE_TOKEN missing — stock analysis disabled');
      return;
    }
    await this.start();
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      try {
        this.transport = new StdioClientTransport({
          command: this.opts.command,
          args: this.opts.args,
          env: { ...this.opts.env },
          stderr: 'pipe',
        });
        this.transport.onclose = () => {
          this.logger.warn('MCP child process closed');
          this.started = false;
        };
        this.transport.onerror = (err) => {
          this.logger.error(`MCP transport error: ${err.message}`);
        };

        this.client = new Client(
          { name: 'robot-stock-client', version: '1.0.0' },
          { capabilities: {} },
        );
        await this.client.connect(this.transport);
        this.started = true;
        this.logger.log('MCP stock client started');

        await this.health().catch((err: unknown) => {
          this.logger.warn(`MCP warmup ping failed: ${(err as Error).message}`);
        });
      } catch (err) {
        this.logger.error(
          `Failed to start MCP client: ${(err as Error).message}`,
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

  private async ensureStarted(): Promise<boolean> {
    if (this.opts.enabled && !this.started) await this.start();
    return this.started;
  }

  private async callToolRaw(payload: ToolCallPayload): Promise<string> {
    if (!(await this.ensureStarted()) || !this.client) {
      throw new Error('MCP client not started');
    }
    const res = await this.client.callTool({
      name: payload.name,
      arguments: payload.args,
    });
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
  }

  private async callWithRetry(payload: ToolCallPayload): Promise<string> {
    const max = Math.max(1, this.opts.maxRetries);
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const text = await this.callToolRaw(payload);
        if (
          text &&
          !text.includes('获取股票每日行情数据失败') &&
          !text.includes('获取实时日K线行情失败')
        ) {
          return text;
        }
        lastErr = new Error(text || `tool ${payload.name} returned empty`);
      } catch (err) {
        lastErr = err as Error;
        // Restart on next attempt in case the child died.
        if (!this.started) await this.start();
      }
      if (attempt < max) await sleep(this.opts.retryBackoffMs);
    }
    throw lastErr ?? new Error(`tool ${payload.name} failed`);
  }

  private dateRangeNDays(days: number): { start: string; end: string } {
    const fmt = (d: Date) =>
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    return { start: fmt(start), end: fmt(end) };
  }

  getDaily = traceable(
    async (tsCode: string, days = 90): Promise<FetchResult<Bar[]>> => {
      const { start, end } = this.dateRangeNDays(days);
      return this.callKLine('daily', tsCode, start, end);
    },
    { name: 'mcp.getDaily', run_type: 'tool' },
  );

  getWeekly = traceable(
    async (tsCode: string, weeks = 52): Promise<FetchResult<Bar[]>> => {
      const { start, end } = this.dateRangeNDays(weeks * 7);
      return this.callKLine('weekly', tsCode, start, end);
    },
    { name: 'mcp.getWeekly', run_type: 'tool' },
  );

  getMonthly = traceable(
    async (tsCode: string, months = 36): Promise<FetchResult<Bar[]>> => {
      const { start, end } = this.dateRangeNDays(months * 30);
      return this.callKLine('monthly', tsCode, start, end);
    },
    { name: 'mcp.getMonthly', run_type: 'tool' },
  );

  getRealtime = traceable(
    async (tsCode: string): Promise<FetchResult<RealtimeQuote>> => {
      if (!(await this.ensureStarted())) {
        return { status: 'error', message: 'MCP client not started' };
      }
      try {
        const text = await this.callWithRetry({
          name: 'rt_k',
          args: { ts_code: tsCode },
        });
        return parseRealtimeText(text);
      } catch (err) {
        return { status: 'error', message: (err as Error).message };
      }
    },
    { name: 'mcp.getRealtime', run_type: 'tool' },
  );

  async health(): Promise<boolean> {
    if (!(await this.ensureStarted()) || !this.client) return false;
    try {
      const text = await this.callToolRaw({ name: 'current_time', args: {} });
      return !!text;
    } catch {
      return false;
    }
  }

  private async callKLine(
    name: 'daily' | 'weekly' | 'monthly',
    tsCode: string,
    start: string,
    end: string,
  ): Promise<FetchResult<Bar[]>> {
    if (!(await this.ensureStarted())) {
      return { status: 'error', message: 'MCP client not started' };
    }
    try {
      const text = await this.callWithRetry({
        name,
        args: { ts_code: tsCode, start_date: start, end_date: end },
      });
      return parseKLineText(text);
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const mcpStockClientFactory = {
  provide: McpStockClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const token = config.get<string>('stock.tushareToken');
    const args = config.get<string[]>('stock.mcpArgs') ?? [
      '-y',
      '@pidanmoe/mcp-stock',
    ];
    const opts: McpStockOptions = {
      enabled: !!token,
      command: config.get<string>('stock.mcpCommand') ?? 'npx',
      args,
      env: token ? { TUSHARE_TOKEN: token } : {},
      maxRetries: config.get<number>('stock.maxRetries') ?? 2,
      retryBackoffMs: config.get<number>('stock.retryBackoffMs') ?? 500,
    };
    return new McpStockClient(opts, config);
  },
};
