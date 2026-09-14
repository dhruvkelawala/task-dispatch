import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createTaskApiRuntime } from "../src/plugin/task-api-runtime";
import { rowToTask, isValidTransition } from "../src/plugin/db";
import type { PluginApi } from "../src/plugin/types";

function createHarness() {
  const routes: Parameters<PluginApi["registerHttpRoute"]>[0][] = [];
  const queued: unknown[][] = [];
  const runtime = createTaskApiRuntime({
    api: {
      registerHttpRoute: (route: Parameters<PluginApi["registerHttpRoute"]>[0]) =>
        routes.push(route),
      on() {},
    },
    getTask: () => ({ id: "task-1", status: "review", review_attempts: 2, qa_required: 1 }),
    rowToTask,
    requireApiKey: () => true,
    backgroundEnqueue: (...args: unknown[]) => {
      queued.push(args);
      return true;
    },
  } as unknown as Parameters<typeof createTaskApiRuntime>[0]);
  runtime.registerTaskRoutes();
  const response = {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
    },
    end(body = "") {
      this.body = body;
    },
  };
  return { routes, queued, response };
}

describe("legacy BadVibes removal", () => {
  test("does not register the post-merge review intake", () => {
    const { routes } = createHarness();
    expect(routes.map((route) => route.path)).not.toContain("/api/tasks/review");
  });

  test("POST to the retired intake cannot create a review", async () => {
    const { routes, response, queued } = createHarness();
    const route = routes.find((entry) => entry.path === "/api/tasks")!;
    await route.handler({ method: "POST", url: "/api/tasks/review", on() {} }, response);
    expect(response.status).toBe(405);
    expect(queued).toEqual([]);
  });

  test("legacy bridge, reviewer, issue writer and auth modules are absent", () => {
    const paths = [
      "src/bridge/index.ts",
      "src/github-webhook.ts",
      "src/plugin/review.ts",
      "src/plugin/review-runtime.ts",
      "src/plugin/review-issues.ts",
      "src/plugin/github-app-auth.ts",
    ];
    expect(paths.filter((path) => existsSync(new URL(`../${path}`, import.meta.url)))).toEqual([]);
  });

  test("task QA accepts review status and retains review attempts", async () => {
    const { routes, response, queued } = createHarness();
    const route = routes.find((entry) => entry.path === "/api/tasks")!;
    await route.handler({ method: "POST", url: "/api/tasks/task-1/qa", on() {} }, response);
    expect(response.status).toBe(202);
    expect(queued).toEqual([["qa", "task-1"]]);
    await route.handler({ method: "GET", url: "/api/tasks/task-1", on() {} }, response);
    expect(JSON.parse(response.body)).toMatchObject({
      status: "review",
      reviewAttempts: 2,
      qaRequired: true,
    });
    expect(isValidTransition("in_progress", "review")).toBeTrue();
    expect(isValidTransition("review", "done")).toBeTrue();
    expect(isValidTransition("review", "in_progress")).toBeTrue();
  });
});
