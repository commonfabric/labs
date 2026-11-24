import { expect } from "@std/expect";

import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";

/** Returns the next report from this fixture's guest. */
function report(id: string) {
  return new Promise<Record<string, string>>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.data?.fixture !== id) return;
      globalThis.removeEventListener("message", receive);
      resolve(event.data);
    };
    globalThis.addEventListener("message", receive);
  });
}

/** Returns HTML which reports its effective style and retained input. */
function guest(id: string) {
  return `<!doctype html><html data-skin="authored"><head>
    <noscript><p id="noscript-fallback">Enable scripting</p></noscript>
    <style>body { color: var(--example-ink); }</style></head><body>
    <input value="initial"><script>
    const input = document.querySelector('input');
    const incarnation = Math.random().toString();
    const startupInk = getComputedStyle(document.documentElement).getPropertyValue('--example-ink').trim();
    function report() {
      top.postMessage({fixture: ${JSON.stringify(id)},
        color: getComputedStyle(document.body).color,
        skin: document.documentElement.getAttribute('data-skin'),
        caption: document.documentElement.getAttribute('data-caption'),
        fallback: String(!!document.querySelector('#noscript-fallback')),
        mode: document.compatMode, input: input.value, incarnation, startupInk,
        fontToken: getComputedStyle(document.documentElement).getPropertyValue('--example-font').trim(),
        fonts: document.querySelector('link[rel="stylesheet"]')?.getAttribute('href') ?? ''
      }, '*');
    }
    globalThis.addEventListener('load', () => { report(); input.value = 'edited'; });
    document.addEventListener('common-iframe-presentation', report);
    globalThis.addEventListener('message', event => {
      if (event.data === 'presentation-test-probe') report();
    });
    </script></body></html>`;
}

for (const outerFrameUrl of [undefined, "/outer-frame.html"]) {
  Deno.test(`iframe presentation updates in ${outerFrameUrl ?? "srcdoc"} without replacing the guest`, async () => {
    const id = crypto.randomUUID();
    const element = new CommonIframeSandboxElement();
    element.outerFrameUrl = outerFrameUrl;
    const fontURL = new URL("/presentation.css", location.href).href;
    element.presentation = {
      css: ":root { --example-ink: rgb(12, 34, 56); }",
      attributes: {
        "data-skin": "host",
        "data-caption": "</script><b>text</b>",
      },
      stylesheets: [fontURL],
    };
    element.src = guest(id);
    const first = report(id);
    document.body.append(element);
    try {
      const initial = await first;
      expect(initial.color).toBe("rgb(12, 34, 56)");
      expect(initial.startupInk).toBe("rgb(12, 34, 56)");
      expect(initial.skin).toBe("host");
      expect(initial.caption).toBe("</script><b>text</b>");
      expect(initial.mode).toBe("CSS1Compat");
      expect(initial.fallback).toBe("false");
      expect(initial.fonts).toBe(fontURL);
      expect(initial.fontToken).toBe("fixture");
      const changed = report(id);
      element.presentation = {
        css: ":root { --example-ink: rgb(65, 43, 21); }",
        attributes: { "data-skin": "next" },
        stylesheets: [],
      };
      const next = await changed;
      expect(next.color).toBe("rgb(65, 43, 21)");
      expect(next.skin).toBe("next");
      expect(next.fonts).toBe("");
      expect(next.fontToken).toBe("");
      expect(next.input).toBe("edited");
      expect(next.incarnation).toBe(initial.incarnation);
      const guestWindow = element.accessForTestingOnly.iframeRef.value
        ?.contentWindow
        ?.frames[0];
      expect(guestWindow).toBeDefined();
      const unrelated = report(id);
      guestWindow!.postMessage({ type: "presentation", data: null }, "*");
      guestWindow!.postMessage("presentation-test-probe", "*");
      const afterUnrelated = await unrelated;
      expect(afterUnrelated.skin).toBe("next");
      expect(afterUnrelated.color).toBe(next.color);
      const cleared = report(id);
      element.presentation = null;
      const plain = await cleared;
      expect(plain.skin).toBe("authored");
      expect(plain.color).not.toBe(next.color);
      expect(plain.input).toBe("edited");
      expect(plain.incarnation).toBe(initial.incarnation);
      const reloadedID = crypto.randomUUID();
      const reloaded = report(reloadedID);
      element.src = guest(reloadedID);
      element.presentation = {
        css: ":root { --example-ink: rgb(98, 76, 54); }",
        attributes: { "data-skin": "replacement" },
        stylesheets: [],
      };
      const replacement = await reloaded;
      expect(replacement.color).toBe("rgb(98, 76, 54)");
      expect(replacement.skin).toBe("replacement");
      expect(replacement.incarnation).not.toBe(initial.incarnation);
    } finally {
      element.remove();
    }
  });
}

for (const outerFrameUrl of [undefined, "/outer-frame.html"]) {
  Deno.test(`iframe presentation honors guest meta CSP in ${outerFrameUrl ?? "srcdoc"}`, async () => {
    const id = crypto.randomUUID();
    const element = new CommonIframeSandboxElement();
    element.outerFrameUrl = outerFrameUrl;
    const stylesheet = new URL("/presentation.css", location.href).href;
    element.presentation = {
      css: ":root { --blocked-ink: injected; }",
      attributes: {},
      stylesheets: [stylesheet],
    };
    element.src = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="style-src 'none'; font-src 'none'">
      </head><body><script>
      addEventListener('load', () => {
        const style = getComputedStyle(document.documentElement);
        top.postMessage({fixture: ${JSON.stringify(id)},
          inline: style.getPropertyValue('--blocked-ink').trim(),
          external: style.getPropertyValue('--example-font').trim(),
          requests: String(performance.getEntriesByName(${
      JSON.stringify(stylesheet)
    }).length),
        }, '*');
      });
      </script></body></html>`;
    const loaded = report(id);
    document.body.append(element);
    try {
      const value = await loaded;
      expect(value.inline).toBe("");
      expect(value.external).toBe("");
    } finally {
      element.remove();
    }
  });
}
