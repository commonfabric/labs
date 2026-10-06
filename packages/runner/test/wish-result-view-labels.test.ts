/**
 * The labels a wish result carries when the piece it finds has a view that
 * holds a sealed cell. A wish result is a reference to the piece it found, and
 * the view the wish shows is a reference to the `[UI]` slot of that piece (CFC
 * spec §8.2). Choosing that view reads what the slot holds and nothing behind
 * it, so a label inside the view stays off the wish state, whose labels every
 * read through the wish result consumes. A read that goes inside the view
 * still consumes what it finds there.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import {
  type JSONSchema,
  NAME,
  type Pattern,
  UI,
} from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { type CfcConfClause, clauseAlternatives } from "../src/cfc/clause.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import { createRenderConfidentialityResolver } from "../src/cfc/render-ceiling.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { vnodeSchema } from "../src/schemas.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const owner = await Identity.fromPassphrase("wish-result-view-labels owner");
const patternSpace = (await Identity.fromPassphrase(
  "wish-result-view-labels pattern space",
)).did();
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

// The two spellings the clause takes: its subject in the clear in the profile
// space, and committed to a digest once a label in another space carries it.
const sealedSpellings = [
  sealedClause,
  cfcAtom.modulePolicyRef(
    SEAL.manifest.moduleIdentity,
    SEAL.manifest.symbol,
    SEAL.policyDigest,
    commitCfcFieldValue(profileSpace),
  ),
];

/** Whether one of `clauses` names the sealing policy, alone or as an option. */
const holdsSealedClause = (clauses: readonly CfcConfClause[]): boolean =>
  clauses.some((clause) =>
    clauseAlternatives(clause).some((atom) =>
      sealedSpellings.some((spelling) => deepEqual(atom, spelling))
    )
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

/** A stored view node with no children. */
const emptyView = { type: "vnode", name: "div", props: {}, children: [] };

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
    sealed = await seeded(profileSpace, "sealed-sheet", {
      secret: "sealed content",
    }, [{ path: [], label: { confidentiality: [sealedClause] } }]);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A document in `space`, stored with `entries` as its labels. */
  const seeded = async (
    space: typeof profileSpace,
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const document = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space,
      scope: "space",
      id: document.getAsNormalizedFullLink().id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    return document.withTx(undefined);
  };

  /**
   * A document in `space` holding `value` as the runtime writes it, so any
   * cell in it is stored as a reference the runtime made.
   */
  const written = async (
    space: typeof profileSpace,
    cause: string,
    value: Record<string, unknown>,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const document = runtime.getCell(space, cause, undefined, tx);
    document.set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    return document.withTx(undefined);
  };

  /**
   * Sets the covering label at `path` of the document `address` names to
   * `confidentiality`, or removes it when that is undefined, keeping the
   * document's value and the rest of its stored labels as they are.
   */
  const labelPath = async (
    address: Pick<NormalizedFullLink, "space" | "scope" | "id">,
    path: string[],
    confidentiality?: CfcConfClause[],
  ) => {
    const tx = runtime.edit();
    const stored = readStoredCfcMetadata(tx, address);
    const kept = (stored?.labelMap.entries ?? []).filter((entry) =>
      entry.origin !== undefined || !deepEqual(entry.path, path)
    );
    if (stored === undefined) writeSeedEnvelopeDoc(tx, address.space);
    seedStoredEnvelope(tx, {
      space: address.space,
      scope: address.scope,
      id: address.id,
      path: ["cfc"],
    }, {
      version: stored?.version ?? 1,
      schemaHash: stored?.schemaHash ?? SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: confidentiality === undefined
          ? kept
          : [...kept, { path, label: { confidentiality } }],
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** Runs `piecePattern` on `argument` in the pattern space, and settles it. */
  const runPiece = async (
    piecePattern: Pattern,
    argument: unknown,
    cause: string,
  ): Promise<Cell<Record<string, unknown>>> => {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      patternSpace,
      cause,
      undefined,
      tx,
    );
    const piece = runtime.run(tx, piecePattern, argument, resultCell);
    expect((await tx.commit().settled).error).toBeUndefined();
    await piece.pull();
    await runtime.idle();
    return piece.withTx(undefined);
  };

  /** Pins `pieces` in the owner's default profile, each under `tag`. */
  const pinAll = async (pieces: Cell<unknown>[], tag: string) => {
    const tx = runtime.edit();
    const profile = runtime.getCell(profileSpace, "profile", undefined, tx);
    profile.set({
      name: "Ada",
      initialNameApplied: "Ada",
      avatar: "",
      elements: pieces.map((cell) => ({
        cell,
        tag,
        userTags: [],
        title: "pinned",
      })),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    const homeTx = runtime.edit();
    const homeDefault = runtime.getCell(
      owner.did(),
      "home-default",
      undefined,
      homeTx,
    );
    homeDefault.key("profiles").set([profile]);
    runtime.getHomeSpaceCell(homeTx).key("defaultPattern").set(homeDefault);
    expect((await homeTx.commit().settled).error).toBeUndefined();
  };

  /** Pins `piece` in the owner's default profile under `tag`. */
  const pin = (piece: Cell<unknown>, tag: string) => pinAll([piece], tag);

  /** Lists `piece` among the mentionables of the pattern space. */
  const mention = async (piece: Cell<unknown>) => {
    const tx = runtime.edit();
    const backlinks = runtime.getCell(patternSpace, "backlinks", undefined, tx);
    backlinks.set({ mentionable: [piece] });
    const defaultPattern = runtime.getCell(
      patternSpace,
      "default-pattern",
      undefined,
      tx,
    );
    defaultPattern.set({ backlinksIndex: backlinks });
    runtime.getCell(patternSpace, patternSpace, undefined, tx)
      .key("defaultPattern").set(defaultPattern);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** A piece whose view holds a render boundary over the sealed cell. */
  const pieceShowingSealedCell = async (): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const piece = runtime.getCell(profileSpace, "sheet-piece", undefined, tx);
    piece.set({
      title: "Sheet",
      [UI]: vnode("cf-cfc-render-boundary", [vnode("div", [sealed])]),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    return piece.withTx(undefined);
  };

  /** A pattern whose `found` is a typed wish for `tag` in the profile. */
  const finderFor = (tag: string) =>
    builder.pattern(() => ({
      found: builder.wish({ query: tag, scope: ["profile"] }, pieceSchema),
    }));

  /** Runs a typed wish for `tag` in the profile, and settles it. */
  const runWish = (tag: string, cause: string) =>
    runPiece(finderFor(tag), {}, cause);

  /**
   * Runs a typed headless wish for `tag` among the pattern space's
   * mentionables, which resolves through the state the space shares for that
   * query, and settles it.
   */
  const runSharedWish = (tag: string, cause: string) =>
    runPiece(
      builder.pattern(() => ({
        found: builder.wish(
          { query: tag, scope: ["."], headless: true },
          pieceSchema,
        ),
      })),
      {},
      cause,
    );

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

  /** Where the wish behind `result.found` keeps its state. */
  const wishState = (result: Cell<unknown>): NormalizedFullLink =>
    result.key("found").resolveAsCell().getAsNormalizedFullLink();

  /**
   * What observing the wish state's shape consumes: the labels a reader of
   * which fields the state holds is given.
   */
  const stateShape = (result: Cell<unknown>) => {
    const state = wishState(result);
    return consumedBy((tx) =>
      tx.readValueOrThrow({ ...state, path: [] }, { nonRecursive: true })
    ).confidentiality;
  };

  /** The title of the piece the wish found, read through the wish result. */
  const titleThrough = (result: Cell<unknown>) =>
    consumedBy((tx) =>
      result.withTx(tx).key("found").key("result").key("title").get()
    );

  /** The clauses the owner's default display ceiling refuses. */
  const refusedForOwner = (confidentiality: readonly CfcConfClause[]) =>
    atomsOutsideCeiling(
      createRenderConfidentialityResolver({
        actingPrincipal: owner.did(),
        memberSpaces: [owner.did()],
      })({ confidentiality }),
      [cfcAtom.user(owner.did()), cfcAtom.personalSpace(owner.did())],
    );

  /** What reading the value `cell` resolves to, whole, consumes. */
  const consumedReading = (cell: Cell<unknown>) =>
    consumedBy((tx) => cell.withTx(tx).getRaw({ lastNode: "value" }))
      .confidentiality;

  /** The view the wish shows: the place it resolves to, and its node's name. */
  const shownView = (result: Cell<unknown>) => {
    const view = result.key("found").key(UI);
    const { id, path } = view.resolveAsCell().getAsNormalizedFullLink();
    return { id, path, name: view.key("name").get() };
  };

  describe("labels", () => {
    it("leaves the sealed clause off the wish state when the found piece's view holds the sealed cell", async () => {
      const piece = await pieceShowingSealedCell();
      await pin(piece, "#sheet");

      const result = await runWish("#sheet", "finder");

      expect(shownView(result)).toEqual({
        id: piece.getAsNormalizedFullLink().id,
        path: [UI],
        name: "cf-cfc-render-boundary",
      });
      expect(holdsSealedClause(consumedReading(sealed))).toBe(true);
      expect(holdsSealedClause(stateShape(result))).toBe(false);
    });

    it("leaves the sealed clause off a title read through the wish result when the found piece renders a sealed argument raw", async () => {
      const sheetView = builder.pattern<{ sheet: { secret: string } }>((
        { sheet },
      ) => ({
        title: "Sheet view",
        [UI]: vnode("cf-cfc-render-boundary", [vnode("div", [sheet])]),
      }));
      const piece = await runPiece(sheetView, { sheet: sealed }, "sheet-view");
      await pin(piece, "#sheetview");

      const result = await runWish("#sheetview", "sheet-view-finder");
      const title = titleThrough(result);

      expect(title.value).toBe("Sheet view");
      expect(holdsSealedClause(title.confidentiality)).toBe(false);
      expect(refusedForOwner(title.confidentiality)).toEqual([]);
    });

    it("leaves the sealed clause off the wish state when the found piece's view is computed from the sealed cell", async () => {
      // The view lives in a document of its own that a computation wrote
      // after reading the sealed cell, so that document's labels carry the
      // clause, and the piece's `[UI]` slot holds a link to it.
      const viewOf = builder.lift((sheet: { secret: string }) =>
        vnode("div", [sheet.secret.length])
      );
      const computedView = builder.pattern<{ sheet: { secret: string } }>((
        { sheet },
      ) => ({ title: "Computed view", [UI]: viewOf(sheet) }));
      const piece = await runPiece(
        computedView,
        { sheet: sealed },
        "computed-view",
      );
      expect(holdsSealedClause(consumedReading(piece.key(UI)))).toBe(true);
      await pin(piece, "#computedview");

      const result = await runWish("#computedview", "computed-view-finder");
      const title = titleThrough(result);

      expect(title.value).toBe("Computed view");
      expect(holdsSealedClause(title.confidentiality)).toBe(false);
      expect(holdsSealedClause(stateShape(result))).toBe(false);
    });

    it("leaves the sealed clause off the wish state when the found piece holds a sealed value inline in its view", async () => {
      // The clause sits inside the view, in the piece's own document. The
      // wish reads what the `[UI]` slot holds and the view node's `type`, and
      // nothing inside the view.
      const piece = await seeded(profileSpace, "inline-piece", {
        title: "Inline",
        [UI]: {
          type: "vnode",
          name: "div",
          props: {},
          children: ["sealed inline"],
        },
      }, [{
        path: [UI, "children", "0"],
        label: { confidentiality: [sealedClause] },
      }]);
      await pin(piece, "#inline");

      const result = await runWish("#inline", "inline-finder");

      expect(shownView(result).name).toBe("div");
      expect(holdsSealedClause(consumedReading(piece.key(UI)))).toBe(true);
      expect(holdsSealedClause(stateShape(result))).toBe(false);
    });

    it("holds a label covering the found piece's `[UI]` slot on the wish state", async () => {
      // Which view the wish shows depends on what that slot holds, so the
      // label covering the slot is one the wish state carries. The slot holds
      // a link, which the wish does not follow.
      const viewDoc = await seeded(profileSpace, "slot-view", emptyView, []);
      const piece = await written(profileSpace, "slot-piece", {
        title: "Slot",
        [UI]: viewDoc,
      });
      await labelPath(piece.getAsNormalizedFullLink(), [UI], [sealedClause]);
      await pin(piece, "#slot");

      const result = await runWish("#slot", "slot-finder");

      expect(holdsSealedClause(stateShape(result))).toBe(true);
    });

    it("holds a label covering the first found piece's `[UI]` slot on the wish state when several match", async () => {
      // With several matches and no picker surface open yet, the wish shows
      // the first match's view while the surface opens, and decides that view
      // in its own transaction as it does for a single match.
      const viewDoc = await seeded(profileSpace, "multi-view", emptyView, []);
      const pieces: Cell<unknown>[] = [];
      for (const cause of ["multi-first", "multi-second"]) {
        const piece = await written(profileSpace, cause, {
          title: cause,
          [UI]: viewDoc,
        });
        await labelPath(piece.getAsNormalizedFullLink(), [UI], [sealedClause]);
        pieces.push(piece);
      }
      await pinAll(pieces, "#multi");

      const result = await runWish("#multi", "multi-finder");

      expect(titleThrough(result).value).toBe("multi-first");
      expect(holdsSealedClause(stateShape(result))).toBe(true);
    });

    it("holds a label on the found piece's view node `type` on the wish state", async () => {
      // Whether an inline value counts as a view is read from its `type`.
      const piece = await seeded(profileSpace, "type-piece", {
        title: "Type",
        [UI]: emptyView,
      }, [{ path: [UI, "type"], label: { confidentiality: [sealedClause] } }]);
      await pin(piece, "#type");

      const result = await runWish("#type", "type-finder");

      expect(shownView(result).name).toBe("div");
      expect(holdsSealedClause(stateShape(result))).toBe(true);
    });

    it("returns a value read through the wish result that the owner's display ceiling admits", async () => {
      const piece = await pieceShowingSealedCell();
      await pin(piece, "#sheet");

      const result = await runWish("#sheet", "finder");
      const title = titleThrough(result);

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
      // The stamped piece: its view shows a value derived from the sealed
      // cell, so the document holding that value carries the clause, as a
      // view does whose values are derived from a stamped wish result.
      const lengthOf = builder.lift((sheet: { secret: string }) =>
        sheet.secret.length
      );
      const stampedPattern = builder.pattern<{ sheet: { secret: string } }>(
        ({ sheet }) => {
          const size = lengthOf(sheet);
          return { title: "Stamped", size, [UI]: builder.h("div", {}, size) };
        },
      );
      const stamped = await runPiece(
        stampedPattern,
        { sheet: sealed },
        "stamped-piece",
      );
      expect(holdsSealedClause(consumedReading(stamped.key("size")))).toBe(
        true,
      );
      await pin(stamped, "#pane");

      const fresh = await runWish("#pane", "fresh-finder");
      const title = titleThrough(fresh);

      expect(title.value).toBe("Stamped");
      expect(holdsSealedClause(title.confidentiality)).toBe(false);
      expect(holdsSealedClause(stateShape(fresh))).toBe(false);
    });

    it("re-derives a clean wish state once a stamped one is deleted", async () => {
      // A label on the found piece's `[UI]` slot stamps the wish state. Taking
      // the label off the piece leaves the stamp, since the state still
      // stands; deleting the state and running the wish again writes it
      // afresh, labeled by what that run reads.
      const viewDoc = await seeded(profileSpace, "healed-view", emptyView, []);
      const piece = await written(profileSpace, "healed-piece", {
        title: "Healed",
        [UI]: viewDoc,
      });
      const pieceLink = piece.getAsNormalizedFullLink();
      await pin(piece, "#healed");
      await labelPath(pieceLink, [UI], [sealedClause]);
      const finder = finderFor("#healed");
      const tx = runtime.edit();
      const resultCell = runtime.getCell<Record<string, unknown>>(
        patternSpace,
        "healed-finder",
        undefined,
        tx,
      );
      const running = runtime.run(tx, finder, {}, resultCell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await runtime.idle();
      const result = running.withTx(undefined);
      const state = wishState(result);
      await labelPath(pieceLink, [UI]);
      await runtime.idle();
      expect(holdsSealedClause(titleThrough(result).confidentiality)).toBe(
        true,
      );

      const deleteTx = runtime.edit();
      seedStoredEnvelope(deleteTx, {
        space: state.space,
        scope: state.scope,
        id: state.id,
        path: [],
      }, undefined);
      expect((await deleteTx.commit().settled).error).toBeUndefined();
      runtime.runner.stop(running);
      const rerunTx = runtime.edit();
      const rerun = runtime.run(rerunTx, finder, {}, resultCell);
      expect((await rerunTx.commit().settled).error).toBeUndefined();
      await rerun.pull();
      await runtime.idle();
      const healed = rerun.withTx(undefined);
      const title = titleThrough(healed);

      expect(wishState(healed).id).toBe(state.id);
      expect(title.value).toBe("Healed");
      expect(holdsSealedClause(title.confidentiality)).toBe(false);
      expect(holdsSealedClause(stateShape(healed))).toBe(false);
    });
  });

  describe("the shared state of a headless hashtag wish", () => {
    it("holds a label covering the found piece's `[UI]` slot on the shared state", async () => {
      // The resolver the space shares for the query writes the state, so its
      // own transaction is the one that reads the slot.
      const viewDoc = await seeded(patternSpace, "slot-view", emptyView, []);
      const piece = await written(patternSpace, "shared-slot-piece", {
        [NAME]: "sharedslot",
        title: "Shared slot",
        [UI]: viewDoc,
      });
      await labelPath(piece.getAsNormalizedFullLink(), [UI], [{
        anyOf: [sealedClause, cfcAtom.space(patternSpace)],
      }]);
      await mention(piece);

      const result = await runSharedWish("#sharedslot", "shared-slot-finder");

      expect(shownView(result).id).toBe(viewDoc.getAsNormalizedFullLink().id);
      expect(holdsSealedClause(stateShape(result))).toBe(true);
    });

    it("shows a `cf-cell-link` to the found piece when its `[UI]` holds no view node", async () => {
      const notViews: Array<[string, FabricValue]> = [
        ["text", "text"],
        ["number", 7],
        ["object", { foo: 1 }],
        ["array", []],
      ];
      for (const [kind, held] of notViews) {
        const tx = runtime.edit();
        const piece = runtime.getCell(
          patternSpace,
          `shared-${kind}`,
          undefined,
          tx,
        );
        piece.set({ [NAME]: `shared${kind}`, title: kind, [UI]: held });
        expect((await tx.commit().settled).error).toBeUndefined();
        await mention(piece.withTx(undefined));

        const result = await runSharedWish(`#shared${kind}`, `${kind}-shared`);

        expect({ kind, name: shownView(result).name }).toEqual({
          kind,
          name: "cf-cell-link",
        });
      }
    });
  });

  describe("the view the wish shows", () => {
    it("links to the found piece's `[UI]` slot when the slot links to a view not written yet", async () => {
      const pending = runtime.getCell(profileSpace, "pending-view");
      const piece = await written(profileSpace, "pending-piece", {
        title: "Pending",
        [UI]: pending,
      });
      await pin(piece, "#pending");

      const result = await runWish("#pending", "pending-finder");

      expect(shownView(result)).toEqual({
        id: pending.getAsNormalizedFullLink().id,
        path: [],
        name: undefined,
      });
    });

    it("shows the found piece's sub-pattern when its `[UI]` is one", async () => {
      const picker = builder.pattern(() => ({
        title: "Picker",
        [UI]: builder.h("div", {}, "picker"),
      }));
      const outer = builder.pattern(() => ({
        title: "Outer",
        [UI]: picker({}),
      }));
      const piece = await runPiece(outer, {}, "outer-piece");
      await pin(piece, "#outer");

      const result = await runWish("#outer", "outer-finder");
      const view = result.key("found").key(UI);

      expect(view.key("title").get()).toBe("Picker");
      expect(view.key(UI).key("name").get()).toBe("div");
    });

    it("shows a `cf-cell-link` to the found piece when its `[UI]` holds no view node", async () => {
      const notViews: Array<[string, FabricValue | undefined]> = [
        ["absent", undefined],
        ["text", "text"],
        ["number", 7],
        ["null", null],
        ["object", { foo: 1 }],
        ["array", []],
      ];
      for (const [kind, held] of notViews) {
        const piece = await seeded(
          profileSpace,
          `not-a-view-${kind}`,
          held === undefined ? { title: kind } : { title: kind, [UI]: held },
          [],
        );
        await pin(piece, `#notaview${kind}`);

        const result = await runWish(`#notaview${kind}`, `${kind}-finder`);

        expect({ kind, name: shownView(result).name }).toEqual({
          kind,
          name: "cf-cell-link",
        });
      }
    });
  });
});
