/**
 * Dashboard entrypoint.
 *
 * A separate process from the bot (docs/dashboard.md "Architecture sketch"): it
 * opens the shared SQLite file read-only so a web bug can never take down
 * message counting or contend for the write lock. It holds only its OAuth
 * credentials and a session secret — never the bot token. Run it behind a
 * reverse proxy that terminates TLS.
 */

import { openDbReadonly } from "../db/index.js";
import { loadWebConfig, WebConfigError } from "./config.js";
import { createServer } from "./server.js";

function main(): void {
  let config;
  try {
    config = loadWebConfig();
  } catch (err) {
    if (err instanceof WebConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const db = openDbReadonly(config.databasePath);
  const server = createServer({ config, db });

  server.listen(config.port, () => {
    console.log(`Dashboard listening on port ${config.port} (base ${config.baseUrl})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}, shutting down dashboard.`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Don't hang forever if connections are slow to drain.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
