import { describe, expect, test } from "bun:test";
import { createDiscordRuntime } from "../src/plugin/discord-runtime";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[][]> = {};
  function track(name: string) {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  }

  return {
    calls,
    deps: {
      config: {
        channels: {
          discord: {
            accounts: {
              nemesis: { token: "nemesis-token" },
              default: { token: "default-token" },
            },
          },
        },
      },
      openclawConfig: {
        channels: {
          discord: {
            accounts: {
              zeus: { token: "zeus-openclaw-token" },
            },
          },
        },
      },
      defaultDiscordAccountId: "default",
      resolveAccountId: (agent: string) => agent,
      resolveChannel: () => "chan-1",
      formatDiscordThreadUrl: (threadId: string | null | undefined) =>
        threadId ? `https://discord.com/test/${threadId}` : null,
      recordTaskEvent: track("recordTaskEvent") as unknown as () => void,
      db: {
        prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
      },
      stderr: { write: () => true },
      ...overrides,
    },
  };
}

describe("discord-runtime", () => {
  test("resolveBotToken resolves from plugin config first", () => {
    const { deps } = makeDeps();
    const runtime = createDiscordRuntime(
      deps as unknown as Parameters<typeof createDiscordRuntime>[0],
    );
    expect(runtime.resolveBotToken("nemesis")).toBe("nemesis-token");
  });

  test("resolveBotToken falls back to openclaw config when no plugin match or default", () => {
    const { deps } = makeDeps({
      config: { channels: { discord: { accounts: { nemesis: { token: "nemesis-token" } } } } },
    });
    const runtime = createDiscordRuntime(
      deps as unknown as Parameters<typeof createDiscordRuntime>[0],
    );
    expect(runtime.resolveBotToken("zeus")).toBe("zeus-openclaw-token");
  });

  test("resolveBotToken falls back to plugin config default", () => {
    const { deps } = makeDeps();
    const runtime = createDiscordRuntime(
      deps as unknown as Parameters<typeof createDiscordRuntime>[0],
    );
    expect(runtime.resolveBotToken("unknown-agent")).toBe("default-token");
  });

  test("resolveBotToken returns null when no token found", () => {
    const { deps } = makeDeps({
      config: { channels: { discord: { accounts: {} } } },
      openclawConfig: { channels: { discord: { accounts: {} } } },
    });
    const runtime = createDiscordRuntime(
      deps as unknown as Parameters<typeof createDiscordRuntime>[0],
    );
    expect(runtime.resolveBotToken("missing")).toBeNull();
  });
});
