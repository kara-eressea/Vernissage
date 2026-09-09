/**
 * Locating files that ship alongside the compiled code.
 *
 * The ops tools run both from source (`tsx src/backup.ts`, where this module
 * sits in src/ops) and from the build (`node dist/src/backup.js`, where it sits
 * in dist/src/ops). The package root is a different number of levels up in each,
 * so walk up until a package.json turns up rather than hard-coding a depth.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding the nearest package.json above this module. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate the package root (no package.json found above this module).");
    }
    dir = parent;
  }
}

/**
 * The app version from package.json, or "unknown". Informational only — restore
 * compatibility is decided by the schema version, not this.
 */
export function appVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}
