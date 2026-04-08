import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cleanupPath = "";
let cliTest: any;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-cli-unit-home-"));
  cleanupPath = home;
  const configDir = join(home, ".openclaw", "data");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "task-dispatch-config.json"),
    JSON.stringify(
      {
        projects: {
          "web-app": { cwd: "/tmp/web-app", channel: "chan-web", defaultAgent: "builder", aliases: ["web"] },
          "control-plane": { cwd: "/tmp/control", channel: "chan-control", defaultAgent: "builder", aliases: ["cp"] },
          sdk: { cwd: "/tmp/sdk", channel: "chan-sdk", defaultAgent: "reviewer", aliases: ["kit"] },
          cli: { cwd: "/tmp/cli", channel: "chan-cli", defaultAgent: "builder" },
        },
        defaults: { defaultAgent: "builder" },
      },
      null,
      2,
    ),
  );
  process.env.HOME = home;
  ({ __test: cliTest } = await import(`../src/cli/index.ts?test=${Date.now()}`));
});

afterAll(() => {
  if (cleanupPath) {
    try {
      rmSync(cleanupPath, { recursive: true, force: true });
    } catch {}
  }
});

describe("cli helpers", () => {
  test("suggestProjects returns useful fuzzy matches", () => {
    const suggestions = cliTest.suggestProjects("webapp");
    expect(suggestions).toContain("web-app");
  });

  test("resolveProject supports aliases", () => {
    expect(cliTest.resolveProject("cp")?.key).toBe("control-plane");
    expect(cliTest.resolveProject("kit")?.key).toBe("sdk");
  });

  test("inferProjectFromCwd maps exact configured cwd to project", () => {
    expect(cliTest.inferProjectFromCwd("/tmp/cli")?.key).toBe("cli");
  });

  test("parseArgs handles boolean and value flags", () => {
    const parsed = cliTest.parseArgs(["--project", "cli", "--once", "--interval", "5"]);
    expect(parsed.project).toBe("cli");
    expect(parsed.once).toBeTrue();
    expect(parsed.interval).toBe("5");
  });

  test("classifyTaskFailure detects QA model switch failures", () => {
    const result = cliTest.classifyTaskFailure({
      status: "error",
      error: "QA review loop failed: LiveSessionModelSwitchError: Live session model switch requested: anthropic/claude-sonnet-4-6",
    });
    expect(result.category).toBe("qa_model_switch");
    expect(result.nextStep).toContain("--no-qa");
  });

  test("classifyTaskFailure detects silent failures", () => {
    const result = cliTest.classifyTaskFailure({
      status: "error",
      error: "session produced nothing",
    });
    expect(result.category).toBe("silent_failure");
  });

  test("classifyTaskFailure detects thread binding issues", () => {
    const result = cliTest.classifyTaskFailure({
      status: "error",
      error: "Discord thread binding failed",
    });
    expect(result.category).toBe("thread_binding");
  });

  test("explainNextStep returns follow guidance for active tasks", () => {
    const next = cliTest.explainNextStep({ status: "in_progress" });
    expect(next).toContain("dispatch follow");
  });

  test("explainNextStep returns local verification guidance for done tasks", () => {
    const next = cliTest.explainNextStep({ status: "done" });
    expect(next).toContain("test the output locally");
  });
});
