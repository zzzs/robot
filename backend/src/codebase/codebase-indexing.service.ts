import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PostgresPoolService } from '../postgres/postgres-pool.service';
import { getCodeSplitters } from './code-splitter-provider';
import { getMarkdownSplitter } from './code-splitter-provider';
import { GLMEmbedder } from './glm-embedder';

const execAsync = promisify(exec);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx']);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', 'build', '.next', 'coverage', 'lib', 'out', 'vendor', 'cjs', 'es', 'umd', '.claude', '.cursor']);

export interface IndexResult {
  files: number;
  chunks: number;
  tokens: number;
  source: string;
}

export interface UpdateResult {
  changed: number;
  deleted: number;
  tokens: number;
  source: string;
}

interface FileInfo {
  absolutePath: string;
  relativePath: string;
  content: string;
  hash: string;
  ext: string;
}

/**
 * CodebaseIndexingService —— 代码知识库索引
 *
 * 两个接口:
 *   - indexFull(source):首次全量索引。clone(或本地)→ 读全部 → split → embed → store
 *   - updateIncremental(source, changed, deleted):webhook 增量。
 *     changed → clone → 只读这些文件 → embed → 删旧 → 存新
 *     deleted → 直接删 DB(不用 clone)
 *
 * 启动时不自动索引,只打日志提示调 API。
 */
@Injectable()
export class CodebaseIndexingService implements OnModuleInit {
  private readonly logger = new Logger(CodebaseIndexingService.name);
  private readonly embedder: GLMEmbedder;
  private readonly gitlabToken: string;

  constructor(
    private readonly poolSvc: PostgresPoolService,
    private readonly config: ConfigService,
  ) {
    this.gitlabToken = this.config.get<string>('codebase.gitlabToken') ?? '';
    this.embedder = new GLMEmbedder({
      apiKey: process.env.GLM_API_KEY ?? '',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'embedding-3',
      dimensions: 512,
    });
  }

  async onModuleInit() {
    if (!this.poolSvc.isAvailable()) {
      this.logger.warn('Postgres not available, codebase indexing disabled');
      return;
    }
    const count = await this.getRowCount();
    if (count === 0) {
      this.logger.log(
        'codebase_vectors is empty. Call POST /api/codebase/index { "source": "..." } to index a project.',
      );
    } else {
      this.logger.log(`codebase_vectors has ${count} rows. Ready to search.`);
    }
  }

  // ─── 首次全量索引 ──────────────────────────────────────────────────

  async indexFull(source: string, projectName: string): Promise<IndexResult> {
    if (!this.poolSvc.isAvailable()) throw new Error('Postgres not available');

    const { dirPath, isTemp } = await this.resolveSource(source);
    try {
      // 清掉同 source + project_name 的旧数据(重建)
      await this.poolSvc.withClient(async (c) => {
        await c.query(
          'DELETE FROM codebase_vectors WHERE source = $1 AND project_name = $2',
          [source, projectName],
        );
      });

      const files = await this.readAllFiles(dirPath);
      if (files.length === 0) {
        this.logger.warn(`no code files found in ${dirPath}`);
        return { files: 0, chunks: 0, tokens: 0, source };
      }

      const { totalChunks, totalTokens } = await this.embedAndStore(files, source, projectName);
      this.logger.log(
        `full index [${projectName}]: ${files.length} files → ${totalChunks} chunks → ~${totalTokens} tokens`,
      );
      return { files: files.length, chunks: totalChunks, tokens: totalTokens, source };
    } finally {
      if (isTemp) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ─── 增量更新(webhook) ────────────────────────────────────────────

  async updateIncremental(
    source: string,
    projectName: string,
    changedFiles: string[],
    deletedFiles: string[],
  ): Promise<UpdateResult> {
    if (!this.poolSvc.isAvailable()) throw new Error('Postgres not available');

    let tokens = 0;
    let changed = 0;

    // 1. 处理 changed_files:clone/读本地 → 只读这些文件 → embed → 删旧 → 存新
    if (changedFiles.length > 0) {
      const { dirPath, isTemp } = await this.resolveSource(source);
      try {
        const files = await this.readSpecificFiles(dirPath, changedFiles);
        if (files.length > 0) {
          // 删这些文件的旧 chunks
          await this.deleteChunks(source, projectName, changedFiles);

          // embed + 存新
          const result = await this.embedAndStore(files, source, projectName);
          tokens = result.totalTokens;
          changed = files.length;
          this.logger.log(
            `incremental update: re-indexed ${changed} changed files → ${result.totalChunks} chunks → ~${tokens} tokens`,
          );
        } else {
          this.logger.warn(`none of the changed files found in ${dirPath}`);
        }
      } finally {
        if (isTemp) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }
    }

    // 2. 处理 deleted_files:直接删 DB(不用 clone)
    let deleted = 0;
    if (deletedFiles.length > 0) {
      deleted = await this.deleteChunks(source, projectName, deletedFiles);
      this.logger.log(`incremental update: deleted ${deleted} files' chunks`);
    }

    return { changed, deleted, tokens, source };
  }

  // ─── 单文件索引(独立 .md 文档) ───────────────────────────────────

  /**
   * 索引单个本地 .md 文件(独立文档,不在项目 repo 里)
   * source: 绝对路径,如 /Users/.../my-doc.md
   * projectName: 项目名(用于多项目区分)
   */
  async indexSingleMarkdownFile(source: string, projectName: string): Promise<IndexResult> {
    if (!this.poolSvc.isAvailable()) throw new Error('Postgres not available');

    const absPath = resolve(source);
    const ext = extname(absPath);
    if (!DOC_EXTENSIONS.has(ext)) {
      throw new Error(`only .md/.mdx files supported, got: ${ext}`);
    }

    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch (err) {
      throw new Error(`failed to read ${absPath}: ${(err as Error).message}`);
    }

    // 删同 source + project_name 的旧数据(重建)
    await this.poolSvc.withClient(async (c) => {
      await c.query(
        'DELETE FROM codebase_vectors WHERE source = $1 AND project_name = $2',
        [absPath, projectName],
      );
    });

    const hash = createHash('md5').update(content).digest('hex');
    const files: FileInfo[] = [{
      absolutePath: absPath,
      relativePath: basename(absPath),
      content,
      hash,
      ext,
    }];

    const { totalChunks, totalTokens } = await this.embedAndStore(files, absPath, projectName);
    this.logger.log(
      `single doc index [${projectName}]: ${absPath} → ${totalChunks} chunks → ~${totalTokens} tokens`,
    );
    return { files: 1, chunks: totalChunks, tokens: totalTokens, source: absPath };
  }

  // ─── 内部:embed + store ───────────────────────────────────────────

  private async embedAndStore(
    files: FileInfo[],
    source: string,
    projectName: string,
  ): Promise<{ totalChunks: number; totalTokens: number }> {
    // CodeSplitter(tree-sitter AST,按函数/类切)for .ts/.tsx/.js/.jsx
    // MarkdownNodeParser(按标题切,chunk 自带 section 路径)for .md/.mdx
    const { tsSplitter, tsxSplitter } = await getCodeSplitters(this.logger);
    const mdParser = await getMarkdownSplitter(this.logger);

    // 先把所有文件切成 chunks
    const allChunks: Array<{
      content: string;
      metadata: {
        file_path: string;
        language: string;
        type: 'code' | 'markdown';
        start_line: number;
        end_line: number;
        headers?: Record<string, string>;
      };
      fileHash: string;
    }> = [];

    for (const file of files) {
      const isMarkdown = DOC_EXTENSIONS.has(file.ext);

      if (isMarkdown) {
        // .md:用 MarkdownNodeParser,按标题切,每个 chunk 带 headers 元信息
        try {
          const { Document } = await import('llamaindex');
          const doc = new Document({ text: file.content });
          const nodes = await mdParser.getNodesFromDocuments([doc]);
          let lineCursor = 1;
          for (const node of nodes) {
            const text = (node.text ?? '').trim();
            if (!text) continue;
            // 算行号:在原文里找这一段的位置
            const idx = file.content.indexOf(text, lineCursor - 1);
            const startLine = idx >= 0
              ? file.content.slice(0, idx).split('\n').length
              : lineCursor;
            const chunkLines = text.split('\n').length;
            allChunks.push({
              content: text,
              metadata: {
                file_path: file.relativePath,
                language: 'markdown',
                type: 'markdown',
                start_line: startLine,
                end_line: startLine + chunkLines - 1,
                headers: (node.metadata ?? {}) as Record<string, string>,
              },
              fileHash: file.hash,
            });
            if (idx >= 0) lineCursor = startLine + chunkLines;
          }
        } catch (err) {
          this.logger.warn(
            `MarkdownNodeParser failed for ${file.relativePath}: ${(err as Error).message.slice(0, 100)}, fallback to whole file`,
          );
          allChunks.push({
            content: file.content,
            metadata: {
              file_path: file.relativePath,
              language: 'markdown',
              type: 'markdown',
              start_line: 1,
              end_line: file.content.split('\n').length,
            },
            fileHash: file.hash,
          });
        }
        continue;
      }

      // .ts/.tsx/.js/.jsx:用 CodeSplitter(AST 按函数/类切)
      const splitter = (file.ext === '.tsx' || file.ext === '.jsx') ? tsxSplitter : tsSplitter;
      const language = (file.ext === '.tsx' || file.ext === '.ts') ? 'typescript' : 'javascript';

      let chunkTexts: string[];
      try {
        chunkTexts = splitter.splitText(file.content);
      } catch (err) {
        this.logger.warn(
          `CodeSplitter failed for ${file.relativePath} (${file.ext}): ${(err as Error).message.slice(0, 100)}, fallback to whole file`,
        );
        chunkTexts = [file.content];
      }

      let searchOffset = 0;
      for (const chunkText of chunkTexts) {
        if (!chunkText.trim()) continue;
        const idx = file.content.indexOf(chunkText, searchOffset);
        const startLine = idx >= 0
          ? file.content.slice(0, idx).split('\n').length
          : 1;
        const chunkLines = chunkText.split('\n').length;
        allChunks.push({
          content: chunkText,
          metadata: {
            file_path: file.relativePath,
            language,
            type: 'code',
            start_line: startLine,
            end_line: startLine + chunkLines - 1,
          },
          fileHash: file.hash,
        });
        if (idx >= 0) searchOffset = idx + chunkText.length;
      }
    }

    if (allChunks.length === 0) return { totalChunks: 0, totalTokens: 0 };

    // 批量 embed + 存
    let totalTokens = 0;
    const batchSize = 10;
    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await this.embedder.embedDocuments(texts);
      totalTokens += embeddings.reduce((sum: number, e: number[]) => sum + e.length, 0);

      await this.poolSvc.withClient(async (c) => {
        for (let j = 0; j < batch.length; j++) {
          await c.query(
            `INSERT INTO codebase_vectors (content, embedding, metadata, source, content_hash, file_path, project_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              batch[j].content,
              `[${embeddings[j].join(',')}]`,
              JSON.stringify(batch[j].metadata),
              source,
              batch[j].fileHash,
              batch[j].metadata.file_path,
              projectName,
            ],
          );
        }
      });

      if (i + batchSize < allChunks.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    this.logger.log(`embedded ${allChunks.length} chunks from ${files.length} files, ~${totalTokens} tokens`);
    return { totalChunks: allChunks.length, totalTokens };
  }

  // ─── 内部:文件读取 ───────────────────────────────────────────────

  /**
   * 读目录下所有 .ts/.tsx/.js/.jsx 和 .md/.mdx 文件
   */
  private async readAllFiles(dirPath: string): Promise<FileInfo[]> {
    const filePaths = await this.walkDir(dirPath);
    this.logger.log(`found ${filePaths.length} files (code + markdown)`);
    return this.readFiles(dirPath, filePaths);
  }

  /**
   * 只读指定的文件(webhook changed_files)
   * relativePaths 是相对项目根的路径,如 "src/App.tsx"
   */
  private async readSpecificFiles(dirPath: string, relativePaths: string[]): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    for (const relPath of relativePaths) {
      const fullPath = join(dirPath, relPath);
      const ext = extname(relPath);
      if (!CODE_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) {
        this.logger.warn(`skip unsupported file: ${relPath}`);
        continue;
      }
      try {
        const content = await readFile(fullPath, 'utf-8');
        const hash = createHash('md5').update(content).digest('hex');
        files.push({
          absolutePath: fullPath,
          relativePath: relPath,
          content,
          hash,
          ext,
        });
      } catch (err) {
        this.logger.warn(`failed to read changed file ${relPath}: ${(err as Error).message}`);
      }
    }
    return files;
  }

  /**
   * 读一批文件 → 算 hash → 返 FileInfo[]
   */
  private async readFiles(dirPath: string, filePaths: string[]): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    for (const fullPath of filePaths) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        const relativePath = fullPath.replace(dirPath + '/', '').replace(dirPath + '\\', '');
        const hash = createHash('md5').update(content).digest('hex');
        files.push({
          absolutePath: fullPath,
          relativePath,
          content,
          hash,
          ext: extname(fullPath),
        });
      } catch (err) {
        this.logger.warn(`failed to read ${fullPath}: ${(err as Error).message}`);
      }
    }
    return files;
  }

  // ─── 内部:source 解析 ─────────────────────────────────────────────

  private async resolveSource(rawSource: string): Promise<{ dirPath: string; isTemp: boolean }> {
    const isGitUrl =
      rawSource.startsWith('http://') ||
      rawSource.startsWith('https://') ||
      rawSource.startsWith('git@');

    if (!isGitUrl) {
      return { dirPath: resolve(rawSource), isTemp: false };
    }

    const tmpDir = join(tmpdir(), `codebase-${Date.now()}`);
    let cloneUrl = rawSource;
    if (this.gitlabToken) {
      cloneUrl = rawSource.replace(
        /^(https?:\/\/)([^/]+)/,
        (_, proto, host) => `${proto}oauth2:${this.gitlabToken}@${host}`,
      );
    }

    this.logger.log(`cloning ${rawSource} (depth 1) to ${tmpDir}...`);
    try {
      await execAsync(`git clone --depth 1 ${cloneUrl} ${tmpDir}`, {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 10,
      });
      this.logger.log('clone complete');
      return { dirPath: tmpDir, isTemp: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      throw new Error(`clone failed: ${msg.slice(0, 500)}`);
    }
  }

  // ─── 内部:DB 操作 ────────────────────────────────────────────────

  private async deleteChunks(source: string, projectName: string, filePaths: string[]): Promise<number> {
    let deleted = 0;
    await this.poolSvc.withClient(async (c) => {
      for (const fp of filePaths) {
        const res = await c.query(
          'DELETE FROM codebase_vectors WHERE source = $1 AND project_name = $2 AND file_path = $3',
          [source, projectName, fp],
        );
        deleted += res.rowCount ?? 0;
      }
    });
    return deleted;
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        results.push(...(await this.walkDir(fullPath)));
      } else if (CODE_EXTENSIONS.has(extname(entry.name)) || DOC_EXTENSIONS.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private async getRowCount(): Promise<number> {
    if (!this.poolSvc.pool) return 0;
    try {
      const res = await this.poolSvc.pool.query('SELECT COUNT(*) FROM codebase_vectors');
      return parseInt(res.rows[0].count, 10);
    } catch {
      return 0;
    }
  }
}
