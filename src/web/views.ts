/**
 * Server-rendered pages for the dashboard auth shell.
 *
 * These implement the visual design from the Claude Design project
 * "Discord Raffle Moderator Dashboard" (HomeOverview.dc.html): a dark,
 * trust-forward look with a per-guild brand mark, a server switcher, and the
 * home overview (live raffles, the eligible pool, recent-activity spark, and
 * config-health banners). The design's demo state-switcher is intentionally
 * omitted; its states map onto real routes and data instead — login and the
 * picker are their own routes, and the home's ready/empty states are driven by
 * whether the guild has live raffles.
 *
 * All dynamic values go through the escaping `html` tag. Presentation is derived
 * upstream in home.ts; this file is markup and light formatting only.
 */

import { html, raw, type RawHtml } from "./html.js";
import type { HomeView, PickerCard } from "./home.js";
import { resolveDisplayName } from "./naming.js";
import type { Session, SessionGuild } from "./session.js";
import type { SimulatorView } from "./simulator.js";

/** The one accent theme (the design's teal default), exposed as CSS variables. */
const THEME = {
  accent: "#3fb6a8",
  accent2: "#54cabb",
  accentSoft: "rgba(63,182,168,0.16)",
  ok: "#46b877",
  danger: "#e5687a",
  warn: "#d4a24c",
};

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Source+Serif+4:opsz,wght@8..60,500;8..60,600&family=JetBrains+Mono:wght@400;500;600&display=swap";

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0e1013}
a{color:#98a0ff;text-decoration:none}
summary{list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}
.dd-panel{animation:fadeup .14s ease}
.root{min-height:100vh;background:radial-gradient(1200px 620px at 78% -10%,#14171d 0%,#0e1013 62%);color:#e6e8ec;font-family:'Source Sans 3',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.serif{font-family:'Source Serif 4',serif}
.hovcard:hover{border-color:#343a44 !important;background:#191c22 !important}
.hovrow:hover{background:#1c2027 !important}
.hovnav:hover{color:#c3c8d1 !important}
.hovbtn:hover{background:var(--accent-2) !important;color:#0e1013 !important}
.hovout:hover{border-color:#343a44 !important;color:#c3c8d1 !important}
@keyframes fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes barrise{from{transform:scaleY(.3);opacity:.4}to{transform:none;opacity:1}}
@media (max-width:820px){.home-grid{grid-template-columns:1fr !important}}
@media (max-width:900px){.sim-grid{grid-template-columns:1fr !important}.sim-controls{position:static !important}}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:6px;background:#22262d;outline:none;margin:0;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--accent);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.45);border:3px solid #16181d}
input[type=range]::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:var(--accent);cursor:pointer;border:3px solid #16181d}
`;

/** Wrap page content in the full HTML document, fonts, and accent variables. */
function shell(title: string, body: RawHtml): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeTitle(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS_HREF}" rel="stylesheet">
<style>${BASE_CSS}</style>
</head>
<body>
<div class="root" style="--accent:${THEME.accent}; --accent-2:${THEME.accent2}; --accent-soft:${THEME.accentSoft}; --ok:${THEME.ok}; --danger:${THEME.danger}; --warn:${THEME.warn};">
${body.value}
</div>
</body>
</html>`;
}

function escapeTitle(title: string): string {
  return title.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

// ---------------------------------------------------------------------------
// Small presentation helpers
// ---------------------------------------------------------------------------

const GUILD_COLORS = ["#c98b52", "#7c86f2", "#54a6d4", "#46b877", "#d4a24c", "#c85e8a", "#4fb6a8"];

/** A stable avatar colour for a guild with no icon, derived from its id. */
function guildColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GUILD_COLORS[h % GUILD_COLORS.length]!;
}

/** First letter of a name, uppercased (avatar fallback). */
function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** Up to two initials from a display name (moderator avatar). */
function modInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const ini = parts.map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return ini || "?";
}

/** A guild avatar: the real Discord icon when present, else a coloured initial. */
function guildAvatar(guild: SessionGuild, size: number, radius: number, font: number): RawHtml {
  if (guild.icon) {
    const src = `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`;
    return html`<img src="${src}" alt="" width="${size}" height="${size}" style="flex:none; border-radius:${radius}px; object-fit:cover;" />`;
  }
  return html`<span style="flex:none; width:${size}px; height:${size}px; border-radius:${radius}px; background:${guildColor(
    guild.id,
  )}; display:flex; align-items:center; justify-content:center; font-family:'Source Serif 4',serif; font-weight:600; font-size:${font}px; color:#0e1013;">${initial(
    guild.name,
  )}</span>`;
}

/** The moderator's initials avatar. */
function modAvatar(name: string): RawHtml {
  return html`<div style="flex:none; width:30px; height:30px; border-radius:50%; background:#2a2f37; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#c3c8d1;">${modInitials(
    name,
  )}</div>`;
}

/** The name + subtitle + avatar block on the right of the chrome. */
function modBlock(name: string, subtitle: string): RawHtml {
  return html`
    <div style="display:flex; align-items:center; gap:9px;">
      <div style="text-align:right; line-height:1.15;">
        <div style="font-size:12px; font-weight:600;">${name}</div>
        <div style="font-size:10.5px; color:#6b717c;">${subtitle}</div>
      </div>
      ${modAvatar(name)}
    </div>
  `;
}

/** The small ticket brand mark used in the chrome. */
function headerMark(): RawHtml {
  return html`<div style="position:relative; width:30px; height:30px; border-radius:9px; background:linear-gradient(155deg, var(--accent), var(--accent-2)); display:flex; align-items:center; justify-content:center; box-shadow:0 2px 10px var(--accent-soft);">
    <div style="position:relative; width:15px; height:10px; border-radius:2.5px; background:#0e1013;"><div style="position:absolute; top:2px; bottom:2px; left:50%; border-left:1.5px dashed rgba(255,255,255,.3);"></div></div>
  </div>`;
}

/** Compact UTC date label, e.g. "Jul 12, 18:00". */
function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms)) + " UTC"
  );
}

/** Map the raw draw mode to a friendly label and icon. */
function drawMode(mode: string): { label: string; icon: string } {
  if (mode === "manual") return { label: "Manual", icon: "✋" };
  if (mode === "auto") return { label: "Auto at close", icon: "◷" };
  return { label: mode, icon: "◷" };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** The unauthenticated front door. Names no bot; one action. */
export function loginPage(): string {
  const body = html`
    <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; position:relative; overflow:hidden;">
      <div style="position:absolute; top:0; left:0; right:0; height:5px; background:repeating-linear-gradient(90deg, #1a1d23 0 9px, transparent 9px 18px); opacity:.7;"></div>
      <div style="width:100%; max-width:406px; display:flex; flex-direction:column; align-items:center; text-align:center; animation:fadeup .5s ease;">
        <div style="position:relative; width:64px; height:64px; border-radius:18px; background:linear-gradient(155deg, var(--accent), var(--accent-2)); display:flex; align-items:center; justify-content:center; box-shadow:0 14px 38px var(--accent-soft); margin-bottom:26px;">
          <div style="position:relative; width:32px; height:21px; border-radius:5px; background:#0e1013;">
            <div style="position:absolute; top:50%; left:-4px; width:8px; height:8px; border-radius:50%; background:var(--accent); transform:translateY(-50%);"></div>
            <div style="position:absolute; top:50%; right:-4px; width:8px; height:8px; border-radius:50%; background:var(--accent-2); transform:translateY(-50%);"></div>
            <div style="position:absolute; top:3px; bottom:3px; left:50%; border-left:2px dashed rgba(255,255,255,.28);"></div>
          </div>
        </div>
        <h1 class="serif" style="font-weight:600; font-size:30px; letter-spacing:-.02em; margin:0 0 30px;">Moderator Dashboard</h1>
        <a href="/login" class="hovbtn" style="display:flex; align-items:center; justify-content:center; gap:11px; width:100%; background:#5865f2; color:#fff; border:none; border-radius:12px; padding:14px 18px; font-size:15px; font-weight:600; box-shadow:0 8px 24px rgba(88,101,242,.34);">
          <span style="width:22px; height:22px; border-radius:6px; background:rgba(255,255,255,.16); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700;">◆</span>
          Sign in with Discord
        </a>
        <p style="margin:18px 0 0; font-size:13px; color:#8b93a0; line-height:1.55; max-width:34ch; display:flex; align-items:center; gap:7px;">
          <span style="flex:none; color:#6b717c; font-size:12px;">🔒</span>Moderators only — you'll only see servers you help run.
        </p>
      </div>
    </div>
  `;
  return shell("Sign in — Moderator Dashboard", body);
}

// ---------------------------------------------------------------------------
// Guild picker
// ---------------------------------------------------------------------------

/** A minimal guild-less header (login-adjacent screens). */
function guildlessHeader(session: Session): RawHtml {
  return html`
    <header style="display:flex; align-items:center; justify-content:space-between; height:58px; padding:0 24px; border-bottom:1px solid #1e2127; background:rgba(14,16,19,.72); position:sticky; top:0; z-index:20;">
      <div style="display:flex; align-items:center; gap:10px;">
        ${headerMark()}
        <span style="font-weight:700; font-size:15px; letter-spacing:-.01em;">Moderator Dashboard</span>
      </div>
      <div style="display:flex; align-items:center; gap:14px;">
        ${modBlock(session.username, "Signed in with Discord")}
        <a href="/logout" class="hovout" style="background:none; border:1px solid #262a31; color:#8b93a0; border-radius:8px; padding:6px 11px; font-size:12px; font-weight:600;">Sign out</a>
      </div>
    </header>
  `;
}

/** The guild picker, shown when a moderator manages more than one guild. */
export function pickerPage(session: Session, cards: PickerCard[]): string {
  const body = html`
    ${guildlessHeader(session)}
    <div style="max-width:620px; margin:0 auto; padding:52px 22px 80px; animation:fadeup .4s ease;">
      <h1 class="serif" style="font-weight:600; font-size:26px; letter-spacing:-.015em; margin:0 0 6px;">Choose a server</h1>
      <p style="margin:0 0 26px; font-size:14px; color:#8b93a0;">
        You moderate ${session.guilds.length} servers. Pick one to open its dashboard.
      </p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${session.guilds.map((g, i) => {
          const card = cards.find((c) => c.id === g.id);
          return html`
            <a href="/app/select?guild=${g.id}" class="hovcard" style="display:flex; align-items:center; gap:15px; width:100%; text-align:left; background:#16181d; border:1px solid #23272e; border-radius:14px; padding:15px 17px; color:inherit;">
              ${guildAvatar(g, 44, 13, 18)}
              <span style="flex:1; min-width:0;">
                <span style="display:block; font-size:15px; font-weight:600; color:#e6e8ec; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${g.name}</span>
                <span style="display:block; font-size:12.5px; color:#8b93a0; margin-top:2px;">${card?.statLabel ?? ""}</span>
              </span>
              <span style="flex:none; color:#585e68; font-size:18px;">→</span>
            </a>
          `;
        })}
      </div>
      <p style="margin:24px 0 0; font-size:12px; color:#585e68; display:flex; align-items:center; gap:7px;">
        <span style="color:#6b717c;">🔒</span>Only servers where you have Manage Server appear here.
      </p>
    </div>
  `;
  return shell("Choose a server — Moderator Dashboard", body);
}

// ---------------------------------------------------------------------------
// Home overview
// ---------------------------------------------------------------------------

/** The server-switcher dropdown in the home chrome (a no-JS <details>). */
function switcher(guild: SessionGuild, cards: PickerCard[]): RawHtml {
  return html`
    <details style="position:relative;">
      <summary style="display:flex; align-items:center; gap:8px; background:#16181d; border:1px solid #262a31; border-radius:9px; padding:6px 10px 6px 8px; color:#c3c8d1;">
        ${guildAvatar(guild, 18, 5, 10)}
        <span style="font-size:13px; font-weight:600; white-space:nowrap;">${guild.name}</span>
        <span style="color:#6b717c; font-size:11px;">▾</span>
      </summary>
      <div class="dd-panel" style="position:absolute; top:calc(100% + 8px); left:0; width:288px; background:#16181d; border:1px solid #2a2f37; border-radius:13px; padding:6px; box-shadow:0 20px 50px rgba(0,0,0,.55); z-index:40;">
        <div style="font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#585e68; padding:7px 9px 6px;">Your servers</div>
        ${cards.map((c) => {
          const isCurrent = c.id === guild.id;
          return html`
            <a href="/app/select?guild=${c.id}" class="hovrow" style="display:flex; align-items:center; gap:11px; width:100%; text-align:left; background:${isCurrent
              ? "#1c2027"
              : "transparent"}; border:none; border-radius:9px; padding:9px; color:inherit;">
              ${guildAvatar({ id: c.id, name: c.name, icon: c.icon }, 26, 8, 11)}
              <span style="flex:1; min-width:0;">
                <span style="display:block; font-size:13px; font-weight:600; color:#e6e8ec; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${c.name}</span>
                <span style="display:block; font-size:11px; color:#6b717c;">${c.statLabel}</span>
              </span>
              ${isCurrent
                ? html`<span style="flex:none; color:var(--accent); font-size:13px; font-weight:700;">✓</span>`
                : ""}
            </a>
          `;
        })}
        <div style="height:1px; background:#23272e; margin:6px 4px;"></div>
        <a href="/logout" class="hovrow" style="display:block; padding:9px; border-radius:9px; font-size:13px; font-weight:600; color:#c3c8d1;">Sign out</a>
      </div>
    </details>
  `;
}

/** One primary-nav item: an active tab (highlighted span) or a link. */
function navItem(label: string, href: string, active: boolean): RawHtml {
  if (active) {
    return html`<span style="font-size:13px; font-weight:600; color:#e6e8ec; padding:7px 11px; border-radius:8px; background:#191c22;">${label}</span>`;
  }
  return html`<a href="${href}" class="hovnav" style="font-size:13px; color:#8b93a0; padding:7px 11px; border-radius:8px;">${label}</a>`;
}

/** The home chrome: brand, switcher, nav, and the moderator block. */
function homeHeader(
  session: Session,
  guild: SessionGuild,
  brand: string,
  cards: PickerCard[],
  active: "overview" | "simulator",
): RawHtml {
  return html`
    <header style="display:flex; align-items:center; justify-content:space-between; height:58px; padding:0 24px; border-bottom:1px solid #1e2127; background:rgba(14,16,19,.72); position:sticky; top:0; z-index:20;">
      <div style="display:flex; align-items:center; gap:16px;">
        <div style="display:flex; align-items:center; gap:10px;">
          ${headerMark()}
          <div style="display:flex; flex-direction:column; line-height:1.05;">
            <span style="font-weight:700; font-size:15px; letter-spacing:-.01em;">${brand}</span>
            <span style="font-size:11px; color:#6b717c;">Moderator Dashboard</span>
          </div>
        </div>
        <div style="width:1px; height:24px; background:#242830;"></div>
        ${switcher(guild, cards)}
      </div>
      <nav style="display:flex; align-items:center; gap:6px;">
        ${navItem("Overview", "/app", active === "overview")}
        <a href="#" class="hovnav" style="font-size:13px; color:#8b93a0; padding:7px 11px; border-radius:8px;">Raffles</a>
        ${navItem("Simulator", "/app/simulator", active === "simulator")}
        <a href="#" class="hovnav" style="font-size:13px; color:#8b93a0; padding:7px 11px; border-radius:8px; display:flex; align-items:center; gap:6px;"><span style="width:6px; height:6px; border-radius:50%; background:var(--ok);"></span>Verify</a>
        <div style="width:1px; height:24px; background:#242830; margin:0 6px;"></div>
        ${modBlock(session.username, "Moderator")}
      </nav>
    </header>
  `;
}

/** The config-health banners (one per warning), each dismissible for this view. */
function banners(view: HomeView): RawHtml {
  if (view.warnings.length === 0) return html``;
  return html`
    <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px;">
      ${view.warnings.map(
        (w) => html`
          <div data-banner style="display:flex; align-items:center; gap:13px; background:rgba(212,162,76,.07); border:1px solid rgba(212,162,76,.26); border-radius:13px; padding:13px 15px; animation:fadeup .3s ease;">
            <span style="flex:none; width:30px; height:30px; border-radius:9px; background:rgba(212,162,76,.14); color:var(--warn); display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:700;">!</span>
            <div style="flex:1; min-width:0;">
              <div style="font-size:13.5px; font-weight:600; color:#e8dcc4;">${w.title}</div>
              <div style="font-size:12.5px; color:#a99a7d; margin-top:1px;">${w.detail}</div>
            </div>
            <button type="button" onclick="this.closest('[data-banner]').remove()" style="flex:none; width:26px; height:26px; border-radius:7px; background:none; border:none; color:#8a7e64; font-size:15px; cursor:pointer; display:flex; align-items:center; justify-content:center;">✕</button>
          </div>
        `,
      )}
    </div>
  `;
}

/** A single live/scheduled raffle card. */
function raffleCard(r: HomeView["liveRaffles"][number]): RawHtml {
  const status = r.isLive
    ? { label: "Live", color: "var(--ok)", dot: "var(--ok)", halo: "rgba(70,184,119,.16)", progress: "var(--accent)" }
    : { label: "Scheduled", color: "#8b93a0", dot: "#6b717c", halo: "rgba(107,113,124,.14)", progress: "#2f343d" };
  const mode = drawMode(r.drawMode);
  const entries = r.isLive || r.entrants > 0 ? String(r.entrants) : "—";
  return html`
    <a href="#" class="hovcard" style="display:block; background:#16181d; border:1px solid #23272e; border-radius:14px; padding:16px 18px; color:inherit;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:9px;">
        <span style="display:inline-flex; align-items:center; gap:7px; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:${status.color};"><span style="width:7px; height:7px; border-radius:50%; background:${status.dot}; box-shadow:0 0 0 3px ${status.halo};"></span>${status.label}</span>
        <span style="display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; color:#a7adb7; background:#101216; border:1px solid #262a31; border-radius:20px; padding:4px 10px;"><span style="color:#6b717c; font-size:11px;">${mode.icon}</span>${mode.label}</span>
      </div>
      <div class="serif" style="font-weight:600; font-size:17px; color:#e6e8ec; letter-spacing:-.01em; margin-bottom:11px;">${r.name}</div>
      <div style="display:flex; align-items:center; gap:18px;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:12.5px; color:#8b93a0; margin-bottom:6px;"><span style="color:#c3c8d1;">${dateLabel(
            r.startsAt,
          )}</span> <span style="color:#585e68;">→</span> <span style="color:#c3c8d1;">${dateLabel(r.endsAt)}</span></div>
          <div style="height:5px; border-radius:5px; background:#23272e; overflow:hidden;"><div style="height:100%; width:${r.progressPct}%; background:${status.progress}; border-radius:5px;"></div></div>
          <div style="font-size:11px; color:#585e68; margin-top:5px;">${r.timeNote}</div>
        </div>
        <div style="flex:none; text-align:right;">
          <div class="serif" style="font-weight:600; font-size:22px; color:#e6e8ec; line-height:1;">${entries}</div>
          <div style="font-size:11px; color:#6b717c; margin-top:3px;">entries</div>
        </div>
      </div>
    </a>
  `;
}

/** The empty state for the "what's live now" column. */
function rafflesEmpty(guildName: string): RawHtml {
  return html`
    <div style="background:#16181d; border:1px dashed #2f3540; border-radius:16px; padding:46px 32px; text-align:center;">
      <div style="width:48px; height:48px; border-radius:14px; background:#101216; border:1px solid #23272e; display:flex; align-items:center; justify-content:center; margin:0 auto 15px;">
        <div style="position:relative; width:22px; height:15px; border-radius:4px; border:1.5px solid #585e68;"><div style="position:absolute; top:2px; bottom:2px; left:50%; border-left:1.5px dashed #4c525c;"></div></div>
      </div>
      <div class="serif" style="font-weight:600; font-size:18px; margin-bottom:6px;">No raffles running</div>
      <p style="margin:0 auto 18px; font-size:13.5px; color:#8b93a0; max-width:36ch; line-height:1.55;">Nothing is live or scheduled in ${guildName} right now. Design one to get started.</p>
      <a href="#" class="hovbtn" style="display:inline-flex; align-items:center; gap:8px; background:var(--accent); color:#0e1013; border-radius:10px; padding:10px 18px; font-size:13.5px; font-weight:700;"><span style="font-size:15px; line-height:1;">＋</span>Design a raffle</a>
    </div>
  `;
}

/** The eligible-pool panel. */
function poolPanel(view: HomeView): RawHtml {
  const { hasDefaults, eligible, considered, reqSummary } = view.pool;
  if (!hasDefaults) {
    return html`
      <section style="background:linear-gradient(160deg,#181b21,#14171d); border:1px solid #23272e; border-radius:16px; padding:20px 22px;">
        <div style="font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#8b93a0; margin-bottom:14px;">The pool right now</div>
        <p style="margin:0; font-size:13.5px; color:#a7adb7; line-height:1.55;">Set a default activity requirement in Discord (<span style="color:#c3c8d1;">req-messages</span> and <span style="color:#c3c8d1;">req-days</span>) to see who's eligible.</p>
      </section>
    `;
  }
  const pct = considered > 0 ? Math.round((eligible / considered) * 100) : 0;
  return html`
    <section style="background:linear-gradient(160deg,#181b21,#14171d); border:1px solid #23272e; border-radius:16px; padding:20px 22px;">
      <div style="font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#8b93a0; margin-bottom:14px;">The pool right now</div>
      <div style="display:flex; align-items:baseline; gap:9px; margin-bottom:4px;">
        <span class="serif" style="font-weight:600; font-size:44px; letter-spacing:-.02em; color:var(--accent); line-height:.9;">~${eligible}</span>
        <span style="font-size:15px; color:#8b93a0;">of ${considered} active members</span>
      </div>
      <div style="font-size:13px; color:#a7adb7; margin-bottom:14px;">eligible today · ${pct}% of the recently active</div>
      <div style="height:6px; border-radius:6px; background:#23272e; overflow:hidden; margin-bottom:15px;"><div style="height:100%; width:${pct}%; background:var(--accent); border-radius:6px;"></div></div>
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding-top:14px; border-top:1px solid #23272e;">
        <div style="font-size:11.5px; color:#6b717c; line-height:1.45;">Under the server default bar<br /><span style="color:#8b93a0;">${reqSummary}</span></div>
        <a href="/app/simulator" style="flex:none; font-size:12.5px; font-weight:600; white-space:nowrap;">tune this →</a>
      </div>
    </section>
  `;
}

/** The recent-activity spark panel. */
function activityPanel(view: HomeView): RawHtml {
  const { spark, weekMessages, trendPct, trendUp } = view.activity;
  const max = spark.reduce((m, p) => Math.max(m, p.count), 0);
  const bars = spark.map((p, i) => {
    const h = max === 0 ? 2 : Math.max(2, Math.round((p.count / max) * 58));
    const color = i >= spark.length - 7 ? "var(--accent)" : "#2f343d";
    return html`<div title="${p.day}: ${p.count}" style="flex:1; height:${h}px; min-height:2px; background:${color}; border-radius:2px; transform-origin:bottom; animation:barrise .5s ease;"></div>`;
  });
  const arrow = trendUp ? "▲" : "▼";
  const trendColor = trendUp ? "var(--accent)" : "var(--danger)";
  const chipBg = trendUp ? "var(--accent-soft)" : "rgba(229,104,122,.13)";
  const word =
    weekMessages === 0 ? "it's quiet here" : trendUp ? "the server is warming up" : "the server is cooling off";
  return html`
    <section style="background:#16181d; border:1px solid #23272e; border-radius:16px; padding:20px 22px;">
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:3px;">
        <div style="font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#8b93a0;">Recent activity</div>
        <span style="display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:600; color:${trendColor};">${arrow} ${Math.abs(
          trendPct,
        )}%</span>
      </div>
      <div style="font-size:12.5px; color:#6b717c; margin-bottom:16px;">Guild messages · last 4 weeks</div>
      <div style="display:flex; align-items:flex-end; gap:2px; height:58px; margin-bottom:9px;">${bars}</div>
      <div style="display:flex; justify-content:space-between; font-size:10px; color:#4c525c; font-family:'JetBrains Mono',monospace; margin-bottom:14px;"><span>4 wks ago</span><span>this week</span></div>
      <div style="display:flex; align-items:center; gap:9px; padding-top:14px; border-top:1px solid #23272e;">
        <span style="flex:none; width:28px; height:28px; border-radius:9px; background:${chipBg}; color:${trendColor}; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700;">${arrow}</span>
        <div style="font-size:12.5px; color:#a7adb7; line-height:1.4;"><span style="color:#e6e8ec; font-weight:600;">${weekMessages.toLocaleString(
          "en-US",
        )}</span> messages this week — ${word}.</div>
      </div>
    </section>
  `;
}

/** The home overview a moderator lands on inside a guild. */
export function homePage(session: Session, guild: SessionGuild, view: HomeView, cards: PickerCard[]): string {
  const brand = resolveDisplayName({});
  const hasRaffles = view.liveRaffles.length > 0;
  const liveCountLabel = `${view.liveCount} live · ${view.scheduledCount} scheduled`;

  const body = html`
    ${homeHeader(session, guild, brand, cards, "overview")}
    <div style="max-width:1120px; margin:0 auto; padding:26px 24px 84px;">
      ${banners(view)}

      <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px;">
        <div>
          <div style="font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:#585e68; margin-bottom:7px;">Overview</div>
          <h1 class="serif" style="font-weight:600; font-size:29px; letter-spacing:-.02em; margin:0 0 5px;">${guild.name}</h1>
          <p style="margin:0; font-size:14px; color:#8b93a0;">What ${brand} is running here right now.</p>
        </div>
        <a href="#" class="hovbtn" style="flex:none; display:flex; align-items:center; gap:8px; background:var(--accent); color:#0e1013; border-radius:11px; padding:11px 18px; font-size:14px; font-weight:700; box-shadow:0 6px 20px var(--accent-soft);"><span style="font-size:16px; line-height:1;">＋</span>Design a raffle</a>
      </div>

      <div class="home-grid" style="display:grid; grid-template-columns:1.62fr 1fr; gap:18px; align-items:start;">
        <div style="display:flex; flex-direction:column; gap:13px;">
          <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px;">
            <div style="display:flex; align-items:baseline; gap:10px;">
              <h2 class="serif" style="font-weight:600; font-size:18px; margin:0; letter-spacing:-.01em;">What's live now</h2>
              ${hasRaffles ? html`<span style="font-size:12px; color:#6b717c;">${liveCountLabel}</span>` : ""}
            </div>
            ${hasRaffles ? html`<a href="#" style="font-size:12.5px; font-weight:600;">All raffles →</a>` : ""}
          </div>
          ${hasRaffles
            ? html`<div style="display:flex; flex-direction:column; gap:12px;">${view.liveRaffles.map(raffleCard)}</div>`
            : rafflesEmpty(guild.name)}
        </div>

        <div style="display:flex; flex-direction:column; gap:18px;">
          ${poolPanel(view)}
          ${activityPanel(view)}
        </div>
      </div>
    </div>
  `;
  return shell(`${guild.name} — Moderator Dashboard`, body);
}

// ---------------------------------------------------------------------------
// Eligibility simulator
// ---------------------------------------------------------------------------

/** The query string carrying the current dial values (without the filter). */
function settingsQuery(view: SimulatorView): string {
  const p = new URLSearchParams();
  for (const s of view.sliders) p.set(s.param, String(s.value));
  return p.toString();
}

/** The left-hand controls: a GET form of sliders that re-runs the simulation. */
function simControls(view: SimulatorView): RawHtml {
  return html`
    <aside class="sim-controls" style="flex:0 0 340px; max-width:340px; position:sticky; top:82px;">
      <form id="sim-form" method="get" action="/app/simulator">
        <input type="hidden" name="filter" value="${view.filter}" />
        <section style="background:#16181d; border:1px solid #23272e; border-radius:14px; padding:18px 20px 20px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <span style="font-weight:700; font-size:11.5px; letter-spacing:.09em; text-transform:uppercase; color:#8b93a0;">Entry requirements</span>
            <a href="/app/simulator" class="hovnav" style="font-size:11.5px; font-weight:600; color:#8b93a0;">Reset</a>
          </div>
          <p style="margin:0 0 16px; font-size:11.5px; color:#585e68;">Adjust the bar, then re-run to see who clears it.</p>
          <div style="display:flex; flex-direction:column; gap:20px;">
            ${view.sliders.map(
              (s) => html`
                <div>
                  <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:9px;">
                    <label for="sl-${s.param}" style="font-weight:600; font-size:13.5px; color:#dfe2e7; display:flex; align-items:center; gap:7px;">${s.label}${s.symbol
                      ? html`<span style="font-family:'JetBrains Mono',monospace; font-size:10.5px; font-weight:600; color:#585e68; background:#101216; border:1px solid #23272e; border-radius:5px; padding:1px 5px;">${s.symbol}</span>`
                      : ""}</label>
                    <span style="display:flex; align-items:baseline; gap:4px;"><span id="${s.param}-val" class="serif" style="font-weight:600; font-size:20px; color:var(--accent); line-height:1;">${s.value}</span><span style="font-size:11px; color:#6b717c;">${s.unit}</span></span>
                  </div>
                  <input id="sl-${s.param}" type="range" name="${s.param}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.value}" data-valout="${s.param}-val" style="background:linear-gradient(90deg, var(--accent) ${s.pct}, #22262d ${s.pct});" />
                  <div style="display:flex; justify-content:space-between; font-size:10px; color:#4c525c; font-family:'JetBrains Mono',monospace; margin-top:6px;"><span>${s.minLabel}</span><span>${s.hint}</span><span>${s.maxLabel}</span></div>
                </div>
              `,
            )}
          </div>
          <button type="submit" class="hovbtn" style="margin-top:20px; width:100%; background:var(--accent); color:#0e1013; border:none; border-radius:10px; padding:11px 16px; font-size:13.5px; font-weight:700; cursor:pointer;">Run simulation</button>
        </section>
      </form>
    </aside>
  `;
}

/** The headline count with the "clears it" donut. */
function simHeadline(view: SimulatorView): RawHtml {
  const ringLen = 2 * Math.PI * 50;
  const dash = view.considered > 0 ? (ringLen * view.eligible) / view.considered : 0;
  const shortfall = view.considered - view.eligible;
  const line =
    view.considered === 0
      ? "No members with counted activity in this window yet."
      : view.eligible === view.considered
        ? "Every active member clears this bar."
        : `${view.pctClear}% of active members clear this bar. ${shortfall} fall short.`;
  return html`
    <section style="background:linear-gradient(160deg,#181b21,#14171d); border:1px solid #23272e; border-radius:16px; padding:22px 24px; display:flex; align-items:center; justify-content:space-between; gap:20px;">
      <div>
        <div style="font-size:12px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#8b93a0; margin-bottom:8px;">Eligible right now</div>
        <div class="serif" style="font-weight:600; font-size:34px; letter-spacing:-.02em; line-height:1;"><span style="color:var(--accent);">~${view.eligible}</span> <span style="color:#6b717c; font-weight:500; font-size:24px;">of ${view.considered} active members</span></div>
        <div style="font-size:13px; color:#8b93a0; margin-top:8px;">${line}</div>
      </div>
      <div style="flex:none; width:118px; height:118px; position:relative; display:flex; align-items:center; justify-content:center;">
        <svg width="118" height="118" viewBox="0 0 118 118" style="transform:rotate(-90deg);">
          <circle cx="59" cy="59" r="50" fill="none" stroke="#23272e" stroke-width="10"></circle>
          <circle cx="59" cy="59" r="50" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${ringLen.toFixed(1)}"></circle>
        </svg>
        <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;"><span class="serif" style="font-weight:600; font-size:24px; color:#e6e8ec;">${view.pctClear}%</span><span style="font-size:10px; color:#6b717c;">clear it</span></div>
      </div>
    </section>
  `;
}

/** The message-count histogram with the threshold line drawn on it. */
function simHistogram(view: SimulatorView): RawHtml {
  const h = view.histogram;
  const cap = view.caption;
  const capColor =
    cap.tone === "raise" ? "var(--danger)" : cap.tone === "lower" ? "var(--accent)" : "#8b93a0";
  const capBg =
    cap.tone === "raise"
      ? "rgba(229,104,122,.14)"
      : cap.tone === "lower"
        ? "var(--accent-soft)"
        : "#1c2027";
  const capIcon = cap.tone === "raise" ? "↑" : cap.tone === "lower" ? "↓" : "≈";
  return html`
    <section style="background:#16181d; border:1px solid #23272e; border-radius:16px; padding:22px 24px 20px;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:20px;">
        <div>
          <div class="serif" style="font-weight:600; font-size:18px; letter-spacing:-.01em;">Where members fall</div>
          <div style="font-size:12.5px; color:#8b93a0; margin-top:3px;">Messages sent per member across the last ${view.settings.reqDays} days</div>
        </div>
        <div style="display:flex; gap:16px; flex:none;">
          <div style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:#a7adb7;"><span style="width:11px; height:11px; border-radius:3px; background:var(--accent);"></span>Clears the bar</div>
          <div style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:#a7adb7;"><span style="width:11px; height:11px; border-radius:3px; background:#363b44;"></span>Below X</div>
        </div>
      </div>
      <div style="position:relative; height:216px; padding-left:30px;">
        <div style="position:absolute; left:0; right:0; top:0; bottom:26px; display:flex; flex-direction:column; justify-content:space-between;">
          ${h.yTicks.map(
            (y) => html`<div style="position:relative; height:1px; background:#1d2027;"><span style="position:absolute; left:-30px; top:-6px; font-size:9.5px; color:#4c525c; font-family:'JetBrains Mono',monospace; width:26px; text-align:right;">${y}</span></div>`,
          )}
        </div>
        <div style="position:absolute; left:30px; right:0; top:0; bottom:26px; display:flex; align-items:flex-end; gap:4px;">
          ${h.bins.map(
            (b) => html`<div title="${b.count}" style="flex:1; height:${b.heightPct}; min-height:2px; background:${b.clears
              ? "var(--accent)"
              : "#363b44"}; border-radius:3px 3px 0 0; transform-origin:bottom; animation:barrise .4s ease;"></div>`,
          )}
        </div>
        <div style="position:absolute; top:-6px; bottom:26px; left:calc(30px + (100% - 30px) * ${(parseFloat(view.histogram.thresholdPct) / 100).toFixed(4)}); width:2px; background:var(--accent); box-shadow:0 0 0 2px rgba(22,24,29,.9); z-index:3;"></div>
        <div style="position:absolute; top:-14px; left:calc(30px + (100% - 30px) * ${(parseFloat(view.histogram.thresholdPct) / 100).toFixed(4)}); transform:translateX(-50%); z-index:4; background:var(--accent); color:#0e1013; font-size:10px; font-weight:700; padding:2px 7px; border-radius:5px; white-space:nowrap; font-family:'JetBrains Mono',monospace;">X = ${view.settings.reqMessages}</div>
        <div style="position:absolute; left:30px; right:0; bottom:0; display:flex; justify-content:space-between; font-size:9.5px; color:#4c525c; font-family:'JetBrains Mono',monospace;">
          ${h.xTicks.map((x) => html`<span>${x}</span>`)}
        </div>
      </div>
      <div style="margin-top:24px; display:flex; align-items:center; gap:12px; background:#101216; border:1px solid #23272e; border-radius:11px; padding:13px 16px;">
        <span style="flex:none; width:26px; height:26px; border-radius:8px; background:${capBg}; display:flex; align-items:center; justify-content:center; font-size:14px; color:${capColor};">${capIcon}</span>
        <div style="font-size:13.5px; color:#dfe2e7; line-height:1.45;">${cap.text}</div>
      </div>
    </section>
  `;
}

/** The member table (keyed by id — the web process has no usernames). */
function simTable(view: SimulatorView): RawHtml {
  const q = settingsQuery(view);
  return html`
    <section style="background:#16181d; border:1px solid #23272e; border-radius:16px; overflow:hidden;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 20px 14px; flex-wrap:wrap;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="serif" style="font-weight:600; font-size:16px;">Members</span>
          <span style="font-size:11px; color:#6b717c;">${view.shownLabel}</span>
        </div>
        <div style="display:flex; background:#101216; border:1px solid #2a2f37; border-radius:9px; padding:3px;">
          ${view.filterTabs.map(
            (f) => html`<a href="/app/simulator?${raw(q)}&filter=${f.filter}" style="border-radius:6px; padding:6px 12px; font-size:12px; font-weight:600; white-space:nowrap; background:${f.active
              ? "var(--accent)"
              : "transparent"}; color:${f.active ? "#0e1013" : "#c3c8d1"};">${f.label}</a>`,
          )}
        </div>
      </div>
      <div style="display:grid; grid-template-columns:2.4fr .9fr .9fr 1fr 1.8fr; align-items:center; padding:0 20px; height:34px; border-top:1px solid #23272e; border-bottom:1px solid #23272e; background:#131519; font-size:10.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:#6b717c;">
        <span>Member</span><span style="text-align:center;">Msgs</span><span style="text-align:center;">Active</span><span style="text-align:center;">Status</span><span>Reason</span>
      </div>
      <div style="max-height:440px; overflow-y:auto;">
        ${view.rows.length === 0
          ? html`<div style="padding:44px 20px; text-align:center; font-size:13px; color:#8b93a0;">No members match this filter.</div>`
          : view.rows.map(
              (r) => html`
                <div class="hovrow" style="display:grid; grid-template-columns:2.4fr .9fr .9fr 1fr 1.8fr; align-items:center; padding:10px 20px; border-bottom:1px solid #1b1e24;">
                  <div style="display:flex; align-items:center; gap:11px; min-width:0;">
                    <span style="flex:none; width:30px; height:30px; border-radius:50%; background:${r.avatarColor};"></span>
                    <span style="min-width:0;"><span style="display:block; font-size:12.5px; font-weight:600; color:#dfe2e7; font-family:'JetBrains Mono',monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${r.userId}</span><span style="display:block; font-size:11px; color:#6b717c;">member</span></span>
                  </div>
                  <div style="font-size:13px; color:#c3c8d1; font-family:'JetBrains Mono',monospace; text-align:center;">${r.messages}</div>
                  <div style="font-size:13px; color:#c3c8d1; font-family:'JetBrains Mono',monospace; text-align:center;">${r.activeDays}</div>
                  <div style="display:flex; justify-content:center;">
                    <span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:3px 9px 3px 7px; border-radius:20px; background:${r.eligible
                      ? "rgba(70,184,119,.13)"
                      : "rgba(229,104,122,.12)"}; color:${r.eligible ? "#5ccc8a" : "#e58497"};"><span style="width:6px; height:6px; border-radius:50%; background:${r.eligible
                      ? "var(--ok)"
                      : "var(--danger)"};"></span>${r.statusLabel}</span>
                  </div>
                  <div style="font-size:12px; color:${r.eligible ? "#4c525c" : "#a7adb7"}; padding-left:6px;">${r.reason}</div>
                </div>
              `,
            )}
      </div>
    </section>
  `;
}

/** The apply-in-Discord card: the generated command with a copy button. */
function simApply(view: SimulatorView, guild: SessionGuild): RawHtml {
  return html`
    <section style="background:#14171d; border:1px solid #262a31; border-radius:16px; padding:20px 22px; box-shadow:0 10px 30px rgba(0,0,0,.3);">
      <div style="display:flex; align-items:center; gap:9px; margin-bottom:5px;">
        <span style="width:24px; height:24px; border-radius:7px; background:var(--accent-soft); display:flex; align-items:center; justify-content:center; color:var(--accent); font-size:13px;">↗</span>
        <h2 class="serif" style="font-weight:600; font-size:17px; margin:0; letter-spacing:-.01em;">Apply in Discord</h2>
      </div>
      <p style="margin:0 0 15px; font-size:13px; color:#8b93a0; line-height:1.5;">Happy with the bar? Run this command in <span style="color:#dfe2e7; font-weight:600;">${guild.name}</span> to save it as the server default — the dashboard changes nothing itself.</p>
      <div style="background:#0c0e11; border:1px solid #262a31; border-radius:11px; padding:14px 16px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:14px;">
          <code style="font-family:'JetBrains Mono',monospace; font-size:13px; line-height:1.6; color:#c3c8d1; overflow-x:auto; white-space:nowrap;">${view.command}</code>
          <button type="button" class="sim-copy" data-cmd="${view.command}" style="flex:none; display:flex; align-items:center; gap:6px; background:var(--accent); color:#0e1013; border:1px solid transparent; border-radius:9px; padding:8px 14px; font-size:12.5px; font-weight:700; cursor:pointer;">Copy</button>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:7px; margin-top:12px; font-size:11.5px; color:#6b717c;"><span style="color:var(--ok); font-size:12px;">✓</span>Read-only — nothing is written until you run this in your server.</div>
    </section>
  `;
}

/** Progressive enhancement: live value labels, auto-run on release, copy button. */
const SIM_SCRIPT = raw(`<script>
(function(){
  var f=document.getElementById('sim-form');
  if(f){
    f.querySelectorAll('input[type=range]').forEach(function(r){
      var out=document.getElementById(r.getAttribute('data-valout'));
      r.addEventListener('input',function(){
        if(out) out.textContent=r.value;
        var p=(r.max>r.min)?((r.value-r.min)/(r.max-r.min)*100):0;
        r.style.background='linear-gradient(90deg, var(--accent) '+p+'%, #22262d '+p+'%)';
      });
      r.addEventListener('change',function(){ f.submit(); });
    });
  }
  document.querySelectorAll('.sim-copy').forEach(function(b){
    b.addEventListener('click',function(){
      var t=b.getAttribute('data-cmd');
      var done=function(){ var o=b.textContent; b.textContent='Copied \\u2713'; setTimeout(function(){ b.textContent=o; },1800); };
      if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done,function(){}); }
    });
  });
})();
</script>`);

/** The eligibility simulator: tune the bar, see who clears it, carry it back. */
export function simulatorPage(
  session: Session,
  guild: SessionGuild,
  view: SimulatorView,
  cards: PickerCard[],
): string {
  const brand = resolveDisplayName({});
  const results = view.hasCandidates
    ? html`
        ${simHeadline(view)}
        ${simHistogram(view)}
        ${simTable(view)}
      `
    : html`
        ${simHeadline(view)}
        <div style="background:#16181d; border:1px dashed #2f3540; border-radius:16px; padding:56px 40px; text-align:center;">
          <div class="serif" style="font-weight:600; font-size:18px; margin-bottom:6px;">No activity to simulate yet</div>
          <p style="margin:0 auto; font-size:13.5px; color:#8b93a0; max-width:44ch; line-height:1.55;">No member has a counted message in the last ${view.settings.reqDays} days. Widen the window, or check back once the server has been active.</p>
        </div>
      `;

  const body = html`
    ${homeHeader(session, guild, brand, cards, "simulator")}
    <div style="max-width:1280px; margin:0 auto; padding:26px 24px 84px;">
      <div style="display:flex; align-items:baseline; gap:10px; color:#6b717c; font-size:12px; margin-bottom:8px;"><a href="/app" class="hovnav" style="color:#8b93a0;">${guild.name}</a><span>/</span><span>Eligibility simulator</span></div>
      <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px; flex-wrap:wrap;">
        <div>
          <h1 class="serif" style="font-weight:600; font-size:28px; letter-spacing:-.015em; margin:0 0 4px;">Eligibility Simulator</h1>
          <p style="margin:0; font-size:14px; color:#8b93a0; max-width:66ch;">Tune the server's default entry bar and see who clears it — before you commit to anything. This is a sandbox: it reads your members but <span style="color:#c3c8d1;">never changes a thing.</span></p>
        </div>
        <div style="display:flex; align-items:center; gap:7px; flex:none; font-size:11.5px; color:#6b717c; background:#16181d; border:1px solid #23272e; border-radius:20px; padding:6px 12px 6px 10px;"><span style="width:7px; height:7px; border-radius:50%; background:var(--ok);"></span>Read-only · nothing is written</div>
      </div>

      <div class="sim-grid" style="display:grid; grid-template-columns:340px 1fr; gap:26px; align-items:start;">
        ${simControls(view)}
        <main style="min-width:0; display:flex; flex-direction:column; gap:16px;">
          ${results}
          ${simApply(view, guild)}
        </main>
      </div>
    </div>
    ${SIM_SCRIPT}
  `;
  return shell("Eligibility Simulator — Moderator Dashboard", body);
}

// ---------------------------------------------------------------------------
// Utility pages
// ---------------------------------------------------------------------------

/** Shown when a signed-in visitor manages none of the allowlisted guilds. */
export function noAccessPage(): string {
  const body = html`
    <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;">
      <div style="width:100%; max-width:440px; text-align:center; animation:fadeup .4s ease;">
        <h1 class="serif" style="font-weight:600; font-size:26px; letter-spacing:-.015em; margin:0 0 10px;">No servers to show</h1>
        <p style="margin:0 0 26px; font-size:14px; color:#8b93a0; line-height:1.6;">
          You're signed in, but you don't manage any server this dashboard covers. Access needs the
          Manage Server permission on an allowlisted server.
        </p>
        <a href="/logout" class="hovout" style="display:inline-block; background:none; border:1px solid #262a31; color:#8b93a0; border-radius:10px; padding:10px 18px; font-size:13.5px; font-weight:600;">Sign out</a>
      </div>
    </div>
  `;
  return shell("No access — Moderator Dashboard", body);
}

/** A minimal error page for unexpected failures (e.g. a failed OAuth exchange). */
export function errorPage(message: string): string {
  const body = html`
    <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;">
      <div style="width:100%; max-width:440px; text-align:center; animation:fadeup .4s ease;">
        <h1 class="serif" style="font-weight:600; font-size:26px; letter-spacing:-.015em; margin:0 0 10px;">Something went wrong</h1>
        <p style="margin:0 0 26px; font-size:14px; color:#8b93a0; line-height:1.6;">${message}</p>
        <a href="/" class="hovout" style="display:inline-block; background:none; border:1px solid #262a31; color:#8b93a0; border-radius:10px; padding:10px 18px; font-size:13.5px; font-weight:600;">Back to start</a>
      </div>
    </div>
  `;
  return shell("Error — Moderator Dashboard", body);
}
