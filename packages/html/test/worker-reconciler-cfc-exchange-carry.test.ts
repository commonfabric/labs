import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import { Runtime } from "@commonfabric/runner";
import type { RuntimeProgram } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
  renderSpaceAccessProviderFor,
} from "../../runtime-client/src/backends/runtime-processor.ts";
import {
  createCellRef,
  getCell,
} from "../../runtime-client/src/backends/utils.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

// A module policy releases what `project` computes over a sealed input, by a
// value-intrinsic rule (spec §5.3). The view shows the released value, values
// derived from it alone, and a public store a handler copied it into, beside
// a value an unreleased function computed and one that also read the sealed
// input. Each is mounted as the worker mounts a piece, under the viewer's
// default display ceiling, so what the policy has not released is replaced
// by the placeholder. Every value that must stay sealed carries a prefix that
// appears nowhere else, so a search of the operations for it is a search for
// the value having escaped.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

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

export const project = lift((s: Secret | undefined): Card => toCard(s));
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
  return {
    card,
    viaComputed: computed(() => "C:" + (card.rows?.[0]?.text ?? "")),
    byHandComputed: computed(() => "H:" + (byHand.rows?.[0]?.text ?? "")),
    mixed: computed(() => "X:" + card.match + "|" + (secret.get()?.b ?? "")),
    rowViews: card.rows.map((row) => <span>{row.text}</span>),
    seed: seed({ secret }),
  };
});
`;

const MAIN = `/// <cts-enable />
import { Default, handler, type MaxConfidentiality, NAME, pattern, UI, Writable } from "commonfabric";
import Card from "./card.tsx";

type Public = MaxConfidentiality<string, readonly []>;

const publish = handler<void, { from: string; to: Writable<Public> }>(
  (_, { from, to }) => {
    to.set(("P:" + from) as Public);
  },
);

interface Rooms {
  roomCard: Writable<Default<Public, "unset">>;
}

export default pattern<Rooms>(({ roomCard }) => {
  const card = Card({} as any);
  return {
    [NAME]: "exchange carry",
    [UI]: (
      <div>
        <p>{card.card.match}</p>
        <p>{card.viaComputed}</p>
        <p>{card.byHandComputed}</p>
        <p>{card.mixed}</p>
        <p>{roomCard}</p>
        {card.rowViews}
      </div>
    ),
    seed: card.seed,
    publishCard: publish({ from: card.card.rows[0].text, to: roomCard }),
  };
});
`;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    { name: "/card.tsx", contents: CARD },
  ],
};

const PLACEHOLDER = "Content hidden by policy";

Deno.test("worker reconciler shows values derived from a value-intrinsic release", async (t) => {
  const owner = await Identity.fromPassphrase("exchange carry owner");
  const space = owner.did();
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  try {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    // deno-lint-ignore no-explicit-any
    const piece = runtime.getCell<any>(space, "exchange-carry", undefined, tx);
    runtime.run(tx, pattern, {}, piece);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await piece.pull();
    await runtime.idle();

    const send = async (stream: string, event?: unknown) => {
      const sendTx = runtime.edit();
      piece.withTx(sendTx).key(stream).send(event);
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await piece.pull();
    };
    await send("seed", { a: "alpha", b: "beta" });
    await send("publishCard");

    const ceiling = defaultRenderConfidentialityCeiling(owner.did());
    const membershipProvider = renderMembershipProviderFor(
      runtime,
      owner,
      ceiling,
    );
    const modulePolicySource = renderModulePolicySourceFor(runtime, ceiling);
    const ops: VDomOp[] = [];
    const cancel = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      renderConfidentialityCeiling: ceiling,
      resolveRenderConfidentiality: renderConfidentialityResolverFor(
        runtime,
        owner,
        ceiling,
        owner.did(),
        membershipProvider,
        modulePolicySource,
      ),
      membershipProvider,
      modulePolicySource,
      spaceAccess: renderSpaceAccessProviderFor(runtime),
    }).mount(
      getCell(runtime, createCellRef(piece.key("$UI")))
        .asSchema(rendererVDOMSchema),
    );
    try {
      await runtime.idle();
      await t.settle();
      const shown = ops.flatMap((op) =>
        op.op === "create-text" || op.op === "update-text" ? [op.text] : []
      );
      const emitted = JSON.stringify(ops);

      await t.step("shows the released value", () => {
        expect(shown).toContain("M:alpha");
      });

      await t.step("shows a computed over the released value", () => {
        expect(shown).toContain("C:R0:alpha");
      });

      await t.step(
        "shows each element of a map over the released value",
        () => {
          expect(shown).toContain("R0:alpha");
          expect(shown).toContain("R1:beta");
        },
      );

      await t.step(
        "shows a public store a handler copied the released value into",
        () => {
          expect(shown).toContain("P:R0:alpha");
        },
      );

      await t.step(
        "hides a value an unreleased function computed, and one that also read the sealed input",
        () => {
          expect(shown.filter((text) => text === PLACEHOLDER)).toHaveLength(2);
          expect(emitted).not.toContain("H:R0:alpha");
          expect(emitted).not.toContain("X:M:alpha");
        },
      );
    } finally {
      cancel();
    }
  } finally {
    await storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  }
});
