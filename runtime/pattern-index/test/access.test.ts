import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  decodeDelegation,
  Identity,
  issueDelegation,
} from "@commonfabric/identity";
import {
  checkIndexChain,
  DEFAULT_SIGNER_LINK_SECONDS,
  issueIndexChain,
  issueRootMove,
} from "../src/membership.ts";
import { chainForSigner, resolvePatternIndexUrl } from "../src/access.ts";
import {
  adoptIndexChain,
  joinPatternIndex,
  moveMembershipRoot,
  parseInviteLink,
} from "../src/join.ts";
import { PatternIndexStore } from "../src/store.ts";
import { FakePatternIndex } from "./fake-pattern-index.ts";

const BASE = "https://index.test";
const NOW = Math.floor(Date.now() / 1000);
const cfKey = await Identity.fromPassphrase("pattern-index access cf");
const secondMachine = await Identity.fromPassphrase(
  "pattern-index access laptop",
);
const LINK =
  "https://fbrc.social/index-join?invite=inv1&inviter=p-admin#code=secret-code";

describe("access", () => {
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

    it("records the membership of a kept root whose redemption landed unanswered, redeeming nothing", async () => {
      const root = await store.createRootKey();
      const index = new FakePatternIndex();
      index.admit(root.did(), "p-5");
      const result = await joinPatternIndex({
        baseUrl: BASE,
        signer: cfKey,
        store,
        fetchFn: index.fetchFn,
        invite: parseInviteLink(LINK),
      });
      expect(result).toMatchObject({ handle: "p-5", root: root.did() });
      expect(index.calls.some((call) => call.fn === "redeemInvite")).toBe(
        false,
      );
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
      expect(checked.signerLinkExpires).toBe(NOW + DEFAULT_SIGNER_LINK_SECONDS);
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

  describe("moveMembershipRoot()", () => {
    it("moves the member to the signing key and records it as the root here", async () => {
      const oldRoot = await Identity.fromPassphrase("access move old root");
      const index = new FakePatternIndex();
      index.admit(oldRoot.did(), "p-3");
      const move = await issueRootMove({ root: oldRoot, to: cfKey.did() });
      const result = await moveMembershipRoot({
        baseUrl: BASE,
        signer: cfKey,
        store,
        fetchFn: index.fetchFn,
        rootDelegation: move.bytes,
      });
      expect(result).toMatchObject({ handle: "p-3", root: cfKey.did() });
      expect((await store.membership())!.root).toBe(cfKey.did());
      expect(await chainForSigner(store, cfKey, NOW)).toBeUndefined();
    });

    it("throws for an /index delegation, which never moves a root", async () => {
      const oldRoot = await Identity.fromPassphrase("access move old root");
      const [link] = await issueIndexChain({
        issuer: oldRoot,
        to: cfKey.did(),
        held: [],
      });
      await expect(moveMembershipRoot({
        baseUrl: BASE,
        signer: cfKey,
        store,
        fetchFn: new FakePatternIndex().fetchFn,
        rootDelegation: link,
      })).rejects.toThrow("does not move a root");
      expect(await store.membership()).toBeUndefined();
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

    it("throws for a chain rooted elsewhere than the membership already recorded", async () => {
      const mine = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: mine.did(),
      });
      const other = await Identity.fromPassphrase("pattern-index access root");
      const chain = await issueIndexChain({
        issuer: other,
        to: secondMachine.did(),
        held: [],
      });
      await expect(adoptIndexChain({
        baseUrl: BASE,
        signer: secondMachine,
        store,
        fetchFn: new FakePatternIndex().fetchFn,
        chain,
      })).rejects.toThrow("already holds a membership");
      expect((await store.membership())!.root).toBe(mine.did());
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
