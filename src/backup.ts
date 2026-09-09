/**
 * `npm run backup` — write a backup archive of the live database.
 *
 * Safe to run while the bot is running: the snapshot is taken through a
 * read-only connection and sees every committed transaction.
 *
 *   docker compose run --rm -v "$PWD:/backup" bot node dist/src/backup.js /backup
 */

import { resolveDatabasePath } from "./config.js";
import { runBackup } from "./ops/backup.js";

interface Args {
  outDir: string;
  note?: string;
}

function parseArgs(argv: string[]): Args {
  let outDir: string | undefined;
  let note: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--note") {
      note = argv[++i];
      if (note === undefined) {
        throw new Error("--note needs a value.");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}. Usage: backup [output-directory] [--note "text"]`);
    } else if (outDir === undefined) {
      outDir = arg;
    } else {
      throw new Error(`Unexpected argument ${arg}. Usage: backup [output-directory] [--note "text"]`);
    }
  }

  return { outDir: outDir ?? ".", ...(note ? { note } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databasePath = resolveDatabasePath();

  console.log(`Backing up ${databasePath} ...`);
  const result = await runBackup({
    databasePath,
    outDir: args.outDir,
    env: process.env,
    ...(args.note ? { note: args.note } : {}),
  });

  const { manifest } = result;
  const rows = Object.entries(manifest.rowCounts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} ${n}`)
    .join(", ");

  console.log(`Wrote ${result.archivePath} (${formatBytes(result.bytes)})`);
  console.log(`  schema version ${manifest.schemaVersion}, guilds: ${manifest.guildIds.join(", ") || "none"}`);
  console.log(`  ${rows || "no rows"}`);
  console.log(
    `\nYour credentials are not in the archive — keep a copy of this host's .env, or fill in ` +
      `the blanks in the archive's env.template on the new host. The database itself is still ` +
      `private data, so store the archive accordingly.`,
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

main().catch((err: unknown) => {
  console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
