import { describe, expect, test } from "bun:test";
import { resolveChannel, resolveCwd } from "../src/plugin/config";

describe("config", () => {
  test("resolveChannel returns project channel then agent fallback", () => {
    const channel = resolveChannel(
      { projectId: "mission-control", agent: "zeus" },
      { "mission-control": "chan-1" },
    );
    expect(channel).toBe("chan-1");

    const fallback = resolveChannel({ agent: "zeus" }, {});
    expect(fallback).toBe("1475499310417182810");
  });

  test("resolveCwd returns task.cwd then project cwd then null", () => {
    expect(resolveCwd({ cwd: "/task" }, { p1: "/project" })).toBe("/task");
    expect(resolveCwd({ projectId: "p1" }, { p1: "/project" })).toBe("/project");
    expect(resolveCwd({}, {})).toBeNull();
  });
});
