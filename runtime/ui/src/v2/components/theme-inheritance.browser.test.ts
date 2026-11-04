/**
 * Checks that a widget draws the theme in effect around it.
 *
 * A host gives every pattern in it one look by setting the `--cf-theme-*`
 * properties on an ancestor, and `cf-theme` sets them on itself; either way
 * they reach a widget by inheritance, and a widget that writes its own copy on
 * its host hides them. Computed custom properties need a live document, so
 * these run in a browser.
 */

import { expect } from "@std/expect";

import "../index.ts";
import { CFThemeProvider } from "./cf-theme/index.ts";
import { CFToolsChip } from "./cf-tools-chip/index.ts";
import { type CFTheme, mergeWithDefaultTheme } from "./theme-context.ts";

/** The widgets that read the theme tokens in their own styles. */
const WIDGETS = [
  "cf-autocomplete",
  "cf-button",
  "cf-chat",
  "cf-chat-message",
  "cf-file-input",
  "cf-heading",
  "cf-input",
  "cf-location",
  "cf-markdown",
  "cf-prompt-input",
  "cf-radio-group",
  "cf-select",
  "cf-textarea",
  "cf-tool-call",
  "cf-tools-chip",
  "cf-voice-input",
];

const HOST_TEXT = "rgb(10, 20, 30)";
const HOST_FONT = "Georgia";

/** A host element carrying its own text color and font as theme tokens. */
function themedHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.setProperty("--cf-theme-color-text", HOST_TEXT);
  host.style.setProperty("--cf-theme-font-family", HOST_FONT);
  document.body.append(host);
  return host;
}

/** The value of the custom property `name` in effect at `element`. */
function token(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

async function mountIn<T extends HTMLElement>(
  parent: HTMLElement,
  tag: string,
): Promise<T> {
  const element = document.createElement(tag) as T & {
    updateComplete?: Promise<unknown>;
  };
  parent.append(element);
  await element.updateComplete;
  return element;
}

for (const tag of WIDGETS) {
  Deno.test(`${tag} draws the theme tokens a host sets on an ancestor`, async () => {
    const host = themedHost();
    try {
      const widget = await mountIn(host, tag);

      expect(token(widget, "--cf-theme-color-text")).toBe(HOST_TEXT);
      expect(token(widget, "--cf-theme-font-family")).toBe(HOST_FONT);
    } finally {
      host.remove();
    }
  });
}

Deno.test("a widget draws the theme of the cf-theme around it", async () => {
  const provider = new CFThemeProvider();
  provider.theme = { fontFamily: HOST_FONT };
  document.body.append(provider);
  try {
    await provider.updateComplete;
    const button = await mountIn(provider, "cf-button");

    expect(token(button, "--cf-theme-font-family")).toBe(HOST_FONT);
  } finally {
    provider.remove();
  }
});

Deno.test("a theme given to a widget directly is drawn over the host's, and withdrawing it restores the host's", async () => {
  const host = themedHost();
  try {
    const button = await mountIn<
      HTMLElement & {
        theme: CFTheme | undefined;
        updateComplete: Promise<unknown>;
      }
    >(host, "cf-button");
    const given = mergeWithDefaultTheme({
      colors: { text: "rgb(200, 100, 50)" },
    });

    button.theme = given;
    await button.updateComplete;
    expect(token(button, "--cf-theme-color-text")).toBe("rgb(200, 100, 50)");

    button.theme = undefined;
    await button.updateComplete;
    expect(token(button, "--cf-theme-color-text")).toBe(HOST_TEXT);
  } finally {
    host.remove();
  }
});

Deno.test("withdrawing a direct theme leaves the styles the author set on the widget", async () => {
  const host = themedHost();
  try {
    const button = await mountIn<
      HTMLElement & {
        theme: CFTheme | undefined;
        updateComplete: Promise<unknown>;
      }
    >(host, "cf-button");
    button.style.setProperty("--cf-theme-color-text", "rgb(7, 7, 7)");
    button.style.setProperty("font-family", "Courier");

    button.theme = mergeWithDefaultTheme({ colors: { primary: "red" } });
    await button.updateComplete;
    button.theme = undefined;
    await button.updateComplete;

    expect(button.style.getPropertyValue("--cf-theme-color-text")).toBe(
      "rgb(7, 7, 7)",
    );
    expect(button.style.getPropertyValue("font-family")).toBe("Courier");
    expect(button.style.getPropertyValue("--cf-theme-color-primary")).toBe("");
  } finally {
    host.remove();
  }
});

Deno.test("the tools chip's overlay on the document body carries the host's tokens", async () => {
  const host = themedHost();
  try {
    const chip = await mountIn<CFToolsChip>(host, "cf-tools-chip");
    chip.open = true;
    await chip.updateComplete;

    const overlay = document.querySelector("[data-cf-tools-chip-overlay]");
    expect(overlay).toBeInstanceOf(HTMLElement);
    expect(overlay?.parentElement).toBe(document.body);
    expect(token(overlay!, "--cf-theme-color-text")).toBe(HOST_TEXT);
    expect(token(overlay!, "--cf-theme-font-family")).toBe(HOST_FONT);
  } finally {
    host.remove();
  }
});

Deno.test("the tools chip's open overlay follows a change to the cf-theme around it", async () => {
  const provider = new CFThemeProvider();
  provider.theme = { fontFamily: HOST_FONT };
  document.body.append(provider);
  try {
    await provider.updateComplete;
    const chip = await mountIn<CFToolsChip>(provider, "cf-tools-chip");
    chip.open = true;
    await chip.updateComplete;
    const overlay = document.querySelector("[data-cf-tools-chip-overlay]")!;
    expect(token(overlay, "--cf-theme-font-family")).toBe(HOST_FONT);

    provider.theme = { fontFamily: "Courier" };
    await provider.updateComplete;
    await chip.updateComplete;

    expect(token(overlay, "--cf-theme-font-family")).toBe("Courier");
  } finally {
    provider.remove();
  }
});

Deno.test("the tools chip's open overlay follows a theme preference change", async () => {
  const host = themedHost();
  try {
    const chip = await mountIn<CFToolsChip>(host, "cf-tools-chip");
    chip.open = true;
    await chip.updateComplete;
    const overlay = document.querySelector("[data-cf-tools-chip-overlay]")!;

    host.style.setProperty("--cf-theme-color-text", "rgb(1, 1, 1)");
    document.dispatchEvent(new CustomEvent("theme-preference-changed"));

    expect(token(overlay, "--cf-theme-color-text")).toBe("rgb(1, 1, 1)");
  } finally {
    host.remove();
  }
});

Deno.test("a partial theme given to the chat tints the ambient one", async () => {
  const provider = new CFThemeProvider();
  provider.theme = { fontFamily: HOST_FONT };
  document.body.append(provider);
  try {
    await provider.updateComplete;
    const chat = await mountIn<
      HTMLElement & { theme: unknown; updateComplete: Promise<unknown> }
    >(provider, "cf-chat");
    chat.theme = { accentColor: "rgb(1, 2, 3)" };
    await chat.updateComplete;

    expect(token(chat, "--cf-theme-font-family")).toBe(HOST_FONT);
    expect(token(chat, "--cf-theme-color-primary")).toBe("rgb(1, 2, 3)");
  } finally {
    provider.remove();
  }
});

Deno.test("the chat's spacing tokens give way to a host's", async () => {
  const host = themedHost();
  host.style.setProperty("--cf-theme-spacing-message-bottom", "33px");
  try {
    const chat = await mountIn(host, "cf-chat");

    expect(token(chat, "--cf-theme-spacing-message-bottom")).toBe("33px");
    expect(chat.style.getPropertyValue("--cf-theme-spacing-message-bottom"))
      .toBe("");
    expect(chat.style.getPropertyValue("--cf-theme-spacing-padding-bubble"))
      .not.toBe("");
  } finally {
    host.remove();
  }
});

Deno.test("the chat sets its spacing tokens when no host has any", async () => {
  const chat = await mountIn(document.body, "cf-chat");
  try {
    expect(chat.style.getPropertyValue("--cf-theme-spacing-message-bottom"))
      .not.toBe("");
  } finally {
    chat.remove();
  }
});

Deno.test("a primary button with no theme anywhere above it still draws its fill", async () => {
  const button = await mountIn(document.body, "cf-button");
  try {
    const inner = button.shadowRoot?.querySelector(".button");
    expect(inner).toBeInstanceOf(HTMLElement);
    expect(getComputedStyle(inner!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
  } finally {
    button.remove();
  }
});

for (const tag of ["cf-checkbox", "cf-radio"]) {
  Deno.test(`${tag} draws its box in the host's theme colors`, async () => {
    const host = themedHost();
    host.style.setProperty("--cf-theme-color-primary", "rgb(1, 2, 3)");
    host.style.setProperty("--cf-theme-color-surface", "rgb(4, 5, 6)");
    host.style.setProperty("--cf-theme-color-border", "rgb(7, 8, 9)");
    try {
      const control = await mountIn(host, tag);

      expect(token(control, "--primary")).toBe("rgb(1, 2, 3)");
      expect(token(control, "--background")).toBe("rgb(4, 5, 6)");
      expect(token(control, "--foreground")).toBe(HOST_TEXT);
      expect(token(control, "--border")).toBe("rgb(7, 8, 9)");
    } finally {
      host.remove();
    }
  });
}
