export interface ScaffoldPlan {
  /** Description of the target setup the agent should implement */
  hypothesis: string;
  /** The model to use for the scaffold agent */
  model?: string;
  /** Maximum number of agent iterations */
  maxIterations?: number;
}

export interface ScaffoldResult {
  /** Whether the scaffold was successful */
  status: 'completed' | 'failed';
  /** The list of parameters (flags) exposed by the scaffolded implementation */
  parametersExposed: Record<string, string>;
  /** Error message if failed */
  error?: string;
}
