export type EvalCategory =
  | 'integrity'
  | 'tool-selection'
  | 'quality'
  | 'no-fabrication';

export interface EvalExpectations {
  mustContain?: string;
  mustNotContain?: string[];
  expectedTool?:
    | 'analyze_stock_free'
    | 'analyze_stock'
    | 'search_news'
    | 'none';
  judgePrompt: string;
}

export interface EvalCase {
  id: string;
  description: string;
  input: string;
  category: EvalCategory;
  requiresNetwork: boolean;
  expectations: EvalExpectations;
}

export interface EvaluatorResult {
  pass: boolean;
  score: number;
  reason: string;
}

export interface JudgeResult {
  score: number;
  explanation: string;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  description: string;
  requiresNetwork: boolean;
  input: string;
  responseText: string;
  detectedTool: string;
  pass: boolean;
  integrity: EvaluatorResult | null;
  toolSelection: EvaluatorResult | null;
  judge: JudgeResult | null;
  error?: string;
}

export interface EvalReport {
  totalCases: number;
  passed: number;
  passRate: number;
  results: CaseResult[];
  ranAt: string;
  duration: number;
}

export interface EvalRunOptions {
  offline?: boolean;
  category?: EvalCategory;
}
