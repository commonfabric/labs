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

/** A third space, which reads `SPACE` in the cases with a chain. */
const FAR = "did:key:z6Mk-server-currency-test-far";

/** A fourth space, which nothing has pulled from. */
const OTHER = "did:key:z6Mk-server-currency-test-other";
const EPOCH = "epoch-one";
const AUDIENCE = "did:key:z6Mk-server-currency-test-audience";

describe("v2-server-currency", () => {
  let server: Server;
  let stores = 0;
  let localSeq: number;

  /** The spaces whose serving loop the server told of a change, in order. */
  let told: string[];

  /** A server that holds every space, or only those `owned` names. */
  const newServer = (owned?: readonly string[]): Server => {
    stores += 1;
    const made = new Server({
      store: new URL(`memory://server-currency-${stores}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => "did:key:z6Mk-server-currency-principal",
      sessionOpenAuth: { audience: AUDIENCE },
      ...(owned !== undefined && {
        ownsSpace: (space: string) => owned.includes(space),
      }),
    });
    made.setServerExecutionObserver({
      currencyChanged: (space) => told.push(space),
    });
    return made;
  };

  beforeEach(() => {
    localSeq = 0;
    told = [];
  });

  afterEach(async () => {
    await server.close();
  });

  /**
   * Commits a write to each of `ids` in `space` straight into its store, as
   * a serving loop's wave does, and returns the commit's seq. The server is
   * not told of the commit.
   */
  const write = async (space: string, ...ids: string[]): Promise<number> => {
    localSeq += 1;
    return applyCommit(await server.engineForSpace(space), {
      sessionId: "session-one",
      principal: "did:key:alice",
      space,
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((id) => ({
          op: "set" as const,
          id,
          value: { value: { n: localSeq } },
        })),
      },
    }).seq;
  };

  /**
   * Has the server admit a commit to `id` in `space` that no client
   * authored, and returns once what the commit queued has run.
   */
  const change = async (space: string, id: string): Promise<number> => {
    localSeq += 1;
    const { seq } = await server.writeDocument(space, id, { n: localSeq });
    await server.idle();
    return seq;
  };

  /**
   * Has the server admit a commit to `id` in `space` as one a client
   * authored, and returns once what the commit queued has run.
   */
  const author = async (space: string, id: string): Promise<void> => {
    const seq = await write(space, id);
    server.noteExecutorCommit({
      space,
      seq,
      class: "authored",
      sessionId: "session-one",
      writes: [{ id, scopeKey: "space" }],
    });
    await server.idle();
  };

  /**
   * A record of `piece` whose one read is the shared instance of `id` in
   * `source` at `seq`, and which computes each of `produces`.
   */
  const reading = (
    source: string,
    id: string,
    seq: number,
    piece = "of:piece",
    produces: string[] = [],
  ): CurrencyRecord => ({
    piece,
    under: [],
    vouched: true,
    writes: produces,
    owned: [],
    slices: [{
      key: "space",
      vouched: true,
      reads: [{ space: source, id, scopeKey: "space", derived: false, seq }],
      vouches: produces,
    }],
  });

  /**
   * Stores `record` of a piece of `space`, as taken at the head a write to
   * the piece's documents leaves.
   */
  const store = async (record: CurrencyRecord, space = SPACE) =>
    await server.storeCurrencyRecords(space, {
      asOf: await write(space, record.piece, ...record.writes),
      seen: [],
      epoch: EPOCH,
      records: [record],
    });

  /** The mark the `space` slice of `piece` holds in `space`. */
  const markOf = async (space = SPACE, piece = "of:piece") =>
    selectCurrencyPiece(await server.engineForSpace(space), { piece })?.mark;

  /** Whether a judgment finds `piece` of `space` servable. */
  const servable = async (space = SPACE, piece = "of:piece") =>
    (await server.judgeCurrencyRoots(space, [piece], { epoch: EPOCH }))
      .servable.length === 1;

  /**
   * Records `SPACE`'s piece as having read `of:far` of `SOURCE` at its
   * head, and judges it, which arms `SPACE` with `SOURCE`.
   */
  const armed = async (): Promise<void> => {
    await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));
    await servable();
  };

  describe("instance members", () => {
    describe("storeCurrencyRecords()", () => {
      it("stores clean a slice that read another space this server holds, at its head there", async () => {
        server = newServer();

        await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));

        expect(await markOf()).toBe(0);
      });

      it("stores marked `2` a slice that read a space another owner holds", async () => {
        server = newServer([SPACE]);
        const head = await write(SOURCE, "of:far");

        await store(reading(SOURCE, "of:far", head));

        expect(await markOf()).toBe(2);
      });

      it("drops the registration of an instance of another space once no slice reads it any longer", async () => {
        server = newServer();
        await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));

        await store({
          ...reading(SOURCE, "of:far", 0),
          slices: [{ key: "space", vouched: true, reads: [], vouches: [] }],
        });

        const source = await server.engineForSpace(SOURCE);
        expect(
          source.database.prepare(`SELECT COUNT(*) AS n FROM currency_reader`)
            .get(),
        ).toEqual({ n: 0 });
      });

      it("stores marked `2` a slice that read a space this server holds no store of", async () => {
        server = newServer();

        await store(reading(SOURCE, "of:far", 0));

        expect(await markOf()).toBe(2);
      });

      it("disarms the readers of a space whose record reads a space it has not pulled from", async () => {
        // The record rests on what a registration returned, and no change
        // in that space would reach the readers of this one.

        server = newServer();
        await store(
          reading(SOURCE, "of:far", await write(SOURCE, "of:far"), "of:piece", [
            "computed:mid",
          ]),
        );
        const mid = (await server.engineForSpace(SPACE)).database.prepare(
          `SELECT MAX(seq) AS seq FROM head WHERE id = 'computed:mid'`,
        ).get() as { seq: number };
        await store(reading(SPACE, "computed:mid", mid.seq, "of:end"), FAR);
        await servable(FAR, "of:end");
        expect(server.currencyReadersArmedOn(SPACE)).toEqual([FAR]);

        await store(
          reading(OTHER, "of:far", await write(OTHER, "of:far"), "of:other"),
        );

        expect(server.currencyReadersArmedOn(SPACE)).toEqual([]);
        expect(told).toEqual([FAR]);
      });
    });

    describe("judgeCurrencyRoots()", () => {
      it("returns a root that rests on a slice that read another space which has not changed", async () => {
        server = newServer();
        await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));

        expect(await servable()).toBe(true);
      });

      it("refuses that root once the other space changed, and marks its slice `2`", async () => {
        server = newServer();
        await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));
        await write(SOURCE, "of:far");

        expect(await servable()).toBe(false);
        expect(await markOf()).toBe(2);
      });

      it("asks nothing of a space it pulled from that has told it nothing since", async () => {
        server = newServer();
        await armed();
        const { pulls } = server.currencyDeliveryStats();

        expect(await servable()).toBe(true);

        expect(server.currencyDeliveryStats().pulls).toBe(pulls);
      });

      it("pulls from a space that told it of a change, and refuses the root", async () => {
        server = newServer();
        await armed();
        const { pulls } = server.currencyDeliveryStats();
        await change(SOURCE, "of:far");

        expect(await servable()).toBe(false);

        expect(server.currencyDeliveryStats().pulls).toBe(pulls + 1);
      });

      it("returns the slices an advance queued behind a commit marked, at the seq of that commit", async () => {
        server = newServer();
        await write(SOURCE, "of:raw");
        await store(
          {
            piece: "of:producer",
            under: [],
            vouched: true,
            writes: ["computed:far"],
            owned: [],
            slices: [{
              key: "space",
              vouched: true,
              reads: [{
                space: SOURCE,
                id: "of:raw",
                scopeKey: "space",
                derived: false,
              }],
              vouches: ["computed:far"],
            }],
          },
          SOURCE,
        );
        const far = (await server.engineForSpace(SOURCE)).database.prepare(
          `SELECT MAX(seq) AS seq FROM head WHERE id = 'computed:far'`,
        ).get() as { seq: number };
        await store(reading(SOURCE, "computed:far", far.seq));
        await servable();
        const changed = await change(SOURCE, "of:raw");
        expect(told).toEqual([SOURCE, SPACE]);

        const judged = await server.judgeCurrencyRoots(SOURCE, [], {
          epoch: EPOCH,
        });

        expect(judged.marked.map(({ piece, seq }) => ({ piece, seq })))
          .toEqual([{ piece: "of:producer", seq: changed }]);
      });
    });

    describe("writeDocument()", () => {
      it("tells a reader armed with the space of a change to an instance it registered, once", async () => {
        server = newServer();
        await armed();

        await change(SOURCE, "of:far");
        await change(SOURCE, "of:far");

        expect(told).toEqual([SPACE]);
        expect(server.currencyDeliveryStats().triggers).toBe(1);
      });

      it("tells the reader again of a change after it pulled", async () => {
        server = newServer();
        await armed();
        await change(SOURCE, "of:far");
        await servable();

        await change(SOURCE, "of:far");

        expect(told).toEqual([SPACE, SPACE]);
      });

      it("tells no reader of a change to an instance none registered", async () => {
        server = newServer();
        await armed();

        await change(SOURCE, "of:other");

        expect(told).toEqual([]);
        expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
      });

      it("queues no advance in a space with no armed reader", async () => {
        server = newServer();
        await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));

        await change(SOURCE, "of:far");

        expect(server.currencyDeliveryStats().advancesQueued).toBe(0);
      });

      describe("with three spaces in a chain", () => {
        // `SPACE` computes `computed:mid` from `SOURCE`'s `of:far`, and
        // `FAR` reads `computed:mid`.

        beforeEach(async () => {
          server = newServer();
          await store(
            reading(
              SOURCE,
              "of:far",
              await write(SOURCE, "of:far"),
              "of:piece",
              ["computed:mid"],
            ),
          );
          const mid = (await server.engineForSpace(SPACE)).database.prepare(
            `SELECT MAX(seq) AS seq FROM head WHERE id = 'computed:mid'`,
          ).get() as { seq: number };
          await store(reading(SPACE, "computed:mid", mid.seq, "of:end"), FAR);
          await servable(FAR, "of:end");
        });

        it("arms each space with the one it reads when the last is judged", () => {
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
          expect(server.currencyReadersArmedOn(SPACE)).toEqual([FAR]);
        });

        it("tells the second and the third once each of a change in the first, and marks nothing in them", async () => {
          await change(SOURCE, "of:far");
          await change(SOURCE, "of:far");

          expect(told).toEqual([SPACE, FAR]);
          expect([await markOf(), await markOf(FAR, "of:end")]).toEqual([0, 0]);
        });

        it("marks the slices that rest on the first once the third is judged", async () => {
          await change(SOURCE, "of:far");

          expect(await servable(FAR, "of:end")).toBe(false);

          expect([await markOf(), await markOf(FAR, "of:end")]).toEqual([2, 1]);
        });
      });

      describe("with two spaces that read each other", () => {
        // `SPACE` reads `SOURCE`'s `of:far` and `SOURCE` reads `SPACE`'s
        // `of:near`, so a trigger from either reaches the other and comes
        // back.

        /** Judges both spaces' pieces, which arms each with the other. */
        const armBoth = async (): Promise<void> => {
          await servable();
          await servable(SOURCE, "of:back");
        };

        beforeEach(async () => {
          server = newServer();
          await store(reading(SOURCE, "of:far", await write(SOURCE, "of:far")));
          await store(
            reading(SPACE, "of:near", await write(SPACE, "of:near"), "of:back"),
            SOURCE,
          );
          await armBoth();
        });

        it("passes a trigger around once, and stops at the space already told", async () => {
          await change(SOURCE, "of:far");

          expect(told).toEqual([SPACE, SOURCE]);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          expect(server.currencyReadersArmedOn(SPACE)).toEqual([]);
        });

        it("marks `2` the slices that read a space eight triggers from a commit a client authored, and rests on it again after one", async () => {
          // Each change no client authored adds two triggers to the chain:
          // one to the reader, and one back.

          for (let round = 0; round < 4; round++) {
            await change(SOURCE, "of:far");
            await armBoth();
          }
          expect(server.currencyDeliveryStats().overHops).toBe(1);
          expect(await markOf()).toBe(2);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);

          await author(SOURCE, "of:far");
          const head = (await server.engineForSpace(SOURCE)).database.prepare(
            `SELECT MAX(seq) AS seq FROM head WHERE id = 'of:far'`,
          ).get() as { seq: number };
          await store(reading(SOURCE, "of:far", head.seq));

          expect(await servable()).toBe(true);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
        });
      });
    });
  });
});
