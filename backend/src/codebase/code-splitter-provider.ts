import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';

/**
 * CodeSplitterProvider —— 初始化 LlamaIndex CodeSplitter
 *
 * 三层分工:
 *   1. llamaindex.CodeSplitter — 切分逻辑(按 AST 节点走)
 *   2. web-tree-sitter — WASM 运行时(Parser.parse())
 *   3. tree-sitter-typescript — 语法文件(.wasm)
 *
 * 初始化一次,创建 2 个 splitter:
 *   - tsSplitter:用于 .ts/.js 文件
 *   - tsxSplitter:用于 .tsx/.jsx 文件(JSX 语法)
 */

let initialized = false;
let tsSplitter: any = null;
let tsxSplitter: any = null;

export async function getCodeSplitters(logger: Logger): Promise<{
  tsSplitter: any;
  tsxSplitter: any;
}> {
  if (initialized) return { tsSplitter, tsxSplitter };

  // 1. 从 llamaindex 拿 CodeSplitter(ESM dynamic import)
  const { CodeSplitter } = await import('llamaindex');

  // 2. 初始化 web-tree-sitter(WASM 运行时)
  // web-tree-sitter 的 default export 就是 Parser 类
  // Parser.Language.load(wasmBytes) 加载语法
  const Parser = ((await import('web-tree-sitter')) as any).default;
  await Parser.init();

  // 3. 加载 TypeScript + TSX 语法 WASM
  const tsWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
  const tsxWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');
  const tsWasm = await readFile(tsWasmPath);
  const tsxWasm = await readFile(tsxWasmPath);
  const tsLang = await Parser.Language.load(tsWasm);
  const tsxLang = await Parser.Language.load(tsxWasm);

  // 4. 创建 parser 实例(配置好语法)
  const tsParser = new Parser();
  tsParser.setLanguage(tsLang);

  const tsxParser = new Parser();
  tsxParser.setLanguage(tsxLang);

  // 5. 创建 LlamaIndex CodeSplitter(getParser 返回已配置的 parser)
  tsSplitter = new CodeSplitter({ getParser: () => tsParser, maxChars: 1500 });
  tsxSplitter = new CodeSplitter({ getParser: () => tsxParser, maxChars: 1500 });

  initialized = true;
  logger.log('LlamaIndex CodeSplitter initialized (TS + TSX, tree-sitter WASM)');
  return { tsSplitter, tsxSplitter };
}

/**
 * getMarkdownSplitter —— 用 llamaindex MarkdownNodeParser
 *
 * 按 markdown 标题(# / ## / ###)切,每个 chunk 自带 Header_1/2/3 路径
 * 比 RecursiveCharacterTextSplitter 强:chunk 自带 section 上下文,
 * 检索时 agent 能看到这条代码属于哪个章节
 */
let mdParser: any = null;

export async function getMarkdownSplitter(logger: Logger): Promise<any> {
  if (mdParser) return mdParser;
  const { MarkdownNodeParser } = await import('llamaindex');
  mdParser = new MarkdownNodeParser();
  logger.log('LlamaIndex MarkdownNodeParser initialized');
  return mdParser;
}
