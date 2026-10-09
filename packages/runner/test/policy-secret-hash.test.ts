import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { policySecretHashOf } from "../src/builtins/policy-secret-hash.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import {
  type CfcModulePolicyMarker,
  OWNING_SPACE_PLACEHOLDER,
} from "../src/cfc/policy.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  modulePolicySecret,
  runtimeSecretLink,
  unusableRuntimeSecret,
} from "../src/runtime-secret.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-policy-secret-hash");
const space = signer.did();

const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";

// The policy the hashes belong to. Its rule releases what `drawWinner`
// computes when every confidential input it read was written by the builtin,
// and nothing else.
const POLICY = `/// <cts-enable />
import { type Confidential, lift } from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const releaseDraw = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "${TRANSFORMED_BY}",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "drawWinner",
      },
      inputWitness: {
        type: "${TRANSFORMED_BY}",
        identity: { kind: "builtin", builtinId: "policySecretHash" },
      },
    }],
  },
  post: { dropClause: true },
});

// Releases what \`drawWinner\` computes over a list \`collectHashes\` wrote,
// when every confidential input that read was a hash the builtin wrote.
export const releaseCollected = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "${TRANSFORMED_BY}",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "drawWinner",
      },
      inputWitness: {
        type: "${TRANSFORMED_BY}",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "collectHashes",
        },
        inputWitness: {
          type: "${TRANSFORMED_BY}",
          identity: { kind: "builtin", builtinId: "policySecretHash" },
        },
      },
    }],
  },
  post: { dropClause: true },
});

export const drawRules = exchangeRules([releaseDraw, releaseCollected]);

export type DrawHash = Confidential<
  string,
  readonly [PolicyOf<typeof drawRules>]
>;

/** The hashes as one list, once every one of them is in. */
export const collectHashes = lift(
  (draw: { hashes: (string | undefined)[] }): string[] | undefined =>
    draw.hashes.some((hash) => !hash)
      ? undefined
      : draw.hashes.map((hash) => hash!),
);

/** The candidate whose hash sorts first, once every hash is in. */
export const drawWinner = lift(
  (draw: {
    candidates: string[];
    hashes: (string | undefined)[] | undefined;
  }): string => {
    const hashes = draw.hashes ?? [];
    if (hashes.length === 0 || hashes.some((hash) => !hash)) return "";
    let first = 0;
    hashes.forEach((hash, index) => {
      if (hash! < hashes[first]!) first = index;
    });
    return draw.candidates[first];
  },
);
`;

// A second policy, whose rule releases what its own `relabel` computes.
const OTHER_POLICY = `/// <cts-enable />
import { type Confidential, lift } from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const releaseRelabel = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "${TRANSFORMED_BY}",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "relabel",
      },
    }],
  },
  post: { dropClause: true },
});

export const otherRules = exchangeRules([releaseRelabel]);

export type OtherHash = Confidential<
  string,
  readonly [PolicyOf<typeof otherRules>]
>;

export const relabel = lift((hash: string | undefined): string => hash ?? "");
`;

// The rooms admit only public values, so a publish into one is where a
// release rule gets its chance.
const MAIN = `/// <cts-enable />
import {
  Default,
  handler,
  lift,
  type MaxConfidentiality,
  pattern,
  policySecretHash,
  Writable,
} from "commonfabric";
import { collectHashes, type DrawHash, drawWinner } from "./policy.tsx";
import { type OtherHash, relabel } from "./other-policy.tsx";


type RoomText = MaxConfidentiality<string, readonly []>;

const publish = handler<void, { from: string; to: Writable<RoomText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

const echo = lift((hash: string | undefined): string => hash ?? "");

// Derives from a hash a value that sorts first exactly when the hash's first
// digit is below 8: one bit of the hash, in a form the endorsed function
// accepts in a hash's place.
const standIn = lift((hash: string | undefined): string =>
  hash === undefined ? "" : parseInt(hash[0], 16) < 8 ? "0" : "f"
);

const rename = handler<void, { name: Writable<string> }>((_, { name }) => {
  name.set("dave");
});

interface Rooms {
  name: Writable<Default<string, "carol">>;
  items: Writable<Default<string[], ["alice", "bob"]>>;
  roomMapped: Writable<Default<RoomText, "">>;
  roomCollected: Writable<Default<RoomText, "">>;
  roomCollectedStandIn: Writable<Default<RoomText, "">>;
  roomWinner: Writable<Default<RoomText, "">>;
  roomEcho: Writable<Default<RoomText, "">>;
  roomRelabel: Writable<Default<RoomText, "">>;
  roomStandIn: Writable<Default<RoomText, "">>;
}

export default pattern<Rooms>((
  {
    name,
    items,
    roomMapped,
    roomCollected,
    roomCollectedStandIn,
    roomWinner,
    roomEcho,
    roomRelabel,
    roomStandIn,
  },
) => {
  const alice = policySecretHash<DrawHash>({ input: "alice" });
  const bob = policySecretHash<DrawHash>({ input: "bob" });
  const aliceAgain = policySecretHash<DrawHash>({ input: "alice" });
  const aliceOther = policySecretHash<OtherHash>({ input: "alice" });
  // An input stored under the other policy's clause.
  const carolHash = policySecretHash<DrawHash>({ input: relabel(aliceOther) });
  const nameHash = policySecretHash<DrawHash>({ input: name });
  const winner = drawWinner({
    candidates: ["alice", "bob"],
    hashes: [alice, bob],
  });
  const mappedWinner = drawWinner({
    candidates: items,
    hashes: items.map((item) => policySecretHash<DrawHash>({ input: item })),
  });
  const collectedWinner = drawWinner({
    candidates: ["alice", "bob"],
    hashes: collectHashes({ hashes: [alice, bob] }),
  });
  const collectedSteered = drawWinner({
    candidates: ["alice", "bob"],
    hashes: collectHashes({ hashes: [standIn(alice), bob] }),
  });
  const steered = drawWinner({
    candidates: ["alice", "bob"],
    hashes: [standIn(alice), bob],
  });
  return {
    alice,
    bob,
    aliceAgain,
    aliceOther,
    carolHash,
    nameHash,
    winner,
    mappedWinner,
    collectedWinner,
    collectedSteered,
    steered,
    roomCollected,
    roomCollectedStandIn,
    roomWinner,
    roomEcho,
    roomRelabel,
    roomStandIn,
    roomMapped,
    publishWinner: publish({ from: winner, to: roomWinner }),
    publishEcho: publish({ from: echo(alice), to: roomEcho }),
    publishRelabel: publish({ from: relabel(alice), to: roomRelabel }),
    publishStandIn: publish({ from: steered, to: roomStandIn }),
    rename: rename({ name }),
    publishMapped: publish({ from: mappedWinner, to: roomMapped }),
    publishCollected: publish({ from: collectedWinner, to: roomCollected }),
    publishCollectedStandIn: publish({
      from: collectedSteered,
      to: roomCollectedStandIn,
    }),
  };
});
`;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    { name: "/policy.tsx", contents: POLICY },
    { name: "/other-policy.tsx", contents: OTHER_POLICY },
  ],
};

type Draw = {
  alice?: string;
  bob?: string;
  aliceAgain?: string;
  aliceOther?: string;
  carolHash?: string;
  nameHash?: string;
  winner?: string;
  mappedWinner?: string;
  collectedWinner?: string;
  collectedSteered?: string;
  steered?: string;
  roomMapped: string;
  roomCollected: string;
  roomCollectedStandIn: string;
  roomWinner: string;
  roomEcho: string;
  roomRelabel: string;
  roomStandIn: string;
};

type Run = {
  runtime: Runtime;
  result: Cell<Draw>;
  send: (stream: string) => Promise<void>;
  read: () => Promise<Draw>;
};

/** Runs the program on `runtime` under `cause`, and hands `body` its run. */
const runDraw = async (
  runtime: Runtime,
  cause: string,
  body: (run: Run) => void | Promise<void>,
): Promise<void> => {
  const compileTx = runtime.edit();
  const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
    space,
    tx: compileTx,
  });
  expect((await compileTx.commit().settled).error).toBeUndefined();
  // A start retries a stale read, such as the absence of a policy manifest
  // another runtime of the space installed first.
  const result = runtime.getCell<Draw>(space, cause);
  const started = await runtime.editWithRetry((tx) => {
    runtime.run(tx, pattern, {}, result.withTx(tx));
  });
  expect(started.error).toBeUndefined();
  await result.pull();
  await runtime.idle();

  const read = async () => {
    await runtime.idle();
    return (await result.pull()) as Draw;
  };
  const send = async (stream: string) => {
    const sendTx = runtime.edit();
    // deno-lint-ignore no-explicit-any
    (result.withTx(sendTx) as any).key(stream).send(undefined);
    expect((await sendTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  };
  await body({ runtime, result, send, read });
};

/**
 * A runtime on its own emulated storage, enforcing CFC in `mode` with flow
 * labels at `flowLabels`.
 */
const withRuntime = async (
  mode: "enforce-strict" | "observe",
  body: (runtime: Runtime) => Promise<void>,
  flowLabels: "persist" | "off" = "persist",
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: mode,
    cfcFlowLabels: flowLabels,
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** The module-policy references the store behind `cell` is labeled with. */
const policyClausesOf = (
  runtime: Runtime,
  cell: Cell<unknown>,
): Record<string, unknown>[] => {
  const tx = runtime.edit();
  try {
    const metadata = readStoredCfcMetadata(
      tx,
      cell.resolveAsCell().getAsNormalizedFullLink(),
    );
    const atoms: unknown[] = (metadata?.labelMap.entries ?? [])
      .flatMap((entry) => entry.label.confidentiality ?? [])
      .flat();
    const byDigest = new Map<unknown, Record<string, unknown>>();
    for (const atom of atoms) {
      if (
        typeof atom === "object" && atom !== null &&
        (atom as Record<string, unknown>).type === CFC_ATOM_TYPE.Policy
      ) {
        const policy = atom as Record<string, unknown>;
        byDigest.set(policy.policyDigest, policy);
      }
    }
    return [...byDigest.values()];
  } finally {
    tx.abort("label read");
  }
};

/** The one module-policy reference the store behind `cell` is labeled with. */
const policyClauseOf = (
  runtime: Runtime,
  cell: Cell<unknown>,
): Record<string, unknown> | undefined => {
  const clauses = policyClausesOf(runtime, cell);
  expect(clauses).toHaveLength(1);
  return clauses[0];
};

/**
 * The key stored in the space for the policy `clause` names, read below the
 * transaction layer, which is where the read chokepoint is.
 */
const storedKey = (
  runtime: Runtime,
  clause: Record<string, unknown>,
): unknown => {
  const marker = {
    ...clause,
    subject: { [OWNING_SPACE_PLACEHOLDER]: true },
  } as CfcModulePolicyMarker;
  const tx = runtime.edit();
  try {
    return tx.tx.read(toMemorySpaceAddress(
      runtimeSecretLink(space, modulePolicySecret(marker).name),
    )).ok?.value;
  } finally {
    tx.abort("key read");
  }
};

describe("policySecretHash()", () => {
  it("hands out a hex hash under its policy's clause, bound to the space", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-label", async ({ result, read }) => {
        expect((await read()).alice).toMatch(/^[0-9a-f]{64}$/);
        expect(policyClauseOf(runtime, result.key("alice"))).toMatchObject({
          type: CFC_ATOM_TYPE.Policy,
          policyRefKind: "module",
          symbol: "drawRules",
          subject: space,
        });
      });
    });
  });

  it("returns the hash of the key and the input, the same for the same input", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-hash", async ({ result, read }) => {
        const draw = await read();
        const clause = policyClauseOf(runtime, result.key("alice"))!;
        const key = storedKey(runtime, clause);
        expect(typeof key).toBe("string");

        expect(draw.alice).toBe(policySecretHashOf(key as string, "alice"));
        expect(draw.aliceAgain).toBe(draw.alice);
        expect(draw.bob).toBe(policySecretHashOf(key as string, "bob"));
        expect(draw.bob).not.toBe(draw.alice);
      });
    });
  });

  it("hashes the input it holds when the input changes", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-rename", async ({ result, send, read }) => {
        const clause = policyClauseOf(runtime, result.key("alice"))!;
        const key = storedKey(runtime, clause) as string;
        expect((await read()).nameHash).toBe(policySecretHashOf(key, "carol"));

        await send("rename");
        expect((await read()).nameHash).toBe(policySecretHashOf(key, "dave"));
      });
    });
  });

  it("hashes under a key of each policy's own", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-policies", async ({ result, read }) => {
        const draw = await read();
        expect(draw.aliceOther).toMatch(/^[0-9a-f]{64}$/);
        expect(draw.aliceOther).not.toBe(draw.alice);
        expect(
          policyClauseOf(runtime, result.key("aliceOther"))?.policyDigest,
        ).not.toBe(policyClauseOf(runtime, result.key("alice"))?.policyDigest);
      });
    });
  });

  it("mints no key for a marker naming a policy's digest under another module", async () => {
    // A key is named by its policy's digest alone, so a marker pairing one
    // policy's digest with another module would put a key under that name
    // with a clause the policy's rules never rewrite.

    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-forged", async ({ result }) => {
        const clause = policyClauseOf(runtime, result.key("alice"))!;
        const other = policyClauseOf(runtime, result.key("aliceOther"))!;
        const key = storedKey(runtime, clause);
        const forged = {
          ...clause,
          moduleIdentity: other.moduleIdentity,
          symbol: other.symbol,
          subject: { [OWNING_SPACE_PLACEHOLDER]: true },
        } as CfcModulePolicyMarker;

        const tx = runtime.edit();
        tx.ensureRuntimeSecret(
          space,
          modulePolicySecret(forged),
          runtimeWritePolicyAuthorization,
        );
        expect((await tx.commit().settled).error).toBeDefined();
        expect(storedKey(runtime, clause)).toBe(key);
      });
    });
  });

  it("releases what the policy's endorsed function computes from its hashes", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-release", async ({ send, read }) => {
        const { winner } = await read();
        expect(["alice", "bob"]).toContain(winner);

        await send("publishWinner");
        expect((await read()).roomWinner).toBe(winner);
      });
    });
  });

  it("releases nothing computed from a list of hashes `.map()` builds, which carries no witness", async () => {
    // `.map()` builds a list of references the `map` builtin writes in a
    // transaction that read nothing labeled, under the clause the list's type
    // declares for its members, so each slot is a confidential input with no
    // writer's stamp, and a rule requiring the builtin's witness finds none.

    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-mapped", async ({ result, send, read }) => {
        const { winner } = await read();
        await waitForCellValue<string>(
          runtime,
          result.key("mappedWinner"),
          (value) => value === winner,
          { stuckLabel: "the mapped draw" },
        );

        await send("publishMapped");
        expect((await read()).roomMapped).toBe("");
      });
    });
  });

  it("releases what the endorsed function computes over a list of hashes an endorsed step collected", async () => {
    // The collecting step returns nothing until every hash is in, so the list
    // replaces a value of another kind, and the diff writes it empty before
    // it writes the hashes.

    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(
        runtime,
        "draw-collected",
        async ({ result, send, read }) => {
          const { winner } = await read();
          await waitForCellValue<string>(
            runtime,
            result.key("collectedWinner"),
            (value) => value === winner,
            { stuckLabel: "the collected draw" },
          );

          await send("publishCollected");
          expect((await read()).roomCollected).toBe(winner);
        },
      );
    });
  });

  it("releases nothing computed over a collected list holding a value other code derived from a hash", async () => {
    // The collecting step reads the stand-in as one of its inputs, so its
    // stamp on the list carries no witness of the builtin, and the rule that
    // pins the chain finds none.

    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(
        runtime,
        "draw-collected-stand-in",
        async ({ result, send, read }) => {
          await waitForCellValue<string>(
            runtime,
            result.key("collectedSteered"),
            (value) => value === "alice" || value === "bob",
            { stuckLabel: "the collected stand-in draw" },
          );

          await send("publishCollectedStandIn");
          expect((await read()).roomCollectedStandIn).toBe("");
        },
      );
    });
  });

  it("releases nothing other code computes from a hash", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-echo", async ({ send, read }) => {
        expect((await read()).alice).toBeDefined();

        await send("publishEcho");
        expect((await read()).roomEcho).toBe("");
      });
    });
  });

  it("releases nothing another policy's endorsed function computes from a hash", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-relabel", async ({ send, read }) => {
        expect((await read()).alice).toBeDefined();

        await send("publishRelabel");
        expect((await read()).roomRelabel).toBe("");
      });
    });
  });

  it("hashes a labeled input under both its own clause and the policy's", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-labeled", async ({ result, read }) => {
        expect((await read()).carolHash).toMatch(/^[0-9a-f]{64}$/);
        const digests = policyClausesOf(runtime, result.key("carolHash"))
          .map((clause) => clause.policyDigest);
        expect(new Set(digests)).toEqual(
          new Set([
            policyClauseOf(runtime, result.key("alice"))?.policyDigest,
            policyClauseOf(runtime, result.key("aliceOther"))?.policyDigest,
          ]),
        );
      });
    });
  });

  it("releases nothing the endorsed function computes over a value other code derived from a hash", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-stand-in", async ({ send, read }) => {
        const { steered } = await read();
        expect(["alice", "bob"]).toContain(steered);

        await send("publishStandIn");
        expect((await read()).roomStandIn).toBe("");
      });
    });
  });

  it("hands every runtime of the space the same hash, however they race to mint the key", async () => {
    const server = newSharedServer();
    const managers = [
      EmulatedStorageManager.connectTo(server, { as: signer }),
      EmulatedStorageManager.connectTo(server, { as: signer }),
    ];
    const runtimes = managers.map((storageManager) =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      })
    );
    try {
      // Both start together, so both find no key and mint one, and the
      // commit that lands second conflicts on its read of the absence.
      const hashes = await Promise.all(
        runtimes.map((runtime, index) => {
          let hash: string | undefined;
          return runDraw(runtime, `draw-shared-${index}`, async ({ read }) => {
            hash = (await read()).alice;
          }).then(() => hash);
        }),
      );
      expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes[1]).toBe(hashes[0]);
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      for (const manager of managers) await manager.close();
    }
  });

  it("hands a runtime that joins after the mint the hash the first one computed", async () => {
    const server = newSharedServer();
    const managers = [
      EmulatedStorageManager.connectTo(server, { as: signer }),
      EmulatedStorageManager.connectTo(server, { as: signer }),
    ];
    const runtimes = managers.map((storageManager) =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      })
    );
    try {
      const hashes: (string | undefined)[] = [];
      for (const [index, runtime] of runtimes.entries()) {
        await runDraw(runtime, `draw-join-${index}`, async ({ read }) => {
          hashes.push((await read()).alice);
        });
      }
      expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes[1]).toBe(hashes[0]);
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      for (const manager of managers) await manager.close();
    }
  });

  it("hands out nothing once the key's location holds a value under another label", async () => {
    // A stored label never weakens, so the runtime cannot mint the key over
    // such a value, and the policy has no key in the space.

    let digest: unknown;
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-digest", ({ result }) => {
        digest = policyClauseOf(runtime, result.key("alice"))?.policyDigest;
      });
    });
    expect(typeof digest).toBe("string");

    await withRuntime("enforce-strict", async (runtime) => {
      const plant = runtime.edit();
      plant.ensureRuntimeSecret(
        space,
        unusableRuntimeSecret(`policy:${digest}`),
        runtimeWritePolicyAuthorization,
      );
      expect((await plant.commit().settled).error).toBeUndefined();

      await runDraw(runtime, "draw-planted", async ({ read }) => {
        expect((await read()).alice).toBeUndefined();
      });
    });
  });

  it("hands out nothing where flow labels are not persisted", async () => {
    await withRuntime("enforce-strict", async (runtime) => {
      await runDraw(runtime, "draw-no-flow", async ({ read }) => {
        expect((await read()).alice).toBeUndefined();
      });
    }, "off");
  });

  it("hands out nothing where CFC is not enforced", async () => {
    await withRuntime("observe", async (runtime) => {
      await runDraw(runtime, "draw-observe", async ({ read }) => {
        const draw = await read();
        expect(draw.alice).toBeUndefined();
        expect(draw.winner).toBe("");
      });
    });
  });
});
