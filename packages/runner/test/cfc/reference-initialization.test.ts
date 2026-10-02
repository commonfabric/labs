import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { recordNewProtectedDefaults } from "../../src/cfc/default-initialization.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  recordCapturedArgumentFields,
  recordReferencedArgumentFields,
} from "../../src/cfc/reference-initialization.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { areLinksSame } from "../../src/link-utils.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("reference-initialization-owner");
const stager = await Identity.fromPassphrase(
  "reference-initialization-stager",
);
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

  /** Every confidentiality atom `cell`'s stored label map holds at `path`. */
  function confidentialityAt(
    cell: { getAsNormalizedFullLink(): NormalizedFullLink },
    path: readonly string[],
  ): unknown[] {
    return (readStoredCfcMetadata(
      runtime.edit(),
      cell.getAsNormalizedFullLink(),
    )
      ?.labelMap.entries ?? [])
      .filter((entry) => entry.path.join("/") === path.join("/"))
      .flatMap((entry) => entry.label.confidentiality ?? []);
  }

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
        mode: "capture",
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

  describe("recordCapturedArgumentFields()", () => {
    it("records each link within a named field, a write redirect among them, at its own path", () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", undefined, tx);
      const entry = entryCell(tx, "entry", "a");
      const redirect = entry.getAsWriteRedirectLink();
      const link = entry.getAsLink();
      argument.setRaw({
        params: {
          redirect,
          nested: { link, note: "kept as a value" },
          list: [link, 1],
        },
      });

      recordCapturedArgumentFields(
        tx,
        argument.getAsNormalizedFullLink(),
        ["params"],
      );

      const recorded = tx.getCfcState().writePolicyInputs.filter((input) =>
        input.kind === "initialization"
      );
      expect(recorded.every((input) => input.mode === "capture")).toBe(true);
      expect(recorded.map((input) => [input.target.path, input.value]))
        .toEqual([
          [["params", "redirect"], redirect],
          [["params", "nested", "link"], link],
          [["params", "list", "0"], link],
        ]);
      expect(recorded.every((input) => tx.isRuntimeWritePolicyInput(input)))
        .toBe(true);
    });

    it("records nothing for a named field that holds only values, or nothing", () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.setRaw({ params: { body: "forged", tags: ["a"], n: 1 } });

      recordCapturedArgumentFields(
        tx,
        argument.getAsNormalizedFullLink(),
        ["params", "missing"],
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
        mode: "capture",
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
        mode: "capture",
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

  describe("a captured binding staged as a write redirect", () => {
    // The owner's list is initialized as a protected default in a transaction
    // attributed to the owner, so its stored label names the owner. A
    // collection builtin stages a write redirect to it into each sub-pattern's
    // `params`, as the binding the builtin's callback captures.

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
    const boardSchema: JSONSchema = {
      type: "object",
      properties: {
        items: { ...ownedList, default: [] },
        note: { type: "string" },
      },
    };
    /** An argument schema whose `params` holds `captures`. */
    const capturing = (captures: Record<string, JSONSchema>): JSONSchema => ({
      type: "object",
      properties: { params: { type: "object", properties: captures } },
    });
    const capturingSchema = capturing({
      items: { ...ownedList, asCell: ["readonly"] },
    });

    /**
     * Initializes the owner's list on `board`, in a transaction attributed to
     * the owner as a handler run of theirs is.
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

    /**
     * A write redirect to the list on `board`, carrying `schema` in its
     * payload when one is given, as a pattern's bound capture does.
     */
    function captured(
      tx: ReturnType<Runtime["edit"]>,
      board = "board",
      schema?: JSONSchema,
    ) {
      return runtime.getCell(space, board, undefined, tx).key("items")
        .asSchema(schema).getAsWriteRedirectLink({
          includeSchema: schema !== undefined,
        });
    }

    /**
     * Stages `params` into the argument named `name` under `schema`, and
     * records its links as a collection builtin does unless `recorded` is
     * `false`.
     */
    function stage(
      tx: ReturnType<Runtime["edit"]>,
      params: unknown,
      { name = "argument", recorded = true, schema = capturingSchema } = {},
    ) {
      const argument = runtime.getCell(space, name, schema, tx);
      argument.set({ params });
      if (recorded) {
        recordCapturedArgumentFields(tx, argument.getAsNormalizedFullLink(), [
          "params",
        ]);
      }
      return argument;
    }

    /** Stages `params` as `stage()` does, in a transaction of its own. */
    async function commitStaging(
      params: (tx: ReturnType<Runtime["edit"]>) => unknown,
      options: Parameters<typeof stage>[2] = {},
    ) {
      const tx = runtime.edit();
      stage(tx, params(tx), options);
      runtime.prepareTxForCommit(tx);
      return (await tx.commit()).error?.message;
    }

    /** The owner's list, read outside any transaction under test. */
    function ownersList(): unknown {
      return runtime.getCell(space, "board").key("items").get();
    }

    it("accepts it into an absent owner-protected field once it is recorded", async () => {
      await initializeOwnersList();
      // The same staging is committed twice, recorded and not, so the recording
      // is what the acceptance turns on.
      for (const recorded of [false, true]) {
        const tx = runtime.edit();
        stage(tx, { items: captured(tx) }, {
          name: `argument-${recorded}`,
          recorded,
        });
        runtime.prepareTxForCommit(tx);
        const error = (await tx.commit()).error?.message;

        if (recorded) expect(error).toBeUndefined();
        else expect(error).toContain("writeAuthorizedBy");
      }
    });

    it("accepts it from a principal other than the owner, and from the owner over it after", async () => {
      await initializeOwnersList();
      for (const principal of [stager.did(), signer.did()]) {
        actingPrincipal = principal;
        const tx = runtime.edit();
        stage(tx, { items: captured(tx) });
        runtime.prepareTxForCommit(tx);

        expect((await tx.commit()).error).toBeUndefined();
      }
    });

    it("refuses a write through it, in the transaction staging it, without the list's writer", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = stage(tx, { items: captured(tx) });
      argument.key("params").key("items").set(["forged"]);
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /items",
      );
      expect(ownersList()).toEqual([]);
    });

    it("refuses a write through it by a principal other than the list's owner", async () => {
      await initializeOwnersList();
      actingPrincipal = stager.did();
      const staging = runtime.edit();
      stage(staging, { items: captured(staging) });
      runtime.prepareTxForCommit(staging);
      expect((await staging.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      runtime.getCell(space, "argument", capturingSchema, tx).key("params")
        .key("items").set(["forged"]);
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain(
        "ownerPrincipal mismatch at /items",
      );
      expect(ownersList()).toEqual([]);
    });

    it("refuses a value staged in its place", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      stage(tx, { items: ["forged"] });
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /params/items",
      );
    });

    it("refuses a write redirect to another cell staged over one the field holds", async () => {
      await initializeOwnersList();
      await initializeOwnersList("other-board");
      const first = runtime.edit();
      const held = captured(first);
      stage(first, { items: held });
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();

      const second = runtime.edit();
      stage(second, { items: captured(second, "other-board") });
      runtime.prepareTxForCommit(second);

      expect((await second.commit()).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /params/items",
      );
      expect(
        runtime.getCell(space, "argument").key("params").key("items").getRaw(),
      ).toEqual(held);
    });

    for (const emptiedFirst of [false, true]) {
      it(
        `accepts it again under another schema over the slot that holds it${
          emptiedFirst
            ? ", after the transaction empties the record holding it"
            : ""
        }`,
        async () => {
          // A later version of the pattern binds the same cell under a
          // schema of its own, so the bytes it stages differ while the cell
          // they name does not. Staged over the stored link, the same cell
          // lands no write; staged into a record the transaction emptied
          // first, it lands one.
          await initializeOwnersList();
          expect(
            await commitStaging((tx) => ({
              items: captured(tx, "board", ownedList),
            })),
          ).toBeUndefined();
          const revised: JSONSchemaObj = {
            ...ownedList,
            description: "the owner's list, revised",
          };

          const tx = runtime.edit();
          if (emptiedFirst) {
            runtime.getCell(space, "argument", undefined, tx).key("params")
              .setRaw({});
          }
          stage(tx, { items: captured(tx, "board", revised) });
          runtime.prepareTxForCommit(tx);

          expect((await tx.commit()).error).toBeUndefined();
          expect(
            areLinksSame(
              runtime.getCell(space, "argument").key("params").key("items")
                .getRaw(),
              captured(runtime.edit()),
            ),
          ).toBe(true);
        },
      );
    }

    for (const emptied of ["params", "root", "slot"]) {
      it(`refuses a write redirect to another cell staged over the slot after the transaction empties the ${emptied}`, async () => {
        await initializeOwnersList();
        await initializeOwnersList("other-board");
        expect(await commitStaging((tx) => ({ items: captured(tx) })))
          .toBeUndefined();

        const tx = runtime.edit();
        const raw = runtime.getCell(space, "argument", undefined, tx);
        if (emptied === "params") raw.key("params").setRaw({});
        if (emptied === "root") raw.setRaw({});
        if (emptied === "slot") {
          raw.key("params").key("items").setRaw(undefined);
        }
        stage(tx, { items: captured(tx, "other-board") });
        runtime.prepareTxForCommit(tx);

        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy requires a trusted verified binding identity at /params/items",
        );
        expect(
          runtime.getCell(space, "argument").key("params").key("items")
            .getRaw(),
        ).toEqual(captured(runtime.edit()));
      });
    }

    it("refuses a value beside a staged link under a protected record in params", async () => {
      // The link's record covers the link's own slot, never the protected
      // record holding it.
      await initializeOwnersList();
      const schema = capturing({
        record: {
          type: "object",
          properties: {
            items: { ...ownedList, asCell: ["readonly"] },
            note: { type: "string" },
          },
          ifc: { writeAuthorizedBy: writer },
        },
      });

      expect(
        await commitStaging(
          (tx) => ({ record: { items: captured(tx), note: "forged" } }),
          { schema },
        ),
      ).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /params/record",
      );
    });

    it("refuses a value beside a staged link in a list whose items are protected", async () => {
      await initializeOwnersList();
      const schema = capturing({
        list: {
          type: "array",
          items: { ...ownedList, asCell: ["readonly"] },
        },
      });

      expect(
        await commitStaging(
          (tx) => ({ list: [captured(tx), "forged"] }),
          { schema },
        ),
      ).toContain("writeAuthorizedBy");
    });

    it("keeps the confidentiality its link carries on the slot when it is staged again", async () => {
      // The slot declares a writer and no confidentiality; the list it names
      // is secret, and only the link's own label says so at the slot.
      const secretList: JSONSchemaObj = {
        type: "array",
        items: { type: "string" },
        ifc: { confidentiality: ["secret"] },
      };
      const seed = runtime.edit();
      runtime.getCell(space, "secret-board", {
        type: "object",
        properties: { items: secretList },
      }, seed).set({ items: ["a"] });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).error).toBeUndefined();
      const schema = capturing({
        items: {
          type: "array",
          items: { type: "string" },
          asCell: ["readonly"],
          ifc: { writeAuthorizedBy: writer },
        },
      });

      for (const _ of ["staged", "staged again"]) {
        expect(
          await commitStaging(
            (tx) => ({ items: captured(tx, "secret-board") }),
            { schema },
          ),
        ).toBeUndefined();
        expect(
          confidentialityAt(runtime.getCell(space, "argument"), [
            "params",
            "items",
          ]),
        ).toContain("secret");
      }
    });
  });

  describe("labels of a staged reference", () => {
    // The owner's message is initialized as a protected default, which mints
    // the owner's authorship on it. Another principal then stages a reference
    // to the message into a new argument, as a collection coordinator running
    // for someone else does.

    const inboxSchema: JSONSchema = {
      type: "object",
      properties: {
        message: { ...entrySchema, default: { body: "a" } },
        note: { type: "string" },
      },
    };

    /**
     * Initializes the owner's message with protected-default authorship, in
     * a transaction attributed to the owner as a handler run of theirs is.
     */
    async function initializeOwnersMessage(schema: JSONSchema = inboxSchema) {
      const seed = runtime.edit();
      runtime.getCell(space, "inbox", undefined, seed).set({ note: "saved" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).error).toBeUndefined();

      const first = runtime.edit();
      first.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      const inbox = runtime.getCell(space, "inbox", schema, first);
      recordNewProtectedDefaults(
        first,
        inbox.getAsNormalizedFullLink(),
        { type: "object", properties: { note: { type: "string" } } },
        schema,
        { message: { body: "a" } },
        { message: { body: "a" }, note: "saved" },
      );
      inbox.set({ message: { body: "a" }, note: "saved" });
      runtime.prepareTxForCommit(first);
      expect((await first.commit()).error).toBeUndefined();
    }

    /** Stages a reference to the message as `stager`, and commits. */
    async function stageAsStager(
      schema: JSONSchema,
      message: (tx: ReturnType<Runtime["edit"]>) => unknown,
    ) {
      actingPrincipal = stager.did();
      const stage = runtime.edit();
      const argument = runtime.getCell(space, "argument", schema, stage);
      argument.set({ element: message(stage) });
      recordReferencedArgumentFields(
        stage,
        argument.getAsNormalizedFullLink(),
        ["element"],
      );
      runtime.prepareTxForCommit(stage);
      return {
        error: (await stage.commit()).error,
        argument: argument.getAsNormalizedFullLink(),
      };
    }

    /** The subjects of every `authored-by` claim stored at `path`. */
    function authorsAt(
      link: NormalizedFullLink,
      path: readonly string[],
    ): unknown[] {
      return (readStoredCfcMetadata(runtime.edit(), link)?.labelMap.entries ??
        [])
        .filter((entry) => entry.path.join("/") === path.join("/"))
        .flatMap((entry) => entry.label.integrity ?? [])
        .filter((atom) => isObjectOrArray(atom) && atom.kind === "authored-by")
        .map((atom) => (atom as { subject: unknown }).subject);
    }

    it("stores the entry's own authorship on a staged reference, and none for the principal that stages it", async () => {
      await initializeOwnersMessage();
      const { error, argument } = await stageAsStager(
        argumentSchema,
        (tx) =>
          runtime.getCell(space, "inbox", undefined, tx).key("message")
            .asSchema(entrySchema),
      );

      expect(error).toBeUndefined();
      expect(authorsAt(argument, ["element"])).toEqual([signer.did()]);
    });

    /**
     * Stages a chain from the owner's message through two arguments as `stager`.
     */
    async function stageChainAsStager(
      secondSchema: JSONSchema,
      downstreamFirst = false,
    ) {
      actingPrincipal = stager.did();
      const stage = runtime.edit();
      const first = runtime.getCell(space, "first", argumentSchema, stage);
      const second = runtime.getCell(space, "second", secondSchema, stage);
      const stageFirst = () => {
        first.set({
          element: runtime.getCell(space, "inbox", undefined, stage)
            .key("message").asSchema(entrySchema),
        });
        recordReferencedArgumentFields(
          stage,
          first.getAsNormalizedFullLink(),
          ["element"],
        );
      };
      const stageSecond = () => {
        second.set({ element: first.key("element") });
        recordReferencedArgumentFields(
          stage,
          second.getAsNormalizedFullLink(),
          ["element"],
        );
      };
      if (downstreamFirst) {
        stageSecond();
        stageFirst();
      } else {
        stageFirst();
        stageSecond();
      }
      runtime.prepareTxForCommit(stage);
      return {
        error: (await stage.commit()).error,
        second: second.getAsNormalizedFullLink(),
      };
    }

    it("stores the owner's authorship, and none for the staging principal, on a reference staged from another staged reference", async () => {
      await initializeOwnersMessage();
      const { error, second } = await stageChainAsStager(argumentSchema);

      expect(error).toBeUndefined();
      expect(authorsAt(second, ["element"])).toEqual([signer.did()]);
    });

    it("preserves the owner's authorship when the downstream reference is staged first", async () => {
      await initializeOwnersMessage();
      const { error, second } = await stageChainAsStager(argumentSchema, true);

      expect(error).toBeUndefined();
      expect(authorsAt(second, ["element"])).toEqual([signer.did()]);
    });

    for (
      const [name, principal] of [
        ["owner", signer],
        ["stager", stager],
      ] as const
    ) {
      it(`${name === "owner" ? "accepts" : "refuses"} the ${name}'s authorship floor when the downstream reference is staged first`, async () => {
        await initializeOwnersMessage();
        const { error } = await stageChainAsStager({
          type: "object",
          properties: {
            element: {
              ...entrySchema,
              ifc: {
                ...entrySchema.ifc,
                requiredIntegrity: [{
                  kind: "authored-by",
                  subject: principal.did(),
                }],
              },
            },
          },
        }, true);

        if (name === "owner") expect(error).toBeUndefined();
        else expect(error?.message).toContain("write floor failed at /element");
      });
    }

    it("preserves authorship through a chain of references in the same argument", async () => {
      await initializeOwnersMessage();
      actingPrincipal = stager.did();
      const stage = runtime.edit();
      const argument = runtime.getCell(space, "argument", {
        type: "object",
        properties: { first: entrySchema, second: entrySchema },
      }, stage);
      argument.set({
        second: argument.key("first"),
        first: runtime.getCell(space, "inbox", undefined, stage)
          .key("message").asSchema(entrySchema),
      });
      const link = argument.getAsNormalizedFullLink();
      recordReferencedArgumentFields(stage, link, ["second", "first"]);
      runtime.prepareTxForCommit(stage);

      expect((await stage.commit()).error).toBeUndefined();
      expect(authorsAt(link, ["second"])).toEqual([signer.did()]);
    });

    it("preserves authorship through three references staged from the downstream end", async () => {
      await initializeOwnersMessage();
      actingPrincipal = stager.did();
      const stage = runtime.edit();
      const first = runtime.getCell(space, "first", argumentSchema, stage);
      const second = runtime.getCell(space, "second", argumentSchema, stage);
      const third = runtime.getCell(space, "third", argumentSchema, stage);
      third.set({ element: second.key("element") });
      second.set({ element: first.key("element") });
      first.set({
        element: runtime.getCell(space, "inbox", undefined, stage)
          .key("message").asSchema(entrySchema),
      });
      for (const argument of [third, second, first]) {
        recordReferencedArgumentFields(
          stage,
          argument.getAsNormalizedFullLink(),
          ["element"],
        );
      }
      runtime.prepareTxForCommit(stage);

      expect((await stage.commit()).error).toBeUndefined();
      expect(authorsAt(third.getAsNormalizedFullLink(), ["element"]))
        .toEqual([signer.did()]);
    });

    for (const linkFirst of [false, true]) {
      it(`stores a staged reference's labels below a link to its argument when the ${linkFirst ? "link" : "reference"} is staged first`, async () => {
        // The link covers the whole argument, so the reference's labels land at
        // `element` beneath it and the argument slot gains none of them.

        await initializeOwnersMessage({
          type: "object",
          properties: {
            message: {
              ...entrySchema,
              default: { body: "a" },
              ifc: { ...entrySchema.ifc, confidentiality: ["owner-secret"] },
            },
            note: { type: "string" },
          },
        });
        actingPrincipal = stager.did();
        const stage = runtime.edit();
        const argument = runtime.getCell(space, "first", argumentSchema, stage);
        const holder = runtime.getCell(space, "holder", {
          type: "object",
          properties: {
            argument: { type: "object", ifc: { confidentiality: ["holder"] } },
          },
        }, stage);
        const stageReference = () => {
          argument.set({
            element: runtime.getCell(space, "inbox", undefined, stage)
              .key("message").asSchema(entrySchema),
          });
          recordReferencedArgumentFields(
            stage,
            argument.getAsNormalizedFullLink(),
            ["element"],
          );
        };
        const stageLink = () => holder.set({ argument });
        if (linkFirst) {
          stageLink();
          stageReference();
        } else {
          stageReference();
          stageLink();
        }
        runtime.prepareTxForCommit(stage);

        expect((await stage.commit()).error).toBeUndefined();
        const link = holder.getAsNormalizedFullLink();
        expect(authorsAt(link, ["argument", "element"])).toEqual([
          signer.did(),
        ]);
        expect(
          (readStoredCfcMetadata(runtime.edit(), link)?.labelMap.entries ?? [])
            .filter((entry) => entry.path.join("/") === "argument/element")
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toContain("owner-secret");
        expect(authorsAt(link, ["argument"])).toEqual([]);
      });
    }

    for (const endorsed of [true, false]) {
      it(`${endorsed ? "credits a nested integrity floor and carries nested confidentiality" : "refuses a nested floor credited only by an ancestor"} through a pending reference`, async () => {
        await initializeOwnersMessage({
          type: "object",
          properties: {
            note: { type: "string" },
            message: {
              ...entrySchema,
              default: { body: "a" },
              properties: {
                body: {
                  type: "string",
                  ifc: {
                    confidentiality: ["nested-secret"],
                    integrity: ["nested-body"],
                  },
                },
              },
            },
          },
        });
        actingPrincipal = stager.did();
        const stage = runtime.edit();
        const first = runtime.getCell(space, "first", argumentSchema, stage);
        const second = runtime.getCell(space, "second", {
          type: "object",
          properties: {
            element: {
              ...entrySchema,
              properties: {
                body: {
                  type: "string",
                  ifc: {
                    requiredIntegrity: endorsed ? ["nested-body"] : [{
                      kind: "authored-by",
                      subject: signer.did(),
                    }],
                  },
                },
              },
            },
          },
        }, stage);
        second.set({
          element: first.key("element"),
        });
        recordReferencedArgumentFields(
          stage,
          second.getAsNormalizedFullLink(),
          ["element"],
        );
        first.set({
          element: runtime.getCell(space, "inbox", undefined, stage)
            .key("message").asSchema(entrySchema),
        });
        recordReferencedArgumentFields(
          stage,
          first.getAsNormalizedFullLink(),
          ["element"],
        );
        runtime.prepareTxForCommit(stage);

        const error = (await stage.commit()).error;
        if (!endorsed) {
          expect(error?.message).toContain(
            "write floor failed at /element/body",
          );
          return;
        }
        expect(error).toBeUndefined();
        const entries = readStoredCfcMetadata(
          runtime.edit(),
          second.getAsNormalizedFullLink(),
        )!.labelMap.entries;
        const labels = entries.filter((entry) =>
          entry.path.join("/") === "element/body"
        ).map((entry) => entry.label);
        expect(labels.flatMap((label) => label.confidentiality ?? []))
          .toContain("nested-secret");
        expect(labels.flatMap((label) => label.integrity ?? []))
          .toContain("nested-body");
      });
    }

    it("commits an object whose staged reference points back to itself", async () => {
      const tx = runtime.edit();
      const argument = runtime.getCell(space, "argument", {
        type: "object",
        properties: { element: { type: "object" }, index: { type: "number" } },
        ifc: { integrity: ["root-proof"] },
      }, tx);
      argument.set({ index: 7, element: argument });
      recordReferencedArgumentFields(tx, argument.getAsNormalizedFullLink(), [
        "element",
      ]);
      expect(argument.key("element").key("index").get()).toBe(7);
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error).toBeUndefined();
      expect(
        runtime.getCell(space, "argument").key("element")
          .key("index").get(),
      ).toBe(7);
      const entries = readStoredCfcMetadata(
        runtime.edit(),
        argument.getAsNormalizedFullLink(),
      )!.labelMap.entries;
      expect(
        entries.filter((entry) => entry.path.join("/") === "element")
          .flatMap((entry) => entry.label.integrity ?? []),
      )
        .toContain("root-proof");
    });

    for (const secondFirst of [false, true]) {
      for (const throughSlot of [false, true]) {
        it(`commits mutually referring objects${throughSlot ? " through an intermediate reference" : ""} when the ${secondFirst ? "second" : "first"} is staged first`, async () => {
          const tx = runtime.edit();
          const schema: JSONSchema = {
            type: "object",
            properties: {
              element: { type: "object" },
              index: { type: "number" },
            },
            ifc: { integrity: ["root-proof"] },
          };
          const first = runtime.getCell(space, "first", schema, tx);
          const second = runtime.getCell(space, "second", schema, tx);
          const stageFirst = () => first.set({ index: 1, element: second });
          const stageSecond = () =>
            second.set({
              index: 2,
              element: throughSlot ? first.key("element") : first,
            });
          if (secondFirst) {
            stageSecond();
            stageFirst();
          } else {
            stageFirst();
            stageSecond();
          }
          for (const argument of [first, second]) {
            recordReferencedArgumentFields(
              tx,
              argument.getAsNormalizedFullLink(),
              [
                "element",
              ],
            );
          }
          runtime.prepareTxForCommit(tx);

          expect((await tx.commit()).error).toBeUndefined();
          expect(
            runtime.getCell(space, "first").key("element").key("element")
              .key("index").get(),
          ).toBe(throughSlot ? 2 : 1);
        });
      }
    }

    for (const holderFirst of [false, true]) {
      for (const endorsed of [false, true]) {
        it(`${endorsed ? "credits the owner's floor and confidentiality" : "refuses the stager's floor"} through repeated object back-references when the ${holderFirst ? "holder" : "object"} is staged first`, async () => {
          await initializeOwnersMessage({
            ...inboxSchema,
            properties: {
              message: {
                ...entrySchema,
                default: { body: "a" },
                ifc: { ...entrySchema.ifc, confidentiality: ["owner-secret"] },
              },
            },
          });
          actingPrincipal = stager.did();
          const tx = runtime.edit();
          const argument = runtime.getCell(space, "argument", {
            type: "object",
            properties: { element: { type: "object" }, message: entrySchema },
            ifc: { integrity: ["object-proof"] },
          }, tx);
          const holder = runtime.getCell(space, "holder", {
            type: "object",
            properties: {
              argument: {
                type: "object",
                ifc: { confidentiality: ["holder"] },
                properties: {
                  message: {
                    type: "object",
                    ifc: {
                      requiredIntegrity: [{
                        kind: "authored-by",
                        subject: (endorsed ? signer : stager).did(),
                      }],
                    },
                  },
                },
              },
            },
          }, tx);
          const stageArgument = () => {
            argument.set({
              element: argument,
              message: runtime.getCell(space, "inbox", undefined, tx)
                .key("message").asSchema(entrySchema),
            });
            recordReferencedArgumentFields(
              tx,
              argument.getAsNormalizedFullLink(),
              [
                "element",
                "message",
              ],
            );
          };
          const stageHolder = () => {
            holder.set({
              argument: argument.key("element").key("element").key("element")
                .asSchema({
                  type: "object",
                  ifc: { confidentiality: ["holder"] },
                }),
            });
            recordReferencedArgumentFields(
              tx,
              holder.getAsNormalizedFullLink(),
              ["argument"],
            );
          };
          if (holderFirst) {
            stageHolder();
            stageArgument();
          } else {
            stageArgument();
            stageHolder();
          }
          runtime.prepareTxForCommit(tx);
          const error = (await tx.commit()).error;
          if (!endorsed) {
            expect(error?.message).toContain(
              "write floor failed at /argument/message",
            );
            return;
          }
          expect(error).toBeUndefined();
          const link = holder.getAsNormalizedFullLink();
          expect(authorsAt(link, ["argument", "message"])).toEqual([
            signer.did(),
          ]);
          expect(authorsAt(link, ["argument"])).toEqual([]);
          expect(
            readStoredCfcMetadata(runtime.edit(), link)!.labelMap.entries
              .filter((entry) => entry.path.join("/") === "argument/message")
              .flatMap((entry) => entry.label.confidentiality ?? []),
          )
            .toContain("owner-secret");
        });
      }
    }

    for (const growing of [false, true]) {
      it(`refuses a staged reference to ${growing ? "its own descendant" : "itself"} inside a linked object`, async () => {
        const tx = runtime.edit();
        const argument = runtime.getCell(space, "argument", argumentSchema, tx);
        const holder = runtime.getCell(space, "holder", {
          type: "object",
          properties: {
            argument: { type: "object", ifc: { confidentiality: ["holder"] } },
          },
        }, tx);
        holder.set({ argument });
        argument.set({});
        const source = growing
          ? argument.key("element").key("body")
          : argument.key("element");
        const target = {
          ...argument.getAsNormalizedFullLink(),
          path: ["element"],
        };
        tx.writeValueOrThrow(target, source.getAsLink());
        tx.recordCfcWritePolicyInput({
          kind: "link-write",
          target,
          source: source.getAsNormalizedFullLink(),
        });
        recordReferencedArgumentFields(tx, argument.getAsNormalizedFullLink(), [
          "element",
        ]);
        runtime.prepareTxForCommit(tx);

        expect((await tx.commit()).error?.message).toContain(
          "cyclic staged reference in link label derivation",
        );
      });
    }

    it("resolves a repeated link whose source projection switches to a concrete sibling", async () => {
      const tx = runtime.edit();
      const first = runtime.getCell(space, "first", argumentSchema, tx);
      const second = runtime.getCell(space, "second", {
        type: "object",
        properties: { element: entrySchema, body: { type: "string" } },
        ifc: { integrity: ["object-proof"] },
      }, tx);
      first.set({ element: second });
      second.set({ element: first.key("element").key("body"), body: "value" });
      for (const cell of [first, second]) {
        recordReferencedArgumentFields(tx, cell.getAsNormalizedFullLink(), [
          "element",
        ]);
      }
      expect(first.key("element").key("element").get()).toBe("value");
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error).toBeUndefined();
    });

    it("refuses a pointer loop whose path grows across linked objects", async () => {
      const tx = runtime.edit();
      const first = runtime.getCell(space, "first", argumentSchema, tx);
      const second = runtime.getCell(space, "second", argumentSchema, tx);
      first.set({ element: second });
      second.set({ element: first.key("element").key("element").key("body") });
      for (const cell of [first, second]) {
        recordReferencedArgumentFields(tx, cell.getAsNormalizedFullLink(), [
          "element",
        ]);
      }
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain(
        "cyclic staged reference in link label derivation",
      );
    });

    it("refuses a cycle of staged references without borrowing schema authorship", async () => {
      actingPrincipal = stager.did();
      const stage = runtime.edit();
      const first = runtime.getCell(space, "first", argumentSchema, stage);
      const second = runtime.getCell(space, "second", argumentSchema, stage);
      first.set({ element: second.key("element") });
      second.set({ element: first.key("element") });
      for (const argument of [first, second]) {
        recordReferencedArgumentFields(
          stage,
          argument.getAsNormalizedFullLink(),
          ["element"],
        );
      }
      runtime.prepareTxForCommit(stage);

      expect((await stage.commit()).error?.message).toContain(
        "cyclic staged reference in link label derivation",
      );
    });

    it("refuses an integrity floor that only the staging principal's authorship would meet on a reference staged from another staged reference", async () => {
      await initializeOwnersMessage();
      const { error } = await stageChainAsStager({
        type: "object",
        properties: {
          element: {
            ...entrySchema,
            ifc: {
              ...entrySchema.ifc,
              requiredIntegrity: [{
                kind: "authored-by",
                subject: stager.did(),
              }],
            },
          },
        },
      });

      expect(error?.message).toContain("write floor failed at /element");
    });

    it("stores no authorship on a reference to an entry the staging principal created in the same transaction", async () => {
      // The entry is written outside the slot's writer, so the slot's schema
      // does not describe how it was written.

      const { error, argument } = await stageAsStager(
        argumentSchema,
        (tx) => entryCell(tx, "fresh", "a"),
      );

      expect(error).toBeUndefined();
      expect(authorsAt(argument, ["element"])).toEqual([]);
    });

    it("refuses an integrity floor at the slot that only authorship minted for the staging principal would meet", async () => {
      await initializeOwnersMessage();
      const flooredEntry: JSONSchemaObj = {
        ...entrySchema,
        ifc: {
          ...entrySchema.ifc,
          requiredIntegrity: [{ kind: "authored-by", subject: stager.did() }],
        },
      };
      const { error } = await stageAsStager(
        {
          type: "object",
          properties: { element: flooredEntry },
        },
        (tx) => runtime.getCell(space, "inbox", undefined, tx).key("message"),
      );

      expect(error?.message).toContain("write floor failed at /element");
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

  describe("a list operation whose callback captures a protected list", () => {
    // The callback binds the list's writer to the list, so the list reaches
    // each sub-pattern's argument as a captured binding: a write redirect to
    // the list, under the list's own policy. The list sits in the result
    // because the writer binding names the handler the pattern exports.

    /** The list's protection: its writer alone, or its writer and its owner. */
    const protections = {
      writer: "WriteAuthorizedBy<string[], typeof edit>",
      owner: `RepresentsCurrentUser<
        Cfc<
          WriteAuthorizedBy<string[], typeof edit>,
          { ownerPrincipal: CurrentPrincipal }
        >
      >`,
    };

    /**
     * The program computing `rows` by `expression`, over a list under
     * `protection`. `gated` shows the rows only once `reveal` is sent, as an
     * edit form is shown, and `listDoc` documents the list's type, which its
     * schema carries.
     */
    function capturingProgram(
      expression: string,
      protection: keyof typeof protections,
      { gated = false, listDoc = "" } = {},
    ) {
      const rows = gated ? `ifElse(shown, ${expression}, [])` : expression;
      return {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `/// <cts-enable />
            import {
              Cfc,
              CurrentPrincipal,
              handler,
              ifElse,
              pattern,
              RepresentsCurrentUser,
              Writable,
              WriteAuthorizedBy,
            } from "commonfabric";
            const edit = handler<
              { add?: string; remove?: string },
              { items: Writable<string[]> }
            >((event, { items }) => {
              const kept = items.get().filter((item) => item !== event.remove);
              items.set(event.add === undefined ? kept : [...kept, event.add]);
            });
            const show = handler<unknown, { shown: Writable<boolean> }>(
              (_, { shown }) => {
                shown.set(true);
              },
            );
            ${listDoc}
            type Items = ${protections[protection]};
            export default pattern<Record<string, never>>(() => {
              const items = new Writable<Items>([]).for("items");
              const shown = new Writable<boolean>(false).for("shown");
              return {
                items,
                rows: ${rows},
                add: edit({ items }),
                reveal: show({ shown }),
              };
            });
          `,
        }],
      };
    }

    /** Compiles `capturingProgram()`'s program. */
    function compileCapturing(
      expression: string,
      protection: keyof typeof protections,
    ) {
      return runtime.patternManager.compilePattern(
        capturingProgram(expression, protection),
      );
    }

    /**
     * Runs the pattern with `rows` computed by `expression`, over a list under
     * `protection`, adds two items through the list's writer as the owner and
     * waits for both to commit, and returns the result and every error the
     * scheduler reported.
     */
    async function runCapturing(
      expression: string,
      protection: keyof typeof protections = "writer",
    ) {
      const errors: unknown[] = [];
      runtime.scheduler.onError((error) => errors.push(error));
      const compiled = await compileCapturing(expression, protection);
      const tx = runtime.edit();
      const output = runtime.getCell<{
        items: string[];
        rows: (string | { item: string })[];
        add: unknown;
      }>(space, "output", compiled.resultSchema, tx);
      const result = runtime.run(tx, compiled, {}, output);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const cancel = result.sink(() => {});
      await runtime.idle();
      result.key("add").send({ add: "a" });
      await runtime.idle();
      result.key("add").send({ add: "b" });
      await runtime.idle();
      // The second write's commit can still be in flight once the scheduler
      // is idle; settling it keeps teardown from cutting it off.
      await manager.synced();
      return { result, errors, cancel };
    }

    /** The item each row shows: the row itself, or the row's `item`. */
    function itemsOf(rows: readonly (string | { item: string })[]): string[] {
      return rows.map((row) => typeof row === "string" ? row : row.item);
    }

    const operations = {
      map: {
        expression: "items.map((item) => ({ item, remove: edit({ items }) }))",
        expected: ["a", "b"],
      },
      filter: {
        expression: "items.filter((item) => items.get().indexOf(item) === 0)",
        expected: ["a"],
      },
      flatMap: {
        expression:
          "items.flatMap((item) => [{ item, remove: edit({ items }) }])",
        expected: ["a", "b"],
      },
    };

    for (const [name, { expression, expected }] of Object.entries(operations)) {
      it(`hands the captured list to the callback of \`${name}()\``, async () => {
        const { result, errors, cancel } = await runCapturing(expression);

        expect(itemsOf(await result.key("rows").pull())).toEqual(expected);
        expect(errors).toEqual([]);
        cancel();
      });
    }

    it("lets a row's handler write the list through the captured binding, and refuses a write through it without the list's writer", async () => {
      const { result, errors, cancel } = await runCapturing(
        operations.map.expression,
      );
      const row = result.key("rows").key(0).resolveAsCell();

      row.key("remove").send({ remove: "a" });
      await runtime.idle();
      expect(await result.key("items").pull()).toEqual(["b"]);

      const tx = runtime.edit();
      row.getArgumentCell<{ params: { items: string[] } }>()!.withTx(tx)
        .key("params").key("items").set(["forged"]);
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity",
      );
      expect(await result.key("items").pull()).toEqual(["b"]);
      expect(errors).toEqual([]);
      cancel();
    });

    it("hands an owner-protected list to each row, whose handler writes the list for its owner and is refused for anyone else", async () => {
      const { result, errors, cancel } = await runCapturing(
        operations.map.expression,
        "owner",
      );
      expect(itemsOf(await result.key("rows").pull())).toEqual(["a", "b"]);
      expect(errors).toEqual([]);
      const remove = (item: string) =>
        result.key("rows").key(0).resolveAsCell().key("remove").send({
          remove: item,
        });

      actingPrincipal = stager.did();
      remove("a");
      await runtime.idle();
      await manager.synced();
      expect(await result.key("items").pull()).toEqual(["a", "b"]);

      actingPrincipal = signer.did();
      remove("a");
      await runtime.idle();
      await manager.synced();
      expect(await result.key("items").pull()).toEqual(["b"]);
      cancel();
    });

    it("re-stages each row's captured list after a pattern version revises the list's schema", async () => {
      const { result, errors, cancel } = await runCapturing(
        operations.map.expression,
      );
      const revised = await runtime.patternManager.compilePattern(
        capturingProgram(operations.map.expression, "writer", {
          listDoc: "/** The list, revised. */",
        }),
      );

      const tx = runtime.edit();
      runtime.run(
        tx,
        revised,
        {},
        runtime.getCell(space, "output", revised.resultSchema, tx),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await manager.synced();

      expect(itemsOf(await result.key("rows").pull())).toEqual(["a", "b"]);
      expect(errors).toEqual([]);
      cancel();
    });

    it("stages an owner-protected list into the rows a non-owner's runtime shows, and refuses that non-owner's write through it", async () => {
      // The owner's runtime adds the items and never shows the rows, so the
      // rows are staged first by the non-owner's runtime, which shows them.
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const ownerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const visitorStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const ownerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: ownerStorage,
        trustSnapshotProvider: () => ({
          id: signer.did(),
          actingPrincipal: signer.did(),
        }),
      });
      const errors: string[] = [];
      const visitorRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: visitorStorage,
        errorHandlers: [
          (error) => errors.push(String(error?.message ?? error)),
        ],
        trustSnapshotProvider: () => ({
          id: stager.did(),
          actingPrincipal: stager.did(),
        }),
      });
      const program = capturingProgram(operations.map.expression, "owner", {
        gated: true,
      });
      let ownerClosed = false;
      try {
        const compiled = await ownerRuntime.patternManager.compilePattern(
          program,
        );
        const tx = ownerRuntime.edit();
        const result = ownerRuntime.run(
          tx,
          compiled,
          {},
          ownerRuntime.getCell(space, "output", compiled.resultSchema, tx),
        );
        ownerRuntime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await ownerRuntime.idle();
        for (const add of ["a", "b"]) {
          result.key("add").send({ add });
          await ownerRuntime.idle();
        }
        await ownerStorage.synced();
        ownerRuntime.runner.stop(result);
        await ownerRuntime.dispose({ closeStorage: false });
        await ownerStorage.close();
        ownerClosed = true;

        await visitorRuntime.patternManager.compilePattern(program, { space });
        const shown = visitorRuntime.getCellFromLink<{
          items: string[];
          rows: (string | { item: string })[];
        }>(result.getAsNormalizedFullLink());
        const cancel = shown.sink(() => {});
        expect(await visitorRuntime.start(shown)).toBe(true);
        await visitorRuntime.idle();
        expect(await shown.key("rows").pull()).toEqual([]);
        shown.key("reveal").send({});
        await visitorRuntime.idle();
        await visitorStorage.synced();
        expect(itemsOf(await shown.key("rows").pull())).toEqual(["a", "b"]);
        expect(errors).toEqual([]);

        shown.key("rows").key(0).resolveAsCell().key("remove").send({
          remove: "a",
        });
        await visitorRuntime.idle();
        await visitorStorage.synced();
        expect(await shown.key("items").pull()).toEqual(["a", "b"]);
        cancel();
      } finally {
        if (!ownerClosed) {
          await ownerRuntime.dispose({ closeStorage: false });
          await ownerStorage.close();
        }
        await visitorRuntime.dispose({ closeStorage: false });
        await visitorStorage.close();
        await server.close();
      }
    });
  });
});
