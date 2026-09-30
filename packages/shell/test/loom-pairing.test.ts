import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { StoredCredential } from "../src/lib/credentials.ts";
import {
  handleLoomPairingLink,
  pairWithLoom,
  runLoomPairingLogin,
} from "../src/lib/loom-pairing-login.ts";
import {
  consumeLoomPairingFragment,
  DEFAULT_LOOM_URL,
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
    function withLocation(hash: string, framed = false) {
      const href = "http://localhost:8000/home/piece" + hash;
      const replaced: string[] = [];
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
        replaceState: (_state: unknown, _title: string, url: string) =>
          replaced.push(url),
      });
      set("self", globalThis);
      set("top", framed ? {} : globalThis);
      const restore = () => {
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      };
      return { replaced, restore };
    }

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
    function run(opts: {
      existing?: Identity;
      incoming: Identity;
      confirm?: boolean;
    }) {
      const keyStore = fakeKeyStore(opts.existing);
      const confirmCalls: [string, string][] = [];
      const saved: StoredCredential[] = [];
      let redeemed = 0;
      const outcome = runLoomPairingLogin(REQUEST, {
        openKeyStore: keyStore.open,
        confirmReplace: (currentDid, loomUrl) => {
          confirmCalls.push([currentDid, loomUrl]);
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
        confirmCalls,
        saved,
        redeemed: () => redeemed,
      };
    }

    it("stores the identity without asking when nobody is signed in", async () => {
      const incoming = await makeIdentity(1);
      const ctx = run({ incoming });
      expect(await ctx.outcome).toBe("accepted");
      expect(ctx.confirmCalls).toEqual([]);
      expect(ctx.keyStore.entries.get("$ROOT_KEY")?.did()).toBe(
        incoming.did(),
      );
      expect(ctx.saved).toEqual([{ id: incoming.did(), method: "keyfile" }]);
    });

    it("asks before redeeming, and redeems nothing on cancel", async () => {
      const existing = await makeIdentity(2);
      const ctx = run({ existing, incoming: await makeIdentity(1) });
      expect(await ctx.outcome).toBe("cancelled");
      expect(ctx.confirmCalls).toEqual([[existing.did(), REQUEST.loomUrl]]);
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
        currentDid: "did:key:z6Mkcurrent",
        loomUrl: REQUEST.loomUrl,
      });
      view.accessForTestingOnly.finish(true);
      expect(answers).toEqual([]);
      view.accessForTestingOnly.finish(false);
      view.accessForTestingOnly.finish(false);
      expect(answers).toEqual([false]);
    });

    it("accepts once the guard has released", () => {
      const { view, answers } = makeView({
        currentDid: "did:key:z6Mkcurrent",
        loomUrl: REQUEST.loomUrl,
        guarded: false,
      });
      view.accessForTestingOnly.finish(true);
      expect(answers).toEqual([true]);
    });
  });
});
