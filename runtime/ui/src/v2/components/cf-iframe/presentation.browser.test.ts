import { expect } from "@std/expect";
import { ContextProvider } from "@lit/context";

import { CFIframe, iframePresentationContext } from "./index.ts";

/** Returns the next presentation reported by the fixture's guest. */
function report(id: string) {
  return new Promise<string>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      globalThis.removeEventListener("message", receive);
      resolve(event.data.ink);
    };
    globalThis.addEventListener("message", receive);
  });
}

Deno.test("cf-iframe inherits live presentation across a shadow root and supports opting out", async () => {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const provider = new ContextProvider(host, {
    context: iframePresentationContext,
    initialValue: {
      css: ":root { --example-ink: first; }",
      attributes: {},
      stylesheets: [],
    },
  });
  const element = new CFIframe();
  const id = crypto.randomUUID();
  element.src = `<script>
      function report() {
        top.postMessage({id: ${JSON.stringify(id)},
          ink: getComputedStyle(document.documentElement).getPropertyValue('--example-ink').trim()
        }, '*');
      }
      globalThis.addEventListener('load', report);
      document.addEventListener('common-iframe-presentation', report);
    </script>`;
  shadow.append(element);
  const first = report(id);
  document.body.append(host);
  try {
    expect(await first).toBe("first");
    const changed = report(id);
    provider.setValue({
      css: ":root { --example-ink: next; }",
      attributes: {},
      stylesheets: [],
    });
    expect(await changed).toBe("next");
    const overridden = report(id);
    element.presentation = {
      css: ":root { --example-ink: explicit; }",
      attributes: {},
      stylesheets: [],
    };
    expect(await overridden).toBe("explicit");
    provider.setValue({
      css: ":root { --example-ink: latest; }",
      attributes: {},
      stylesheets: [],
    });
    const cleared = report(id);
    element.presentation = null;
    expect(await cleared).toBe("");
    const inherited = report(id);
    element.presentation = undefined;
    expect(await inherited).toBe("latest");
  } finally {
    host.remove();
  }
});
