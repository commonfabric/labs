import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { recordNewProtectedDefaults } from "../../src/cfc/default-initialization.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { recordReferencedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

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

    /** Initializes the owner's message with protected-default authorship. */
    async function initializeOwnersMessage(schema: JSONSchema = inboxSchema) {
      const seed = runtime.edit();
      runtime.getCell(space, "inbox", undefined, seed).set({ note: "saved" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).error).toBeUndefined();

      const first = runtime.edit();
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
});
