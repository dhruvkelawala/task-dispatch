import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import setup from "../src/plugin/index";
import type { PluginHttpRequest, PluginHttpResponse } from "../src/plugin/types";

function createRes() {
  return {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headers = headers || {};
    },
    end(payload?: string) {
      this.body = payload || "";
    },
  };
}

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    try {
      rmSync(path, { force: true });
    } catch {}
  }
  tempPaths.clear();
});

describe("public config", () => {
  test("plugin manifest only exposes the safe public config surface", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema?: { properties?: Record<string, { type?: string }> };
    };

    expect(Object.keys(manifest.configSchema?.properties || {}).sort()).toEqual([
      "dbPath",
      "maxConcurrentSessions",
    ]);
    expect(manifest.configSchema?.properties?.dbPath?.type).toBe("string");
    expect(manifest.configSchema?.properties?.maxConcurrentSessions?.type).toBe("number");
  });

  test("dispatch health route reflects public config overrides", () => {
    const routes: Array<{
      path: string;
      handler: (req: PluginHttpRequest, res: PluginHttpResponse) => unknown;
    }> = [];
    const dbPath = `/tmp/task-dispatch-public-config-${Date.now()}.db`;
    tempPaths.add(dbPath);

    setup({
      config: { dbPath },
      registerHttpRoute(route) {
        routes.push(route);
      },
      on() {},
      runtime: {},
    });

    const healthRoute = routes.find((route) => route.path === "/api/dispatch/health");
    expect(healthRoute).toBeDefined();

    const res = createRes();
    healthRoute?.handler({ method: "GET", url: "/api/dispatch/health", on() {} }, res);

    const payload = JSON.parse(res.body) as {
      status: string;
      dbPath: string;
      maxConcurrentSessions: number;
    };

    expect(payload.status).toBe("ok");
    expect(payload.dbPath).toBe(dbPath);
    expect(payload.maxConcurrentSessions).toBe(2);
    expect(existsSync(dbPath)).toBeTrue();
  });
});
