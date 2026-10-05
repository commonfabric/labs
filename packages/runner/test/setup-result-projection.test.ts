import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type {
  JSONSchema,
  JSONSchemaObj,
  Pattern,
} from "../src/builder/types.ts";
import { recordNewProtectedDefaults } from "../src/cfc/default-initialization.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("setup-result-projection-owner");
const other = await Identity.fromPassphrase("setup-result-projection-other");
const space = signer.did();
const writer = {
  __ctWriterIdentityOf: { file: "/trusted.tsx", path: ["send"] },
};
const refusal =
  "writeAuthorizedBy requires a trusted verified binding identity";

// The owner's list: its writer, its owner, and the owner's integrity.
const ownedList: JSONSchemaObj = {
  type: "array",
  items: { type: "string" },
  ifc: {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    addIntegrity: [{
      kind: "represents-principal",
      subject: { __ctCurrentPrincipal: true },
    }],
    writeAuthorizedBy: writer,
  },
};

// The document holding the owner's list at `items`, beside a note.
const boardSchema: JSONSchema = {
  type: "object",
  properties: {
    items: { ...ownedList, default: [] },
    note: { type: "string" },
  },
};

// A slot or result field that repeats the list's policy.
const listField: JSONSchema = { ...ownedList, asCell: ["cell"] };

// The list's protection in a compiled pattern: its writer alone, or its writer
// and its owner.
const protections = {
  writer: "WriteAuthorizedBy<string[], typeof edit>",
  owner: `RepresentsCurrentUser<
    Cfc<
      WriteAuthorizedBy<string[], typeof edit>,
      { ownerPrincipal: CurrentPrincipal }
    >
  >`,
};

// What a handler that is not the list's writer does before it writes the list.
// Each of the first group names the list in the result of a pattern the
// handler sets up; the second group names nothing of it.
const projectingAttacks = {
  "sets up a pattern whose result names the list": `
    const Inner = pattern<Record<string, never>, { list: Writable<Items> }>(
      () => ({ list: items }),
    );
    const inner = Inner({});
    items.set(["forged"]);
    return inner;`,
  "sets up a pattern with a cell of its own whose result also names the list": `
    const Inner = pattern<
      Record<string, never>,
      { own: Writable<string[]>; list: Writable<Items> }
    >(() => {
      const own = new Writable<string[]>([]).for("own");
      return { own, list: items };
    });
    const inner = Inner({});
    items.set(["forged"]);
    return inner;`,
  "composes a pattern that passes the list through to its result": `
    const inner = Pass({ list: items });
    items.set(["forged"]);
    return inner;`,
};
const otherAttacks = {
  "sets up a pattern whose result names nothing of the list": `
    const Inner = pattern<Record<string, never>, { n: number }>(
      () => ({ n: 1 }),
    );
    const inner = Inner({});
    items.set(["forged"]);
    return inner;`,
  "sets up nothing": `
    items.set(["forged"]);`,
};

describe("setup-result-projection", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;
  // The principal each new transaction acts as.
  let actingPrincipal: string;

  beforeEach(() => {
    actingPrincipal = signer.did();
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      trustSnapshotProvider: () => ({
        id: actingPrincipal,
        actingPrincipal,
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  describe("a pattern set up over a caller's list", () => {
    /**
     * Initializes the owner's list on `board`, in a transaction attributed to
     * the owner as a handler run of theirs is, so its stored label names the
     * owner.
     */
    async function initializeOwnersList(board = "board") {
      const seed = runtime.edit();
      runtime.getCell(space, board, undefined, seed).set({ note: "saved" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).error).toBeUndefined();

      const first = runtime.edit();
      first.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      const cell = runtime.getCell(space, board, boardSchema, first);
      recordNewProtectedDefaults(
        first,
        cell.getAsNormalizedFullLink(),
        { type: "object", properties: { note: { type: "string" } } },
        boardSchema,
        { items: [] },
        { items: [], note: "saved" },
      );
      cell.set({ items: [], note: "saved" });
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();
    }

    /** A write redirect to the owner's list on `board`. */
    function binding(tx: IExtendedStorageTransaction, board = "board") {
      return runtime.getCell(space, board, undefined, tx).key("items")
        .getAsWriteRedirectLink();
    }

    /** Prepares and commits `tx`, and returns the refusal, if any. */
    async function commit(tx: IExtendedStorageTransaction) {
      runtime.prepareTxForCommit(tx);
      return (await tx.commit()).error?.message;
    }

    /** The owner's list on `board`, read outside any transaction under test. */
    function ownersList(board = "board"): unknown {
      return runtime.getCell(space, board).key("items").get();
    }

    /** Sets up a pattern whose result's `items` is the owner's list. */
    async function setUpExporter(tx: IExtendedStorageTransaction) {
      const pattern = {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: { type: "object", properties: { items: listField } },
        result: { items: binding(tx) },
        nodes: [],
      } as unknown as Pattern;
      await runtime.runner.setup(
        tx,
        pattern,
        {},
        runtime.getCell(space, "exporter", undefined, tx),
        {},
      );
    }

    /**
     * Sets up a pattern over the owner's list at its argument's `list` whose
     * result's `list` passes that slot through. Returns its result cell.
     */
    async function setUpPassThrough(tx: IExtendedStorageTransaction) {
      const resultCell = runtime.getCell(space, "pass", undefined, tx);
      const pattern = {
        argumentSchema: { type: "object", properties: { list: listField } },
        resultSchema: { type: "object", properties: { list: listField } },
        result: { list: { $alias: { cell: "argument", path: ["list"] } } },
        nodes: [],
      } as unknown as Pattern;
      await runtime.runner.setup(
        tx,
        pattern,
        { list: binding(tx) },
        resultCell,
        {},
      );
      return resultCell;
    }

    it("records a binding of the result field naming the list, and no setup projection", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpExporter(tx);
      const exporter = runtime.getCell(space, "exporter", undefined, tx)
        .getAsNormalizedFullLink();
      const list = runtime.getCell(space, "board", undefined, tx).key("items")
        .getAsNormalizedFullLink();

      const records = tx.getCfcState().writePolicyInputs.flatMap((input) => {
        if (
          input.kind === "initialization" && input.target.id === exporter.id
        ) {
          const named = parseLink(input.value, exporter);
          return [{
            record: input.mode,
            path: input.target.path,
            names: named && { id: named.id, path: named.path },
          }];
        }
        return input.kind === "structural-provenance" &&
            input.claim === CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION &&
            input.target.id === exporter.id
          ? [{ record: input.claim, path: input.target.path }]
          : [];
      });

      expect(records).toEqual([{
        record: "binding",
        path: ["items"],
        names: { id: list.id, path: list.path },
      }]);
      tx.abort();
    });

    it("accepts the setup of a pattern whose result names the list", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpExporter(tx);

      expect(await commit(tx)).toBeUndefined();
    });

    it("refuses a write to the list without its writer in the transaction setting up a pattern whose result names it", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpExporter(tx);
      runtime.getCell(space, "board", boardSchema, tx).key("items").set([
        "forged",
      ]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });

    it("accepts the setup of a pattern that passes the list through to its result", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpPassThrough(tx);

      expect(await commit(tx)).toBeUndefined();
    });

    it("refuses a write through the passed-through result field without the list's writer in the transaction setting it up", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const resultCell = await setUpPassThrough(tx);
      resultCell.asSchema({
        type: "object",
        properties: { list: listField },
      }).key("list").set(["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });

    it("refuses a re-point of the argument slot it passes through, in the transaction setting it up", async () => {
      await initializeOwnersList();
      await initializeOwnersList("other");
      const tx = runtime.edit();
      const resultCell = await setUpPassThrough(tx);
      const argument = resultCell.getArgumentCell()!.getAsNormalizedFullLink();
      tx.writeValueOrThrow(
        { ...argument, path: [...argument.path, "list"] },
        binding(tx, "other"),
      );

      expect(await commit(tx)).toContain(`${refusal} at /list`);
    });
  });

  describe("a handler that is not the list's writer", () => {
    /**
     * Runs a pattern holding a list under `protection`, adds an item through
     * the list's writer as the owner, then sends `hack`, whose handler runs
     * `attack` over the list, as `principal`. Returns the list as the
     * pattern's runtime reads it before and after, and as a runtime started
     * afresh over the same storage reads it.
     */
    async function runAttack(
      attack: string,
      protection: keyof typeof protections,
      principal = signer.did(),
    ) {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `/// <cts-enable />
            import {
              Cfc,
              CurrentPrincipal,
              handler,
              pattern,
              RepresentsCurrentUser,
              Writable,
              WriteAuthorizedBy,
            } from "commonfabric";
            const edit = handler<{ add?: string }, { items: Writable<string[]> }>(
              (event, { items }) => {
                items.set([...items.get(), event.add ?? ""]);
              },
            );
            type Items = ${protections[protection]};
            const Pass = pattern<
              { list: Writable<Items> },
              { list: Writable<Items> }
            >(({ list }) => ({ list }));
            const hack = handler<Record<string, never>, { items: Writable<Items> }>(
              (_event, { items }) => {${attack}
              },
            );
            export default pattern<Record<string, never>>(() => {
              const items = new Writable<Items>([]).for("items");
              return { items, add: edit({ items }), hack: hack({ items }) };
            });
          `,
        }],
      });
      const tx = runtime.edit();
      const output = runtime.getCell<{ items: string[] }>(
        space,
        "output",
        compiled.resultSchema,
        tx,
      );
      const result = runtime.run(tx, compiled, {}, output);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const cancel = result.sink(() => {});
      await runtime.idle();
      result.key("add").send({ add: "a" });
      await runtime.idle();
      await manager.synced();
      const before = await result.key("items").pull();

      actingPrincipal = principal;
      result.key("hack").send({});
      await runtime.idle();
      // The handler's commit can still be in flight once the scheduler is
      // idle; settling it keeps the reads below from racing it.
      await manager.synced();
      const after = await result.key("items").pull();
      cancel();

      const fresh = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: manager,
        trustSnapshotProvider: () => ({
          id: actingPrincipal,
          actingPrincipal,
        }),
      });
      const stored = fresh.getCell<{ items: string[] }>(space, "output")
        .key("items");
      await stored.sync();
      const afresh = stored.get();
      await fresh.dispose();
      return { before, after, afresh };
    }

    for (const protection of ["writer", "owner"] as const) {
      for (
        const [name, attack] of Object.entries({
          ...projectingAttacks,
          ...otherAttacks,
        })
      ) {
        it(`keeps the list protected by its ${protection} from one that ${name} and writes the list`, async () => {
          const { before, after, afresh } = await runAttack(
            attack,
            protection,
          );
          // The owner's own write, through the list's writer, landed.
          expect(before).toEqual(["a"]);
          expect(after).toEqual(["a"]);
          expect(afresh).toEqual(["a"]);
        });
      }
    }

    it("keeps the list protected by its writer from one that another principal sends, which sets up a pattern whose result names the list and writes the list", async () => {
      const { before, after, afresh } = await runAttack(
        projectingAttacks["sets up a pattern whose result names the list"],
        "writer",
        other.did(),
      );
      expect(before).toEqual(["a"]);
      expect(after).toEqual(["a"]);
      expect(afresh).toEqual(["a"]);
    });
  });

  describe("a computed that is not the list's writer", () => {
    for (const protection of ["writer", "owner"] as const) {
      it(`keeps the list protected by its ${protection} from one that composes a pattern passing the list through to its result and writes the list`, async () => {
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `/// <cts-enable />
              import {
                Cfc,
                computed,
                CurrentPrincipal,
                handler,
                pattern,
                RepresentsCurrentUser,
                Writable,
                WriteAuthorizedBy,
              } from "commonfabric";
              const edit = handler<{ add?: string }, { items: Writable<string[]> }>(
                (event, { items }) => {
                  items.set([...items.get(), event.add ?? ""]);
                },
              );
              type Items = ${protections[protection]};
              const Pass = pattern<
                { list: Writable<Items> },
                { list: Writable<Items> }
              >(({ list }) => ({ list }));
              export default pattern<Record<string, never>>(() => {
                const items = new Writable<Items>([]).for("items");
                const sink = computed(() => {
                  const inner = Pass({ list: items });
                  try {
                    items.set(["forged"]);
                  } catch (_error) {
                    // A refused write may throw inside the computation.
                  }
                  return inner;
                });
                return { items, add: edit({ items }), sink };
              });
            `,
          }],
        });
        const tx = runtime.edit();
        const result = runtime.run(
          tx,
          compiled,
          {},
          runtime.getCell<{ items: string[] }>(
            space,
            "computed-output",
            compiled.resultSchema,
            tx,
          ),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        const cancel = result.sink(() => {});
        await runtime.idle();
        result.key("add").send({ add: "a" });
        await runtime.idle();
        await manager.synced();
        const after = await result.key("items").pull();
        cancel();

        // The owner's own write, through the list's writer, landed; the
        // computation's did not.
        expect(after).toEqual(["a"]);
      });
    }
  });
});
