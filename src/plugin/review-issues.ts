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
    params.finding.issueBody.trim(),
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
    operation: "created",
    reason: "dry_run",
  }));
}
