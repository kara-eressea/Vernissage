/**
 * Discord OAuth2 — the identity half of the auth shell.
 *
 * The dashboard uses the Authorization Code flow with the `identify` and
 * `guilds` scopes: `identify` tells us who the visitor is, `guilds` lists the
 * servers they are in (with their permission bits) so we can intersect with the
 * allowlist and decide moderator access without holding the bot token (see
 * auth.ts). All calls use the global `fetch` — no HTTP dependency.
 */

import type { WebConfig } from "./config.js";

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const API = "https://discord.com/api/v10";

/** Build the Discord consent URL to redirect the visitor to. */
export function buildAuthorizeUrl(config: WebConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    scope: "identify guilds",
    redirect_uri: config.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code for an access token. Throws on failure. */
export async function exchangeCode(config: WebConfig, code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("OAuth token exchange returned no access_token");
  }
  return json.access_token;
}

/** The subset of the Discord user object we use. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

/** Fetch the authenticated user (the `identify` scope). Throws on failure. */
export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Fetching user failed: ${res.status}`);
  }
  return (await res.json()) as DiscordUser;
}

/** A partial guild from `/users/@me/guilds` — includes the user's permissions. */
export interface DiscordPartialGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  /** The user's permission bitfield in this guild, as a decimal string. */
  permissions: string;
}

/** Fetch the guilds the user is a member of (the `guilds` scope). Throws on failure. */
export async function fetchUserGuilds(accessToken: string): Promise<DiscordPartialGuild[]> {
  const res = await fetch(`${API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Fetching guilds failed: ${res.status}`);
  }
  return (await res.json()) as DiscordPartialGuild[];
}
