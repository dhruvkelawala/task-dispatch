import { describe, expect, test } from "bun:test";
import { buildExistingThreadDispatchMessage } from "../src/plugin/thread-messages";

describe("thread reuse kickoff message", () => {
  test("builds a reused-thread session active message with cwd", () => {
    const message = buildExistingThreadDispatchMessage(
      {
        id: "d3f892af-0d86-4613-a809-debec1e0bfdd",
        title: "hevy-cli follow-up: fix help text and history UX",
        cwd: "/Users/sumo-deus/.openclaw/workspace/hevy-cli",
      },
      "/Users/sumo-deus/.openclaw/workspace/hevy-cli",
    );

    expect(message).toContain("session active (reused thread)");
    expect(message).toContain("Messages here go directly to this session");
    expect(message).toContain("hevy-cli follow-up: fix help text and history UX-d3f892af-");
    expect(message).toContain("cwd: /Users/sumo-deus/.openclaw/workspace/hevy-cli");
  });
});
