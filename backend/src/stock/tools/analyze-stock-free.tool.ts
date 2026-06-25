import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { StockAnalysisService } from '../stock-analysis.service';
import { normalizeTsCode } from '../normalize-ts-code';

const NO_DATA = 'No data available for analysis';
const INSUFFICIENT = 'Data insufficient for reliable analysis';

const TOOL_DESCRIPTION = [
  '【免费版】分析 A 股个股的技术面。基于新浪财经 HTTP API (无需 Tushare Token) 拉取 K 线数据,',
  '计算 MA/EMA、MACD、RSI、BOLL、KDJ 等技术指标,',
  '生成离散信号(均线排列、金叉死叉、超买超卖、突破等)和综合趋势判断(偏多/偏空/震荡 + 置信度)。',
  '',
  '【何时使用】优先调用此工具。如果此工具返回 status="no-data",可以再试 analyze_stock (Tushare 版)。',
  '',
  '【分析诚信规则 - 必须严格遵守】',
  '1) 如果工具返回 status="no-data",你必须原样回复 "No data available for analysis" 并停止。',
  '2) 如果工具返回 status="insufficient",你必须原样回复 "Data insufficient for reliable analysis" 并停止。',
  '3) 绝不捏造、估算或幻觉任何价格、指标或信号。仅引用工具返回的实际数据。',
  '4) 总结应定性表述(方向、关键信号、置信度),不要把完整的 OHLCV 行或指标数列粘贴出来。',
  '',
  '参数说明:',
  '- ts_code: 6 位 A 股代码(如 300033、600519、000001),也可带后缀 300033.SZ / 600519.SH',
  '- range: short(约 45 个交易日) / medium(约 90,默认) / long(约 365)',
].join('\n');

export function buildAnalyzeStockFreeTool(
  service: StockAnalysisService,
): DynamicStructuredTool {
  const schema = z.object({
    ts_code: z
      .string()
      .regex(
        /^(\d{6}|\d{6}\.(SH|SZ|BJ)|(SH|SZ|BJ)\d{6})$/i,
        'ts_code must be 6 digits, optionally with .SH/.SZ/.BJ suffix',
      )
      .describe('6 位 A 股代码,如 300033、600519、000001'),
    range: z
      .enum(['short', 'medium', 'long'])
      .optional()
      .describe('分析窗口长度,默认 medium'),
  });

  return new DynamicStructuredTool({
    name: 'analyze_stock_free',
    description: TOOL_DESCRIPTION,
    schema,
    func: async (input: {
      ts_code: string;
      range?: 'short' | 'medium' | 'long';
    }) => {
      const tsCode = normalizeTsCode(input.ts_code);
      if (!tsCode) {
        return JSON.stringify({
          status: 'no-data',
          required_reply: NO_DATA,
          reason: `invalid ts_code: ${input.ts_code}`,
        });
      }
      try {
        const result = await service.analyze({
          ts_code: tsCode,
          range: input.range ?? 'medium',
        });

        if (result.status === 'no-data') {
          return JSON.stringify({ status: 'no-data', required_reply: NO_DATA });
        }
        if (result.status === 'insufficient') {
          return JSON.stringify({
            status: 'insufficient',
            required_reply: INSUFFICIENT,
          });
        }

        const { chart_payload, indicators, ...summary } = result;
        void chart_payload;
        void indicators;
        return JSON.stringify(summary);
      } catch (err) {
        return JSON.stringify({
          status: 'no-data',
          required_reply: NO_DATA,
          error: (err as Error).message,
        });
      }
    },
  });
}
