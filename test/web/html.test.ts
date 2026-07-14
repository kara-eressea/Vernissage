import { describe, expect, it } from "vitest";
import { escapeHtml, html, raw } from "../../src/web/html.js";

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("html tag", () => {
  it("escapes interpolated values by default", () => {
    const name = "<script>alert(1)</script>";
    expect(html`<p>${name}</p>`.value).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("passes raw() through unescaped", () => {
    expect(html`<div>${raw("<b>bold</b>")}</div>`.value).toBe("<div><b>bold</b></div>");
  });

  it("renders arrays by concatenation and drops falsy values", () => {
    const items = [html`<li>a</li>`, html`<li>b</li>`];
    expect(html`<ul>${items}</ul>`.value).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(html`x${null}${undefined}${false}y`.value).toBe("xy");
  });

  it("nests html fragments without double-escaping", () => {
    const inner = html`<span>${"a&b"}</span>`;
    expect(html`<p>${inner}</p>`.value).toBe("<p><span>a&amp;b</span></p>");
  });
});
