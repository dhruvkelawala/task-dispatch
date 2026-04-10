import { describe, expect, test } from "bun:test";
import {
  buildDiscordAcpPromptContext,
  buildDiscordAgentTarget,
  buildExistingThreadDispatchMessage,
} from "../src/plugin/thread-messages";

describe("thread reuse kickoff message", () => {
  test("builds a reused-thread session active message with cwd", () => {
    const message = buildExistingThreadDispatchMessage(
      {
        id: "d3f892af-0d86-4613-a809-debec1e0bfdd",
        title: "cli follow-up: fix help text and history UX",
        cwd: "/workspace/cli",
      },
      "/workspace/cli",
    );

    expect(message).toContain("session active (reused thread)");
    expect(message).toContain("Messages here go directly to this session");
    expect(message).toContain("cli follow-up: fix help text and history UX-d3f892af-");
    expect(message).toContain("cwd: /workspace/cli");
  });
});

test("buildDiscordAgentTarget prefers thread ids over parent channel ids", () => {
  expect(buildDiscordAgentTarget("1488655623087325327", "1488587493698703411")).toBe(
    "channel:1488655623087325327",
  );
  expect(buildDiscordAgentTarget(undefined, "1488587493698703411")).toBe(
    "channel:1488587493698703411",
  );
  expect(buildDiscordAgentTarget(undefined, undefined)).toBeUndefined();
});

test("buildDiscordAcpPromptContext includes thread and conversation ids", () => {
  expect(buildDiscordAcpPromptContext("1488655623087325327", "builder-bot")).toEqual({
    channel: "discord",
    accountId: "builder-bot",
    threadId: "1488655623087325327",
    conversationId: "1488655623087325327",
  });
  expect(buildDiscordAcpPromptContext(undefined, "builder-bot")).toEqual({
    channel: "discord",
    accountId: "builder-bot",
  });
});
