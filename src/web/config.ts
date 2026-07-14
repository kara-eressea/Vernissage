/**
 * Dashboard (web) configuration, loaded and validated from the environment.
 *
 * The dashboard is a second process that shares the bot's SQLite file read-only
 * (see docs/dashboard.md "Architecture sketch"). It needs its own OAuth
 * credentials and a session-signing secret, plus the shared allowlist and
 * database path it reads alongside the bot. It deliberately does NOT take the
 * bot token: Tier-1 authorises moderators from the OAuth `guilds` scope alone,
 * so the bot's most sensitive secret never touches the internet-facing surface.
 */

import { ENV, parseGuildIds } from "../config.js";

export interface WebConfig {
  /** Discord OAuth2 client id — the same value as the bot's application id. */
  clientId: string;
  /** Discord OAuth2 client secret (Developer Portal → OAuth2). */
  clientSecret: string;
  /** Public base URL the dashboard is served at, e.g. https://tombola.example.com (no trailing slash). */
  baseUrl: string;
  /** OAuth redirect URI: baseUrl + "/auth/callback". Must match the portal registration. */
  redirectUri: string;
  /** Secret used to HMAC-sign session and OAuth-state cookies. */
  sessionSecret: string;
  /** TCP port to listen on (behind the reverse proxy). */
  port: number;
  /** Path to the shared SQLite database file (opened read-only). */
  databasePath: string;
  /** The guild allowlist, shared with the bot: only these guilds are servable. */
  guildIds: string[];
  /** Whether to trust X-Forwarded-* from the reverse proxy (client IP for rate limiting). */
  trustProxy: boolean;
  /** Whether to mark cookies Secure — true when the public base URL is https. */
  secureCookies: boolean;
}

/** Environment variable names specific to the dashboard, documented in .env.example. */
export const WEB_ENV = {
  clientId: "DISCORD_CLIENT_ID",
  clientSecret: "DISCORD_CLIENT_SECRET",
  baseUrl: "DASHBOARD_BASE_URL",
  sessionSecret: "DASHBOARD_SESSION_SECRET",
  port: "DASHBOARD_PORT",
  trustProxy: "DASHBOARD_TRUST_PROXY",
} as const;

/** Thrown when required dashboard configuration is missing, listing every problem. */
export class WebConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them before starting the dashboard.`,
    );
    this.name = "WebConfigError";
  }
}

/** Parse a boolean-ish env value; defaults to `fallback` when unset/blank. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Build a validated WebConfig from an environment map (defaults to
 * process.env). Collects all missing required vars before throwing so the
 * operator sees everything wrong at once, mirroring loadConfig.
 */
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  // The client id is the application id; accept the bot's DISCORD_APP_ID as a
  // fallback so a single-app setup needn't repeat it.
  const clientId = (env[WEB_ENV.clientId] ?? env[ENV.appId])?.trim();
  const clientSecret = env[WEB_ENV.clientSecret]?.trim();
  const baseUrlRaw = env[WEB_ENV.baseUrl]?.trim();
  const sessionSecret = env[WEB_ENV.sessionSecret]?.trim();
  const guildIds = parseGuildIds(env[ENV.guildIds] ?? env[ENV.homeGuildId]);

  const missing: string[] = [];
  if (!clientId) missing.push(WEB_ENV.clientId);
  if (!clientSecret) missing.push(WEB_ENV.clientSecret);
  if (!baseUrlRaw) missing.push(WEB_ENV.baseUrl);
  if (!sessionSecret) missing.push(WEB_ENV.sessionSecret);
  if (guildIds.length === 0) missing.push(ENV.guildIds);

  if (missing.length > 0) {
    throw new WebConfigError(missing);
  }

  const baseUrl = baseUrlRaw!.replace(/\/+$/, "");
  const portRaw = env[WEB_ENV.port]?.trim();
  const port = portRaw ? Number(portRaw) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WebConfigError([`${WEB_ENV.port} (must be a valid port number)`]);
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    baseUrl,
    redirectUri: `${baseUrl}/auth/callback`,
    sessionSecret: sessionSecret!,
    port,
    databasePath: env[ENV.databasePath]?.trim() || "./vernissage.db",
    guildIds,
    trustProxy: parseBool(env[WEB_ENV.trustProxy], true),
    secureCookies: baseUrl.startsWith("https://"),
  };
}
