import { expect } from "@std/expect";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, UI } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { buildCfcPolicyArtifactManifest } from "../../runner/src/cfc/policy.ts";
import type { JSONSchema } from "../../runner/src/builder/types.ts";
import { vnodeSchema } from "../../runner/src/schemas.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../../runner/test/support/trusted-builder.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type {
  WorkerReconcilerOptions,
  WorkerVNode,
} from "../src/worker/types.ts";

// The view a typed wish shows for a piece it found is a reference to that
// piece's `[UI]`, and the sealed cell in it is read where the view renders.
// Mounted under a ceiling, that read is refused and the sealed value never
// reaches the emitted operations; mounted with no ceiling, it does, which is
// what makes the search of the operations a search for a leak.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

Deno.test("worker reconciler CFC ceiling over the view a wish shows", async (t) => {
  const owner = await Identity.fromPassphrase("wish view ceiling owner");
  const patternSpace = (await Identity.fromPassphrase(
    "wish view ceiling pattern space",
  )).did();
  const profileSpace = (await Identity.fromPassphrase(
    "wish view ceiling profile space",
  )).did();
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const SECRET = "sealed-sheet-marker";

  // A module policy with no exchange rules: nothing releases what it seals.
  const seal = buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity: "sha256:wish-view-ceiling",
    symbol: "sealSheet",
    template: {
      templateVersion: 1,
      exchangeRules: [],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });
  runtime.registerCfcPolicyManifests(undefined, [seal]);
  const { pattern, lift, wish } = createTrustedBuilder(runtime).commonfabric;

  // The schema a typed wish for a piece asks with.
  const pieceSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      [UI]: { $ref: "#/$defs/VNode" },
    },
    $defs: vnodeSchema.$defs,
  } as const satisfies JSONSchema;

  const vnode = (name: string, children: unknown[]) => ({
    type: "vnode",
    name,
    props: {},
    children,
  });

  /** Mounts `tree`, settles, and returns what was emitted and the unmount. */
  const mount = async (
    tree: WorkerVNode | Cell<unknown>,
    options: Partial<WorkerReconcilerOptions> = {},
  ) => {
    const ops: VDomOp[] = [];
    const cancel = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      ...options,
    }).mount(tree);
    await t.settle();
    return { emitted: () => JSON.stringify(ops), cancel };
  };

  /** Runs `piecePattern` as a piece in the pattern space, and settles it. */
  const runInPatternSpace = async <R>(
    piecePattern: Parameters<typeof runtime.run<unknown, R>>[1],
    argument: unknown,
    cause: string,
  ): Promise<Cell<R>> => {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<R>(patternSpace, cause, undefined, tx);
    const piece = runtime.run(tx, piecePattern, argument, resultCell);
    expect((await tx.commit()).error).toBeUndefined();
    await piece.pull();
    await t.settle();
    return piece.withTx(undefined);
  };

  try {
    // The sealed cell, and a view document that holds it.
    const seedTx = runtime.edit();
    const sealed = runtime.getCell<string>(
      profileSpace,
      "sealed-sheet",
      undefined,
      seedTx,
    );
    writeSeedEnvelopeDoc(seedTx, profileSpace);
    seedStoredEnvelope(seedTx, {
      space: profileSpace,
      scope: "space",
      id: sealed.getAsNormalizedFullLink().id,
      path: [],
    }, {
      value: SECRET,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: [cfcAtom.modulePolicyRef(
                seal.manifest.moduleIdentity,
                seal.manifest.symbol,
                seal.policyDigest,
                profileSpace,
              )],
            },
          }],
        },
      },
    });
    expect((await seedTx.commit()).error).toBeUndefined();

    // A piece whose `[UI]` slot links to a view document holding the sealed
    // cell inside a render boundary.
    const pieceTx = runtime.edit();
    const linkedView = runtime.getCell(
      profileSpace,
      "linked-view",
      undefined,
      pieceTx,
    );
    linkedView.set(
      vnode("cf-cfc-render-boundary", [vnode("div", [sealed])]),
    );
    const linkedPiece = runtime.getCell(
      profileSpace,
      "linked-piece",
      undefined,
      pieceTx,
    );
    linkedPiece.set({ title: "Linked", [UI]: linkedView });
    expect((await pieceTx.commit()).error).toBeUndefined();

    // A piece whose view a computation builds from the sealed cell.
    const viewOf = lift((sheet: string) => vnode("div", [sheet]));
    const computedPiece = await runInPatternSpace(
      pattern<{ sheet: string }>(({ sheet }) => ({
        title: "Computed",
        [UI]: viewOf(sheet),
      })),
      { sheet: sealed },
      "computed-piece",
    );

    // Both pinned in the owner's default profile.
    const profileTx = runtime.edit();
    const profile = runtime.getCell(
      profileSpace,
      "profile",
      undefined,
      profileTx,
    );
    profile.set({
      name: "Ada",
      initialNameApplied: "Ada",
      avatar: "",
      elements: [
        { cell: linkedPiece, tag: "#linked", userTags: [], title: "linked" },
        {
          cell: computedPiece,
          tag: "#computed",
          userTags: [],
          title: "computed",
        },
      ],
    });
    expect((await profileTx.commit()).error).toBeUndefined();
    const homeTx = runtime.edit();
    const homeDefault = runtime.getCell(
      owner.did(),
      "home-default",
      undefined,
      homeTx,
    );
    homeDefault.key("profiles").set([profile]);
    runtime.getHomeSpaceCell(homeTx).key("defaultPattern").set(
      homeDefault,
    );
    expect((await homeTx.commit()).error).toBeUndefined();

    const finder = await runInPatternSpace<Record<string, unknown>>(
      pattern(() => ({
        linked: wish({ query: "#linked", scope: ["profile"] }, pieceSchema),
        computed: wish({ query: "#computed", scope: ["profile"] }, pieceSchema),
      })),
      {},
      "finder",
    );

    for (const key of ["linked", "computed"]) {
      const shown = finder.key(key).key(UI).asSchema(rendererVDOMSchema);

      await t.step(
        `renders the sealed value of the ${key} view with no ceiling`,
        async () => {
          const page = await mount(shown);
          try {
            expect(page.emitted()).toContain(SECRET);
          } finally {
            page.cancel();
          }
        },
      );

      await t.step(
        `keeps the sealed value of the ${key} view out of the page under the host ceiling`,
        async () => {
          const page = await mount(shown, {
            renderConfidentialityCeiling: { atoms: [] },
          });
          try {
            expect(page.emitted()).not.toContain(SECRET);
          } finally {
            page.cancel();
          }
        },
      );

      await t.step(
        `keeps the sealed value of the ${key} view out of the page inside a boundary admitting nothing`,
        async () => {
          const page = await mount({
            type: "vnode",
            name: "cf-cfc-render-boundary",
            props: { maxConfidentiality: [] },
            children: [shown],
          });
          try {
            expect(page.emitted()).not.toContain(SECRET);
          } finally {
            page.cancel();
          }
        },
      );
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
