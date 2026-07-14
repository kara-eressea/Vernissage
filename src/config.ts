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
  /**
   * The Raffle Designer handoff listener, when enabled. Present only when
   * DESIGNER_HANDOFF_SECRET is set; otherwise the dashboard's "Create in Discord"
   * stays inert and the bot opens no inbound socket. The dashboard POSTs a
   * composed raffle here to stage it as a pending spec (design.md "Raffle Designer
   * handoff").
   */
  handoff?: HandoffConfig;
}

/** The internal handoff endpoint's bind address and shared secret. */
export interface HandoffConfig {
  /** Shared secret the dashboard presents as a Bearer token (constant-time checked). */
  secret: string;
  /** Bind host — localhost by default, so it isn't exposed off-box. */
  host: string;
  port: number;
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
  /** Shared secret enabling the Raffle Designer handoff listener (optional). */
  handoffSecret: "DESIGNER_HANDOFF_SECRET",
  /** Handoff listener bind host (default 127.0.0.1). */
  handoffHost: "DESIGNER_HANDOFF_HOST",
  /** Handoff listener port (default 8899). */
  handoffPort: "DESIGNER_HANDOFF_PORT",
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
    handoff: loadHandoffConfig(env),
  };
}

/**
 * The Raffle Designer handoff listener config, or undefined when the handoff is
 * off (no shared secret set). Throws only if the secret is set but the port is
 * invalid — a misconfiguration the operator should see immediately.
 */
function loadHandoffConfig(env: NodeJS.ProcessEnv): HandoffConfig | undefined {
  const secret = env[ENV.handoffSecret]?.trim();
  if (!secret) {
    return undefined;
  }
  const portRaw = env[ENV.handoffPort]?.trim();
  const port = portRaw ? Number(portRaw) : 8899;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError([`${ENV.handoffPort} (must be a valid port number)`]);
  }
  return {
    secret,
    host: env[ENV.handoffHost]?.trim() || "127.0.0.1",
    port,
  };
}
