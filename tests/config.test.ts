import { describe, expect, test } from "bun:test";
import { resolveChannel, resolveCwd } from "../src/plugin/config";

describe("config", () => {
  test("resolveChannel returns project channel", () => {
    const channel = resolveChannel(
      { projectId: "control-plane", agent: "builder" },
      { "control-plane": "chan-1" },
    );
    expect(channel).toBe("chan-1");
  });

  test("resolveChannel throws when no projectId/channelId", () => {
    expect(() => resolveChannel({ title: "Missing route", id: "task-123456" }, {})).toThrow(
      "has no projectId or channelId",
    );
  });

  test("resolveCwd returns task.cwd then project cwd then null", () => {
    expect(resolveCwd({ cwd: "/task" }, { p1: "/project" })).toBe("/task");
    expect(resolveCwd({ projectId: "p1" }, { p1: "/project" })).toBe("/project");
    expect(resolveCwd({}, {})).toBeNull();
  });
});
