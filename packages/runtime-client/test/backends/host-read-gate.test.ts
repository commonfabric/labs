/**
 * The host-read gate's decisions, made for a viewer under the shell's default
 * display ceiling with the resolver and providers a worker builds for that
 * viewer, over documents the owner wrote and labeled. Every value the visitor
 * may not see carries a string that appears nowhere else, so a search of an
 * answer for it is a search for the value having escaped.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { rootRenderPolicyFor } from "@commonfabric/html/worker";
import { Identity } from "@commonfabric/identity";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import { type Cell, KeepAsCell, NAME, Runtime } from "@commonfabric/runner";
import { nameSchema, stringSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import { HostReadGate } from "@/backends/host-read-gate.ts";
import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
} from "@/backends/runtime-processor.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellUpdateNotification } from "@/protocol/mod.ts";

const owner = await Identity.fromPassphrase("host read gate owner");
const visitor = await Identity.fromPassphrase("host read gate visitor");
const space = owner.did();
const ownerOnly = cfcAtom.user(owner.did());

const SEALED_ENTRY = "entry-behind-the-seal";
const OWNER_ONLY_NOTE = "owner-only-margin-note";
const SEALED_NAME = "name-behind-the-seal";
const SEALED_RENAME = "second-name-behind-the-seal";
const SEALED_INTERNAL = "internal-state-behind-the-seal";
const HOME_NAME = "name-for-members-of-the-owner-space";

type Labels = readonly [path: string[], confidentiality: readonly CfcAtom[]][];

/** The documents every case reads, and the runtime holding them. */
async function shelf() {
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  /** Writes `value` beside `meta`, labeling each path in `labels`. */
  const write = async (
    id: string,
    value: unknown,
    labels: Labels = [],
    meta: Record<string, unknown> = {},
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, id, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space,
      id: cell.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value,
      ...meta,
      ...(labels.length === 0 ? {} : {
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: labels.map(([path, confidentiality]) => ({
              path,
              label: { confidentiality },
            })),
          },
        },
      }),
    } as FabricValue);
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell(space, id);
  };
  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  const sealedEntry = await write("sealed-entry", SEALED_ENTRY, [[
    [],
    [ownerOnly],
  ]]);
  // A piece anyone may see but for one entry, a document of its own.
  const piece = await write("piece", {
    [NAME]: "Shared piece",
    entry: link(sealedEntry),
  });
  // A piece whose sealed entry sits one level inside an untyped field.
  const nestedPiece = await write("nested-piece", {
    [NAME]: "Nested piece",
    entry: { inner: link(sealedEntry) },
  });
  // A piece whose whole document only its owner may see.
  const sealedPiece = await write(
    "sealed-piece",
    { [NAME]: SEALED_NAME },
    [[[], [ownerOnly]]],
    { internal: { note: SEALED_INTERNAL } },
  );
  // A piece one of whose fields only its owner may see.
  const notedPiece = await write(
    "noted-piece",
    { [NAME]: "Noted piece", note: OWNER_ONLY_NOTE },
    [[["note"], [ownerOnly]]],
    { internal: { cache: SEALED_INTERNAL } },
  );
  const publicPiece = await write("public-piece", {
    [NAME]: "Public piece",
    entry: "public entry",
  });
  // A piece labeled with the owner's space, which only the exchange rules
  // resolve, for a member of that space.
  const homePiece = await write(
    "home-piece",
    { [NAME]: HOME_NAME },
    [[[], [cfcAtom.space(space)]]],
  );
  await runtime.idle();

  return {
    runtime,
    write,
    sealedEntry,
    piece,
    nestedPiece,
    sealedPiece,
    notedPiece,
    publicPiece,
    homePiece,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** The gate a worker builds for `viewer`, under the shell's default ceiling. */
function gateFor(runtime: Runtime, viewer: Identity): HostReadGate {
  const ceiling = defaultRenderConfidentialityCeiling(viewer.did());
  const membership = renderMembershipProviderFor(runtime, viewer, ceiling);
  const modulePolicies = renderModulePolicySourceFor(runtime, ceiling);
  return new HostReadGate(rootRenderPolicyFor(ceiling), {
    resolveConfidentiality: renderConfidentialityResolverFor(
      runtime,
      viewer,
      ceiling,
      viewer.did(),
      membership,
      modulePolicies,
    ),
    membership,
    modulePolicies,
  });
}

/** Whether `text` appears anywhere in `answer`. */
function holds(answer: unknown, text: string): boolean {
  return JSON.stringify(answer ?? null).includes(text);
}

/** Subscribes through `gate`, keeping every update it delivers. */
function subscribe(gate: HostReadGate, cell: Cell<unknown>) {
  const updates: CellUpdateNotification[] = [];
  const cancel = gate.subscribe(
    cell,
    createCellRef(cell),
    {},
    () => {},
    (u) => {
      updates.push(u);
    },
  );
  return { updates, cancel };
}

describe("HostReadGate", () => {
  describe("read()", () => {
    it("refuses a visitor a piece that links to a sealed entry, returning no value", async () => {
      await using docs = await shelf();
      const answer = gateFor(docs.runtime, visitor).read(
        docs.piece.asSchema(true),
      );

      expect(holds(answer, SEALED_ENTRY)).toBe(false);
      expect(answer).toEqual({ refused: { refusedBy: "display-ceiling" } });
    });

    for (const untyped of [{}, true] as const) {
      it(
        `refuses a visitor a sealed entry inside a field typed \`${
          JSON.stringify(untyped)
        }\``,
        async () => {
          await using docs = await shelf();
          const answer = gateFor(docs.runtime, visitor).read(
            docs.nestedPiece.asSchema({
              type: "object",
              properties: { [NAME]: { type: "string" }, entry: untyped },
            }),
          );

          expect(holds(answer, SEALED_ENTRY)).toBe(false);
          expect("refused" in answer).toBe(true);
        },
      );
    }

    for (
      const [reader, schema] of [
        ["the shell's title", stringSchema],
        ["the piece list", nameSchema],
      ] as const
    ) {
      it(`refuses a visitor a sealed piece's \`[NAME]\`, as ${reader} reads it`, async () => {
        await using docs = await shelf();
        const target = reader === "the shell's title"
          ? docs.sealedPiece.key(NAME).asSchema(schema)
          : docs.sealedPiece.asSchema(schema);
        const answer = gateFor(docs.runtime, visitor).read(target);

        expect(holds(answer, SEALED_NAME)).toBe(false);
        expect("refused" in answer).toBe(true);
      });
    }

    it("returns a visitor the `[NAME]` of a piece holding a sealed entry", async () => {
      await using docs = await shelf();
      const answer = gateFor(docs.runtime, visitor).read(
        docs.piece.asSchema(nameSchema),
      );

      expect(answer).toEqual({ value: { [NAME]: "Shared piece" } });
    });

    it("returns a visitor the whole of a piece anyone may see", async () => {
      await using docs = await shelf();
      const answer = gateFor(docs.runtime, visitor).read(
        docs.publicPiece.asSchema(true),
      );

      expect(answer).toEqual({
        value: { [NAME]: "Public piece", entry: "public entry" },
      });
    });

    it("returns the owner their own sealed piece and linked entry", async () => {
      await using docs = await shelf();
      const gate = gateFor(docs.runtime, owner);

      expect(gate.read(docs.piece.asSchema(true))).toEqual({
        value: expect.objectContaining({ entry: SEALED_ENTRY }),
      });
      expect(gate.read(docs.sealedPiece.key(NAME).asSchema(stringSchema)))
        .toEqual({ value: SEALED_NAME });
    });

    it("returns the owner a value labeled with their space, which only the exchange rules admit", async () => {
      await using docs = await shelf();
      const answer = gateFor(docs.runtime, owner).read(
        docs.homePiece.key(NAME).asSchema(stringSchema),
      );

      expect(answer).toEqual({ value: HOME_NAME });
    });

    it("refuses a visitor who is no member of the space the same value", async () => {
      await using docs = await shelf();
      const answer = gateFor(docs.runtime, visitor).read(
        docs.homePiece.key(NAME).asSchema(stringSchema),
      );

      expect(holds(answer, HOME_NAME)).toBe(false);
      expect("refused" in answer).toBe(true);
    });

    it("returns a stream as the link it names", async () => {
      await using docs = await shelf();
      const stream = docs.runtime.getCell(space, "a-stream", {
        asCell: ["stream"],
      });
      const answer = gateFor(docs.runtime, visitor).read(stream);

      expect(answer).toEqual({
        value: expect.objectContaining({ "/": expect.anything() }),
      });
    });

    it("returns every read as read with no policy", async () => {
      await using docs = await shelf();
      const answer = new HostReadGate(undefined, {}).read(
        docs.piece.asSchema(true),
      );

      expect(holds(answer, SEALED_ENTRY)).toBe(true);
    });
  });

  describe("readMetadata()", () => {
    for (const piece of ["sealedPiece", "notedPiece"] as const) {
      it(
        `refuses a visitor the metadata of ${
          piece === "sealedPiece"
            ? "a sealed piece"
            : "a piece with one sealed field"
        }`,
        async () => {
          await using docs = await shelf();
          const answer = gateFor(docs.runtime, visitor).readMetadata(
            docs[piece],
            "internal",
          );

          expect(holds(answer, SEALED_INTERNAL)).toBe(false);
          expect("refused" in answer).toBe(true);
        },
      );
    }

    it("returns the owner their own piece's metadata", async () => {
      await using docs = await shelf();
      const answer = gateFor(docs.runtime, owner).readMetadata(
        docs.sealedPiece,
        "internal",
      );

      expect(answer).toEqual({ value: { note: SEALED_INTERNAL } });
    });
  });

  describe("subscribe()", () => {
    it("delivers a refusal to a visitor, and no value", async () => {
      await using docs = await shelf();
      const { updates, cancel } = subscribe(
        gateFor(docs.runtime, visitor),
        docs.sealedPiece.key(NAME).asSchema(stringSchema),
      );
      cancel();

      expect(holds(updates, SEALED_NAME)).toBe(false);
      expect(updates).toHaveLength(1);
      expect("refused" in updates[0]).toBe(true);
    });

    it("delivers a refusal once a label written after it opened seals the value", async () => {
      await using docs = await shelf();
      const { updates, cancel } = subscribe(
        gateFor(docs.runtime, visitor),
        docs.publicPiece.key(NAME).asSchema(stringSchema),
      );
      await docs.write("public-piece", {
        [NAME]: "Public piece",
        entry: "public entry",
      }, [[[], [ownerOnly]]]);
      await docs.runtime.idle();
      cancel();

      expect(updates[0]).toEqual(
        expect.objectContaining({ value: "Public piece" }),
      );
      expect("refused" in updates[updates.length - 1]).toBe(true);
    });

    it("delivers a refusal for each change it refuses", async () => {
      await using docs = await shelf();
      const { updates, cancel } = subscribe(
        gateFor(docs.runtime, visitor),
        docs.sealedPiece.key(NAME).asSchema(stringSchema),
      );
      const before = updates.length;
      await docs.write("sealed-piece", { [NAME]: SEALED_RENAME }, [[
        [],
        [ownerOnly],
      ]]);
      await docs.runtime.idle();
      cancel();

      expect(holds(updates, SEALED_RENAME)).toBe(false);
      expect(updates.length).toBeGreaterThan(before);
      expect(updates.every((update) => "refused" in update)).toBe(true);
    });

    it("delivers a sealed entry inside an untyped field to the owner, and refuses it to a visitor", async () => {
      await using docs = await shelf();
      const schema = {
        type: "object",
        properties: { entry: {} },
      } as const;
      const toOwner = subscribe(
        gateFor(docs.runtime, owner),
        docs.nestedPiece.asSchema(schema),
      );
      const toVisitor = subscribe(
        gateFor(docs.runtime, visitor),
        docs.nestedPiece.asSchema(schema),
      );
      toOwner.cancel();
      toVisitor.cancel();

      expect(holds(toOwner.updates, SEALED_ENTRY)).toBe(true);
      expect(holds(toVisitor.updates, SEALED_ENTRY)).toBe(false);
      expect("refused" in toVisitor.updates[0]).toBe(true);
    });

    it("delivers a stream's events to the owner, deciding them on the stream's document", async () => {
      await using docs = await shelf();
      const stream = docs.runtime.getCell(space, "an-owner-stream", {
        asCell: ["stream"],
      });
      const { updates, cancel } = subscribe(
        gateFor(docs.runtime, owner),
        stream,
      );
      stream.send({ said: "hello" } as never);
      await docs.runtime.idle();
      cancel();

      expect(updates).toEqual([
        expect.objectContaining({ value: { said: "hello" } }),
      ]);
    });
  });
});
