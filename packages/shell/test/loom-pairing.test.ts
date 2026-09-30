import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { urlToAppView } from "@commonfabric/navigation";

import type { StoredCredential } from "../src/lib/credentials.ts";
import {
  confirmWithUser,
  describeThisDevice,
  handleLoomPairingLink,
  type LoomPairingQuestion,
  pairWithLoom,
  rememberKeyFileCredential,
  reportLoomPairingFailure,
  runLoomPairingLogin,
} from "../src/lib/loom-pairing-login.ts";
import {
  consumeLoomPairingFragment,
  DEFAULT_LOOM_URL,
  isLocalLoom,
  LoomPairingError,
  type LoomPairingRequest,
  normalizeLoomUrl,
  normalizePairingCode,
  parseLoomPairingFragment,
  redeemPairingCode,
} from "../src/lib/loom-pairing.ts";
import { XLoomPairingView } from "../src/views/LoomPairingView.ts";

const REQUEST: LoomPairingRequest = {
  code: "7KQ2MXH4RD",
  loomUrl: "http://localhost:9900",
};

const DEVICE = { name: "test device", platform: "web" };

/** An identity with a fixed seed, for a DID the test can compare against. */
function makeIdentity(seed: number): Promise<Identity> {
  return Identity.fromRaw(new Uint8Array(32).fill(seed));
}

/** A fresh key as the Loom sends it, and the DID it is. */
async function makeKey(): Promise<{ pkcs8: Uint8Array; did: string }> {
  const pkcs8 = await Identity.generatePkcs8();
  return { pkcs8, did: (await Identity.fromPkcs8(pkcs8)).did() };
}

/** Base64 of `bytes`, the encoding the Loom sends a key in. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A `fetch` that records its calls and returns `response`. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((input: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The text of a Lit template, its static parts and its values in order. */
function templateText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return "";
  const template = value as { strings?: string[]; values?: unknown[] };
  return [...(template.strings ?? []), ...(template.values ?? [])]
    .map(templateText).join("");
}

/** The functions a Lit template holds, its event handlers, in order. */
function functionsOf(value: unknown): Array<() => void> {
  if (typeof value === "function") return [value as () => void];
  if (value == null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(functionsOf);
  return ((value as { values?: unknown[] }).values ?? []).flatMap(functionsOf);
}

/** In-memory stand-in for the IndexedDB-backed KeyStore. */
function fakeKeyStore(initial?: Identity) {
  const entries = new Map<string, Identity>();
  if (initial) entries.set("$ROOT_KEY", initial);
  return {
    entries,
    open: () =>
      Promise.resolve({
        get: (name: string) => Promise.resolve(entries.get(name)),
        set: (name: string, value: Identity) => {
          entries.set(name, value);
          return Promise.resolve();
        },
        // deno-lint-ignore no-explicit-any
      } as any),
  };
}

/**
 * Replaces `globalThis` properties for the length of `body`, restoring each
 * afterwards.
 */
function withGlobals<T>(values: Record<string, unknown>, body: () => T): T {
  const saved = Object.keys(values).map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  try {
    const result = body();
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/** A stand-in for the pairing view, which the dialog functions drive. */
class FakePairingView extends EventTarget {
  question: LoomPairingQuestion | null = null;
  failure: string | null = null;
  removed = false;

  remove() {
    this.removed = true;
  }

  answer(accepted: boolean) {
    this.dispatchEvent(
      new CustomEvent("loom-pairing-result", { detail: { accepted } }),
    );
  }
}

/** A `document` whose views are `FakePairingView`s, and the views it made. */
function fakeDocument() {
  const views: FakePairingView[] = [];
  const inserted: FakePairingView[] = [];
  return {
    views,
    inserted,
    document: {
      createElement: () => {
        const view = new FakePairingView();
        views.push(view);
        return view;
      },
      body: { appendChild: (view: FakePairingView) => inserted.push(view) },
    },
  };
}

describe("loom-pairing", () => {
  describe("normalizePairingCode()", () => {
    it("returns the code without its separator, uppercased", () => {
      expect(normalizePairingCode("7kq2m-xh4rd")).toBe("7KQ2MXH4RD");
      expect(normalizePairingCode(" 7KQ2M XH4RD ")).toBe("7KQ2MXH4RD");
    });

    it("folds Crockford's look-alikes to digits", () => {
      expect(normalizePairingCode("OIL00-11111")).toBe("0110011111");
    });

    it("returns `null` for a code of the wrong length", () => {
      expect(normalizePairingCode("7KQ2M-XH4R")).toBeNull();
      expect(normalizePairingCode("7KQ2M-XH4RDD")).toBeNull();
      expect(normalizePairingCode("")).toBeNull();
    });

    it("returns `null` for a character outside the alphabet", () => {
      expect(normalizePairingCode("7KQ2M-XH4RU")).toBeNull();
      expect(normalizePairingCode("7KQ2M-XH4R!")).toBeNull();
    });

    it("returns `null` for a letter that only uppercases into the alphabet", () => {
      expect(normalizePairingCode("7KQ2M-XH4Rſ")).toBeNull();
      expect(normalizePairingCode("7KQ2M-XH4Rı")).toBeNull();
    });
  });

  describe("normalizeLoomUrl()", () => {
    it("returns the origin of an `http:` or `https:` URL", () => {
      expect(normalizeLoomUrl("http://localhost:9900/")).toBe(
        "http://localhost:9900",
      );
      expect(normalizeLoomUrl(" https://mac.tail.ts.net/some/path ")).toBe(
        "https://mac.tail.ts.net",
      );
    });

    it("returns `null` for another scheme, credentials, or no URL", () => {
      expect(normalizeLoomUrl("ftp://localhost:9900")).toBeNull();
      expect(normalizeLoomUrl("javascript:alert(1)")).toBeNull();
      expect(normalizeLoomUrl("http://user:pw@localhost:9900")).toBeNull();
      expect(normalizeLoomUrl("localhost:9900/x")).toBeNull();
      expect(normalizeLoomUrl("not a url")).toBeNull();
    });
  });

  describe("isLocalLoom()", () => {
    it("returns `true` for a loopback Loom", () => {
      for (
        const url of [
          "http://localhost:9900",
          "http://127.0.0.1:9900",
          "http://[::1]:9900",
        ]
      ) {
        expect(isLocalLoom(url)).toBe(true);
      }
    });

    it("returns `false` for a Loom on another host", () => {
      for (
        const url of [
          "https://mac.tail.ts.net",
          "http://192.168.1.4:9900",
          "http://localhost.evil.example",
        ]
      ) {
        expect(isLocalLoom(url)).toBe(false);
      }
    });
  });

  describe("parseLoomPairingFragment()", () => {
    it("returns `absent` for a hash that is not a pairing link", () => {
      for (const hash of ["", "#", "#k=abc", "#paired=7KQ2M-XH4RD"]) {
        expect(parseLoomPairingFragment(hash)).toEqual({ kind: "absent" });
      }
    });

    it("returns the request, with the default Loom when the link names none", () => {
      expect(parseLoomPairingFragment("#pair=7KQ2M-XH4RD")).toEqual({
        kind: "request",
        request: { code: "7KQ2MXH4RD", loomUrl: DEFAULT_LOOM_URL },
      });
    });

    it("returns the Loom the link names", () => {
      const loom = encodeURIComponent("https://mac.tail.ts.net");
      expect(parseLoomPairingFragment(`#pair=7KQ2M-XH4RD&loom=${loom}`))
        .toEqual({
          kind: "request",
          request: { code: "7KQ2MXH4RD", loomUrl: "https://mac.tail.ts.net" },
        });
    });

    it("returns `malformed` for an unreadable code or Loom URL", () => {
      expect(parseLoomPairingFragment("#pair=")).toEqual({
        kind: "malformed",
      });
      expect(parseLoomPairingFragment("#pair=7KQ2M")).toEqual({
        kind: "malformed",
      });
      expect(parseLoomPairingFragment("#pair=7KQ2M-XH4RD&loom=ftp://x"))
        .toEqual({ kind: "malformed" });
    });
  });

  describe("consumeLoomPairingFragment()", () => {
    function withLocation(
      hash: string,
      framed = false,
      history: { state?: unknown; throws?: boolean } = {},
    ) {
      const href = "http://localhost:8000/home/piece" + hash;
      const replaced: string[] = [];
      const states: unknown[] = [];
      const saved = ["location", "history", "top", "self"].map((
        name,
      ) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
      const set = (name: string, value: unknown) =>
        Object.defineProperty(globalThis, name, {
          value,
          configurable: true,
          writable: true,
        });
      set("location", { hash, href });
      set("history", {
        state: history.state ?? null,
        replaceState: (state: unknown, _title: string, url: string) => {
          if (history.throws) throw new DOMException("refused");
          states.push(state);
          replaced.push(url);
        },
      });
      set("self", globalThis);
      set("top", framed ? {} : globalThis);
      const restore = () => {
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      };
      return { replaced, states, restore };
    }

    it("gives a scrubbed entry without state the view its address names", () => {
      const ctx = withLocation("#pair=7KQ2M-XH4RD");
      try {
        consumeLoomPairingFragment();
        expect(ctx.states).toEqual([
          urlToAppView(new URL("http://localhost:8000/home/piece")),
        ]);
      } finally {
        ctx.restore();
      }
    });

    it("keeps the state of a scrubbed entry that has one", () => {
      const state = { spaceName: "home" };
      const ctx = withLocation("#pair=7KQ2M-XH4RD", false, { state });
      try {
        consumeLoomPairingFragment();
        expect(ctx.states).toEqual([state]);
      } finally {
        ctx.restore();
      }
    });

    it("returns the request when the history refuses the scrub", () => {
      const ctx = withLocation("#pair=7KQ2M-XH4RD", false, { throws: true });
      try {
        expect(consumeLoomPairingFragment()).toEqual({
          kind: "request",
          request: { code: "7KQ2MXH4RD", loomUrl: DEFAULT_LOOM_URL },
        });
      } finally {
        ctx.restore();
      }
    });

    it("returns the request and scrubs the fragment, keeping the path", () => {
      const ctx = withLocation("#pair=7KQ2M-XH4RD");
      try {
        expect(consumeLoomPairingFragment()).toEqual({
          kind: "request",
          request: { code: "7KQ2MXH4RD", loomUrl: DEFAULT_LOOM_URL },
        });
        expect(ctx.replaced).toEqual(["http://localhost:8000/home/piece"]);
      } finally {
        ctx.restore();
      }
    });

    it("scrubs a malformed link and returns `malformed`", () => {
      const ctx = withLocation("#pair=nope");
      try {
        expect(consumeLoomPairingFragment()).toEqual({ kind: "malformed" });
        expect(ctx.replaced).toEqual(["http://localhost:8000/home/piece"]);
      } finally {
        ctx.restore();
      }
    });

    it("leaves any other fragment alone", () => {
      const ctx = withLocation("#k=abc");
      try {
        expect(consumeLoomPairingFragment()).toEqual({ kind: "absent" });
        expect(ctx.replaced).toEqual([]);
      } finally {
        ctx.restore();
      }
    });

    it("scrubs a link inside a frame but returns `absent`", () => {
      const ctx = withLocation("#pair=7KQ2M-XH4RD", true);
      try {
        expect(consumeLoomPairingFragment()).toEqual({ kind: "absent" });
        expect(ctx.replaced).toEqual(["http://localhost:8000/home/piece"]);
      } finally {
        ctx.restore();
      }
    });
  });

  describe("redeemPairingCode()", () => {
    it("posts the code and the device to the Loom's redeem route", async () => {
      const { calls, fetchImpl } = fakeFetch(() =>
        json(200, { pkcs8Base64: toBase64(new Uint8Array([1, 2, 3])) })
      );
      await redeemPairingCode(REQUEST, DEVICE, fetchImpl);

      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe(
        "http://localhost:9900/identity-pairing/redeem",
      );
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.credentials).toBe("omit");
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        code: "7KQ2MXH4RD",
        device: DEVICE,
      });
    });

    it("returns the decoded key and the DID the Loom names", async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(200, {
          pkcs8Base64: toBase64(new Uint8Array([1, 2, 3])),
          did: "did:key:z6Mkexample",
        })
      );
      expect(await redeemPairingCode(REQUEST, DEVICE, fetchImpl)).toEqual({
        pkcs8: new Uint8Array([1, 2, 3]),
        did: "did:key:z6Mkexample",
      });
    });

    it("returns a `null` DID when the Loom names none", async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(200, { pkcs8Base64: toBase64(new Uint8Array([1])), did: "" })
      );
      expect((await redeemPairingCode(REQUEST, DEVICE, fetchImpl)).did)
        .toBeNull();
    });

    it("throws `refused` with the Loom's hint on a 403", async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(403, { error: "pairing-refused", hint: "Make a new code." })
      );
      const error = await redeemPairingCode(REQUEST, DEVICE, fetchImpl).then(
        () => null,
        (e) => e,
      );
      expect(error).toBeInstanceOf(LoomPairingError);
      expect(error.reason).toBe("refused");
      expect(error.message).toBe("Make a new code.");
    });

    it("throws `refused` with its own advice on a 403 without a hint", async () => {
      const { fetchImpl } = fakeFetch(() => new Response("", { status: 403 }));
      const error = await redeemPairingCode(REQUEST, DEVICE, fetchImpl).then(
        () => null,
        (e) => e,
      );
      expect(error.reason).toBe("refused");
      expect(error.message).toContain("new code");
    });

    it("throws `unreachable` naming the Loom when the fetch fails", async () => {
      const fetchImpl =
        (() =>
          Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
      const error = await redeemPairingCode(REQUEST, DEVICE, fetchImpl).then(
        () => null,
        (e) => e,
      );
      expect(error.reason).toBe("unreachable");
      expect(error.message).toContain("http://localhost:9900");
    });

    it("throws `unreachable` for a Loom without the redeem route", async () => {
      const { fetchImpl } = fakeFetch(() => new Response("", { status: 404 }));
      const error = await redeemPairingCode(REQUEST, DEVICE, fetchImpl).then(
        () => null,
        (e) => e,
      );
      expect(error.reason).toBe("unreachable");
      expect(error.message).toContain("does not offer pairing");
    });

    it("throws `invalid-response` on another error status", async () => {
      const { fetchImpl } = fakeFetch(() => json(500, { error: "boom" }));
      const error = await redeemPairingCode(REQUEST, DEVICE, fetchImpl).then(
        () => null,
        (e) => e,
      );
      expect(error.reason).toBe("invalid-response");
    });

    it("throws `invalid-response` on a success without a readable key", async () => {
      for (
        const body of [{}, { pkcs8Base64: "" }, { pkcs8Base64: "%%%" }, []]
      ) {
        const { fetchImpl } = fakeFetch(() => json(200, body));
        const error = await redeemPairingCode(REQUEST, DEVICE, fetchImpl)
          .then(() => null, (e) => e);
        expect(error?.reason).toBe("invalid-response");
      }
    });
  });

  describe("pairWithLoom()", () => {
    it("returns the identity whose key the Loom returned", async () => {
      const key = await makeKey();
      const identity = await pairWithLoom(REQUEST, () => Promise.resolve(key));
      expect(identity.did()).toBe(key.did);
    });

    it("throws `invalid-response` when the key is not the DID the Loom named", async () => {
      const handed = await makeKey();
      const other = await makeKey();
      const error = await pairWithLoom(
        REQUEST,
        () => Promise.resolve({ pkcs8: handed.pkcs8, did: other.did }),
      )
        .then(() => null, (e) => e);
      expect(error).toBeInstanceOf(LoomPairingError);
      expect(error.reason).toBe("invalid-response");
    });

    it("throws `invalid-response` for bytes that are not PKCS8", async () => {
      const error = await pairWithLoom(
        REQUEST,
        () => Promise.resolve({ pkcs8: new Uint8Array([1, 2, 3]), did: null }),
      )
        .then(() => null, (e) => e);
      expect(error.reason).toBe("invalid-response");
    });
  });

  describe("runLoomPairingLogin()", () => {
    const REMOTE: LoomPairingRequest = {
      code: REQUEST.code,
      loomUrl: "https://mac.tail.ts.net",
    };

    function run(opts: {
      request?: LoomPairingRequest;
      existing?: Identity;
      incoming: Identity;
      confirm?: boolean;
    }) {
      const keyStore = fakeKeyStore(opts.existing);
      const questions: LoomPairingQuestion[] = [];
      const saved: StoredCredential[] = [];
      let redeemed = 0;
      const outcome = runLoomPairingLogin(opts.request ?? REQUEST, {
        openKeyStore: keyStore.open,
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(opts.confirm ?? false);
        },
        pair: () => {
          redeemed++;
          return Promise.resolve(opts.incoming);
        },
        saveCredential: (credential) => saved.push(credential),
      });
      return {
        outcome,
        keyStore,
        questions,
        saved,
        redeemed: () => redeemed,
      };
    }

    describe("for a Loom on this computer", () => {
      it("stores the identity without asking when nobody is signed in", async () => {
        const incoming = await makeIdentity(1);
        const ctx = run({ incoming });
        expect(await ctx.outcome).toBe("accepted");
        expect(ctx.questions).toEqual([]);
        expect(ctx.keyStore.entries.get("$ROOT_KEY")?.did()).toBe(
          incoming.did(),
        );
        expect(ctx.saved).toEqual([{ id: incoming.did(), method: "keyfile" }]);
      });

      it("returns `accepted` when the credential cannot be saved", async () => {
        const incoming = await makeIdentity(1);
        const keyStore = fakeKeyStore();
        const outcome = await withGlobals({
          console: { ...console, warn: () => {} },
        }, () =>
          runLoomPairingLogin(REQUEST, {
            openKeyStore: keyStore.open,
            pair: () => Promise.resolve(incoming),
            saveCredential: () => {
              throw new DOMException("quota", "QuotaExceededError");
            },
          }));
        expect(outcome).toBe("accepted");
        expect(keyStore.entries.get("$ROOT_KEY")).toBe(incoming);
      });

      it("asks before redeeming, and redeems nothing on cancel", async () => {
        const existing = await makeIdentity(2);
        const ctx = run({ existing, incoming: await makeIdentity(1) });
        expect(await ctx.outcome).toBe("cancelled");
        expect(ctx.questions).toEqual([{
          loomUrl: REQUEST.loomUrl,
          currentDid: existing.did(),
          incomingDid: null,
        }]);
        expect(ctx.redeemed()).toBe(0);
        expect(ctx.keyStore.entries.get("$ROOT_KEY")).toBe(existing);
        expect(ctx.saved).toEqual([]);
      });

      it("replaces the signed-in identity when the person confirms", async () => {
        const incoming = await makeIdentity(1);
        const ctx = run({
          existing: await makeIdentity(2),
          incoming,
          confirm: true,
        });
        expect(await ctx.outcome).toBe("accepted");
        expect(ctx.questions.length).toBe(1);
        expect(ctx.keyStore.entries.get("$ROOT_KEY")).toBe(incoming);
      });

      it("returns `already-signed-in` without writing when the identity is the same", async () => {
        const existing = await makeIdentity(1);
        const ctx = run({
          existing,
          incoming: await makeIdentity(1),
          confirm: true,
        });
        expect(await ctx.outcome).toBe("already-signed-in");
        expect(ctx.keyStore.entries.get("$ROOT_KEY")).toBe(existing);
        expect(ctx.saved).toEqual([]);
      });
    });

    describe("for a Loom elsewhere", () => {
      it("asks after redeeming, naming the incoming identity, even when nobody is signed in", async () => {
        const incoming = await makeIdentity(1);
        const ctx = run({ request: REMOTE, incoming });
        expect(await ctx.outcome).toBe("cancelled");
        expect(ctx.questions).toEqual([{
          loomUrl: REMOTE.loomUrl,
          currentDid: null,
          incomingDid: incoming.did(),
        }]);
        expect(ctx.keyStore.entries.size).toBe(0);
        expect(ctx.saved).toEqual([]);
      });

      it("asks once when replacing, naming both identities", async () => {
        const existing = await makeIdentity(2);
        const incoming = await makeIdentity(1);
        const ctx = run({
          request: REMOTE,
          existing,
          incoming,
          confirm: true,
        });
        expect(await ctx.outcome).toBe("accepted");
        expect(ctx.questions).toEqual([{
          loomUrl: REMOTE.loomUrl,
          currentDid: existing.did(),
          incomingDid: incoming.did(),
        }]);
        expect(ctx.keyStore.entries.get("$ROOT_KEY")).toBe(incoming);
      });

      it("returns `already-signed-in` without asking when the identity is the same", async () => {
        const ctx = run({
          request: REMOTE,
          existing: await makeIdentity(1),
          incoming: await makeIdentity(1),
        });
        expect(await ctx.outcome).toBe("already-signed-in");
        expect(ctx.questions).toEqual([]);
      });
    });
  });
  describe("rememberKeyFileCredential()", () => {
    it("saves a key-file credential for the identity", async () => {
      const identity = await makeIdentity(1);
      const saved: StoredCredential[] = [];
      rememberKeyFileCredential(identity, (c) => saved.push(c));
      expect(saved).toEqual([{ id: identity.did(), method: "keyfile" }]);
    });

    it("returns normally when the browser refuses the write", async () => {
      const identity = await makeIdentity(1);
      const warnings: unknown[] = [];
      withGlobals({
        console: {
          ...console,
          warn: (...args: unknown[]) => warnings.push(args),
        },
      }, () =>
        rememberKeyFileCredential(identity, () => {
          throw new DOMException("quota", "QuotaExceededError");
        }));
      expect(warnings.length).toBe(1);
    });
  });

  describe("describeThisDevice()", () => {
    it("names the shell's host", () => {
      expect(
        withGlobals(
          { location: { host: "localhost:8000" } },
          describeThisDevice,
        ),
      ).toEqual({
        name: "Common Fabric shell at localhost:8000",
        platform: "web",
      });
    });

    it("returns a generic name without a location", () => {
      expect(withGlobals({ location: undefined }, describeThisDevice))
        .toEqual({ name: "Common Fabric shell", platform: "web" });
    });
  });

  describe("confirmWithUser()", () => {
    it("shows the question and returns the person's answer", async () => {
      const question = {
        loomUrl: REQUEST.loomUrl,
        currentDid: "did:key:z6Mkcurrent",
        incomingDid: null,
      };
      for (const accepted of [true, false]) {
        const fake = fakeDocument();
        const answer = await withGlobals({ document: fake.document }, () => {
          const pending = confirmWithUser(question);
          expect(fake.inserted).toEqual(fake.views);
          expect(fake.views[0].question).toBe(question);
          fake.views[0].answer(accepted);
          return pending;
        });
        expect(answer).toBe(accepted);
        expect(fake.views[0].removed).toBe(true);
      }
    });
  });

  describe("reportLoomPairingFailure()", () => {
    it("shows the message until it is dismissed, then removes the view", async () => {
      const fake = fakeDocument();
      await withGlobals({ document: fake.document }, () => {
        const pending = reportLoomPairingFailure("Make a new code.");
        expect(fake.views[0].failure).toBe("Make a new code.");
        fake.views[0].answer(false);
        return pending;
      });
      expect(fake.views[0].removed).toBe(true);
    });
  });

  describe("handleLoomPairingLink()", () => {
    const LINK = { kind: "request", request: REQUEST } as const;

    it("reports a malformed link without logging in", async () => {
      const reports: string[] = [];
      let logins = 0;
      await handleLoomPairingLink({ kind: "malformed" }, {
        report: (message) => {
          reports.push(message);
          return Promise.resolve();
        },
        login: () => {
          logins++;
          return Promise.resolve("accepted");
        },
      });
      expect(reports.length).toBe(1);
      expect(logins).toBe(0);
    });

    it("reloads after an accepted login only when asked to", async () => {
      for (const reloadOnAccept of [true, false]) {
        let reloads = 0;
        await handleLoomPairingLink(LINK, {
          reloadOnAccept,
          reload: () => reloads++,
          login: () => Promise.resolve("accepted"),
        });
        expect(reloads).toBe(reloadOnAccept ? 1 : 0);
      }
    });

    it("does not reload on `cancelled` or `already-signed-in`", async () => {
      for (const outcome of ["cancelled", "already-signed-in"] as const) {
        let reloads = 0;
        await handleLoomPairingLink(LINK, {
          reloadOnAccept: true,
          reload: () => reloads++,
          login: () => Promise.resolve(outcome),
        });
        expect(reloads).toBe(0);
      }
    });

    it("reports a `LoomPairingError`'s own message", async () => {
      const reports: string[] = [];
      await handleLoomPairingLink(LINK, {
        report: (message) => {
          reports.push(message);
          return Promise.resolve();
        },
        login: () =>
          Promise.reject(new LoomPairingError("refused", "Make a new code.")),
      });
      expect(reports).toEqual(["Make a new code."]);
    });

    it("reports any other error generically, and survives a failing reporter", async () => {
      const reports: string[] = [];
      await handleLoomPairingLink(LINK, {
        report: (message) => {
          reports.push(message);
          return Promise.reject(new Error("reporter broke"));
        },
        login: () => Promise.reject(new Error("internal detail")),
      });
      expect(reports.length).toBe(1);
      expect(reports[0]).not.toContain("internal detail");
    });
  });

  describe("XLoomPairingView", () => {
    function makeView(state: Record<string, unknown>) {
      const view = new XLoomPairingView();
      Object.assign(view, state);
      const answers: boolean[] = [];
      view.addEventListener(
        "loom-pairing-result",
        (e) => answers.push(Boolean((e as CustomEvent).detail?.accepted)),
      );
      return { view, answers };
    }

    it("ignores an accept inside the tap-through guard, and answers once", () => {
      const { view, answers } = makeView({
        question: {
          loomUrl: REQUEST.loomUrl,
          currentDid: "did:key:z6Mkcurrent",
          incomingDid: null,
        },
      });
      view.accessForTestingOnly.finish(true);
      expect(answers).toEqual([]);
      view.accessForTestingOnly.finish(false);
      view.accessForTestingOnly.finish(false);
      expect(answers).toEqual([false]);
    });

    it("renders the Loom and the incoming identity for a Loom elsewhere", () => {
      const { view } = makeView({
        question: {
          loomUrl: "https://mac.tail.ts.net",
          currentDid: "did:key:z6Mkcurrent",
          incomingDid: "did:key:z6Mkincoming",
        },
      });
      const text = templateText(view.render());
      expect(text).toContain("https://mac.tail.ts.net");
      expect(text).toContain("did:key:z6Mkcurrent");
      expect(text).toContain("did:key:z6Mkincoming");
      expect(text).toContain("not on this computer");
    });

    it("renders no incoming identity for a Loom on this computer", () => {
      const { view } = makeView({
        question: {
          loomUrl: REQUEST.loomUrl,
          currentDid: "did:key:z6Mkcurrent",
          incomingDid: null,
        },
      });
      const text = templateText(view.render());
      expect(text).toContain(REQUEST.loomUrl);
      expect(text).not.toContain("not on this computer");
      expect(text).not.toContain("Would become");
    });

    it("renders a failure with only a dismiss button, which answers no", () => {
      const { view, answers } = makeView({ failure: "Make a new code." });
      const rendered = view.render();
      expect(templateText(rendered)).toContain("Make a new code.");
      const handlers = functionsOf(rendered);
      expect(handlers.length).toBe(1);
      handlers[0]();
      expect(answers).toEqual([false]);
    });

    it("renders nothing without a question or a failure", () => {
      expect(templateText(makeView({}).view.render())).toBe("");
    });

    it("wires the dialog's cancel to no, and clears its guard timer on disconnect", () => {
      const { view, answers } = makeView({
        question: {
          loomUrl: REQUEST.loomUrl,
          currentDid: null,
          incomingDid: "did:key:z6Mkincoming",
        },
      });
      let cancel: ((event: Event) => void) | undefined;
      let focused = false;
      const dialog = {
        showModal: () => {},
        setAttribute: () => {},
        addEventListener: (type: string, listener: (e: Event) => void) => {
          if (type === "cancel") cancel = listener;
        },
      };
      Object.defineProperty(view, "renderRoot", {
        value: {
          querySelector: (selector: string) =>
            selector === "dialog" ? dialog : {
              focus: () => (focused = true),
            },
        },
        configurable: true,
      });
      const cleared: unknown[] = [];
      let release: (() => void) | undefined;
      withGlobals({
        setTimeout: (callback: () => void) => {
          release = callback;
          return 7;
        },
        clearTimeout: (id: unknown) => cleared.push(id),
      }, () => {
        view.firstUpdated();
        release?.();
        cancel?.(new Event("cancel"));
        view.disconnectedCallback();
      });
      expect(answers).toEqual([false]);
      expect(focused).toBe(true);
      expect(cleared).toEqual([7]);
    });

    it("accepts once the guard has released", () => {
      const { view, answers } = makeView({
        question: {
          loomUrl: REQUEST.loomUrl,
          currentDid: null,
          incomingDid: "did:key:z6Mkincoming",
        },
        guarded: false,
      });
      view.accessForTestingOnly.finish(true);
      expect(answers).toEqual([true]);
    });
  });
});
