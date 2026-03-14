import type { Task } from "./types";

export function taskNeedsAthena(task: Pick<Task, "title" | "description">): boolean {
  const text = `${task.title} ${task.description || ""}`.toLowerCase();
  const uiKeywords = [
    "ui",
    "ux",
    "design",
    "layout",
    "component",
    "style",
    "css",
    "tailwind",
    "animation",
    "responsive",
    "landing",
    "page",
    "visual",
    "typography",
    "font",
    "color",
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
    prompt += "\n1. First, use the task tool with subagent: athena to get a UI/UX spec for this task. Wait for the spec, then implement following it closely.";
    prompt += "\n2. Before committing, use the task tool with subagent: maat to review your code changes. Only commit after maat approves.";
  } else {
    prompt += "\n1. Before committing, use the task tool with subagent: maat to review your code changes. Only commit after maat approves.";
  }
  prompt += "\n3. Report: commit hash, files changed, build pass/fail.";
  return prompt;
}
