import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { droppedStoredClaim } from "../src/cfc/claim-preservation.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase("runner-cfc-stored-claim-shapes");
const space = signer.did();

const LABEL = { confidentiality: ["writer-clause"] } as const;
const CONTRACT = {
  helper: "UiAction",
  action: "PinNote",
  trustedPattern: "PinSurface",
  requiredEventIntegrity: ["PinSurface"],
} as const;
const PIN = { type: "string", ifc: { uiContract: CONTRACT } } as const;
const LABELED_STRING = { type: "string", ifc: LABEL } as const;

const pinClick = () => {
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
  return event;
};

/** A write another writer attempts, through `schema` at `keys`. */
type Attempt = {
  readonly name: string;
  readonly schema: JSONSchema | undefined;
  readonly keys: readonly string[];
  readonly value: unknown;

  /**
   * Set where the attempt is refused even with the click: the merge of its
   * schema with the stored one cannot be shown to keep every stored claim,
   * so the commit refuses it rather than risk storing the loss.
   */
  readonly refusedWithClick?: true;
};

/** A stored shape carrying a contract, seeded by a trusted click. */
type Shape = {
  readonly name: string;
  readonly stored: JSONSchema;
  readonly seed: unknown;
  readonly attempts: readonly Attempt[];
};

const SHAPES: readonly Shape[] = [
  {
    name: "a field declaring the contract inline",
    stored: { type: "object", properties: { pin: PIN } },
    seed: { pin: "pinned" },
    attempts: [
      { name: "undeclared", schema: undefined, keys: ["pin"], value: "x" },
      {
        name: "labeled at the field",
        schema: { type: "object", properties: { pin: LABELED_STRING } },
        keys: [],
        value: { pin: "x" },
      },
      {
        name: "labeled through a definition of its own",
        schema: {
          type: "object",
          properties: { pin: { $ref: "#/$defs/Mine" } },
          $defs: { Mine: LABELED_STRING },
        },
        keys: [],
        value: { pin: "x" },
      },
    ],
  },
  {
    name: "a field whose contract sits behind a reference",
    stored: {
      type: "object",
      properties: { pin: { $ref: "#/$defs/Pin" } },
      $defs: { Pin: PIN },
    },
    seed: { pin: "pinned" },
    attempts: [
      { name: "undeclared", schema: undefined, keys: ["pin"], value: "x" },
      {
        name: "labeled at the field",
        schema: { type: "object", properties: { pin: LABELED_STRING } },
        keys: [],
        value: { pin: "x" },
      },
    ],
  },
  {
    // A candidate declaring structure beside the stored reference.
    name: "an object behind a reference that holds the contracted field",
    stored: {
      type: "object",
      properties: { box: { $ref: "#/$defs/Box" } },
      $defs: {
        Box: {
          type: "object",
          properties: { pin: PIN, other: { type: "string" } },
        },
      },
    },
    seed: { box: { pin: "pinned", other: "o" } },
    attempts: [
      {
        name: "labeled with sibling properties",
        schema: {
          type: "object",
          properties: {
            box: {
              type: "object",
              properties: { other: LABELED_STRING, pin: { type: "string" } },
            },
          },
        },
        keys: [],
        value: { box: { pin: "x", other: "o2" } },
      },
      {
        name: "undeclared through the object",
        schema: undefined,
        keys: ["box"],
        value: { pin: "x", other: "o3" },
      },
    ],
  },
  {
    name: "a recursive definition whose every level holds the contract",
    stored: {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { pin: PIN, child: { $ref: "#/$defs/Node" } },
        },
      },
    },
    seed: { node: { pin: "p1", child: { pin: "p2", child: { pin: "p3" } } } },
    attempts: [
      {
        name: "labeled two levels down",
        refusedWithClick: true,
        schema: {
          type: "object",
          properties: {
            node: {
              type: "object",
              ifc: LABEL,
              properties: {
                pin: LABELED_STRING,
                child: {
                  type: "object",
                  ifc: LABEL,
                  properties: {
                    pin: LABELED_STRING,
                    child: {
                      type: "object",
                      ifc: LABEL,
                      properties: { pin: LABELED_STRING },
                    },
                  },
                },
              },
            },
          },
        },
        keys: ["node", "child"],
        value: { pin: "x2", child: { pin: "x3" } },
      },
    ],
  },
  {
    // The writer declares a label deep inside the referenced object and
    // nothing at the object itself.
    name: "an object behind a reference with a label declared deep inside it",
    stored: {
      type: "object",
      properties: { box: { $ref: "#/$defs/Box" } },
      $defs: {
        Box: {
          type: "object",
          properties: {
            pin: PIN,
            meta: { type: "object", properties: { note: { type: "string" } } },
          },
        },
      },
    },
    seed: { box: { pin: "pinned", meta: { note: "n" } } },
    attempts: [{
      name: "labeled deep inside",
      schema: {
        type: "object",
        properties: {
          box: {
            type: "object",
            properties: {
              pin: { type: "string" },
              meta: { type: "object", properties: { note: LABELED_STRING } },
            },
          },
        },
      },
      keys: ["box"],
      value: { pin: "x", meta: { note: "n2" } },
    }],
  },
  {
    name: "a recursive tree whose every node holds the contract",
    stored: {
      type: "object",
      properties: { tree: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            pin: PIN,
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
    },
    seed: { tree: { pin: "pinned", children: [] } },
    attempts: [
      {
        name: "labeled through a recursive definition of its own",
        refusedWithClick: true,
        schema: {
          type: "object",
          properties: { tree: { $ref: "#/$defs/Other" } },
          $defs: {
            Other: {
              type: "object",
              properties: {
                pin: LABELED_STRING,
                children: { type: "array", items: { $ref: "#/$defs/Other" } },
              },
            },
          },
        },
        keys: [],
        value: { tree: { pin: "x", children: [] } },
      },
      {
        name: "labeled deep in the children",
        schema: {
          type: "object",
          properties: {
            tree: {
              type: "object",
              properties: {
                pin: { type: "string" },
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { note: LABELED_STRING },
                  },
                },
              },
            },
          },
        },
        keys: [],
        value: { tree: { pin: "x", children: [] } },
      },
    ],
  },
  {
    name: "a nullable field whose contract sits in one arm",
    stored: {
      type: "object",
      properties: {
        pin: { anyOf: [{ $ref: "#/$defs/Pin" }, { type: "null" }] },
      },
      $defs: { Pin: PIN },
    },
    seed: { pin: "pinned" },
    attempts: [
      {
        name: "labeled with arms of its own",
        refusedWithClick: true,
        schema: {
          type: "object",
          properties: {
            pin: { anyOf: [LABELED_STRING, { type: "null" }] },
          },
        },
        keys: [],
        value: { pin: "x" },
      },
      {
        name: "labeled inline",
        schema: { type: "object", properties: { pin: LABELED_STRING } },
        keys: [],
        value: { pin: "x" },
      },
    ],
  },
  {
    name: "array items declaring the contract inline",
    stored: { type: "array", items: PIN },
    seed: ["pinned"],
    attempts: [{
      name: "labeled items",
      schema: { type: "array", items: LABELED_STRING },
      keys: [],
      value: ["x"],
    }],
  },
  {
    name: "array items whose contract sits behind a reference",
    stored: {
      type: "array",
      items: { $ref: "#/$defs/Pin" },
      $defs: { Pin: PIN },
    },
    seed: ["pinned"],
    attempts: [{
      name: "labeled items",
      schema: { type: "array", items: LABELED_STRING },
      keys: [],
      value: ["x"],
    }],
  },
  {
    name: "an object declaring the contract at the root",
    stored: {
      type: "object",
      ifc: { uiContract: CONTRACT },
      properties: { child: { type: "string" } },
    },
    seed: { child: "pinned" },
    attempts: [
      { name: "undeclared", schema: undefined, keys: ["child"], value: "x" },
      {
        name: "labeled at the field",
        schema: { type: "object", properties: { child: LABELED_STRING } },
        keys: [],
        value: { child: "x" },
      },
    ],
  },
];

describe("stored claim shapes", () => {
  // Each shape stores a contract, and each attempt is a writer with no click
  // declaring nothing or a label of its own, shaped to meet the stored schema
  // somewhere the merge of the two could lose the contract. Every attempt is
  // refused, the value stays, and the stored envelope keeps every claim it
  // held once seeded.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const clickWrite = async (
    runtime: Runtime,
    id: string,
    schema: JSONSchema | undefined,
    value: unknown,
    keys: readonly string[] = [],
  ) => {
    const stream = runtime.getCell(space, `${id}-stream`, {
      asCell: ["stream"],
    });
    let output = runtime.getCell(space, id, schema);
    for (const key of keys) {
      output = output.key(key as never) as typeof output;
    }
    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set(value as never);
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
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), pinClick());
    await runtime.idle();
    cancel();
  };

  const storedEnvelope = (runtime: Runtime, id: string): JSONSchema => {
    const tx = runtime.edit();
    const link = runtime.getCell(space, id, undefined, tx)
      .getAsNormalizedFullLink();
    const stored = loadStoredCfcEnvelope(tx, link);
    tx.abort("inspected");
    expect(stored.status).toBe("loaded");
    return (stored as { schema: JSONSchema }).schema;
  };

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      for (const attempt of shape.attempts) {
        it(`refuses an unclicked ${attempt.name} writer and keeps the stored contract`, async () => {
          storageManager = StorageManager.emulate({ as: signer });
          runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
          });
          const id = `${shape.name}/${attempt.name}`;
          await clickWrite(runtime, id, shape.stored, shape.seed);
          const cell = runtime.getCell(space, id, shape.stored);
          expect(cell.get()).toEqual(shape.seed);
          const seeded = storedEnvelope(runtime, id);

          const tx = runtime.edit();
          let target = runtime.getCell(space, id, attempt.schema, tx);
          for (const key of attempt.keys) {
            target = target.key(key as never) as typeof target;
          }
          target.set(attempt.value as never);
          const result = await tx.commit();

          expect(isCfcEnforcementRejection(result.error)).toBe(true);
          expect(cell.get()).toEqual(shape.seed);
          expect(droppedStoredClaim(seeded, storedEnvelope(runtime, id)))
            .toBeUndefined();
        });
      }

      for (const attempt of shape.attempts) {
        it(
          `${
            attempt.refusedWithClick ? "refuses" : "commits"
          } a clicked ${attempt.name} writer and keeps every stored claim`,
          async () => {
            storageManager = StorageManager.emulate({ as: signer });
            runtime = new Runtime({
              apiUrl: new URL(import.meta.url),
              storageManager,
            });
            const id = `${shape.name}/${attempt.name}/clicked`;
            await clickWrite(runtime, id, shape.stored, shape.seed);
            expect(runtime.getCell(space, id, shape.stored).get()).toEqual(
              shape.seed,
            );
            const seeded = storedEnvelope(runtime, id);

            await clickWrite(
              runtime,
              id,
              attempt.schema,
              attempt.value,
              attempt.keys,
            );

            const now = runtime.getCell(space, id, shape.stored).get();
            if (attempt.refusedWithClick) expect(now).toEqual(shape.seed);
            else expect(now).not.toEqual(shape.seed);
            expect(droppedStoredClaim(seeded, storedEnvelope(runtime, id)))
              .toBeUndefined();
          },
        );
      }

      it("commits a clicked write through the declared schema", async () => {
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const id = `${shape.name}/clicked`;
        await clickWrite(runtime, id, shape.stored, shape.seed);
        const cell = runtime.getCell(space, id, shape.stored);
        expect(cell.get()).toEqual(shape.seed);
      });
    });
  }
});
