/**
 * The dashboard HTTP server: routing and request handling.
 *
 * A small hand-rolled router over node:http — for a read-only, server-rendered
 * tool this avoids a web-framework dependency (docs/dashboard.md "Architecture
 * sketch"). It implements sequencing step 1: the Discord-login front door, the
 * OAuth callback, guild/mod gating, the guild picker/switcher, and the home
 * overview. It never writes the database.
 *
 * It is designed to sit behind a reverse proxy (Caddy/nginx) that terminates
 * TLS: it honours X-Forwarded-For for the client IP (rate limiting) when
 * `trustProxy` is set and marks cookies Secure based on the public base URL.
 */

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WebConfig } from "./config.js";
import type { Database } from "../db/index.js";
import { buildHomeView } from "./home.js";
import { selectManageableGuilds } from "./auth.js";
import { buildAuthorizeUrl, exchangeCode, fetchUser, fetchUserGuilds } from "./oauth.js";
import { RateLimiter } from "./rateLimit.js";
import {
  decodeSession,
  encodeSession,
  OAUTH_STATE_COOKIE,
  parseCookies,
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  serializeCookie,
  type Session,
  type SessionGuild,
} from "./session.js";
import { errorPage, homePage, loginPage, noAccessPage, pickerPage } from "./views.js";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth round-trip

export interface ServerDeps {
  config: WebConfig;
  db: Database;
}

/** Send an HTML response with the given status and any accumulated cookies. */
function sendHtml(res: ServerResponse, status: number, body: string, cookies: string[] = []): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...(cookies.length ? { "Set-Cookie": cookies } : {}),
  });
  res.end(body);
}

/** Send a 302 redirect with any accumulated cookies. */
function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, {
    Location: location,
    ...(cookies.length ? { "Set-Cookie": cookies } : {}),
  });
  res.end();
}

/** The client IP, honouring the proxy's X-Forwarded-For only when trusted. */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const raw = Array.isArray(fwd) ? fwd[0] : fwd;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** The guild the session currently points at, if the selection is still valid. */
function selectedGuild(session: Session): SessionGuild | undefined {
  if (!session.selectedGuildId) return undefined;
  return session.guilds.find((g) => g.id === session.selectedGuildId);
}

/** Build the Set-Cookie value that persists a (re-signed) session. */
function sessionCookie(session: Session, config: WebConfig): string {
  return serializeCookie(SESSION_COOKIE, encodeSession(session, config.sessionSecret), {
    maxAgeMs: SESSION_MAX_AGE_MS,
    secure: config.secureCookies,
  });
}

/** Expire a cookie by name. */
function clearCookie(name: string, config: WebConfig): string {
  return serializeCookie(name, "", { maxAgeMs: 0, secure: config.secureCookies });
}

/** Create the dashboard HTTP server. Call `.listen(port)` on the result. */
export function createServer(deps: ServerDeps): Server {
  const { config, db } = deps;
  const loginLimiter = new RateLimiter(30, 60 * 1000);
  // Periodically discard expired rate-limit windows so the map can't grow.
  const sweepTimer = setInterval(() => loginLimiter.sweep(Date.now()), 5 * 60 * 1000);
  sweepTimer.unref();

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("Unhandled request error:", err);
      if (!res.headersSent) {
        sendHtml(res, 500, errorPage("An unexpected error occurred."));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", config.baseUrl);
    const path = url.pathname;
    const cookies = parseCookies(req.headers.cookie);
    const now = Date.now();
    const session = decodeSession(cookies.get(SESSION_COOKIE), config.sessionSecret, now);

    // Health check for the reverse proxy / orchestrator — no auth, no DB.
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // GET is the only method these read-only routes use (forms use GET too).
    if (req.method !== "GET") {
      sendHtml(res, 405, errorPage("Method not allowed."));
      return;
    }

    if (path === "/") {
      if (session) {
        redirect(res, "/app");
      } else {
        sendHtml(res, 200, loginPage());
      }
      return;
    }

    if (path === "/login") {
      if (!loginLimiter.check(clientIp(req, config.trustProxy), now)) {
        sendHtml(res, 429, errorPage("Too many attempts. Please wait a minute and try again."));
        return;
      }
      const state = randomBytes(16).toString("hex");
      const stateCookie = serializeCookie(OAUTH_STATE_COOKIE, state, {
        maxAgeMs: STATE_MAX_AGE_MS,
        secure: config.secureCookies,
      });
      redirect(res, buildAuthorizeUrl(config, state), [stateCookie]);
      return;
    }

    if (path === "/auth/callback") {
      await handleCallback(req, res, url, cookies, now);
      return;
    }

    if (path === "/logout") {
      redirect(res, "/", [clearCookie(SESSION_COOKIE, config)]);
      return;
    }

    if (path === "/app") {
      handleApp(res, session);
      return;
    }

    if (path === "/app/select") {
      handleSelect(res, session, url);
      return;
    }

    sendHtml(res, 404, errorPage("Page not found."));
  }

  async function handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cookies: Map<string, string>,
    now: number,
  ): Promise<void> {
    if (!loginLimiter.check(clientIp(req, config.trustProxy), now)) {
      sendHtml(res, 429, errorPage("Too many attempts. Please wait a minute and try again."));
      return;
    }

    // Discord reports consent denial / errors in the query string.
    if (url.searchParams.get("error")) {
      sendHtml(res, 200, errorPage("Sign-in was cancelled."), [clearCookie(OAUTH_STATE_COOKIE, config)]);
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = cookies.get(OAUTH_STATE_COOKIE);
    // CSRF: the state must match the one we set, and both must be present.
    if (!code || !state || !expectedState || state !== expectedState) {
      sendHtml(res, 400, errorPage("Sign-in could not be verified. Please try again."), [
        clearCookie(OAUTH_STATE_COOKIE, config),
      ]);
      return;
    }

    let session: Session;
    try {
      const token = await exchangeCode(config, code);
      const [user, guilds] = await Promise.all([fetchUser(token), fetchUserGuilds(token)]);
      const manageable = selectManageableGuilds(guilds, config.guildIds);
      session = {
        uid: user.id,
        username: user.global_name || user.username,
        guilds: manageable,
        // Drop straight into the only guild when there is exactly one.
        selectedGuildId: manageable.length === 1 ? manageable[0]!.id : undefined,
        iat: now,
      };
    } catch (err) {
      console.error("OAuth callback failed:", err);
      sendHtml(res, 502, errorPage("Could not complete sign-in with Discord. Please try again."), [
        clearCookie(OAUTH_STATE_COOKIE, config),
      ]);
      return;
    }

    redirect(res, "/app", [sessionCookie(session, config), clearCookie(OAUTH_STATE_COOKIE, config)]);
  }

  function handleApp(res: ServerResponse, session: Session | null): void {
    if (!session) {
      redirect(res, "/");
      return;
    }
    if (session.guilds.length === 0) {
      sendHtml(res, 200, noAccessPage());
      return;
    }
    const guild = selectedGuild(session);
    if (!guild) {
      sendHtml(res, 200, pickerPage(session));
      return;
    }
    const view = buildHomeView(db, guild.id, new Date().toISOString());
    sendHtml(res, 200, homePage(session, guild, view));
  }

  function handleSelect(res: ServerResponse, session: Session | null, url: URL): void {
    if (!session) {
      redirect(res, "/");
      return;
    }
    const guildId = url.searchParams.get("guild");
    const chosen = session.guilds.find((g) => g.id === guildId);
    if (!chosen) {
      // Unknown/again-unauthorised guild: fall back to the picker.
      redirect(res, "/app");
      return;
    }
    const updated: Session = { ...session, selectedGuildId: chosen.id };
    redirect(res, "/app", [sessionCookie(updated, config)]);
  }

  server.on("close", () => clearInterval(sweepTimer));
  return server;
}
