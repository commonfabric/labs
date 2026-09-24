import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { applyCfcPolicyToExistingValue } from "../src/cfc/policy-application.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { Runtime } from "../src/runtime.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";
import type { EventHandler } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase("runner-cfc-policy-application");
const space = signer.did();

// The writer the stored claims name, and the builtin that applies a label to
// a document it does not write.
const CLAIM_OWNER = "claim-owner";
const APPLIER = "policy-applier";

const PIN_CONTRACT = {
  helper: "UiAction",
  action: "PinNote",
  trustedPattern: "PinSurface",
  requiredEventIntegrity: ["PinSurface"],
} as const;

const STORED = {
  type: "object",
  properties: {
    queue: {
      type: "array",
      items: { type: "string" },
      ifc: { writeAuthorizedBy: [CLAIM_OWNER] },
    },
    pinned: { type: "string", ifc: { uiContract: PIN_CONTRACT } },
    other: { type: "string" },
  },
} as const satisfies JSONSchema;
const SEED = { queue: ["a"], pinned: "p", other: "o" };

// What the applier protects the document with: an owner label over all of it.
const OWNER_LABEL = {
  type: "object",
  ifc: { confidentiality: ["owner-clause"] },
} as const satisfies JSONSchema;

describe("a runtime policy application", () => {
  // Host code may label a document it does not write, such as a view it
  // hands its owner. Nothing is written, so the document's writer and click
  // claims have no write to govern. Every other requirement still holds, and
  // only the runtime can say that nothing was written.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const start = async (
    id: string,
    stored: JSONSchema = STORED,
    seed: unknown = SEED,
  ): Promise<Runtime> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    trust(tx, CLAIM_OWNER);
    const cell = runtime.getCell(space, id, stored, tx);
    cell.set(seed as never);
    const target = cell.getAsNormalizedFullLink();
    tx.recordCfcWritePolicyInput({
      kind: "trusted-event",
      target: { ...target, path: ["pinned"] },
      eventId: `seed-${id}`,
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "PinSurface",
          eventIntegrity: ["PinSurface"],
          uiContractDataset: { uiAction: "PinNote" },
        },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return runtime;
  };

  const trust = (tx: IExtendedStorageTransaction, builtinId?: string) => {
    tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
    if (builtinId !== undefined) {
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId });
    }
  };

  const refusalOf = (result: { error?: unknown }): string => {
    const error = result.error as Error | undefined;
    expect(isCfcEnforcementRejection(error)).toBe(true);
    return String(error?.message);
  };

  const storedIfcAt = (runtime: Runtime, id: string, key: string) => {
    const tx = runtime.edit();
    const envelope = loadStoredCfcEnvelope(tx, {
      space,
      id: runtime.getCell(space, id).getAsNormalizedFullLink().id,
      scope: undefined,
    } as never);
    tx.abort();
    expect(envelope.status).toBe("loaded");
    const schema = (envelope as { schema: JSONSchema }).schema as {
      properties?: Record<string, { ifc?: Record<string, unknown> }>;
      ifc?: Record<string, unknown>;
    };
    return { root: schema.ifc, at: schema.properties?.[key]?.ifc };
  };

  it("labels a document whose writer and click claims it does not satisfy", async () => {
    const runtime = await start("applies");
    const tx = runtime.edit();
    trust(tx, APPLIER);
    applyCfcPolicyToExistingValue(
      runtime.getCell(space, "applies", OWNER_LABEL, tx),
    );
    expect((await tx.commit()).error).toBeUndefined();

    const stored = storedIfcAt(runtime, "applies", "queue");
    expect(stored.root).toMatchObject({ confidentiality: ["owner-clause"] });
    expect(stored.at).toMatchObject({ writeAuthorizedBy: [CLAIM_OWNER] });
    expect(storedIfcAt(runtime, "applies", "pinned").at).toMatchObject({
      uiContract: PIN_CONTRACT,
    });
    expect(runtime.getCell(space, "applies", STORED).get()).toEqual(SEED);
  });

  describe("only the runtime can apply one", () => {
    // Pattern and handler code reach the cells they are bound to and the
    // transaction under them, so none of what they can call may stand in for
    // the runtime's application.

    it("is not among the modules a pattern can import", () => {
      // Walks every value the sandbox hands pattern code, including the
      // properties of its functions, for the application or the runtime's
      // authorization.
      const seen = new Set<unknown>();
      const reachable: unknown[] = [];
      const walk = (value: unknown) => {
        if (
          value === null ||
          (typeof value !== "object" && typeof value !== "function") ||
          seen.has(value)
        ) return;
        seen.add(value);
        reachable.push(value);
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
          if (descriptor && "value" in descriptor) walk(descriptor.value);
        }
      };
      walk(getRuntimeModuleExports().runtimeExports);
      expect(reachable.length).toBeGreaterThan(10);
      expect(reachable).not.toContain(applyCfcPolicyToExistingValue);
      expect(reachable).not.toContain(runtimeWritePolicyAuthorization);
    });

    it("refuses the cell's own schema application, whatever identity the transaction names", async () => {
      const runtime = await start("cell-method");
      const tx = runtime.edit();
      trust(tx, APPLIER);
      runtime.getCell(space, "cell-method", OWNER_LABEL, tx)
        .applyCfcSchemaToExistingValue();
      expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
    });

    it("refuses an application recorded without the runtime's authorization", async () => {
      const runtime = await start("unauthorized-record");
      const tx = runtime.edit();
      trust(tx, APPLIER);
      const cell = runtime.getCell(space, "unauthorized-record", OWNER_LABEL, tx);
      cell.applyCfcSchemaToExistingValue();
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "policy-application",
        target: {
          space: target.space,
          id: target.id,
          scope: target.scope,
          path: [],
        },
      });
      expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
    });

    const inHandler = async (
      runtime: Runtime,
      id: string,
      act: (tx: IExtendedStorageTransaction) => void,
    ) => {
      const stream = runtime.getCell(space, `${id}-stream`, {
        asCell: ["stream"],
      });
      const target = runtime.getCell(space, id, OWNER_LABEL);
      let status: unknown;
      const handler = Object.assign(
        ((tx: IExtendedStorageTransaction) => {
          trust(tx, APPLIER);
          act(tx);
        }) as EventHandler,
        {
          reads: [],
          writes: [target.getAsNormalizedFullLink()],
          module: { type: "javascript" as const },
          pattern: {} as never,
        },
      );
      const cancel = runtime.scheduler.addEventHandler(
        handler,
        stream.getAsNormalizedFullLink(),
      );
      const event = {
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "PinSurface",
            eventIntegrity: ["PinSurface"],
            uiContractDataset: { uiAction: "PinNote" },
          },
        },
      };
      markRendererTrustedEvent(event);
      runtime.scheduler.queueEvent(
        stream.getAsNormalizedFullLink(),
        event,
        undefined,
        (tx) => {
          status = tx.status().status;
        },
      );
      await runtime.idle();
      cancel();
      return status;
    };

    for (
      const [name, act] of [
        [
          "a handler applying its cell's schema",
          (runtime: Runtime, id: string) => (tx: IExtendedStorageTransaction) =>
            runtime.getCell(space, id, OWNER_LABEL, tx)
              .applyCfcSchemaToExistingValue(),
        ],
        [
          "a handler writing through a cell whose schema carries the label",
          (runtime: Runtime, id: string) => (tx: IExtendedStorageTransaction) =>
            runtime.getCell(space, id, OWNER_LABEL, tx).set(SEED as never),
        ],
        [
          "a handler recording the application itself",
          (runtime: Runtime, id: string) => (tx: IExtendedStorageTransaction) => {
            const cell = runtime.getCell(space, id, OWNER_LABEL, tx);
            cell.applyCfcSchemaToExistingValue();
            const target = cell.getAsNormalizedFullLink();
            tx.recordCfcWritePolicyInput({
              kind: "policy-application",
              target: {
                space: target.space,
                id: target.id,
                scope: target.scope,
                path: [],
              },
            });
          },
        ],
      ] as const
    ) {
      it(`refuses ${name}`, async () => {
        const id = `handler-${name}`;
        const runtime = await start(id);
        const status = await inHandler(runtime, id, act(runtime, id));
        expect(status).not.toBe("done");
        expect(storedIfcAt(runtime, id, "queue").root).toBeUndefined();
      });
    }
  });

  it("refuses an application under an identity that is not a builtin", async () => {
    const runtime = await start("verified-applier");
    const tx = runtime.edit();
    trust(tx);
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: "some-module",
      sourceFile: "/some.tsx",
      bindingPath: ["apply"],
    });
    applyCfcPolicyToExistingValue(
      runtime.getCell(space, "verified-applier", OWNER_LABEL, tx),
    );
    expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
  });

  it("refuses an application with no identity", async () => {
    const runtime = await start("unattributed-applier");
    const tx = runtime.edit();
    trust(tx);
    applyCfcPolicyToExistingValue(
      runtime.getCell(space, "unattributed-applier", OWNER_LABEL, tx),
    );
    expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
  });

  describe("a write to the document in the same transaction", () => {
    // Any write to the document, even one that changes nothing, leaves the
    // claims their ordinary force, and the application's own read reaches
    // the claimed list.

    for (
      const [name, key, value] of [
        ["beside the claims", "other", "changed"],
        ["at the writer claim", "queue", ["mallory"]],
        ["that changes nothing at the writer claim", "queue", ["a"]],
        ["that changes nothing at the click claim", "pinned", "p"],
      ] as const
    ) {
      it(`refuses an application beside a write ${name}`, async () => {
        const id = `with-write-${name}`;
        const runtime = await start(id);
        const tx = runtime.edit();
        trust(tx, APPLIER);
        applyCfcPolicyToExistingValue(
          runtime.getCell(space, id, OWNER_LABEL, tx),
        );
        runtime.getCell(space, id, undefined, tx).key(key).set(value as never);
        expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
        expect(runtime.getCell(space, id, STORED).get()).toEqual(SEED);
      });
    }
  });

  it("refuses an application whose schema would drop a stored claim", async () => {
    const stored = {
      type: "object",
      properties: {
        queue: {
          anyOf: [
            {
              type: "array",
              items: { type: "string" },
              ifc: { writeAuthorizedBy: [CLAIM_OWNER] },
            },
            { type: "null" },
          ],
        },
      },
    } as const satisfies JSONSchema;
    const runtime = await start("drops-claim", stored, { queue: ["a"] });
    const tx = runtime.edit();
    trust(tx, APPLIER);
    applyCfcPolicyToExistingValue(
      runtime.getCell(space, "drops-claim", {
        type: "object",
        properties: {
          queue: {
            anyOf: [
              { type: "array", ifc: { confidentiality: ["owner-clause"] } },
              { type: "null" },
            ],
          },
        },
      }, tx),
    );
    expect(refusalOf(await tx.commit())).toContain(
      "drops the stored writeAuthorizedBy at /queue",
    );
  });

  it("still applies the document's integrity floor", async () => {
    // The floor is a requirement on what the value was derived from, not on
    // who writes it, and the application reads a labeled source first.

    const stored = {
      type: "object",
      properties: {
        verified: {
          type: "string",
          ifc: {
            requiredIntegrity: ["verified-source"],
            addIntegrity: ["verified-source"],
          },
        },
      },
    } as const satisfies JSONSchema;
    const runtime = await start("floor", stored, { verified: "v" });
    {
      const tx = runtime.edit();
      runtime.getCell(space, "floor-source", {
        type: "string",
        ifc: { confidentiality: ["source-clause"] },
      }, tx).set("s");
      expect((await tx.commit()).error).toBeUndefined();
    }
    const tx = runtime.edit();
    trust(tx, APPLIER);
    runtime.getCell(space, "floor-source", {
      type: "string",
      ifc: { confidentiality: ["source-clause"] },
    }, tx).get();
    applyCfcPolicyToExistingValue(
      runtime.getCell(space, "floor", OWNER_LABEL, tx),
    );
    expect(refusalOf(await tx.commit())).toContain(
      "requiredIntegrity failed at /verified",
    );
  });
});
