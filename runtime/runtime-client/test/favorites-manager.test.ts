import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellScope, JSONSchema } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";
import { favoriteKey } from "@commonfabric/home-schemas";

import {
  type FavoritePieceAddress,
  FavoritesManager,
} from "@/favorites-manager.ts";
import type { RuntimeClient } from "@/runtime-client.ts";

const space = "did:key:test-space" as DID;

/** The address of `pieceId` in the test space, resolved in `scope`. */
function pieceAt(
  pieceId: string,
  scope: CellScope = "space",
): FavoritePieceAddress {
  return { space, pieceId, scope };
}

interface StubOptions {
  schema?: JSONSchema; // schema carried on the resolved piece ref
  getPieceThrows?: boolean; // make getPiece reject (derivation error path)
  favorites?: unknown; // value returned by the favorites cell
  ensureThrows?: boolean; // make ensureHomePatternRunning reject
  ensureDisposed?: boolean; // abort the runtime signal during setup
}

// A single flexible RuntimeClient stub covering everything FavoritesManager
// touches: the home-pattern handle chain (ensureHomePatternRunning → asSchema →
// key → handler / favorites cell) and getPiece (whose resolved ref carries the
// piece schema).
function makeStub(opts: StubOptions = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let subscribeCb: ((v: unknown) => void) | undefined;
  let unsubscribed = false;
  const getPieceArgs: unknown[][] = [];

  const handler = { send: (p: Record<string, unknown>) => sent.push(p) };
  const favoritesCell: Record<string, unknown> = {
    asSchema: () => favoritesCell,
    sync: () => Promise.resolve(),
    get: () => opts.favorites,
    subscribe: (cb: (v: unknown) => void) => {
      subscribeCb = cb;
      return () => {
        unsubscribed = true;
      };
    },
  };
  const homeHandle: Record<string, unknown> = {
    asSchema: () => homeHandle,
    sync: () => Promise.resolve(),
    key: (k: string) => (k === "favorites" ? favoritesCell : handler),
  };
  const rt = {
    signal: { aborted: opts.ensureDisposed === true },
    ensureHomePatternRunning: () =>
      opts.ensureDisposed
        ? Promise.reject(new DOMException("aborted", "AbortError"))
        : opts.ensureThrows
        ? Promise.reject(new Error("ensure failed"))
        : Promise.resolve(homeHandle),
    getPiece: (...args: unknown[]) => {
      getPieceArgs.push(args);
      return opts.getPieceThrows
        ? Promise.reject(new Error("getPiece failed"))
        : Promise.resolve({
          cell: () => ({ ref: () => ({ schema: opts.schema }) }),
        });
    },
  } as unknown as RuntimeClient;

  return {
    rt,
    sent,
    invokeSubscribe: (v: unknown) => subscribeCb?.(v),
    hasSubscriber: () => subscribeCb !== undefined,
    wasUnsubscribed: () => unsubscribed,
    getPieceCalls: () => getPieceArgs.length,
    lastGetPiece: () => getPieceArgs.at(-1),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FavoritesManager", () => {
  describe("addFavorite tag derivation", () => {
    it("derives structured tags from the piece schema", async () => {
      const stub = makeStub({
        schema: {
          type: "object",
          description: "A #Search tool to #go",
        },
      });
      await new FavoritesManager(stub.rt).addFavorite(pieceAt("piece-1"));
      expect(stub.sent[0].tags).toEqual(["search", "go"]);
      expect(stub.sent[0].piece).toMatchObject({ id: "of:piece-1", space });
      // The favorite is addressed by the piece's identity so the handler can dedup
      // a re-favorite and remove by identity.
      expect(stub.sent[0].id).toBe(
        favoriteKey({ space, scope: "space", id: "of:piece-1", path: [] }),
      );
    });

    it("prefers an explicit tag and skips the schema read", async () => {
      const stub = makeStub({
        schema: { type: "object", description: "#schema_tag" },
      });
      await new FavoritesManager(stub.rt).addFavorite(
        pieceAt("p"),
        "#Custom-Tag",
      );
      expect(stub.sent[0].tags).toEqual(["custom-tag"]);
      expect(stub.getPieceCalls()).toBe(0);
    });

    it("stores no tags when the piece has no readable schema", async () => {
      const stub = makeStub({ schema: undefined });
      await new FavoritesManager(stub.rt).addFavorite(pieceAt("p"));
      expect(stub.sent[0].tags).toEqual([]);
    });

    it("stores no tags when the schema read fails", async () => {
      const stub = makeStub({ getPieceThrows: true });
      await new FavoritesManager(stub.rt).addFavorite(pieceAt("p"));
      expect(stub.sent[0].tags).toEqual([]);
    });

    it("reads the schema in the scope the piece's address names", async () => {
      const stub = makeStub({
        schema: { type: "object", description: "#deep" },
      });
      await new FavoritesManager(stub.rt).addFavorite(pieceAt("p", "user"));
      // The id and the scope together say which document to read: the same id
      // in the space scope is a different one, whose tags are not this
      // piece's.
      expect(stub.lastGetPiece()).toEqual(["p", space, undefined, "user"]);
    });
  });

  describe("the scope a favorite is taken in", () => {
    it("sends the piece reference in the scope its address names", async () => {
      const stub = makeStub();
      await new FavoritesManager(stub.rt).addFavorite(pieceAt("p", "user"));
      expect(stub.sent[0].piece).toMatchObject({
        id: "of:p",
        space,
        scope: "user",
      });
    });

    it("keys one id resolved in two scopes as two favorites", async () => {
      const stub = makeStub();
      const favorites = new FavoritesManager(stub.rt);
      await favorites.addFavorite(pieceAt("p", "space"));
      await favorites.addFavorite(pieceAt("p", "user"));
      expect(stub.sent[0].id).not.toBe(stub.sent[1].id);
    });

    it("removes a scoped favorite by the key adding it used", async () => {
      const stub = makeStub();
      const favorites = new FavoritesManager(stub.rt);
      await favorites.addFavorite(pieceAt("p", "session"));
      await favorites.removeFavorite(pieceAt("p", "session"));
      expect(stub.sent[1].id).toBe(stub.sent[0].id);
      expect(stub.sent[1].piece).toMatchObject({ scope: "session" });
    });
  });

  describe("other operations", () => {
    describe("removeFavorite()", () => {
      it("sends the piece reference and its key", async () => {
        const stub = makeStub();
        await new FavoritesManager(stub.rt).removeFavorite(pieceAt("piece-x"));
        expect(stub.sent[0]).toMatchObject({
          piece: { id: "of:piece-x", space },
        });
        // The same key add uses, so the removal reaches the same favorite entity.
        expect(stub.sent[0].id).toBe(
          favoriteKey({ space, scope: "space", id: "of:piece-x", path: [] }),
        );
      });
    });

    describe("getFavorites()", () => {
      it("returns the favorites list", async () => {
        const entries = [{ cell: {}, tags: ["a"], userTags: [] }];
        const stub = makeStub({ favorites: entries });
        const result = await new FavoritesManager(stub.rt).getFavorites();
        expect(result).toEqual(entries);
      });

      it("returns `[]` when the cell is empty", async () => {
        const stub = makeStub({ favorites: undefined });
        expect(await new FavoritesManager(stub.rt).getFavorites()).toEqual([]);
      });
    });

    describe("subscribeFavorites()", () => {
      it("delivers values and stops on unsubscribe", async () => {
        const stub = makeStub();
        const seen: unknown[] = [];
        const cancel = new FavoritesManager(stub.rt).subscribeFavorites((f) =>
          seen.push(f)
        );
        await tick();
        expect(stub.hasSubscriber()).toBe(true);

        stub.invokeSubscribe([{ cell: {}, tags: ["x"], userTags: [] }]);
        expect(seen).toEqual([[{ cell: {}, tags: ["x"], userTags: [] }]]);

        // A null delivery is normalized to an empty array.
        stub.invokeSubscribe(undefined);
        expect(seen[1]).toEqual([]);

        cancel();
        expect(stub.wasUnsubscribed()).toBe(true);
        // After cleanup, further deliveries are dropped.
        stub.invokeSubscribe([{ cell: {}, tags: ["y"], userTags: [] }]);
        expect(seen.length).toBe(2);
      });

      it("reports setup errors to `onError`", async () => {
        const stub = makeStub({ ensureThrows: true });
        const seen: unknown[] = [];
        let reported: Error | undefined;
        new FavoritesManager(stub.rt).subscribeFavorites(
          (f) => seen.push(f),
          (err) => {
            reported = err;
          },
        );
        await tick();
        await tick();
        expect(reported?.message).toBe("ensure failed");
        // The callback is still invoked once with an empty list on failure.
        expect(seen).toEqual([[]]);
      });

      it("treats an aborted runtime as cancellation", async () => {
        const stub = makeStub({ ensureDisposed: true });
        const seen: unknown[] = [];
        let reported: Error | undefined;
        new FavoritesManager(stub.rt).subscribeFavorites(
          (f) => seen.push(f),
          (err) => {
            reported = err;
          },
        );
        await tick();
        await tick();
        // An aborted runtime signal marks an expected teardown race, not an error:
        // neither onError nor the empty-list callback fires.
        expect(reported).toBeUndefined();
        expect(seen).toEqual([]);
      });

      it("logs setup errors when no `onError` is given", async () => {
        const stub = makeStub({ ensureThrows: true });
        const original = console.error;
        let logged = false;
        console.error = () => {
          logged = true;
        };
        try {
          new FavoritesManager(stub.rt).subscribeFavorites(() => {});
          await tick();
          await tick();
        } finally {
          console.error = original;
        }
        expect(logged).toBe(true);
      });
    });
  });
});
