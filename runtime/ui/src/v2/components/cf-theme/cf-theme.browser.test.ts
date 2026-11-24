/**
 * Checks how a `<cf-theme>` inside another one combines with it: the inner one
 * changes what its partial names and inherits the rest. Computed custom
 * properties need a live document, so these run in a browser.
 */

import { expect } from "@std/expect";

import { CFCodeEditor } from "../cf-code-editor/index.ts";
import { CFThemeProvider } from "./index.ts";

const OUTER_FONT = "Georgia";
const ACCENT = "rgb(1, 2, 3)";
const HOST_SURFACE = "rgb(9, 9, 9)";
const HOST_TEXT = "rgb(240, 240, 240)";

/** The value of the custom property `name` in effect at `element`. */
function token(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

interface Nested {
  outer: CFThemeProvider;
  inner: CFThemeProvider;
  content: HTMLElement;
  done(): void;
}

/** A `cf-theme` carrying `outerTheme`, holding one carrying `innerTheme`. */
async function nest(
  outerTheme: Record<string, unknown>,
  innerTheme: Record<string, unknown>,
  parent: HTMLElement = document.body,
): Promise<Nested> {
  const outer = new CFThemeProvider();
  outer.theme = outerTheme;
  const inner = new CFThemeProvider();
  inner.theme = innerTheme;
  const content = document.createElement("div");
  inner.append(content);
  outer.append(inner);
  parent.append(outer);
  await outer.updateComplete;
  await inner.updateComplete;
  return { outer, inner, content, done: () => outer.remove() };
}

Deno.test("a nested theme naming only an accent sets it and keeps the outer theme's font", async () => {
  const { content, done } = await nest(
    { fontFamily: OUTER_FONT },
    { accentColor: ACCENT },
  );
  try {
    expect(token(content, "--cf-theme-font-family")).toBe(OUTER_FONT);
    expect(getComputedStyle(content).fontFamily).toBe(OUTER_FONT);
    expect(token(content, "--cf-theme-color-primary")).toBe(ACCENT);
    expect(token(content, "--cf-theme-color-accent")).toBe(ACCENT);
    expect(token(content, "--cf-theme-color-primary-pressed")).toContain(
      ACCENT,
    );
  } finally {
    done();
  }
});

Deno.test("a nested theme follows a change the outer theme makes to what it does not name", async () => {
  const { outer, inner, content, done } = await nest(
    { fontFamily: OUTER_FONT },
    { accentColor: ACCENT },
  );
  try {
    outer.theme = { fontFamily: "Courier" };
    await outer.updateComplete;
    await inner.updateComplete;

    expect(token(content, "--cf-theme-font-family")).toBe("Courier");
    expect(token(content, "--cf-theme-color-primary")).toBe(ACCENT);
  } finally {
    done();
  }
});

Deno.test("a nested theme hands its consumers the outer theme with its own changes over it", async () => {
  const { content, done } = await nest(
    { colorScheme: "dark" },
    { accentColor: ACCENT },
  );
  try {
    const editor = new CFCodeEditor();
    content.append(editor);
    await editor.updateComplete;

    expect(editor.ambientTheme.colorScheme).toBe("dark");
    expect(editor.ambientTheme.colors.primary).toBe(ACCENT);
  } finally {
    done();
  }
});

/** A host that sets tokens by CSS alone, as the Weaver does. */
function cssHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.setProperty("--cf-theme-color-surface", HOST_SURFACE);
  host.style.setProperty("--cf-theme-color-text", HOST_TEXT);
  host.style.setProperty("--cf-theme-font-family", OUTER_FONT);
  host.style.setProperty("font-family", OUTER_FONT);
  document.body.append(host);
  return host;
}

Deno.test("a tint outside any cf-theme keeps what a CSS-only host sets and changes only its accent", async () => {
  const host = cssHost();
  try {
    const provider = new CFThemeProvider();
    provider.theme = { accentColor: ACCENT };
    const content = document.createElement("div");
    provider.append(content);
    host.append(provider);
    await provider.updateComplete;

    expect(token(content, "--cf-theme-color-surface")).toBe(HOST_SURFACE);
    expect(token(content, "--cf-theme-color-text")).toBe(HOST_TEXT);
    expect(token(content, "--cf-theme-font-family")).toBe(OUTER_FONT);
    expect(getComputedStyle(content).fontFamily).toBe(OUTER_FONT);
    expect(token(content, "--cf-theme-color-primary")).toBe(ACCENT);
    expect(token(content, "--cf-theme-color-accent")).toBe(ACCENT);
  } finally {
    host.remove();
  }
});

Deno.test("a tint outside any cf-theme writes nothing for a color scheme it does not name", async () => {
  const host = cssHost();
  try {
    const provider = new CFThemeProvider();
    provider.theme = { accentColor: ACCENT };
    host.append(provider);
    await provider.updateComplete;

    expect(provider.style.getPropertyValue("color-scheme")).toBe("");
    expect(provider.style.getPropertyValue("--cf-theme-color-background"))
      .toBe("");
  } finally {
    host.remove();
  }
});

Deno.test("a tint that shrinks takes its old changes back off", async () => {
  const host = cssHost();
  try {
    const provider = new CFThemeProvider();
    provider.theme = { accentColor: ACCENT, fontFamily: "Courier" };
    host.append(provider);
    await provider.updateComplete;
    expect(provider.style.length).toBeGreaterThan(0);

    provider.theme = {};
    await provider.updateComplete;

    expect(provider.style.length).toBe(0);
  } finally {
    host.remove();
  }
});

Deno.test("a theme with nothing in effect above it writes the whole theme", async () => {
  const provider = new CFThemeProvider();
  provider.theme = { accentColor: ACCENT };
  document.body.append(provider);
  try {
    await provider.updateComplete;
    expect(provider.style.getPropertyValue("--cf-theme-color-surface"))
      .not.toBe("");
    expect(provider.style.getPropertyValue("--cf-theme-color-primary"))
      .toBe(ACCENT);
  } finally {
    provider.remove();
  }
});
