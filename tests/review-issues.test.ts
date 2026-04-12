import { describe, expect, test } from "bun:test";
import {
  buildReviewFindingFingerprint,
  buildReviewIssueBody,
  buildReviewIssueLabels,
  buildReviewIssueTitle,
  executePlannedReviewIssuesDryRun,
  planReviewIssues,
} from "../src/plugin/review-issues";

const finding = {
  title: "Users route is missing auth middleware",
  severity: "high" as const,
  category: "security",
  file: "src/routes/users.ts",
  line: 42,
  summary: "The route can be reached without authentication.",
  issueBody: "## Why this matters\nUnauthenticated access may expose protected data.",
};

describe("review issue helpers", () => {
  test("buildReviewFindingFingerprint is deterministic", () => {
    const first = buildReviewFindingFingerprint({
      repo: "org/web-app",
      finding,
    });
    const second = buildReviewFindingFingerprint({
      repo: "org/web-app",
      finding: {
        ...finding,
        title: "  Users route is missing auth middleware  ",
      },
    });

    expect(first).toBe(second);
    expect(first.startsWith("sha256:")).toBeTrue();
  });

  test("buildReviewIssueLabels and title use deterministic formatting", () => {
    expect(buildReviewIssueLabels(finding)).toEqual([
      "ai-review",
      "review:security",
      "severity:high",
    ]);
    expect(buildReviewIssueTitle(finding)).toBe(
      "[ai-review][high][security] Users route is missing auth middleware",
    );
  });

  test("buildReviewIssueBody renders a human-readable issue", () => {
    const fingerprint = buildReviewFindingFingerprint({
      repo: "org/web-app",
      finding,
    });
    const body = buildReviewIssueBody({
      repo: "org/web-app",
      reviewRange: "abc123..def456",
      fingerprint,
      finding,
    });

    expect(body).toContain("## Summary");
    expect(body).toContain("`src/routes/users.ts:42`");
    expect(body).toContain(`Fingerprint: \`${fingerprint}\``);
    expect(body).toContain("Review range: `abc123..def456`");
  });

  test("buildReviewIssueBody falls back to a server-generated detailed body", () => {
    const fingerprint = buildReviewFindingFingerprint({
      repo: "org/web-app",
      finding: { ...finding, issueBody: undefined },
    });
    const body = buildReviewIssueBody({
      repo: "org/web-app",
      reviewRange: "abc123..def456",
      fingerprint,
      finding: { ...finding, issueBody: undefined },
    });

    expect(body).toContain("## Problem");
    expect(body).toContain("## Suggested fix");
    expect(body).toContain("Inspect `src/routes/users.ts:42`");
  });

  test("planReviewIssues filters by severity threshold and produces deterministic issue plans", () => {
    const planned = planReviewIssues({
      repo: "org/web-app",
      reviewRange: "abc123..def456",
      minSeverity: "medium",
      findings: [
        finding,
        {
          title: "Minor copy tweak",
          severity: "low",
          category: "docs",
          file: "README.md",
          summary: "Small copy issue.",
          issueBody: "## Problem\nMinor.",
        },
      ],
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]?.title).toBe(
      "[ai-review][high][security] Users route is missing auth middleware",
    );
  });

  test("executePlannedReviewIssuesDryRun returns deterministic created operations", async () => {
    const planned = planReviewIssues({
      repo: "org/web-app",
      reviewRange: "abc123..def456",
      findings: [finding],
    });
    const plannedIssue = planned[0];
    expect(plannedIssue).toBeDefined();
    await expect(executePlannedReviewIssuesDryRun(planned)).resolves.toEqual([
      {
        fingerprint: plannedIssue!.fingerprint,
        operation: "created",
        reason: "dry_run",
      },
    ]);
  });
});
