import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { McpStockClient, mcpStockClientFactory } from './mcp/mcp-stock.client';
import { SinaClient } from './providers/sina/sina-client';
import { IndicatorService } from './indicators/indicator.service';
import { SignalDeriver } from './analysis/signal.deriver';
import { TrendScorer } from './analysis/trend.scorer';
import { StockAnalysisService } from './stock-analysis.service';
import { buildAnalyzeStockTool } from './tools/analyze-stock.tool';
import { buildAnalyzeStockFreeTool } from './tools/analyze-stock-free.tool';

/**
 * Symbol tokens for the two analysis-service instances + their tool wrappers.
 * StockAnalysisService is now provider-agnostic, so we instantiate it twice
 * with different data sources.
 */
export const MCP_ANALYSIS_SERVICE = Symbol('MCP_ANALYSIS_SERVICE');
export const SINA_ANALYSIS_SERVICE = Symbol('SINA_ANALYSIS_SERVICE');
export const ANALYZE_STOCK_TOOL = Symbol('ANALYZE_STOCK_TOOL');
export const ANALYZE_STOCK_FREE_TOOL = Symbol('ANALYZE_STOCK_FREE_TOOL');

@Module({
  imports: [ConfigModule],
  providers: [
    mcpStockClientFactory,
    SinaClient,
    IndicatorService,
    SignalDeriver,
    TrendScorer,
    {
      provide: MCP_ANALYSIS_SERVICE,
      inject: [McpStockClient, IndicatorService, SignalDeriver, TrendScorer],
      useFactory: (
        mcp: McpStockClient,
        ind: IndicatorService,
        deriver: SignalDeriver,
        scorer: TrendScorer,
      ) =>
        new StockAnalysisService(
          mcp,
          ind,
          deriver,
          scorer,
          'StockAnalysisService',
        ),
    },
    {
      provide: SINA_ANALYSIS_SERVICE,
      inject: [SinaClient, IndicatorService, SignalDeriver, TrendScorer],
      useFactory: (
        sina: SinaClient,
        ind: IndicatorService,
        deriver: SignalDeriver,
        scorer: TrendScorer,
      ) =>
        new StockAnalysisService(
          sina,
          ind,
          deriver,
          scorer,
          'StockAnalysisService(Sina)',
        ),
    },
    {
      provide: ANALYZE_STOCK_TOOL,
      inject: [MCP_ANALYSIS_SERVICE, ConfigService],
      useFactory: (
        svc: StockAnalysisService,
        config: ConfigService,
      ): DynamicStructuredTool => {
        const token = config.get<string>('stock.tushareToken');
        if (!token) {
          // No token — stub tool that always returns no-data honestly.
          return new DynamicStructuredTool({
            name: 'analyze_stock',
            description:
              '分析 A 股个股的技术面 (Tushare 版,当前已禁用: 未配置 TUSHARE_TOKEN)。' +
              '若被调用,必须原样回复 "No data available for analysis"。' +
              '请优先使用 analyze_stock_free 工具。',
            schema: z.object({ ts_code: z.string().optional() }),
            func: () =>
              Promise.resolve(
                JSON.stringify({
                  status: 'no-data',
                  required_reply: 'No data available for analysis',
                }),
              ),
          });
        }
        return buildAnalyzeStockTool(svc);
      },
    },
    {
      provide: ANALYZE_STOCK_FREE_TOOL,
      inject: [SINA_ANALYSIS_SERVICE],
      useFactory: (svc: StockAnalysisService) => buildAnalyzeStockFreeTool(svc),
    },
  ],
  exports: [
    ANALYZE_STOCK_TOOL,
    ANALYZE_STOCK_FREE_TOOL,
    MCP_ANALYSIS_SERVICE,
    SINA_ANALYSIS_SERVICE,
    McpStockClient,
    SinaClient,
  ],
})
export class StockModule {}
