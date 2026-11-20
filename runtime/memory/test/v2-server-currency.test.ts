import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type CurrencyRecord,
  selectCurrencyPiece,
} from "../v2/currency-index.ts";
import { applyCommit } from "../v2/engine.ts";
import { Server } from "../v2/server.ts";

const SPACE = "did:key:z6Mk-server-currency-test-space";
const SOURCE = "did:key:z6Mk-server-currency-test-source";
const EPOCH = "epoch-one";
const AUDIENCE = "did:key:z6Mk-server-currency-test-audience";

describe("v2-server-currency", () => {
  let server: Server;
  let stores = 0;
  let localSeq: number;

  /** A server that holds every space, or only those `owned` names. */
  const newServer = (owned?: readonly string[]): Server => {
    stores += 1;
    return new Server({
      store: new URL(`memory://server-currency-${stores}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => "did:key:z6Mk-server-currency-principal",
      sessionOpenAuth: { audience: AUDIENCE },
      ...(owned !== undefined && {
        ownsSpace: (space: string) => owned.includes(space),
      }),
    });
  };

  beforeEach(() => {
    localSeq = 0;
  });

  afterEach(async () => {
    await server.close();
  });

  /** Commits a write to `id` in `space`, and returns the commit's seq. */
  const write = async (space: string, id: string): Promise<number> => {
    localSeq += 1;
    return applyCommit(await server.engineForSpace(space), {
      sessionId: "session-one",
      principal: "did:key:alice",
      space,
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: { n: localSeq } } }],
      },
    }).seq;
  };

  /** A record of `of:piece` whose one read is the source's `of:far` at `seq`. */
  const reading = (seq: number): CurrencyRecord => ({
    piece: "of:piece",
    under: [],
    vouched: true,
    writes: [],
    owned: [],
    slices: [{
      key: "space",
      vouched: true,
      reads: [{
        space: SOURCE,
        id: "of:far",
        scopeKey: "space",
        derived: false,
        seq,
      }],
      vouches: [],
    }],
  });

  /** Stores `record` of the space's piece, as taken at the space's head. */
  const store = async (record: CurrencyRecord) =>
    await server.storeCurrencyRecords(SPACE, {
      asOf: await write(SPACE, "of:piece"),
      seen: [],
      epoch: EPOCH,
      records: [record],
    });

  /** The mark the `space` slice of `of:piece` holds. */
  const markOf = async () =>
    selectCurrencyPiece(await server.engineForSpace(SPACE), {
      piece: "of:piece",
    })?.mark;

  /** Whether a judgment across spaces finds `of:piece` servable. */
  const servable = async () =>
    (await server.judgeCurrencyRoots(SPACE, ["of:piece"], {
      epoch: EPOCH,
      acrossSpaces: true,
    })).servable.length === 1;

  describe("instance members", () => {
    describe("storeCurrencyRecords()", () => {
      it("stores clean a slice that read another space this server holds, at its head there", async () => {
        server = newServer();

        await store(reading(await write(SOURCE, "of:far")));

        expect(await markOf()).toBe(0);
      });

      it("stores marked `2` a slice that read a space another owner holds", async () => {
        server = newServer([SPACE]);
        const head = await write(SOURCE, "of:far");

        await store(reading(head));

        expect(await markOf()).toBe(2);
      });
    });

    describe("judgeCurrencyRoots()", () => {
      it("returns a root that rests on a slice that read another space, where it is judged across spaces and that space has not changed", async () => {
        server = newServer();
        await store(reading(await write(SOURCE, "of:far")));

        expect(await servable()).toBe(true);
      });

      it("refuses that root once the other space changed, and marks its slice `2`", async () => {
        server = newServer();
        await store(reading(await write(SOURCE, "of:far")));
        await write(SOURCE, "of:far");

        expect(await servable()).toBe(false);
        expect(await markOf()).toBe(2);
      });

      it("refuses that root where it is not judged across spaces", async () => {
        server = newServer();
        await store(reading(await write(SOURCE, "of:far")));

        expect(
          (await server.judgeCurrencyRoots(SPACE, ["of:piece"], {
            epoch: EPOCH,
          })).refused,
        ).toEqual({ "reads-another-space": 1 });
      });
    });
  });
});
