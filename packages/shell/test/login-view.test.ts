import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { Identity } from "@commonfabric/identity";

import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
} from "../src/lib/credentials.ts";
import type { XLoginView } from "../src/views/LoginView.ts";

type LoginView = InstanceType<typeof XLoginView> & Record<string, unknown>;

type TemplateResultLike = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

function installBrowserGlobals(): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();

  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  class TestHTMLElement extends EventTarget {}

  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
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
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/common-knowledge",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}

function templateText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return "";

  const result = value as TemplateResultLike;
  return [
    ...(result.strings ?? []),
    ...((result.values ?? []).map(templateText)),
  ].join("");
}

function renderText(view: LoginView): string {
  return templateText(view.render());
}

function setState(
  view: LoginView,
  state: Record<string, unknown>,
): LoginView {
  Object.assign(view, state);
  return view;
}

Deno.test("login view renders each key store ready state", async () => {
  const restore = installBrowserGlobals();
  try {
    // The view's module graph reaches @commonfabric/ui, whose components
    // extend a bare HTMLElement as they load, so it can only load once the
    // test has installed one.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { XLoginView } = await import("../src/views/LoginView.ts");
    const keyStore = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(undefined),
      clear: () => Promise.resolve(undefined),
    };

    const view = (state: Record<string, unknown> = {}) =>
      setState(new XLoginView() as LoginView, {
        keyStore,
        storedCredential: null,
        ...state,
      });

    const waitingForKeyStore = renderText(
      setState(new XLoginView() as LoginView, { storedCredential: null }),
    );
    assertStringIncludes(waitingForKeyStore, "Preparing secure storage...");
    assert(!waitingForKeyStore.includes('test-id="register-new-key"'));

    assertStringIncludes(
      renderText(view({ error: "Nope" })),
      '<div class="error">',
    );
    assertStringIncludes(
      renderText(view({ isProcessing: true })),
      "Please follow the browser's prompts to continue...",
    );
    assertStringIncludes(
      renderText(view({ mnemonic: "alpha beta gamma" })),
      "Your Secret Recovery Phrase:",
    );
    assertStringIncludes(
      renderText(view({ registrationSuccess: true })),
      "successfully registered!",
    );
    assertStringIncludes(
      renderText(view()),
      'test-id="register-new-key"',
    );
    assertStringIncludes(
      renderText(view({ flow: "register", method: null })),
      "Register with",
    );
    assertStringIncludes(
      renderText(view({
        flow: "register",
        method: AUTH_METHOD_PASSPHRASE,
      })),
      'test-id="generate-passphrase"',
    );
    assertStringIncludes(
      renderText(view({
        flow: "register",
        method: AUTH_METHOD_KEYFILE,
      })),
      "Import Key",
    );
    assertStringIncludes(
      renderText(view({
        flow: "register",
        method: AUTH_METHOD_PASSKEY,
      })),
      "Please follow the browser's prompts to continue...",
    );
    assertStringIncludes(
      renderText(view({ flow: "login", method: null })),
      "Pair with Loom",
    );
    assert(
      !renderText(view({ flow: "register", method: null }))
        .includes("Pair with Loom"),
    );
    const pairing = renderText(view({ flow: "login", method: "loom-pairing" }));
    assertStringIncludes(pairing, 'name="pairing-code"');
    assertStringIncludes(pairing, "http://localhost:9900");
    assertStringIncludes(
      renderText(view({
        flow: "login",
        method: "loom-pairing",
        pairingError: "That code did not pair this device.",
      })),
      "That code did not pair this device.",
    );
    assertStringIncludes(
      renderText(view({ method: "loom-pairing", isProcessing: true })),
      "Pairing with Loom...",
    );
  } finally {
    restore();
  }
});

/** The functions a template holds, event handlers among them, in order. */
function functionsOf(value: unknown): Array<(...args: unknown[]) => unknown> {
  if (typeof value === "function") {
    return [value as (...args: unknown[]) => unknown];
  }
  if (value == null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(functionsOf);
  return ((value as TemplateResultLike).values ?? []).flatMap(functionsOf);
}

/** A submit event from a form holding `fields`. */
function submitEvent(fields: Record<string, string>) {
  return {
    preventDefault() {},
    target: {
      elements: {
        namedItem: (name: string) =>
          name in fields ? { value: fields[name] } : null,
      },
    },
  };
}

/**
 * Installs a `fetch` that returns `response` and records request bodies, and a
 * `localStorage` held in memory, for the length of `body`.
 */
async function withLoomAndStorage(
  response: () => Response,
  body: (
    ctx: { requests: string[]; storage: Map<string, string> },
  ) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const storage = new Map<string, string>();
  const originals = ["fetch", "localStorage"].map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  const set = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  set("fetch", (_url: unknown, init?: RequestInit) => {
    requests.push(String(init?.body ?? ""));
    return Promise.resolve(response());
  });
  set("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  try {
    await body({ requests, storage });
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

Deno.test("login view signs in as the identity a Loom pairing code redeems", async () => {
  const restore = installBrowserGlobals();
  try {
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { XLoginView } = await import("../src/views/LoginView.ts");
    const pkcs8 = await Identity.generatePkcs8();
    const did = (await Identity.fromPkcs8(pkcs8)).did();
    const pkcs8Base64 = btoa(String.fromCharCode(...pkcs8));

    await withLoomAndStorage(
      () => new Response(JSON.stringify({ pkcs8Base64, did })),
      async ({ requests, storage }) => {
        const stored = new Map<string, Identity>();
        const view = setState(new XLoginView() as LoginView, {
          keyStore: {
            get: () => Promise.resolve(undefined),
            set: (name: string, identity: Identity) => {
              stored.set(name, identity);
              return Promise.resolve();
            },
            clear: () => Promise.resolve(),
          },
          storedCredential: null,
          flow: "login",
          method: "loom-pairing",
        });
        const commands: { type: string; identity?: Identity }[] = [];
        view.addEventListener(
          "shell-command",
          (e) => commands.push((e as CustomEvent).detail),
        );
        const [submit] = functionsOf(view.render());

        await submit(submitEvent({
          "pairing-code": "7kq2m xh4rd",
          "loom-url": "http://127.0.0.1:9950/",
        }));

        assertEquals(JSON.parse(requests[0]).code, "7KQ2MXH4RD");
        assertEquals(stored.get("$ROOT_KEY")?.did(), did);
        assertEquals(commands.map((c) => [c.type, c.identity?.did()]), [
          ["set-identity", did],
        ]);
        assertEquals(JSON.parse(storage.get("storedCredential") ?? "null"), {
          id: did,
          method: AUTH_METHOD_KEYFILE,
        });
      },
    );
  } finally {
    restore();
  }
});

Deno.test("login view opens the Loom pairing form from a saved credential", async () => {
  const restore = installBrowserGlobals();
  try {
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { XLoginView } = await import("../src/views/LoginView.ts");
    const view = setState(new XLoginView() as LoginView, {
      keyStore: {
        get: () => Promise.resolve(undefined),
        set: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      storedCredential: {
        id: "did:key:z6Mkstored",
        method: AUTH_METHOD_KEYFILE,
      },
    });
    // Quick unlock, forget, passphrase login, pair, register: pairing is the
    // fourth control on the saved-credential screen.
    const initial = view.render();
    assertStringIncludes(templateText(initial), "Pair with Loom");
    functionsOf(initial)[3]();
    assertStringIncludes(renderText(view), 'name="pairing-code"');
  } finally {
    restore();
  }
});

Deno.test("login view shows why a Loom pairing did not sign in", async () => {
  const restore = installBrowserGlobals();
  try {
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { XLoginView } = await import("../src/views/LoginView.ts");
    await withLoomAndStorage(
      () =>
        new Response(JSON.stringify({ hint: "Make a new code." }), {
          status: 403,
        }),
      async ({ requests }) => {
        const stored: string[] = [];
        const view = setState(new XLoginView() as LoginView, {
          keyStore: {
            get: () => Promise.resolve(undefined),
            set: (name: string) => {
              stored.push(name);
              return Promise.resolve();
            },
            clear: () => Promise.resolve(),
          },
          storedCredential: null,
          flow: "login",
          method: "loom-pairing",
        });
        const [submit] = functionsOf(view.render());
        const loomUrl = "http://127.0.0.1:9950";

        await submit(
          submitEvent({ "pairing-code": "nope", "loom-url": loomUrl }),
        );
        assertStringIncludes(renderText(view), "ten letters");

        await submit(
          submitEvent({ "pairing-code": "7KQ2M-XH4RD", "loom-url": "ftp://x" }),
        );
        assertStringIncludes(renderText(view), "Loom's address");
        assertEquals(requests, []);

        await submit(
          submitEvent({ "pairing-code": "7KQ2M-XH4RD", "loom-url": loomUrl }),
        );
        const shown = renderText(view);
        assertStringIncludes(shown, "Make a new code.");
        assert(!shown.includes("Pairing with Loom..."));

        // Back leaves the form, and takes its error with it.
        functionsOf(view.render()).at(-1)!();
        const initial = renderText(view);
        assertStringIncludes(initial, 'test-id="register-new-key"');
        assert(!initial.includes("Make a new code."));
        assertEquals(stored, []);
      },
    );
  } finally {
    restore();
  }
});
