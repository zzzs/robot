#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fetchCompDetail, fetchCompList } from './cai-client.js';
import { loadEnv } from './env.js';
import {
  GET_COMP_DETAIL_DESCRIPTION,
  getCompDetailSchema,
} from './tools/get-comp-detail.js';
import {
  LIST_COMPS_DESCRIPTION,
  listCompsSchema,
} from './tools/list-comps.js';

const log = (msg: string) => console.error(msg);

const env = loadEnv(log);

const server = new Server(
  { name: 'cai-comp-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_comp_detail',
      description: GET_COMP_DETAIL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '组件 ID' },
          version: { type: 'string', description: '版本号(可选)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'list_comps',
      description: LIST_COMPS_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          pageNo: { type: 'number', description: '页码,默认 1' },
          pageSize: { type: 'number', description: '每页条数,默认 30,上限 100' },
          status: { type: 'number', description: '0=已发布,1=草稿,默认 0' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (name === 'get_comp_detail') {
    const parsed = getCompDetailSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'bad-args', error: parsed.error.message }) }],
        isError: true,
      };
    }
    const result = await fetchCompDetail(env, parsed.data, log);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }

  if (name === 'list_comps') {
    const parsed = listCompsSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'bad-args', error: parsed.error.message }) }],
        isError: true,
      };
    }
    const result = await fetchCompList(env, parsed.data, log);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'unknown-tool', name }) }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
log('[cai-comp-mcp] server started (stdio)');
