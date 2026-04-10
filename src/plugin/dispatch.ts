import type { Task } from "./types";

export function taskNeedsAthena(task: Pick<Task, "title" | "description">): boolean {
  const text = `${task.title} ${task.description || ""}`.toLowerCase();

  // Skip Athena for test/infra/docs tasks — even if they mention UI keywords
  const skipKeywords = [
    "test",
    "maestro",
    "e2e",
    "ci",
    "infra",
    "docs",
    "refactor",
    "migration",
    "stabilize",
  ];
  if (skipKeywords.some((kw) => text.includes(kw))) return false;

  const uiKeywords = [
    "screen",
    "tab",
    "design",
    "layout",
    "style",
    "css",
    "tailwind",
    "animation",
    "responsive",
    "landing page",
    "visual redesign",
    "typography",
    "theme",
  ];
  return uiKeywords.some((kw) => text.includes(kw));
}

export function formatTaskPrompt(task: Partial<Task>): string {
  let prompt = `# Task: ${task.title}\n\n`;
  if (task.description) prompt += `## Description\n${task.description}\n\n`;
  if (task.projectId) prompt += `**Project:** ${task.projectId}\n`;
  if (task.cwd) prompt += `**Working directory:** ${task.cwd}\n`;
  if (task.model) prompt += `**Model:** ${task.model}\n`;
  if (task.thinking) prompt += `**Thinking:** ${task.thinking}\n`;

  prompt += "\n## Instructions";
  if (taskNeedsAthena({ title: task.title || "", description: task.description || null })) {
    prompt +=
      "\n1. First, use the task tool with subagent: athena to get a UI/UX spec for this task. Wait for the spec, then implement following it closely.";
    prompt +=
      "\n2. Before committing, use the task tool with subagent: maat to review your code changes. Only commit after maat approves.";
  } else {
    prompt +=
      "\n1. Before committing, use the task tool with subagent: maat to review your code changes. Only commit after maat approves.";
  }
  prompt += "\n3. Report: commit hash, files changed, build pass/fail.";
  return prompt;
}
