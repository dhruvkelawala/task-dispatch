export function buildExistingThreadDispatchMessage(task: { id?: string; title?: string; cwd?: string }, cwd?: string): string {
  const shortId = typeof task?.id === "string" ? task.id.slice(0, 8) : "task";
  const stamp = Date.now();
  const title = typeof task?.title === "string" && task.title.trim() ? task.title.trim() : "Task";
  const header = `⚙️ ${title}-${shortId}-${stamp} session active (reused thread). Messages here go directly to this session.`;
  const cwdLine = `cwd: ${cwd || task?.cwd || "-"}`;
  return `${header}\n${cwdLine}`;
}

export function buildDiscordAgentTarget(threadId?: string | null, channelId?: string | null): string | undefined {
  if (threadId && threadId.trim()) return `channel:${threadId}`;
  if (channelId && channelId.trim()) return `channel:${channelId}`;
  return undefined;
}
