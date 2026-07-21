import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { CHAT_MODEL } from './chat.constants';

/**
 * Phase 1 验证端点 —— 检查 DashScope Anthropic 兼容网关是否真支持 prompt caching。
 *
 * 流程:
 *   1. 构造 >= 1024 token 的长 prompt(SYSTEM_PROMPT + 工具描述)
 *   2. 第一次调用:不带 cache_control
 *   3. 第二次调用:在 prompt 末尾加 cache_control: { type: 'ephemeral' }
 *   4. 对比两次 response 的 usage.cache_read_input_tokens / cache_creation_input_tokens
 *
 * 用法:
 *   curl http://localhost:3000/api/chat/cache-test
 *
 * 返回:
 *   { supported: boolean, withoutCache: Usage, withCache: Usage }
 *
 * 这是 spike 端点,Phase 1 通过后可考虑删除或保留作为 regression check。
 */

const LONG_PROMPT = [
  '你是一个乐于助人的中文助理,擅长一般问答,并对中国 A 股个股做技术面分析 + 新闻检索。',
  '',
  '## 工具选择',
  '- analyze_stock_free:用户问 K 线 / 走势 / 技术指标 / 趋势分析时调用。',
  '- analyze_stock:Tushare 版本,fallback 用。',
  '- search_news:用户问"最近有什么新闻 / 消息 / 公告"时调用。',
  '- list_comps:用户问公司组件中心时调用,分页返回组件摘要。',
  '- get_comp_detail:已知组件 ID 时查详情。',
  '',
  '## 调用 analyze_stock_free 后',
  '工具返回 JSON,status 字段决定行为:',
  '- status="ok":基于 trend.direction、trend.confidence、signals 写中文总结。',
  '- status="no-data":用 required_reply 原样回复 "No data available for analysis",停止。',
  '- status="insufficient":同理,原样回复 "Data insufficient for reliable analysis"。',
  '',
  '## 调用 list_comps 后',
  '工具返回 { total, data: [...] },每条含 id / name / alias / packageName / version / committer。',
  'data[].id 可作为 get_comp_detail 入参。',
  '',
  '## 调用 search_news 后',
  '工具返回编号片段([1]/[2]/...),每条带 title + 日期 + 链接 + 内容摘要。',
  '写总结时必须引用至少一个编号。',
  '',
  '## 分析诚信',
  '绝不捏造、估算或幻觉任何价格、指标、信号或新闻。仅引用工具返回的数据。',
  '',
  '## 详细工具描述(用于让本 prompt 达到 Anthropic 最小缓存长度 1024 token)',
  '',
  '### analyze_stock_free 详细描述',
  '【免费版】分析 A 股个股的技术面。基于新浪财经 HTTP API (无需 Tushare Token) 拉取 K 线数据,',
  '计算 MA/EMA、MACD、RSI、BOLL、KDJ 等技术指标,',
  '生成离散信号(均线排列、金叉死叉、超买超卖、突破等)和综合趋势判断(偏多/偏空/震荡 + 置信度)。',
  '【分析诚信规则 - 必须严格遵守】',
  '1) 如果工具返回 status="no-data",你必须原样回复 "No data available for analysis" 并停止。',
  '2) 如果工具返回 status="insufficient",你必须原样回复 "Data insufficient for reliable analysis" 并停止。',
  '3) 绝不捏造、估算或幻觉任何价格、指标或信号。仅引用工具返回的实际数据。',
  '4) 总结应定性表述(方向、关键信号、置信度),不要把完整的 OHLCV 行或指标数列粘贴出来。',
  '参数说明:',
  '- ts_code: 6 位 A 股代码(如 300033、600519、000001),也可带后缀 300033.SZ / 600519.SH',
  '- range: short(约 45 个交易日) / medium(约 90,默认) / long(约 365)',
  '',
  '### search_news 详细描述',
  '从本地向量库检索新闻。输入 query 字符串,工具做 embedding 相似度搜索,返回 top-K 条新闻。',
  '每条返回格式:[编号] title | date | url | content摘要。',
  '模型写总结时必须引用编号,例如"据 [1] 报道..."。如果工具返回 loading/empty/failed 提示,如实告知用户。',
  '',
  '### list_comps / get_comp_detail 详细描述',
  '公司内部组件中心查询。list_comps 分页列出,get_comp_detail 查单个组件详情。',
  'Auth 通过 env vars 注入,token 过期时返 status="unauthorized"。',
  '',
  // ↓ 故意填充到 2K+ token,稳过 Anthropic 1024 token 最小阈值
  '## 附录:常见股票指标计算原理(填充内容,用于触发 prompt caching 缓存阈值)',
  '',
  '### MA 移动平均线',
  'MA5 = 最近 5 个交易日收盘价之和 / 5。反映短期趋势。',
  'MA10 / MA20 / MA60 同理,只是窗口长度不同。多头排列:MA5 > MA10 > MA20 > MA60,',
  '说明短期成本 > 中期 > 长期,价格上涨动能强。空头排列相反。金叉:短期 MA 上穿长期 MA,',
  '看多信号;死叉:短期下穿长期,看空。',
  '',
  '### MACD',
  'MACD = 12 EMA - 26 EMA。Signal = MACD 的 9 EMA。Histogram = MACD - Signal。',
  '金叉:MACD 上穿 Signal → 看多。死叉:MACD 下穿 Signal → 看空。',
  '柱状图变长说明动能增强,变短说明动能减弱。',
  '',
  '### RSI',
  'RSI = 平均涨幅 / (平均涨幅 + 平均跌幅) * 100。取值 0-100。',
  'RSI > 70:超买,可能回调。RSI < 30:超卖,可能反弹。',
  '6 日 RSI 短期,12 日中期,24 日长期。',
  '',
  '### BOLL 布林带',
  'BOLL = MA20 ± 2 * 标准差。上轨、中轨、下轨。',
  '突破上轨:超买或趋势加速。跌破下轨:超卖或加速下跌。',
  '带宽收窄说明波动率低,可能酝酿大行情。',
  '',
  '### KDJ',
  'K = RSI 的指数平均。D = K 的指数平均。J = 3K - 2D。',
  'J > 100:超买。J < 0:超卖。金叉(K 上穿 D)看多,死叉看空。',
  '',
  '### 成交量分析',
  '放量上涨:有资金推动,趋势确认。缩量上涨:动能不足。',
  '量价背离:价涨量缩 / 价跌量增,转势信号。',
  'VOLMA5 / VOLMA10 是成交量均线,用于过滤单日异常。',
  '',
  '### 趋势综合判断',
  '综合 MA 排列 + MACD 状态 + RSI 区间 + 量价 + 突破信号,',
  '输出 direction(bullish/bearish/neutral)+ confidence(0-1)。',
  'confidence 计算逻辑:多个信号同向 → 高;信号矛盾 → 低;信号缺失 → 0.3。',
].join('\n');

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface CacheTestResult {
  supported: boolean;
  withoutCache: Usage | undefined;
  withCache: Usage | undefined;
  note?: string;
}

@Controller('chat')
export class CacheTestController {
  private readonly logger = new Logger(CacheTestController.name);

  constructor(@Inject(CHAT_MODEL) private readonly model: ChatAnthropic) {}

  @Get('cache-test')
  async run(): Promise<CacheTestResult> {
    const human = new HumanMessage('你好');

    // ── 1. 第一次调用:不带 cache_control ─────────────────────────────
    const promptNoCache = new SystemMessage({
      content: [{ type: 'text', text: LONG_PROMPT }],
    });
    let r1: AIMessage;
    try {
      r1 = (await this.model.invoke([promptNoCache, human])) as AIMessage;
    } catch (err) {
      this.logger.error(`first call failed: ${(err as Error).message}`);
      return {
        supported: false,
        withoutCache: undefined,
        withCache: undefined,
        note: `first call failed: ${(err as Error).message}`,
      };
    }
    const u1 = extractUsage(r1);

    // ── 2. 第二次调用:在 prompt 末尾加 cache_control ────────────────
    const promptWithCache = new SystemMessage({
      content: [
        { type: 'text', text: LONG_PROMPT },
        { type: 'text', text: ' ', cache_control: { type: 'ephemeral' } },
      ],
    });
    let r2: AIMessage;
    try {
      r2 = (await this.model.invoke([promptWithCache, human])) as AIMessage;
    } catch (err) {
      this.logger.error(`second call failed: ${(err as Error).message}`);
      return {
        supported: false,
        withoutCache: u1,
        withCache: undefined,
        note: `second call failed: ${(err as Error).message}`,
      };
    }
    const u2 = extractUsage(r2);

    // ── 3. 判定 ──────────────────────────────────────────────────────
    // supported = 第二次响应里出现了 cache 字段(无论 read 还是 creation)
    // 注:第一次也可能命中(若 5 分钟内已有同样 prefix 被 cache 过),所以
    // 严格判定"是否支持"看第二次是否出现了 cache_creation/cache_read 任一字段
    const supported =
      (u2.cache_read_input_tokens ?? 0) > 0 ||
      (u2.cache_creation_input_tokens ?? 0) > 0;

    this.logger.log(
      `cache-test result: supported=${supported} ` +
        `withoutCache(cache_read=${u1.cache_read_input_tokens ?? 0}, ` +
        `creation=${u1.cache_creation_input_tokens ?? 0}, ` +
        `input=${u1.input_tokens ?? 0}) ` +
        `withCache(cache_read=${u2.cache_read_input_tokens ?? 0}, ` +
        `creation=${u2.cache_creation_input_tokens ?? 0}, ` +
        `input=${u2.input_tokens ?? 0})`,
    );

    return { supported, withoutCache: u1, withCache: u2 };
  }
}

function extractUsage(msg: AIMessage): Usage {
  const meta = msg.response_metadata as { usage?: Usage } | undefined;
  return (
    meta?.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
  );
}
