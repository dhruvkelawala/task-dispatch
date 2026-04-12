import type { PluginConfig } from "./types";

export const DEFAULT_REVIEW_DEBOUNCE_MS = 5 * 60 * 1000;

// Resolved at runtime from config; this is the fallback default.
export let REVIEW_DEBOUNCE_WINDOW_MS = DEFAULT_REVIEW_DEBOUNCE_MS;

export function setReviewDebounceMs(ms: number): void {
  REVIEW_DEBOUNCE_WINDOW_MS = ms;
}

export type ReviewRequest = {
  repo: string;
  beforeSha?: string | null;
  sha: string;
  branch?: string | null;
  pusher?: string | null;
  compareUrl?: string | null;
  deliveryKey: string;
};

export type ReviewStateRow = {
  repo: string;
  last_reviewed_sha: string | null;
  last_review_at: number | null;
  pending_from_sha: string | null;
  pending_to_sha: string | null;
  pending_task_id: string | null;
  pending_updated_at: number | null;
  active_from_sha: string | null;
  active_to_sha: string | null;
  active_task_id: string | null;
};

export type ParsedReviewSummary = {
  schemaVersion: 1;
  reviewOutcome: "success" | "failed_retryable";
  findingsCount: number;
  findings: Array<{
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    category: string;
    file: string;
    line?: number;
    summary: string;
    issueBody?: string;
  }>;
  issueOps?: Array<{
    fingerprint?: string;
    operation: "created" | "duplicate_existing" | "skipped_low_severity" | "failed_retryable";
  }>;
};

export type ReviewRequestPlan = {
  status: "created" | "debounced" | "queued_after_active_review" | "duplicate";
  pendingFromSha: string;
  pendingToSha: string;
};

export function normalizeRepoSlug(repo: unknown): string {
  return typeof repo === "string" ? repo.trim().toLowerCase() : "";
}

export function resolveProjectIdForRepo(config: PluginConfig, repo: string): string | null {
  const target = normalizeRepoSlug(repo);
  if (!target) return null;
  for (const [projectId, entry] of Object.entries(config.projects || {})) {
    if (normalizeRepoSlug(entry.repo) === target) {
      return projectId;
    }
  }
  return null;
}

export function resolveReviewRange(
  state: ReviewStateRow | null,
  request: ReviewRequest,
): { fromSha: string; toSha: string } {
  const toSha = request.sha.trim();
  const fromSha = state?.last_reviewed_sha?.trim() || request.beforeSha?.trim() || `${toSha}^`;
  return { fromSha, toSha };
}

export function buildReviewTaskTitle(repo: string, toSha: string): string {
  const shortRepo = repo.split("/").pop() || repo;
  return `Post-merge review: ${shortRepo} @ ${toSha.slice(0, 12)}`;
}

export function planReviewRequest(params: {
  state: ReviewStateRow | null;
  fromSha: string;
  toSha: string;
  duplicateDelivery: boolean;
}): ReviewRequestPlan {
  const state = params.state;
  if (params.duplicateDelivery) {
    return {
      status: "duplicate",
      pendingFromSha: state?.pending_from_sha || state?.active_from_sha || params.fromSha,
      pendingToSha: state?.pending_to_sha || state?.active_to_sha || params.toSha,
    };
  }
  if (state?.active_task_id) {
    return {
      status: "queued_after_active_review",
      pendingFromSha: state.pending_from_sha || state.active_to_sha || params.fromSha,
      pendingToSha: params.toSha,
    };
  }
  if (state?.pending_task_id) {
    return {
      status: "debounced",
      pendingFromSha: state.pending_from_sha || params.fromSha,
      pendingToSha: params.toSha,
    };
  }
  return {
    status: "created",
    pendingFromSha: params.fromSha,
    pendingToSha: params.toSha,
  };
}

export function buildReviewTaskDescription(params: {
  repo: string;
  projectId: string;
  fromSha: string;
  toSha: string;
  branch?: string | null;
  pusher?: string | null;
  compareUrl?: string | null;
}): string {
  const details = [
    "Post-merge retrospective code review.",
    "",
    `Repo: ${params.repo}`,
    `Project: ${params.projectId}`,
    `Range: ${params.fromSha}..${params.toSha}`,
    params.branch ? `Branch: ${params.branch}` : null,
    params.pusher ? `Pusher: ${params.pusher}` : null,
    params.compareUrl ? `Compare URL: ${params.compareUrl}` : null,
    "",
    "Instructions:",
    `0. Sync: \`git fetch origin && git checkout ${params.branch || "main"} && git pull origin ${params.branch || "main"}\`. If range unresolvable, reviewOutcome=failed_retryable.`,
    "0b. Read-only review. Dirty working tree? Ignore it. Review only the requested range.",
    `1. \`git log --oneline ${params.fromSha}..${params.toSha}\` and \`git diff ${params.fromSha}..${params.toSha}\`.`,
    "2. Find: bugs, edge cases, missing tests, security issues, architecture drift.",
    "3. Classify each: category + severity.",
    "4. Do NOT create GitHub issues. Plugin does that server-side from your JSON.",
    "",
    "OUTPUT RULES (strict):",
    "- Your ENTIRE thread output = 2-3 sentences + ONE json fence. Nothing else.",
    "- No bullet lists. No headers. No markdown formatting. No code blocks except the final JSON.",
    "- No process narration. Do NOT say things like 'I'm reviewing', 'Sync is complete', 'Now I'm checking', 'I validated', or describe your workflow step-by-step.",
    "- Pattern: 'Reviewed [range]. [N] findings ([severities]). [one-line summary if needed].'",
    "- Then ONE ```json fence with the full summary. Do NOT split JSON across multiple fences or messages.",
    "- Think of yourself as a terse code reviewer, not an essay writer. Every extra word is waste.",
    "",
    "Required final machine-readable summary:",
    "Return a final fenced JSON block with this exact top-level shape:",
    "```json",
    JSON.stringify(
      {
        schemaVersion: 1,
        reviewOutcome: "success",
        findingsCount: 0,
        findings: [
          {
            title: "Users route is missing auth middleware",
            severity: "high",
            category: "security",
            file: "src/routes/users.ts",
            line: 42,
            summary: "The route can be reached without authentication.",
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "Clean review = findingsCount: 0, findings: [].",
    "Each finding: title, severity, category, file, optional line, one-sentence summary. Nothing else.",
    "BAD: headers, bullets, multiple json fences, long explanations, ## Problem sections.",
    "GOOD: 'Reviewed 104b4c8. 2 findings (1 high, 1 medium).' then one json fence.",
  ].filter(Boolean);
  return details.join("\n");
}

export function transitionPendingReviewState(state: ReviewStateRow): ReviewStateRow | null {
  if (!state.pending_task_id || state.active_task_id) {
    return null;
  }
  return {
    ...state,
    active_from_sha: state.pending_from_sha,
    active_to_sha: state.pending_to_sha,
    active_task_id: state.pending_task_id,
    pending_from_sha: null,
    pending_to_sha: null,
    pending_task_id: null,
    pending_updated_at: null,
  };
}

export function applySuccessfulReviewCompletion(
  state: ReviewStateRow,
  now: number,
): ReviewStateRow {
  const nextCursor = state.active_to_sha;
  const shouldClearPending =
    Boolean(nextCursor) && (!state.pending_to_sha || state.pending_to_sha === nextCursor);

  return {
    ...state,
    last_reviewed_sha: nextCursor,
    last_review_at: now,
    pending_from_sha: shouldClearPending ? null : state.pending_from_sha,
    pending_to_sha: shouldClearPending ? null : state.pending_to_sha,
    pending_task_id: shouldClearPending ? null : state.pending_task_id,
    pending_updated_at: shouldClearPending ? null : state.pending_updated_at,
    active_from_sha: null,
    active_to_sha: null,
    active_task_id: null,
  };
}

export function applyFailedReviewCompletion(state: ReviewStateRow, now: number): ReviewStateRow {
  return {
    ...state,
    pending_from_sha: state.active_from_sha || state.pending_from_sha,
    pending_to_sha: state.pending_to_sha || state.active_to_sha,
    pending_updated_at: state.pending_updated_at || now,
    active_from_sha: null,
    active_to_sha: null,
    active_task_id: null,
  };
}

export function parseReviewSummary(output: unknown): ParsedReviewSummary | null {
  if (typeof output !== "string" || !output.trim()) {
    return null;
  }
  const fencedJsonBlocks = Array.from(output.matchAll(/```json\s*([\s\S]*?)```/gi));
  const tryParseSummary = (jsonText: string): ParsedReviewSummary | null => {
    try {
      const parsed = JSON.parse(jsonText) as ParsedReviewSummary;
      if (
        parsed &&
        parsed.schemaVersion === 1 &&
        (parsed.reviewOutcome === "success" || parsed.reviewOutcome === "failed_retryable") &&
        typeof parsed.findingsCount === "number" &&
        Array.isArray(parsed.findings)
      ) {
        return parsed;
      }
    } catch {
      // Ignore malformed JSON and keep scanning.
    }
    return null;
  };

  for (let idx = fencedJsonBlocks.length - 1; idx >= 0; idx -= 1) {
    const jsonText = fencedJsonBlocks[idx]?.[1];
    if (!jsonText) continue;
    const parsed = tryParseSummary(jsonText);
    if (parsed) {
      return parsed;
    }
  }

  // Discord can split a long final JSON summary across multiple ` ```json `
  // messages. If individual blocks are invalid, try joining suffixes of the
  // final JSON block run and parse again.
  const blockContents = fencedJsonBlocks.map((match) => match[1]).filter(Boolean) as string[];
  for (let start = blockContents.length - 1; start >= 0; start -= 1) {
    const parsed = tryParseSummary(blockContents.slice(start).join(""));
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function shouldAdvanceReviewCursor(summary: ParsedReviewSummary | null): boolean {
  if (!summary) {
    return false;
  }
  if (summary.reviewOutcome !== "success") {
    return false;
  }
  if (summary.findingsCount === 0 && summary.findings.length === 0) {
    return true;
  }
  if (!summary.issueOps) {
    return false;
  }
  return summary.issueOps.every(
    (entry) =>
      entry.operation === "created" ||
      entry.operation === "duplicate_existing" ||
      entry.operation === "skipped_low_severity",
  );
}
