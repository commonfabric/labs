/**
 * A node's input requirements (spec §8.9, §8.10.3). Trusted code that declares
 * `requiredIntegrity` on its input admits only an input carrying it, as §10's
 * `to_city()` does: a location other code shifted, or wrote itself, is refused
 * before the commit. The same holds of an input that shapes whether data is
 * released (§3.8.4), such as a location-sharing window gate: a gate a viewer
 * wrote, wired in, or assembled around the owner's fix is refused. Handlers'
 * inputs are held to the same check as lifts'.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  argumentInputRefusals,
  argumentIntegrityRequirements,
  schemaDefaultsAt,
} from "../src/cfc/node-input-requirements.ts";
import type { CfcArgumentInputRefusal } from "../src/cfc/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  internalVerifierRead,
  isInternalVerifierRead,
} from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-node-input-requirements",
);
const space = signer.did();

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

export interface Location {
  lat: number;
  long: number;
}

/** A location as the device measured it. */
export type Measured = AddIntegrity<Location, readonly ["gps-measurement"]>;

/** The trusted coarsener: a measured location in, a city out. */
export const toCity = lift(
  (args: {
    location: RequiresIntegrity<Location, readonly ["gps-measurement"]>;
  }): string =>
    args?.location === undefined
      ? "unknown"
      : "city " + Math.round(args.location.lat) + "," +
        Math.round(args.location.long),
);

/** The device records a measurement. */
export const measure = handler<void, { measured: Writable<Measured> }>(
  (_, { measured }) => {
    measured.set({ lat: 48.86, long: 2.35 } as Measured);
  },
);

/** Other code shifts the measured location a little, to probe a boundary. */
export const shift = lift((location: Location): Location => ({
  lat: (location?.lat ?? 0) + 0.4,
  long: location?.long ?? 0,
}));

/** Other code writes a location of its own choosing. */
export const forgeLocation = handler<void, { fake: Writable<Location> }>(
  (_, { fake }) => {
    fake.set({ lat: 51.51, long: -0.13 });
  },
);

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

/** A viewer points its argument at the owner's gate. */
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

/** Settings the owner writes whole, stamped, with no gate in them. */
export type OwnerSettings = AddIntegrity<{ fix: Fix; gate?: Gate }, readonly ["owner-gate"]>;

/** The owner saves settings that leave the gate out. */
export const saveSettings = handler<void, { settings: Writable<OwnerSettings> }>(
  (_, { settings }) => {
    settings.set({ fix: { lat: 51.6 } } as OwnerSettings);
  },
);

/** A trusted handler that acts on a gate, which it requires the owner wrote. */
export const useGate = handler<
  void,
  {
    gate: RequiresIntegrity<Gate, readonly ["owner-gate"]>;
    log: Writable<string>;
  }
>((_, { gate, log }) => {
  log.set(gate?.always === true ? "open" : "closed");
});

interface Input {
  measured: Writable<Default<Measured, { lat: 0; long: 0 }>>;
  fake: Writable<Default<Location, { lat: 0; long: 0 }>>;
  fix: Writable<Default<Fix, { lat: 51.6 }>>;
  gate: Writable<Default<OwnerGate, { always: false }>>;
  standIn: Writable<Default<Gate, { always: false }>>;
  view: Writable<
    Default<{ fix: Fix; gate: Gate }, { fix: { lat: 0 }; gate: { always: false } }>
  >;
  wrap: Writable<
    Default<{ fix: Fix; gate: Gate }, { fix: { lat: 0 }; gate: { always: false } }>
  >;
  bare: Writable<Default<{ fix: Fix }, { fix: { lat: 51.6 } }>>;
  settings: Writable<Default<OwnerSettings, { fix: { lat: 0 } }>>;
  ownerLog: Writable<Default<string, "">>;
  forgedLog: Writable<Default<string, "">>;
}

// The casts only quiet the authoring types, which tell an AddIntegrity value
// from a RequiresIntegrity one; the bindings are as written.
export default pattern<Input>(
  ({
    measured,
    fake,
    fix,
    gate,
    standIn,
    view,
    wrap,
    bare,
    settings,
    ownerLog,
    forgedLog,
  }) => ({${outputs}
  }),
);
`,
  }],
});

const LOCATION_OUTPUTS = `
    city: toCity({ location: measured as any }),
    shiftedCity: toCity({ location: shift(measured as any) as any }),
    fakeCity: toCity({ location: fake as any }),
    measure: measure({ measured }),
    forgeLocation: forgeLocation({ fake }),`;

const GATE_OUTPUTS = `
    honest: coarsen({ fix, gate: gate as any }),
    standInRun: coarsen({ fix, gate: standIn as any }),
    literal: coarsen({ fix, gate: { always: true } as any }),
    viewRun: coarsen(view as any),
    nestedRun: coarsen({ fix, gate: wrap.key("gate") as any }),
    derivedRun: coarsen({ fix, gate: reopen(gate as any) as any }),
    nullableRun: coarsenNullable({ fix, gate: standIn as any }),
    bareRun: coarsenOptional(bare as any),
    settingsRun: coarsenOptional(settings as any),
    openGate: openGate({ gate }),
    forge: forge({ standIn }),
    assemble: assemble({ view, fix }),
    wrapView: wrapView({ wrap, view }),
    saveSettings: saveSettings({ settings }),`;

const HONEST_GATE_OUTPUTS = `
    honest: coarsen({ fix, gate: gate as any }),
    openGate: openGate({ gate }),`;

const REFERENCE_OUTPUTS = `
    viewRun: coarsen(view as any),
    openGate: openGate({ gate }),
    pointAtOwner: pointAtOwner({ view, fix, gate }),`;

const HANDLER_OUTPUTS = `
    ownerLog,
    forgedLog,
    useOwner: useGate({ gate: gate as any, log: ownerLog }),
    useForged: useGate({ gate: standIn as any, log: forgedLog }),
    forge: forge({ standIn }),`;

type Outputs = Record<string, string | undefined>;

// Every failed requirement, from every transaction: the nodes run in
// transactions the scheduler opens, out of reach of the test. Each entry also
// counts the verifier's own reads its transaction had made by then.
type Recorded = { reason: string; verifierReads: number };
let recorded: Recorded[] = [];
const recordCfcArgumentInputRefusal = ExtendedStorageTransaction.prototype
  .recordCfcArgumentInputRefusal;

const failedAt = (path: string) =>
  recorded.filter(({ reason }) =>
    reason.startsWith(`input requiredIntegrity failed at ${path} of `)
  );

const run = async (
  outputs: string,
  body: (
    send: (stream: string) => Promise<unknown>,
    read: () => Promise<Outputs>,
  ) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  try {
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(
      program(outputs),
      { space, tx },
    );
    const result = runtime.getCell<Outputs>(
      space,
      "node input requirements",
      undefined,
      tx,
    );
    runtime.run(tx, compiled, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    // Returns the handler commit's error, if it was refused.
    const send = async (stream: string) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(undefined);
      const { error } = await sendTx.commit().settled;
      await runtime.idle();
      await result.pull();
      return error;
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

describe("cfc node input requirements", () => {
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

  // §10's boundary-probing example: the integrity that matters is on the
  // data the trusted code releases.
  describe("a trusted transformer's input (§10 to_city)", () => {
    it("releases a measured location", async () => {
      await run(LOCATION_OUTPUTS, async (send, read) => {
        await send("measure");
        expect((await read()).city).toBe("city 49,2");
      });
    });

    it("refuses a location other code shifted from the measured one", async () => {
      await run(LOCATION_OUTPUTS, async (send, read) => {
        await send("measure");
        expect((await read()).shiftedCity).toBeUndefined();
        expect(failedAt("/location").length).toBeGreaterThan(0);
      });
    });

    it("refuses a location other code wrote", async () => {
      await run(LOCATION_OUTPUTS, async (send, read) => {
        await send("forgeLocation");
        expect((await read()).fakeCity).toBeUndefined();
      });
    });
  });

  // §3.8.4: a parameter that shapes whether release occurs carries integrity.
  describe("a release-shaping control input (a window gate)", () => {
    it("runs on the owner's gate, closed and open", async () => {
      await run(HONEST_GATE_OUTPUTS, async (send, read) => {
        // The gate the pattern's setup wrote carries the owner's stamp.
        expect((await read()).honest).toBe("hidden");
        await send("openGate");
        expect((await read()).honest).toBe("near 52");
        expect(recorded).toEqual([]);
      });
    });

    it("refuses a gate a viewer assembled around the owner's fix", async () => {
      await run(GATE_OUTPUTS, async (send, read) => {
        await send("openGate");
        await send("assemble");
        const outputs = await read();
        expect(outputs.viewRun).toBeUndefined();
        expect(outputs.honest).toBe("near 52");
        expect(failedAt("/gate").length).toBeGreaterThan(0);
      });
    });

    it("refuses a gate other code wrote", async () => {
      await run(GATE_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).standInRun).toBeUndefined();
      });
    });

    it("refuses a gate written in the wiring", async () => {
      await run(GATE_OUTPUTS, async (_send, read) => {
        expect((await read()).literal).toBeUndefined();
      });
    });

    it("follows a reference partway along a reference's own path", async () => {
      await run(GATE_OUTPUTS, async (send, read) => {
        await send("assemble");
        await send("wrapView");
        expect((await read()).nestedRun).toBeUndefined();
      });
    });

    it("refuses a gate other code computed from the owner's", async () => {
      await run(GATE_OUTPUTS, async (send, read) => {
        await send("openGate");
        expect((await read()).derivedRun).toBeUndefined();
      });
    });

    it("keeps a requirement that sits in an anyOf branch", async () => {
      await run(GATE_OUTPUTS, async (send, read) => {
        await send("forge");
        expect((await read()).nullableRun).toBeUndefined();
      });
    });

    // An absent gate is read and found absent: a shape observation of where
    // it is missing from, labeled as that position is.
    it("refuses a gate found absent from a document the owner did not write", async () => {
      await run(GATE_OUTPUTS, async (_send, read) => {
        expect((await read()).bareRun).toBeUndefined();
      });
    });

    it("runs on a gate found absent from settings the owner wrote", async () => {
      await run(GATE_OUTPUTS, async (send, read) => {
        await send("saveSettings");
        expect((await read()).settingsRun).toBe("hidden");
      });
    });

    // Selection among values the owner stamped is not something an input
    // requirement rules out: binding two inputs to one item is what
    // instance-bound integrity is for.
    it("runs on a reference a viewer made to the owner's gate", async () => {
      await run(REFERENCE_OUTPUTS, async (send, read) => {
        await send("openGate");
        await send("pointAtOwner");
        expect((await read()).viewRun).toBe("near 52");
      });
    });

    it("reads through the attempt's own transaction, as the verifier's", async () => {
      await run(GATE_OUTPUTS, async (send) => {
        await send("forge");
        expect(
          failedAt("/gate").some(({ verifierReads }) => verifierReads > 0),
        ).toBe(true);
      });
    });
  });

  describe("a handler's input", () => {
    // A handler's state is bound under `$ctx`; the event's dispatch commits,
    // and the handler's own run is what the check refuses.
    it("acts on the owner's gate and refuses another's", async () => {
      await run(HANDLER_OUTPUTS, async (send, read) => {
        await send("useOwner");
        expect((await read()).ownerLog).toBe("closed");
        expect(recorded).toEqual([]);
        await send("forge");
        await send("useForged");
        expect((await read()).forgedLog).toBe("");
        expect(failedAt("/$ctx/gate").length).toBeGreaterThan(0);
      });
    });
  });

  describe("bound requirements", () => {
    const required = {
      type: "object",
      properties: {
        gate: { type: "object", ifc: { requiredIntegrity: ["owner-gate"] } },
      },
    } as const;

    // A graph built as data may carry a schema of its own for the node; the
    // runner checks it beside the schema of the code the identity names.
    it("keeps the code's requirement under a weaker graph schema", () => {
      expect(
        argumentIntegrityRequirements([required, { type: "object" }]),
      ).toEqual([{ path: ["gate"], requiredIntegrity: ["owner-gate"] }]);
      expect(argumentIntegrityRequirements([required, required])).toHaveLength(
        1,
      );
    });

    it("finds a default that could fill a path, and only such a default", () => {
      expect(schemaDefaultsAt({ default: 1 }, [])).toBe(true);
      expect(
        schemaDefaultsAt(
          { properties: { gate: { default: { always: true } } } },
          ["gate"],
        ),
      ).toBe(true);
      expect(
        schemaDefaultsAt({ properties: { other: { default: "x" } } }, ["gate"]),
      ).toBe(false);
      expect(schemaDefaultsAt({ default: { other: 1 } }, ["gate"])).toBe(false);
      expect(schemaDefaultsAt({ default: { gate: 1 } }, ["gate"])).toBe(true);
      expect(schemaDefaultsAt({ $ref: "#/$defs/missing" }, ["gate"])).toBe(
        true,
      );
    });
  });

  // Each reference and absence case, against one unlabeled document.
  describe("references and absence", () => {
    const requirements = [{
      path: ["gate"],
      requiredIntegrity: ["owner-gate"],
    }];
    const withDocument = async (
      body: (
        refusals: (binding: unknown) => readonly unknown[],
        link: (schema?: unknown, path?: string[]) => unknown,
        write: (value: unknown) => Promise<void>,
      ) => Promise<void>,
    ) => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const setup = runtime.edit();
        const base = runtime.getCell(space, "missing gate", undefined, setup)
          .getAsNormalizedFullLink();
        setup.abort();
        const link = (schema?: unknown, path: string[] = ["gate"]) => ({
          "/": {
            "link@1": {
              id: base.id,
              space: base.space,
              path,
              ...(schema === undefined ? {} : { schema }),
            },
          },
        });
        // Written and committed in a transaction of its own, so the check
        // runs in one that has written nothing.
        const write = async (value: unknown) => {
          const tx = runtime.edit();
          tx.writeValueOrThrow({ ...base, path: [] }, value as never);
          await tx.commit().settled;
        };
        const refusals = (binding: unknown) => {
          const tx = runtime.edit();
          try {
            return argumentInputRefusals(
              tx,
              "code",
              binding,
              base,
              requirements,
              internalVerifierRead,
            );
          } finally {
            tx.abort();
          }
        };
        await body(refusals, link, write);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    const reason = (refused: readonly unknown[]) =>
      (refused[0] as CfcArgumentInputRefusal | undefined)?.reason;

    it("refuses a gate found absent where no label vouches for it", async () => {
      await withDocument(async (refusals, link) => {
        expect(reason(refusals({ gate: link() }))).toBe(
          "input requiredIntegrity failed at /gate of code",
        );
      });
    });

    it("refuses a gate the wiring left out", async () => {
      await withDocument(async (refusals) => {
        expect(reason(refusals({}))).toBe(
          "input requiredIntegrity failed at /gate of code",
        );
      });
    });

    it("refuses a reference cycle whose path grows", async () => {
      await withDocument(async (refusals, link, write) => {
        await write({ gate: link(undefined, ["gate", "inner"]) });
        expect(reason(refusals({ gate: link() }))).toBe(
          "input requiredIntegrity failed at /gate of code",
        );
      });
    });
  });
});
