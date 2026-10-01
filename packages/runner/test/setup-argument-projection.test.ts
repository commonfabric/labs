import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type {
  JSONSchema,
  JSONSchemaObj,
  Pattern,
} from "../src/builder/types.ts";
import {
  LIST_OP_CAPTURED_ARGUMENT_FIELDS,
  LIST_OP_REFERENCED_ARGUMENT_FIELDS,
} from "../src/builtins/list-op-argument-usage.ts";
import { recordNewProtectedDefaults } from "../src/cfc/default-initialization.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("setup-argument-projection-owner");
const stager = await Identity.fromPassphrase(
  "setup-argument-projection-stager",
);
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

// The argument of a sub-pattern a pattern composes over the owner's list, as
// `Child({ list: items })`: the slot `list` repeats the list's policy.
const childArgumentSchema: JSONSchema = {
  type: "object",
  properties: { list: { ...ownedList, asCell: ["cell"] } },
};

describe("setup-argument-projection", () => {
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

  /** A write redirect to the owner's list on `board`, as a binding is passed. */
  function binding(tx: IExtendedStorageTransaction, board = "board") {
    return runtime.getCell(space, board, undefined, tx).key("items")
      .getAsWriteRedirectLink();
  }

  /**
   * Sets up a sub-pattern on the result cell `child` with `list` at its
   * argument's `list`, as setup stages a binding a pattern passes to a
   * sub-pattern it composes. A setup that declines `attributeInitialization`
   * is nobody's act, as one a builtin starts from a continuation is. Returns
   * the sub-pattern's argument cell.
   */
  async function setUpChild(
    tx: IExtendedStorageTransaction,
    list: unknown,
    { argumentSchema = childArgumentSchema, attributeInitialization }: {
      argumentSchema?: JSONSchema;
      attributeInitialization?: boolean;
    } = {},
  ) {
    const resultCell = runtime.getCell(space, "child", undefined, tx);
    const pattern = {
      argumentSchema,
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    } satisfies Pattern;
    await runtime.runner.setup(tx, pattern, { list }, resultCell, {
      ...(attributeInitialization !== undefined && { attributeInitialization }),
    });
    return resultCell.getArgumentCell<{ list: string[] }>(argumentSchema)!;
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

  describe("the record", () => {
    it("records a capture of the slot, naming the passed list, and no setup projection", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      const slot = argument.getAsNormalizedFullLink();
      const list = runtime.getCell(space, "board", undefined, tx).key("items")
        .getAsNormalizedFullLink();

      const records = tx.getCfcState().writePolicyInputs.flatMap((input) => {
        if (input.kind === "initialization" && input.target.id === slot.id) {
          const named = parseLink(input.value, slot);
          return [{
            record: input.mode,
            path: input.target.path,
            names: named && { id: named.id, path: named.path },
            runtime: tx.isRuntimeWritePolicyInput(input),
          }];
        }
        return input.kind === "structural-provenance" &&
            input.claim === CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION &&
            input.target.id === slot.id
          ? [{ record: input.claim, path: input.target.path }]
          : [];
      });

      expect(records).toEqual([{
        record: "capture",
        path: ["list"],
        names: { id: list.id, path: list.path },
        runtime: true,
      }]);
      tx.abort();
    });
  });

  describe("the slot", () => {
    it("accepts the binding into an absent owner-protected slot, and refuses the same binding written outside setup", async () => {
      await initializeOwnersList();
      const staged = runtime.edit();
      await setUpChild(staged, binding(staged));
      const written = runtime.edit();
      runtime.getCell(space, "written", childArgumentSchema, written).set({
        list: binding(written),
      });

      expect(await commit(staged)).toBeUndefined();
      expect(await commit(written)).toContain(`${refusal} at /list`);
    });

    it("accepts the binding from a principal other than the list's owner, and from the owner over it after", async () => {
      await initializeOwnersList();
      for (const principal of [stager.did(), signer.did()]) {
        actingPrincipal = principal;
        const tx = runtime.edit();
        await setUpChild(tx, binding(tx));

        expect(await commit(tx)).toBeUndefined();
      }
    });

    it("refuses a plain link to the list written over it in the transaction staging it", async () => {
      // A capture records whether its link is a write redirect, and a plain
      // link to the same cell is not the link the setup staged.
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      const slot = argument.getAsNormalizedFullLink();
      tx.writeValueOrThrow(
        { ...slot, path: [...slot.path, "list"] },
        runtime.getCell(space, "board", undefined, tx).key("items")
          .getAsLink(),
      );

      expect(await commit(tx)).toContain(`${refusal} at /list`);
    });

    it("refuses a later setup staging a redirect to another list over it", async () => {
      // The slot keeps the cell it was first given, as a list builtin's
      // captured binding does. Whether a trusted setup may re-point it when a
      // pattern version names another cell is not settled.
      await initializeOwnersList();
      await initializeOwnersList("other");
      const first = runtime.edit();
      await setUpChild(first, binding(first));
      expect(await commit(first)).toBeUndefined();

      const later = runtime.edit();
      await setUpChild(later, binding(later, "other"));

      expect(await commit(later)).toContain(`${refusal} at /list`);
    });

    it("refuses a relative write redirect over it in the transaction staging it, which names the child's own argument document rather than the list", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      const slot = argument.getAsNormalizedFullLink();
      // The same path as the list's, in the document holding the slot: the
      // link's address omits the document, which is the slot's own.
      const relative = createSigilLinkFromParsedLink(
        { ...slot, path: ["items"] },
        { base: slot, overwrite: "redirect" },
      );
      tx.writeValueOrThrow({ ...slot, path: [...slot.path, "list"] }, relative);

      expect(await commit(tx)).toContain(`${refusal} at /list`);
    });

    it("accepts a write redirect to the list whose address omits the space it shares with the slot", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      const slot = argument.getAsNormalizedFullLink();
      const list = runtime.getCell(space, "board", undefined, tx).key("items")
        .getAsNormalizedFullLink();
      // Relative to the slot's document, the link keeps the list's document
      // and omits the space the two share.
      const sameSpace = createSigilLinkFromParsedLink(list, {
        base: slot,
        overwrite: "redirect",
      });
      tx.writeValueOrThrow(
        { ...slot, path: [...slot.path, "list"] },
        sameSpace,
      );

      expect(await commit(tx)).toBeUndefined();
    });

    it("refuses a value staged in its place", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpChild(tx, ["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /list`);
    });

    it("refuses a link that is not a write redirect staged in its place", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpChild(
        tx,
        runtime.getCell(space, "board", undefined, tx).key("items").getAsLink(),
      );

      expect(await commit(tx)).toContain(`${refusal} at /list`);
    });
  });

  describe("the passed list", () => {
    it("refuses a write through the slot without the list's writer in the transaction staging it", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      argument.key("list").set(["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });

    it("refuses a write to the list itself without its writer in the transaction staging it", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpChild(tx, binding(tx));
      runtime.getCell(space, "board", boardSchema, tx).key("items")
        .set(["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });

    it("refuses a write through the slot without the list's writer in a later transaction that stages it again", async () => {
      await initializeOwnersList();
      const staging = runtime.edit();
      await setUpChild(staging, binding(staging));
      expect(await commit(staging)).toBeUndefined();

      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      argument.key("list").set(["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });

    it("refuses a write through the slot without the list's writer in a later transaction", async () => {
      await initializeOwnersList();
      const staging = runtime.edit();
      await setUpChild(staging, binding(staging));
      expect(await commit(staging)).toBeUndefined();

      const tx = runtime.edit();
      runtime.getCell(space, "child", undefined, tx)
        .getArgumentCell<{ list: string[] }>(childArgumentSchema)!
        .key("list").set(["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });

    it("attributes a write to the passed list in the transaction staging it to the principal making it", async () => {
      // An owner-protected list, seeded on nobody's behalf and then written
      // through its writer as a module's reviewed binding writes it. The slot
      // is the setup's unattributed initialization; the list is not, so the
      // write binds its principal as the list's owner.
      const notesList: JSONSchemaObj = {
        ...ownedList,
        ifc: {
          ...ownedList.ifc,
          writeAuthorizedBy: {
            __ctWriterIdentityOf: {
              file: "/main.tsx",
              path: ["send"],
              moduleIdentity: "notes-module",
            },
          },
        },
      };
      const notesSchema: JSONSchema = {
        type: "object",
        properties: { items: notesList },
      };
      const seed = runtime.edit();
      const seeded = runtime.getCell(space, "notes", notesSchema, seed);
      seeded.set({ items: [] });
      seed.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "seed",
        target: seeded.key("items").getAsNormalizedFullLink(),
        value: [],
      }, runtimeWritePolicyAuthorization);
      expect(await commit(seed)).toBeUndefined();

      const tx = runtime.edit();
      await setUpChild(tx, binding(tx, "notes"), {
        argumentSchema: {
          type: "object",
          properties: { list: { ...notesList, asCell: ["cell"] } },
        },
        attributeInitialization: false,
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "notes-module",
        sourceFile: "/main.tsx",
        bindingPath: ["send"],
      });
      const notes = runtime.getCell(space, "notes", notesSchema, tx);
      notes.key("items").set(["a"]);
      expect(await commit(tx)).toBeUndefined();

      const represented = (readStoredCfcMetadata(
        runtime.edit(),
        notes.getAsNormalizedFullLink(),
      )?.labelMap.entries ?? [])
        .filter((entry) => entry.path.join("/") === "items")
        .flatMap((entry) => entry.label.integrity ?? [])
        .filter((atom) =>
          isObjectOrArray(atom) && atom.kind === "represents-principal"
        )
        .map((atom) => (atom as { subject: unknown }).subject);
      expect(represented).toEqual([signer.did()]);
    });

    it("refuses a write through the slot by a principal other than the list's owner in the transaction staging it", async () => {
      await initializeOwnersList();
      actingPrincipal = stager.did();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      argument.key("list").set(["forged"]);

      expect(await commit(tx)).toContain("ownerPrincipal mismatch at /items");
      expect(ownersList()).toEqual([]);
    });
  });
  describe("beside a binding a list builtin captures", () => {
    // A list builtin stages its callback's captured bindings at `params` as a
    // link to a record holding a write redirect to each captured cell, and
    // records each link as a capture. The walk recording binding projections
    // stops at that link, so the slot holds a capture alone.

    // The argument of a row whose callback captures the owner's list.
    const rowArgumentSchema: JSONSchema = {
      type: "object",
      properties: {
        params: {
          type: "object",
          properties: { items: { ...ownedList, asCell: ["readonly"] } },
        },
      },
    };

    /** Sets up a row capturing `list`, as a list builtin stages it. */
    async function setUpRow(tx: IExtendedStorageTransaction, list: unknown) {
      const resultCell = runtime.getCell(space, "row", undefined, tx);
      const pattern = {
        argumentSchema: rowArgumentSchema,
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      } satisfies Pattern;
      const params = runtime.getImmutableCell(
        space,
        { params: { items: list } },
        undefined,
        tx,
      ).key("params");
      await runtime.runner.setup(tx, pattern, { params }, resultCell, {
        referencedArgumentFields: LIST_OP_REFERENCED_ARGUMENT_FIELDS,
        capturedArgumentFields: LIST_OP_CAPTURED_ARGUMENT_FIELDS,
      });
      return resultCell.getAsNormalizedFullLink();
    }

    it("records a capture of the slot and no projection of it", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpRow(tx, binding(tx));
      const row = runtime.getCell(space, "row", undefined, tx)
        .getArgumentCell()!.getAsNormalizedFullLink();

      const records = tx.getCfcState().writePolicyInputs.flatMap((input) =>
        input.kind === "initialization" && input.target.id === row.id
          ? [{ record: input.mode, path: input.target.path }]
          : input.kind === "structural-provenance" &&
              input.target.id === row.id &&
              input.claim === CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION
          ? [{ record: input.claim, path: input.target.path }]
          : []
      );

      expect(records).toEqual([{
        record: "capture",
        path: ["params", "items"],
      }]);
      tx.abort();
    });

    it("refuses a later setup staging a redirect to another cell over the captured one", async () => {
      await initializeOwnersList();
      await initializeOwnersList("other-board");
      const first = runtime.edit();
      await setUpRow(first, binding(first));
      expect(await commit(first)).toBeUndefined();

      const second = runtime.edit();
      await setUpRow(second, binding(second, "other-board"));

      expect(await commit(second)).toContain(`${refusal} at /params/items`);
    });

    it("refuses a write through the captured slot without the list's writer in the transaction staging it", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      await setUpRow(tx, binding(tx));
      runtime.getCell(space, "row", undefined, tx)
        .getArgumentCell<{ params: { items: string[] } }>(rowArgumentSchema)!
        .key("params").key("items").set(["forged"]);

      expect(await commit(tx)).toContain(`${refusal} at /items`);
      expect(ownersList()).toEqual([]);
    });
  });
});
