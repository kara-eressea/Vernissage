/**
 * `npm run restore` — replace the database with the contents of a backup archive.
 *
 * Stop the bot and the dashboard first. Nothing prevents two processes from
 * using one database (see the README's "Run only one instance"), and swapping
 * the file under a running process leaves it holding a stale copy.
 *
 *   docker compose stop bot dashboard
 *   docker compose run --rm -v "$PWD:/backup" bot \
 *     node dist/src/restore.js /backup/vernissage-backup-....tar.gz --yes
 */

import { createInterface } from "node:readline/promises";
import { resolveDatabasePath } from "./config.js";
import { runRestore } from "./ops/restore.js";

interface Args {
  archivePath: string;
  force: boolean;
  yes: boolean;
  rewritePublishedDraws: boolean;
}

function parseArgs(argv: string[]): Args {
  let archivePath: string | undefined;
  let force = false;
  let yes = false;
  let rewritePublishedDraws = false;

  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--rewrite-published-draws") {
      rewritePublishedDraws = true;
    } else if (arg.startsWith("--")) {
      throw new Error(
        `Unknown option ${arg}. Usage: restore <archive.tar.gz> [--force] [--yes] ` +
          `[--rewrite-published-draws]`,
      );
    } else if (archivePath === undefined) {
      archivePath = arg;
    } else {
      throw new Error(`Unexpected argument ${arg}. Usage: restore <archive.tar.gz> [--force] [--yes]`);
    }
  }

  if (archivePath === undefined) {
    throw new Error("Usage: restore <archive.tar.gz> [--force] [--yes]");
  }
  return { archivePath, force, yes, rewritePublishedDraws };
}

/**
 * Make sure a human meant this, unless they already said so with --yes.
 *
 * "refused" and "declined" are kept apart because they exit differently: a
 * script that forgot --yes must fail loudly, or a `restore && docker compose up
 * -d` chain would start the stack on the un-restored database and report
 * success. Someone answering "no" at the prompt got what they asked for.
 */
type Confirmation = "confirmed" | "declined" | "refused";

async function confirm(databasePath: string): Promise<Confirmation> {
  if (!process.stdin.isTTY) {
    console.error(
      `Refusing to restore without confirmation. Re-run with --yes once the bot and dashboard are stopped.`,
    );
    return "refused";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `This will replace ${databasePath}. Stop the bot and dashboard first. Continue? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y" ? "confirmed" : "declined";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databasePath = resolveDatabasePath();

  if (!args.yes) {
    const answer = await confirm(databasePath);
    if (answer !== "confirmed") {
      console.log("Cancelled. Nothing was changed.");
      if (answer === "refused") {
        process.exitCode = 1;
      }
      return;
    }
  }

  const result = await runRestore({
    archivePath: args.archivePath,
    databasePath,
    force: args.force,
    rewritePublishedDraws: args.rewritePublishedDraws,
  });

  const { manifest, stats } = result;
  console.log(`Restored ${args.archivePath} to ${databasePath}`);
  console.log(`  taken ${manifest.createdAt} (app version ${manifest.appVersion})`);
  if (manifest.note) {
    console.log(`  note: ${manifest.note}`);
  }
  if (result.schemaVersionBefore === result.schemaVersionAfter) {
    console.log(`  schema version ${result.schemaVersionAfter}`);
  } else {
    console.log(
      `  schema version ${result.schemaVersionBefore} migrated up to ${result.schemaVersionAfter}`,
    );
  }
  console.log(`  guilds: ${stats.guildIds.join(", ") || "none"}`);
  const rows = Object.entries(stats.rowCounts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} ${n}`)
    .join(", ");
  console.log(`  ${rows || "no rows"}`);
  if (result.movedAsideTo) {
    console.log(`  previous database kept at ${result.movedAsideTo}`);
  }

  if (result.warnings.length > 0) {
    console.log(`\nWhat the replaced database had that this one does not:`);
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  console.log(
    `\nNext: put the secrets into .env (the archive's env.template lists which ones), then ` +
      `start the stack. Slash commands re-register themselves on startup.`,
  );
}

main().catch((err: unknown) => {
  console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
