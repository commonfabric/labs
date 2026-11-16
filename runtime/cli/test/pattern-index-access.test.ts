import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  decodeDelegation,
  issueDelegation,
} from "@commonfabric/identity";
import {
  checkIndexChain,
  issueIndexChain,
  MAX_SIGNER_LINK_SECONDS,
} from "@commonfabric/pattern-index/membership";
import {
  adoptIndexChain,
  chainForSigner,
  joinPatternIndex,
  parseInviteLink,
  resolvePatternIndexUrl,
} from "../lib/pattern-index-access.ts";
import { PatternIndexStore } from "../lib/pattern-index-store.ts";
import { FakePatternIndex } from "./fake-pattern-index.ts";

const BASE = "https://index.test";
const NOW = Math.floor(Date.now() / 1000);
const cfKey = await Identity.fromPassphrase("pattern-index access cf");
const secondMachine = await Identity.fromPassphrase(
  "pattern-index access laptop",
);
const LINK =
  "https://fbrc.social/index-join?invite=inv1&inviter=p-admin#code=secret-code";

describe("pattern-index-access", () => {
  let dir: string;
  let store: PatternIndexStore;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    store = new PatternIndexStore(dir);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("parseInviteLink()", () => {
    it("returns the invite id from the query and the code from the fragment", () => {
      expect(parseInviteLink(LINK)).toEqual({
        inviteId: "inv1",
        code: "secret-code",
      });
    });

    it("throws without quoting a link that carries no code", () => {
      const link = "https://fbrc.social/index-join?invite=inv1&x=secret-code";
      expect(() => parseInviteLink(link)).toThrow("after #");
      try {
        parseInviteLink(link);
      } catch (error) {
        expect((error as Error).message).not.toContain("secret-code");
      }
    });
  });

  describe("resolvePatternIndexUrl()", () => {
    it("returns the flag over the environment, and the environment over the default", () => {
      const env = (key: string) =>
        key === "CF_PATTERN_INDEX_URL" ? "https://env.test" : undefined;
      expect(resolvePatternIndexUrl("https://flag.test", env)).toBe(
        "https://flag.test",
      );
      expect(resolvePatternIndexUrl(undefined, env)).toBe("https://env.test");
      expect(resolvePatternIndexUrl(undefined, () => undefined)).toContain(
        "pattern-index",
      );
    });
  });

  describe("joinPatternIndex()", () => {
    it("redeems the invite with a new index-only root and leaves the cf key acting for that member", async () => {
      const index = new FakePatternIndex({ invites: { inv1: "secret-code" } });
      const result = await joinPatternIndex({
        baseUrl: BASE,
        signer: cfKey,
        store,
        fetchFn: index.fetchFn,
        invite: parseInviteLink(LINK),
      });
      const root = await store.rootKey();
      expect(root).toBeDefined();
      expect(root!.did()).not.toBe(cfKey.did());
      expect(result).toMatchObject({
        handle: "p-1",
        root: root!.did(),
        signer: cfKey.did(),
        joined: true,
      });
      const redeem = index.calls.find((call) => call.fn === "redeemInvite")!;
      expect(redeem.signer).toBe(root!.did());
      const whoami = index.calls.find((call) => call.fn === "whoami")!;
      expect(whoami.signer).toBe(cfKey.did());
      expect(whoami.body.proofs).toHaveLength(1);
    });

    it("redeems nothing on a second run, so the invite is not spent twice", async () => {
      const index = new FakePatternIndex({ invites: { inv1: "secret-code" } });
      const options = {
        baseUrl: BASE,
        signer: cfKey,
        store,
        fetchFn: index.fetchFn,
        invite: parseInviteLink(LINK),
      };
      await joinPatternIndex(options);
      const again = await joinPatternIndex(options);
      expect(again.joined).toBe(false);
      expect(index.calls.filter((call) => call.fn === "redeemInvite"))
        .toHaveLength(1);
    });

    it("throws naming the refusal and never the code", async () => {
      const index = new FakePatternIndex({ invites: { inv1: "other" } });
      const attempt = joinPatternIndex({
        baseUrl: BASE,
        signer: cfKey,
        store,
        fetchFn: index.fetchFn,
        invite: parseInviteLink(LINK),
      });
      await expect(attempt).rejects.toThrow("code does not match");
      await attempt.catch((error: Error) => {
        expect(error.message).not.toContain("secret-code");
      });
      expect(await store.membership()).toBeUndefined();
    });
  });

  describe("chainForSigner()", () => {
    it("renews from the kept root a chain with under a week left", async () => {
      const root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
      const old = await issueIndexChain({
        issuer: root,
        to: cfKey.did(),
        held: [],
        expiresAt: NOW + 3600,
        nowSeconds: NOW,
      });
      await store.recordChain(cfKey.did(), old);
      const chain = await chainForSigner(store, cfKey, NOW);
      const checked = await checkIndexChain(chain!, cfKey.did(), NOW);
      expect(checked.signerLinkExpires).toBe(NOW + MAX_SIGNER_LINK_SECONDS);
      expect(await store.chainFor(cfKey.did())).toEqual(chain);
    });

    it("returns a chain with time left as it is held", async () => {
      const root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
      const held = await issueIndexChain({
        issuer: root,
        to: cfKey.did(),
        held: [],
        nowSeconds: NOW,
      });
      await store.recordChain(cfKey.did(), held);
      expect(await chainForSigner(store, cfKey, NOW + 60)).toEqual(held);
    });

    it("returns undefined where no membership is recorded", async () => {
      expect(await chainForSigner(store, cfKey, NOW)).toBeUndefined();
    });
  });

  describe("adoptIndexChain()", () => {
    it("keeps a chain the root issued on another machine once the index answers for it", async () => {
      const root = await Identity.fromPassphrase("pattern-index access root");
      const index = new FakePatternIndex();
      index.admit(root.did(), "p-9");
      const chain = await issueIndexChain({
        issuer: root,
        to: secondMachine.did(),
        held: [],
      });
      const result = await adoptIndexChain({
        baseUrl: BASE,
        signer: secondMachine,
        store,
        fetchFn: index.fetchFn,
        chain,
      });
      expect(result).toMatchObject({ handle: "p-9", root: root.did() });
      expect(await store.chainFor(secondMachine.did())).toEqual(chain);
      expect(await store.rootKey()).toBeUndefined();
    });

    it("throws for a chain whose command is not exactly /index, keeping nothing", async () => {
      const root = await Identity.fromPassphrase("pattern-index access root");
      const broad = await issueDelegation(root, {
        aud: secondMachine.did(),
        sub: root.did(),
        cmd: "/",
        pol: [],
        exp: NOW + 60,
      });
      expect((await decodeDelegation(broad.bytes)).payload.cmd).toBe("/");
      await expect(adoptIndexChain({
        baseUrl: BASE,
        signer: secondMachine,
        store,
        fetchFn: new FakePatternIndex().fetchFn,
        chain: [broad.bytes],
      })).rejects.toThrow("/index");
      expect(await store.membership()).toBeUndefined();
    });
  });
});
