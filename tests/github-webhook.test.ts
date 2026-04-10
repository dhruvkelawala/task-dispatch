import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  buildTaskDispatchReviewForwardRequest,
  forwardGitHubReview,
  isGitHubPingEvent,
  isRepoAllowedForBridge,
  normalizeGitHubPushWebhook,
  verifyGitHubSignature,
} from "../src/github-webhook";

describe("github webhook helpers", () => {
  test("verifies GitHub sha256 signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "top-secret";
    const digest = crypto.createHmac("sha256", secret).update(body).digest("hex");

    expect(
      verifyGitHubSignature({
        secret,
        body,
        signature256: `sha256=${digest}`,
      }),
    ).toBeTrue();
    expect(
      verifyGitHubSignature({
        secret,
        body,
        signature256: "sha256=deadbeef",
      }),
    ).toBeFalse();
  });

  test("normalizes a push to main into review payload", () => {
    expect(
      normalizeGitHubPushWebhook({
        deliveryId: "delivery-123",
        eventName: "push",
        payload: {
          ref: "refs/heads/main",
          before: "aaa111",
          after: "bbb222",
          compare: "https://github.com/org/repo/compare/aaa111...bbb222",
          installation: { id: 12345 },
          pusher: { name: "octocat" },
          repository: { full_name: "org/repo" },
        },
      }),
    ).toEqual({
      repo: "org/repo",
      beforeSha: "aaa111",
      sha: "bbb222",
      branch: "main",
      pusher: "octocat",
      compareUrl: "https://github.com/org/repo/compare/aaa111...bbb222",
      deliveryKey: "delivery-123",
      installationId: 12345,
    });
  });

  test("rejects non-push and non-main events", () => {
    expect(() =>
      normalizeGitHubPushWebhook({
        deliveryId: "delivery-123",
        eventName: "issues",
        payload: {},
      }),
    ).toThrow("unsupported_github_event");

    expect(() =>
      normalizeGitHubPushWebhook({
        deliveryId: "delivery-123",
        eventName: "push",
        payload: {
          ref: "refs/heads/feature-x",
          after: "bbb222",
          repository: { full_name: "org/repo" },
        },
      }),
    ).toThrow("unsupported_branch");
  });

  test("recognizes GitHub ping events", () => {
    expect(isGitHubPingEvent("ping")).toBeTrue();
    expect(isGitHubPingEvent("push")).toBeFalse();
  });

  test("builds a task-dispatch forward request", async () => {
    const payload = normalizeGitHubPushWebhook({
      deliveryId: "delivery-123",
      eventName: "push",
      payload: {
        ref: "refs/heads/main",
        before: "aaa111",
        after: "bbb222",
        installation: { id: 12345 },
        repository: { full_name: "org/repo" },
      },
    });

    const request = buildTaskDispatchReviewForwardRequest(payload, {
      taskDispatchUrl: "http://127.0.0.1:18789/",
      apiKey: "secret-key",
    });

    expect(request.url).toBe("http://127.0.0.1:18789/api/tasks/review");
    expect(request.init.method).toBe("POST");
    expect((request.init.headers as Record<string, string>)["X-API-Key"]).toBe("secret-key");
    expect(JSON.parse(String(request.init.body))).toEqual(payload);
  });

  test("forwards normalized payload to task-dispatch", async () => {
    const payload = normalizeGitHubPushWebhook({
      deliveryId: "delivery-123",
      eventName: "push",
      payload: {
        ref: "refs/heads/main",
        before: "aaa111",
        after: "bbb222",
        installation: { id: 12345 },
        repository: { full_name: "org/repo" },
      },
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await forwardGitHubReview(payload, {
      taskDispatchUrl: "http://127.0.0.1:18789",
      apiKey: "secret-key",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, taskId: "task-1" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:18789/api/tasks/review");
    expect(result).toEqual({
      status: 202,
      body: JSON.stringify({ ok: true, taskId: "task-1" }),
    });
  });

  test("allows only repos present in configured project mappings", () => {
    expect(
      isRepoAllowedForBridge({
        repo: "dhruvkelawala/visaroy",
        projects: {
          visaroy: { repo: "dhruvkelawala/visaroy" },
          taskDispatch: { repo: "dhruvkelawala/task-dispatch" },
        },
      }),
    ).toBeTrue();
    expect(
      isRepoAllowedForBridge({
        repo: "dhruvkelawala/unknown",
        projects: {
          visaroy: { repo: "dhruvkelawala/visaroy" },
        },
      }),
    ).toBeFalse();
  });
});
