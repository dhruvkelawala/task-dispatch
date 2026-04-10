import type { PluginConfig, Task } from "./types";
import type { DatabaseLike } from "./runtime-types";

type DiscordRuntimeDeps = {
  config: PluginConfig;
  /** OpenClaw gateway config — used to resolve Discord bot tokens from openclaw.json */
  openclawConfig?: { channels?: { discord?: { accounts?: Record<string, { token?: string }> } } };
  defaultDiscordAccountId: string;
  resolveAccountId: (agent: string) => string;
  resolveChannel: (task: Partial<Task>) => string | null;
  formatDiscordThreadUrl: (threadId: string | null | undefined) => string | null;
  recordTaskEvent: (
    taskId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ) => void;
  db: DatabaseLike;
  stderr: Pick<typeof process.stderr, "write">;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDiscordRuntime(deps: DiscordRuntimeDeps) {
  function resolveBotToken(accountId: string): string | null {
    try {
      // First try task-dispatch plugin config
      const pluginAccounts = deps.config.channels?.discord?.accounts;
      const fromPluginConfig = pluginAccounts?.[accountId]?.token || pluginAccounts?.default?.token;
      if (fromPluginConfig) return fromPluginConfig;

      // Fallback: use OpenClaw gateway config (api.config.channels.discord.accounts)
      const openclawAccounts = deps.openclawConfig?.channels?.discord?.accounts;
      const fromOpenclawConfig =
        openclawAccounts?.[accountId]?.token || openclawAccounts?.default?.token;
      if (typeof fromOpenclawConfig === "string") return fromOpenclawConfig;

      return null;
    } catch {
      return null;
    }
  }

  async function postToThread(
    threadId: string | null,
    content: string,
    accountId: string,
  ): Promise<void> {
    if (!threadId) return;

    const token =
      resolveBotToken(accountId) ||
      resolveBotToken(deps.defaultDiscordAccountId) ||
      resolveBotToken("default");
    if (!token) return;

    try {
      await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://openclaw.ai, 1.0)",
        },
        body: JSON.stringify({ content }),
      });
    } catch (error) {
      deps.stderr.write(`[DISCORD] Error posting to thread: ${getErrorMessage(error)}\n`);
    }
  }

  async function createDiscordThread(task: Task): Promise<string | null> {
    const channelId = deps.resolveChannel(task);
    if (!channelId) {
      deps.stderr.write(`[DISCORD] No channel for task ${task.id}, skipping thread\n`);
      return null;
    }

    const shortId = task.id.slice(0, 8);
    const threadName = `${task.title.slice(0, 70)} — #${shortId}`;
    const accountId = deps.resolveAccountId(task.agent);
    deps.recordTaskEvent(task.id, "thread.attempt", { channelId, accountId, agent: task.agent });

    const agentToken = resolveBotToken(accountId);
    if (!agentToken) {
      deps.recordTaskEvent(task.id, "thread.failed", {
        reason: "missing_token",
        accountId,
        channelId,
        agent: task.agent,
      });
      deps.stderr.write(`[DISCORD] No bot token for ${accountId}, skipping thread\n`);
      return null;
    }

    try {
      const threadResp = await fetch(`https://discord.com/api/v10/channels/${channelId}/threads`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${agentToken}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://openclaw.ai, 1.0)",
        },
        body: JSON.stringify({
          name: threadName,
          type: 11,
          auto_archive_duration: 4320,
        }),
      });

      if (!threadResp.ok) {
        const err = await threadResp.text();
        deps.recordTaskEvent(task.id, "thread.failed", {
          reason: "http_error",
          accountId,
          channelId,
          status: threadResp.status,
          error: err.slice(0, 500),
        });
        deps.stderr.write(`[DISCORD] Failed to create thread: ${threadResp.status} ${err}\n`);
        return null;
      }

      const thread = (await threadResp.json()) as { id?: string };
      const threadId = typeof thread.id === "string" ? thread.id : null;
      if (!threadId) {
        deps.recordTaskEvent(task.id, "thread.failed", {
          reason: "missing_thread_id",
          accountId,
          channelId,
        });
        return null;
      }

      await postToThread(
        threadId,
        `🚀 **Task dispatched to ${task.agent}**\n\n**Title:** ${task.title}\n**Task ID:** \`${task.id}\`\n**Status:** dispatched`,
        accountId,
      );

      deps.db
        .prepare("UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?")
        .run(threadId, Date.now(), task.id);
      deps.recordTaskEvent(task.id, "thread.created", {
        threadId,
        channelId,
        agent: task.agent,
        threadUrl: deps.formatDiscordThreadUrl(threadId),
      });

      deps.stderr.write(`[DISCORD] Created thread ${threadId} for task ${task.id}\n`);
      return threadId;
    } catch (error) {
      deps.recordTaskEvent(task.id, "thread.failed", {
        reason: "exception",
        accountId,
        channelId,
        error: getErrorMessage(error),
      });
      deps.stderr.write(`[DISCORD] Error creating thread: ${getErrorMessage(error)}\n`);
      return null;
    }
  }

  return {
    resolveBotToken,
    postToThread,
    createDiscordThread,
  };
}
