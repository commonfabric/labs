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

import type { CfcArgumentInputRequirementsMode } from "../src/cfc/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

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
  openGate: openGate({ gate }),
  forge: forge({ standIn }),
  assemble: assemble({ view, fix }),
  stampPart: stampPart({ partialGate }),`;
const HONEST_OUTPUTS = `
  honest: coarsen({ fix, gate: gate as any }),
  openGate: openGate({ gate }),`;

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
}

// The casts only quiet the authoring types, which tell an AddIntegrity gate
// from a RequiresIntegrity one; the bindings are as written.
export default pattern<Input>(({ fix, gate, standIn, view, partialGate }) => ({${outputs}
}));
`,
  }],
});

type Outputs = {
  honest?: string;
  standInRun?: string;
  literal?: string;
  viewRun?: string;
  partial?: string;
};

// What each lift run noted, collected from every transaction: the lifts run
// in transactions the scheduler opens, out of reach of the test.
let diagnostics: string[] = [];
const noteCfcDiagnostic = ExtendedStorageTransaction.prototype
  .noteCfcDiagnostic;

const argumentDiagnostics = () =>
  diagnostics.filter((message) =>
    message.startsWith("argument-input-requirements(observe)")
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
    diagnostics = [];
    ExtendedStorageTransaction.prototype.noteCfcDiagnostic = function (
      this: ExtendedStorageTransaction,
      message: string,
    ) {
      diagnostics.push(message);
      return noteCfcDiagnostic.call(this, message);
    };
  });

  afterEach(() => {
    ExtendedStorageTransaction.prototype.noteCfcDiagnostic = noteCfcDiagnostic;
  });

  describe("enforce", () => {
    it("runs the lift on the owner's gate", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("openGate");
        expect((await read()).honest).toBe("near 52");
      });
    });

    it("refuses a gate other code wrote", async () => {
      await run("enforce", ALL_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).standInRun).toBeUndefined();
      });
    });

    it("refuses a gate written in the wiring", async () => {
      await run("enforce", ALL_OUTPUTS, async (_send, read) => {
        expect((await read()).literal).toBeUndefined();
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
  });

  describe("observe", () => {
    it("runs every lift and flags each gate the owner did not write", async () => {
      await run("observe", ALL_OUTPUTS, async (send, read) => {
        await send("openGate");
        await send("forge");
        await send("assemble");
        await send("stampPart");
        expect(await read()).toMatchObject({
          honest: "near 52",
          standInRun: "near 52",
          literal: "near 52",
          viewRun: "near 52",
          partial: "near 52",
        });
        const flagged = argumentDiagnostics();
        expect(flagged.length).toBeGreaterThan(0);
        expect(
          flagged.every((message) =>
            message.endsWith("argument requiredIntegrity failed at /gate")
          ),
        ).toBe(true);
      });
    });

    it("does not flag the lift's runs on the owner's gate", async () => {
      await run("observe", HONEST_OUTPUTS, async (send, read) => {
        const before = argumentDiagnostics().length;
        await send("openGate");
        expect((await read()).honest).toBe("near 52");
        expect(argumentDiagnostics().length).toBe(before);
      });
    });

    it("flags the lift's run on a stand-in", async () => {
      await run("observe", ALL_OUTPUTS, async (send, read) => {
        const before = argumentDiagnostics().length;
        await send("forge");
        expect((await read()).standInRun).toBe("near 52");
        expect(argumentDiagnostics().length).toBeGreaterThan(before);
      });
    });
  });

  describe("off", () => {
    it("checks nothing", async () => {
      await run("off", ALL_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).standInRun).toBe("near 52");
        expect(argumentDiagnostics()).toEqual([]);
      });
    });
  });
});
