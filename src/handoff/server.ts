/**
 * The Raffle Designer handoff listener (bot side).
 *
 * The read-only dashboard can't write the database, so when a moderator hands a
 * composed raffle off from the Designer, the dashboard POSTs it to this small
 * authenticated endpoint on the bot — the sole DB writer (design.md "Raffle
 * Designer handoff"). The bot re-validates the submission, stages it as an inert
 * pending spec keyed by a friendly single-use token bound to that moderator, and
 * returns the token for the moderator to redeem in Discord with
 * `/raffle from-design`. Nothing is published here; the raffle becomes real only
 * on redemption.
 *
 * The listener binds to localhost by default and authenticates the dashboard
 * with a shared secret. The request logic is split out as `handleStage` so it can
 * be unit-tested without opening a socket.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { HandoffConfig } from "../config.js";
import { AUDIT_EVENTS } from "../core/auditEvents.js";
import { buildPendingSpec, type DesignerSubmission } from "../core/designerSpec.js";
import { generateToken } from "../core/friendlyToken.js";
import { writeAudit } from "../db/repositories/audit.js";
import { getGuild } from "../db/repositories/guilds.js";
import { pendingTokenExists, stagePendingRaffle } from "../db/repositories/pendingRaffles.js";

/** How long a staged token stays redeemable. */
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

/** The route the dashboard POSTs a composed raffle to. */
const STAGE_PATH = "/stage-raffle";

/** Cap the request body so a bad client can't feed us an unbounded stream. */
const MAX_BODY_BYTES = 32 * 1024;

/** The result of processing a stage request: an HTTP status and JSON body. */
export interface StageResult {
  status: number;
  body: unknown;
}

/** The expected request payload from the dashboard. */
interface StageRequest {
  guildId: string;
  moderatorUserId: string;
  submission: DesignerSubmission;
}

/** Constant-time compare of the presented bearer token to the shared secret. */
function authorized(authHeader: string | undefined, secret: string): boolean {
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether a parsed body has the shape we require (shallow guard). */
function isStageRequest(v: unknown): v is StageRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.guildId === "string" &&
    typeof r.moderatorUserId === "string" &&
    typeof r.submission === "object" &&
    r.submission !== null
  );
}

/**
 * Process a stage request: authenticate, validate the guild + submission, mint a
 * unique token, stage the spec, and audit it. Pure of sockets — `now` and the
 * token generator are injected so it is deterministic under test.
 */
export function handleStage(
  db: Database,
  opts: { secret: string; guildIds: string[] },
  authHeader: string | undefined,
  rawBody: string,
  now: string,
  gen: () => string = () => generateToken(),
): StageResult {
  if (!authorized(authHeader, opts.secret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (!isStageRequest(parsed)) {
    return { status: 400, body: { error: "invalid_request" } };
  }

  const { guildId, moderatorUserId, submission } = parsed;
  if (!opts.guildIds.includes(guildId)) {
    return { status: 403, body: { error: "guild_not_allowed" } };
  }

  const guild = getGuild(db, guildId);
  const built = buildPendingSpec(submission, {
    timezone: guild?.timezone ?? null,
    defaultReqMessages: guild?.default_req_messages ?? null,
    defaultReqDays: guild?.default_req_days ?? null,
    defaultReqActiveDays: guild?.default_req_active_days ?? null,
    defaultCooldownDays: guild?.default_cooldown_days ?? null,
    defaultCooldownCount: guild?.default_cooldown_count ?? null,
  }, now);
  if (!built.ok) {
    return { status: 422, body: { error: "invalid_spec", message: built.error } };
  }

  // Mint a token that isn't already staged. Collisions are vanishingly rare, so
  // a few tries is plenty; give up rather than loop forever on a stuck rng.
  let token = "";
  for (let i = 0; i < 8; i++) {
    const candidate = gen();
    if (!pendingTokenExists(db, candidate)) {
      token = candidate;
      break;
    }
  }
  if (!token) {
    return { status: 503, body: { error: "token_unavailable" } };
  }

  const expiresAt = new Date(Date.parse(now) + HANDOFF_TTL_MS).toISOString();
  stagePendingRaffle(db, {
    token,
    guildId,
    stagedByUserId: moderatorUserId,
    spec: built.spec,
    createdAt: now,
    expiresAt,
  });
  // Audited but not mirrored to the audit channel — it becomes visible there
  // only when redeemed (its raffle_created/scheduled rows). The token is a
  // capability, so it is deliberately kept out of the audit payload.
  writeAudit(db, {
    guildId,
    raffleId: null,
    eventType: AUDIT_EVENTS.pendingRaffleStaged,
    actorId: moderatorUserId,
    payload: { name: built.spec.name },
    createdAt: now,
  });

  return { status: 200, body: { token, expiresAt } };
}

/** A running handoff listener. */
export interface HandoffServer {
  /** The address it bound to, for logging. */
  readonly url: string;
  stop(): Promise<void>;
}

export interface HandoffServerDeps {
  db: Database;
  handoff: HandoffConfig;
  /** The guild allowlist, so a stage request can't target an unknown guild. */
  guildIds: string[];
}

/** Read a request body up to the size cap, rejecting anything larger. */
function readBody(req: IncomingMessage, onDone: (body: string | null) => void): void {
  let size = 0;
  const chunks: Buffer[] = [];
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      onDone(null);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!aborted) onDone(Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", () => {
    if (!aborted) {
      aborted = true;
      onDone(null);
    }
  });
}

/** Start the handoff listener. Call `stop()` on shutdown. */
export function startHandoffServer(deps: HandoffServerDeps): HandoffServer {
  const { db, handoff, guildIds } = deps;
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== STAGE_PATH) {
      send(404, { error: "not_found" });
      return;
    }
    readBody(req, (rawBody) => {
      if (rawBody === null) {
        send(413, { error: "payload_too_large" });
        return;
      }
      try {
        const now = new Date().toISOString();
        const result = handleStage(
          db,
          { secret: handoff.secret, guildIds },
          req.headers.authorization,
          rawBody,
          now,
        );
        send(result.status, result.body);
      } catch (err) {
        console.error("Handoff stage error:", err);
        send(500, { error: "internal_error" });
      }
    });
  });
  server.listen(handoff.port, handoff.host);
  return {
    url: `http://${handoff.host}:${handoff.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
