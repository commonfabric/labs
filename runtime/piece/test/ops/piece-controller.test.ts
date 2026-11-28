import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getPatternIdentityRef,
  getPieceReconciliation,
  isLink,
  isStream,
  type JSONSchema,
  parseLinkOrThrow,
  type Pattern,
  PIECE_SOURCE_MOVED,
  Runtime,
  type RuntimeProgram,
  setPatternSource,
  setPieceReconciliation,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  cfcLabelViewForCell,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import {
  assertWritablePiecePath,
  currentValuePathContracts,
  durableSourceContract,
  isGatedReleaseStep,
  localizeWritableDestinationContracts,
  materializedValueAtPath,
  omitMissingProjectionAliases,
  PieceController,
  PieceSourceChangedError,
  pinnedSourceMoved,
} from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece controller edit");

/** A counter document; `n` is what the overlapping edits contend for. */
function counterProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ n?: number }>(({ n }) => ({",
        "  [NAME]: 'Counter',",
        "  n,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A piece whose input holds a `tally`, typed `tallyType`, beside a `note` of
 * its own.
 */
function tallyProgram(tallyType: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern, Writable } from 'commonfabric';",
        "interface Counter { count?: number }",
        "interface LabeledCounter { count?: number; label: string }",
        `interface Args { tally?: ${tallyType}; note?: string }`,
        "export default pattern<Args>(() => ({ [NAME]: 'Tally' }));",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A piece whose input holds an optional `seed` typed `seedType`, and whose
 * result is the one field `field`, so two such programs differ in both
 * schemas.
 */
function seedProgram(seedType: string, field: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        `export default pattern<{ seed?: ${seedType} }, { ${field}: number }>(`,
        `  () => ({ ${field}: 1 }),`,
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/** A piece reporting `version`, with its entry module named `main`. */
function versionProgram(version: string, main = "/main.tsx"): RuntimeProgram {
  return {
    main,
    files: [{
      name: main,
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }>(() => ({",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A stored legacy link envelope whose payload path is not an array: it reads
 * as a link, and parsing it throws.
 */
const MALFORMED_LINK = { "/": { "link@1": { path: 5 } } };

/** The confidentiality atom naming `owner`'s personal space. */
const personalSpaceOf = (owner: string) => ({
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner,
});

describe("piece-controller", () => {
  describe("edit()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let piece: PieceController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        }),
        runtime,
      );
      await pieces.synced();
      piece = await pieces.create(counterProgram(), { input: { n: 0 } });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    async function readN(): Promise<unknown> {
      const cell = await piece.input.getCell();
      await cell.pull();
      return (cell.getRaw({ lastNode: "value" }) as { n?: unknown }).n;
    }

    it("computes each overlapping edit from the then-current document", async () => {
      // Overlapping edits on one replica serialize rather than conflict
      // (an immediate transaction holds the local order), so the retry
      // path stays with editWithRetry's own contract for replica-behind
      // conflicts; what this proves is the property repair rests on —
      // every produce call answers for the document its commit sees, so
      // neither of two contending updates is lost.
      let runs = 0;
      const bump = () =>
        piece.input.edit((stored) => {
          runs += 1;
          const doc = stored as { n?: number };
          return { value: { n: (doc.n ?? 0) + 1 } };
        });
      await Promise.all([bump(), bump()]);
      expect(await readN()).toBe(2);
      expect(runs).toBe(2);
    });

    it("returns wrote: false and writes nothing for a no-write answer", async () => {
      const result = await piece.input.edit(() => undefined);
      expect(result).toEqual({ wrote: false });
      expect(await readN()).toBe(0);
    });

    it("hands produce the stored value and writes its answer", async () => {
      let seen: unknown;
      const result = await piece.input.edit((stored) => {
        seen = (stored as { n?: unknown }).n;
        return { value: { n: 7 } };
      });
      expect(result).toEqual({ wrote: true });
      expect(seen).toBe(0);
      expect(await readN()).toBe(7);
    });
  });

  describe("input.set() beside a stored link", () => {
    // A write to one input field validates the whole input it lands in. A
    // `Writable` slot holding a link is a handle, valid as a link whatever it
    // reaches, so the write neither judges nor reads what it reaches. Not
    // reading it keeps the linked document's labels off the field written.
    // A plain-typed slot's linked content is part of the input's value and is
    // still judged.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let space: string;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      space = await runtime.createSpace();
      pieces = new PiecesController(
        createSession({ identity: signer, spaceDid: space as never }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** A counter document holding `value`, with `count` labeled if asked. */
    async function counterHolding(
      name: string,
      value: Record<string, unknown>,
      labeled: boolean,
    ) {
      const counter = runtime.getCell<Record<string, unknown>>(
        space as never,
        name,
      );
      const id = counter.getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space as never);
      seedStoredEnvelope(seed, {
        space: space as never,
        scope: "space",
        id,
        path: [],
      }, {
        value: value as never,
        ...(labeled
          ? {
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: ["count"],
                  label: { confidentiality: [personalSpaceOf(space)] },
                }],
              },
            },
          }
          : {}),
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      return counter;
    }

    /** The confidentiality atoms stored for the input at `path`. */
    async function inputConfidentialityAt(
      piece: PieceController,
      path: string[],
    ): Promise<unknown[]> {
      const input = await piece.input.getCell();
      const link = input.getAsNormalizedFullLink();
      const entries = readStoredCfcMetadata(runtime.readTx(), link)?.labelMap
        .entries ?? [];
      return entries
        .filter((entry) =>
          entry.path.length === path.length &&
          entry.path.every((segment, index) => segment === path[index])
        )
        .flatMap((entry) => entry.label.confidentiality ?? []);
    }

    /**
     * The confidentiality atoms a read of the input at `path` reaches,
     * through whatever links the path lands on or crosses.
     */
    async function confidentialityReachedAt(
      piece: PieceController,
      path: string[],
    ): Promise<unknown[]> {
      const view = cfcLabelViewForCell(await piece.input.getCell(path));
      return (view?.entries ?? [])
        .filter((entry) => entry.path.length === 0)
        .flatMap((entry) => entry.label.confidentiality ?? []);
    }

    it("leaves the linked document's confidentiality off the field it writes", async () => {
      const counter = await counterHolding("labeled", { count: 3 }, true);
      const piece = await pieces.create(
        tallyProgram("Writable<Counter>"),
        { input: { tally: counter } },
      );

      await piece.input.set("hello", ["note"]);

      expect(await piece.input.get(["note"])).toBe("hello");
      expect(
        await inputConfidentialityAt(piece, ["note"]),
        "the write read the counter through the handle slot, and its " +
          "transaction carried the counter's label onto the written field",
      ).not.toContainEqual(personalSpaceOf(space));
      // The counter's label stays with the counter: the input document
      // stores none of it where it links the counter, and a read through
      // that link reaches it. So the atom the written field must not carry
      // is one a write that read through the handle slot would have carried.
      expect(await inputConfidentialityAt(piece, ["tally", "count"]))
        .toEqual([]);
      expect(await confidentialityReachedAt(piece, ["tally", "count"]))
        .toContainEqual(personalSpaceOf(space));
    });

    it("writes beside a link whose value the handle's schema refuses", async () => {
      const counter = await counterHolding(
        "wrong-type",
        { count: "seven" },
        false,
      );
      const piece = await pieces.create(
        tallyProgram("Writable<Counter>"),
        { input: { tally: counter } },
      );

      await piece.input.set("hello", ["note"]);

      expect(await piece.input.get(["note"])).toBe("hello");
    });

    it("still refuses a write beside a link that reaches a value of another type", async () => {
      const counter = runtime.getCell<unknown>(space as never, "other-type");
      const { error } = await runtime.editWithRetry((tx) => {
        counter.withTx(tx).set("seven");
      });
      expect(error).toBeUndefined();
      const piece = await pieces.create(
        tallyProgram("Writable<Counter>"),
        { input: { tally: counter } },
      );

      await expect(piece.input.set("hello", ["note"])).rejects.toThrow(
        "tally: value does not match type object",
      );
    });

    it("writes through a handle slot into the document its link reaches", async () => {
      // The write path's own positions stay materialized: what is written
      // there lands in the linked document, which is judged as written.
      // A piece's input is a destination with a durable contract, which a
      // write through a link requires. The required `label` beside the
      // written `count` is what the write's validation has to see.
      const owner = await pieces.create(tallyProgram("LabeledCounter"), {
        input: { tally: { label: "laps" } },
      });
      const counter = (await owner.input.getCell()).key("tally");
      const piece = await pieces.create(
        tallyProgram("Writable<LabeledCounter>"),
        { input: { tally: counter } },
      );

      await piece.input.set(5, ["tally", "count"]);

      expect(await owner.input.get(["tally"])).toEqual({
        label: "laps",
        count: 5,
      });
      await expect(piece.input.set("five", ["tally", "count"])).rejects
        .toThrow("count: value does not match type number");
    });

    it("still refuses a write beside a plain-typed link to that value", async () => {
      const counter = await counterHolding(
        "wrong-type-plain",
        { count: "seven" },
        false,
      );
      const piece = await pieces.create(
        tallyProgram("Counter"),
        { input: { tally: counter } },
      );

      await expect(piece.input.set("hello", ["note"])).rejects.toThrow(
        "count: value does not match type number",
      );
    });
  });

  describe("pinnedSourceMoved()", () => {
    const pinned = { identity: "idA", symbol: "Member" };

    it("translates the transition layer's stale-source failure for a pinned write", () => {
      // The window's second half: this guard fires inside the transaction
      // that commits, and throws the runtime's generic error. A pinned
      // caller has to read it as a row to refuse, not as an operational
      // failure of unknown state.
      const translated = pinnedSourceMoved(
        new Error(PIECE_SOURCE_MOVED),
        pinned,
      );
      expect(translated).toBeInstanceOf(PieceSourceChangedError);
      expect((translated as Error).message).toContain("moved off idA#Member");
    });

    it("leaves the same failure alone when the caller pinned nothing", () => {
      // Without a pin there is no proved reference to name, and the caller
      // asked for no such guarantee.
      const error = new Error(PIECE_SOURCE_MOVED);
      expect(pinnedSourceMoved(error, undefined)).toBe(error);
    });

    it("passes every other failure through untouched", () => {
      // Translating on anything but this message would turn real breakage
      // into a refusal and hide it.
      const error = new Error("the runtime would not shut down");
      expect(pinnedSourceMoved(error, pinned)).toBe(error);
    });
  });

  describe("write contracts", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let space: string;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      space = await runtime.createSpace();
      pieces = new PiecesController(
        createSession({ identity: signer, spaceDid: space as never }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** A fresh document holding `value` as stored. */
    async function documentHolding(name: string, value: unknown) {
      const cell = runtime.getCell<unknown>(
        space as never,
        `${name}-${crypto.randomUUID()}`,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).setRawUntyped(value as never);
      });
      expect(error).toBeUndefined();
      return cell;
    }

    /**
     * Stores `value` as `cell`'s document value as given, beneath the Cell
     * layer, which refuses to write a link it cannot parse.
     */
    async function storeRaw(cell: Cell<unknown>, value: unknown) {
      const { id } = cell.getAsNormalizedFullLink();
      const tx = runtime.edit();
      tx.writeOrThrow(
        { space: space as never, scope: "space", id, path: ["value"] },
        value as never,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    }

    /** Runs `pattern`, trusted as a fixture, as a started piece. */
    async function runFixture(pattern: Pattern, input: unknown = {}) {
      const piece = await pieces.runPersistent(
        runtime.unsafeTrustPattern(pattern, {
          reason: "piece controller write contract fixture",
        }),
        input as never,
        undefined,
        { start: true },
      );
      return { piece, controller: new PieceController(pieces, piece) };
    }

    it("reads a materialized path through Cells and stops at a Stream", async () => {
      const counter = await documentHolding("counter", { count: 3 });
      const events = runtime.getCell<unknown>(
        space as never,
        `events-${crypto.randomUUID()}`,
        { asCell: ["stream"] } as JSONSchema,
      );
      expect(isStream(events)).toBe(true);

      expect(materializedValueAtPath({ counter }, ["counter", "count"]))
        .toBe(3);
      expect(materializedValueAtPath({ events }, ["events"])).toBe(events);
    });

    it("localizes a boolean contract to itself at any child", () => {
      for (const schema of [true, false]) {
        expect(
          currentValuePathContracts(
            { schema, root: schema },
            "value",
            { value: 1 },
            { value: 2 },
          ),
        ).toEqual([{ schema, root: schema }]);
      }
      const object: JSONSchema = {
        type: "object",
        properties: { value: { type: "number" } },
      };
      expect(
        currentValuePathContracts(
          { schema: object, root: object },
          "value",
          { value: 1 },
          { value: 2 },
        ).map((contract) => contract.schema),
      ).toEqual([{ type: "number" }]);
    });

    it("keeps the current value's oneOf branch only when the value selects one", () => {
      const branch = (type: "number" | "string"): JSONSchema => ({
        type: "object",
        properties: { value: { type } },
        required: ["value"],
      });
      const oneOf: JSONSchema = { oneOf: [branch("number"), branch("string")] };
      const contracts = (current: unknown) =>
        currentValuePathContracts(
          { schema: oneOf, root: oneOf },
          "value",
          current,
          { value: 2 },
        ).map((contract) => contract.schema);

      // The staged value selects the number branch; a current value in the
      // string branch keeps that branch's contract too, and one in neither
      // adds nothing.
      expect(contracts({ value: "two" })).toEqual([
        true,
        { type: "number" },
        { type: "string" },
      ]);
      expect(contracts({ value: true })).toEqual([true, { type: "number" }]);
    });

    it("lets a terminal write land in a plain slot and refuses a readonly one", async () => {
      const base = await documentHolding("plain-slot", { value: 1 });
      const slot = (value: JSONSchema): JSONSchema => ({
        type: "object",
        properties: { value },
      });

      expect(() =>
        assertWritablePiecePath(
          slot({ type: "number" }),
          ["value"],
          false,
          true,
          base,
        )
      ).not.toThrow();
      expect(() =>
        assertWritablePiecePath(
          slot({ type: "number", asCell: ["readonly"] }),
          ["value"],
          false,
          true,
          base,
        )
      ).toThrow("readonly Cell path is not writable");
    });

    it("treats a stored link that does not parse as an opaque Cell handle", async () => {
      // A union offering a readonly Cell beside a plain number is decided by
      // what is stored: a write redirect is an ordinary alias, so the plain
      // number applies, and any other link is a Cell handle, so the readonly
      // wrapper does. A link that does not parse grants nothing, so it is
      // judged as a handle.
      const target = await documentHolding("redirect-target", 1);
      const base = runtime.getCell<unknown>(
        space as never,
        `stored-links-${crypto.randomUUID()}`,
      );
      const redirect = target.getAsWriteRedirectLink({ base });
      await storeRaw(base, { malformed: MALFORMED_LINK, redirect });
      const stored = base.getRawUntyped({ lastNode: "top" }) as {
        malformed: unknown;
      };
      expect(isLink(stored.malformed)).toBe(true);
      expect(() => parseLinkOrThrow(stored.malformed, base)).toThrow();

      const union: JSONSchema = {
        anyOf: [{ type: "number", asCell: ["readonly"] }, { type: "number" }],
      };
      const at = (field: string): JSONSchema => ({
        type: "object",
        properties: { [field]: union },
      });
      expect(() =>
        assertWritablePiecePath(
          at("malformed"),
          ["malformed"],
          false,
          true,
          base,
        )
      ).toThrow("readonly Cell path is not writable");
      expect(() =>
        assertWritablePiecePath(at("redirect"), ["redirect"], false, true, base)
      ).not.toThrow();
    });

    it("refuses a write destination whose Cell alternatives disagree", async () => {
      const root = await documentHolding("destination", { value: 1 });
      const destination = (alternatives: JSONSchema[]) => {
        const schema: JSONSchema = {
          type: "object",
          properties: { value: { anyOf: alternatives } },
        };
        return {
          root: schema,
          path: ["value"],
          rawBasePath: [],
          schemaBaseDepth: 0,
          validationCell: root,
          validationPath: ["value"],
        };
      };

      expect(() =>
        localizeWritableDestinationContracts(
          destination([
            { type: "number", asCell: ["cell"] },
            { type: "number", asCell: ["readonly"] },
          ]),
          root,
          2,
        )
      ).toThrow("Cell alternatives expose incompatible outer capabilities");
      expect(
        localizeWritableDestinationContracts(
          destination([
            { type: "number", asCell: ["cell"] },
            { type: "integer", asCell: ["cell"] },
          ]),
          root,
          2,
        ).declaredStream,
      ).toBe(false);
    });

    it("reports a missing alias target only where no schema view was present", async () => {
      const base = runtime.getCell<unknown>(
        space as never,
        `alias-base-${crypto.randomUUID()}`,
      );
      const missing = runtime.getCell<unknown>(
        space as never,
        `alias-missing-${crypto.randomUUID()}`,
      );
      const present = await documentHolding("alias-present", 7);
      const linkTo = (target: typeof base) =>
        target.getAsLink({ base, includeSchema: false });
      const tx = runtime.edit();
      const reconcile = (raw: unknown, schemaViewPresent: boolean) =>
        omitMissingProjectionAliases(
          undefined,
          raw,
          undefined,
          base.withTx(tx),
          pieces,
          schemaViewPresent,
        );
      try {
        // Where the schema view was read, the absent target leaves the
        // materialization as it was; only an alias whose view is absent too
        // is reported missing, so a containing object drops it.
        expect(reconcile(linkTo(missing), true)).toBeUndefined();
        expect(typeof reconcile(linkTo(missing), false)).toBe("symbol");
        expect(reconcile(linkTo(present), false)).toBeUndefined();
      } finally {
        await tx.commit().settled;
      }
    });

    it("skips a result alias that does not parse when collecting projections", async () => {
      const { piece } = await runFixture({
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {
          type: "object",
          properties: { output: { type: "number" } },
        },
        derivedInternalCells: [{ partialCause: "output" }],
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [{
          module: {
            type: "javascript",
            implementation: (input: number) => input * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        }],
      }, { input: 5 });
      const internal = piece.key("output").resolveAsCell();
      const projections = () =>
        durableSourceContract(internal, pieces)!.schemas.map((entry) =>
          entry.validationPath
        );
      const before = projections();
      expect(before).toContainEqual(["output"]);
      const rawResult = piece.getRawUntyped({ lastNode: "top" }) as Record<
        string,
        unknown
      >;

      await storeRaw(piece, { ...rawResult, broken: MALFORMED_LINK });
      expect(projections()).toEqual(before);

      await storeRaw(piece, {
        ...rawResult,
        broken: MALFORMED_LINK,
        mirror: rawResult.output,
      });
      expect(projections()).toEqual([...before, ["mirror"]]);
    });

    it("refuses a nested result write that leaves an array below its minItems", async () => {
      const { piece, controller } = await runFixture({
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "number" }, minItems: 2 },
          },
        },
        result: { items: [] },
        nodes: [],
      });
      const items = () => (piece.getRaw() as { items?: number[] }).items;

      await expect(controller.result.set(1, ["items", "0"])).rejects.toThrow(
        /updated value does not match its container at \["items"\]/,
      );
      expect(items()).toEqual([]);

      await controller.result.set([1, 2], ["items"]);
      await controller.result.set(5, ["items", "0"]);
      expect(items()).toEqual([5, 2]);
    });

    it("validates a write under a correlated union against the whole result", async () => {
      // The written field's contract depends on its sibling, so the write is
      // judged by the result it leaves behind.
      const { piece, controller } = await runFixture({
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { kind: { type: "string" }, value: {} },
          anyOf: [
            {
              properties: {
                kind: { const: "number" },
                value: { type: "number" },
              },
            },
            {
              properties: {
                kind: { const: "text" },
                value: { type: "string" },
              },
            },
          ],
        },
        result: { kind: "number", value: 1 },
        nodes: [],
      });
      const value = () => (piece.getRaw() as { value?: unknown }).value;

      await controller.result.set(2, ["value"]);
      expect(value()).toBe(2);
      await expect(controller.result.set("two", ["value"])).rejects.toThrow(
        /updated result does not match its schema/,
      );
      expect(value()).toBe(2);
    });

    it("refuses to control a cell that names no entity", async () => {
      const blank = runtime.getCellFromLink({
        space: space as never,
        id: "of:",
        path: [],
      });
      expect(() => new PieceController(pieces, blank)).toThrow(
        "Could not get an ID from a Cell<Piece>",
      );
      const piece = await pieces.create(counterProgram(), { input: { n: 0 } });
      expect(new PieceController(pieces, piece.getCell()).id).toBe(piece.id);
    });

    it("refuses to read the source program of a cell running no pattern", async () => {
      const plain = await documentHolding("plain", { n: 0 });
      await expect(
        new PieceController(pieces, plain).getPatternSourceProgram(),
      ).rejects.toThrow("piece missing pattern identity");
      const piece = await pieces.create(counterProgram(), { input: { n: 0 } });
      expect((await piece.getPatternSourceProgram())?.main).toBe("/main.tsx");
    });
  });

  describe("source and input changes", () => {
    const route = "/api/patterns/served.tsx";
    let served: RuntimeProgram | undefined;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      served = undefined;
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        // The patterns route serves `served` at `route`, and states no
        // release time for anything.
        fetch: (input) => {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          const entry = served?.files.find((file) =>
            file.name === served?.main
          );
          return Promise.resolve(
            url.pathname !== route || url.searchParams.has("identity") ||
              entry === undefined
              ? new Response("not found", { status: 404 })
              : new Response(entry.contents, {
                status: 200,
                headers: { "content-type": "text/typescript-jsx" },
              }),
          );
        },
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /**
     * Has the pattern manager repoint `piece` at `ref` as its `call`th pattern
     * load returns, as a source change landing during that load would.
     * Returns the restore.
     */
    function repointDuringLoad(
      piece: PieceController,
      ref: { identity: string; symbol: string },
      call: number,
    ): () => void {
      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      let loads = 0;
      manager.loadPatternByIdentity = async (...args) => {
        const pattern = await load(...args);
        if (++loads === call) {
          const tx = runtime.edit();
          piece.getCell().withTx(tx).setMetaRaw(
            "patternIdentity",
            { ...ref },
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        return pattern;
      };
      return () => {
        manager.loadPatternByIdentity = load;
      };
    }

    /** Compiles `program` into the space, and its entry reference. */
    async function compiled(program: RuntimeProgram) {
      const pattern = await runtime.patternManager.compilePattern(program, {
        space: pieces.getSpace(),
      });
      return {
        pattern,
        ref: runtime.patternManager.getArtifactEntryRef(pattern)!,
      };
    }

    it("prepares nothing for an origin that offers what the piece runs", async () => {
      const origin = "system:served.tsx";
      served = versionProgram("served");
      const piece = await pieces.create(versionProgram("running"), {
        input: {},
      });
      const stamped = await runtime.editWithRetry((tx) => {
        setPatternSource(piece.getCell(), tx, origin);
      });
      expect(stamped.error).toBeUndefined();

      expect((await piece.prepareSourceChange({ kind: "adopt" })).status)
        .toBe("prepared");
      expect(await piece.changeSource({ kind: "adopt" })).toEqual({
        status: "applied",
      });
      expect(await piece.prepareSourceChange({ kind: "adopt" })).toEqual({
        status: "current",
      });
      expect(getPieceReconciliation(piece.getCell())).toMatchObject({
        outcome: "followed",
        origin,
      });
    });

    /** A `system:` origin for `route`, and a fabric origin, which has none. */
    const STEP_ORIGINS = {
      system: "system:served.tsx",
      fabric: "cf:pattern:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };

    it("gates only a later release of the system route the piece runs", async () => {
      const piece = await pieces.create(versionProgram("running", route), {
        input: {},
      });
      const running = getPatternIdentityRef(piece.getCell())!;
      const releasedAt = Date.UTC(2026, 9, 16);
      const confirmed = await runtime.editWithRetry((tx) => {
        setPieceReconciliation(piece.getCell(), tx, {
          outcome: "followed",
          at: releasedAt,
          origin: STEP_ORIGINS.system,
          confirmed: { identity: running.identity, releasedAt },
        });
      });
      expect(confirmed.error).toBeUndefined();
      const step = (origin: string, at: number, symbol = "default") =>
        isGatedReleaseStep(pieces, running, piece.getCell(), {
          candidate: { identity: "candidate", symbol },
          origin,
          releasedAt: at,
        });

      expect(await step(STEP_ORIGINS.system, releasedAt + 1)).toBe(true);
      expect(await step(STEP_ORIGINS.system, releasedAt)).toBe(false);
      expect(await step(STEP_ORIGINS.system, releasedAt + 1, "other"))
        .toBe(false);
      expect(await step("system:other.tsx", releasedAt + 1)).toBe(false);
      // A fabric origin names no patterns route, and neither does an origin
      // that is not one at all.
      expect(await step(STEP_ORIGINS.fabric, releasedAt + 1)).toBe(false);
      expect(await step(" ", releasedAt + 1)).toBe(false);
      // A failure classifying the origin, other than its refusal, is raised.
      {
        using _host = stub(runtime, "hostForSpace", () => {
          throw new Error("no host serves the space");
        });
        await expect(step(STEP_ORIGINS.system, releasedAt + 1)).rejects
          .toThrow("no host serves the space");
        expect(await step(" ", releasedAt + 1)).toBe(false);
      }

      // A running source the space does not retain was compiled from no
      // route, so no origin's route is its own.
      const unretained = { identity: "unretained", symbol: "default" };
      const reconfirmed = await runtime.editWithRetry((tx) => {
        setPieceReconciliation(piece.getCell(), tx, {
          outcome: "followed",
          at: releasedAt,
          origin: STEP_ORIGINS.system,
          confirmed: { identity: unretained.identity, releasedAt },
        });
      });
      expect(reconfirmed.error).toBeUndefined();
      for (const origin of [STEP_ORIGINS.system, STEP_ORIGINS.fabric, " "]) {
        expect(
          await isGatedReleaseStep(pieces, unretained, piece.getCell(), {
            candidate: { identity: "candidate", symbol: "default" },
            origin,
            releasedAt: releasedAt + 1,
          }),
        ).toBe(false);
      }
    });

    it("retries an input update against the pattern that replaced the one it was checked against", async () => {
      const piece = await pieces.create(seedProgram("number", "a"), {
        input: {},
      });
      const replacement = await compiled(seedProgram("string", "b"));
      await expect(piece.setInput({ seed: "text" })).rejects.toThrow(
        /updated arguments do not match the candidate schema/,
      );

      // The update reads the running pattern, during which the piece is
      // repointed, so the input is checked against what it no longer runs.
      const restore = repointDuringLoad(piece, replacement.ref, 1);
      try {
        await piece.setInput({ seed: "text" });
      } finally {
        restore();
      }

      expect(getPatternIdentityRef(piece.getCell())).toEqual(replacement.ref);
      expect(await piece.input.get(["seed"])).toBe("text");
    });

    it("reloads the schema of the pattern that replaced the one a failed update read", async () => {
      const piece = await pieces.create(seedProgram("number", "a"), {
        input: {},
      });
      const original = await compiled(seedProgram("number", "a"));
      const replacement = await compiled(seedProgram("boolean", "b"));
      expect(piece.getCell().getAsNormalizedFullLink().schema).toEqual(
        original.pattern.resultSchema,
      );

      // The update reads the running pattern and fails; the reload after it
      // reads that pattern again, during which the piece is repointed.
      const restore = repointDuringLoad(piece, replacement.ref, 2);
      try {
        await expect(piece.setInput({ seed: "text" })).rejects.toThrow(
          /updated arguments do not match the candidate schema/,
        );
      } finally {
        restore();
      }

      expect(piece.getCell().getAsNormalizedFullLink().schema).toEqual(
        replacement.pattern.resultSchema,
      );
    });
  });
});
