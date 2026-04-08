import { describe, expect, test } from "bun:test";
import {
  buildQAReviewPrompt,
  extractCommitHash,
  parseMaatVerdict,
} from "../src/plugin/qa";

describe("qa", () => {
  test("parseMaatVerdict parses approve verdict", () => {
    const verdict = parseMaatVerdict("VERDICT: APPROVE\nSUMMARY: all good");
    expect(verdict).toEqual({ verdict: "approve", summary: "all good" });
  });

  test("parseMaatVerdict defaults to request_changes", () => {
    const verdict = parseMaatVerdict("");
    expect(verdict.verdict).toBe("request_changes");
  });

  test("extractCommitHash extracts commit hash", () => {
    expect(extractCommitHash("commit hash: abc1234f")).toBe("abc1234f");
  });

  test("buildQAReviewPrompt includes cwd and task id", () => {
    const prompt = buildQAReviewPrompt(
      { id: "task-1", title: "Refactor", cwd: "/repo", agent: "builder", output: "ok" },
      () => "/fallback",
    );
    expect(prompt.includes("task-1")).toBeTrue();
    expect(prompt.includes("/repo")).toBeTrue();
  });
});
