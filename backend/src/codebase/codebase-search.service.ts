import { Injectable, Logger } from '@nestjs/common';
import { PostgresPoolService } from '../postgres/postgres-pool.service';
import { GLMEmbedder } from './glm-embedder';
import { GLMChatClient } from './glm-chat';

export interface CodebaseSearchResult {
  content: string;
  score: number;
  metadata: {
    file_path: string;
    language: string;
    type: 'code' | 'markdown';
    start_line: number;
    end_line: number;
    headers?: Record<string, string>;
  };
  project_name: string;
  vec_score?: number;
  kw_score?: number;
  rerank_score?: number;
}

/**
 * CodebaseSearchService —— 代码库 + 文档 混合搜索
 *
 * Hybrid Search:
 *   1. 向量搜索 top-N(语义匹配,GLM embedding)
 *   2. 关键词 ILIKE 搜索 top-N(精确匹配,中文按 2-char bigram 切)
 *   3. 按 id 合并,加权打分 0.7*vec + 0.3*kw
 *   4. 返 top-K
 *
 * 为什么需要 hybrid:
 *   纯向量搜索"本地开发文档" → 跟 README 里"npm install"语义远,搜不到
 *   加关键词搜索 → "开发" 直接命中 README 里含"开发"的 chunk
 */
@Injectable()
export class CodebaseSearchService {
  private readonly logger = new Logger(CodebaseSearchService.name);
  private readonly embedder: GLMEmbedder;
  private readonly chatClient: GLMChatClient;
  private readonly rewriteEnabled: boolean;
  private readonly rerankEnabled: boolean;
  private readonly autoMergeEnabled: boolean;
  private readonly hydeEnabled: boolean;
  private readonly similarityThreshold: number;
  // query 改写缓存(同 query 5 分钟内复用)
  private readonly rewriteCache = new Map<string, { ts: number; variants: string[] }>();
  // HyDE 假想回答缓存(同 query 5 分钟内复用)
  private readonly hydeCache = new Map<string, { ts: number; text: string; embedding: number[] }>();
  private static readonly REWRITE_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(private readonly poolSvc: PostgresPoolService) {
    this.embedder = new GLMEmbedder({
      apiKey: process.env.GLM_API_KEY ?? '',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'embedding-3',
      dimensions: 512,
    });
    this.chatClient = new GLMChatClient({
      apiKey: process.env.GLM_API_KEY ?? '',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: process.env.CODEBASE_LLM_MODEL ?? 'glm-4-flash',
    });
    this.rewriteEnabled = process.env.CODEBASE_QUERY_REWRITE_ENABLED !== 'false';
    this.rerankEnabled = process.env.CODEBASE_RERANK_ENABLED !== 'false';
    this.autoMergeEnabled = process.env.CODEBASE_AUTO_MERGE_ENABLED !== 'false';
    this.hydeEnabled = process.env.CODEBASE_HYDE_ENABLED !== 'false';
    this.similarityThreshold = parseFloat(process.env.CODEBASE_SIMILARITY_THRESHOLD ?? '0.3');
  }

  async search(query: string, topK = 5, project?: string): Promise<CodebaseSearchResult[]> {
    if (!this.poolSvc.isAvailable()) {
      this.logger.warn('Postgres not available, returning empty results');
      return [];
    }

    try {
      const keywords = this.extractKeywords(query);

      // ─── 1. Query Rewriting:用 LLM 把 query 改写成 3 个变体 ───
      let queriesForSearch = [query];
      if (this.rewriteEnabled) {
        const variants = await this.rewriteQuerySafe(query);
        if (variants.length > 0) {
          queriesForSearch = [query, ...variants];
        }
      }

      // ─── 1b. HyDE:用 LLM 生成假想回答,把它的 embedding 也加入 multi-query 集 ───
      // 假想回答比原 query 更接近实际文档语义,召回率提升 20-40%
      const hydeEmbedding = this.hydeEnabled ? await this.hydeEmbedSafe(query) : null;

      // ─── 2. Multi-Query Search:对每个 query(原 + 变体)+ HyDE embedding 做向量搜索 ───
      const allVecResults: Map<string, { id: string; content: string; metadata: any; project_name: string; vec_score: number }> = new Map();
      for (const q of queriesForSearch) {
        const emb = await this.embedder.embedQuery(q);
        const results = await this.vectorSearch(emb, 20, project);
        for (const r of results) {
          // 合并去重 by id,保留最高 vec_score
          const existing = allVecResults.get(r.id);
          if (!existing || r.vec_score > existing.vec_score) {
            allVecResults.set(r.id, r);
          }
        }
      }
      // HyDE 假想回答单独搜一次(embedding 已生成,不重复 embed)
      if (hydeEmbedding) {
        const results = await this.vectorSearch(hydeEmbedding, 20, project);
        for (const r of results) {
          const existing = allVecResults.get(r.id);
          if (!existing || r.vec_score > existing.vec_score) {
            allVecResults.set(r.id, r);
          }
        }
      }

      // ─── 3. 关键词搜索(对原 query,不变) ───
      const kwResults = keywords.length > 0
        ? await this.keywordSearch(keywords, 20, project)
        : [];

      // ─── 4. Hybrid 加权合并 ───
      const vecArr = Array.from(allVecResults.values());
      const merged = this.mergeAndScore(vecArr, kwResults);

      // 取 top-20 候选(为 rerank 准备)
      const candidates = merged.sort((a, b) => b.score - a.score).slice(0, 20);

      if (candidates.length === 0) {
        this.logger.log(
          `no results for query: "${query.slice(0, 30)}"${project ? ` in project "${project}"` : ''}`,
        );
        return [];
      }

      // ─── 5. Rerank:LLM 对 top-20 候选打分 ───
      let final: CodebaseSearchResult[];
      if (this.rerankEnabled && candidates.length > 1) {
        final = await this.rerankSafe(query, candidates, topK);
      } else {
        final = candidates.slice(0, topK);
      }

      // ─── 6. AutoMerging:同文件 + 行号相邻 → 合并成大 chunk ───
      if (this.autoMergeEnabled && final.length > 1) {
        const beforeCount = final.length;
        final = this.autoMerge(final);
        if (final.length < beforeCount) {
          this.logger.log(`autoMerge: ${beforeCount} → ${final.length} chunks (merged adjacent)`);
        }
      }

      this.logger.log(
        `search "${query.slice(0, 30)}"${project ? ` [${project}]` : ''}: ${final.length} results, top hybrid=${final[0].score?.toFixed(3)} (vec=${final[0].vec_score?.toFixed(3)}, kw=${final[0].kw_score?.toFixed(3)}${final[0].rerank_score !== undefined ? `, rerank=${final[0].rerank_score}` : ''})`,
      );

      return final;
    } catch (err) {
      this.logger.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }

  async listProjects(): Promise<string[]> {
    if (!this.poolSvc.isAvailable()) return [];
    try {
      const res = await this.poolSvc.pool!.query(
        'SELECT DISTINCT project_name FROM codebase_vectors WHERE project_name != \'\' ORDER BY project_name',
      );
      return res.rows.map((r) => r.project_name as string);
    } catch {
      return [];
    }
  }

  // ─── 内部:向量搜索 ───────────────────────────────────────────────

  private async vectorSearch(
    embedding: number[],
    limit: number,
    project?: string,
  ): Promise<Array<{ id: string; content: string; metadata: any; project_name: string; vec_score: number }>> {
    const emb = `[${embedding.join(',')}]`;
    // SimilarityPostprocessor:过滤 cosine 相似度低于阈值的 chunk,防低分噪声进 prompt
    const threshold = this.similarityThreshold;
    const sql = project
      ? `SELECT id, content, metadata, project_name, 1 - (embedding <=> $1) AS vec_score
         FROM codebase_vectors
         WHERE project_name = $3 AND 1 - (embedding <=> $1) >= $4
         ORDER BY embedding <=> $1
         LIMIT $2`
      : `SELECT id, content, metadata, project_name, 1 - (embedding <=> $1) AS vec_score
         FROM codebase_vectors
         WHERE 1 - (embedding <=> $1) >= $3
         ORDER BY embedding <=> $1
         LIMIT $2`;
    const params = project ? [emb, limit, project, threshold] : [emb, limit, threshold];
    const result = await this.poolSvc.pool!.query(sql, params);
    return result.rows.map((r) => ({
      id: String(r.id),
      content: r.content,
      metadata: r.metadata,
      project_name: r.project_name ?? '',
      vec_score: parseFloat(r.vec_score),
    }));
  }

  // ─── 内部:关键词搜索 ─────────────────────────────────────────────

  private async keywordSearch(
    keywords: string[],
    limit: number,
    project?: string,
  ): Promise<Array<{ id: string; content: string; metadata: any; project_name: string; kw_score: number }>> {
    // 每个 keyword 一个 ILIKE 条件,匹配数 = kw_score
    const ilikeConds = keywords.map((_, i) => `content ILIKE $${i + 2}`).join(' OR ');
    const scoreExpr = keywords.map((_, i) => `CASE WHEN content ILIKE $${i + 2} THEN 1 ELSE 0 END`).join(' + ');

    const sql = project
      ? `SELECT id, content, metadata, project_name,
                (${scoreExpr})::FLOAT / $1 AS kw_score
         FROM codebase_vectors
         WHERE project_name = $${keywords.length + 2} AND (${ilikeConds})
         ORDER BY kw_score DESC
         LIMIT $${keywords.length + 3}`
      : `SELECT id, content, metadata, project_name,
                (${scoreExpr})::FLOAT / $1 AS kw_score
         FROM codebase_vectors
         WHERE ${ilikeConds}
         ORDER BY kw_score DESC
         LIMIT $${keywords.length + 2}`;

    const totalKw = keywords.length;
    const ilikePatterns = keywords.map((k) => `%${k}%`);
    const params = project
      ? [totalKw, ...ilikePatterns, project, limit]
      : [totalKw, ...ilikePatterns, limit];

    try {
      const result = await this.poolSvc.pool!.query(sql, params);
      return result.rows.map((r) => ({
        id: String(r.id),
        content: r.content,
        metadata: r.metadata,
        project_name: r.project_name ?? '',
        kw_score: parseFloat(r.kw_score),
      }));
    } catch (err) {
      this.logger.warn(`keyword search failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ─── 内部:合并 + 加权打分 ────────────────────────────────────────

  private mergeAndScore(
    vecResults: Array<{ id: string; content: string; metadata: any; project_name: string; vec_score: number }>,
    kwResults: Array<{ id: string; content: string; metadata: any; project_name: string; kw_score: number }>,
  ): CodebaseSearchResult[] {
    const map = new Map<string, CodebaseSearchResult & { vec_score: number; kw_score: number }>();

    const VEC_WEIGHT = 0.7;
    const KW_WEIGHT = 0.3;

    for (const r of vecResults) {
      map.set(r.id, {
        content: r.content,
        metadata: r.metadata,
        project_name: r.project_name,
        score: VEC_WEIGHT * r.vec_score,
        vec_score: r.vec_score,
        kw_score: 0,
      });
    }

    for (const r of kwResults) {
      const existing = map.get(r.id);
      if (existing) {
        existing.kw_score = r.kw_score;
        existing.score = VEC_WEIGHT * existing.vec_score + KW_WEIGHT * r.kw_score;
      } else {
        map.set(r.id, {
          content: r.content,
          metadata: r.metadata,
          project_name: r.project_name,
          score: KW_WEIGHT * r.kw_score,
          vec_score: 0,
          kw_score: r.kw_score,
        });
      }
    }

    return Array.from(map.values());
  }

  // ─── 内部:HyDE 假想回答 embedding ──────────────────────────────────

  /**
   * HyDE (Hypothetical Document Embedding):
   * 用 LLM 生成"假想回答",用假想回答的 embedding 搜
   * 假想回答的语义比原 query 更接近实际文档,召回率提升 20-40%
   *
   * 例:用户问"本地开发文档有吗"
   *   原 query embedding 跟 README 里"npm install"语义远
   *   LLM 生成假想回答:"本地开发文档在 README.md,含 npm install 步骤"
   *   假想回答的 embedding 跟 README 里"npm install"更接近 → 命中
   *
   * 失败时返 null(降级为不用 HyDE)
   * 5 分钟缓存(同 query 复用假想回答 + embedding)
   */
  private async hydeEmbedSafe(query: string): Promise<number[] | null> {
    // 查缓存
    const cached = this.hydeCache.get(query);
    if (cached && Date.now() - cached.ts < CodebaseSearchService.REWRITE_CACHE_TTL_MS) {
      this.logger.log(`hyde cache hit: "${query.slice(0, 30)}"`);
      return cached.embedding;
    }

    try {
      const systemPrompt = [
        '你是一个代码/文档助手。基于用户查询,生成一个简短的假想答案(50 字以内)。',
        '即使你不知道实际内容,也写一个合理的可能答案 — 这个答案会被 embedding 后用于检索。',
        '直接输出答案文本,不要解释,不要 markdown。',
        '',
        '示例:',
        '查询: "本地开发文档有吗"',
        '答案: 本地开发文档在 README.md 中,包含 npm install 步骤和 npm run dev 启动命令。',
        '',
        '查询: "useChat hook 怎么实现"',
        '答案: useChat hook 在 hooks/useChat.ts,使用 EventSource 接收 SSE 流,管理 messages 状态。',
      ].join('\n');

      const hypotheticalAnswer = await this.chatClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        { temperature: 0.3, maxTokens: 100 },
      );

      const cleaned = hypotheticalAnswer.trim();
      if (!cleaned) {
        this.logger.warn('hyde: LLM returned empty answer, skip');
        return null;
      }

      const embedding = await this.embedder.embedQuery(cleaned);
      this.hydeCache.set(query, { ts: Date.now(), text: cleaned, embedding });

      this.logger.log(`hyde generate: "${query.slice(0, 30)}" → "${cleaned.slice(0, 60)}${cleaned.length > 60 ? '...' : ''}"`);
      return embedding;
    } catch (err) {
      this.logger.warn(`hyde failed: ${(err as Error).message.slice(0, 100)}, fallback to no HyDE`);
      return null;
    }
  }

  // ─── 内部:AutoMerging 相邻 chunk 合并 ──────────────────────────────

  /**
   * 同 file_path + 前者 end_line + 1 >= 后者 start_line → 合并
   * 合并 content(中间加换行),end_line 取后者
   * 不合并不同文件 / 不相邻的同文件 chunk
   *
   * 为什么需要:CodeSplitter 按 AST 切,一个文件切成 5-10 个小 chunk,
   * top-5 可能都是同文件的相邻 chunk → LLM 看不到完整逻辑
   * 合并后 chunk 数减少,但每个 content 更完整
   */
  private autoMerge(candidates: CodebaseSearchResult[]): CodebaseSearchResult[] {
    const merged: CodebaseSearchResult[] = [];
    for (const c of candidates) {
      const last = merged[merged.length - 1];
      if (last
          && last.metadata.file_path === c.metadata.file_path
          && last.metadata.end_line + 1 >= c.metadata.start_line) {
        // 合并到 last
        last.content += '\n' + c.content;
        last.metadata.end_line = Math.max(last.metadata.end_line, c.metadata.end_line);
        // score 取较高者(保留信息)
        if (c.score > last.score) last.score = c.score;
        if ((c.vec_score ?? 0) > (last.vec_score ?? 0)) last.vec_score = c.vec_score;
      } else {
        merged.push({ ...c });
      }
    }
    return merged;
  }

  // ─── 内部:Query Rewriting(LLM 改写) ────────────────────────────

  /**
   * 用 LLM 把用户 query 改写成 3 个变体:
   *   1. 中文同义词/概括重述
   *   2. 英文 + 文件名/技术词
   *   3. 更具体/更概括的版本
   *
   * 失败时返空数组(降级为只用原 query)
   * 5 分钟缓存(同 query 复用结果)
   */
  private async rewriteQuerySafe(query: string): Promise<string[]> {
    // 查缓存
    const cached = this.rewriteCache.get(query);
    if (cached && Date.now() - cached.ts < CodebaseSearchService.REWRITE_CACHE_TTL_MS) {
      return cached.variants;
    }

    try {
      const systemPrompt = [
        '你是查询改写助手,用于代码/文档检索。把用户的查询改写成 3 个**互不相同**的变体,以扩大召回。',
        '变体必须遵循以下格式,严格输出 JSON 数组:',
        '- 变体 1(中文同义词):用不同的中文词表达同样意图',
        '- 变体 2(英文技术词):翻译成英文 + 加常见文件名/技术名词',
        '- 变体 3(具体动作):用具体的操作词或文件名',
        '',
        '示例 1:',
        '输入: "本地开发文档有吗"',
        '输出: ["开发指南 启动 运行", "README getting started development guide", "npm run dev 安装"]',
        '',
        '示例 2:',
        '输入: "原子标题组件的核心逻辑"',
        '输出: ["主组件 实现原理", "Title component main entry logic", "SubTitleConfig 渲染 配置"]',
        '',
        '严格输出 JSON 数组,3 个字符串,不要任何额外文字,不要 markdown 代码块。',
      ].join('\n');

      const content = await this.chatClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `原查询:${query}` },
        ],
        { temperature: 0.3, maxTokens: 300 },
      );

      // 解析 JSON(宽容点:剥掉 ```json 标记)
      const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const variants = JSON.parse(cleaned);
      if (!Array.isArray(variants)) throw new Error('not array');
      const result = variants
        .filter((v) => typeof v === 'string' && v.trim().length > 0)
        .map((v: string) => v.trim())
        .slice(0, 3);

      this.rewriteCache.set(query, { ts: Date.now(), variants: result });
      this.logger.log(`query rewrite: "${query.slice(0, 30)}" → ${result.length} variants: ${result.map((v) => `"${v.slice(0, 20)}"`).join(', ')}`);
      return result;
    } catch (err) {
      this.logger.warn(`query rewrite failed: ${(err as Error).message.slice(0, 100)}, fallback to original query only`);
      return [];
    }
  }

  // ─── 内部:Rerank(LLM 重排) ──────────────────────────────────────

  /**
   * 用 LLM 对 top-20 候选打分(0-10),按分排序返 top-K
   * 一次性传所有候选(batch 模式),避免 N 次串行调用
   * 失败时返原顺序的 top-K(降级)
   */
  private async rerankSafe(
    query: string,
    candidates: CodebaseSearchResult[],
    topK: number,
  ): Promise<CodebaseSearchResult[]> {
    try {
      const systemPrompt = [
        '你是相关性打分助手。对每个候选内容,根据它与查询的相关性打分(0-10,10 最相关)。',
        '输出严格 JSON 数组,每项 { "index": <候选序号从0开始>, "score": <0-10> }',
        '不要任何额外文字,不要 markdown 代码块。',
      ].join('\n');

      // 把候选拼成带 index 的列表
      const candidateText = candidates
        .map((c, i) => `[#${i}] 文件:${c.metadata.file_path} 类型:${c.metadata.type}\n内容预览:${c.content.slice(0, 150).replace(/\s+/g, ' ')}`)
        .join('\n---\n');

      const userMsg = `查询:${query}\n\n候选列表:\n${candidateText}`;

      const content = await this.chatClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        { temperature: 0, maxTokens: 800 },
      );

      const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const scores: Array<{ index: number; score: number }> = JSON.parse(cleaned);

      // 应用 rerank 分
      const scored = candidates.map((c, i) => {
        const entry = scores.find((s) => s.index === i);
        return {
          ...c,
          rerank_score: entry?.score ?? 0,
        };
      });

      // 按 rerank_score 降序,取 topK
      const final = scored.sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0)).slice(0, topK);

      this.logger.log(
        `rerank: ${candidates.length} candidates → top ${topK}, ` +
          `rerank scores: ${candidates.slice(0, 5).map((c, i) => `#${i}=${scored[i]?.rerank_score}`).join(', ')} → ` +
          `final top: ${final.map((f) => `${f.metadata.file_path}(${f.rerank_score})`).join(', ')}`,
      );

      return final;
    } catch (err) {
      this.logger.warn(`rerank failed: ${(err as Error).message.slice(0, 100)}, fallback to hybrid order`);
      return candidates.slice(0, topK);
    }
  }

  // ─── 内部:中文关键词提取 ─────────────────────────────────────────

  /**
   * 中文关键词提取
   * - 按空格切 → 每段作为一个 keyword
   * - 中文段:提取 2-char bigram(如"本地开发文档" → ["本地","地开","开发","发文","文档"])
   * - 过滤掉太短的(<2 字符)和常见停用词
   */
  private extractKeywords(query: string): string[] {
    const STOP_WORDS = new Set([
      '有吗', '的吗', '是的', '什么', '怎么', '哪些', '哪个',
      '请问', '帮我', '帮我查', '查一下', '一下',
      'the', 'a', 'an', 'is', 'are', 'of', 'in', 'on', 'to', 'for',
    ]);

    const keywords = new Set<string>();

    const segments = query.trim().split(/\s+/).filter(Boolean);

    for (const seg of segments) {
      // 英文/数字段(>=2 字符)直接加
      if (/^[a-zA-Z0-9_\-]+$/.test(seg) && seg.length >= 2) {
        keywords.add(seg.toLowerCase());
        continue;
      }

      // 中文段:提取 2-char bigram
      const chars = seg.replace(/[，。？！,.?!()（）【】\[\]]/g, '');
      if (chars.length < 2) continue;

      // 整段也作为一个 keyword(精确匹配用)
      if (chars.length <= 4) {
        keywords.add(chars);
      }

      // 2-char bigram
      for (let i = 0; i < chars.length - 1; i++) {
        const bigram = chars.slice(i, i + 2);
        if (!STOP_WORDS.has(bigram)) {
          keywords.add(bigram);
        }
      }
    }

    return Array.from(keywords).slice(0, 10); // 最多 10 个,避免 SQL 太长
  }
}
