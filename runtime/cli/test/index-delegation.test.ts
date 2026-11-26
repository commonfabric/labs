import { expect } from "@std/expect";
import { decodeDelegation, Identity } from "@commonfabric/identity";
import {
  checkIndexChain,
  INDEX_ROOT_COMMAND,
  issueIndexChain,
} from "@commonfabric/pattern-index/membership";
import { issueIndexDelegation } from "../lib/index-delegation.ts";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const BASE = "https://index.test";
const cfKey = await Identity.fromPassphrase("index delegation cf");
const loom = await Identity.fromPassphrase("index delegation loom");
const elsewhereRoot = await Identity.fromPassphrase("index delegation root");

describe("index-delegation", () => {
  let dir: string;
  let store: PatternIndexStore;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    store = new PatternIndexStore(dir);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("issueIndexDelegation()", () => {
    it("issues a one-link /index chain from the kept root to the key named", async () => {
      const root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
      const issued = await issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      });
      expect(issued.chain).toHaveLength(1);
      expect(issued.root).toBe(root.did());
      const checked = await checkIndexChain(issued.chain, loom.did());
      expect(checked.root).toBe(root.did());
    });

    it("issues behind the identity's own chain where the root is kept elsewhere", async () => {
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: elsewhereRoot.did(),
      });
      await store.recordChain(
        cfKey.did(),
        await issueIndexChain({
          issuer: elsewhereRoot,
          to: cfKey.did(),
          held: [],
        }),
      );
      const issued = await issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      });
      expect(issued.chain).toHaveLength(2);
      expect(issued.root).toBe(elsewhereRoot.did());
    });

    it("issues a root move only from the kept root", async () => {
      const root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
      const issued = await issueIndexDelegation({
        kind: "root-move",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      });
      const move = await decodeDelegation(issued.chain[0]);
      expect(move.payload).toMatchObject({
        iss: root.did(),
        sub: root.did(),
        aud: loom.did(),
        cmd: INDEX_ROOT_COMMAND,
      });
    });

    it("throws for a root move where the root is not kept here", async () => {
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: elsewhereRoot.did(),
      });
      await expect(issueIndexDelegation({
        kind: "root-move",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      })).rejects.toThrow("Only the root moves the root");
    });

    it("issues from the kept root without an identity", async () => {
      const root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
      const issued = await issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        to: loom.did(),
        store,
      });
      expect(issued.root).toBe(root.did());
    });

    it("issues from the identity when a root move made it the root", async () => {
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: cfKey.did(),
      });
      const issued = await issueIndexDelegation({
        kind: "root-move",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      });
      const move = await decodeDelegation(issued.chain[0]);
      expect(move.payload.iss).toBe(cfKey.did());
      const member = await issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      });
      expect(member.chain).toHaveLength(1);
    });

    it("throws naming --identity where the root is kept elsewhere and no identity is named", async () => {
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: elsewhereRoot.did(),
      });
      await expect(issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        to: loom.did(),
        store,
      })).rejects.toThrow(
        "name the identity that issues behind its chain with --identity",
      );
    });

    it("throws where the root is kept elsewhere and the identity holds no chain from it", async () => {
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: elsewhereRoot.did(),
      });
      await expect(issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      })).rejects.toThrow(
        `${cfKey.did()} holds no chain to issue onward from`,
      );
    });

    it("throws before any join", async () => {
      await expect(issueIndexDelegation({
        kind: "member",
        baseUrl: BASE,
        identity: cfKey,
        to: loom.did(),
        store,
      })).rejects.toThrow("cf index join");
    });
  });
});
