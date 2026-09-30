import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import {
  consumeDeviceLinkFragment,
  looksLikeDeviceLink,
  parseDeviceLinkFragment,
} from "../src/lib/device-link.ts";
import {
  confirmWithUser,
  handleDeviceLink,
  reportDeviceLinkFailure,
  runDeviceLinkLogin,
} from "../src/lib/device-link-login.ts";
import {
  activateModalDialog,
  XDeviceLinkView,
} from "../src/views/DeviceLinkView.ts";

// NOTE: this file lives in test/ deliberately. The shell's test task globs
// `test/*.test.ts` ONLY — a co-located src/lib/*.test.ts is silently never run,
// and the verify step would pass with zero coverage.

/** Unpadded base64url, the QR payload encoding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

const ZERO_ENTROPY = new Uint8Array(32);
// The all-zero BIP39 entropy vector, pinned in the identity package too.
const ZERO_ENTROPY_DID =
  "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";

// A deliberately ASYMMETRIC vector (0x00..0x1f). The all-zero vector is a fixed
// point of reversal, rotation and XOR-with-zero, so pinning ONLY against it
// lets a whole class of byte-mangling bugs through — a mutation reversing the
// seed passed the entire suite when this was the only vector.
const COUNTING_ENTROPY = new Uint8Array(
  Array.from({ length: 32 }, (_, i) => i),
);
const COUNTING_ENTROPY_DID =
  "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";

describe("parseDeviceLinkFragment", () => {
  it("decodes a well-formed device link to 32 bytes", () => {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(entropy));
    assert(parsed);
    assertEquals(parsed, entropy);
  });

  it("accepts the all-zero vector", () => {
    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(ZERO_ENTROPY));
    assertEquals(parsed, ZERO_ENTROPY);
  });

  it("rejects anything that is not exactly a device link", () => {
    const valid = toBase64Url(ZERO_ENTROPY);
    for (
      const hash of [
        "",
        "#",
        "#foo=bar",
        "#kk=" + valid,
        "#k=", // empty payload
        "#k=" + valid.slice(0, 42), // too short
        "#k=" + valid + "A", // too long
        "#k=" + valid.slice(0, 42) + "+", // non-base64url character
        "#k=" + valid.slice(0, 42) + "=", // padded
        "#k=" + valid.slice(0, 42) + " ", // whitespace
        "?k=" + valid, // query, not fragment
      ]
    ) {
      assertEquals(
        parseDeviceLinkFragment(hash),
        null,
        `should have rejected: ${JSON.stringify(hash)}`,
      );
    }
  });

  it("is pure — a rejected hash is simply null, never a throw", () => {
    assertEquals(parseDeviceLinkFragment("#k=" + "!".repeat(43)), null);
  });
});

describe("looksLikeDeviceLink", () => {
  it("is true for malformed payloads too, so they still get scrubbed", () => {
    // A malformed payload is still somebody's secret; leaving it in the
    // address bar to be bookmarked or synced is the leak with none of the win.
    assert(looksLikeDeviceLink("#k=garbage"));
    assert(!looksLikeDeviceLink("#other"));
  });
});

/** Origin of the fake documents the location stand-ins describe. */
const ORIGIN = "https://shell.test";

/**
 * A `history.replaceState` stand-in: it resolves its argument against the
 * document URL as a browser does, refuses a cross-origin result with a
 * `SecurityError`, and records what the address bar would then hold. Modeling
 * the origin check is what lets a test see a scrub a browser would refuse; it
 * models nothing else about a history, the session entry included.
 */
function fakeReplaceState(documentHref: string, replaced: string[]) {
  return (_state: unknown, _title: string, url: string) => {
    const resolved = new URL(url, documentHref);
    if (resolved.origin !== new URL(documentHref).origin) {
      throw new DOMException(
        `A history state object with URL '${resolved.href}' cannot be created ` +
          `in a document with origin '${new URL(documentHref).origin}'.`,
        "SecurityError",
      );
    }
    replaced.push(resolved.href);
  };
}

describe("consumeDeviceLinkFragment", () => {
  // Minimal stand-ins: the real ones are read straight off globalThis.
  function withLocation(
    hash: string,
    pathname = "/loom-jun-12/home",
    search = "",
  ) {
    const replaced: string[] = [];
    const href = ORIGIN + pathname + search + hash;
    const originalLocation = globalThis.location;
    const originalHistory = globalThis.history;
    Object.defineProperty(globalThis, "location", {
      value: { hash, pathname, search, href },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "history", {
      value: { replaceState: fakeReplaceState(href, replaced) },
      configurable: true,
      writable: true,
    });
    const restore = () => {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "history", {
        value: originalHistory,
        configurable: true,
        writable: true,
      });
    };
    return { replaced, restore };
  }

  it("returns the entropy and scrubs the fragment", () => {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const ctx = withLocation("#k=" + toBase64Url(entropy));
    try {
      assertEquals(consumeDeviceLinkFragment(), {
        kind: "entropy",
        entropy,
      });
      assertEquals(ctx.replaced, [ORIGIN + "/loom-jun-12/home"]);
    } finally {
      ctx.restore();
    }
  });

  it("preserves pathname and search when scrubbing", () => {
    // Load-bearing, not cosmetic: the QR targets a deep link, and the boot must
    // continue to that path so the flow ends inside a logged-in app the user
    // bookmarks. The scrubbed URL is exactly what gets bookmarked.
    const ctx = withLocation(
      "#k=" + toBase64Url(ZERO_ENTROPY),
      "/loom-jun-12/home",
      "?ref=qr",
    );
    try {
      consumeDeviceLinkFragment();
      assertEquals(ctx.replaced, [ORIGIN + "/loom-jun-12/home?ref=qr"]);
    } finally {
      ctx.restore();
    }
  });

  it("removes the fragment from a path beginning `//`, keeping path and query", () => {
    // `replaceState` resolves what it is handed as a relative reference, and a
    // path beginning `//` is a protocol-relative URL there:
    // `//loom-jun-12/top/42` resolves to `https://loom-jun-12/top/42`, which a
    // browser refuses as cross-origin. The scrub has to reach the address bar
    // on such a path, or the secret stays there for a bookmark or a tab-sync to
    // capture — and `consumeDeviceLinkFragment` catches the refusal, so a
    // failure to reach it is silent.
    const ctx = withLocation(
      "#k=" + toBase64Url(ZERO_ENTROPY),
      "//loom-jun-12/top/42",
      "?ref=qr",
    );
    try {
      expect(consumeDeviceLinkFragment()).toEqual({
        kind: "entropy",
        entropy: ZERO_ENTROPY,
      });
      expect(ctx.replaced).toEqual([
        ORIGIN + "//loom-jun-12/top/42?ref=qr",
      ]);
    } finally {
      ctx.restore();
    }
  });

  it("scrubs even when the payload is malformed", () => {
    const ctx = withLocation("#k=not-valid-entropy");
    try {
      // "malformed", NOT "absent": the scrub already removed it, so the
      // documented "refresh once and rescan" recovery cannot work and the
      // failure has to be surfaced rather than booting as if nothing happened.
      assertEquals(consumeDeviceLinkFragment(), { kind: "malformed" });
      assertEquals(ctx.replaced, [ORIGIN + "/loom-jun-12/home"]);
    } finally {
      ctx.restore();
    }
  });

  it("leaves unrelated fragments completely alone", () => {
    const ctx = withLocation("#some-anchor");
    try {
      assertEquals(consumeDeviceLinkFragment(), { kind: "absent" });
      assertEquals(ctx.replaced, []);
    } finally {
      ctx.restore();
    }
  });

  it("refuses to act inside a frame, but still scrubs", () => {
    // The parent controls a framed shell's URL, so acting on `#k=` there would
    // be a one-click identity swap the user can't see the address bar for.
    // Report absent — but the secret is scrubbed anyway, per the file's policy.
    const ctx = withLocation("#k=" + toBase64Url(ZERO_ENTROPY));
    const originalTop = Object.getOwnPropertyDescriptor(globalThis, "top");
    Object.defineProperty(globalThis, "top", {
      value: {}, // distinct from globalThis (=self) → looks framed
      configurable: true,
      writable: true,
    });
    try {
      assertEquals(consumeDeviceLinkFragment(), { kind: "absent" });
      assertEquals(
        ctx.replaced,
        [ORIGIN + "/loom-jun-12/home"],
        "must scrub even framed",
      );
    } finally {
      if (originalTop) Object.defineProperty(globalThis, "top", originalTop);
      else Reflect.deleteProperty(globalThis, "top");
      ctx.restore();
    }
  });
});

describe("device-link derivation", () => {
  it("derives the pinned DID from the all-zero entropy vector", async () => {
    // Pins that the shell and the pairing device agree on the derivation. If
    // this DID ever moves, a scanned code signs the phone in as somebody else.
    const identity = await Identity.fromRaw(ZERO_ENTROPY);
    assertEquals(identity.did(), ZERO_ENTROPY_DID);
  });

  it("derives the pinned DID from an ASYMMETRIC vector", async () => {
    // The all-zero vector alone is worthless as a pin: it survives reversal,
    // rotation and XOR-with-zero unchanged, so a seed-mangling bug passes.
    // This vector does not.
    const identity = await Identity.fromRaw(COUNTING_ENTROPY);
    assertEquals(identity.did(), COUNTING_ENTROPY_DID);
  });

  it("byte order matters — a reversed seed is a different identity", async () => {
    const reversed = new Uint8Array([...COUNTING_ENTROPY].reverse());
    const forward = await Identity.fromRaw(COUNTING_ENTROPY);
    const backward = await Identity.fromRaw(reversed);
    assert(
      forward.did() !== backward.did(),
      "reversal must change the identity, or the pins above prove nothing",
    );
  });

  it("rejects any entropy length but 32", async () => {
    for (const length of [0, 16, 31, 33, 64]) {
      let threw = false;
      try {
        await Identity.fromRaw(new Uint8Array(length));
      } catch {
        threw = true;
      }
      assert(
        threw,
        `length ${length} must be rejected, not silently truncated`,
      );
    }
  });

  it("round-trips a fragment to the identity it names", async () => {
    // The whole path a scan takes: entropy -> QR text -> fragment -> identity.
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const expected = await Identity.fromRaw(entropy);

    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(entropy));
    assert(parsed);
    assertEquals((await Identity.fromRaw(parsed)).did(), expected.did());
  });

  it("produces a payload that fits the pairing QR's byte budget", () => {
    // The encoder driving the Pair screen's QR caps at 106 bytes, and the
    // hosted deep-link target is already 54 of them. 43 chars is what makes
    // the whole flow fit without touching the encoder.
    const encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    assertEquals(encoded.length, 43);
    assertEquals(new TextEncoder().encode("#k=" + encoded).length, 46);
  });
});

describe("runDeviceLinkLogin", () => {
  /** In-memory stand-in for the IndexedDB-backed KeyStore. */
  function fakeKeyStore(initial?: Identity) {
    const entries = new Map<string, Identity>();
    if (initial) entries.set("$ROOT_KEY", initial);
    return {
      store: {
        // deno-lint-ignore require-await
        get: async (name: string) => entries.get(name),
        // deno-lint-ignore require-await
        set: async (name: string, value: Identity) => {
          entries.set(name, value);
        },
        // deno-lint-ignore no-explicit-any
      } as any,
      entries,
    };
  }

  it("stores the new identity when confirmed", async () => {
    const { store, entries } = fakeKeyStore();
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(true),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "accepted");
    assertEquals(entries.get("$ROOT_KEY")?.did(), ZERO_ENTROPY_DID);
  });

  it("does not touch the KeyStore when the user cancels", async () => {
    const existing = await Identity.fromRaw(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { store, entries } = fakeKeyStore(existing);
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(false),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "cancelled");
    assertEquals(entries.get("$ROOT_KEY")?.did(), existing.did());
  });

  it("REPLACES a different existing identity when confirmed", async () => {
    // The case a LoginView-only handler would silently no-op on, and the one
    // App.setIdentity refuses outright ("Cannot change identity while logged
    // in") — which is why this writes ROOT_KEY directly, pre-initializeKeys.
    const stale = await Identity.fromRaw(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { store, entries } = fakeKeyStore(stale);
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(true),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "accepted");
    assertEquals(entries.get("$ROOT_KEY")?.did(), ZERO_ENTROPY_DID);
  });

  it("shows BOTH DIDs to the confirm gate when replacing", async () => {
    // The confirm screen is the ONLY defense against a donated-identity link,
    // so it must be handed the DIDs a user can cross-check against the Pair
    // screen — not a truncation or a placeholder.
    const stale = await Identity.fromRaw(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { store } = fakeKeyStore(stale);
    let seen: [string, string | null] | null = null;
    await runDeviceLinkLogin(
      ZERO_ENTROPY,
      (incoming, current) => {
        seen = [incoming, current];
        return Promise.resolve(false);
      },
      () => Promise.resolve(store),
    );
    assertEquals(seen, [ZERO_ENTROPY_DID, stale.did()]);
  });

  it("passes a null current DID on a fresh device", async () => {
    const { store } = fakeKeyStore();
    let current: string | null | undefined;
    await runDeviceLinkLogin(
      ZERO_ENTROPY,
      (_incoming, currentDid) => {
        current = currentDid;
        return Promise.resolve(false);
      },
      () => Promise.resolve(store),
    );
    assertEquals(current, null);
  });

  it("re-scanning the same code is a no-op, reported as already-signed-in", async () => {
    // Distinct from "accepted" on purpose: the hashchange caller reloads only
    // on "accepted", so a no-op re-scan must NOT report it, or the page would
    // pointlessly flash-reload.
    const same = await Identity.fromRaw(ZERO_ENTROPY);
    const { store, entries } = fakeKeyStore(same);
    let wrote = false;
    store.set = () => {
      wrote = true;
      return Promise.resolve();
    };
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(true),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "already-signed-in");
    assert(!wrote, "should not churn the stored key when nothing changed");
    assertEquals(entries.get("$ROOT_KEY")?.did(), ZERO_ENTROPY_DID);
  });

  it("reports invalid entropy without prompting or opening the store", async () => {
    let prompted = false;
    let opened = false;
    const outcome = await runDeviceLinkLogin(
      new Uint8Array(3), // not a valid ed25519 seed
      () => {
        prompted = true;
        return Promise.resolve(true);
      },
      () => {
        opened = true;
        return Promise.resolve(fakeKeyStore().store);
      },
    );
    assertEquals(outcome, "invalid");
    assert(!prompted, "must not prompt for undecodable entropy");
    assert(!opened, "must not open the KeyStore for undecodable entropy");
  });
});

//
// the confirm gate itself
//
// Previously uncovered: every test above injects its own `confirm`, so the
// production path and the whole view were unexercised. Two mutations passed the
// entire suite as a result — `confirmWithUser` hardcoded to true, and the Cancel
// button rewired to accept. For the screen the design calls the only defense
// against a donated-identity link, those are the mutations that matter most.
//
// Follows the repo's view-test idiom (see login-view.test.ts): install fake
// browser globals, instantiate the element, and inspect what render() produces.
//

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
    body: { appendChild() {} },
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
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

// deno-lint-ignore no-explicit-any
function templateText(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return "";
  return [
    ...(value.strings ?? []),
    ...((value.values ?? []).map(templateText)),
  ].join("");
}

/** Click handlers in template order: [accept, cancel]. */
// deno-lint-ignore no-explicit-any
function handlersOf(value: any): Array<() => void> {
  if (value == null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(handlersOf);
  const out: Array<() => void> = [];
  for (const v of value.values ?? []) {
    if (typeof v === "function") out.push(v as () => void);
    else out.push(...handlersOf(v));
  }
  return out;
}

describe("DeviceLinkView", () => {
  function makeView(state: Record<string, unknown>) {
    const view = new XDeviceLinkView();
    // `guarded` defaults true (tap-through protection); tests opt out unless
    // they are specifically exercising the guard.
    Object.assign(view, { guarded: false, ...state });
    const answers: boolean[] = [];
    view.addEventListener(
      "device-link-result",
      (e) => answers.push(Boolean((e as CustomEvent).detail?.accepted)),
    );
    return { view, answers };
  }

  it("shows the incoming DID verbatim so it can be cross-checked", () => {
    const restore = installBrowserGlobals();
    try {
      const { view } = makeView({ incomingDid: COUNTING_ENTROPY_DID });
      const text = templateText(view.render());
      assert(
        text.includes(COUNTING_ENTROPY_DID),
        "the full DID must be on screen, not truncated",
      );
      assert(
        text.includes("Pair screen"),
        "anti-phishing copy must be present",
      );
    } finally {
      restore();
    }
  });

  it("shows BOTH DIDs and replace wording when replacing", () => {
    const restore = installBrowserGlobals();
    try {
      const { view } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        currentDid: ZERO_ENTROPY_DID,
      });
      const text = templateText(view.render());
      assert(text.includes(COUNTING_ENTROPY_DID));
      assert(text.includes(ZERO_ENTROPY_DID));
      assert(text.includes("Replace"), "must say it replaces an identity");
    } finally {
      restore();
    }
  });

  it("CANCEL answers no — the button wiring, not just finish()", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
      });
      const handlers = handlersOf(view.render());
      assertEquals(
        handlers.length,
        2,
        "expected an accept and a cancel handler",
      );
      const [, cancel] = handlers;
      cancel();
      assertEquals(answers, [false], "Cancel must answer NO");
    } finally {
      restore();
    }
  });

  it("the primary button answers yes", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
      });
      handlersOf(view.render())[0]();
      assertEquals(answers, [true]);
    } finally {
      restore();
    }
  });

  it("ignores an accept that lands inside the tap-through guard", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        guarded: true, // as it is for the first moments on screen
      });
      handlersOf(view.render())[0]();
      assertEquals(answers, [], "a tap in flight must not accept");
    } finally {
      restore();
    }
  });

  it("still allows CANCEL during the guard", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        guarded: true,
      });
      handlersOf(view.render())[1]();
      assertEquals(answers, [false], "the guard must never trap the user");
    } finally {
      restore();
    }
  });

  it("answers exactly once, even on a double tap", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
      });
      const [accept, cancel] = handlersOf(view.render());
      accept();
      cancel();
      accept();
      assertEquals(answers, [true], "only the first answer counts");
    } finally {
      restore();
    }
  });

  it("the already-signed-in screen cannot answer anything but yes", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        currentDid: COUNTING_ENTROPY_DID,
      });
      const text = templateText(view.render());
      assert(text.includes("Already signed in"));
      handlersOf(view.render())[0]();
      assertEquals(answers, [true]);
    } finally {
      restore();
    }
  });

  it("the failure screen explains why a refresh will not help", () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = makeView({ failure: "unreadable" });
      const text = templateText(view.render());
      assert(text.includes("could not be read"));
      // The scrub has already removed the code, so the design's documented
      // "refresh once and rescan" cannot work — the copy must say so.
      // Whitespace-normalized: the template is line-wrapped by the formatter.
      assert(
        text.replace(/\s+/g, " ").includes("Reloading this page will not help"),
        text,
      );
      handlersOf(view.render())[0]();
      assertEquals(answers, [false], "the failure screen never accepts");
    } finally {
      restore();
    }
  });
});

describe("confirmWithUser (the production confirm path)", () => {
  it("resolves false when the view answers no", async () => {
    const restore = installBrowserGlobals();
    try {
      // A stand-in element that the real confirmWithUser can drive.
      class FakeView extends EventTarget {
        incomingDid = "";
        currentDid: string | null = null;
        failure: string | null = null;
        remove() {}
      }
      const created: FakeView[] = [];
      // deno-lint-ignore no-explicit-any
      (globalThis as any).document.createElement = () => {
        const el = new FakeView();
        created.push(el);
        return el;
      };
      const pending = confirmWithUser(COUNTING_ENTROPY_DID, null);
      const el = created[0];
      assertEquals(el.incomingDid, COUNTING_ENTROPY_DID);
      el.dispatchEvent(
        new CustomEvent("device-link-result", { detail: { accepted: false } }),
      );
      assertEquals(await pending, false);
    } finally {
      restore();
    }
  });

  it("resolves true only when the view says so", async () => {
    const restore = installBrowserGlobals();
    try {
      class FakeView extends EventTarget {
        incomingDid = "";
        currentDid: string | null = null;
        remove() {}
      }
      const created: FakeView[] = [];
      // deno-lint-ignore no-explicit-any
      (globalThis as any).document.createElement = () => {
        const el = new FakeView();
        created.push(el);
        return el;
      };
      const pending = confirmWithUser(COUNTING_ENTROPY_DID, ZERO_ENTROPY_DID);
      assertEquals(created[0].currentDid, ZERO_ENTROPY_DID);
      created[0].dispatchEvent(
        new CustomEvent("device-link-result", { detail: { accepted: true } }),
      );
      assertEquals(await pending, true);
    } finally {
      restore();
    }
  });
});

//
// the modal activation seam
//
// firstUpdated's imperative DOM work runs only against a real DOM, so the
// browser-behavior mutations (Escape rewired to accept, showModal never
// called, cancel listener never attached) previously ALL survived — the unit
// tests stub document.body.appendChild to a no-op, so the element never
// connects and firstUpdated never fires. `activateModalDialog` is extracted so
// exactly those rules can be pinned against a fake dialog, no browser needed.
//

/** Records what the component does to a dialog. */
function fakeDialog(
  opts: { hasShowModal?: boolean; showModalThrows?: boolean } = {},
) {
  const calls: string[] = [];
  let cancelListener: ((e: Event) => void) | undefined;
  const dialog = {
    showModal: opts.hasShowModal === false ? undefined : () => {
      calls.push("showModal");
      if (opts.showModalThrows) throw new Error("unsupported");
    },
    setAttribute: (name: string, value: string) => {
      calls.push(`setAttribute:${name}=${value}`);
    },
    addEventListener: (type: string, listener: (e: Event) => void) => {
      calls.push(`listen:${type}`);
      if (type === "cancel") cancelListener = listener;
    },
  };
  return {
    dialog,
    calls,
    fireCancel: () => cancelListener?.(new Event("cancel")),
  };
}

describe("activateModalDialog", () => {
  it("shows the dialog modally and wires the cancel signal", () => {
    const { dialog, calls } = fakeDialog();
    activateModalDialog(dialog, () => {});
    assert(calls.includes("showModal"), "must open the top layer");
    assert(calls.includes("listen:cancel"), "must wire the cancel signal");
  });

  it("Escape (a cancel event) resolves to NO, never a silent accept", () => {
    const { dialog, fireCancel } = fakeDialog();
    let answer: boolean | undefined;
    activateModalDialog(dialog, () => (answer = false));
    fireCancel();
    assertEquals(answer, false);
  });

  it("falls back to a VISIBLE dialog when showModal is unsupported", () => {
    // A <dialog> with no `open` is display:none — on old iOS this would be an
    // invisible, un-dismissable hang. The open attribute makes it show.
    const { dialog, calls } = fakeDialog({ hasShowModal: false });
    activateModalDialog(dialog, () => {});
    assert(
      calls.includes("setAttribute:open="),
      "must force the dialog visible when showModal is missing",
    );
  });

  it("falls back to a visible dialog when showModal THROWS", () => {
    const { dialog, calls } = fakeDialog({ showModalThrows: true });
    activateModalDialog(dialog, () => {});
    assert(calls.includes("showModal"), "tries the top layer first");
    assert(
      calls.includes("setAttribute:open="),
      "then degrades to visible non-modal rather than hanging",
    );
  });

  it("is a no-op on a missing dialog rather than throwing", () => {
    activateModalDialog(null, () => {
      throw new Error("onCancel must not fire for a null dialog");
    });
  });
});

describe("firstUpdated wiring (component-level, via a stubbed shadow root)", () => {
  /** Stub the shadow root so firstUpdated runs without a real DOM. */
  function withStubbedRoot(
    view: { renderRoot?: unknown },
    dialog: unknown,
    autofocus: unknown = null,
  ) {
    Object.defineProperty(view, "renderRoot", {
      value: {
        querySelector: (sel: string) => sel === "dialog" ? dialog : autofocus,
      },
      configurable: true,
    });
  }

  it("wires the dialog's cancel (Escape) to a NO answer, not accept", () => {
    // M1: the highest-stakes mutation — Escape rewired to accept a donated
    // identity. The seam test proves cancel→onCancel; this proves the COMPONENT
    // passes finish(false) as onCancel, closing the loop.
    const restore = installBrowserGlobals();
    try {
      const view = new XDeviceLinkView();
      Object.assign(view, { guarded: false });
      const answers: boolean[] = [];
      view.addEventListener(
        "device-link-result",
        (e) => answers.push(Boolean((e as CustomEvent).detail?.accepted)),
      );
      let cancelListener: ((e: Event) => void) | undefined;
      const dialog = {
        showModal: () => {},
        setAttribute: () => {},
        addEventListener: (type: string, cb: (e: Event) => void) => {
          if (type === "cancel") cancelListener = cb;
        },
      };
      withStubbedRoot(view, dialog);
      view.firstUpdated();
      assert(cancelListener, "firstUpdated must wire the cancel signal");
      cancelListener!(new Event("cancel"));
      assertEquals(answers, [false], "Escape must answer NO, never accept");
    } finally {
      restore();
    }
  });

  it("is scheduled on first update and CLEARED on disconnect", () => {
    // A leaked timer would flip `guarded` on an element already removed; a timer
    // never scheduled would leave accept disabled forever. Pin both by
    // capturing the ids through the real firstUpdated/disconnectedCallback.
    const scheduled: number[] = [];
    const cleared: number[] = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    let nextId = 1;
    // deno-lint-ignore no-explicit-any
    (globalThis as any).setTimeout = (_fn: () => void) => {
      const id = nextId++;
      scheduled.push(id);
      return id;
    };
    // deno-lint-ignore no-explicit-any
    (globalThis as any).clearTimeout = (id: number) => cleared.push(id);
    const restore = installBrowserGlobals();
    try {
      const view = new XDeviceLinkView();
      // Stub the shadow root so firstUpdated can run without a real DOM; a null
      // dialog exercises the crash-safe path (activateModalDialog no-ops).
      Object.defineProperty(view, "renderRoot", {
        value: { querySelector: () => null },
        configurable: true,
      });
      view.firstUpdated();
      assertEquals(scheduled.length, 1, "the guard timer must be scheduled");
      view.disconnectedCallback();
      assertEquals(cleared, scheduled, "disconnect must clear the same timer");
    } finally {
      restore();
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });
});

//
// failure reporting + fallback paths
//
// These cover the error/degradation paths the coverage ratchet flagged as
// uncovered. They are not padding: `reportDeviceLinkFailure` is the whole
// reason a failed scan isn't silent, and the two `catch` arms are what keep a
// hostile or exotic environment from turning a failure into a hang.
//

describe("reportDeviceLinkFailure", () => {
  /** Install a document whose createElement yields drivable fake views. */
  function withFakeViews() {
    class FakeView extends EventTarget {
      incomingDid = "";
      currentDid: string | null = null;
      failure: string | null = null;
      removed = false;
      remove() {
        this.removed = true;
      }
    }
    const created: FakeView[] = [];
    // deno-lint-ignore no-explicit-any
    (globalThis as any).document.createElement = () => {
      const el = new FakeView();
      created.push(el);
      return el;
    };
    return created;
  }

  it("shows the failure screen and resolves when dismissed", async () => {
    const restore = installBrowserGlobals();
    try {
      const created = withFakeViews();
      const pending = reportDeviceLinkFailure("unreadable");
      assertEquals(created.length, 1);
      assertEquals(created[0].failure, "unreadable");

      created[0].dispatchEvent(new CustomEvent("device-link-result"));
      await pending; // must resolve, not hang
      assert(created[0].removed, "the view must be cleaned up afterwards");
    } finally {
      restore();
    }
  });

  it("carries the 'failed' reason for a mid-flow error", async () => {
    // index.ts's catch-all reports this one; a silent boot there is exactly the
    // failure the screen exists to prevent.
    const restore = installBrowserGlobals();
    try {
      const created = withFakeViews();
      const pending = reportDeviceLinkFailure("failed");
      assertEquals(created[0].failure, "failed");
      created[0].dispatchEvent(new CustomEvent("device-link-result"));
      await pending;
    } finally {
      restore();
    }
  });

  it("removes the view even if dismissal rejects", async () => {
    const restore = installBrowserGlobals();
    try {
      const created = withFakeViews();
      const pending = reportDeviceLinkFailure("unreadable");
      created[0].dispatchEvent(new CustomEvent("device-link-result"));
      await pending;
      assert(created[0].removed);
    } finally {
      restore();
    }
  });
});

describe("scrub failure is survivable", () => {
  it("still reports the entropy when history.replaceState throws", () => {
    // A sandboxed iframe or a locked-down environment can throw here. Losing
    // the scrub is bad, but abandoning the login on top of it would be worse —
    // and an uncaught throw at module init would take the whole boot with it.
    const originalLocation = globalThis.location;
    const originalHistory = globalThis.history;
    Object.defineProperty(globalThis, "location", {
      value: {
        hash: "#k=" + toBase64Url(ZERO_ENTROPY),
        pathname: "/p",
        search: "",
        href: ORIGIN + "/p#k=" + toBase64Url(ZERO_ENTROPY),
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "history", {
      value: {
        replaceState: () => {
          throw new Error("SecurityError: sandboxed");
        },
      },
      configurable: true,
      writable: true,
    });
    try {
      const got = consumeDeviceLinkFragment();
      assertEquals(got, { kind: "entropy", entropy: ZERO_ENTROPY });
    } finally {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "history", {
        value: originalHistory,
        configurable: true,
        writable: true,
      });
    }
  });

  it("tolerates a missing history object entirely", () => {
    const originalLocation = globalThis.location;
    const originalHistory = globalThis.history;
    Object.defineProperty(globalThis, "location", {
      value: {
        hash: "#k=" + toBase64Url(ZERO_ENTROPY),
        pathname: "/p",
        search: "",
        href: ORIGIN + "/p#k=" + toBase64Url(ZERO_ENTROPY),
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "history", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      assertEquals(consumeDeviceLinkFragment(), {
        kind: "entropy",
        entropy: ZERO_ENTROPY,
      });
    } finally {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "history", {
        value: originalHistory,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("activateModalDialog — last-ditch fallback", () => {
  it("does not throw when BOTH showModal and setAttribute fail", () => {
    // The worst case: an exotic/partial <dialog>. We cannot show anything, but
    // throwing here would propagate out of firstUpdated and hang the promise —
    // the crash that bricked boot before. It must degrade quietly.
    let listened = false;
    const hostile = {
      showModal: () => {
        throw new Error("unsupported");
      },
      setAttribute: () => {
        throw new Error("also unsupported");
      },
      addEventListener: () => {
        listened = true;
      },
    };
    activateModalDialog(hostile, () => {});
    assert(listened, "the cancel signal must still be wired");
  });
});

describe("the tap-through guard actually releases", () => {
  it("flips `guarded` false when the timer fires", () => {
    // The timer BODY (not just its scheduling): without this the accept button
    // would stay disabled forever, which is one half of the boot-brick.
    const restore = installBrowserGlobals();
    const realSet = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    // deno-lint-ignore no-explicit-any
    (globalThis as any).setTimeout = (fn: () => void) => {
      fire = fn;
      return 1;
    };
    try {
      const view = new XDeviceLinkView();
      Object.defineProperty(view, "renderRoot", {
        value: { querySelector: () => null },
        configurable: true,
      });
      view.firstUpdated();
      const answers: boolean[] = [];
      view.addEventListener(
        "device-link-result",
        (e) => answers.push(Boolean((e as CustomEvent).detail?.accepted)),
      );

      // Before the timer fires, accept is inert...
      view.accessForTestingOnly.finish(true);
      assertEquals(answers, [], "accept must be inert during the guard");

      assert(fire, "the guard timer must have been scheduled");
      fire!(); // ...and after it fires, accept works.
      view.accessForTestingOnly.finish(true);
      assertEquals(answers, [true], "accept must work once the guard lifts");
    } finally {
      globalThis.setTimeout = realSet;
      restore();
    }
  });
});

//
// handleDeviceLink: the whole per-scan decision
//
// This logic used to live in index.ts — an entry module with a top-level await
// that no unit test can import, so every branch here was uncoverable by
// construction. Moving it into a real module is what makes these assertions
// possible at all; the coverage ratchet was pointing at a genuine design smell.
//

describe("handleDeviceLink", () => {
  it("reports a malformed fragment and never attempts a login", async () => {
    const reported: string[] = [];
    let loggedIn = false;
    await handleDeviceLink({ kind: "malformed" }, {
      report: (r) => {
        reported.push(r);
        return Promise.resolve();
      },
      login: () => {
        loggedIn = true;
        return Promise.resolve("accepted" as const);
      },
    });
    assertEquals(reported, ["unreadable"]);
    assert(!loggedIn, "a malformed payload has no entropy to log in with");
  });

  it("reports an invalid entropy outcome", async () => {
    const reported: string[] = [];
    await handleDeviceLink({ kind: "entropy", entropy: ZERO_ENTROPY }, {
      report: (r) => {
        reported.push(r);
        return Promise.resolve();
      },
      login: () => Promise.resolve("invalid" as const),
    });
    assertEquals(reported, ["unreadable"]);
  });

  it("is SILENT on cancel and on already-signed-in", async () => {
    // Cancel is an intentional "not mine"; already-signed-in is a successful
    // no-op. Nagging on either would train users to dismiss the real warnings.
    for (const outcome of ["cancelled", "already-signed-in"] as const) {
      const reported: string[] = [];
      let reloaded = false;
      await handleDeviceLink({ kind: "entropy", entropy: ZERO_ENTROPY }, {
        reloadOnReplace: true,
        report: (r) => {
          reported.push(r);
          return Promise.resolve();
        },
        login: () => Promise.resolve(outcome),
        reload: () => {
          reloaded = true;
        },
      });
      assertEquals(reported, [], `${outcome} must not report a failure`);
      assert(!reloaded, `${outcome} must not reload`);
    }
  });

  it("reloads after an accepted replace on the hashchange path", async () => {
    // The running app still holds the OLD identity; without the reload it would
    // keep signing as it despite the KeyStore having been updated.
    let reloaded = false;
    await handleDeviceLink({ kind: "entropy", entropy: ZERO_ENTROPY }, {
      reloadOnReplace: true,
      login: () => Promise.resolve("accepted" as const),
      reload: () => {
        reloaded = true;
      },
      report: () => Promise.resolve(),
    });
    assert(reloaded, "an accepted replace mid-session must re-bootstrap");
  });

  it("does NOT reload on the bootstrap path", async () => {
    // initializeKeys() has not run yet there, so it picks the new key up
    // directly — reloading would be a gratuitous flash.
    let reloaded = false;
    await handleDeviceLink({ kind: "entropy", entropy: ZERO_ENTROPY }, {
      login: () => Promise.resolve("accepted" as const),
      reload: () => {
        reloaded = true;
      },
      report: () => Promise.resolve(),
    });
    assert(!reloaded, "bootstrap must not reload");
  });

  it("never throws — a mid-flow error is reported, not propagated", async () => {
    // An uncaught throw on the bootstrap path skips initializeKeys AND
    // Navigation, stranding the user on a login screen with no explanation.
    const reported: string[] = [];
    await handleDeviceLink({ kind: "entropy", entropy: ZERO_ENTROPY }, {
      login: () => Promise.reject(new Error("KeyStore.open rejected")),
      report: (r) => {
        reported.push(r);
        return Promise.resolve();
      },
    });
    assertEquals(reported, ["failed"]);
  });

  it("survives the reporter itself failing", async () => {
    // Last line of defense: if even the failure screen cannot render, boot on
    // rather than hanging forever.
    await handleDeviceLink({ kind: "entropy", entropy: ZERO_ENTROPY }, {
      login: () => Promise.reject(new Error("boom")),
      report: () => Promise.reject(new Error("the reporter is broken too")),
    });
  });
});
