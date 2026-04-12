import crypto from "node:crypto";
import type { ParsedReviewSummary } from "./review";

export type ReviewFinding = ParsedReviewSummary["findings"][number];

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_#:[\](){}]/g, "")
    .replace(/\s+/g, " ");
}

export function buildReviewFindingFingerprint(params: {
  repo: string;
  finding: ReviewFinding;
}): string {
  const payload = [
    params.repo.trim().toLowerCase(),
    normalizeText(params.finding.title),
    normalizeText(params.finding.category),
    params.finding.file.trim().toLowerCase(),
    typeof params.finding.line === "number" ? String(params.finding.line) : "",
    crypto.createHash("sha256").update(normalizeText(params.finding.summary)).digest("hex"),
  ].join("|");
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

export function buildReviewIssueLabels(finding: ReviewFinding): string[] {
  return [
    "ai-review",
    `review:${normalizeText(finding.category).replace(/\s+/g, "-")}`,
    `severity:${finding.severity}`,
  ];
}

export function buildReviewIssueTitle(finding: ReviewFinding): string {
  return `[ai-review][${finding.severity}][${finding.category}] ${finding.title}`;
}

export function buildReviewIssueBody(params: {
  repo: string;
  reviewRange: string;
  fingerprint: string;
  finding: ReviewFinding;
}): string {
  const location =
    typeof params.finding.line === "number"
      ? `${params.finding.file}:${params.finding.line}`
      : params.finding.file;
  const detailedBody =
    params.finding.issueBody?.trim() ||
    [
      "## Problem",
      params.finding.summary,
      "",
      "## Why it matters",
      `This ${params.finding.severity} ${params.finding.category} issue was found during post-merge review and should be investigated.`,
      "",
      "## Suggested fix",
      `Inspect \`${location}\` and add the smallest targeted fix plus regression coverage where appropriate.`,
    ].join("\n");
  return [
    "## Summary",
    params.finding.summary,
    "",
    "## Severity",
    params.finding.severity,
    "",
    "## Category",
    params.finding.category,
    "",
    "## Location",
    `\`${location}\``,
    "",
    detailedBody,
    "",
    "---",
    `Fingerprint: \`${params.fingerprint}\``,
    "Detected by: post-merge review",
    `Repo: \`${params.repo}\``,
    `Review range: \`${params.reviewRange}\``,
  ].join("\n");
}

export type PlannedReviewIssue = {
  fingerprint: string;
  title: string;
  labels: string[];
  body: string;
  severity: ReviewFinding["severity"];
  category: string;
  file: string;
  line?: number;
};

export function planReviewIssues(params: {
  repo: string;
  reviewRange: string;
  findings: ReviewFinding[];
  minSeverity?: "critical" | "high" | "medium" | "low";
}): PlannedReviewIssue[] {
  const severityRank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  const minimum = params.minSeverity || "medium";

  return params.findings
    .filter((finding) => severityRank[finding.severity] >= severityRank[minimum])
    .map((finding) => {
      const fingerprint = buildReviewFindingFingerprint({
        repo: params.repo,
        finding,
      });
      return {
        fingerprint,
        title: buildReviewIssueTitle(finding),
        labels: buildReviewIssueLabels(finding),
        body: buildReviewIssueBody({
          repo: params.repo,
          reviewRange: params.reviewRange,
          fingerprint,
          finding,
        }),
        severity: finding.severity,
        category: finding.category,
        file: finding.file,
        ...(typeof finding.line === "number" ? { line: finding.line } : {}),
      };
    });
}

export type ReviewIssueWriteResult = {
  fingerprint: string;
  operation: "created" | "duplicate_existing" | "skipped_low_severity" | "failed_retryable";
  issueNumber?: number;
  issueUrl?: string;
  reason?: string;
};

export async function executePlannedReviewIssuesDryRun(
  issues: PlannedReviewIssue[],
): Promise<ReviewIssueWriteResult[]> {
  return issues.map((issue) => ({
    fingerprint: issue.fingerprint,
    operation: "created" as const,
    reason: "dry_run",
  }));
}

export async function executePlannedReviewIssues(params: {
  token: string;
  repo: string;
  reviewRange: string;
  issues: PlannedReviewIssue[];
  searchIssuesByFingerprint: (p: {
    token: string;
    repo: string;
    fingerprint: string;
  }) => Promise<Array<{ number: number; html_url: string; state: string }>>;
  createGitHubIssue: (p: {
    token: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }) => Promise<{ number: number; html_url: string }>;
  commentOnGitHubIssue: (p: {
    token: string;
    repo: string;
    issueNumber: number;
    body: string;
  }) => Promise<void>;
  stderr?: Pick<typeof process.stderr, "write">;
}): Promise<ReviewIssueWriteResult[]> {
  const results: ReviewIssueWriteResult[] = [];

  for (const issue of params.issues) {
    try {
      const existing = await params.searchIssuesByFingerprint({
        token: params.token,
        repo: params.repo,
        fingerprint: issue.fingerprint,
      });

      const openMatch = existing.find((i) => i.state === "open");
      if (openMatch) {
        await params.commentOnGitHubIssue({
          token: params.token,
          repo: params.repo,
          issueNumber: openMatch.number,
          body: `Re-detected in review range \`${params.reviewRange}\`.\n\nFingerprint: \`${issue.fingerprint}\``,
        });
        results.push({
          fingerprint: issue.fingerprint,
          operation: "duplicate_existing",
          issueNumber: openMatch.number,
          issueUrl: openMatch.html_url,
        });
        params.stderr?.write(
          `[ISSUE-WRITER] duplicate_existing #${openMatch.number} for ${issue.fingerprint.slice(0, 20)}\n`,
        );
        continue;
      }

      const created = await params.createGitHubIssue({
        token: params.token,
        repo: params.repo,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      });
      results.push({
        fingerprint: issue.fingerprint,
        operation: "created",
        issueNumber: created.number,
        issueUrl: created.html_url,
      });
      params.stderr?.write(
        `[ISSUE-WRITER] created #${created.number} for ${issue.fingerprint.slice(0, 20)}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        fingerprint: issue.fingerprint,
        operation: "failed_retryable",
        reason: message,
      });
      params.stderr?.write(
        `[ISSUE-WRITER] failed_retryable for ${issue.fingerprint.slice(0, 20)}: ${message}\n`,
      );
    }
  }

  return results;
}
