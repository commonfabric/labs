import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type CellHandle,
  type CellRef,
  isCellHandle,
  RuntimeClient,
} from "@commonfabric/runtime-client";
import { MessagePortRuntimeTransport } from "@commonfabric/runtime-client/transports/message-port";

import { RuntimeClients } from "../../../../../runtime-client/src/backends/client-registry.ts";
import type { RuntimeProcessor } from "../../../../../runtime-client/src/backends/runtime-processor.ts";
import { createCellRef } from "../../../../../runtime-client/src/backends/utils.ts";
import { RequestType } from "../../../../../runtime-client/src/protocol/mod.ts";
import { buildProcessor } from "../../../../../runtime-client/test/backends/build-processor.ts";
import { LinkTargetWatch } from "../../core/link-target-watch.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import {
  drawnCards,
  isShownEntry,
  isUnobscuredEntry,
  lookOf,
  type SuggestionCard,
  suggestionRowsSchema,
} from "./suggestion-cards.ts";

const SPACE = "did:key:list-space";

/** A handle on its own cell, standing in for a piece a card refers to. */
function piece(id: string, ref: Partial<CellRef> = {}): CellHandle {
  return createMockCellHandle<unknown>({}, {
    id: `of:${id}` as CellRef["id"],
    space: SPACE as CellRef["space"],
    ...ref,
  });
}

const here = piece("here");
const elsewhere = piece("elsewhere");

/** A row's `about`: the JSON of `links`, as intake stores it. */
function aboutOf(...links: unknown[]): string {
  return JSON.stringify(links);
}

/** A sigil link carrying `payload`. */
function link(payload: Record<string, unknown>): unknown {
  return { "/": { "link@1": payload } };
}

/** The ids of the cards drawn at `here` from `cards`. */
function drawnIds(
  cards: SuggestionCard[],
  options: { tags?: string[]; listSpace?: string } = {},
): string[] {
  return drawnCards(cards, here, options.tags, options.listSpace ?? SPACE)
    .map(({ card }) => card.id);
}

/**
 * A worker holding a ranked list whose rows link to things, and the element
 * of a `.map()` over a list of those things: a cell holding a link to `item`.
 * The client reaches both over a channel, as the page does.
 */
async function rankedListOverWorker() {
  const signer = await Identity.fromPassphrase("suggestion-cards-worker", {
    implementation: "noble",
  });
  const space = signer.did();
  const apiUrl = "http://localhost/";
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
  });
  const cause = `suggestion-cards-${crypto.randomUUID()}`;
  const item = runtime.getCell<{ title: string }>(space, `${cause}-item`);
  const other = runtime.getCell<{ title: string }>(space, `${cause}-other`);
  const ranked = runtime.getCell<unknown[]>(space, `${cause}-ranked`);
  const mapped = runtime.getCell<unknown>(space, `${cause}-mapped`);
  const tx = runtime.edit();
  item.withTx(tx).set({ title: "Water the plants" });
  other.withTx(tx).set({ title: "Call the plumber" });
  ranked.withTx(tx).set([
    { id: "anchored", anchor: item },
    { id: "shelf-only", anchor: null },
    { id: "anchored-elsewhere", anchor: other },
  ]);
  mapped.withTx(tx).set({ element: item });
  const { error } = await tx.commit().settled;
  if (error) throw new Error(`The commit failed: ${error.name}`);
  await runtime.scheduler.idleWithPendingCommits();

  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
          identity: signer,
          space,
        }) as unknown as RuntimeProcessor,
      ),
  });
  await clients.handleMessage(
    clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: { apiUrl, identity: { placeholder: true }, spaceDid: space },
        },
      } as never),
    }),
  );
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  const client = await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: space },
  );
  return {
    items: client.getCellFromRef<unknown[]>(createCellRef(ranked)),
    about: client.getCellFromRef<{ element: unknown }>(createCellRef(mapped))
      .key("element") as CellHandle,
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

/** An observer entry reporting only the fields the element reads. */
function entry(
  fields: {
    isIntersecting: boolean;
    intersectionRatio: number;
    isVisible?: boolean;
  },
): IntersectionObserverEntry {
  return fields as unknown as IntersectionObserverEntry;
}

describe("suggestion-cards", () => {
  describe("drawnCards", () => {
    it("returns no cards when about is not a cell", () => {
      expect(drawnCards([{ id: "one", anchor: here }], {}, undefined, SPACE))
        .toEqual([]);
    });

    it("returns each drawn card with its position in the list", () => {
      const cards: SuggestionCard[] = [
        { id: "elsewhere", anchor: elsewhere },
        { id: "here", anchor: here },
      ];
      expect(drawnCards(cards, here, undefined, SPACE)).toEqual([
        { card: cards[1], index: 1 },
      ]);
    });

    it("draws by anchor, then the first link of about, then act_target", () => {
      expect(drawnIds([
        { id: "anchored", anchor: here },
        { id: "anchored-elsewhere", anchor: elsewhere, about: aboutOf() },
        { id: "shelf-only", anchor: null, act_target: here },
        { id: "first-about", about: aboutOf(here.toSigilLink()) },
        {
          id: "second-about",
          about: aboutOf(elsewhere.toSigilLink(), here.toSigilLink()),
        },
        { id: "act-target", act_target: here },
        {
          id: "about-ahead-of-act",
          about: aboutOf(elsewhere.toSigilLink()),
          act_target: here,
        },
        { id: "nothing" },
      ])).toEqual(["anchored", "first-about", "act-target"]);
    });

    it("skips a card without a string id and a repeated id", () => {
      expect(drawnIds([
        { title: "no id", anchor: here } as unknown as SuggestionCard,
        { id: 7, anchor: here } as unknown as SuggestionCard,
        { id: "one", title: "first", anchor: here },
        { id: "one", title: "second", anchor: here },
        undefined as unknown as SuggestionCard,
      ])).toEqual(["one"]);
    });

    it("draws a different handle on the same cell, in the same scope", () => {
      expect(drawnIds([
        { id: "same-cell", anchor: piece("here") },
        { id: "named-scope", anchor: piece("here", { scope: "space" }) },
        { id: "other-path", anchor: piece("here", { path: ["title"] }) },
        { id: "other-space", anchor: piece("here", { space: "did:key:x" }) },
      ] as SuggestionCard[])).toEqual(["same-cell", "named-scope"]);
    });

    it("reads a link in about with no space as in the list's space", () => {
      const cards: SuggestionCard[] = [
        { id: "spaceless", about: aboutOf(link({ id: "of:here" })) },
      ];
      expect(drawnIds(cards)).toEqual(["spaceless"]);
      expect(drawnIds(cards, { listSpace: "did:key:other" })).toEqual([]);
      expect(drawnCards(cards, here, undefined, undefined)).toEqual([]);
    });

    it("compares the scope and path a link in about names", () => {
      expect(drawnIds([
        {
          id: "space-scope",
          about: aboutOf(link({ id: "of:here", scope: "space", path: [] })),
        },
        {
          id: "with-path",
          about: aboutOf(link({ id: "of:here", path: ["title"] })),
        },
        { id: "no-id", about: aboutOf(link({ space: SPACE })) },
      ])).toEqual(["space-scope"]);
    });

    it("falls back to act_target when the first entry of about is not a link", () => {
      expect(drawnIds([
        { id: "not-json", about: "here", act_target: here },
        { id: "not-array", about: JSON.stringify({}), act_target: here },
        { id: "empty", about: aboutOf(), act_target: here },
        { id: "string", about: aboutOf("of:here"), act_target: here },
        { id: "array", about: aboutOf([]), act_target: here },
        { id: "no-envelope", about: aboutOf({ "/": 1 }), act_target: here },
        { id: "no-payload", about: aboutOf({ "/": {} }), act_target: here },
        { id: "bad-id", about: aboutOf(link({ id: 1 })), act_target: here },
        {
          id: "bad-space",
          about: aboutOf(link({ id: "of:here", space: 1 })),
          act_target: here,
        },
        {
          id: "bad-scope",
          about: aboutOf(link({ id: "of:here", scope: 1 })),
          act_target: here,
        },
        {
          id: "bad-path",
          about: aboutOf(link({ id: "of:here", path: [1] })),
          act_target: here,
        },
        {
          id: "path-not-array",
          about: aboutOf(link({ id: "of:here", path: "title" })),
          act_target: here,
        },
        { id: "neither", about: "here" },
      ])).toEqual([
        "not-json",
        "not-array",
        "empty",
        "string",
        "array",
        "no-envelope",
        "no-payload",
        "bad-id",
        "bad-space",
        "bad-scope",
        "bad-path",
        "path-not-array",
      ]);
    });

    it("draws only cards carrying one of the tags, when tags are given", () => {
      const cards: SuggestionCard[] = [
        { id: "tagged", anchor: here, tags: JSON.stringify(["food", "trip"]) },
        { id: "other-tag", anchor: here, tags: JSON.stringify(["work"]) },
        { id: "not-json", anchor: here, tags: "trip" },
        { id: "not-array", anchor: here, tags: JSON.stringify("trip") },
        { id: "untagged", anchor: here },
      ];
      expect(drawnIds(cards, { tags: ["trip"] })).toEqual(["tagged"]);
      expect(drawnIds(cards, { tags: [] })).toEqual([]);
      expect(drawnIds(cards)).toEqual([
        "tagged",
        "other-tag",
        "not-json",
        "not-array",
        "untagged",
      ]);
    });
  });

  describe("over a real worker", () => {
    it("reads each row's anchor as a handle and draws at what a map element links to", async () => {
      // The element reads the rows under its own schema and compares the
      // cell its `about` resolves to, so a slot placed per mapped item draws
      // the cards anchored at that item.

      await using fixture = await rankedListOverWorker();
      const rows = await fixture.items.asSchema<SuggestionCard[]>(
        suggestionRowsSchema,
      ).sync() ?? [];
      expect(rows.map(({ anchor }) => isCellHandle(anchor))).toEqual([
        true,
        false,
        true,
      ]);
      expect(rows[1].anchor).toBeNull();

      const watch = new LinkTargetWatch({ onRetarget: () => {} });
      const followed = await watch.follow(fixture.about, () => false);
      watch.cancel();
      const space = fixture.items.space();
      expect(
        drawnCards(rows, followed?.cell, undefined, space).map(({ card }) =>
          card.id
        ),
      ).toEqual(["anchored"]);
      expect(drawnCards(rows, fixture.about, undefined, space)).toEqual([]);
    });
  });

  describe("lookOf", () => {
    it("returns the same look for the same card at the same position", () => {
      const card: SuggestionCard = {
        id: "one",
        card_revision: "r1",
        title: "Plant",
        body: "Water it",
        act_target: here,
      };
      expect(lookOf(card, 0)).toBe(
        lookOf({ ...card, act_target: piece("here") }, 0),
      );
    });

    it("returns a different look when what a person sees or acts on changes", () => {
      const card: SuggestionCard = { id: "one", act_target: here };
      const look = lookOf(card, 0);
      expect([
        lookOf(card, 1),
        lookOf({ ...card, card_revision: "r2" }, 0),
        lookOf({ ...card, title: "Delete" }, 0),
        lookOf({ ...card, body: "Gone" }, 0),
        lookOf({ ...card, act_target: elsewhere }, 0),
        lookOf({ ...card, act_target: null }, 0),
      ]).not.toContain(look);
    });
  });

  describe("isShownEntry", () => {
    it("returns true only for an intersecting entry at least half on screen", () => {
      expect([
        isShownEntry(entry({ isIntersecting: true, intersectionRatio: 0.5 })),
        isShownEntry(entry({ isIntersecting: true, intersectionRatio: 0.49 })),
        isShownEntry(entry({ isIntersecting: false, intersectionRatio: 1 })),
      ]).toEqual([true, false, false]);
    });
  });

  describe("isUnobscuredEntry", () => {
    it("returns false only when the browser reports the card obscured", () => {
      const shown = { isIntersecting: true, intersectionRatio: 1 };
      expect([
        isUnobscuredEntry(entry({ ...shown, isVisible: true })),
        isUnobscuredEntry(entry({ ...shown, isVisible: false })),
        isUnobscuredEntry(entry(shown)),
      ]).toEqual([true, false, true]);
    });
  });
});
