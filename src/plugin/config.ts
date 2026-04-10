import { createRequire } from "node:module";
import type { PluginConfig, Task } from "./types";

const require = createRequire(import.meta.url);

export const HOME = process.env.HOME || "";

export function loadConfig(): PluginConfig {
  const { readFileSync, existsSync } = require("node:fs") as {
    readFileSync: (path: string, enc: string) => string;
    existsSync: (path: string) => boolean;
  };
  const configPath = `${process.env.HOME}/.openclaw/data/task-dispatch-config.json`;
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf8")) as PluginConfig;
    }
  } catch (e) {
    process.stderr.write(`[WARN] Could not load config: ${(e as Error).message}\n`);
  }
  return {};
}

export function normalizeTimeoutMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.max(1000, Math.floor(value));
}

export function buildConfigMaps(config: PluginConfig): {
  projectChannels: Record<string, string>;
  projectCwd: Record<string, string>;
  agentRuntime: Record<string, string>;
} {
  const projectChannels: Record<string, string> = {};
  const projectCwd: Record<string, string> = {};
  const agentRuntime: Record<string, string> = {};

  if (config.projects) {
    for (const [key, val] of Object.entries(config.projects)) {
      if (val.channel) projectChannels[key] = val.channel;
      if (val.cwd) projectCwd[key] = val.cwd;
    }
  }

  if (config.agents) {
    for (const [key, val] of Object.entries(config.agents)) {
      if (val.runtime) agentRuntime[key] = val.runtime;
    }
  }

  return { projectChannels, projectCwd, agentRuntime };
}

export function resolveChannel(
  task: Partial<Task>,
  projectChannels: Record<string, string>,
): string {
  if (task.channelId) return task.channelId;
  if (task.projectId && projectChannels[task.projectId]) {
    return projectChannels[task.projectId] as string;
  }
  const shortId = typeof task.id === "string" ? task.id.slice(0, 8) : "unknown";
  const projectIds = Object.keys(projectChannels).join(", ");
  throw new Error(
    `Task "${task.title || "unknown"}" (${shortId}) has no projectId or channelId. ` +
      `Set projectId to one of: ${projectIds} or provide an explicit channelId.`,
  );
}

export function resolveCwd(task: Partial<Task>, projectCwd: Record<string, string>): string | null {
  return task.cwd || (task.projectId ? (projectCwd[task.projectId] ?? null) : null);
}

export function resolveRuntime(task: Partial<Task>, agentRuntime: Record<string, string>): string {
  if (task.runtime) return task.runtime;
  return task.agent ? agentRuntime[task.agent] || "subagent" : "subagent";
}
