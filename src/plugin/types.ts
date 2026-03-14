export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "error"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  agent: string;
  runtime: string | null;
  projectId: string | null;
  channelId: string | null;
  cwd: string | null;
  model: string | null;
  thinking: string | null;
  dependsOn: string[];
  chainId: string | null;
  status: TaskStatus;
  manualComplete: boolean;
  sessionKey: string | null;
  runId: string | null;
  timeoutMs: number | null;
  threadId: string | null;
  output: string | null;
  retries: number;
  reviewAttempts: number;
  qaRequired: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface Schedule {
  id: string;
  title: string;
  description: string | null;
  agent: string;
  projectId: string | null;
  cwd: string | null;
  category: string | null;
  qaRequired: boolean;
  cronExpression: string;
  nlExpression: string | null;
  timeoutMs: number | null;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface PluginConfig {
  dbPath?: string;
  apiKey?: string;
  defaults?: {
    maxConcurrentSessions?: number;
    defaultCwd?: string;
    taskTimeoutMs?: number;
    reviewTimeoutMs?: number;
    maxReviewCycles?: number;
  };
  notifications?: {
    sumodeusSessionKey?: string;
  };
  agents?: Record<string, { runtime?: string }>;
  projects?: Record<string, { channel?: string; cwd?: string }>;
  channels?: {
    discord?: {
      accounts?: Record<string, { token?: string }>;
    };
  };
}

export interface SubagentRuntime {
  run?: (args: {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
    lane: "subagent";
  }) => Promise<{ runId?: string }>;
  waitForRun?: (args: { runId: string; timeoutMs: number }) => Promise<{ status?: string; error?: string }>;
  getSessionMessages?: (args: {
    sessionKey: string;
    limit: number;
  }) => Promise<{ messages?: Array<{ role?: string; content?: unknown }> }>;
}

export interface AcpRuntime {
  prompt?: (args: {
    sessionKey: string;
    text: string;
    channel?: string;
    accountId?: string;
    threadId?: string;
  }) => Promise<{ runId?: string }>;
  spawn?: (
    payload: {
      task: string;
      label: string;
      agentId: string;
      cwd: string;
      thread: boolean;
    },
    routing: {
      agentChannel: string;
      agentAccountId: string;
      agentTo?: string;
    },
  ) => Promise<{
    status?: string;
    error?: string;
    childSessionKey?: string;
    runId?: string;
  }>;
}

export interface PluginApi {
  config?: PluginConfig;
  runtime?: {
    acp?: AcpRuntime;
    subagent?: SubagentRuntime;
  };
  registerHttpRoute: (route: {
    path: string;
    auth?: string;
    match?: "prefix";
    handler: (req: any, res: any) => boolean | Promise<boolean>;
  }) => void;
  on: (event: string, listener: (payload: any) => void) => void;
}
