/**
 * Input requirements on a lift's arguments (spec §8.10.3,
 * `docs/plans/cfc-argument-input-requirements.md`). The endorsed lift here
 * coarsens a location fix, and requires its window gate to carry the owner's
 * integrity. The cases hold the honest wiring to running, and every way of
 * handing the lift a gate the owner did not write to being flagged under
 * `observe` and refused under `enforce`: a stand-in written by other code, a
 * literal written in the wiring, and an argument a viewer assembled from the
 * owner's fix and a gate of its own.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  argumentInputRefusals,
  argumentIntegrityRequirements,
} from "../src/cfc/argument-input-requirements.ts";
import type {
  CfcArgumentInputRefusal,
  CfcArgumentInputRequirementsMode,
} from "../src/cfc/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  isInternalVerifierRead,
  stableInternalVerifierRead,
} from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-argument-input-requirements",
);
const space = signer.did();

// Every lift, or only the honest one: lifts reading one argument document
// re-run together, so the honest lift's own runs are counted in a program
// that holds nothing else.
const ALL_OUTPUTS = `
  honest: coarsen({ fix, gate: gate as any }),
  standInRun: coarsen({ fix, gate: standIn as any }),
  literal: coarsen({ fix, gate: { always: true } as any }),
  viewRun: coarsen(view as any),
  partial: coarsen({ fix, gate: partialGate as any }),
  bareRun: coarsenOptional(bare as any),
  nullableRun: coarsenNullable({ fix, gate: standIn as any }),
  nestedRun: coarsen({ fix, gate: wrap.key("gate") as any }),
  derivedRun: coarsen({ fix, gate: reopen(gate as any) as any }),
  openGate: openGate({ gate }),
  forge: forge({ standIn }),
  assemble: assemble({ view, fix }),
  pointAtOwner: pointAtOwner({ view, fix, gate }),
  stampPart: stampPart({ partialGate }),
  wrapView: wrapView({ wrap, view }),`;
const HONEST_OUTPUTS = `
  honest: coarsen({ fix, gate: gate as any }),
  openGate: openGate({ gate }),`;
const REFERENCE_OUTPUTS = `
  viewRun: coarsen(view as any),
  openGate: openGate({ gate }),
  pointAtOwner: pointAtOwner({ view, fix, gate }),`;

const program = (outputs: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import {
  type AddIntegrity,
  Default,
  handler,
  lift,
  pattern,
  type RequiresIntegrity,
  Writable,
} from "commonfabric";

export interface Gate {
  always: boolean;
}

export interface Fix {
  lat: number;
}

/** The gate as its owner writes it: stamped with the owner's integrity. */
export type OwnerGate = AddIntegrity<Gate, readonly ["owner-gate"]>;

/** The endorsed coarsener: shows the fix only while the owner's gate is open. */
export const coarsen = lift(
  (
    args: {
      fix: Fix;
      gate: RequiresIntegrity<Gate, readonly ["owner-gate"]>;
    },
  ): string =>
    args?.gate?.always === true
      ? "near " + Math.round(args?.fix?.lat ?? 0)
      : "hidden",
);

/** The coarsener, with a gate that may be null: the requirement sits in a branch. */
export const coarsenNullable = lift(
  (
    args: {
      fix: Fix;
      gate: RequiresIntegrity<Gate, readonly ["owner-gate"]> | null;
    },
  ): string =>
    args?.gate?.always === true
      ? "near " + Math.round(args?.fix?.lat ?? 0)
      : "hidden",
);

/** The coarsener, with a gate an argument may leave out. */
export const coarsenOptional = lift(
  (
    args: {
      fix: Fix;
      gate?: RequiresIntegrity<Gate, readonly ["owner-gate"]>;
    },
  ): string =>
    args?.gate?.always === true
      ? "near " + Math.round(args?.fix?.lat ?? 0)
      : "hidden",
);

/** Other code's computation over the owner's gate. */
export const reopen = lift((gate: Gate): Gate => ({ always: gate?.always ?? false }));

/** The owner opens the gate. */
export const openGate = handler<void, { gate: Writable<OwnerGate> }>(
  (_, { gate }) => {
    gate.set({ always: true } as OwnerGate);
  },
);

/** Other code opens a gate of its own. */
export const forge = handler<void, { standIn: Writable<Gate> }>(
  (_, { standIn }) => {
    standIn.set({ always: true });
  },
);

/** A viewer assembles an argument: the owner's fix, and a gate it wrote. */
export const assemble = handler<
  void,
  { view: Writable<{ fix: Fix; gate: Gate }>; fix: Writable<Fix> }
>((_, { view, fix }) => {
  view.set({ fix, gate: { always: true } } as any);
});

/** A viewer points its argument at the owner's gate, which it did not choose to write. */
export const pointAtOwner = handler<
  void,
  {
    view: Writable<{ fix: Fix; gate: Gate }>;
    fix: Writable<Fix>;
    gate: Writable<OwnerGate>;
  }
>((_, { view, fix, gate }) => {
  view.set({ fix, gate } as any);
});

/** Other code makes a document a reference to the viewer's assembly. */
export const wrapView = handler<
  void,
  { wrap: Writable<{ fix: Fix; gate: Gate }>; view: Writable<{ fix: Fix; gate: Gate }> }
>((_, { wrap, view }) => {
  wrap.set(view as any);
});

/** A gate only one field of which the owner stamped. */
export interface PartlyStamped {
  always: boolean;
  stamp: AddIntegrity<string, readonly ["owner-gate"]>;
}

/** Other code opens a gate beside a field the owner's stamp is on. */
export const stampPart = handler<void, { partialGate: Writable<PartlyStamped> }>(
  (_, { partialGate }) => {
    partialGate.set({ always: true, stamp: "owner" } as PartlyStamped);
  },
);

interface Input {
  fix: Writable<Default<Fix, { lat: 51.6 }>>;
  gate: Writable<Default<OwnerGate, { always: false }>>;
  standIn: Writable<Default<Gate, { always: false }>>;
  partialGate: Writable<
    Default<PartlyStamped, { always: false; stamp: "" }>
  >;
  view: Writable<
    Default<{ fix: Fix; gate: Gate }, { fix: { lat: 0 }; gate: { always: false } }>
  >;
  wrap: Writable<
    Default<{ fix: Fix; gate: Gate }, { fix: { lat: 0 }; gate: { always: false } }>
  >;
  bare: Writable<Default<{ fix: Fix }, { fix: { lat: 51.6 } }>>;
}

// The casts only quiet the authoring types, which tell an AddIntegrity gate
// from a RequiresIntegrity one; the bindings are as written.
export default pattern<Input>(
  ({ fix, gate, standIn, view, partialGate, wrap, bare }) => ({${outputs}
  }),
);
`,
  }],
});

type Outputs = {
  honest?: string;
  standInRun?: string;
  literal?: string;
  viewRun?: string;
  partial?: string;
  bareRun?: string;
  nullableRun?: string;
  nestedRun?: string;
  derivedRun?: string;
};

// Every failed argument requirement, from every transaction: the lifts run in
// transactions the scheduler opens, out of reach of the test. Each entry also
// says how many of the verifier's own reads the recording transaction had
// made by then, which is how observe is shown to read nothing through it.
type Recorded = { reason: string; verifierReads: number };
let recorded: Recorded[] = [];
const recordCfcArgumentInputRefusal = ExtendedStorageTransaction.prototype
  .recordCfcArgumentInputRefusal;

const reasons = () => recorded.map(({ reason }) => reason);
const failedAt = (path: string) =>
  recorded.filter(({ reason }) =>
    reason.startsWith(`argument requiredIntegrity failed at ${path} of `)
  );

const run = async (
  mode: CfcArgumentInputRequirementsMode,
  outputs: string,
  body: (
    send: (stream: string) => Promise<void>,
    read: () => Promise<Outputs>,
  ) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
    cfcArgumentInputRequirements: mode,
  });
  try {
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(
      program(outputs),
      {
        space,
        tx,
      },
    );
    const result = runtime.getCell<Outputs>(
      space,
      `argument input requirements ${mode}`,
      undefined,
      tx,
    );
    runtime.run(tx, compiled, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    const send = async (stream: string) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(undefined);
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
    };
    const read = async () => {
      await runtime.idle();
      return (await result.pull()) as Outputs;
    };
    await body(send, read);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("cfc argument input requirements", () => {
  beforeEach(() => {
    recorded = [];
    ExtendedStorageTransaction.prototype.recordCfcArgumentInputRefusal =
      function (
        this: ExtendedStorageTransaction,
        refusal: CfcArgumentInputRefusal,
      ) {
        recorded.push({
          reason: refusal.reason,
          verifierReads: [...(this.getReadActivities?.() ?? [])].filter(
            (read) => isInternalVerifierRead(read.meta),
          ).length,
        });
        return recordCfcArgumentInputRefusal.call(this, refusal);
      };
  });

  afterEach(() => {
    ExtendedStorageTransaction.prototype.recordCfcArgumentInputRefusal =
      recordCfcArgumentInputRefusal;
  });

  describe("enforce", () => {
    it("runs the lift on the owner's gate, closed and open", async () => {
      await run("enforce", HONEST_OUTPUTS, async (send, read) => {
        // The gate the pattern's setup wrote carries the owner's stamp.
        expect((await read()).honest).toBe("hidden");
        await send("openGate");
        expect((await read()).honest).toBe("near 52");
        expect(failedAt("/gate")).toEqual([]);
      });
    });

    it("refuses a gate other code wrote", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).standInRun).toBeUndefined();
        expect(failedAt("/gate").length).toBeGreaterThan(0);
      });
    });

    it("refuses a gate written in the wiring", async () => {
      await run("enforce", ALL_OUTPUTS, async (_send, read) => {
        expect((await read()).literal).toBeUndefined();
        expect(failedAt("/gate").length).toBeGreaterThan(0);
      });
    });

    it("refuses a gate only part of which carries the owner's stamp", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("stampPart");
        expect((await read()).partial).toBeUndefined();
      });
    });

    it("refuses an argument a viewer assembled around the owner's fix", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("openGate");
        await send("assemble");
        const outputs = await read();
        expect(outputs.viewRun).toBeUndefined();
        // The owner's gate is open, and the lift still runs on it.
        expect(outputs.honest).toBe("near 52");
      });
    });

    it("follows a reference partway along a reference's own path", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("assemble");
        await send("wrapView");
        expect((await read()).nestedRun).toBeUndefined();
      });
    });

    it("refuses a gate other code computed from the owner's", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("openGate");
        expect((await read()).derivedRun).toBeUndefined();
      });
    });

    it("keeps a requirement that sits in an anyOf branch", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).nullableRun).toBeUndefined();
      });
    });

    it("observes nothing at an argument the binding does not reach", async () => {
      await run("enforce", ALL_OUTPUTS, async (_send, read) => {
        expect((await read()).bareRun).toBe("hidden");
      });
    });

    // Selection among values the owner stamped is not something an input
    // requirement rules out: the viewer may point at any gate the owner
    // wrote, a stale one included. Binding two inputs to one item is what
    // instance-bound integrity is for.
    it("runs on a reference a viewer made to the owner's gate", async () => {
      await run("enforce", REFERENCE_OUTPUTS, async (send, read) => {
        await send("openGate");
        await send("pointAtOwner");
        expect((await read()).viewRun).toBe("near 52");
      });
    });

    // The contrast for observe's case below: a refusal reached by reading a
    // stored document records the verifier's reads in the attempt. (A gate
    // written in the wiring is refused without reading anything.)
    it("reads through the attempt's own transaction", async () => {
      await run("enforce", ALL_OUTPUTS, async (send) => {
        await send("forge");
        expect(
          failedAt("/gate").some(({ verifierReads }) => verifierReads > 0),
        ).toBe(true);
      });
    });
  });

  describe("observe", () => {
    it("runs every lift and flags each gate the owner did not write", async () => {
      await run("observe", ALL_OUTPUTS, async (send, read) => {
        await send("openGate");
        await send("forge");
        await send("assemble");
        await send("stampPart");
        await send("wrapView");
        // Each lift the enforce cases refuse does run when nothing refuses it.
        expect(await read()).toMatchObject({
          honest: "near 52",
          standInRun: "near 52",
          literal: "near 52",
          viewRun: "near 52",
          partial: "near 52",
          nestedRun: "near 52",
          derivedRun: "near 52",
          nullableRun: "near 52",
          bareRun: "hidden",
        });
        // Seven lifts run on a gate the owner did not write; each is flagged
        // on each of its runs, and nothing else is.
        expect(reasons().length).toBeGreaterThanOrEqual(7);
        expect(failedAt("/gate").length).toBe(reasons().length);
      });
    });

    it("reads nothing through the attempt's transaction", async () => {
      await run("observe", ALL_OUTPUTS, async (send) => {
        await send("forge");
        expect(recorded.length).toBeGreaterThan(0);
        expect(recorded.every(({ verifierReads }) => verifierReads === 0))
          .toBe(true);
      });
    });

    it("does not flag the lift's runs on the owner's gate", async () => {
      await run("observe", HONEST_OUTPUTS, async (send, read) => {
        await send("openGate");
        expect((await read()).honest).toBe("near 52");
        expect(recorded).toEqual([]);
      });
    });
  });

  describe("off", () => {
    it("checks nothing", async () => {
      await run("off", ALL_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).standInRun).toBe("near 52");
        expect(recorded).toEqual([]);
      });
    });
  });

  // A graph built as data may carry a schema of its own for the node; the
  // runner unions it with the schema of the code the node's identity names.
  describe("requirements from two schemas", () => {
    const required = {
      type: "object",
      properties: {
        gate: { type: "object", ifc: { requiredIntegrity: ["owner-gate"] } },
      },
    } as const;
    it("keeps the code's requirement under a weaker graph schema", () => {
      expect(
        argumentIntegrityRequirements([required, { type: "object" }]),
      ).toEqual([{ path: ["gate"], requiredIntegrity: ["owner-gate"] }]);
      expect(argumentIntegrityRequirements([{ type: "object" }])).toEqual([]);
    });
  });

  // Absence consumes nothing, unless a schema the code did not declare could
  // fill it: the code would then be handed the value that schema chose.
  describe("absence that a foreign default fills", () => {
    const requirements = [{
      path: ["gate"],
      requiredIntegrity: ["owner-gate"],
    }];
    const withMissingGate = async (
      body: (
        refusals: (
          binding: unknown,
          graphDefaults: boolean,
        ) => readonly unknown[],
        link: (schema?: unknown) => unknown,
      ) => void,
    ) => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        const empty = runtime.getCell(space, "missing gate", undefined, tx);
        const base = empty.getAsNormalizedFullLink();
        const link = (schema?: unknown) => ({
          "/": {
            "link@1": {
              id: base.id,
              space: base.space,
              path: ["gate"],
              ...(schema === undefined ? {} : { schema }),
            },
          },
        });
        body(
          (binding, graphDefaults) =>
            argumentInputRefusals(
              tx,
              "code",
              binding,
              base,
              requirements,
              stableInternalVerifierRead,
              graphDefaults,
            ),
          link,
        );
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("observes nothing at a gate that is not there", async () => {
      await withMissingGate((refusals, link) => {
        expect(refusals({ gate: link() }, false)).toEqual([]);
      });
    });

    it("refuses a gate a reference's own schema would default", async () => {
      await withMissingGate((refusals, link) => {
        expect(
          refusals({ gate: link({ default: { always: true } }) }, false),
        ).toHaveLength(1);
      });
    });

    it("refuses a gate the graph's own schema would default", async () => {
      await withMissingGate((refusals, link) => {
        expect(refusals({ gate: link() }, true)).toHaveLength(1);
        expect(refusals({}, true)).toHaveLength(1);
      });
    });
  });
});
