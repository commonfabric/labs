/**
 * The labels a wish result carries when the piece it finds has a view that
 * holds a sealed cell. A wish result is a reference to the piece it found, and
 * the view the wish shows is a reference to the `[UI]` slot of that piece (CFC
 * spec §8.2). Choosing that view reads the slot and nothing behind it, so a
 * label inside the view stays off the flow stamps of the wish state, which
 * reads through the wish result consume. A read that goes inside the view
 * still consumes what it finds there.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { FabricValue } from "@commonfabric/data-model";
import type { JSONSchema, PatternFactory } from "../src/builder/types.ts";
import { UI } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { type CfcConfClause, clauseAlternatives } from "../src/cfc/clause.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import { createRenderConfidentialityResolver } from "../src/cfc/render-ceiling.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import {
  createSigilLinkFromParsedLink,
  isPrimitiveCellLink,
  type NormalizedFullLink,
  parseLink,
} from "../src/link-utils.ts";
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

// The two spellings the clause is stored in: its subject in the clear in the
// profile space, and committed to a digest once it is stamped in another.
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
    sealed = await seededPiece("sealed-sheet", { secret: "sealed content" }, [
      { path: [], label: { confidentiality: [sealedClause] } },
    ]);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A document in the profile space, stored with `entries` as its labels. */
  const seededPiece = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const piece = runtime.getCell(profileSpace, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, profileSpace);
    seedStoredEnvelope(tx, {
      space: profileSpace,
      scope: "space",
      id: piece.getAsNormalizedFullLink().id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return piece.withTx(undefined);
  };

  /** Runs `piecePattern` on the sealed cell as its `sheet`, and settles it. */
  const runPiece = async <R>(
    piecePattern: PatternFactory<{ sheet: { secret: string } }, R>,
    cause: string,
  ): Promise<Cell<R>> => {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<R>(
      patternSpace.did(),
      cause,
      undefined,
      tx,
    );
    const piece = runtime.run(tx, piecePattern, { sheet: sealed }, resultCell);
    expect((await tx.commit()).error).toBeUndefined();
    await piece.pull();
    await runtime.idle();
    return piece.withTx(undefined);
  };

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

  /** The stored label-map entries of the document `link` names. */
  const storedEntries = (link: NormalizedFullLink): LabelMapEntry[] =>
    readStoredCfcMetadata(runtime.readTx(), link)?.labelMap.entries ?? [];

  /** Every confidentiality clause in the stored label map `link` reaches. */
  const storedClauses = (link: NormalizedFullLink): CfcConfClause[] =>
    storedEntries(link).flatMap((entry) => entry.label.confidentiality ?? []);

  /**
   * The confidentiality clauses of the flow stamps in the stored label map
   * `link` reaches: what the reads of the transactions that wrote it left.
   */
  const flowStampClauses = (link: NormalizedFullLink): CfcConfClause[] =>
    storedEntries(link)
      .filter((entry) =>
        entry.origin === "structure" || entry.origin === "derived"
      )
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

  /** The title of the piece the wish found, read through the wish result. */
  const titleThrough = (result: Cell<Record<string, unknown>>) =>
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

  /**
   * What the wish state's `[UI]` holds: the place a link there names, or the
   * name of the view node held inline.
   */
  const shownView = (state: NormalizedFullLink) => {
    const tx = runtime.readTx();
    const held = tx.readValueOrThrow({ ...state, path: [UI] });
    if (isPrimitiveCellLink(held)) {
      const { id, path } = parseLink(held, state);
      return { link: { id, path } };
    }
    return { node: tx.readValueOrThrow({ ...state, path: [UI, "name"] }) };
  };

  describe("labels", () => {
    it("leaves the sealed clause off the wish state when the found piece's view holds the sealed cell", async () => {
      const piece = await pieceShowingSealedCell();
      await pin(piece, "#sheet");

      const result = await runWish("#sheet", "finder");
      const state = wishStateLink(result);

      expect(shownView(state)).toEqual({
        link: { id: piece.getAsNormalizedFullLink().id, path: [UI] },
      });
      // The clause is there to be stamped: the sealed cell's own label holds
      // it.
      expect(holdsSealedClause(storedClauses(sealed.getAsNormalizedFullLink())))
        .toBe(true);
      expect(holdsSealedClause(storedClauses(state))).toBe(false);
    });

    it("leaves the sealed clause off a title read through the wish result when the found piece renders a sealed argument raw", async () => {
      const sheetView = builder.pattern<{ sheet: { secret: string } }>((
        { sheet },
      ) => ({
        title: "Sheet view",
        [UI]: vnode("cf-cfc-render-boundary", [vnode("div", [sheet])]),
      }));
      const piece = await runPiece(sheetView, "sheet-view-piece");
      await pin(piece, "#sheetview");

      const result = await runWish("#sheetview", "sheet-view-finder");
      const title = titleThrough(result);

      expect(title.value).toBe("Sheet view");
      expect(holdsSealedClause(title.confidentiality)).toBe(false);
      expect(refusedForOwner(title.confidentiality)).toEqual([]);
    });

    it("leaves the sealed clause off the wish state when the found piece's view is computed from the sealed cell", async () => {
      // The view lives in a document of its own that a computation wrote
      // after reading the sealed cell, so that document's own labels carry
      // the clause, and the piece's `[UI]` slot holds a link to it.
      const viewOf = builder.lift((sheet: { secret: string }) =>
        vnode("div", [sheet.secret.length])
      );
      const computedView = builder.pattern<{ sheet: { secret: string } }>((
        { sheet },
      ) => ({ title: "Computed view", [UI]: viewOf(sheet) }));
      const piece = await runPiece(computedView, "computed-view-piece");
      const viewDoc = piece.key(UI).resolveAsCell().getAsNormalizedFullLink();
      expect(holdsSealedClause(storedClauses(viewDoc))).toBe(true);
      await pin(piece, "#computedview");

      const result = await runWish("#computedview", "computed-view-finder");
      const title = titleThrough(result);

      expect(title.value).toBe("Computed view");
      expect(holdsSealedClause(storedClauses(wishStateLink(result)))).toBe(
        false,
      );
      expect(refusedForOwner(title.confidentiality)).toEqual([]);
    });

    it("leaves the sealed clause off the wish state's flow stamps when the found piece holds a sealed value inline in its view", async () => {
      // The clause sits inside the view, in the piece's own document. The
      // link the wish writes to the piece carries the piece's labels along,
      // so what is asserted is the flow stamps the wish's own reads leave.
      const piece = await seededPiece("inline-piece", {
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
      const state = wishStateLink(result);

      expect(shownView(state)).toEqual({
        link: { id: piece.getAsNormalizedFullLink().id, path: [UI] },
      });
      // The state's label map is there: the links it holds carry entries.
      expect(storedClauses(state).length).toBeGreaterThan(0);
      expect(holdsSealedClause(flowStampClauses(state))).toBe(false);
    });

    it("holds a label covering the found piece's `[UI]` slot in the wish state's flow stamps", async () => {
      // Which view the wish shows depends on what that slot holds, so the
      // label covering the slot is one the wish state carries. The slot holds
      // a link, which the wish does not follow.
      const viewDoc = await seededPiece("slot-view", {
        type: "vnode",
        name: "div",
        props: {},
        children: [],
      }, []);
      const piece = await seededPiece("slot-piece", {
        title: "Slot",
        [UI]: createSigilLinkFromParsedLink(viewDoc.getAsNormalizedFullLink()),
      }, [{ path: [UI], label: { confidentiality: [sealedClause] } }]);
      await pin(piece, "#slot");

      const result = await runWish("#slot", "slot-finder");

      expect(holdsSealedClause(flowStampClauses(wishStateLink(result)))).toBe(
        true,
      );
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
      const stamped = await runPiece(stampedPattern, "stamped-piece");
      const sizeLink = stamped.key("size").resolveAsCell()
        .getAsNormalizedFullLink();
      expect(holdsSealedClause(storedClauses(sizeLink))).toBe(true);
      await pin(stamped, "#pane");

      const fresh = await runWish("#pane", "fresh-finder");
      const title = titleThrough(fresh);

      expect(title.value).toBe("Stamped");
      expect(holdsSealedClause(storedClauses(wishStateLink(fresh)))).toBe(
        false,
      );
      expect(refusedForOwner(title.confidentiality)).toEqual([]);
    });

    it.ignore("leaves the sealed clause off an `ifElse` whose condition is a typed wish result", async () => {
      // Known gap, outside the wish: `ifElse` and `when` read their condition
      // with `.get()` under the schema the wish result's link carries, which
      // describes the piece's `[UI]` as a view node, so the read traverses the
      // found piece's whole view and the selected branch's output is labeled
      // with what it found. An untyped wish result leaves the output clean.
      const piece = await pieceShowingSealedCell();
      await pin(piece, "#sheet");
      const { pattern, wish, ifElse } = builder;
      const chooser = pattern(() => {
        const found = wish(
          { query: "#sheet", scope: ["profile"] },
          pieceSchema,
        );
        return { shown: ifElse(found.result, "found", "missing") };
      });
      const tx = runtime.edit();
      const resultCell = runtime.getCell<Record<string, unknown>>(
        patternSpace.did(),
        "chooser",
        undefined,
        tx,
      );
      const result = runtime.run(tx, chooser, {}, resultCell);
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();
      await runtime.idle();
      const shown = consumedBy((tx) => result.withTx(tx).key("shown").get());

      expect(shown.value).toBe("found");
      expect(holdsSealedClause(shown.confidentiality)).toBe(false);
    });
  });

  describe("the view the wish shows", () => {
    it("links to the found piece's `[UI]` slot when the slot links to a view not written yet", async () => {
      const pending = runtime.getCell(profileSpace, "pending-view");
      const piece = await seededPiece("pending-piece", {
        title: "Pending",
        [UI]: createSigilLinkFromParsedLink(pending.getAsNormalizedFullLink()),
      }, []);
      await pin(piece, "#pending");

      const result = await runWish("#pending", "pending-finder");

      expect(shownView(wishStateLink(result))).toEqual({
        link: { id: piece.getAsNormalizedFullLink().id, path: [UI] },
      });
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
        const piece = await seededPiece(
          `not-a-view-${kind}`,
          held === undefined ? { title: kind } : { title: kind, [UI]: held },
          [],
        );
        await pin(piece, `#notaview${kind}`);

        const result = await runWish(`#notaview${kind}`, `${kind}-finder`);

        expect({ kind, ...shownView(wishStateLink(result)) }).toEqual({
          kind,
          node: "cf-cell-link",
        });
      }
    });
  });
});
