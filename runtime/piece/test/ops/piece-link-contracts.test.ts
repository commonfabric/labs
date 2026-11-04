/** Contract admission and binding preservation at the Piece link boundary. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { valueEqual } from "@commonfabric/data-model";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import {
  isLink,
  parseLinkOrThrow,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

import { assertSuppliedLinkSchemasCompatible } from "../../src/ops/piece-controller.ts";
import { PieceInputPathError } from "../../src/ops/piece-input-path.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece link contract tests");

/** Packages a compiler fixture. */
function program(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

/** Publishes a row contract independently of whether any rows are present. */
function rowProducer(empty = false): RuntimeProgram {
  return program(`
    import { NAME, pattern } from "commonfabric";
    interface Row { [NAME]: string; title: string; piece: unknown; }
    export default pattern<Record<string, never>, { rows: Row[] }>(() => ({
      rows: ${
    empty ? "[]" : '[{ [NAME]: "A", title: "A", piece: "reference" }]'
  },
    }));
  `);
}

/** Declares the consumer's access independently of its row projection. */
function rowConsumer(
  kind: "ReadonlyCell" | "Writable",
  fields = "title: string;",
): RuntimeProgram {
  return program(`
    import { Default, lift, NAME, pattern, ReadonlyCell, Writable } from "commonfabric";
    interface Row { [NAME]: string; ${fields} }
    interface Input { rows?: ${kind}<Row[] | Default<[]>>; }
    const label = lift((rows: ReadonlyCell<Row[]>) => rows.get()?.[0]?.[NAME] ?? "empty");
    export default pattern<Input, { label: string }>(({ rows }) => ({
      label: label(rows!),
    }));
  `);
}

/** Publishes a scalar backed by authored input. */
function scalarProducer() {
  return program(`
    import { pattern, ReadonlyCell, Writable } from "commonfabric";
    export default pattern<{ value: Writable<string> }, { value: Writable<string> }>(
      ({ value }) => ({ value }),
    );
  `);
}

/** Reads a scalar through the selected consumer capability and scope. */
function scalarConsumer(type = 'ReadonlyCell<string | Default<"seed">>') {
  return program(`
    import { Default, lift, pattern, PerSpace, ReadonlyCell, Writable } from "commonfabric";
    const read = lift((value: ReadonlyCell<string>) => value.get());
    export default pattern<{ value: ${type} }, { value: string }>(
      ({ value }) => ({ value: read(value) }),
    );
  `);
}

describe("PiecesController", () => {
  describe("instance members", () => {
    describe("link()", () => {
      let storage: ReturnType<typeof StorageManager.emulate>;
      let session: Session;
      let runtime: Runtime;
      let pieces: PiecesController;

      /** Opens the stored pieces in a runtime with no running graphs. */
      async function reopenPieces(): Promise<void> {
        await runtime.dispose({ closeStorage: false });
        runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: storage,
        });
        pieces = new PiecesController(session, runtime);
        await pieces.synced();
      }

      beforeEach(async () => {
        storage = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: storage,
        });
        session = createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        });
        pieces = new PiecesController(session, runtime);
        await pieces.synced();
      });

      afterEach(async () => {
        await runtime.dispose();
        await storage.close();
      });

      it("starts a cold target and materializes the admitted binding by default", async () => {
        const source = await pieces.create(rowProducer());
        const targetId = (await pieces.create(rowConsumer("ReadonlyCell"))).id;
        await reopenPieces();
        const target = await pieces.get(targetId, false);
        expect(runtime.runner.cancels.size).toBe(0);
        expect(pieces.getResult(target.getCell()).get()).toEqual({
          label: "empty",
        });

        await pieces.link(source.id, ["rows"], target.id, ["rows"]);

        expect(pieces.getResult(target.getCell()).get()).toEqual({
          label: "A",
        });
        expect(runtime.runner.cancels.size).toBeGreaterThan(0);
      });

      it("stores an admitted binding with start false while the cold target stays stopped", async () => {
        const source = await pieces.create(rowProducer());
        const targetId = (await pieces.create(rowConsumer("ReadonlyCell"))).id;
        await reopenPieces();
        const target = await pieces.get(targetId, false);
        expect(runtime.runner.cancels.size).toBe(0);

        await pieces.link(source.id, ["rows"], target.id, ["rows"], {
          start: false,
        });

        expect(runtime.runner.cancels.size).toBe(0);
        const argument = pieces.getArgument(target.getCell());
        const link = parseLinkOrThrow(argument.key("rows").getRaw(), argument);
        expect(link.id).toBe(source.getCell().getAsNormalizedFullLink().id);
        expect(link.path).toEqual(["rows"]);
        expect(pieces.getResult(target.getCell()).get()).toEqual({
          label: "empty",
        });
      });

      it("leaves a cold target stopped and unchanged when admission fails", async () => {
        const source = await pieces.create(rowProducer());
        const targetId = (await pieces.create(rowConsumer("Writable"))).id;
        await reopenPieces();
        const target = await pieces.get(targetId, false);
        const argument = pieces.getArgument(target.getCell());
        const before = argument.getRawUntyped();
        expect(runtime.runner.cancels.size).toBe(0);

        await expect(pieces.link(source.id, ["rows"], target.id, ["rows"]))
          .rejects.toThrow("rows[].piece");

        expect(runtime.runner.cancels.size).toBe(0);
        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
        expect(pieces.getResult(target.getCell()).get()).toEqual({
          label: "empty",
        });
      });

      it("leaves a cold target stopped and unchanged when its input hides the destination", async () => {
        const source = await pieces.create(rowProducer());
        const targetId = (await pieces.create(rowConsumer("ReadonlyCell"))).id;
        await reopenPieces();
        const target = await pieces.get(targetId, false);
        const argument = pieces.getArgument(target.getCell());
        const before = argument.getRawUntyped();
        expect(runtime.runner.cancels.size).toBe(0);

        await expect(pieces.link(source.id, ["rows"], target.id, ["hidden"]))
          .rejects.toThrow(PieceInputPathError);

        expect(runtime.runner.cancels.size).toBe(0);
        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
        expect(pieces.getResult(target.getCell()).get()).toEqual({
          label: "empty",
        });
      });

      it("refuses a writable row projection before changing either endpoint", async () => {
        const source = await pieces.create(rowProducer());
        const target = await pieces.create(rowConsumer("Writable"));
        const argument = await target.input.getCell();
        const before = argument.getRawUntyped();
        const sourceBefore = source.getCell().getRawUntyped();

        await expect(pieces.link(source.id, ["rows"], target.id, ["rows"]))
          .rejects.toThrow("rows[].piece");

        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
        expect(valueEqual(source.getCell().getRawUntyped(), sourceBefore)).toBe(
          true,
        );
        expect(await target.result.get()).toEqual({ label: "empty" });
      });

      it("refuses an incompatible writable contract even when the producer array is empty", async () => {
        const source = await pieces.create(rowProducer(true));
        const target = await pieces.create(rowConsumer("Writable"));
        await expect(pieces.link(source.id, ["rows"], target.id, ["rows"]))
          .rejects.toThrow("rows[].piece");
      });

      it("binds a read-only row projection and preserves the public producer address", async () => {
        const source = await pieces.create(rowProducer());
        const sourceId = source.getCell().getAsNormalizedFullLink().id;
        const targetProgram = rowConsumer("ReadonlyCell");
        const target = await pieces.create(targetProgram);

        await pieces.link(source.id, ["rows"], target.id, ["rows"]);

        const argument = await target.input.getCell();
        const raw = argument.key("rows").getRawUntyped();
        expect(isLink(raw)).toBe(true);
        const link = parseLinkOrThrow(raw, argument);
        expect(link.id).toBe(sourceId);
        expect(link.path).toEqual(["rows"]);
        expect(await target.result.get()).toEqual({ label: "A" });
        expect((await target.checkPattern(targetProgram)).compatible).toBe(
          true,
        );
      });

      it("binds a writable row that preserves the producer's required reference", async () => {
        const source = await pieces.create(rowProducer());
        const target = await pieces.create(
          rowConsumer("Writable", "title: string; piece: unknown;"),
        );
        await pieces.link(source.id, ["rows"], target.id, ["rows"]);
        expect(await target.result.get()).toEqual({ label: "A" });
      });

      it("refuses a read-only projection with an incompatible field type", async () => {
        const source = await pieces.create(rowProducer());
        const target = await pieces.create(
          rowConsumer("ReadonlyCell", "title: number;"),
        );
        await expect(pieces.link(source.id, ["rows"], target.id, ["rows"]))
          .rejects.toThrow("rows[].title");
      });

      it("refuses to expose a read-only producer as a writable handle", async () => {
        // Seed the durable capability contract directly: compiled pattern
        // results publish ordinary scalar schemas for these output wrappers.

        const source = runtime.getCell(pieces.getSpace(), "readonly producer");
        const { error } = await runtime.editWithRetry((tx) => {
          source.withTx(tx).set({ value: "A" });
          source.withTx(tx).setMetaRaw("schema", {
            type: "object",
            properties: { value: { type: "string", asCell: ["readonly"] } },
            required: ["value"],
          }, rawMetaWriteAuthorization);
        });
        expect(error).toBeUndefined();
        const target = await pieces.create(
          scalarConsumer('Writable<string | Default<"seed">>'),
        );
        await expect(
          pieces.link(
            source.getAsNormalizedFullLink().id,
            ["value"],
            target.id,
            ["value"],
          ),
        )
          .rejects.toThrow("readonly capability cannot be exposed as cell");
      });

      it("refuses to bind beneath a read-only ancestor", async () => {
        const source = await pieces.create(scalarProducer(), {
          input: { value: "A" },
        });
        const target = await pieces.create(program(`
          import { Default, pattern, ReadonlyCell } from "commonfabric";
          interface Input { group: ReadonlyCell<{ value: string } | Default<{ value: "seed" }>>; }
          export default pattern<Input, { label: string }>(() => ({ label: "target" }));
        `));
        const argument = await target.input.getCell();
        const before = argument.getRawUntyped();
        await expect(
          pieces.link(source.id, ["value"], target.id, ["group", "value"]),
        )
          .rejects.toThrow("readonly Cell path is not writable");
        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
      });

      it("checks the producer's flow policy for a new binding", async () => {
        const source = await pieces.create(
          program(`
          import {
            Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser,
            Writable, WriteAuthorizedBy,
          } from "commonfabric";
          const setValue = handler<string, { value: Writable<string> }>(
            (event, { value }) => value.set(event),
          );
          type Owned = RepresentsCurrentUser<Cfc<
            WriteAuthorizedBy<string, typeof setValue>,
            { ownerPrincipal: CurrentPrincipal }
          >>;
          export default pattern<{ value: string }, { value: Owned }>(
            ({ value }) => ({ value }),
          );
        `),
          { input: { value: "A" } },
        );
        const target = await pieces.create(scalarConsumer());
        const argument = await target.input.getCell();
        const before = argument.getRawUntyped();
        await expect(pieces.link(source.id, ["value"], target.id, ["value"]))
          .rejects.toThrow("ifc changed");
        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
      });

      it("refuses a user-scoped source for a space-scoped input", async () => {
        const source = await pieces.create(scalarProducer(), {
          input: { value: "A" },
        });
        const target = await pieces.create(
          scalarConsumer('ReadonlyCell<PerSpace<string | Default<"seed">>>'),
        );
        await expect(
          pieces.link(source.id, ["value"], target.id, ["value"], {
            sourceScope: "user",
          }),
        )
          .rejects.toThrow(
            "source Cell scope user exceeds the destination scope",
          );
        await pieces.link(source.id, ["value"], target.id, ["value"]);
        expect(await target.result.get()).toEqual({ value: "A" });
      });

      it("checks the destination scope even when the source has no durable schema", async () => {
        const root = runtime.getCell(
          pieces.getSpace(),
          "scoped dynamic source",
        );
        const source = runtime.getCellFromLink({
          ...root.getAsNormalizedFullLink(),
          scope: "user",
        });
        const { error } = await runtime.editWithRetry((tx) =>
          source.withTx(tx).set({ value: "A" })
        );
        expect(error).toBeUndefined();
        const target = await pieces.create(
          scalarConsumer('ReadonlyCell<PerSpace<string | Default<"seed">>>'),
        );
        await expect(
          pieces.link(
            source.getAsNormalizedFullLink().id,
            ["value"],
            target.id,
            ["value"],
            { sourceScope: "user" },
          ),
        )
          .rejects.toThrow(
            "source Cell scope user exceeds the destination scope",
          );
      });

      it("binds a Stream handle without sending an event and preserves later sends", async () => {
        const source = await pieces.create(program(`
          import { Default, handler, pattern, Stream, Writable } from "commonfabric";
          const record = handler<string, { values: Writable<string[]> }>((event, { values }) => values.push(event));
          export default pattern<{ values: Writable<string[] | Default<[]>> }, { send: Stream<string>; values: string[] }>(
            ({ values }) => ({ send: record({ values }), values }),
          );
        `));
        const target = await pieces.create(program(`
          import { pattern, Stream } from "commonfabric";
          interface Input { send?: Stream<string>; }
          export default pattern<Input, Input>(({ send }) => ({ send }));
        `));
        await pieces.link(source.id, ["send"], target.id, ["send"]);
        expect(await source.input.get(["values"])).toEqual([]);
        (await target.result.getCell()).key("send").send("recorded");
        await runtime.idle();
        expect(await source.input.get(["values"])).toEqual(["recorded"]);
      });

      it("refuses an ordinary Cell where the destination requires a Stream", async () => {
        const source = await pieces.create(scalarProducer(), {
          input: { value: "A" },
        });
        const target = await pieces.create(program(`
          import { pattern, Stream } from "commonfabric";
          interface Input { send?: Stream<string>; }
          export default pattern<Input, Input>(({ send }) => ({ send }));
        `));
        await expect(pieces.link(source.id, ["value"], target.id, ["send"]))
          .rejects.toThrow("Cell handle is not accepted as stream");
      });

      it("replaces a terminal binding without writing through the old producer", async () => {
        const first = await pieces.create(scalarProducer(), {
          input: { value: "first" },
        });
        const second = await pieces.create(scalarProducer(), {
          input: { value: "second" },
        });
        const target = await pieces.create(scalarConsumer());
        await pieces.link(first.id, ["value"], target.id, ["value"]);
        const firstBefore = first.getCell().getRawUntyped();

        await pieces.link(second.id, ["value"], target.id, ["value"]);

        expect(valueEqual(first.getCell().getRawUntyped(), firstBefore)).toBe(
          true,
        );
        expect(await first.result.get()).toEqual({ value: "first" });
        expect(await target.result.get()).toEqual({ value: "second" });
        await second.input.set("updated", ["value"]);
        expect(await target.result.get()).toEqual({ value: "updated" });
      });

      it("preserves an existing binding when its replacement is incompatible", async () => {
        const first = await pieces.create(scalarProducer(), {
          input: { value: "first" },
        });
        const source = await pieces.create(rowProducer());
        const target = await pieces.create(scalarConsumer());
        await pieces.link(first.id, ["value"], target.id, ["value"]);
        const argument = await target.input.getCell();
        const before = argument.getRawUntyped();

        await expect(pieces.link(source.id, ["rows"], target.id, ["value"]))
          .rejects.toThrow("input link at value");

        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
        expect(await target.result.get()).toEqual({ value: "first" });
      });

      it("checks an incompatible legacy binding again when asked to bind the same source", async () => {
        // Raw stored state may predate admission checks. Rebinding it is a new
        // operation even when the supplied address is already in the slot.

        const source = await pieces.create(rowProducer());
        const target = await pieces.create(rowConsumer("Writable"));
        const argument = await target.input.getCell();
        const { error } = await runtime.editWithRetry((tx) => {
          argument.withTx(tx).key("rows").setRawUntyped(
            source.getCell().key("rows").getAsLink({ base: argument }),
          );
        });
        expect(error).toBeUndefined();
        const before = argument.getRawUntyped();
        await expect(pieces.link(source.id, ["rows"], target.id, ["rows"]))
          .rejects.toThrow("rows[].piece");
        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
      });

      it("keeps a source without durable schema metadata as a dynamic binding", async () => {
        const source = runtime.getCell(pieces.getSpace(), "dynamic source");
        const { error } = await runtime.editWithRetry((tx) => {
          source.withTx(tx).set({ value: "dynamic" });
        });
        expect(error).toBeUndefined();
        const target = await pieces.create(scalarConsumer());
        await pieces.link(
          source.getAsNormalizedFullLink().id,
          ["value"],
          target.id,
          ["value"],
        );
        expect(await target.result.get()).toEqual({ value: "dynamic" });

        const candidate = await runtime.patternManager.compilePattern(
          scalarConsumer(),
          { space: pieces.getSpace() },
        );
        expect(() =>
          assertSuppliedLinkSchemasCompatible(
            [{ path: ["value"], value: source.key("value") }],
            candidate.argumentSchema,
            pieces.getArgument(target.getCell()),
            pieces,
          )
        ).toThrow("source has no durable schema contract");
        expect(() =>
          assertSuppliedLinkSchemasCompatible(
            [{ path: ["value"], value: source.key("value").getAsLink() }],
            candidate.argumentSchema,
            pieces.getArgument(target.getCell()),
            pieces,
            { allowUnprovenSource: true },
          )
        ).toThrow("source has no durable schema contract");
      });

      it("refuses a known Piece document whose producer contract is unavailable", async () => {
        const owner = runtime.getCell(pieces.getSpace(), "unavailable owner");
        const source = runtime.getCell(pieces.getSpace(), "owned document");
        const { error } = await runtime.editWithRetry((tx) => {
          source.withTx(tx).set({ value: "A" });
          source.withTx(tx).setMetaRaw(
            "result",
            owner.getAsLink(),
            rawMetaWriteAuthorization,
          );
        });
        expect(error).toBeUndefined();
        const target = await pieces.create(scalarConsumer());
        const argument = await target.input.getCell();
        const before = argument.getRawUntyped();
        await expect(
          pieces.link(
            source.getAsNormalizedFullLink().id,
            ["value"],
            target.id,
            ["value"],
          ),
        )
          .rejects.toThrow(
            "source Piece metadata cannot establish a durable schema contract",
          );
        expect(valueEqual(argument.getRawUntyped(), before)).toBe(true);
      });
    });
  });
});
