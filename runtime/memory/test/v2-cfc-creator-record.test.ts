import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { taggedHashStringOf } from "@commonfabric/data-model";

import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { creatorRecordRefusal } from "../v2/cfc-creator-record.ts";
import {
  applyCommit,
  type ApplyCommitOptions,
  close,
  type Engine,
  open,
  read,
} from "../v2/engine.ts";
import { ProtocolError } from "../v2.ts";

const ALICE = "did:key:z6MkaliceAliceAliceAliceAliceAliceAliceAlice";
const BOB = "did:key:z6MkbobBobBobBobBobBobBobBobBobBobBobBobBobBo";
const SERVICE = "did:key:z6MkserviceServiceServiceServiceServiceSe";

describe("cfc-creator-record", () => {
  describe("creatorRecordRefusal()", () => {
    it("returns `undefined` for a record the session's principal is named in, where none is stored", () => {
      expect(creatorRecordRefusal(undefined, ALICE, ALICE)).toBeUndefined();
    });

    it("returns `undefined` where nothing is stored or proposed, or the stored record is kept", () => {
      expect(creatorRecordRefusal(undefined, undefined, BOB)).toBeUndefined();
      expect(creatorRecordRefusal(ALICE, ALICE, BOB)).toBeUndefined();
    });

    it("returns a reason for a new record naming anyone but the session's principal", () => {
      expect(creatorRecordRefusal(undefined, ALICE, BOB)).toMatch(
        /only its own principal/,
      );
      expect(creatorRecordRefusal(undefined, ALICE, undefined)).toMatch(
        /only its own principal/,
      );
      expect(creatorRecordRefusal(undefined, { did: BOB }, BOB)).toMatch(
        /only its own principal/,
      );
    });

    it("returns a reason for a stored record changed or removed, even by the principal it names", () => {
      expect(creatorRecordRefusal(ALICE, BOB, BOB)).toMatch(/once/);
      expect(creatorRecordRefusal(ALICE, undefined, ALICE)).toMatch(/once/);
    });
  });

  describe("a commit the engine applies", () => {
    let path: string;
    let engine: Engine;
    let localSeq: number;

    beforeEach(async () => {
      path = await Deno.makeTempFile({ suffix: ".sqlite" });
      engine = await open({ url: toFileUrl(path) });
      localSeq = 0;
    });

    afterEach(async () => {
      close(engine);
      await Deno.remove(path);
    });

    const commitAs = (
      principal: string,
      operations: unknown[],
      options: Partial<ApplyCommitOptions> = {},
    ) =>
      applyCommit(engine, {
        sessionId: "s:a",
        space: ALICE,
        principal,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        } as never,
        ...options,
      });

    const piece = "of:piece-result";
    const child = "of:child-result";
    const pointer = { identity: "pattern-a", symbol: "default" };

    const storedCreator = (id: string) =>
      (read(engine, { id }) as { creator?: unknown } | null)?.creator;

    const create = (id: string, creator: string) => ({
      op: "set",
      id,
      value: { value: {}, patternIdentity: pointer, creator },
    });

    it("commits a client's create of a piece recording its own principal", () => {
      commitAs(ALICE, [create(piece, ALICE)]);
      expect(storedCreator(piece)).toBe(ALICE);
    });

    it("commits a handler-placed child recording the creator of its producer, where that is the session's principal", () => {
      commitAs(ALICE, [create(piece, ALICE)]);
      commitAs(ALICE, [
        { op: "set", id: "of:receipt", value: { value: {} } },
        create(child, ALICE),
      ]);
      expect(storedCreator(child)).toBe(ALICE);
    });

    it("throws on a client's create of a piece recording another principal, by a set, a patch or a move", () => {
      expect(() => commitAs(BOB, [create(piece, ALICE)])).toThrow(
        ProtocolError,
      );
      commitAs(BOB, [{
        op: "set",
        id: piece,
        value: { value: { who: ALICE }, patternIdentity: pointer },
      }]);
      expect(() =>
        commitAs(BOB, [{
          op: "patch",
          id: piece,
          patches: [{ op: "add", path: "/creator", value: ALICE }],
        }])
      ).toThrow(/only its own principal/);
      expect(() =>
        commitAs(BOB, [{
          op: "patch",
          id: piece,
          patches: [{ op: "move", from: "/value/who", path: "/creator" }],
        }])
      ).toThrow(/only its own principal/);
      expect(() =>
        commitAs(BOB, [{
          op: "patch",
          id: piece,
          patches: [{
            op: "replace",
            path: "",
            value: { value: {}, patternIdentity: pointer, creator: ALICE },
          }],
        }])
      ).toThrow(/only its own principal/);
      expect(storedCreator(piece)).toBeUndefined();
    });

    it("throws on a client's child recording another principal's creator", () => {
      commitAs(ALICE, [create(piece, ALICE)]);
      expect(() => commitAs(BOB, [create(child, ALICE)])).toThrow(
        /only its own principal/,
      );
      expect(storedCreator(child)).toBeUndefined();
    });

    it("throws on a record in a user-scoped instance or a content-addressed document", () => {
      expect(() => commitAs(BOB, [{ ...create(piece, ALICE), scope: "user" }]))
        .toThrow(/only its own principal/);
      const content = { forged: true };
      expect(() =>
        commitAs(BOB, [{
          op: "set",
          id: `cid:${taggedHashStringOf(content)}`,
          value: { value: content, creator: ALICE },
        }])
      ).toThrow(/only its own principal/);
    });

    it("throws on a change or a removal of a stored record, by a set or a patch", () => {
      commitAs(ALICE, [create(piece, ALICE)]);
      expect(() => commitAs(BOB, [create(piece, BOB)])).toThrow(/once/);
      expect(() =>
        commitAs(ALICE, [{
          op: "set",
          id: piece,
          value: { value: {}, patternIdentity: pointer },
        }])
      ).toThrow(/once/);
      expect(() =>
        commitAs(BOB, [{
          op: "patch",
          id: piece,
          patches: [{ op: "replace", path: "/creator", value: BOB }],
        }])
      ).toThrow(/once/);
      expect(() =>
        commitAs(BOB, [{ op: "delete", id: piece }, create(piece, BOB)])
      ).toThrow(ProtocolError);
      expect(storedCreator(piece)).toBe(ALICE);
    });

    it("commits a write that keeps the stored record, and a delete of the document", () => {
      commitAs(ALICE, [create(piece, ALICE)]);
      commitAs(BOB, [{
        op: "set",
        id: piece,
        value: { value: { n: 1 }, patternIdentity: pointer, creator: ALICE },
      }]);
      commitAs(BOB, [{
        op: "patch",
        id: piece,
        patches: [{ op: "replace", path: "/value/n", value: 2 }],
      }]);
      expect(storedCreator(piece)).toBe(ALICE);
      commitAs(BOB, [{ op: "delete", id: piece }]);
      expect(read(engine, { id: piece })).toBeNull();
    });

    it("commits a served create the server makes for an acting user, and a child it places with its producer's creator", () => {
      const served = {
        delegated: { actingPrincipal: BOB, capabilityRef: "grant:test" },
      };
      commitAs(SERVICE, [create(piece, BOB)], served);
      commitAs(SERVICE, [create(child, ALICE)], served);
      expect(storedCreator(piece)).toBe(BOB);
      expect(storedCreator(child)).toBe(ALICE);
    });
  });
});
