/**
 * Tiny server-side HTML templating.
 *
 * The dashboard is server-rendered with no frontend build (docs/dashboard.md
 * "Architecture sketch"), so a small tagged-template helper is all we need. The
 * `html` tag escapes every interpolation by default; wrap pre-built, trusted
 * markup in `raw(...)` to opt out. Values that are arrays are rendered and
 * concatenated; null/undefined/false render as empty, which makes conditional
 * fragments (`cond && html\`...\``) read cleanly.
 */

/** Marker for HTML that is already safe and must not be re-escaped. */
export class RawHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Wrap a trusted, already-escaped string so `html` interpolates it verbatim. */
export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

/** Escape the five HTML-significant characters for safe text/attribute output. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

type Renderable = RawHtml | string | number | null | undefined | false | Renderable[];

function render(value: Renderable): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (value instanceof RawHtml) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  return escapeHtml(String(value));
}

/** Tagged template that escapes interpolations and returns trusted RawHtml. */
export function html(strings: TemplateStringsArray, ...values: Renderable[]): RawHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new RawHtml(out);
}
