import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveAccountId(agent: string): string {
  return agent || "default";
}

export function resolveBotToken(accountId: string): string | null {
  try {
    const { readFileSync } = require("node:fs") as {
      readFileSync: (path: string, enc: string) => string;
    };
    const cfg = JSON.parse(
      readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"),
    ) as {
      channels?: { discord?: { accounts?: Record<string, { token?: string }> } };
    };
    return cfg.channels?.discord?.accounts?.[accountId]?.token || null;
  } catch {
    return null;
  }
}
