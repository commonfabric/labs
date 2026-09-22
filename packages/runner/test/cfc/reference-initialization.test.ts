import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
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
const entrySchema: JSONSchema = {
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

    it("refuses a link staged into an absent field whose stored policy carries a UI contract", async () => {
      // The envelope is persisted by initializing a protected default beside
      // the absent field, and then stands: a stored UI contract vetoes the
      // initialization as a stored writer binding does.
      const guarded: JSONSchema = {
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
      const contractOnly: JSONSchema = {
        type: "object",
        properties: {
          body: { type: "string" },
        },
        ifc: { uiContract: entrySchema.ifc!.uiContract },
      };
      const schema: JSONSchema = {
        type: "object",
        properties: {
          guarded,
          element: contractOnly,
          note: { type: "string" },
        },
      };
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
      const created = runtime.getCell(space, "argument", schema, first);
      const link = created.getAsNormalizedFullLink();
      recordNewProtectedDefaults(first, link, previousSchema, schema, {
        guarded: [],
      }, { guarded: [], note: "saved" });
      created.set({ guarded: [], note: "saved" });
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();
      expect(readStoredCfcMetadata(runtime.edit(), link)).toBeDefined();

      const again = runtime.edit();
      const held = runtime.getCell(space, "argument", schema, again);
      held.key("element").set(entryCell(again, "entry", "a"));
      recordReferencedArgumentFields(again, link, ["element"]);
      runtime.prepareTxForCommit(again);

      expect((await again.commit()).error?.message).toContain(
        "trusted-event",
      );
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
    const operations = {
      map: {
        expression: "entries.map((entry) => entry.body)",
        expected: ["a", "b"],
      },
      filter: {
        expression: 'entries.filter((entry) => entry.body !== "b")',
        expected: [{ body: "a" }],
      },
      flatMap: {
        expression: "entries.flatMap((entry) => [entry.body])",
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
              const send = handler<{ body?: string }, { entries: Writable<Message[]> }>(
                (event, state) => { state.entries.push({ body: event.body ?? "" }); },
              );
              type Entry = WriteAuthorizedBy<Message, typeof send>;
              export default pattern<{ entries: Writable<Entry[]> }>(({ entries }) => ({
                value: ${expression},
                send: send({ entries }),
              }));
            `,
          }],
        });
        const tx = runtime.edit();
        const entries = runtime.getCell(space, "entries", undefined, tx);
        entries.set([entryCell(tx, "row-a", "a"), entryCell(tx, "row-b", "b")]);
        const output = runtime.getCell<{ value: unknown }>(
          space,
          "output",
          compiled.resultSchema,
          tx,
        );
        const result = runtime.run(tx, compiled, { entries }, output);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        const cancel = result.sink(() => {});
        await runtime.idle();

        expect(await result.key("value").pull()).toEqual(expected);
        expect(errors).toEqual([]);
        cancel();
      });
    }
  });
});
