import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { hashStringOf, taggedHashStringOf } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";
import {
  admitsDroppedDeclaredPaths,
  droppedDeclaredPaths,
} from "../v2/envelope-admission.ts";
import { ProtocolError } from "../v2.ts";

const OWNER = "did:key:z6MkownerOwnerOwnerOwnerOwnerOwnerOwnerOwner";
const OTHER = "did:key:z6MkotherOtherOtherOtherOtherOtherOtherOther";

const personalSpace = (owner: string) => ({
  type: CFC_ATOM_TYPE.PersonalSpace,
  owner,
});

const declared = (path: string[], confidentiality: unknown[]) => ({
  path,
  origin: "declared",
  label: { confidentiality },
});

const schema = { type: "object" } as const;
const schemaHash = internSchemaAsTaggedHashString(schema);

const envelope = (entries: unknown[]) => ({
  version: 1,
  schemaHash,
  labelMap: { version: 1, entries },
});

describe("envelope-admission", () => {
  describe("droppedDeclaredPaths()", () => {
    it("returns a stored declared path the proposal holds no declared entry at", () => {
      const stored = envelope([declared(["rooms"], [personalSpace(OTHER)])]);
      expect(droppedDeclaredPaths(stored, undefined, () => undefined))
        .toEqual([{ path: ["rooms"], clauses: [personalSpace(OTHER)] }]);
      expect(
        droppedDeclaredPaths(stored, envelope([]), () => undefined),
      ).toEqual([{ path: ["rooms"], clauses: [personalSpace(OTHER)] }]);
    });

    it("returns nothing for a stored member holding no label map, or no member at all", () => {
      expect(droppedDeclaredPaths(undefined, undefined, () => undefined))
        .toEqual([]);
      expect(droppedDeclaredPaths({ version: 1 }, undefined, () => undefined))
        .toEqual([]);
      expect(
        droppedDeclaredPaths(
          { version: 1, labelMap: { version: 1 } },
          undefined,
          () => undefined,
        ),
      ).toEqual([]);
    });

    it("joins the clauses of stored declared entries sharing a path, and returns `undefined` clauses when one of them doesn't resolve", () => {
      const joined = envelope([
        declared(["rooms"], [personalSpace(OWNER)]),
        declared(["rooms"], [personalSpace(OTHER)]),
      ]);
      expect(droppedDeclaredPaths(joined, undefined, () => undefined))
        .toEqual([{
          path: ["rooms"],
          clauses: [personalSpace(OWNER), personalSpace(OTHER)],
        }]);
      const unresolved = envelope([
        declared(["rooms"], [personalSpace(OWNER)]),
        { path: ["rooms"], origin: "declared", label: { $ref: "cid:gone" } },
        declared(["rooms"], [personalSpace(OTHER)]),
      ]);
      expect(droppedDeclaredPaths(unresolved, undefined, () => undefined))
        .toEqual([{ path: ["rooms"], clauses: undefined }]);
    });

    it("returns nothing for a path the proposal keeps a declared entry at, however lowered", () => {
      const stored = envelope([
        declared(["rooms"], [personalSpace(OTHER), personalSpace(OWNER)]),
      ]);
      const lowered = envelope([declared(["rooms"], [])]);
      expect(droppedDeclaredPaths(stored, lowered, () => undefined))
        .toEqual([]);
    });

    it("returns nothing for a stored declared entry holding no confidentiality clause", () => {
      const stored = envelope([{
        path: ["claimed"],
        origin: "declared",
        label: { integrity: ["writer-claim"] },
      }, { path: ["marker"], origin: "declared", label: {} }]);
      expect(droppedDeclaredPaths(stored, undefined, () => undefined))
        .toEqual([]);
    });

    it("returns nothing for entries of any other origin", () => {
      const stored = envelope(
        ["derived", "structure", "link", undefined].map((origin) => ({
          path: [],
          ...(origin === undefined ? {} : { origin }),
          observes: "shape",
          label: { confidentiality: [personalSpace(OTHER)] },
        })),
      );
      expect(droppedDeclaredPaths(stored, undefined, () => undefined))
        .toEqual([]);
    });

    it("returns the clauses of a label held by reference, and `undefined` for one that doesn't resolve or names no `cid:` document", () => {
      const label = { confidentiality: [personalSpace(OTHER)] };
      const stored = envelope([
        { path: ["a"], origin: "declared", label: { $ref: "cid:known" } },
        { path: ["b"], origin: "declared", label: { $ref: "cid:missing" } },
        { path: ["c"], origin: "declared", label: { $ref: "of:not-a-label" } },
      ]);
      expect(
        droppedDeclaredPaths(
          stored,
          undefined,
          (ref) =>
            ref === "cid:known" || ref === "of:not-a-label" ? label : undefined,
        ),
      ).toEqual([
        { path: ["a"], clauses: [personalSpace(OTHER)] },
        { path: ["b"], clauses: undefined },
        { path: ["c"], clauses: undefined },
      ]);
    });
  });

  describe("admitsDroppedDeclaredPaths()", () => {
    it("returns `true` for no drop", () => {
      expect(admitsDroppedDeclaredPaths([], "did:key:space", OTHER)).toBe(true);
    });

    it("returns `true` for the space owner dropping clauses that are theirs alone", () => {
      const dropped = [{
        path: ["rooms"],
        clauses: [personalSpace(OWNER), { anyOf: [OWNER] }],
      }];
      expect(admitsDroppedDeclaredPaths(dropped, OWNER, OWNER)).toBe(true);
    });

    it("returns `true` for a clause committing its owner field to the signer", () => {
      const committed = {
        type: CFC_ATOM_TYPE.PersonalSpace,
        owner: { digestOf: hashStringOf(OWNER) },
      };
      expect(
        admitsDroppedDeclaredPaths(
          [{ path: [], clauses: [committed] }],
          OWNER,
          OWNER,
        ),
      ).toBe(true);
    });

    it("returns `false` for the space owner dropping another principal's clause", () => {
      const dropped = [{ path: ["rooms"], clauses: [personalSpace(OTHER)] }];
      expect(admitsDroppedDeclaredPaths(dropped, OWNER, OWNER)).toBe(false);
    });

    it("returns `false` for an owner clause carrying a further field", () => {
      const scoped = { ...personalSpace(OWNER), scope: "rooms" };
      expect(
        admitsDroppedDeclaredPaths(
          [{ path: [], clauses: [scoped] }],
          OWNER,
          OWNER,
        ),
      ).toBe(false);
    });

    it("returns `false` for a drop outside the signer's home space", () => {
      const dropped = [{ path: [], clauses: [personalSpace(OWNER)] }];
      expect(admitsDroppedDeclaredPaths(dropped, "did:key:space", OWNER))
        .toBe(false);
    });

    it("returns `false` for a drop whose clauses didn't resolve, or with no actor", () => {
      expect(
        admitsDroppedDeclaredPaths(
          [{ path: [], clauses: undefined }],
          OWNER,
          OWNER,
        ),
      ).toBe(false);
      expect(
        admitsDroppedDeclaredPaths(
          [{ path: [], clauses: [personalSpace(OWNER)] }],
          undefined,
          undefined,
        ),
      ).toBe(false);
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
      principal: string | undefined,
      operations: unknown[],
    ) =>
      applyCommit(engine, {
        sessionId: "s:a",
        space: OWNER,
        ...(principal === undefined ? {} : { principal }),
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        } as never,
      });

    const id = "of:manager-result";

    const storedCfc = () =>
      (read(engine, { id }) as { cfc?: unknown } | null)?.cfc;

    const seed = (entries: unknown[], extra: unknown[] = []) => {
      commitAs(OWNER, [
        { op: "set", id: `cid:${schemaHash}`, value: { value: schema } },
        ...extra,
        {
          op: "set",
          id,
          value: { value: { rooms: [] }, cfc: envelope(entries) },
        },
      ]);
      return envelope(entries);
    };

    it("throws on a root write dropping the `cfc` member over another principal's declared clause", () => {
      const cfc = seed([declared(["rooms"], [personalSpace(OTHER)])]);
      expect(() =>
        commitAs(OWNER, [{
          op: "set",
          id,
          value: { value: { rooms: [] }, cfc: undefined },
        }])
      ).toThrow(ProtocolError);
      expect(storedCfc()).toEqual(cfc);
    });

    it("throws on a write leaving out a declared entry, and on a patch removing it", () => {
      const cfc = seed([
        declared(["rooms"], [personalSpace(OTHER)]),
        declared(["direct"], [personalSpace(OWNER)]),
      ]);
      expect(() =>
        commitAs(OWNER, [{
          op: "set",
          id,
          value: {
            value: { rooms: [] },
            cfc: envelope([declared(["direct"], [personalSpace(OWNER)])]),
          },
        }])
      ).toThrow(/no declared CFC label at \["rooms"\]/);
      expect(() =>
        commitAs(OWNER, [{
          op: "patch",
          id,
          patches: [{ op: "remove", path: "/cfc/labelMap/entries/0" }],
        }])
      ).toThrow(ProtocolError);
      expect(storedCfc()).toEqual(cfc);
    });

    it("throws on a drop of a label held by reference", () => {
      const label = { confidentiality: [personalSpace(OTHER)] };
      const labelHash = taggedHashStringOf(label);
      const cfc = seed(
        [{
          path: ["rooms"],
          origin: "declared",
          label: { $ref: `cid:${labelHash}` },
        }],
        [{ op: "set", id: `cid:${labelHash}`, value: { value: label } }],
      );
      expect(() =>
        commitAs(OWNER, [{ op: "set", id, value: { value: { rooms: [] } } }])
      ).toThrow(ProtocolError);
      expect(storedCfc()).toEqual(cfc);
    });

    it("throws on the space owner's drop when another principal signs it", () => {
      seed([declared(["rooms"], [personalSpace(OWNER)])]);
      expect(() =>
        commitAs(OTHER, [{ op: "set", id, value: { value: { rooms: [] } } }])
      ).toThrow(ProtocolError);
      expect(() =>
        commitAs(undefined, [{
          op: "set",
          id,
          value: { value: { rooms: [] } },
        }])
      ).toThrow(ProtocolError);
    });

    it("commits the space owner's drop of a clause that is theirs alone", () => {
      seed([
        declared(["rooms"], [personalSpace(OWNER)]),
        declared(["direct"], [personalSpace(OTHER)]),
      ]);
      const kept = envelope([declared(["direct"], [personalSpace(OTHER)])]);
      commitAs(OWNER, [{
        op: "set",
        id,
        value: { value: { rooms: [] }, cfc: kept },
      }]);
      expect(storedCfc()).toEqual(kept);
    });

    it("commits a write that carries the envelope forward, adds to it, or lowers a declared entry it keeps", () => {
      const cfc = seed([declared(["rooms"], [personalSpace(OTHER)])]);
      commitAs(OTHER, [{
        op: "set",
        id,
        value: { value: { rooms: ["a"] }, cfc },
      }]);
      const grown = envelope([
        declared(["rooms"], [personalSpace(OTHER)]),
        declared(["direct"], [personalSpace(OWNER)]),
      ]);
      commitAs(OTHER, [{
        op: "set",
        id,
        value: { value: { rooms: ["a"] }, cfc: grown },
      }]);
      const lowered = envelope([
        declared(["rooms"], []),
        declared(["direct"], [personalSpace(OWNER)]),
      ]);
      commitAs(OTHER, [{
        op: "set",
        id,
        value: { value: { rooms: ["a"] }, cfc: lowered },
      }]);
      expect(storedCfc()).toEqual(lowered);
    });

    it("throws on a delete and a re-creation in one commit", () => {
      const cfc = seed([declared(["rooms"], [personalSpace(OTHER)])]);
      expect(() =>
        commitAs(OWNER, [
          { op: "delete", id },
          {
            op: "patch",
            id,
            patches: [{ op: "add", path: "/value", value: { rooms: [] } }],
          },
        ])
      ).toThrow(ProtocolError);
      expect(() =>
        commitAs(OWNER, [
          { op: "delete", id },
          { op: "set", id, value: { value: { rooms: [] } } },
        ])
      ).toThrow(ProtocolError);
      expect(storedCfc()).toEqual(cfc);
    });

    it("commits a delete of the document", () => {
      seed([declared(["rooms"], [personalSpace(OTHER)])]);
      commitAs(OTHER, [{ op: "delete", id }]);
      expect(read(engine, { id })).toBeNull();
    });
  });
});
