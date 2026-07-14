/**
 * Runtime configuration, loaded and validated from the environment.
 *
 * The bot is private (see design.md "Technical stack"): it needs its token, its
 * application id (to register slash commands), and an allowlist of one or more
 * guilds it is permitted to operate in — it leaves any guild not on the list.
 * Everything else lives in the database per-guild config.
 */

export interface BotConfig {
  /** Discord bot token used to log in to the gateway. */
  token: string;
  /** Application (client) id, used when registering slash commands. */
  appId: string;
  /**
   * The guilds this bot serves (at least one). It registers commands in each,
   * counts activity in each, and leaves any guild not on this list.
   */
  guildIds: string[];
  /** Path to the SQLite database file. Defaults to ./vernissage.db. */
  databasePath: string;
}

/** Environment variable names, in one place so they are easy to document. */
export const ENV = {
  token: "DISCORD_TOKEN",
  appId: "DISCORD_APP_ID",
  /** Comma-separated allowlist of guild ids. */
  guildIds: "GUILD_IDS",
  /** Legacy single-guild variable, still honored as a fallback for GUILD_IDS. */
  homeGuildId: "HOME_GUILD_ID",
  databasePath: "DATABASE_PATH",
} as const;

/** Parse a comma-separated guild-id list: trim, drop blanks, de-duplicate. */
export function parseGuildIds(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0))];
}

/** Thrown when required configuration is missing, listing every problem. */
export class ConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them before starting the bot.`,
    );
    this.name = "ConfigError";
  }
}

/**
 * Build a validated BotConfig from an environment map (defaults to
 * process.env). Accepting the map as an argument keeps this testable without
 * mutating global state. Collects all missing required vars before throwing so
 * the operator sees everything wrong at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const token = env[ENV.token]?.trim();
  const appId = env[ENV.appId]?.trim();
  // Prefer GUILD_IDS (comma-separated); fall back to the legacy single-value
  // HOME_GUILD_ID so existing setups keep working with no change.
  const guildIds = parseGuildIds(env[ENV.guildIds] ?? env[ENV.homeGuildId]);

  const missing: string[] = [];
  if (!token) missing.push(ENV.token);
  if (!appId) missing.push(ENV.appId);
  if (guildIds.length === 0) missing.push(ENV.guildIds);

  if (missing.length > 0) {
    throw new ConfigError(missing);
  }

  return {
    token: token!,
    appId: appId!,
    guildIds,
    databasePath: env[ENV.databasePath]?.trim() || "./vernissage.db",
  };
}
