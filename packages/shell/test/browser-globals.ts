/**
 * The few browser globals a shell view's module graph reaches as it loads and
 * as a view is constructed, installed over Deno's own so that a test can drive
 * a view without a browser. Nothing here renders: a view built this way is
 * never connected, so Lit never runs an update on it, and a test calls the
 * view's tasks and lifecycle methods itself.
 */

/**
 * Installs the stand-in browser globals, with `href` as the page's location,
 * and returns a function which restores what they replaced.
 */
export function installBrowserGlobals(href: string): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  class TestHTMLElement extends EventTarget {
    attachShadow() {
      return {
        adoptedStyleSheets: [],
        appendChild() {},
        append() {},
      };
    }
  }
  const url = new URL(href);
  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    href: url.href,
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}
