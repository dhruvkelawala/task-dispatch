import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (!path) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
});

describe("cli process", () => {
  test("dispatch create --dry-run prints inferred project details", () => {
    const home = mkdtempSync(join(tmpdir(), "dispatch-cli-home-"));
    cleanupPaths.push(home);
    const configDir = join(home, ".openclaw", "data");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "task-dispatch-config.json"),
      JSON.stringify(
        {
          projects: {
            "go-hevy": {
              cwd: "/tmp/hevy-cli",
              channel: "123",
              defaultAgent: "zeus",
            },
          },
          defaults: { taskTimeoutMs: 1234567 },
        },
        null,
        2,
      ),
    );

    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        "src/cli/index.ts",
        "create",
        "-t",
        "Dry Run Test",
        "--cwd",
        "/tmp/hevy-cli",
        "--dry-run",
      ],
      cwd: "/Users/sumo-deus/.openclaw/extensions/task-dispatch",
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("DRY RUN — no task created");
    expect(stdout).toContain("Project: go-hevy");
    expect(stdout).toContain("CWD: /tmp/hevy-cli");
    expect(stdout).toContain("Agent: zeus");
    expect(stdout).toContain("TimeoutMs: 1234567");
  });
});
