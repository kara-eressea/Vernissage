/**
 * Server-rendered pages for the dashboard auth shell.
 *
 * Deliberately plain, structural HTML: this is the plumbing (sequencing step 1
 * in docs/dashboard.md), so the markup is honest scaffolding a visual design can
 * later replace, not a finished look. Every page shares one dark-first layout so
 * the chrome (name, server switcher, nav) is defined once. All dynamic values go
 * through the escaping `html` tag.
 */

import { html, raw, type RawHtml } from "./html.js";
import type { HomeView } from "./home.js";
import { resolveDisplayName } from "./naming.js";
import type { Session, SessionGuild } from "./session.js";

/** Format a UTC ISO timestamp as a compact, readable UTC string for the web. */
function formatUtc(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms)) + " UTC";
}

/** A small letter-badge fallback when a guild has no icon. */
function guildBadge(guild: SessionGuild): RawHtml {
  if (guild.icon) {
    const src = `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`;
    return html`<img class="badge" src="${src}" alt="" width="28" height="28" />`;
  }
  const letter = (guild.name.trim()[0] ?? "?").toUpperCase();
  return html`<span class="badge badge-letter">${letter}</span>`;
}

const STYLES = raw(`
  :root {
    color-scheme: dark;
    --bg: #0f1115; --panel: #181b22; --panel-2: #1f232c; --border: #2a2f3a;
    --text: #e6e8ec; --muted: #9aa1ad; --accent: #5865f2; --good: #3ba55d;
    --warn: #d9822b; --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  a { color: inherit; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 20px 64px; }
  header.chrome {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  header.chrome .name { font-weight: 700; font-size: 18px; margin-right: auto; }
  header.chrome nav { display: flex; gap: 4px; flex-wrap: wrap; }
  header.chrome nav a {
    text-decoration: none; color: var(--muted); padding: 6px 10px;
    border-radius: 8px; font-size: 14px;
  }
  header.chrome nav a[aria-current="page"], header.chrome nav a:hover {
    color: var(--text); background: var(--panel-2);
  }
  .switcher { display: flex; align-items: center; gap: 8px; }
  .switcher select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 8px; font: inherit;
  }
  .badge { border-radius: 6px; vertical-align: middle; }
  .badge-letter {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; background: var(--accent); color: #fff;
    font-weight: 700; font-size: 14px;
  }
  h1 { font-size: 22px; margin: 24px 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); margin: 32px 0 12px; }
  .panel { background: var(--panel); border: 1px solid var(--border);
           border-radius: var(--radius); padding: 16px; }
  .grid { display: grid; gap: 12px; }
  .stat { font-size: 34px; font-weight: 700; }
  .stat .of { color: var(--muted); font-weight: 400; font-size: 18px; }
  .muted { color: var(--muted); }
  .card { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .card + .card { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px;
          background: var(--panel-2); color: var(--muted); }
  .warn { border-left: 3px solid var(--warn); padding: 10px 14px; background: var(--panel-2);
          border-radius: 6px; margin-bottom: 8px; }
  .btn {
    display: inline-block; text-decoration: none; background: var(--accent); color: #fff;
    padding: 10px 16px; border-radius: 8px; font-weight: 600; border: none; cursor: pointer;
  }
  .btn.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 64px; }
  .spark .bar { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; opacity: .85; }
  .login { max-width: 420px; margin: 12vh auto; text-align: center; }
  .login p { color: var(--muted); }
  .picker-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
  .picker-row + .picker-row { border-top: 1px solid var(--border); }
  footer { color: var(--muted); font-size: 13px; margin-top: 48px; }
`);

/** Options for the shared page frame. */
interface LayoutOptions {
  title: string;
  /** The signed-in session, when there is one (drives the account chrome). */
  session?: Session;
  /** The selected guild, when inside one (drives name + nav + switcher). */
  guild?: SessionGuild;
  /** Which nav item is current, if any. */
  current?: "home";
  body: RawHtml;
}

/** The one shared page frame. Guild-less pages omit the nav and switcher. */
function layout(opts: LayoutOptions): string {
  const displayName = resolveDisplayName(opts.guild ? {} : null);
  const inGuild = Boolean(opts.guild);
  const chrome = inGuild
    ? html`
        <header class="chrome">
          <span class="name">${displayName}</span>
          <nav>
            <a href="/app" ${opts.current === "home" ? raw('aria-current="page"') : ""}>Home</a>
          </nav>
          ${renderSwitcher(opts.session, opts.guild)}
          <a class="pill" href="/logout">Sign out</a>
        </header>
      `
    : html``;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeTitle(opts.title)}</title>
  <style>${STYLES.value}</style>
</head>
<body>
  ${chrome.value}
  <div class="wrap">${opts.body.value}</div>
</body>
</html>`;
}

function escapeTitle(title: string): string {
  return title.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

/** The persistent server switcher, shown only when the session has >1 guild. */
function renderSwitcher(session: Session | undefined, guild: SessionGuild | undefined): RawHtml {
  if (!session || !guild || session.guilds.length < 2) {
    return html``;
  }
  return html`
    <form class="switcher" method="get" action="/app/select">
      ${guildBadge(guild)}
      <select name="guild" onchange="this.form.submit()">
        ${session.guilds.map(
          (g) =>
            html`<option value="${g.id}" ${g.id === guild.id ? raw("selected") : ""}>${g.name}</option>`,
        )}
      </select>
      <noscript><button class="btn secondary" type="submit">Go</button></noscript>
    </form>
  `;
}

/** The unauthenticated front door. Names no bot; one action. */
export function loginPage(): string {
  const body = html`
    <div class="login">
      <h1>Moderator Dashboard</h1>
      <p>Moderators only — you'll only see servers you help run.</p>
      <p style="margin-top:28px"><a class="btn" href="/login">Sign in with Discord</a></p>
    </div>
  `;
  return layout({ title: "Sign in — Moderator Dashboard", body });
}

/** Shown when a signed-in visitor manages none of the allowlisted guilds. */
export function noAccessPage(): string {
  const body = html`
    <div class="login">
      <h1>No servers to show</h1>
      <p>
        You're signed in, but you don't manage any server this dashboard covers.
        Access needs the Manage Server permission on an allowlisted server.
      </p>
      <p style="margin-top:28px"><a class="btn secondary" href="/logout">Sign out</a></p>
    </div>
  `;
  return layout({ title: "No access — Moderator Dashboard", body });
}

/** The guild picker, shown when a moderator manages more than one guild. */
export function pickerPage(session: Session): string {
  const body = html`
    <h1>Choose a server</h1>
    <p class="muted">You manage more than one server this dashboard covers.</p>
    <div class="panel" style="margin-top:16px">
      ${session.guilds.map(
        (g) => html`
          <div class="picker-row">
            ${guildBadge(g)}
            <span style="margin-right:auto">${g.name}</span>
            <a class="btn secondary" href="/app/select?guild=${g.id}">Open</a>
          </div>
        `,
      )}
    </div>
  `;
  return layout({ title: "Choose a server — Moderator Dashboard", session, body });
}

/** Render the recent-activity spark as zero-filled bars. */
function renderSpark(view: HomeView): RawHtml {
  const max = view.spark.reduce((m, p) => Math.max(m, p.count), 0);
  const bars = view.spark.map((p) => {
    const pct = max === 0 ? 0 : Math.round((p.count / max) * 100);
    return html`<div class="bar" style="height:${pct}%" title="${p.day}: ${p.count}"></div>`;
  });
  return html`<div class="spark">${bars}</div>`;
}

/** The home overview a moderator lands on inside a guild. */
export function homePage(session: Session, guild: SessionGuild, view: HomeView): string {
  const poolStat = view.pool.hasDefaults
    ? html`<span class="stat">~${view.pool.eligible} <span class="of">of ${view.pool.considered} recently active</span></span>`
    : html`<span class="muted">Set a default activity requirement to see the eligible pool.</span>`;

  const body = html`
    <h1>${guild.name}</h1>

    ${view.warnings.length > 0
      ? html`<div style="margin-top:16px">${view.warnings.map((w) => html`<div class="warn">${w.message}</div>`)}</div>`
      : ""}

    <h2>What's live now</h2>
    <div class="panel">
      ${view.liveRaffles.length === 0
        ? html`<p class="muted" style="margin:0">No raffles running or scheduled.</p>`
        : view.liveRaffles.map(
            (r) => html`
              <div class="card">
                <div>
                  <div style="font-weight:600">${r.name}</div>
                  <div class="muted" style="font-size:13px">
                    Opens ${formatUtc(r.startsAt)} → closes ${formatUtc(r.endsAt)}
                  </div>
                </div>
                <div style="text-align:right">
                  <span class="pill">${r.status}</span>
                  <div class="muted" style="font-size:13px; margin-top:4px">
                    ${r.entrants} ${r.entrants === 1 ? "entry" : "entries"} · ${r.drawMode ?? "auto"}
                  </div>
                </div>
              </div>
            `,
          )}
    </div>

    <h2>The pool right now</h2>
    <div class="panel">${poolStat}</div>

    <h2>Recent activity</h2>
    <div class="panel">
      ${renderSpark(view)}
      <p class="muted" style="font-size:13px; margin:12px 0 0">Guild-wide messages counted, last 28 days.</p>
    </div>

    <footer>Read-only overview. Every change still happens in Discord.</footer>
  `;
  return layout({ title: `${guild.name} — Moderator Dashboard`, session, guild, current: "home", body });
}

/** A minimal error page for unexpected failures (e.g. a failed OAuth exchange). */
export function errorPage(message: string): string {
  const body = html`
    <div class="login">
      <h1>Something went wrong</h1>
      <p>${message}</p>
      <p style="margin-top:28px"><a class="btn secondary" href="/">Back to start</a></p>
    </div>
  `;
  return layout({ title: "Error — Moderator Dashboard", body });
}
