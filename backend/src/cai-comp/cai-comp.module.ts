import { Module } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { McpCaiCompClient } from './mcp/mcp-cai-comp.client';
import { buildGetCompDetailTool } from './tools/get-comp-detail.tool';
import { buildListCompsTool } from './tools/list-comps.tool';

export const CAI_COMP_GET_DETAIL_TOOL = Symbol('CAI_COMP_GET_DETAIL_TOOL');
export const CAI_COMP_LIST_TOOL = Symbol('CAI_COMP_LIST_TOOL');

@Module({
  providers: [
    McpCaiCompClient,
    {
      provide: CAI_COMP_GET_DETAIL_TOOL,
      inject: [McpCaiCompClient],
      useFactory: (client: McpCaiCompClient): DynamicStructuredTool =>
        buildGetCompDetailTool(client),
    },
    {
      provide: CAI_COMP_LIST_TOOL,
      inject: [McpCaiCompClient],
      useFactory: (client: McpCaiCompClient): DynamicStructuredTool =>
        buildListCompsTool(client),
    },
  ],
  exports: [CAI_COMP_GET_DETAIL_TOOL, CAI_COMP_LIST_TOOL, McpCaiCompClient],
})
export class CaiCompModule {}
