/**
 * Checks that a surface recipe, derived from `--cf-theme-*` tokens, follows a
 * tint made beneath another component.
 * Computed custom properties need a live document, so these run in a browser.
 */

import { expect } from "@std/expect";

import { CFCard } from "../components/cf-card/index.ts";
import { CFHoverReveal } from "../components/cf-hover-reveal/index.ts";
import { CFThemeProvider } from "../components/cf-theme/index.ts";

const PAGE_SURFACE = "rgb(9, 9, 9)";
const TINT_SURFACE = "rgb(1, 2, 3)";
const TINT_TEXT = "rgb(240, 240, 240)";

/** The background a card draws: its inner container's, in its shadow root. */
function cardBackground(card: CFCard): string {
  const inner = card.shadowRoot?.querySelector(".card");
  if (!inner) throw new Error("cf-card rendered no .card container");
  return getComputedStyle(inner).backgroundColor;
}

interface Page {
  /** The component between the page's theme and the tints, as a chat
   * thread's reaction reveal sits around a message. */
  reveal: CFHoverReveal;
  updated(): Promise<void>;
}

/** A page themed with `PAGE_SURFACE`, holding a cf-hover-reveal. */
function page(): Page {
  const theme = new CFThemeProvider();
  theme.theme = { colors: { surface: PAGE_SURFACE } };
  const reveal = new CFHoverReveal();
  theme.append(reveal);
  document.body.append(theme);
  return {
    reveal,
    updated: async () => {
      await theme.updateComplete;
      await reveal.updateComplete;
    },
  };
}

/** Waits for each element's first render, then for the page's. */
async function rendered(
  { updated }: Page,
  ...elements: { updateComplete: Promise<boolean> }[]
): Promise<void> {
  await updated();
  for (const element of elements) await element.updateComplete;
}

Deno.test("a card under a cf-theme tint inside another component draws the tint's surface", async () => {
  const p = page();
  const tint = new CFThemeProvider();
  tint.theme = { colors: { surface: TINT_SURFACE } };
  const tinted = new CFCard();
  tint.append(tinted);
  // A tint that names no surface leaves the page's surface in effect.
  const textOnly = new CFThemeProvider();
  textOnly.theme = { colors: { text: TINT_TEXT } };
  const plain = new CFCard();
  textOnly.append(plain);
  p.reveal.append(tint, textOnly);
  try {
    await rendered(p, tint, textOnly, tinted, plain);
    expect(cardBackground(tinted)).toBe(TINT_SURFACE);
    expect(cardBackground(plain)).toBe(PAGE_SURFACE);
  } finally {
    p.reveal.parentElement?.remove();
  }
});

Deno.test("a card under any element setting the theme's surface inside another component draws that surface", async () => {
  const p = page();
  const tint = document.createElement("div");
  tint.style.setProperty("--cf-theme-color-surface", TINT_SURFACE);
  const tinted = new CFCard();
  tint.append(tinted);
  const plain = new CFCard();
  p.reveal.append(tint, plain);
  try {
    await rendered(p, tinted, plain);
    expect(cardBackground(tinted)).toBe(TINT_SURFACE);
    expect(cardBackground(plain)).toBe(PAGE_SURFACE);
  } finally {
    p.reveal.parentElement?.remove();
  }
});

Deno.test("a card's own surface wins over the recipe, inside another component or not", async () => {
  const p = page();
  const own = "rgb(4, 5, 6)";
  const inside = new CFCard();
  inside.style.setProperty("--cf-card-color-surface", own);
  const outside = new CFCard();
  outside.style.setProperty("--cf-card-color-surface", own);
  p.reveal.append(inside);
  p.reveal.parentElement?.append(outside);
  try {
    await rendered(p, inside, outside);
    expect(cardBackground(inside)).toBe(own);
    expect(cardBackground(outside)).toBe(own);
  } finally {
    p.reveal.parentElement?.remove();
  }
});
