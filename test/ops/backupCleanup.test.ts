import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index.js";

// Make the pack step fail *after* it has written something, which is the shape
// of a real interrupted tar (disk full, killed process). Only createArchive is
// replaced; everything else in the module keeps its real behaviour.
vi.mock("../../src/ops/archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ops/archive.js")>();
  return {
    ...actual,
    createArchive: vi.fn(async (_stageDir: string, outFile: string) => {
      writeFileSync(outFile, "truncated archive");
      throw new Error("tar was interrupted");
    }),
  };
});

const { runBackup } = await import("../../src/ops/backup.js");

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "vernissage-cleanup-test-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("backup cleanup", () => {
  it("removes a partly-written archive instead of leaving a plausible name", async () => {
    const source = join(work, "source.db");
    openDb(source).close();
    const outDir = join(work, "out");

    await expect(runBackup({ databasePath: source, outDir, env: {} })).rejects.toThrow(
      /tar was interrupted/,
    );

    // A truncated file under a real-looking backup name is worse than no file:
    // a script picking "the newest archive" would choose it.
    const leftovers = existsSync(outDir)
      ? (await import("node:fs")).readdirSync(outDir)
      : [];
    expect(leftovers).toEqual([]);
  });
});
