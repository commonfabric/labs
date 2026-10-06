import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-exchange-carry");
const space = signer.did();

// A module policy whose one rule drops its clause for what `project`, a
// function of the same module, computed: a value-intrinsic rule (spec §5.3),
// with no sink, no path and no grant guard. `card` is the released value;
// `viaComputed` and `mapped` derive from it alone, and `mixed` reads the
// sealed input beside it.
const CARD = `/// <cts-enable />
import { exchangeRule, exchangeRules, type PolicyOf, THIS_POLICY } from "commonfabric/cfc";
import { type Confidential, computed, Default, handler, lift, pattern, Writable } from "commonfabric";

export const releaseCard = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "project",
      },
    }],
  },
  post: { dropClause: true },
});
export const cardRules = exchangeRules([releaseCard]);

export interface Secret { a: string; b: string }
export type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof cardRules>]>;
export interface Row { text: string }
export interface Card { match: string; rows: Row[] }

const toCard = (s: Secret | undefined): Card => ({
  match: "M:" + (s?.a ?? ""),
  rows: [{ text: "R0:" + (s?.a ?? "") }, { text: "R1:" + (s?.b ?? "") }],
});

/** The released computation. */
export const project = lift((s: Secret | undefined): Card => toCard(s));

/** The same computation under a name no rule releases. */
export const projectByHand = lift((s: Secret | undefined): Card => toCard(s));

const seed = handler<Secret, { secret: Writable<Sealed<Secret>> }>(
  (event, { secret }) => {
    secret.set(event as Sealed<Secret>);
  },
);

interface Input {
  secret: Writable<Default<Sealed<Secret>, { a: ""; b: "" }>>;
}

export default pattern<Input>(({ secret }) => {
  const card = project(secret);
  const byHand = projectByHand(secret);
  const viaComputed = computed(() => "C:" + (card.rows?.[0]?.text ?? ""));
  const byHandComputed = computed(() => "H:" + (byHand.rows?.[0]?.text ?? ""));
  const mixed = computed(() => card.match + "|" + (secret.get()?.b ?? ""));
  const mapped = card.rows.map((row) => ({ shown: row.text }));
  return {
    card,
    viaComputed,
    byHandComputed,
    mixed,
    mapped,
    seed: seed({ secret }),
  };
});
`;

// The public stores sit beside the card rather than inside it, as in the
// other compiled CFC cases: each admits only public values, so a publish into
// one succeeds only when every clause it consumed was released.
const MAIN = `/// <cts-enable />
import { Default, handler, type MaxConfidentiality, pattern, Writable } from "commonfabric";
import Card from "./card.tsx";

type Public = MaxConfidentiality<string, readonly []>;

const publish = handler<void, { from: string; to: Writable<Public> }>(
  (_, { from, to }) => {
    to.set(("P:" + from) as Public);
  },
);

interface Rooms {
  roomCard: Writable<Default<Public, "unset">>;
  roomComputed: Writable<Default<Public, "unset">>;
  roomByHand: Writable<Default<Public, "unset">>;
  roomMixed: Writable<Default<Public, "unset">>;
}

export default pattern<Rooms>(
  ({ roomCard, roomComputed, roomByHand, roomMixed }) => {
    const card = Card({} as any);
    return {
      card: card.card,
      viaComputed: card.viaComputed,
      byHandComputed: card.byHandComputed,
      mixed: card.mixed,
      mapped: card.mapped,
      roomCard,
      roomComputed,
      roomByHand,
      roomMixed,
      seed: card.seed,
      publishCard: publish({ from: card.card.rows[0].text, to: roomCard }),
      publishComputed: publish({ from: card.viaComputed, to: roomComputed }),
      publishByHand: publish({ from: card.byHandComputed, to: roomByHand }),
      publishMixed: publish({ from: card.mixed, to: roomMixed }),
    };
  },
);
`;

const program = (card: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    { name: "/card.tsx", contents: card },
  ],
});

const RELEASED = program(CARD);

// The rule with a grant guard beside its integrity guard: grant-guarded
// (spec §5.3), so its result stays at the access it was evaluated for.
const GRANT_GUARDED = (() => {
  const post = "  post: { dropClause: true },\n});";
  expect(CARD).toContain(post);
  return program(CARD.replace(
    post,
    '  guard: { policyState: [{ kind: "approved" }] },\n' + post,
  ));
})();

type Piece = {
  card: { match: string; rows: { text: string }[] };
  viaComputed: string;
  byHandComputed: string;
  mixed: string;
  mapped: { shown: string }[];
  roomCard: string;
  roomComputed: string;
  roomByHand: string;
  roomMixed: string;
};

type Run = {
  send: (stream: string, event?: unknown) => Promise<void>;
  read: () => Promise<Piece>;
  entriesAt: (...keys: string[]) => readonly LabelMapEntry[];
};

const runPiece = async (
  source: RuntimeProgram,
  cause: string,
  options: { cfcPolicyEvaluation?: "off" | "observe" | "enforce" },
  body: (run: Run) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
    ...options,
  });
  try {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(source, {
      space,
      tx,
    });
    const result = runtime.getCell<Piece>(space, cause, undefined, tx);
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    // A refused publish leaves its room at its default, which is what the
    // cases read, so a commit error is not itself a failure here.
    const send = async (stream: string, event?: unknown) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(event);
      await sendTx.commit().settled;
      await runtime.idle();
      await result.pull();
    };
    const read = async () => {
      await runtime.idle();
      return (await result.pull()) as Piece;
    };
    const entriesAt = (...keys: string[]) => {
      const readTx = runtime.edit();
      try {
        // deno-lint-ignore no-explicit-any
        let cell: any = result;
        for (const key of keys) cell = cell.key(key);
        const link = cell.withTx(readTx).resolveAsCell()
          .getAsNormalizedFullLink();
        return readStoredCfcMetadata(readTx, link)?.labelMap.entries ?? [];
      } finally {
        readTx.abort();
      }
    };
    await body({ send, read, entriesAt });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const isPolicyAtom = (atom: unknown): boolean =>
  (atom as { type?: unknown })?.type === CFC_ATOM_TYPE.Policy;

const policyClausesOf = (entries: readonly LabelMapEntry[]): unknown[] =>
  entries.flatMap((entry) =>
    (entry.label.confidentiality ?? []).filter(isPolicyAtom)
  );

const transformedByOf = (entries: readonly LabelMapEntry[]) =>
  entries.flatMap((entry) =>
    (entry.label.integrity ?? []).filter((atom) =>
      (atom as { type?: unknown }).type === CFC_ATOM_TYPE.TransformedBy
    ) as {
      identity?: { symbol?: string };
      inputWitness?: { identity?: { symbol?: string } };
    }[]
  );

/** Whether some `TransformedBy` names `project` as an input witness. */
const witnessesProject = (entries: readonly LabelMapEntry[]): boolean =>
  transformedByOf(entries).some((atom) =>
    atom.inputWitness?.identity?.symbol === "project"
  );

describe("value-intrinsic exchange carry", () => {
  it("drops the released clause from a computed over the released value", async () => {
    await runPiece(
      RELEASED,
      "computed",
      {},
      async ({ send, read, entriesAt }) => {
        await send("seed", { a: "alpha", b: "beta" });
        expect((await read()).viaComputed).toBe("C:R0:alpha");
        const entries = entriesAt("viaComputed");
        expect(entries.length).toBeGreaterThan(0);
        expect(policyClausesOf(entries)).toEqual([]);
      },
    );
  });

  it("records the release's guard as an input witness of the computed", async () => {
    await runPiece(RELEASED, "witness", {}, async ({ send, entriesAt }) => {
      await send("seed", { a: "alpha", b: "beta" });
      expect(witnessesProject(entriesAt("viaComputed"))).toBe(true);
    });
  });

  it("admits a publish of the computed into a public store", async () => {
    await runPiece(RELEASED, "publish-computed", {}, async (run) => {
      await run.send("seed", { a: "alpha", b: "beta" });
      await run.send("publishComputed");
      expect((await run.read()).roomComputed).toBe("P:C:R0:alpha");
    });
  });

  it("persists the released label on a public store a handler copies the released value into", async () => {
    await runPiece(RELEASED, "publish-card", {}, async (run) => {
      await run.send("seed", { a: "alpha", b: "beta" });
      await run.send("publishCard");
      expect((await run.read()).roomCard).toBe("P:R0:alpha");
      const entries = run.entriesAt("roomCard").filter((entry) =>
        entry.origin === "derived"
      );
      expect(entries.length).toBeGreaterThan(0);
      expect(policyClausesOf(entries)).toEqual([]);
      expect(witnessesProject(entries)).toBe(true);
    });
  });

  it("drops the released clause from the elements and container of a map over the released value", async () => {
    await runPiece(
      RELEASED,
      "mapped",
      {},
      async ({ send, read, entriesAt }) => {
        await send("seed", { a: "alpha", b: "beta" });
        expect((await read()).mapped).toEqual([
          { shown: "R0:alpha" },
          { shown: "R1:beta" },
        ]);
        const container = entriesAt("mapped");
        const element = entriesAt("mapped", "0");
        expect(container.length).toBeGreaterThan(0);
        expect(element.length).toBeGreaterThan(0);
        expect(policyClausesOf(container)).toEqual([]);
        expect(policyClausesOf(element)).toEqual([]);
      },
    );
  });

  describe("what does not carry", () => {
    it("keeps the clause on a value derived from an input no rule releases", async () => {
      await runPiece(RELEASED, "by-hand", {}, async (run) => {
        await run.send("seed", { a: "alpha", b: "beta" });
        await run.send("publishByHand");
        expect((await run.read()).roomByHand).toBe("unset");
        expect(policyClausesOf(run.entriesAt("byHandComputed")).length)
          .toBeGreaterThan(0);
      });
    });

    it("keeps the clause a derived value takes from a sealed input it reads beside the released one", async () => {
      await runPiece(RELEASED, "mixed", {}, async (run) => {
        await run.send("seed", { a: "alpha", b: "beta" });
        await run.send("publishMixed");
        const piece = await run.read();
        expect(piece.mixed).toBe("M:alpha|beta");
        expect(piece.roomMixed).toBe("unset");
        const derived = run.entriesAt("mixed").filter((entry) =>
          entry.origin === "derived"
        );
        expect(policyClausesOf(derived).length).toBeGreaterThan(0);
      });
    });

    it("keeps the clause when the rule is grant-guarded", async () => {
      await runPiece(GRANT_GUARDED, "grant", {}, async (run) => {
        await run.send("seed", { a: "alpha", b: "beta" });
        await run.send("publishComputed");
        expect((await run.read()).roomComputed).toBe("unset");
        expect(policyClausesOf(run.entriesAt("viaComputed")).length)
          .toBeGreaterThan(0);
      });
    });

    it("keeps the clause when policy evaluation only observes", async () => {
      await runPiece(
        RELEASED,
        "observe",
        { cfcPolicyEvaluation: "observe" },
        async ({ send, entriesAt }) => {
          await send("seed", { a: "alpha", b: "beta" });
          expect(policyClausesOf(entriesAt("viaComputed")).length)
            .toBeGreaterThan(0);
        },
      );
    });
  });
});
