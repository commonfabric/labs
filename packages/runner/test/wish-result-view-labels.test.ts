/**
 * The labels a wish result carries when the piece it finds has a view that
 * holds a sealed cell. A wish result is a reference to the piece it found, and
 * its `[UI]` is a reference to that piece's view (CFC spec §8.2). Producing
 * either reads nothing inside the view, so nothing labeled inside it reaches
 * the wish state's flow labels, which every value read through the wish result
 * consumes. A read that does go inside the view still consumes what it finds
 * there.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { UI } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import { createRenderConfidentialityResolver } from "../src/cfc/render-ceiling.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { vnodeSchema } from "../src/schemas.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const owner = await Identity.fromPassphrase("wish-result-view-labels owner");
const patternSpace = await Identity.fromPassphrase(
  "wish-result-view-labels pattern space",
);
const profileSpace = (await Identity.fromPassphrase(
  "wish-result-view-labels profile space",
)).did();

// A module policy with no exchange rules: nothing releases a value it seals,
// so the owner's display ceiling refuses one.
const SEAL = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:wish-result-view-labels",
  symbol: "sealSheet",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const sealedClause = cfcAtom.modulePolicyRef(
  SEAL.manifest.moduleIdentity,
  SEAL.manifest.symbol,
  SEAL.policyDigest,
  profileSpace,
);

// The schema a typed wish for a piece asks with: the piece's view among its
// fields.
const pieceSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    [UI]: { $ref: "#/$defs/VNode" },
  },
  $defs: vnodeSchema.$defs,
} as const satisfies JSONSchema;

/** A view node, as a piece's result document stores one. */
const vnode = (name: string, children: unknown[]) => ({
  type: "vnode",
  name,
  props: {},
  children,
});

describe("wish-result-view-labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];
  let sealed: Cell<unknown>;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: owner });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    runtime.registerCfcPolicyManifests(undefined, [SEAL]);
    builder = createTrustedBuilder(runtime).commonfabric;

    // The sealed cell: a document in the profile space whose stored label
    // carries the policy clause at its root.
    const tx = runtime.edit();
    sealed = runtime.getCell(profileSpace, "sealed-sheet", undefined, tx);
    writeSeedEnvelopeDoc(tx, profileSpace);
    seedStoredEnvelope(tx, {
      space: profileSpace,
      scope: "space",
      id: sealed.getAsNormalizedFullLink().id,
      path: [],
    }, {
      value: { secret: "sealed content" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [sealedClause] } }],
        },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    sealed = sealed.withTx(undefined);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Pins `piece` in the owner's default profile under `tag`. */
  const pin = async (piece: Cell<unknown>, tag: string) => {
    const tx = runtime.edit();
    const profile = runtime.getCell(profileSpace, "profile", undefined, tx);
    profile.set({
      name: "Ada",
      initialNameApplied: "Ada",
      avatar: "",
      elements: [{ cell: piece, tag, userTags: [], title: "pinned" }],
    });
    expect((await tx.commit()).error).toBeUndefined();
    const homeTx = runtime.edit();
    const homeDefault = runtime.getCell(
      owner.did(),
      "home-default",
      undefined,
      homeTx,
    );
    homeDefault.key("profiles").set([profile]);
    runtime.getHomeSpaceCell(homeTx).key("defaultPattern").set(homeDefault);
    expect((await homeTx.commit()).error).toBeUndefined();
  };

  /** A piece whose view holds a render boundary over the sealed cell. */
  const pieceShowingSealedCell = async (): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const piece = runtime.getCell(profileSpace, "sheet-piece", undefined, tx);
    piece.set({
      title: "Sheet",
      [UI]: vnode("cf-cfc-render-boundary", [vnode("div", [sealed])]),
    });
    expect((await tx.commit()).error).toBeUndefined();
    return piece.withTx(undefined);
  };

  /** Runs a pattern whose `found` is a typed wish for `tag`, and settles it. */
  const runWish = async (tag: string, cause: string) => {
    const { pattern, wish } = builder;
    const finder = pattern(() => ({
      found: wish({ query: tag, scope: ["profile"] }, pieceSchema),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      patternSpace.did(),
      cause,
      undefined,
      tx,
    );
    const result = runtime.run(tx, finder, {}, resultCell);
    expect((await tx.commit()).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
    return result.withTx(undefined);
  };

  /** Where the wish behind `result.found` keeps its state. */
  const wishStateLink = (result: Cell<Record<string, unknown>>) =>
    result.key("found").resolveAsCell().getAsNormalizedFullLink();

  /** Every confidentiality clause in the stored label map `link` reaches. */
  const storedClauses = (link: NormalizedFullLink): unknown[] =>
    (readStoredCfcMetadata(runtime.readTx(), link)?.labelMap.entries ?? [])
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /** What `read` returns, and the confidentiality it consumed doing so. */
  const consumedBy = (
    read: (tx: IExtendedStorageTransaction) => unknown,
  ): { value: unknown; confidentiality: readonly CfcConfClause[] } => {
    const tx = runtime.edit();
    try {
      const value = read(tx);
      return {
        value,
        confidentiality: collectConsumedLabel(tx).confidentiality,
      };
    } finally {
      tx.abort();
    }
  };

  /** The clauses the owner's default display ceiling refuses. */
  const refusedForOwner = (confidentiality: readonly CfcConfClause[]) =>
    atomsOutsideCeiling(
      createRenderConfidentialityResolver({
        actingPrincipal: owner.did(),
        memberSpaces: [owner.did()],
      })({ confidentiality }),
      [cfcAtom.user(owner.did()), cfcAtom.personalSpace(owner.did())],
    );

  /** Whether `clauses` hold the policy clause, in any spelling of its subject. */
  const holdsSealedClause = (clauses: readonly unknown[]): boolean =>
    JSON.stringify(clauses).includes(SEAL.policyDigest);

  it("stamps no clause from inside the found piece's view onto the wish state", async () => {
    const piece = await pieceShowingSealedCell();
    await pin(piece, "#sheet");

    const result = await runWish("#sheet", "finder");
    const state = wishStateLink(result);

    // The wish resolved, and its state holds references to the piece and to
    // the piece's view.
    const stored = runtime.readTx().readValueOrThrow({ ...state, path: [] });
    const pieceLink = piece.getAsNormalizedFullLink();
    expect(JSON.stringify(stored)).toContain(pieceLink.id);
    expect(result.key("found").key("result").key("title").get()).toBe("Sheet");
    // The clause is there to be stamped: the sealed cell's own label holds it.
    expect(holdsSealedClause(storedClauses(sealed.getAsNormalizedFullLink())))
      .toBe(true);
    expect(holdsSealedClause(storedClauses(state))).toBe(false);
  });

  it("returns a value read through the wish result that the owner's display ceiling admits", async () => {
    const piece = await pieceShowingSealedCell();
    await pin(piece, "#sheet");

    const result = await runWish("#sheet", "finder");
    const title = consumedBy((tx) =>
      result.withTx(tx).key("found").key("result").key("title").get()
    );

    expect(title.value).toBe("Sheet");
    expect(holdsSealedClause(title.confidentiality)).toBe(false);
    expect(refusedForOwner(title.confidentiality)).toEqual([]);
  });

  it("consumes the sealed clause when the sealed cell is read through the wish result", async () => {
    const piece = await pieceShowingSealedCell();
    await pin(piece, "#sheet");

    const result = await runWish("#sheet", "finder");
    const found = (tx: IExtendedStorageTransaction) =>
      result.withTx(tx).key("found");
    // The sealed cell sits inside the boundary's `div`, both in the found
    // piece's view and in the view the wish shows for it.
    const sealedThrough = (
      view: (tx: IExtendedStorageTransaction) => Cell<unknown>,
    ) =>
      consumedBy((tx) =>
        view(tx).key("children").key(0).key("children").key(0).key("secret")
          .get()
      );
    const viaResult = sealedThrough((tx) => found(tx).key("result").key(UI));
    const viaWishView = sealedThrough((tx) => found(tx).key(UI));

    for (const read of [viaResult, viaWishView]) {
      expect(read.value).toBe("sealed content");
      expect(holdsSealedClause(read.confidentiality)).toBe(true);
      expect(holdsSealedClause(refusedForOwner(read.confidentiality)))
        .toBe(true);
    }
  });

  it("leaves a new piece clean when the piece its wish finds shows sealed-derived values", async () => {
    // The stamped piece: its view shows a value derived from the sealed cell,
    // so the document holding that value carries the clause, as a view does
    // whose values are derived from a stamped wish result.
    const { pattern, lift, h } = builder;
    const lengthOf = lift((sheet: { secret: string }) => sheet.secret.length);
    const stampedPattern = pattern<{ sheet: { secret: string } }>(
      ({ sheet }) => {
        const size = lengthOf(sheet);
        return { title: "Stamped", size, [UI]: h("div", {}, size) };
      },
    );
    const tx = runtime.edit();
    const stampedCell = runtime.getCell<Record<string, unknown>>(
      patternSpace.did(),
      "stamped-piece",
      undefined,
      tx,
    );
    const stamped = runtime.run(
      tx,
      stampedPattern,
      { sheet: sealed },
      stampedCell,
    );
    expect((await tx.commit()).error).toBeUndefined();
    await stamped.pull();
    await runtime.idle();
    const sizeLink = stamped.key("size").resolveAsCell()
      .getAsNormalizedFullLink();
    expect(holdsSealedClause(storedClauses(sizeLink))).toBe(true);
    await pin(stamped.withTx(undefined), "#pane");

    const fresh = await runWish("#pane", "fresh-finder");
    const title = consumedBy((tx) =>
      fresh.withTx(tx).key("found").key("result").key("title").get()
    );

    expect(title.value).toBe("Stamped");
    expect(holdsSealedClause(storedClauses(wishStateLink(fresh)))).toBe(false);
    expect(refusedForOwner(title.confidentiality)).toEqual([]);
  });
});
