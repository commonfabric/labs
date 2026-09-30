import { assert, assertStringIncludes } from "@std/assert";
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
