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
    defaultAgent?: string;
    taskTimeoutMs?: number;
    reviewTimeoutMs?: number;
    maxReviewCycles?: number;
    reviewDebounceMs?: number;
    acpStartupCooldownMs?: number;
    reviewThreadPollTimeoutMs?: number;
    reviewThreadPollLimit?: number;
  };
  notifications?: {
    operatorLabel?: string;
    operatorSessionKey?: string;
    telegramChatId?: string;
    defaultDiscordAccountId?: string;
  };
  agents?: Record<
    string,
    {
      runtime?: string;
      /** ACP harness id: "opencode", "claude", "codex", "gemini", etc. */
      harness?: string;
      channel?: string;
      accountId?: string;
      model?: string;
      name?: string;
    }
  >;
  projects?: Record<
    string,
    {
      name?: string;
      repo?: string;
      description?: string;
      status?: string;
      priority?: number;
      tags?: string[];
      aliases?: string[];
      channel?: string;
      cwd?: string;
      defaultAgent?: string;
      reviewAgent?: string;
    }
  >;
  channels?: {
    discord?: {
      guildId?: string;
      threadUrlTemplate?: string;
      accounts?: Record<string, { token?: string }>;
    };
  };
}

export interface PluginHttpRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface PluginHttpResponse {
  setHeader?: (name: string, value: string) => void;
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  write?: (chunk: string) => void;
  end: (chunk?: string) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface SubagentRuntime {
  run?: (args: {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
    lane: "subagent";
    model?: string;
  }) => Promise<{ runId?: string }>;
  waitForRun?: (args: {
    runId: string;
    timeoutMs: number;
  }) => Promise<{ status?: string; error?: string }>;
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
    conversationId?: string;
    parentConversationId?: string;
  }) => Promise<{ runId?: string }>;
  spawn?: (
    payload: {
      task: string;
      label?: string;
      agentId: string;
      cwd: string;
      mode?: "run" | "session";
      thread: boolean;
      resumeSessionId?: string;
    },
    routing: {
      agentChannel: string;
      agentAccountId: string;
      agentTo?: string;
      agentThreadId?: string | number;
      agentGroupId?: string;
    },
  ) => Promise<{
      status?: string;
      error?: string;
      childSessionKey?: string;
      runId?: string;
      mode?: "run" | "session";
      streamLogPath?: string;
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
    handler: (req: PluginHttpRequest, res: PluginHttpResponse) => boolean | Promise<boolean>;
  }) => void;
  on: (
    event: "subagent_ended",
    listener: (payload: { sessionKey?: string; status?: string; error?: string }) => void,
  ) => void;
}

// Project-related interfaces
export interface Project {
  id: string;
  name: string;
  repo: string | null;
  branch: string;
  priority: number;
  status: string;
  description: string | null;
  cwd: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectCommit {
  id: number;
  project_id: string;
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
  branch: string | null;
}

export interface ProjectSnapshot {
  id: number;
  project_id: string;
  summary: string | null;
  progress_pct: number;
  blockers: string | null;
  generated_at: string;
  model: string | null;
}
