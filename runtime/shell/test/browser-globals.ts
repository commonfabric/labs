/**
 * The few browser globals a shell view's module graph reaches as it loads and
 * as a view is constructed, installed over Deno's own so that a test can drive
 * a view without a browser. Nothing here renders: a view built this way is
 * never connected, so Lit never runs an update on it, and a test calls the
 * view's tasks and lifecycle methods itself.
 */

/**
 * Installs each of `values` as the global of that name, and returns a function
 * which restores what they replaced. A test reaches for this directly to stand
 * in for a global that `installBrowserGlobals()` leaves alone, or to replace
 * one of its stand-ins with one the test observes.
 */
export function installGlobals(values: Record<string, unknown>): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(values)) {
    if (!originals.has(name)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/**
 * The base class an element extends under `installBrowserGlobals()`. It holds
 * attributes, classes, and style properties, so that a test can read back what
 * an element's lifecycle method wrote to its host.
 */
class TestHTMLElement extends EventTarget {
  #attributes = new Map<string, string>();
  #classes = new Set<string>();
  #styleProperties = new Map<string, string>();

  /** The classes on the element, as `add()`, `remove()` and `contains()`. */
  get classList(): {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  } {
    const classes = this.#classes;
    return {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }

  /** The inline style, holding the custom properties set on it. */
  get style(): {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
  } {
    const properties = this.#styleProperties;
    return {
      setProperty: (name, value) => properties.set(name, value),
      getPropertyValue: (name) => properties.get(name) ?? "",
    };
  }

  /** Returns a stand-in shadow root, which holds nothing. */
  attachShadow() {
    return {
      adoptedStyleSheets: [],
      appendChild() {},
      append() {},
    };
  }

  /** Returns whether the element has the attribute `name`. */
  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }

  /**
   * Adds the attribute `name` with an empty value where `force` is true, and
   * removes it where `force` is false; without `force`, flips its presence.
   * Returns whether the element has the attribute afterwards.
   */
  toggleAttribute(name: string, force?: boolean): boolean {
    const present = force ?? !this.#attributes.has(name);
    if (present) this.#attributes.set(name, this.#attributes.get(name) ?? "");
    else this.#attributes.delete(name);
    return present;
  }
}

/**
 * Installs the stand-in browser globals, with `href` as the page's location,
 * and returns a function which restores what they replaced. The
 * `customElements` stand-in records each definition, so that `get()` returns
 * the class a module defined under a name.
 */
export function installBrowserGlobals(href: string): () => void {
  const definitions = new Map<string, CustomElementConstructor>();
  const url = new URL(href);
  return installGlobals({
    window: globalThis,
    HTMLElement: TestHTMLElement,
    customElements: {
      define(name: string, constructor: CustomElementConstructor) {
        definitions.set(name, constructor);
      },
      get: (name: string) => definitions.get(name),
      whenDefined: () => Promise.resolve(),
    },
    document: {
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
    },
    devicePixelRatio: 1,
    screen: { deviceXDPI: 1, logicalXDPI: 1 },
    navigator: { platform: "", userAgent: "deno" },
    location: {
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      href: url.href,
    },
  });
}
