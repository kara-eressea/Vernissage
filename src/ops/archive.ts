/**
 * Packing and unpacking the archive.
 *
 * A backup is a plain gzipped tar so it stays openable by hand years from now
 * with tools that are already on any machine — no bespoke container format and
 * no extra dependency. `tar` is part of the Debian base the runtime image is
 * built on, so it is present wherever the bot runs.
 */

import { spawn } from "node:child_process";

/** Thrown when the archive cannot be written or read. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Pack the named entries of `stageDir` into the gzipped tar at `outFile`.
 *
 * The entries are listed explicitly rather than packed as `.`, which would store
 * them as `./manifest.json` and add a `./` directory entry. That matters twice
 * over: `tar -xzf backup.tar.gz compose.yaml` would not match `./compose.yaml`,
 * and extracting the `./` entry would apply the staging directory's mode to
 * whatever directory the operator unpacks into.
 */
export async function createArchive(
  stageDir: string,
  outFile: string,
  entries: readonly string[],
): Promise<void> {
  await runTar(["-czf", outFile, "-C", stageDir, ...entries]);
}

/** Extract `archiveFile` into `destDir`. */
export async function extractArchive(archiveFile: string, destDir: string): Promise<void> {
  await runTar(["-xzf", archiveFile, "-C", destDir]);
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ArchiveError("`tar` was not found on this system; it is required to read and write backups."));
        return;
      }
      reject(new ArchiveError(`Could not run tar: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new ArchiveError(`tar exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
