import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (!path) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
});

describe("cli command integration", () => {
  test(
    "non-interactive CLI commands work against API contract",
    async () => {
    const home = mkdtempSync(join(tmpdir(), "dispatch-cli-integration-home-"));
    cleanupPaths.push(home);

    const projectCwd = join(home, "workspace", "task-dispatch");
    mkdirSync(projectCwd, { recursive: true });

    const configDir = join(home, ".openclaw", "data");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "task-dispatch-config.json"),
      JSON.stringify(
        {
          apiKey: "test-api-key",
          defaults: { defaultAgent: "zeus", taskTimeoutMs: 60000 },
          channels: { discord: { guildId: "123456789012345678" } },
          projects: {
            "task-dispatch": {
              cwd: projectCwd,
              channel: "123456789012345678",
              defaultAgent: "zeus",
              aliases: ["td"],
            },
          },
        },
        null,
        2,
      ),
    );

    const doneId = "11111111-1111-4111-8111-111111111111";
    const errorId = "22222222-2222-4222-8222-222222222222";
    const activeId = "33333333-3333-4333-8333-333333333333";
    const deleteId = "44444444-4444-4444-8444-444444444444";

    const now = Date.now();
    const tasks: Record<string, Record<string, unknown>> = {
      [doneId]: {
        id: doneId,
        title: "Done task",
        description: "Completed",
        agent: "zeus",
        runtime: "acp",
        projectId: "task-dispatch",
        channelId: null,
        cwd: projectCwd,
        model: null,
        thinking: null,
        dependsOn: [],
        chainId: null,
        status: "done",
        manualComplete: false,
        sessionKey: "agent:opencode:acp:session-1",
        runId: "run-1",
        timeoutMs: 60000,
        threadId: "thread-1",
        output: "DONE_OK",
        retries: 0,
        reviewAttempts: 0,
        qaRequired: false,
        error: null,
        createdAt: now - 5000,
        updatedAt: now - 2000,
        completedAt: now - 1000,
      },
      [errorId]: {
        id: errorId,
        title: "Error task",
        description: "Failed",
        agent: "zeus",
        runtime: "acp",
        projectId: "task-dispatch",
        channelId: null,
        cwd: projectCwd,
        model: null,
        thinking: null,
        dependsOn: [],
        chainId: null,
        status: "error",
        manualComplete: false,
        sessionKey: "agent:opencode:acp:session-2",
        runId: "run-2",
        timeoutMs: 60000,
        threadId: "thread-2",
        output: "",
        retries: 1,
        reviewAttempts: 0,
        qaRequired: false,
        error: "mock failure",
        createdAt: now - 8000,
        updatedAt: now - 3000,
        completedAt: null,
      },
      [activeId]: {
        id: activeId,
        title: "Active task",
        description: "Running",
        agent: "zeus",
        runtime: "acp",
        projectId: "task-dispatch",
        channelId: null,
        cwd: projectCwd,
        model: null,
        thinking: null,
        dependsOn: [],
        chainId: null,
        status: "in_progress",
        manualComplete: false,
        sessionKey: "agent:opencode:acp:session-3",
        runId: "run-3",
        timeoutMs: 60000,
        threadId: "thread-3",
        output: "",
        retries: 0,
        reviewAttempts: 0,
        qaRequired: false,
        error: null,
        createdAt: now - 6000,
        updatedAt: now - 1500,
        completedAt: null,
      },
      [deleteId]: {
        id: deleteId,
        title: "Delete me",
        description: "To delete",
        agent: "zeus",
        runtime: "acp",
        projectId: "task-dispatch",
        channelId: null,
        cwd: projectCwd,
        model: null,
        thinking: null,
        dependsOn: [],
        chainId: null,
        status: "done",
        manualComplete: false,
        sessionKey: "agent:opencode:acp:session-4",
        runId: "run-4",
        timeoutMs: 60000,
        threadId: "thread-4",
        output: "DELETE_OK",
        retries: 0,
        reviewAttempts: 0,
        qaRequired: false,
        error: null,
        createdAt: now - 7000,
        updatedAt: now - 1400,
        completedAt: now - 1200,
      },
    };

    const eventsByTask: Record<string, Array<Record<string, unknown>>> = {
      [doneId]: [
        {
          eventType: "task.created",
          payload: { status: "ready" },
          createdAt: now - 4000,
        },
        {
          eventType: "task.done",
          payload: { status: "done", runId: "run-1", threadId: "thread-1" },
          createdAt: now - 1000,
        },
      ],
    };
    const heartbeats: Array<Record<string, unknown>> = [];

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    let createdCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const method = req.method.toUpperCase();
        const pathname = url.pathname;

        if (pathname === "/api/dispatch/health" && method === "GET") {
          return json({
            status: "ok",
            timestamp: Date.now(),
            activeSessions: 0,
            maxConcurrentSessions: 6,
            acpRuntimeAvailable: true,
            dbPath: "/tmp/mock.db",
          });
        }

        if (pathname === "/api/tasks" && method === "GET") {
          let rows = Object.values(tasks);
          const statusFilter = url.searchParams.get("status");
          const projectFilter = url.searchParams.get("projectId");
          if (statusFilter) rows = rows.filter((task) => String(task.status) === statusFilter);
          if (projectFilter) rows = rows.filter((task) => String(task.projectId) === projectFilter);
          return json(rows);
        }

        if (pathname === "/api/tasks" && method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          createdCount += 1;
          const id = `${String(createdCount).padStart(8, "0")}-aaaa-4aaa-8aaa-${String(createdCount).padStart(12, "0")}`;
          const created = {
            id,
            title: String(body.title || "Created task"),
            description: body.description || null,
            agent: body.agent || "zeus",
            runtime: body.runtime || null,
            projectId: body.projectId || "task-dispatch",
            channelId: null,
            cwd: body.cwd || projectCwd,
            model: body.model || null,
            thinking: body.thinking || null,
            dependsOn: body.dependsOn || [],
            chainId: body.chainId || null,
            status: "ready",
            manualComplete: false,
            sessionKey: null,
            runId: null,
            timeoutMs: body.timeoutMs || 60000,
            threadId: body.threadId || null,
            output: null,
            retries: 0,
            reviewAttempts: 0,
            qaRequired: body.qaRequired !== false,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            completedAt: null,
          };
          tasks[id] = created;
          return json(created, 201);
        }

        if (pathname === "/api/tasks/stats" && method === "GET") {
          return json({
            byStatus: { done: 2, error: 1, in_progress: 1 },
            byAgent: { zeus: 4 },
            byProject: { "task-dispatch": 4 },
          });
        }

        if (pathname === "/api/heartbeats" && method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const row = { ...body, id: heartbeats.length + 1, createdAt: Date.now() };
          heartbeats.push(row);
          return json(row, 201);
        }

        if (pathname === "/api/heartbeats" && method === "GET") {
          return json(heartbeats.slice().reverse());
        }

        if (pathname === "/api/heartbeats/health" && method === "GET") {
          return json({ status: "ok", staleThresholdMs: 60000 });
        }

        if (pathname.startsWith("/api/tasks/")) {
          const parts = pathname.split("/").filter(Boolean);
          const id = parts[2] || "";
          const action = parts[3] || "";
          const task = tasks[id];

          if (action === "events" && method === "GET") {
            return json(eventsByTask[id] || []);
          }

          if (action === "prompt" && method === "POST") {
            if (!task) return json({ error: "Task not found" }, 404);
            return json({ ok: true, taskId: id, runId: `run-prompt-${Date.now()}` });
          }

          if (action === "resume" && method === "POST") {
            if (!task) return json({ error: "Task not found" }, 404);
            return json({ ok: true, queued: true, taskId: id });
          }

          if (action === "qa" && method === "POST") {
            if (!task) return json({ error: "Task not found" }, 404);
            return json({ ok: true, queued: true, taskId: id });
          }

          if (!action && method === "GET") {
            if (!task) return json({ error: "Task not found" }, 404);
            return json(task);
          }

          if (!action && method === "PATCH") {
            if (!task) return json({ error: "Task not found" }, 404);
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
            const updated = {
              ...task,
              ...body,
              updatedAt: Date.now(),
              completedAt:
                body.status === "done"
                  ? Date.now()
                  : body.status === "error"
                    ? null
                    : task.completedAt,
            };
            tasks[id] = updated;
            return json(updated);
          }

          if (!action && method === "DELETE") {
            if (!task) return json({ error: "Task not found" }, 404);
            delete tasks[id];
            return json({ deleted: true, id });
          }
        }

        return json({ error: "Not found" }, 404);
      },
    });

    const runCli = async (args: string[]) => {
      const proc = Bun.spawn({
        cmd: ["bun", "src/cli/index.ts", ...args],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          DISPATCH_URL: `http://127.0.0.1:${server.port}`,
          DISPATCH_API_KEY: "test-api-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      return {
        exitCode,
        stdout,
        stderr,
      };
    };

    const commands: string[][] = [
      ["help"],
      ["projects"],
      ["health"],
      ["doctor"],
      ["list"],
      ["active"],
      ["watch", "--once", "--interval", "1"],
      ["history"],
      ["recent-errors"],
      ["get", doneId],
      ["inspect", doneId],
      ["explain", doneId],
      ["logs", doneId],
      ["timeline", doneId],
      ["open", doneId],
      ["follow", doneId],
      ["prompt", doneId, "smoke prompt"],
      ["update", doneId, "--status", "done"],
      ["resume", doneId],
      ["qa", doneId],
      ["retry", doneId, "--reuse-thread", "--no-qa"],
      ["create", "-t", "Smoke Create", "-p", "task-dispatch", "-a", "zeus", "--no-qa", "-d", "smoke"],
      ["stats"],
      ["delete", deleteId],
      ["heartbeat", "log", "--agent", "zeus", "--name", "Zeus", "--status", "working", "--action", "SMOKE", "--detail", "ok"],
      ["heartbeat", "list", "--limit", "5"],
      ["heartbeat", "health"],
    ];

    try {
      for (const cmd of commands) {
        const result = await runCli(cmd);
        if (result.exitCode !== 0) {
          throw new Error(
            `dispatch ${cmd.join(" ")} failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          );
        }
      }
    } finally {
      server.stop(true);
    }

      expect(true).toBeTrue();
    },
    120_000,
  );
});
