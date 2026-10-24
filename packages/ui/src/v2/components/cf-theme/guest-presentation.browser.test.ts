/**
 * Checks that `cf-theme` themes the iframe guests beneath it: it provides
 * `iframePresentationContext` from its own computed `--cf-theme-*` values, a
 * nested tint provides its own, and `cf-iframe`'s explicit `presentation`
 * still overrides the context or opts out with `null`. Computed custom
 * properties and guest documents need a live document, so these run in a
 * browser.
 */

import {
  CommonIframeSandboxElement,
  type IframePresentation,
} from "@commonfabric/iframe-sandbox";
import { expect } from "@std/expect";

import { CFIframe } from "../cf-iframe/index.ts";
import { CFThemeProvider } from "./index.ts";

const TEXT = "rgb(1, 2, 3)";
const TINT = "rgb(10, 20, 30)";

/** The presentation `element` hands its sandbox, once it has rendered. */
async function presentationOf(
  element: CFIframe,
): Promise<IframePresentation | null> {
  await element.updateComplete;
  const sandbox = element.shadowRoot?.querySelector("common-iframe-sandbox");
  if (!(sandbox instanceof CommonIframeSandboxElement)) {
    throw new Error("cf-iframe rendered no sandbox");
  }
  return sandbox.presentation;
}

/** A `cf-theme` carrying `theme` around a fresh `cf-iframe`, in the page. */
async function themed(theme: Record<string, unknown>) {
  const provider = new CFThemeProvider();
  provider.theme = theme;
  const iframe = new CFIframe();
  provider.append(iframe);
  document.body.append(provider);
  await provider.updateComplete;
  return { provider, iframe, done: () => provider.remove() };
}

/** What the fixture's guest reports about its own styling. */
interface GuestReading {
  ink: string;
  variable: string;
  heading: string;
}

/** Returns the next reading reported by the fixture's guest named `id`. */
function reading<T = GuestReading>(id: string) {
  return new Promise<T>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      globalThis.removeEventListener("message", receive);
      resolve(event.data.reading);
    };
    globalThis.addEventListener("message", receive);
  });
}

/** Returns a guest document that reports its styling on load and on change. */
function reportingGuest(id: string) {
  return `<h1>Heading</h1><script>
      function report() {
        const root = getComputedStyle(document.documentElement);
        top.postMessage({ id: ${JSON.stringify(id)}, reading: {
          ink: getComputedStyle(document.body).color,
          variable: root.getPropertyValue('--cf-theme-color-text').trim(),
          heading: getComputedStyle(document.querySelector('h1')).color,
        } }, '*');
      }
      globalThis.addEventListener('load', report);
      document.addEventListener('common-iframe-presentation', report);
    </script>`;
}

Deno.test("a cf-iframe under a cf-theme receives the theme's text color and resolved scheme", async () => {
  const { iframe, done } = await themed({
    colorScheme: "light",
    colors: { text: TEXT },
  });
  try {
    const presentation = await presentationOf(iframe);
    expect(presentation?.css).toContain(`--cf-theme-color-text: ${TEXT};`);
    expect(presentation?.attributes).toEqual({ "data-color-scheme": "light" });
    expect(presentation?.stylesheets).toEqual([]);
  } finally {
    done();
  }
});

Deno.test("a nested tinting cf-theme gives its own iframe the tint's primary", async () => {
  const { provider: outer, iframe: outerIframe, done } = await themed({
    colors: { text: TEXT },
  });
  const inner = new CFThemeProvider();
  inner.theme = { accentColor: TINT };
  const innerIframe = new CFIframe();
  inner.append(innerIframe);
  outer.append(inner);
  await inner.updateComplete;
  try {
    const innerCss = (await presentationOf(innerIframe))?.css;
    expect(innerCss).toContain(`--cf-theme-color-primary: ${TINT};`);
    expect(innerCss).toContain(`--cf-theme-color-text: ${TEXT};`);
    expect((await presentationOf(outerIframe))?.css).not.toContain(TINT);
  } finally {
    done();
  }
});

Deno.test("an explicit presentation on the cf-iframe wins, and null opts out", async () => {
  const { iframe, done } = await themed({ colors: { text: TEXT } });
  const own = {
    css: "h1 { color: red; }",
    attributes: { "data-skin": "own" },
    stylesheets: [],
  };
  try {
    iframe.presentation = own;
    expect(await presentationOf(iframe)).toEqual(own);
    iframe.presentation = null;
    expect(await presentationOf(iframe)).toBeNull();
    iframe.presentation = undefined;
    expect((await presentationOf(iframe))?.css).toContain(TEXT);
  } finally {
    done();
  }
});

Deno.test("cf-theme re-provides on theme-preference-changed, and sends nothing when unchanged", async () => {
  const { provider, iframe, done } = await themed({ colors: { text: TEXT } });
  const override = document.createElement("style");
  try {
    const first = await presentationOf(iframe);
    document.dispatchEvent(new CustomEvent("theme-preference-changed"));
    expect(await presentationOf(iframe)).toBe(first);

    // A host's `!important` rule outranks the element's inline tokens and
    // changes them without an event of its own.
    provider.id = `host-${crypto.randomUUID()}`;
    override.textContent =
      `#${provider.id} { --cf-theme-color-text: ${TINT} !important; }`;
    document.head.append(override);
    expect(await presentationOf(iframe)).toBe(first);
    document.dispatchEvent(new CustomEvent("theme-preference-changed"));
    expect((await presentationOf(iframe))?.css).toContain(
      `--cf-theme-color-text: ${TINT};`,
    );
  } finally {
    override.remove();
    done();
  }
});

Deno.test("the theme reaches the guest's body, heading and root, and a theme change restyles it", async () => {
  const provider = new CFThemeProvider();
  provider.theme = { colors: { text: TEXT } };
  const iframe = new CFIframe();
  const id = crypto.randomUUID();
  iframe.src = reportingGuest(id);
  provider.append(iframe);
  const first = reading(id);
  document.body.append(provider);
  try {
    expect(await first).toEqual({ ink: TEXT, variable: TEXT, heading: TEXT });
    const changed = reading(id);
    provider.theme = { colors: { text: TINT } };
    expect((await changed).ink).toBe(TINT);
  } finally {
    provider.remove();
  }
});

Deno.test("a guest's plain element rules hold in every state against the base sheet", async () => {
  const provider = new CFThemeProvider();
  const iframe = new CFIframe();
  const id = crypto.randomUUID();
  iframe.src = `<style>
      button { color: rgb(1, 2, 3); background: rgb(4, 5, 6); outline: none; }
    </style><button id="b" disabled>x</button><script>
      const states = {};
      function read() {
        const s = getComputedStyle(document.getElementById('b'));
        return [s.color, s.backgroundColor, s.outlineStyle];
      }
      function report() {
        const b = document.getElementById('b');
        states.disabled = read();
        b.disabled = false;
        states.enabled = read();
        b.focus();
        states.focused = read();
        states.based = getComputedStyle(document.body).lineHeight !== 'normal';
        top.postMessage({ id: ${JSON.stringify(id)}, reading: states }, '*');
      }
      globalThis.addEventListener('load', report);
    </script>`;
  provider.append(iframe);
  const first = reading<Record<string, string[] | boolean>>(id);
  document.body.append(provider);
  try {
    const held = ["rgb(1, 2, 3)", "rgb(4, 5, 6)", "none"];
    const states = await first;
    expect(states.based).toBe(true);
    expect(states.disabled).toEqual(held);
    expect(states.enabled).toEqual(held);
    expect(states.focused).toEqual(held);
  } finally {
    provider.remove();
  }
});
