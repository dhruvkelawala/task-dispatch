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
          visaroy: { cwd: "/tmp/visaroy", channel: "chan-vis", defaultAgent: "zeus" },
          "mission-control": { cwd: "/tmp/mc", channel: "chan-mc", defaultAgent: "zeus" },
          "0xready": { cwd: "/tmp/0xready", channel: "chan-oxr", defaultAgent: "zeus" },
          "go-hevy": { cwd: "/Users/sumo-deus/.openclaw/workspace/hevy-cli", channel: "chan-hevy", defaultAgent: "zeus" },
        },
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
    const suggestions = cliTest.suggestProjects("goheavy");
    expect(suggestions).toContain("go-hevy");
  });

  test("resolveProject supports aliases", () => {
    expect(cliTest.resolveProject("mc")?.key).toBe("mission-control");
    expect(cliTest.resolveProject("oxr")?.key).toBe("0xready");
  });

  test("inferProjectFromCwd maps exact configured cwd to project", () => {
    expect(cliTest.inferProjectFromCwd("/Users/sumo-deus/.openclaw/workspace/hevy-cli")?.key).toBe("go-hevy");
  });

  test("parseArgs handles boolean and value flags", () => {
    const parsed = cliTest.parseArgs(["--project", "go-hevy", "--once", "--interval", "5"]);
    expect(parsed.project).toBe("go-hevy");
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
