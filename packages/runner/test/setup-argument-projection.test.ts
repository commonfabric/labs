import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type {
  JSONSchema,
  JSONSchemaObj,
  Pattern,
} from "../src/builder/types.ts";
import { recordNewProtectedDefaults } from "../src/cfc/default-initialization.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_ARGUMENT_PROJECTION,
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
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
    it("records an argument projection of the slot, naming the passed list, and no result projection", async () => {
      await initializeOwnersList();
      const tx = runtime.edit();
      const argument = await setUpChild(tx, binding(tx));
      const slot = argument.getAsNormalizedFullLink();
      const list = runtime.getCell(space, "board", undefined, tx).key("items")
        .getAsNormalizedFullLink();

      const projections = tx.getCfcState().writePolicyInputs.flatMap((
        input,
      ) =>
        input.kind === "structural-provenance" &&
          (input.claim === CFC_STRUCTURAL_PROVENANCE_ARGUMENT_PROJECTION ||
            input.claim === CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION) &&
          input.target.id === slot.id
          ? [{
            claim: input.claim,
            path: input.target.path,
            sources: input.sources.map(({ id, path }) => ({ id, path })),
            runtime: tx.isRuntimeWritePolicyInput(input),
          }]
          : []
      );

      expect(projections).toEqual([{
        claim: CFC_STRUCTURAL_PROVENANCE_ARGUMENT_PROJECTION,
        path: ["list"],
        sources: [{ id: list.id, path: list.path }],
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
});
