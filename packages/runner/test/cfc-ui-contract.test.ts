import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  markRendererTrustedEvent,
  recordTrustedEventPolicyInputs,
  trustedEventMatchesUiContract,
  uiContractFromSchema,
  uiContractsFromSchema,
} from "../src/cfc/ui-contract.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import type { EventHandler } from "../src/scheduler.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-ui-contract");
const space = signer.did();

const uiActionSchema = {
  type: "string",
  ifc: {
    uiContract: {
      helper: "UiAction",
      action: "SubmitDirectCommand",
    },
  },
} as const;

const trustedPatternUiActionSchema = {
  type: "string",
  ifc: {
    uiContract: {
      helper: "UiAction",
      action: "SubmitDirectCommand",
      trustedPattern: "TrustedDirectCommandSurface",
      requiredEventIntegrity: ["TrustedDirectCommandSurface"],
    },
  },
} as const;

const rendererEvent = <T extends Record<string, unknown>>(event: T): T => {
  markRendererTrustedEvent(event);
  return event;
};

describe("CFC UI contract matching", () => {
  it("matches UiAction contracts against trusted DOM dataset markers", () => {
    const contract = uiContractFromSchema({
      ...uiActionSchema,
    });

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              uiContractDataset: {
                uiAction: "SubmitDirectCommand",
              },
            },
          },
        }),
        contract,
      ),
    ).toBe(true);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              uiContractDataset: {
                uiAction: "DifferentAction",
              },
            },
          },
        }),
        contract,
      ),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
          },
          target: {
            dataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        }),
        contract,
      ),
    ).toBe(false);
  });

  it("requires renderer-attested trusted pattern provenance when declared", () => {
    const contract = uiContractFromSchema({
      ...trustedPatternUiActionSchema,
    });

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: { origin: "dom", trusted: true },
      }, contract),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "TrustedDirectCommandSurface",
              eventIntegrity: ["TrustedDirectCommandSurface"],
              uiContractDataset: {
                uiAction: "SubmitDirectCommand",
              },
            },
          },
        }),
        contract,
      ),
    ).toBe(true);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "UntrustedLookalikeSurface",
              eventIntegrity: ["TrustedDirectCommandSurface"],
              uiContractDataset: {
                uiAction: "SubmitDirectCommand",
              },
            },
          },
        }),
        contract,
      ),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "TrustedDirectCommandSurface",
              eventIntegrity: ["UntrustedLookalikeSurface"],
              uiContractDataset: {
                uiAction: "SubmitDirectCommand",
              },
            },
          },
        }),
        contract,
      ),
    ).toBe(false);
  });

  it("resolves UiAction contracts through local $defs refs", () => {
    const contract = uiContractFromSchema({
      $ref: "#/$defs/TrustedAction",
      $defs: {
        TrustedAction: trustedPatternUiActionSchema,
      },
    });

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
          type: "click",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "TrustedDirectCommandSurface",
              eventIntegrity: ["TrustedDirectCommandSurface"],
              uiContractDataset: {
                uiAction: "SubmitDirectCommand",
              },
            },
          },
        }),
        contract,
      ),
    ).toBe(true);
  });

  it("collects contracts declared in tuple (prefixItems) slots at their index", () => {
    // A contract declared in a tuple element schema is collected under its
    // slot index, so a UI contract declared on a slot is enforced.
    const contracts = uiContractsFromSchema({
      type: "array",
      prefixItems: [
        { type: "number" },
        trustedPatternUiActionSchema,
      ],
    });

    expect(contracts).toEqual([{
      path: ["1"],
      contract: {
        helper: "UiAction",
        action: "SubmitDirectCommand",
        trustedPattern: "TrustedDirectCommandSurface",
        requiredEventIntegrity: ["TrustedDirectCommandSurface"],
      },
    }]);
  });

  it("keeps the items wildcard entry beside prefixItems", () => {
    // The `*` entry carries the tail elements' declared contract; a schema
    // walk that dropped it would leave that contract unenforced (fail-open).
    // It over-enforces the rest contract on tuple slots, the fail-safe
    // direction.
    const contracts = uiContractsFromSchema({
      type: "array",
      prefixItems: [{ type: "number" }],
      items: trustedPatternUiActionSchema,
    });

    expect(contracts).toEqual([{
      path: ["*"],
      contract: {
        helper: "UiAction",
        action: "SubmitDirectCommand",
        trustedPattern: "TrustedDirectCommandSurface",
        requiredEventIntegrity: ["TrustedDirectCommandSurface"],
      },
    }]);
  });

  it("does not fall back to $defs contracts for unknown-typed tuples", () => {
    // PR #4969 review: the $defs fallback's no-children guard did not count
    // prefixItems, so an unknown-typed tuple with one contract-bearing
    // definition minted that contract at the array's own path — enforced
    // for every array write instead of just the referencing slot.
    const contracts = uiContractsFromSchema({
      type: "unknown",
      prefixItems: [
        { $ref: "#/$defs/Action" },
        { type: "number" },
      ],
      $defs: {
        Action: trustedPatternUiActionSchema,
      },
    } as never);

    // Only the referencing slot mints, at its concrete index — no
    // root-path entry.
    expect(contracts.map((entry) => entry.path)).toEqual([["0"]]);
    expect((contracts[0].contract as { action?: string }).action).toBe(
      "SubmitDirectCommand",
    );
  });

  it("keeps sibling ifc metadata when resolving local $refs", () => {
    const contracts = uiContractsFromSchema({
      type: "array",
      items: {
        $ref: "#/$defs/Message",
        ifc: trustedPatternUiActionSchema.ifc,
      },
      $defs: {
        Message: {
          type: "object",
          properties: {
            body: { type: "string" },
          },
          required: ["body"],
        },
      },
    });

    expect(contracts).toEqual([{
      path: ["*"],
      contract: {
        helper: "UiAction",
        action: "SubmitDirectCommand",
        trustedPattern: "TrustedDirectCommandSurface",
        requiredEventIntegrity: ["TrustedDirectCommandSurface"],
      },
    }]);
  });

  it("resolves contracts through a nested property's ref into the root's $defs", () => {
    const contracts = uiContractsFromSchema({
      type: "object",
      $defs: {
        Message: {
          type: "object",
          properties: {
            body: { type: "string" },
          },
          required: ["body"],
          ifc: trustedPatternUiActionSchema.ifc,
        },
      },
      properties: {
        messages: {
          type: "array",
          items: {
            $ref: "#/$defs/Message",
          },
        },
      },
    });

    expect(contracts).toEqual([{
      path: ["messages", "*"],
      contract: {
        helper: "UiAction",
        action: "SubmitDirectCommand",
        trustedPattern: "TrustedDirectCommandSurface",
        requiredEventIntegrity: ["TrustedDirectCommandSurface"],
      },
    }]);
  });

  it("resolves a contract inside an external document against that document's $defs", () => {
    // The `Panel` definition is a `cid:` ref: everything below it belongs to
    // the registered document, whose `$defs` is where `#/$defs/Action` names
    // the contract.
    const release = acquireSchemaRegistryLease();
    try {
      const document = {
        type: "object",
        properties: { action: { $ref: "#/$defs/Action" } },
        $defs: { Action: trustedPatternUiActionSchema },
      } as unknown as JSONSchema;
      const hash = internSchemaAsTaggedHashString(document);
      registerSchemaDocument(hash, document);

      const contracts = uiContractsFromSchema({
        type: "object",
        properties: { panel: { $ref: "#/$defs/Panel" } },
        $defs: { Panel: { $ref: `cid:${hash}` } },
      } as unknown as JSONSchema);

      expect(contracts).toEqual([{
        path: ["panel", "action"],
        contract: {
          helper: "UiAction",
          action: "SubmitDirectCommand",
          trustedPattern: "TrustedDirectCommandSurface",
          requiredEventIntegrity: ["TrustedDirectCommandSurface"],
        },
      }]);
    } finally {
      release();
    }
  });

  it("resolves a contract from a direct `cid:` reference", () => {
    const release = acquireSchemaRegistryLease();
    try {
      const document = trustedPatternUiActionSchema as unknown as JSONSchema;
      const hash = internSchemaAsTaggedHashString(document);
      registerSchemaDocument(hash, document);
      const reference = { $ref: `cid:${hash}` } as unknown as JSONSchema;
      const contract = {
        helper: "UiAction",
        action: "SubmitDirectCommand",
        trustedPattern: "TrustedDirectCommandSurface",
        requiredEventIntegrity: ["TrustedDirectCommandSurface"],
      };

      expect(uiContractFromSchema(reference)).toEqual(contract);
      expect(uiContractsFromSchema(reference)).toEqual([{
        path: [],
        contract,
      }]);
    } finally {
      release();
    }
  });

  it("resolves a direct `cid:` document's descendants against that document's $defs", () => {
    const release = acquireSchemaRegistryLease();
    try {
      const document = {
        type: "object",
        properties: { action: { $ref: "#/$defs/Action" } },
        $defs: { Action: trustedPatternUiActionSchema },
      } as unknown as JSONSchema;
      const hash = internSchemaAsTaggedHashString(document);
      registerSchemaDocument(hash, document);

      const contracts = uiContractsFromSchema(
        { $ref: `cid:${hash}` } as unknown as JSONSchema,
      );

      expect(contracts).toEqual([{
        path: ["action"],
        contract: {
          helper: "UiAction",
          action: "SubmitDirectCommand",
          trustedPattern: "TrustedDirectCommandSurface",
          requiredEventIntegrity: ["TrustedDirectCommandSurface"],
        },
      }]);
    } finally {
      release();
    }
  });

  it("follows a local pointer inside an external document that the referring document also used", () => {
    // Both documents name a `Panel` definition. The outer one was followed on
    // the way in; the external document's `#/$defs/Panel` is another ref,
    // read in another document, not a cycle.
    const release = acquireSchemaRegistryLease();
    try {
      const document = {
        type: "object",
        properties: { action: { $ref: "#/$defs/Panel" } },
        $defs: { Panel: trustedPatternUiActionSchema },
      } as unknown as JSONSchema;
      const hash = internSchemaAsTaggedHashString(document);
      registerSchemaDocument(hash, document);

      const contracts = uiContractsFromSchema({
        $ref: "#/$defs/Panel",
        $defs: {
          Panel: {
            type: "object",
            properties: { inner: { $ref: `cid:${hash}` } },
          },
        },
      } as unknown as JSONSchema);

      expect(contracts).toEqual([{
        path: ["inner", "action"],
        contract: {
          helper: "UiAction",
          action: "SubmitDirectCommand",
          trustedPattern: "TrustedDirectCommandSurface",
          requiredEventIntegrity: ["TrustedDirectCommandSurface"],
        },
      }]);
    } finally {
      release();
    }
  });

  it("resolves one definition name in two external documents to each document's own", () => {
    // `Panel` is a submit action in one document and a disclosure in the
    // other. Read as siblings, and read with the second nested inside the
    // first, each document's `#/$defs/Panel` names its own definition.
    const release = acquireSchemaRegistryLease();
    try {
      const submit = {
        helper: "UiAction",
        action: "SubmitDirectCommand",
        trustedPattern: "TrustedDirectCommandSurface",
        requiredEventIntegrity: ["TrustedDirectCommandSurface"],
      };
      const disclosure = { helper: "UiDisclosure", kind: "Secret" };
      const disclosing = {
        type: "object",
        properties: { action: { $ref: "#/$defs/Panel" } },
        $defs: { Panel: { type: "string", ifc: { uiContract: disclosure } } },
      } as unknown as JSONSchema;
      const disclosingHash = internSchemaAsTaggedHashString(disclosing);
      registerSchemaDocument(disclosingHash, disclosing);
      const submitting = {
        type: "object",
        properties: {
          action: { $ref: "#/$defs/Panel" },
          next: { $ref: `cid:${disclosingHash}` },
        },
        $defs: { Panel: trustedPatternUiActionSchema },
      } as unknown as JSONSchema;
      const submittingHash = internSchemaAsTaggedHashString(submitting);
      registerSchemaDocument(submittingHash, submitting);

      expect(uiContractsFromSchema({
        type: "object",
        properties: {
          a: { $ref: `cid:${submittingHash}` },
          b: { $ref: `cid:${disclosingHash}` },
        },
      } as unknown as JSONSchema)).toEqual([
        { path: ["a", "action"], contract: submit },
        { path: ["a", "next", "action"], contract: disclosure },
        { path: ["b", "action"], contract: disclosure },
      ]);
    } finally {
      release();
    }
  });
});

describe("CFC trusted UI event enforcement", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("commits handler writes when trusted event markers match the schema uiContract", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("accepted");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("rejects public stream payloads that forge trusted DOM provenance", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const sourceStream = runtime.getCell(
      space,
      "cfc-ui-contract-source-stream-forged-public-send",
      { asCell: ["stream"] },
    );
    const protectedStream = runtime.getCell(
      space,
      "cfc-ui-contract-protected-stream-forged-public-send",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-forged-public-send",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const protectedHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("forged");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const forwardHandler = Object.assign(
      ((tx: IExtendedStorageTransaction, event: unknown) => {
        protectedStream.withTx(tx).send(event);
      }) as EventHandler,
      {
        reads: [],
        writes: [],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancelProtected = runtime.scheduler.addEventHandler(
      protectedHandler,
      protectedStream.getAsNormalizedFullLink(),
    );
    const cancelForward = runtime.scheduler.addEventHandler(
      forwardHandler,
      sourceStream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(sourceStream.getAsNormalizedFullLink(), {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    });
    await runtime.idle();

    expect(output.get()).toBeUndefined();
    cancelForward();
    cancelProtected();
  });

  it("records trusted event policy inputs for nested contracts from ancestor schemas", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: "of:cfc-ui-contract-nested-document",
        path: [],
      },
      schema: {
        type: "object",
        properties: {
          savedTitle: { $ref: "#/$defs/TrustedAction" },
        },
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-nested-document",
        path: ["savedTitle"],
      }],
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.target.space === space &&
        input.target.id === "of:cfc-ui-contract-nested-document" &&
        input.target.path.join("/") === "savedTitle"
      ),
    ).toBe(true);
  });

  it("records trusted event policy inputs for array item contract paths", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        id: "of:cfc-ui-contract-array-document",
        scope: "space",
        path: [],
      },
      schema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: trustedPatternUiActionSchema,
          },
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        id: "of:cfc-ui-contract-array-document",
        scope: "space",
        path: ["messages", "0"],
      }],
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.target.space === space &&
        input.target.id === "of:cfc-ui-contract-array-document" &&
        input.target.scope === "space" &&
        input.target.path.join("/") === "messages/0"
      ),
    ).toBe(true);
  });

  it("records trusted event policy inputs from linked handler event envelopes", () => {
    // The one deliberate `data:` cell URI example: an event delivered as a
    // sigil link to a data-URI envelope is the exceptional shape we verify is
    // still decoded and handled. Other event-context tests use the plain
    // in-memory envelope so they don't imply the input is always a data-URI
    // link.

    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: "of:cfc-ui-contract-linked-event-document",
        path: [],
      },
      schema: {
        type: "object",
        properties: {
          savedTitle: { $ref: "#/$defs/TrustedAction" },
        },
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    };
    const eventEnvelopeLink = {
      "/": {
        [LINK_V1_TAG]: {
          id: dataUriFromValue({ $event: rawTrustedEvent }),
          path: ["$event"],
          space,
        },
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-linked-event-document",
        path: ["savedTitle"],
      }],
      rendererEvent(eventEnvelopeLink),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          "trusted-event:click:of:cfc-ui-contract-linked-event-document:savedTitle" &&
        input.target.id === "of:cfc-ui-contract-linked-event-document" &&
        input.target.path.join("/") === "savedTitle"
      ),
    ).toBe(true);
  });

  it("uses bound sigil-link event context as UI contract schema hints", () => {
    const documentId = "of:cfc-ui-contract-context-link-document-argument";
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    };
    // At handler-execution time the `$ctx` entry is a bound sigil link that
    // already addresses the write's document, not a symbolic `$alias`. The event
    // value is a plain in-memory envelope here; the `data:`-URI link form is the
    // exceptional case, covered once by "records trusted event policy inputs from
    // linked handler event envelopes".
    const eventEnvelope = {
      value: {
        $ctx: {
          savedTitle: {
            "/": {
              [LINK_V1_TAG]: {
                id: documentId,
                path: ["savedTitle"],
                space,
                scope: "space",
                schema: {
                  $ref: "#/$defs/TrustedAction",
                  $defs: {
                    TrustedAction: trustedPatternUiActionSchema,
                  },
                },
              },
            },
          },
        },
        $event: rawTrustedEvent,
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: documentId,
        path: ["savedTitle"],
      }],
      rendererEvent(eventEnvelope),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          `trusted-event:click:${documentId}:savedTitle` &&
        input.target.id === documentId &&
        input.target.path.join("/") === "savedTitle"
      ),
    ).toBe(true);
  });

  it("uses bound sigil-link event context item schemas for array item writes", () => {
    const documentId =
      "of:cfc-ui-contract-context-link-array-document-argument";
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    };
    const eventEnvelope = {
      value: {
        $ctx: {
          messages: {
            "/": {
              [LINK_V1_TAG]: {
                id: documentId,
                path: ["messages"],
                space,
                scope: "space",
                schema: {
                  type: "array",
                  items: {
                    $ref: "#/$defs/TrustedAction",
                  },
                  $defs: {
                    TrustedAction: trustedPatternUiActionSchema,
                  },
                },
              },
            },
          },
        },
        $event: rawTrustedEvent,
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        id: documentId,
        scope: "space",
        path: ["messages", "0"],
      }],
      rendererEvent(eventEnvelope),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          `trusted-event:click:${documentId}:messages/0` &&
        input.target.id === documentId &&
        input.target.path.join("/") === "messages/0"
      ),
    ).toBe(true);
  });

  it("uses sigil links nested inside event context entries as schema hints", () => {
    const documentId =
      "of:cfc-ui-contract-context-nested-link-document-argument";
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    };
    // Binding preserves nesting, so the contract-bearing sigil link can sit
    // below the top level of a `$ctx` entry (e.g. `{ config: { savedTitle } }`).
    const eventEnvelope = {
      value: {
        $ctx: {
          config: {
            savedTitle: {
              "/": {
                [LINK_V1_TAG]: {
                  id: documentId,
                  path: ["savedTitle"],
                  space,
                  scope: "space",
                  schema: {
                    $ref: "#/$defs/TrustedAction",
                    $defs: {
                      TrustedAction: trustedPatternUiActionSchema,
                    },
                  },
                },
              },
            },
          },
        },
        $event: rawTrustedEvent,
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: documentId,
        path: ["savedTitle"],
      }],
      rendererEvent(eventEnvelope),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          `trusted-event:click:${documentId}:savedTitle` &&
        input.target.id === documentId &&
        input.target.path.join("/") === "savedTitle"
      ),
    ).toBe(true);
  });

  it("ignores an event-context link that addresses a different document", () => {
    const writeDocumentId = "of:cfc-ui-contract-context-mismatch-write";
    const otherDocumentId = "of:cfc-ui-contract-context-mismatch-other";
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    };
    // The `$ctx` link is a full, absolute link, but it points at a DIFFERENT
    // document than the write target, so it must not contribute a contract.
    const eventEnvelope = {
      value: {
        $ctx: {
          savedTitle: {
            "/": {
              [LINK_V1_TAG]: {
                id: otherDocumentId,
                path: ["savedTitle"],
                space,
                scope: "space",
                schema: {
                  $ref: "#/$defs/TrustedAction",
                  $defs: {
                    TrustedAction: trustedPatternUiActionSchema,
                  },
                },
              },
            },
          },
        },
        $event: rawTrustedEvent,
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: writeDocumentId,
        path: ["savedTitle"],
      }],
      rendererEvent(eventEnvelope),
    );

    expect(
      writePolicyInputs.some((input) => input.kind === "trusted-event"),
    ).toBe(false);
  });

  it("walks past primitive, shared, and over-deep $ctx entries to the contract link", () => {
    const documentId = "of:cfc-ui-contract-context-walk-document";
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    };
    const contractLink = {
      "/": {
        [LINK_V1_TAG]: {
          id: documentId,
          path: ["savedTitle"],
          space,
          scope: "space",
          schema: {
            $ref: "#/$defs/TrustedAction",
            $defs: {
              TrustedAction: trustedPatternUiActionSchema,
            },
          },
        },
      },
    };
    // The walk must tolerate: a primitive entry (a non-record leaf), the same
    // object reached twice (`seen` guards re-descent — a DAG, not a cycle, so
    // the surrounding data-URI inliner stays finite), and a nest deeper than the
    // recursion cap. The contract-bearing link alongside them must still be
    // found.
    const shared = { note: "reached twice" };
    let buried: unknown = { savedTitle: contractLink };
    for (let index = 0; index < 20; index++) {
      buried = { nested: buried };
    }
    const eventEnvelope = {
      value: {
        $ctx: {
          plain: "not a link",
          first: shared,
          second: shared,
          tooDeep: buried,
          savedTitle: contractLink,
        },
        $event: rawTrustedEvent,
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: documentId,
        path: ["savedTitle"],
      }],
      rendererEvent(eventEnvelope),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          `trusted-event:click:${documentId}:savedTitle` &&
        input.target.id === documentId &&
        input.target.path.join("/") === "savedTitle"
      ),
    ).toBe(true);
  });

  it("uses a single leaf $defs uiContract hint for exact write schemas", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: "of:cfc-ui-contract-leaf-defs-document",
        path: ["savedTitle"],
      },
      schema: {
        type: "unknown",
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
          UnrelatedRenderNode: { type: "object" },
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-leaf-defs-document",
        path: ["savedTitle"],
      }],
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.target.id === "of:cfc-ui-contract-leaf-defs-document" &&
        input.target.path.join("/") === "savedTitle"
      ),
    ).toBe(true);
  });

  it("records trusted event policy inputs separately by scope", () => {
    const documentId = "of:cfc-ui-contract-scoped-trusted-event-document";
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "user",
        id: `${documentId}-argument`,
        path: [],
      },
      schema: {
        type: "object",
        properties: {
          savedTitle: { $ref: "#/$defs/TrustedAction" },
        },
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
        },
      },
    }, {
      kind: "trusted-event",
      target: {
        space,
        scope: "space",
        id: `${documentId}-argument`,
        path: ["savedTitle"],
      },
      eventId: `trusted-event:click:${documentId}-argument:savedTitle`,
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "user",
        id: `${documentId}-argument`,
        path: ["savedTitle"],
      }],
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );

    const trustedScopes = writePolicyInputs.flatMap((input) =>
      input.kind === "trusted-event" &&
        input.target.id === `${documentId}-argument` &&
        input.target.path.join("/") === "savedTitle"
        ? [input.target.scope]
        : []
    );
    expect(trustedScopes.sort()).toEqual(["space", "user"]);
  });

  it("commits trusted event writes when the handler write annotation is untyped", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-untyped-write",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-untyped-write",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );
    const untypedWrite = { ...output.getAsNormalizedFullLink() };
    delete untypedWrite.schema;

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("accepted");
      }) as EventHandler,
      {
        reads: [],
        writes: [untypedWrite],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("commits trusted event writes discovered from the handler transaction", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-dynamic-write",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-dynamic-write",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("accepted");
      }) as EventHandler,
      {
        reads: [],
        writes: [],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("commits trusted event pushes for array item contracts", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-array-item-push",
      { asCell: ["stream"] },
    );
    const messages = runtime.getCell<Array<{ body: string }>>(
      space,
      "cfc-ui-contract-output-array-item-push",
      {
        type: "array",
        items: {
          $ref: "#/$defs/Message",
          ifc: {
            ...trustedPatternUiActionSchema.ifc,
          },
        },
        $defs: {
          Message: {
            type: "object",
            properties: {
              body: { type: "string" },
            },
            required: ["body"],
          },
        },
      },
    );

    await runtime.editWithRetry((tx) => {
      messages.withTx(tx).set([]);
    });

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        messages.withTx(tx).push({ body: "accepted" });
      }) as EventHandler,
      {
        reads: [],
        writes: [messages.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(messages.get()).toEqual([{ body: "accepted" }]);
    cancel();
  });

  it("enforces branch-level writeAuthorizedBy on mixed array pushes", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-1",
        actingPrincipal: signer.did(),
      }),
    });

    const trustedStream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-mixed-array-trusted-write-auth",
      { asCell: ["stream"] },
    );
    const fakeSentStream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-mixed-array-fake-sent-write-auth",
      { asCell: ["stream"] },
    );
    const importedStream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-mixed-array-imported-write-auth",
      { asCell: ["stream"] },
    );
    const messages = runtime.getCell<Array<{ origin: string; body: string }>>(
      space,
      "cfc-ui-contract-output-mixed-array-write-auth",
      {
        type: "array",
        items: {
          anyOf: [{
            type: "object",
            properties: {
              origin: { const: "sent" },
              body: { type: "string" },
            },
            required: ["origin", "body"],
            ifc: {
              ...trustedPatternUiActionSchema.ifc,
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/trusted.tsx",
                  path: ["commitTrustedMessageSend"],
                },
              },
            },
          }, {
            type: "object",
            properties: {
              origin: { const: "imported" },
              body: { type: "string" },
            },
            required: ["origin", "body"],
          }],
        },
      },
    );

    await runtime.editWithRetry((tx) => {
      messages.withTx(tx).set([]);
    });

    const trustedHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        tx.setCfcImplementationIdentity({
          kind: "verified",
          moduleIdentity: "trusted-module",
          sourceFile: "/trusted.tsx",
          bindingPath: ["commitTrustedMessageSend"],
        });
        messages.withTx(tx).push({
          origin: "sent",
          body: "accepted",
        } as any);
      }) as EventHandler,
      {
        reads: [],
        writes: [messages.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const fakeSentHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        messages.withTx(tx).push({
          origin: "sent",
          body: "rejected",
        } as any);
      }) as EventHandler,
      {
        reads: [],
        writes: [messages.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const importedHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        messages.withTx(tx).push({
          origin: "imported",
          body: "allowed",
        } as any);
      }) as EventHandler,
      {
        reads: [],
        writes: [messages.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancelTrusted = runtime.scheduler.addEventHandler(
      trustedHandler,
      trustedStream.getAsNormalizedFullLink(),
    );
    const cancelFakeSent = runtime.scheduler.addEventHandler(
      fakeSentHandler,
      fakeSentStream.getAsNormalizedFullLink(),
    );
    const cancelImported = runtime.scheduler.addEventHandler(
      importedHandler,
      importedStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      fakeSentStream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(messages.get()).toEqual([]);

    runtime.scheduler.queueEvent(
      trustedStream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(messages.get().map((message) => message.body)).toEqual([
      "accepted",
    ]);

    runtime.scheduler.queueEvent(
      fakeSentStream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(messages.get().map((message) => message.body)).toEqual([
      "accepted",
    ]);

    runtime.scheduler.queueEvent(importedStream.getAsNormalizedFullLink(), {
      type: "click",
    });
    await runtime.idle();

    expect(messages.get().map((message) => message.body)).toEqual([
      "accepted",
      "allowed",
    ]);

    cancelImported();
    cancelFakeSent();
    cancelTrusted();
  });

  it("enforces branch-level writeAuthorizedBy on nested mixed array pushes", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-1",
        actingPrincipal: signer.did(),
      }),
    });

    const trustedStream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-nested-mixed-array-trusted-write-auth",
      { asCell: ["stream"] },
    );
    const fakeSentStream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-nested-mixed-array-fake-sent-write-auth",
      { asCell: ["stream"] },
    );
    const importedStream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-nested-mixed-array-imported-write-auth",
      { asCell: ["stream"] },
    );
    const state = runtime.getCell<
      { messages: Array<{ origin: string; body: string }> }
    >(
      space,
      "cfc-ui-contract-output-nested-mixed-array-write-auth",
      {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              anyOf: [{
                type: "object",
                properties: {
                  origin: { const: "sent" },
                  body: { type: "string" },
                },
                required: ["origin", "body"],
                ifc: {
                  ...trustedPatternUiActionSchema.ifc,
                  writeAuthorizedBy: {
                    __ctWriterIdentityOf: {
                      file: "/trusted.tsx",
                      path: ["commitTrustedMessageSend"],
                    },
                  },
                },
              }, {
                type: "object",
                properties: {
                  origin: { const: "imported" },
                  body: { type: "string" },
                },
                required: ["origin", "body"],
              }],
            },
          },
        },
        required: ["messages"],
      },
    );

    await runtime.editWithRetry((tx) => {
      state.withTx(tx).set({ messages: [] });
    });

    const trustedHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        tx.setCfcImplementationIdentity({
          kind: "verified",
          moduleIdentity: "trusted-module",
          sourceFile: "/trusted.tsx",
          bindingPath: ["commitTrustedMessageSend"],
        });
        state.withTx(tx).key("messages").push({
          origin: "sent",
          body: "accepted",
        } as any);
      }) as EventHandler,
      {
        reads: [],
        writes: [state.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const fakeSentHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        state.withTx(tx).key("messages").push({
          origin: "sent",
          body: "rejected",
        } as any);
      }) as EventHandler,
      {
        reads: [],
        writes: [state.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const importedHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        state.withTx(tx).key("messages").push({
          origin: "imported",
          body: "allowed",
        } as any);
      }) as EventHandler,
      {
        reads: [],
        writes: [state.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancelTrusted = runtime.scheduler.addEventHandler(
      trustedHandler,
      trustedStream.getAsNormalizedFullLink(),
    );
    const cancelFakeSent = runtime.scheduler.addEventHandler(
      fakeSentHandler,
      fakeSentStream.getAsNormalizedFullLink(),
    );
    const cancelImported = runtime.scheduler.addEventHandler(
      importedHandler,
      importedStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      fakeSentStream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(state.get().messages).toEqual([]);

    runtime.scheduler.queueEvent(
      trustedStream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(state.get().messages.map((message) => message.body)).toEqual([
      "accepted",
    ]);

    runtime.scheduler.queueEvent(
      fakeSentStream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(state.get().messages.map((message) => message.body)).toEqual([
      "accepted",
    ]);

    runtime.scheduler.queueEvent(importedStream.getAsNormalizedFullLink(), {
      type: "click",
    });
    await runtime.idle();

    expect(state.get().messages.map((message) => message.body)).toEqual([
      "accepted",
      "allowed",
    ]);

    cancelImported();
    cancelFakeSent();
    cancelTrusted();
  });

  it("fails closed for untrusted array pushes guarded by a root uiContract", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-array-push-reject",
      { asCell: ["stream"] },
    );
    const messages = runtime.getCell<string[]>(
      space,
      "cfc-ui-contract-output-array-push-reject",
      {
        type: "array",
        items: { type: "string" },
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        messages.withTx(tx).push("rejected");
      }) as EventHandler,
      {
        reads: [],
        writes: [messages.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(messages.get()).toBeUndefined();
    cancel();
  });

  it("fails closed for untrusted pushes into object arrays guarded by a root uiContract", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-object-array-push-reject",
      { asCell: ["stream"] },
    );
    const messages = runtime.getCell<
      Array<{ id: string; body: string }>
    >(
      space,
      "cfc-ui-contract-output-object-array-push-reject",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            body: { type: "string" },
          },
          required: ["id", "body"],
        },
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        messages.withTx(tx).push({
          id: "message-1",
          body: "rejected",
        });
      }) as EventHandler,
      {
        reads: [],
        writes: [messages.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(messages.get()).toBeUndefined();
    cancel();
  });

  it("preserves nested cell-link schemas so later untrusted writes still fail closed", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-nested-cell-link-schema",
      { asCell: ["stream"] },
    );
    const protectedMessagesSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          body: { type: "string" },
        },
        required: ["body"],
      },
      ifc: {
        ...trustedPatternUiActionSchema.ifc,
      },
    } as const;
    const protectedRoot = runtime.getCell(
      space,
      "cfc-ui-contract-protected-root-nested-cell-link-schema",
      {
        type: "object",
        properties: {
          messages: protectedMessagesSchema,
        },
      },
    );
    const holder = runtime.getCell(
      space,
      "cfc-ui-contract-holder-nested-cell-link-schema",
      {
        type: "object",
        properties: {
          messages: {},
        },
      },
    );

    await runtime.editWithRetry((tx) => {
      holder.withTx(tx).set({
        messages: protectedRoot.key("messages"),
      } as { messages: unknown });
    });

    expect(
      resolvedSchema(
        holder.key("messages").resolveAsCell().getAsNormalizedFullLink()
          .schema,
      ),
    ).toEqual(protectedMessagesSchema);

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        const messages = holder.withTx(tx).key("messages")
          .resolveAsCell() as any;
        messages.push({ body: "rejected" });
      }) as EventHandler,
      {
        reads: [],
        writes: [holder.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(protectedRoot.get()).toBeUndefined();
    cancel();
  });

  it("fails closed when trusted event markers are missing or mismatched", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-reject",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-reject",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("rejected");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: { origin: "dom", trusted: true },
        target: {
          dataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      }),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(output.get()).toBeUndefined();
    cancel();
  });

  it("does not let one same-path uiContract satisfy a different contract", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-same-path-mismatch",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-same-path-mismatch",
      {
        allOf: [
          trustedPatternUiActionSchema,
          {
            type: "string",
            ifc: {
              uiContract: {
                helper: "UiAction",
                action: "ApproveDifferentAction",
                trustedPattern: "TrustedDirectCommandSurface",
                requiredEventIntegrity: ["TrustedDirectCommandSurface"],
              },
            },
          },
        ],
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("rejected");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(output.get()).toBeUndefined();
    cancel();
  });

  it("recovers after a mismatched trusted event is rejected", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-recover",
      { asCell: ["stream"] },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-recover",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction, event: { value: string }) => {
        output.withTx(tx).set(event.value);
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        value: "rejected",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();
    expect(output.get()).toBeUndefined();

    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        value: "accepted",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });
});

describe("host embedding contract: trusted-mark threat model", () => {
  // Host-embedding contract seam 6 (docs/features/host-embedding.md §6): the
  // trusted-event mark certifies that an event flow ORIGINATED FROM THE
  // RENDERED SURFACE — an anti-confused-deputy defense against in-runtime
  // pattern code exercising delegated authority it wasn't handed through the
  // real UI. What it certifies is *surface origin*, not *human intent*: it
  // cannot distinguish a human from a key-holding CLI or an agent-driven
  // browser (CDP-synthesized DOM events are `isTrusted === true`). Consequence:
  // first-class headless issuance for key-holding principals is consistent with
  // the threat model, and the in-runtime surface-origin defense must NOT be
  // weakened to accommodate it.
  //
  // The load-bearing code fact is that `trustedEventMatchesUiContract` checks
  // the renderer mark (a WeakSet membership set only on the trusted render
  // path) BEFORE it inspects provenance. So pattern code that assembles a
  // perfect lookalike `provenance` object — but never went through the render
  // path — fails the contract. This test pins that ordering; weakening the mark
  // check to accept unmarked events turns it red.

  const contract = uiContractFromSchema({ ...uiActionSchema });

  const lookalikeProvenance = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: { uiContractDataset: { uiAction: "SubmitDirectCommand" } },
    },
  } as const;

  it("rejects an UNMARKED event even with a perfect lookalike provenance", () => {
    // The confused-deputy case: pattern code fabricating the provenance shape
    // without the renderer mark. Surface origin is not attested → rejected.
    expect(
      trustedEventMatchesUiContract({ ...lookalikeProvenance }, contract),
    ).toBe(false);
  });

  it("accepts the SAME provenance once it carries the renderer mark", () => {
    // Same bytes, but marked as originating from the trusted render path.
    expect(
      trustedEventMatchesUiContract(
        rendererEvent({ ...lookalikeProvenance }),
        contract,
      ),
    ).toBe(true);
  });
});
