# Dashboard — design-tool briefs

**Status: exploratory / not built.** These are ready-to-paste prompts for a visual
design tool (e.g. Claude Design), one per screen, for the moderator dashboard
sketched in [dashboard.md](dashboard.md). That doc is the *why and the plumbing*;
this file is the *look*. Feed the tool **one screen at a time** — it does better
with a single, richly-specified screen than "design six pages."

## Shared conventions (apply to every brief)

- **Product:** a moderator dashboard for a Discord raffle bot that runs auditable,
  activity-gated raffles. Moderators log in with Discord; the pages are mod- or
  member-gated (nothing here is public).
- **Tone:** calm, precise, trust-forward, WYSIWYG — not flashy or gamified.
- **Theme:** dark-mode-first (these are Discord users) with a clean light mode;
  accessible contrast throughout.
- **Naming:** there is no fixed product name. The header shows the **bot's nickname
  on the currently-selected server** (use "Tombola" as the placeholder in
  mockups); it rebrands per server. Wherever a brief says "Tombola," treat it as
  that resolved nickname. Before a server is selected (login/landing), show no bot
  name — just "Moderator Dashboard."
- **Consistency:** the activity-distribution **histogram** appears in both the
  simulator and the Raffle Designer's eligible-pool panel — style it once so they
  read as one system.

---

## 1. Raffle Designer (the hero screen)

```
Design a screen for a Discord raffle bot's MODERATOR DASHBOARD. The bot runs
auditable, activity-gated raffles; moderators log in with Discord. Calm, precise,
confident, WYSIWYG — not flashy. Dark-mode-first with a clean light mode;
accessible. NAMING: no fixed product name — the header shows the bot's nickname on
the selected server (placeholder "Tombola"); before a server is picked, show just
"Moderator Dashboard."

HERO SCREEN: the Raffle Designer — a visual composer for building a whole raffle,
everything visible at once instead of a step-by-step wizard. Split-pane: a
composer form on the LEFT, live previews on the RIGHT that update as you type.

LEFT — composer form, grouped into collapsible sections:
  • Basics: Name ("Summer Vinyl Giveaway"), Prize ("A record of your choice"),
    Description (short rich text).
  • Schedule: Start and End (date/time pickers) in the server's timezone; a quick
    "opens Fri 18:00 → closes Sun 18:00, runs 2 days" summary line.
  • Eligibility: Messages required (10), Activity window (14 days), Distinct active
    days (3), Min account age (30 days), Win cooldown (60 days); plus toggles for
    "Open to everyone" and "Bar past winners."
  • Draw: Number of winners (1), Draw mode (auto at close / manual), optional
    Claim window (24h).
Inline validation appears in context (e.g. a gentle red note "End is before start"
under the schedule).

RIGHT — a stack of live previews:
  1. ENTRY-CARD PREVIEW — render it as a real Discord message/embed as it will
     appear in the announce channel: title, prize, "Starts / Ends / Hosted by /
     Entries: 0", an Enter button, and a small subtext eligibility line that is
     deliberately vague ("you must have been active in the last 14 days" — no exact
     number). Make it look like Discord, not a generic card. Shows the same bot
     nickname as the header.
  2. ELIGIBLE-POOL PREVIEW — "This raffle would open to ~48 of 213 members," with a
     small histogram of members by message count and a vertical line at the current
     threshold, plus a short reason breakdown ("32 too few active days, 14 in
     cooldown"). Updates live as eligibility fields change.

BOTTOM of the composer: a primary "Create in Discord" button. Clicking it opens a
HANDOFF MODAL — a signature moment, design it with care:
  • A short generated command in a big copyable code block:
        /raffle create-from a7f3k9
  • Copy button.
  • Reassuring explanation: "Run this in your server. The bot will show you a
    summary and ask you to confirm before the raffle is created — nothing is
    published from here." A subtle "expires in 24h" note.
Design empty, loading, and validation-error states too.

CONTEXT (other screens, for consistency — don't design now): a standalone
eligibility simulator (same histogram, for tuning server defaults); a raffle list
+ detail with winners and provably-fair verification data; a gated "verify this
draw" page with a green Verified badge.

Brand: no fixed product name — the header uses the per-server bot nickname
(placeholder "Tombola"). Discord-adjacent but its own identity; a restrained
ticket/raffle motif is welcome, kept grown-up, not carnival.
```

---

## 2. Standalone eligibility simulator

```
Design a screen for a Discord raffle bot's MODERATOR DASHBOARD (mod-only, Discord
login). Trust-and-transparency product: calm, precise, data-forward, not flashy.
Dark-mode-first with a clean light mode; accessible contrast. NAMING: the header
shows the bot's nickname on the selected server (placeholder "Tombola"); before a
server is picked, show just "Moderator Dashboard."

SCREEN: the Eligibility Simulator. Unlike the Raffle Designer (which builds one
raffle), this tunes the SERVER'S DEFAULT entry requirements — a "what should our
bar be?" sandbox. Nothing here writes data; it's a live read-out.

Layout: a controls panel + a live results area.

CONTROLS (sliders/steppers, each showing its value):
  • Messages required (X): 10
  • Activity window (Y days): 14
  • Distinct active days (K): 3
  • Minimum account age (days): 30
  • Win cooldown (days): 60
Changing any control updates the results live.

RESULTS, three parts:
  1. Headline stat: "48 of 213 members eligible" (updates as knobs move).
  2. THE CENTERPIECE — an activity-distribution histogram: members bucketed by
     message count over the window, with a vertical line at the current threshold
     and the excluded area shaded, plus a caption like "Raise X to 15 and you cut
     22 more members." This is the 'what number do I pick?' visual — make it the
     focal point.
  3. A member table: avatar, name, an Eligible/Not-eligible pill, and a reason
     column for the ineligible ones ("Only 2 active days", "In win cooldown
     (11 days left)", "Account too new"). Sortable.

Below results: an "Apply in Discord" card with the generated command in a copyable
code block, e.g.
    /raffle config set req-messages:10 req-days:14 req-active-days:3
and a note: "The dashboard makes no changes — run this in your server to apply."

Exact numbers are fine here (mod-only view). Show empty and loading states. The
histogram is the hero; give it room.
```

---

## 3. Draw-verification page (gated, not public)

```
Design an AUTHENTICATED page inside a Discord raffle bot's dashboard (Discord
login required; visible only to members of the raffle's server — optionally
mods-only). It lets a viewer independently verify that a finished raffle's draw
was fair, using a commit-reveal scheme (the bot committed to a secret before
knowing the entrants, then revealed it). The page recomputes the checks IN THE
BROWSER, so the result doesn't depend on trusting the operator. Match the
dashboard's look: calm, precise, trust-forward, dark-mode-first with a clean light
mode; accessible; works on mobile. NAMING: shows the bot's nickname on that
raffle's server (placeholder "Tombola").

HERO: a big, unmistakable verdict.
  • A large green "✓ Verified — this draw checks out" badge (design the red
    "✗ Does not verify" failed state too).
  • Raffle title "Summer Vinyl Giveaway", drawn 14 Jul 2026, 213 entrants.
  • Winner: @alice (1 winner), avatar + name.

THE PROOF — a readable step-by-step (each row: label, monospace value, a ✓ once
recomputed):
  1. Entrant-list hash (SHA-256 of the frozen, sorted entrant ids): `dbbc47f2…`
  2. Revealed secret: `test-secret-…`
  3. Commitment check: SHA-256(secret) == published commitment `9a3f…` ✓
  4. Draw seed = SHA-256(hash + secret): `4e1c…` ✓
  5. Winner index = seed mod 213 = 87 → entrant #87 = @alice ✓
Present it as "here's the math, and we just ran it for you" — truncate hashes with
copy/expand, not a wall of hex.

SUPPORTING:
  • A collapsible plain-language "How this works" (commit-reveal, provably fair).
  • An expandable full entrant list (ids) with the winning index highlighted.
  • Verified, failed, and loading (in-browser hashing) states.

Tone: confident and calm, credible not celebratory. Its job is to make "you can
check this yourself" feel real — for the server's own people, not the public.
```

---

## Nudges once the first pass comes back

- **Entry-card preview** is the detail most likely to be under-delivered — push it
  to look like an *actual Discord embed*, not a generic card.
- **Handoff modal** is the novel interaction — make it feel like a confident
  "here's your ticket to Discord" moment, not a plain dialog.
- **Verifier** should feel credible and calm, not celebratory-tacky; its whole job
  is making "you can check this yourself" feel real.
- **Histogram** must look identical in the simulator and the Designer's
  eligible-pool panel.
