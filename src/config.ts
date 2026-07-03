/**
 * Runtime configuration, loaded and validated from the environment.
 *
 * The bot is private and single-guild (see design.md "Technical stack"): it
 * needs its token, its application id (to register slash commands), and the id
 * of the one guild it is allowed to operate in. Everything else lives in the
 * database per-guild config.
 */

export interface BotConfig {
  /** Discord bot token used to log in to the gateway. */
  token: string;
  /** Application (client) id, used when registering slash commands. */
  appId: string;
  /** The single guild this bot serves; it leaves any other guild. */
  homeGuildId: string;
  /** Path to the SQLite database file. Defaults to ./vernissage.db. */
  databasePath: string;
}

/** Environment variable names, in one place so they are easy to document. */
export const ENV = {
  token: "DISCORD_TOKEN",
  appId: "DISCORD_APP_ID",
  homeGuildId: "HOME_GUILD_ID",
  databasePath: "DATABASE_PATH",
} as const;

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
  const homeGuildId = env[ENV.homeGuildId]?.trim();

  const missing: string[] = [];
  if (!token) missing.push(ENV.token);
  if (!appId) missing.push(ENV.appId);
  if (!homeGuildId) missing.push(ENV.homeGuildId);

  if (missing.length > 0) {
    throw new ConfigError(missing);
  }

  return {
    token: token!,
    appId: appId!,
    homeGuildId: homeGuildId!,
    databasePath: env[ENV.databasePath]?.trim() || "./vernissage.db",
  };
}
