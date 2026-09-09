import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { runBackup } from "../../src/ops/backup.js";

// The exit code is the contract a script depends on, so this drives the real
// entry point rather than the library underneath it.
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "vernissage-cli-test-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runRestoreCli(args: string[], databasePath: string) {
  return spawnSync("npx", ["tsx", "src/restore.ts", ...args], {
    encoding: "utf8",
    // No TTY on stdin, which is the scripted case.
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DATABASE_PATH: databasePath },
  });
}

describe("restore CLI", () => {
  it("exits non-zero when it refuses for want of --yes", async () => {
    openDb(join(work, "source.db")).close();
    const { archivePath } = await runBackup({
      databasePath: join(work, "source.db"),
      outDir: join(work, "archives"),
      env: {},
    });

    const dest = join(work, "dest.db");
    const refused = runRestoreCli([archivePath], dest);

    // Exiting 0 here would let `restore && docker compose up -d` start the bot
    // on a database that was never restored.
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Refusing to restore without confirmation");

    const accepted = runRestoreCli([archivePath, "--yes"], dest);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("Restored");
  }, 60_000);
});
