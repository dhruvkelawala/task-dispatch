import { describe, expect, test } from "bun:test";
import { __test } from "../src/cli/index";

describe("cli helpers", () => {
  test("suggestProjects returns useful fuzzy matches", () => {
    const suggestions = __test.suggestProjects("goheavy");
    expect(suggestions).toContain("go-hevy");
  });

  test("resolveProject supports aliases", () => {
    expect(__test.resolveProject("mc")?.key).toBe("mission-control");
    expect(__test.resolveProject("oxr")?.key).toBe("0xready");
  });

  test("inferProjectFromCwd maps exact configured cwd to project", () => {
    expect(__test.inferProjectFromCwd("/Users/sumo-deus/.openclaw/workspace/hevy-cli")?.key).toBe("go-hevy");
  });

  test("parseArgs handles boolean and value flags", () => {
    const parsed = __test.parseArgs(["--project", "go-hevy", "--once", "--interval", "5"]);
    expect(parsed.project).toBe("go-hevy");
    expect(parsed.once).toBeTrue();
    expect(parsed.interval).toBe("5");
  });

  test("classifyTaskFailure detects QA model switch failures", () => {
    const result = __test.classifyTaskFailure({
      status: "error",
      error: "QA review loop failed: LiveSessionModelSwitchError: Live session model switch requested: anthropic/claude-sonnet-4-6",
    });
    expect(result.category).toBe("qa_model_switch");
    expect(result.nextStep).toContain("--no-qa");
  });

  test("classifyTaskFailure detects silent failures", () => {
    const result = __test.classifyTaskFailure({
      status: "error",
      error: "session produced nothing",
    });
    expect(result.category).toBe("silent_failure");
  });

  test("classifyTaskFailure detects thread binding issues", () => {
    const result = __test.classifyTaskFailure({
      status: "error",
      error: "Discord thread binding failed",
    });
    expect(result.category).toBe("thread_binding");
  });

  test("explainNextStep returns follow guidance for active tasks", () => {
    const next = __test.explainNextStep({ status: "in_progress" });
    expect(next).toContain("dispatch follow");
  });

  test("explainNextStep returns local verification guidance for done tasks", () => {
    const next = __test.explainNextStep({ status: "done" });
    expect(next).toContain("test the output locally");
  });
});
