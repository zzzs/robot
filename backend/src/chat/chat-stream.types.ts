import { ChartPayload } from '../stock/stock.types';

export type ChatStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'chart'; data: ChartPayload }
  | { type: 'analysis-summary'; content: string }
  | { type: 'tool-status'; status: 'no-data' | 'insufficient'; message: string }
  | {
      type: 'interrupt';
      reason: string;
      confirmLabel: string;
      cancelLabel: string;
    }
  | { type: 'done' };

export type ChatEventMessageEvent = {
  data: ChatStreamEvent | { content: string };
  id?: string;
  event?: string;
  retry?: number;
};
