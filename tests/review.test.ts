import { describe, expect, test } from "bun:test";
import {
  applyFailedReviewCompletion,
  applySuccessfulReviewCompletion,
  buildReviewTaskDescription,
  buildReviewTaskTitle,
  parseReviewSummary,
  planReviewRequest,
  resolveProjectIdForRepo,
  resolveReviewRange,
  shouldAdvanceReviewCursor,
  transitionPendingReviewState,
} from "../src/plugin/review";

describe("review helpers", () => {
  test("resolveProjectIdForRepo uses configured repo mapping", () => {
    expect(
      resolveProjectIdForRepo(
        {
          projects: {
            "web-app": { repo: "Org/Web-App" },
            cli: { repo: "org/cli" },
          },
        },
        "org/web-app",
      ),
    ).toBe("web-app");
    expect(resolveProjectIdForRepo({ projects: {} }, "org/missing")).toBeNull();
  });

  test("resolveReviewRange prefers last reviewed sha, then before sha", () => {
    expect(
      resolveReviewRange(
        {
          repo: "org/web-app",
          last_reviewed_sha: "aaa111",
          last_review_at: null,
          pending_from_sha: null,
          pending_to_sha: null,
          pending_task_id: null,
          pending_updated_at: null,
          active_from_sha: null,
          active_to_sha: null,
          active_task_id: null,
        },
        { repo: "org/web-app", beforeSha: "bbb222", sha: "ccc333", deliveryKey: "k" },
      ),
    ).toEqual({ fromSha: "aaa111", toSha: "ccc333" });

    expect(
      resolveReviewRange(null, {
        repo: "org/web-app",
        beforeSha: "bbb222",
        sha: "ccc333",
        deliveryKey: "k",
      }),
    ).toEqual({ fromSha: "bbb222", toSha: "ccc333" });
  });

  test("buildReviewTaskTitle and description include range metadata", () => {
    expect(buildReviewTaskTitle("org/web-app", "abcdef1234567890")).toContain(
      "web-app @ abcdef123456",
    );
    const description = buildReviewTaskDescription({
      repo: "org/web-app",
      projectId: "web-app",
      fromSha: "aaa111",
      toSha: "bbb222",
      branch: "main",
      pusher: "octocat",
      compareUrl: "https://example.com/compare",
    });
    expect(description).toContain("Range: aaa111..bbb222");
    expect(description).toContain("Required final machine-readable summary");
    expect(description).toContain("schemaVersion");
    expect(description).toContain("Do not create or update GitHub issues directly");
  });

  test("parseReviewSummary returns the last valid fenced JSON summary", () => {
    const summary = parseReviewSummary(
      [
        "noise",
        "",
        "```json",
        '{"hello":true}',
        "```",
        "",
        "```json",
        "{",
        '  "schemaVersion": 1,',
        '  "reviewOutcome": "success",',
        '  "findingsCount": 2,',
        '  "findings": [',
        '    { "title": "A", "severity": "high", "category": "bug", "file": "a.ts", "line": 1, "summary": "A", "issueBody": "Body A" },',
        '    { "title": "B", "severity": "medium", "category": "test", "file": "b.ts", "summary": "B", "issueBody": "Body B" }',
        "  ]",
        "}",
        "```",
      ].join("\n"),
    );
    expect(summary).toEqual({
      schemaVersion: 1,
      reviewOutcome: "success",
      findingsCount: 2,
      findings: [
        {
          title: "A",
          severity: "high",
          category: "bug",
          file: "a.ts",
          line: 1,
          summary: "A",
          issueBody: "Body A",
        },
        {
          title: "B",
          severity: "medium",
          category: "test",
          file: "b.ts",
          summary: "B",
          issueBody: "Body B",
        },
      ],
    });
  });

  test("shouldAdvanceReviewCursor only advances on clean or post-issue-write success", () => {
    expect(
      shouldAdvanceReviewCursor({
        schemaVersion: 1,
        reviewOutcome: "success",
        findingsCount: 0,
        findings: [],
      }),
    ).toBeTrue();
    expect(
      shouldAdvanceReviewCursor({
        schemaVersion: 1,
        reviewOutcome: "success",
        findingsCount: 1,
        findings: [
          {
            title: "A",
            severity: "high",
            category: "bug",
            file: "a.ts",
            summary: "A",
            issueBody: "Body A",
          },
        ],
        issueOps: [{ operation: "created" }, { operation: "skipped_low_severity" }],
      }),
    ).toBeTrue();
    expect(
      shouldAdvanceReviewCursor({
        schemaVersion: 1,
        reviewOutcome: "success",
        findingsCount: 1,
        findings: [
          {
            title: "A",
            severity: "high",
            category: "bug",
            file: "a.ts",
            summary: "A",
            issueBody: "Body A",
          },
        ],
      }),
    ).toBeTrue();
    expect(
      shouldAdvanceReviewCursor({
        schemaVersion: 1,
        reviewOutcome: "failed_retryable",
        findingsCount: 1,
        findings: [
          {
            title: "A",
            severity: "high",
            category: "bug",
            file: "a.ts",
            summary: "A",
            issueBody: "Body A",
          },
        ],
        issueOps: [{ operation: "created" }, { operation: "skipped_low_severity" }],
      }),
    ).toBeFalse();
    expect(
      shouldAdvanceReviewCursor({
        schemaVersion: 1,
        reviewOutcome: "success",
        findingsCount: 1,
        findings: [
          {
            title: "A",
            severity: "high",
            category: "bug",
            file: "a.ts",
            summary: "A",
            issueBody: "Body A",
          },
        ],
        issueOps: [{ operation: "failed_retryable" }],
      }),
    ).toBeFalse();
    expect(shouldAdvanceReviewCursor(null)).toBeFalse();
  });

  test("planReviewRequest covers create, debounce, active isolation, and duplicate", () => {
    expect(
      planReviewRequest({
        state: null,
        fromSha: "aaa111",
        toSha: "bbb222",
        duplicateDelivery: false,
      }),
    ).toEqual({
      status: "created",
      pendingFromSha: "aaa111",
      pendingToSha: "bbb222",
    });

    expect(
      planReviewRequest({
        state: {
          repo: "org/web-app",
          last_reviewed_sha: "aaa111",
          last_review_at: 1,
          pending_from_sha: "aaa111",
          pending_to_sha: "bbb222",
          pending_task_id: "task-1",
          pending_updated_at: 2,
          active_from_sha: null,
          active_to_sha: null,
          active_task_id: null,
        },
        fromSha: "aaa111",
        toSha: "ccc333",
        duplicateDelivery: false,
      }),
    ).toEqual({
      status: "debounced",
      pendingFromSha: "aaa111",
      pendingToSha: "ccc333",
    });

    expect(
      planReviewRequest({
        state: {
          repo: "org/web-app",
          last_reviewed_sha: "aaa111",
          last_review_at: 1,
          pending_from_sha: null,
          pending_to_sha: null,
          pending_task_id: null,
          pending_updated_at: null,
          active_from_sha: "aaa111",
          active_to_sha: "bbb222",
          active_task_id: "task-1",
        },
        fromSha: "aaa111",
        toSha: "ccc333",
        duplicateDelivery: false,
      }),
    ).toEqual({
      status: "queued_after_active_review",
      pendingFromSha: "bbb222",
      pendingToSha: "ccc333",
    });

    expect(
      planReviewRequest({
        state: {
          repo: "org/web-app",
          last_reviewed_sha: "aaa111",
          last_review_at: 1,
          pending_from_sha: "aaa111",
          pending_to_sha: "bbb222",
          pending_task_id: "task-1",
          pending_updated_at: 2,
          active_from_sha: null,
          active_to_sha: null,
          active_task_id: null,
        },
        fromSha: "aaa111",
        toSha: "bbb222",
        duplicateDelivery: true,
      }),
    ).toEqual({
      status: "duplicate",
      pendingFromSha: "aaa111",
      pendingToSha: "bbb222",
    });
  });

  test("transitionPendingReviewState moves pending window into active window atomically", () => {
    expect(
      transitionPendingReviewState({
        repo: "org/web-app",
        last_reviewed_sha: "aaa111",
        last_review_at: 1,
        pending_from_sha: "aaa111",
        pending_to_sha: "bbb222",
        pending_task_id: "task-1",
        pending_updated_at: 2,
        active_from_sha: null,
        active_to_sha: null,
        active_task_id: null,
      }),
    ).toEqual({
      repo: "org/web-app",
      last_reviewed_sha: "aaa111",
      last_review_at: 1,
      pending_from_sha: null,
      pending_to_sha: null,
      pending_task_id: null,
      pending_updated_at: null,
      active_from_sha: "aaa111",
      active_to_sha: "bbb222",
      active_task_id: "task-1",
    });
  });

  test("review completion helpers advance or preserve cursor appropriately", () => {
    const activeState = {
      repo: "org/web-app",
      last_reviewed_sha: "aaa111",
      last_review_at: 1,
      pending_from_sha: "bbb222",
      pending_to_sha: "ccc333",
      pending_task_id: "task-2",
      pending_updated_at: 5,
      active_from_sha: "aaa111",
      active_to_sha: "bbb222",
      active_task_id: "task-1",
    };

    expect(applySuccessfulReviewCompletion(activeState, 10)).toEqual({
      repo: "org/web-app",
      last_reviewed_sha: "bbb222",
      last_review_at: 10,
      pending_from_sha: "bbb222",
      pending_to_sha: "ccc333",
      pending_task_id: "task-2",
      pending_updated_at: 5,
      active_from_sha: null,
      active_to_sha: null,
      active_task_id: null,
    });

    expect(
      applySuccessfulReviewCompletion(
        {
          ...activeState,
          pending_from_sha: "aaa111",
          pending_to_sha: "bbb222",
          pending_task_id: "task-2",
        },
        10,
      ),
    ).toEqual({
      repo: "org/web-app",
      last_reviewed_sha: "bbb222",
      last_review_at: 10,
      pending_from_sha: null,
      pending_to_sha: null,
      pending_task_id: null,
      pending_updated_at: null,
      active_from_sha: null,
      active_to_sha: null,
      active_task_id: null,
    });

    expect(applyFailedReviewCompletion(activeState, 10)).toEqual({
      repo: "org/web-app",
      last_reviewed_sha: "aaa111",
      last_review_at: 1,
      pending_from_sha: "aaa111",
      pending_to_sha: "ccc333",
      pending_task_id: "task-2",
      pending_updated_at: 5,
      active_from_sha: null,
      active_to_sha: null,
      active_task_id: null,
    });
  });
});
