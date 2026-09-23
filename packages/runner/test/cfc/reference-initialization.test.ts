import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { recordNewProtectedDefaults } from "../../src/cfc/default-initialization.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { recordReferencedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("reference-initialization-owner");
const space = signer.did();
const writer = {
  __ctWriterIdentityOf: { file: "/trusted.tsx", path: ["send"] },
};
// The labels a message sent through a trusted surface carries: its writer,
// the UI contract its writes come in under, and its author's integrity.
const entrySchema: JSONSchemaObj = {
  type: "object",
  properties: { body: { type: "string" } },
  ifc: {
    writeAuthorizedBy: writer,
    uiContract: {
      helper: "UiAction",
      action: "SendMessage",
      trustedPattern: "SendSurface",
      requiredEventIntegrity: ["SendSurface"],
    },
    addIntegrity: [{
      kind: "authored-by",
      subject: { __ctCurrentPrincipal: true },
    }],
  },
};
const argumentSchema: JSONSchema = {
  type: "object",
  properties: { element: entrySchema, index: { type: "number" } },
};
// The provenance a trusted event carries when it comes in under that contract.
const sendProvenance = {
  origin: "dom",
  trusted: true,
  ui: {
    pattern: "SendSurface",
    eventIntegrity: ["SendSurface"],
    uiContractDataset: { uiAction: "SendMessage" },
  },
};

describe("reference-initialization", () => {
  let runtime: Runtime;
  let manager: StorageManager;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      trustSnapshotProvider: () => ({
        id: "owner",
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  /** Writes an entry under no schema, as a list's existing entry is held. */
  function entryCell(
    tx: ReturnType<Runtime["edit"]>,
    name: string,
    body: string,
  ) {
    const entry = runtime.getCell(space, name, undefined, tx);
    entry.set({ body });
    return entry;
  }

  describe("recordReferencedArgumentFields()", () => {
    it("records a named field that holds a link to a cell", () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", argumentSchema, tx);
      argument.set({ element: entryCell(tx, "entry", "a"), index: 0 });
      const link = argument.getAsNormalizedFullLink();

      recordReferencedArgumentFields(tx, link, ["element"]);

      const recorded = tx.getCfcState().writePolicyInputs.filter((input) =>
        input.kind === "initialization"
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        mode: "reference",
        target: { id: link.id, path: ["element"] },
        value: argument.key("element").getRaw(),
      });
      expect(tx.isRuntimeWritePolicyInput(recorded[0]!)).toBe(true);
    });

    it("records nothing for a named field that holds a value, a redirect, or nothing", () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", undefined, tx);
      const entry = entryCell(tx, "entry", "a");
      argument.setRaw({
        value: { body: "forged" },
        redirect: entry.getAsWriteRedirectLink(),
      });

      recordReferencedArgumentFields(
        tx,
        argument.getAsNormalizedFullLink(),
        ["value", "redirect", "missing"],
      );

      expect(
        tx.getCfcState().writePolicyInputs.filter((input) =>
          input.kind === "initialization"
        ),
      ).toEqual([]);
    });
  });

  describe("preparation", () => {
    it("accepts a link staged into an absent protected field once it is recorded", async () => {
      // The same staging is committed twice, recorded and not, so the recording
      // is what the acceptance turns on.
      for (const recorded of [false, true]) {
        const tx = runtime.edit();
        const name = `argument-${recorded}`;
        const argument = runtime.getCell(space, name, argumentSchema, tx);
        argument.set({ element: entryCell(tx, `entry-${recorded}`, "a") });
        if (recorded) {
          recordReferencedArgumentFields(
            tx,
            argument.getAsNormalizedFullLink(),
            ["element"],
          );
        }
        runtime.prepareTxForCommit(tx);
        const error = (await tx.commit()).error?.message;

        if (recorded) expect(error).toBeUndefined();
        else expect(error).toContain("writeAuthorizedBy");
      }
    });

    it("refuses a value staged into a field named as a reference", async () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", argumentSchema, tx);
      argument.set({ element: { body: "forged" } });
      recordReferencedArgumentFields(
        tx,
        argument.getAsNormalizedFullLink(),
        ["element"],
      );
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });

    it("refuses a runtime-recorded reference whose value is no link", async () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", argumentSchema, tx);
      tx.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "reference",
        target: { ...argument.getAsNormalizedFullLink(), path: ["element"] },
        value: { body: "forged" },
      }, runtimeWritePolicyAuthorization);
      argument.set({ element: { body: "forged" } });
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });

    it("refuses a reference recorded without the runtime's mark", async () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", argumentSchema, tx);
      argument.set({ element: entryCell(tx, "entry", "a") });
      tx.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "reference",
        target: { ...argument.getAsNormalizedFullLink(), path: ["element"] },
        value: argument.key("element").getRaw(),
      });
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });

    it("accepts a link staged again over a field that holds that link already", async () => {
      // Nothing lands at the slot, so nothing is repointed; a second runtime
      // starting a piece it finds set up stages its argument this way.
      const first = runtime.edit();
      const entry = entryCell(first, "entry-a", "a");
      const created = runtime.getCell(space, "argument", argumentSchema, first);
      created.set({ element: entry });
      recordReferencedArgumentFields(
        first,
        created.getAsNormalizedFullLink(),
        ["element"],
      );
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();

      const again = runtime.edit();
      const held = runtime.getCell(space, "argument", argumentSchema, again);
      held.set({
        element: runtime.getCell(space, "entry-a", undefined, again),
      });
      recordReferencedArgumentFields(
        again,
        held.getAsNormalizedFullLink(),
        ["element"],
      );
      runtime.prepareTxForCommit(again);

      expect((await again.commit()).error).toBeUndefined();
    });

    // A stored envelope in which `element` carries a UI contract and no writer
    // binding, persisted by initializing a protected default beside the absent
    // field.
    const guarded: JSONSchemaObj = {
      type: "array",
      items: { type: "string" },
      default: [],
      ifc: {
        ownerPrincipal: signer.did(),
        addIntegrity: [{
          kind: "represents-principal",
          subject: signer.did(),
        }],
        writeAuthorizedBy: writer,
      },
    };
    const contractOnly: JSONSchemaObj = {
      type: "object",
      properties: {
        body: { type: "string" },
      },
      ifc: { uiContract: entrySchema.ifc!.uiContract },
    };
    const storedSchema: JSONSchemaObj = {
      type: "object",
      properties: {
        guarded,
        element: contractOnly,
        note: { type: "string" },
      },
    };
    /** The stored schema with a writer binding introduced on `element`. */
    const introducingWriter: JSONSchemaObj = {
      ...storedSchema,
      properties: {
        ...storedSchema.properties,
        element: {
          ...contractOnly,
          ifc: { ...contractOnly.ifc, writeAuthorizedBy: writer },
        },
      },
    };

    /** Persists that envelope and returns the argument's link. */
    async function persistContractOnlyElement() {
      const previousSchema: JSONSchema = {
        type: "object",
        properties: { note: { type: "string" } },
      };
      const seed = runtime.edit();
      runtime.getCell(space, "argument", undefined, seed).set({
        note: "saved",
      });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).error).toBeUndefined();

      const first = runtime.edit();
      const created = runtime.getCell(space, "argument", storedSchema, first);
      const link = created.getAsNormalizedFullLink();
      recordNewProtectedDefaults(first, link, previousSchema, storedSchema, {
        guarded: [],
      }, { guarded: [], note: "saved" });
      created.set({ guarded: [], note: "saved" });
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();
      expect(readStoredCfcMetadata(runtime.edit(), link)).toBeDefined();
      return link;
    }

    it("refuses a link staged into an absent field whose stored policy carries a UI contract", async () => {
      // A stored UI contract keeps its trusted-event requirement, as a stored
      // writer binding keeps its writer requirement.
      const link = await persistContractOnlyElement();
      const again = runtime.edit();
      const held = runtime.getCell(space, "argument", storedSchema, again);
      held.key("element").set(entryCell(again, "entry", "a"));
      recordReferencedArgumentFields(again, link, ["element"]);
      runtime.prepareTxForCommit(again);

      expect((await again.commit()).error?.message).toContain(
        "trusted-event",
      );
    });

    it("accepts a link staged under a writer binding the schema introduces beside a stored UI contract that a trusted event satisfies", async () => {
      // The stored contract keeps its requirement and the event meets it; the
      // writer binding is new to the slot, so the initialization waives it.
      const link = await persistContractOnlyElement();
      const again = runtime.edit();
      const held = runtime.getCell(space, "argument", introducingWriter, again);
      held.key("element").set(entryCell(again, "entry", "a"));
      recordReferencedArgumentFields(again, link, ["element"]);
      again.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: { space, id: link.id, scope: link.scope, path: ["element"] },
        eventId: "trusted-event:send:argument:element",
        provenance: sendProvenance,
      });
      runtime.prepareTxForCommit(again);

      expect((await again.commit()).error).toBeUndefined();
      expect(runtime.getCell(space, "argument").key("element").get()).toEqual({
        body: "a",
      });
    });

    it("refuses for the stored UI contract, not for the writer binding introduced beside it, when no trusted event is recorded", async () => {
      const link = await persistContractOnlyElement();
      const again = runtime.edit();
      const held = runtime.getCell(space, "argument", introducingWriter, again);
      held.key("element").set(entryCell(again, "entry", "a"));
      recordReferencedArgumentFields(again, link, ["element"]);
      runtime.prepareTxForCommit(again);

      const message = (await again.commit()).error?.message;
      expect(message).toContain("trusted-event");
      expect(message).not.toContain("writeAuthorizedBy");
    });

    it("refuses a link to another cell staged over a field that holds one", async () => {
      const first = runtime.edit();
      const created = runtime.getCell(space, "argument", argumentSchema, first);
      created.set({ element: entryCell(first, "entry-a", "a") });
      recordReferencedArgumentFields(
        first,
        created.getAsNormalizedFullLink(),
        ["element"],
      );
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();

      const second = runtime.edit();
      const held = runtime.getCell(space, "argument", argumentSchema, second);
      held.key("element").set(entryCell(second, "entry-b", "b"));
      recordReferencedArgumentFields(
        second,
        held.getAsNormalizedFullLink(),
        ["element"],
      );
      runtime.prepareTxForCommit(second);

      expect((await second.commit()).error?.message).toContain(
        "writeAuthorizedBy",
      );
      expect(runtime.getCell(space, "argument").key("element").get()).toEqual({
        body: "a",
      });
    });
  });

  describe("a list operation over owner-protected entries", () => {
    // Each entry is added through the handler its policy names, whose state
    // holds the protected list, so each entry's document carries the policy
    // that handler's commit stores. The list sits inside an interface because
    // the entry's writer binding names the handler that writes it.
    const operations = {
      map: {
        expression: 'board.key("entries").map((entry) => entry.body)',
        expected: ["a", "b"],
      },
      filter: {
        expression:
          'board.key("entries").filter((entry) => entry.body !== "b")',
        expected: [{ body: "a" }],
      },
      flatMap: {
        expression: 'board.key("entries").flatMap((entry) => [entry.body])',
        expected: ["a", "b"],
      },
    };

    for (const [name, { expression, expected }] of Object.entries(operations)) {
      it(`hands each entry to the callback of \`${name}()\``, async () => {
        const errors: unknown[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `/// <cts-enable />
              import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
              interface Message { body: string }
              type Entry = WriteAuthorizedBy<Message, typeof send>;
              interface Board { entries: Entry[] }
              const send = handler<{ body?: string }, { board: Writable<Board> }>(
                (event, { board }) => {
                  board.key("entries").push({ body: event.body ?? "" });
                },
              );
              export default pattern<{ board: Writable<Board> }>(({ board }) => ({
                value: ${expression},
                send: send({ board }),
              }));
            `,
          }],
        });
        const tx = runtime.edit();
        const board = runtime.getCell(space, "board", undefined, tx);
        board.set({ entries: [] });
        const output = runtime.getCell<{ value: unknown; send: unknown }>(
          space,
          "output",
          compiled.resultSchema,
          tx,
        );
        const result = runtime.run(tx, compiled, { board }, output);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        const cancel = result.sink(() => {});
        await runtime.idle();
        result.key("send").send({ body: "a" });
        await runtime.idle();
        result.key("send").send({ body: "b" });
        await runtime.idle();

        expect(await result.key("value").pull()).toEqual(expected);
        expect(errors).toEqual([]);
        cancel();
      });
    }
  });
});
