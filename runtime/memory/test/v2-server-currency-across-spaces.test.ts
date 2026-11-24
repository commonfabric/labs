import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import {
  type CurrencyRecord,
  selectCurrencyPiece,
} from "../v2/currency-index.ts";
import { aclDocId } from "../acl.ts";
import { resolveScopeKey } from "../v2.ts";
import { connect, loopback } from "../v2/client.ts";
import { applyCommit } from "../v2/engine.ts";
import { getCurrencyDelivery, Server } from "../v2/server.ts";

const SPACE = "did:key:z6Mk-server-currency-test-space";
const SOURCE = "did:key:z6Mk-server-currency-test-source";

/** A third space, which reads `SPACE` in the cases with a chain. */
const FAR = "did:key:z6Mk-server-currency-test-far";

/** A fourth space, which nothing has pulled from. */
const OTHER = "did:key:z6Mk-server-currency-test-other";
const EPOCH = "epoch-one";
const AUDIENCE = "did:key:z6Mk-server-currency-test-audience";

describe("v2-server-currency-across-spaces", () => {
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

  /** The seq of the latest commit to `id` in `space`. */
  const headOf = async (space: string, id: string): Promise<number> =>
    ((await server.engineForSpace(space)).database.prepare(
      `SELECT MAX(seq) AS seq FROM head WHERE id = ?`,
    ).get(id) as { seq: number }).seq;

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
        await store(
          reading(
            SPACE,
            "computed:mid",
            await headOf(SPACE, "computed:mid"),
            "of:end",
          ),
          FAR,
        );
        await servable(FAR, "of:end");
        expect(server.currencyReadersArmedOn(SPACE)).toEqual([FAR]);

        await store(
          reading(OTHER, "of:far", await write(OTHER, "of:far"), "of:other"),
        );

        expect(server.currencyReadersArmedOn(SPACE)).toEqual([]);
        expect(told).toEqual([FAR]);
      });

      describe("with a slice of an actor that read that actor's own instance in another space", () => {
        /** The principal `write()` and `writeOwn()` commit as. */
        const ALICE = "did:key:alice";
        const aliceUser = resolveScopeKey("user", { principal: ALICE });
        const aliceSession = resolveScopeKey("session", {
          principal: ALICE,
          sessionId: "session-one",
        });

        /**
         * Gives `SOURCE` an access list that grants alice `capability`, or
         * names her nowhere.
         */
        const grant = async (capability?: string): Promise<void> => {
          localSeq += 1;
          applyCommit(await server.engineForSpace(SOURCE), {
            sessionId: "access-list",
            space: SOURCE,
            commit: {
              localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: aclDocId(SOURCE),
                value: {
                  value: {
                    "did:key:owner": "OWNER",
                    ...(capability !== undefined && { [ALICE]: capability }),
                  },
                },
              }],
            },
          });
        };

        /**
         * Commits a write to alice's own instance of `of:prefs` in `SOURCE`,
         * at `scope`, and returns the commit's seq.
         */
        const writeOwn = async (scope: "user" | "session"): Promise<number> => {
          localSeq += 1;
          return applyCommit(await server.engineForSpace(SOURCE), {
            sessionId: "session-one",
            principal: ALICE,
            space: SOURCE,
            commit: {
              localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "of:prefs",
                scope,
                value: { value: { n: localSeq } },
              }],
            },
          }).seq;
        };

        /**
         * A record of `SPACE`'s piece whose slice at `key` read alice's
         * instance of `of:prefs` in `SOURCE` at `seq`.
         */
        const readingOwn = (key: string, seq: number): CurrencyRecord => ({
          piece: "of:piece",
          under: [],
          vouched: true,
          writes: [],
          owned: [],
          slices: [
            { key: "space", vouched: true, reads: [], vouches: [] },
            {
              key,
              vouched: true,
              reads: [{
                space: SOURCE,
                id: "of:prefs",
                scopeKey: key,
                derived: false,
                seq,
              }],
              vouches: [],
            },
          ],
        });

        /** The mark the slice of `SPACE`'s piece at `key` holds. */
        const markAt = async (key: string) =>
          selectCurrencyPiece(await server.engineForSpace(SPACE), {
            piece: "of:piece",
            slice: key,
          })?.mark;

        /** How many instances `SOURCE` holds a registration of. */
        const registrations = async () =>
          ((await server.engineForSpace(SOURCE)).database.prepare(
            `SELECT COUNT(*) AS n FROM currency_reader`,
          ).get() as { n: number }).n;

        beforeEach(() => {
          server = newServer();
        });

        it("stores clean the user's slice, where the actor holds READ on that space", async () => {
          await grant("READ");

          await store(readingOwn(aliceUser, await writeOwn("user")));

          expect(await markAt(aliceUser)).toBe(0);
          expect(await registrations()).toBe(1);
        });

        it("stores clean the session's slice, where the actor holds READ on that space", async () => {
          await grant("READ");

          await store(readingOwn(aliceSession, await writeOwn("session")));

          expect(await markAt(aliceSession)).toBe(0);
        });

        it("stores the slice marked `2` once the instance has moved past the seq it was read at", async () => {
          await grant("READ");
          const read = await writeOwn("user");
          await writeOwn("user");

          await store(readingOwn(aliceUser, read));

          expect(await markAt(aliceUser)).toBe(2);
        });

        it("stores the slice marked `2`, and registers nothing, where that space's access list does not name the actor", async () => {
          await grant();

          await store(readingOwn(aliceUser, await writeOwn("user")));

          expect(await markAt(aliceUser)).toBe(2);
          expect(await registrations()).toBe(0);
        });

        it("stores the slice marked `2`, and drops its registration, once the actor's grant has been withdrawn", async () => {
          await grant("READ");
          const read = await writeOwn("user");
          await store(readingOwn(aliceUser, read));
          await grant();

          await store(readingOwn(aliceUser, read));

          expect(await markAt(aliceUser)).toBe(2);
          expect(await registrations()).toBe(0);
        });

        it("marks the slice `2` at the judgment that follows a change to that space's access list which withdrew the actor's grant", async () => {
          // The slice is demanded by no session here, so the judgment that
          // pulls is made of a piece whose `space` slice read that space
          // too.

          await grant("READ");
          const read = await writeOwn("user");
          const shared = await write(SOURCE, "of:far");
          await store({
            ...readingOwn(aliceUser, read),
            slices: [
              {
                key: "space",
                vouched: true,
                reads: [{
                  space: SOURCE,
                  id: "of:far",
                  scopeKey: "space",
                  derived: false,
                  seq: shared,
                }],
                vouches: [],
              },
              readingOwn(aliceUser, read).slices[1],
            ],
          });
          await servable();
          expect(await markAt(aliceUser)).toBe(0);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);

          // A client's commit is what a change to an access list is.
          const client = await connect({ transport: loopback(server) });
          const owner = await client.mount(SOURCE, {}, (
            _space,
            _session,
            context,
          ) => ({
            invocation: {
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: {},
          }));
          await owner.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: aclDocId(SOURCE),
              value: { value: { "did:key:owner": "OWNER" } },
            }],
          });
          await client.close();
          await server.idle();
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          await servable();

          expect(await markAt(aliceUser)).toBe(2);
          expect(await registrations()).toBe(1);
        });

        it("stores the slice marked `2`, and registers nothing, where that space has no access list", async () => {
          await store(readingOwn(aliceUser, await writeOwn("user")));

          expect(await markAt(aliceUser)).toBe(2);
          expect(await registrations()).toBe(0);
        });
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
        const { pulls } = server.currencyDelivery();

        expect(await servable()).toBe(true);

        expect(server.currencyDelivery().pulls).toBe(pulls);
      });

      it("pulls from a space that told it of a change, and refuses the root", async () => {
        server = newServer();
        await armed();
        const { pulls } = server.currencyDelivery();
        await change(SOURCE, "of:far");

        expect(await servable()).toBe(false);

        expect(server.currencyDelivery().pulls).toBe(pulls + 1);
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
        await store(
          reading(SOURCE, "computed:far", await headOf(SOURCE, "computed:far")),
        );
        await servable();
        const changed = await change(SOURCE, "of:raw");
        expect(told).toEqual([SOURCE, SPACE]);

        const judged = await server.judgeCurrencyRoots(SOURCE, [], {
          epoch: EPOCH,
        });

        expect(judged.marked.map(({ piece, seq }) => ({ piece, seq })))
          .toEqual([{ piece: "of:producer", seq: changed }]);
      });

      describe("with a space it reads that holds a slice which expires", () => {
        /** What `Date.now()` returns in these cases. */
        let now: number;
        let clock: Stub<DateConstructor>;

        /** The time `SOURCE`'s slice expires at. */
        const EXPIRES = 1_700_000_060_000;

        beforeEach(() => {
          now = 1_700_000_000_000;
          clock = stub(Date, "now", () => now);
          server = newServer();
        });

        afterEach(() => {
          clock.restore();
        });

        /**
         * Records `of:clock` of `space` as computing `computed:tick` until
         * `EXPIRES`.
         */
        const storeClock = async (space = SOURCE) =>
          await store(
            {
              piece: "of:clock",
              under: [],
              vouched: true,
              writes: ["computed:tick"],
              owned: [],
              slices: [{
                key: "space",
                vouched: true,
                reads: [],
                vouches: ["computed:tick"],
                expiresAt: EXPIRES,
              }],
            },
            space,
          );

        /**
         * Records `of:after` of `SOURCE` as computing `computed:after` from
         * `computed:tick`, and `SPACE`'s piece as having read
         * `computed:after` at its head.
         */
        const storeChain = async (): Promise<void> => {
          await storeClock();
          await store(
            {
              piece: "of:after",
              under: [],
              vouched: true,
              writes: ["computed:after"],
              owned: [],
              slices: [{
                key: "space",
                vouched: true,
                reads: [{
                  space: SOURCE,
                  id: "computed:tick",
                  scopeKey: "space",
                  derived: true,
                }],
                vouches: ["computed:after"],
              }],
            },
            SOURCE,
          );
          await store(
            reading(
              SOURCE,
              "computed:after",
              await headOf(SOURCE, "computed:after"),
            ),
          );
        };

        /** What a judgment of `SPACE`'s piece returns. */
        const judged = async (space = SPACE) =>
          await server.judgeCurrencyRoots(space, ["of:piece"], {
            epoch: EPOCH,
          });

        it("returns the root, and that time as the time to judge it again", async () => {
          await storeChain();

          expect(await judged()).toMatchObject({
            servable: [{ root: "of:piece", piece: "of:piece" }],
            nextExpiry: EXPIRES,
          });
        });

        it("asks nothing of that space before the time", async () => {
          await storeChain();
          await judged();
          const { pulls } = server.currencyDelivery();
          now = EXPIRES - 1;

          expect((await judged()).servable).toHaveLength(1);

          expect(server.currencyDelivery().pulls).toBe(pulls);
        });

        it("refuses, once the time has come, a root that read what a piece computes from the expired slice's output", async () => {
          await storeChain();
          await judged();
          const { pulls } = server.currencyDelivery();
          now = EXPIRES;

          const after = await judged();

          expect(after.servable).toEqual([]);
          expect(after.nextExpiry).toBeUndefined();
          expect(server.currencyDelivery().pulls).toBe(pulls + 1);
        });

        it("returns that time for a root two spaces along from the slice", async () => {
          await storeChain();
          await store(
            reading(SPACE, "of:near", await write(SPACE, "of:near")),
            FAR,
          );

          expect(await judged(FAR)).toMatchObject({
            servable: [{ root: "of:piece", piece: "of:piece" }],
            nextExpiry: EXPIRES,
          });
        });

        it("refuses, once the time has come, a root two spaces along that read what the space between computes from it", async () => {
          await storeChain();
          await store(
            {
              ...reading(
                SOURCE,
                "computed:after",
                await headOf(SOURCE, "computed:after"),
              ),
              writes: ["of:near"],
              slices: [{
                key: "space",
                vouched: true,
                reads: [{
                  space: SOURCE,
                  id: "computed:after",
                  scopeKey: "space",
                  derived: false,
                  seq: await headOf(SOURCE, "computed:after"),
                }],
                vouches: ["of:near"],
              }],
            },
          );
          await store(
            reading(SPACE, "of:near", await headOf(SPACE, "of:near")),
            FAR,
          );
          await judged(FAR);
          now = EXPIRES;

          expect((await judged(FAR)).servable).toEqual([]);
        });

        it("tells a space resting on it without a time when a slice that expires is stored in it", async () => {
          await armed();
          told = [];

          await storeClock();

          expect(told).toEqual([SPACE]);
          expect((await judged()).nextExpiry).toBe(EXPIRES);
        });
      });
    });

    describe("currencyDelivery()", () => {
      it("reports no space and no armed pair for a server no space reads another on", () => {
        server = newServer();

        expect(server.currencyDelivery()).toEqual({
          triggers: 0,
          pulls: 0,
          advancesQueued: 0,
          holds: 0,
          armed: 0,
          spaces: [],
        });
      });

      it("is what `getCurrencyDelivery()` reports for the newest live server, until that server closes", async () => {
        server = newServer();
        await armed();
        const newer = newServer();
        try {
          expect(getCurrencyDelivery()).toEqual(newer.currencyDelivery());
          expect(getCurrencyDelivery()?.pulls).toBe(0);
        } finally {
          await newer.close();
        }

        expect(getCurrencyDelivery()).toEqual(server.currencyDelivery());
        expect(getCurrencyDelivery()?.pulls).toBe(1);
      });
    });

    describe("writeDocument()", () => {
      it("tells a reader armed with the space of a change to an instance it registered, once", async () => {
        server = newServer();
        await armed();

        await change(SOURCE, "of:far");
        await change(SOURCE, "of:far");

        expect(told).toEqual([SPACE]);
        expect(server.currencyDelivery().triggers).toBe(1);
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

        expect(server.currencyDelivery().advancesQueued).toBe(0);
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
          await store(
            reading(
              SPACE,
              "computed:mid",
              await headOf(SPACE, "computed:mid"),
              "of:end",
            ),
            FAR,
          );
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

      describe("with ten spaces in a chain", () => {
        // Each space after the first computes `computed:out` from what the
        // one before it holds, so one change passes down the whole chain.

        /** The spaces of the chain, in the order a change passes them. */
        const chain = Array.from(
          { length: 10 },
          (_, at) => `did:key:z6Mk-server-currency-test-chain-${at}`,
        );

        beforeEach(async () => {
          server = newServer();
          let head = await write(chain[0], "of:far");
          for (let at = 1; at < chain.length; at++) {
            await store(
              reading(
                chain[at - 1],
                at === 1 ? "of:far" : "computed:out",
                head,
                "of:piece",
                ["computed:out"],
              ),
              chain[at],
            );
            head = await headOf(chain[at], "computed:out");
          }
          await servable(chain[9]);
        });

        it("tells every space after the first of a change in the first, and holds none", async () => {
          await change(chain[0], "of:far");

          expect(told).toEqual(chain.slice(1));
          expect(server.currencyDelivery().holds).toBe(0);
        });

        it("arms the last space with the one before it again once it is judged", async () => {
          await change(chain[0], "of:far");

          await servable(chain[9]);

          expect(server.currencyReadersArmedOn(chain[8])).toEqual([chain[9]]);
        });
      });

      describe("with two spaces that read each other", () => {
        // `SPACE` reads `SOURCE`'s `of:far` and `SOURCE` reads `SPACE`'s
        // `of:near`, so a trigger from either reaches the other and comes
        // back.

        /** What `Date.now()` returns in these cases. */
        let now: number;
        let clock: Stub<DateConstructor>;

        /** Judges both spaces' pieces, which arms each with the other. */
        const armBoth = async (): Promise<void> => {
          await servable();
          await servable(SOURCE, "of:back");
        };

        /**
         * Records each space's piece as having read the other's document at
         * its head, and judges both.
         */
        const recordBoth = async (): Promise<void> => {
          await store(
            reading(SOURCE, "of:far", await headOf(SOURCE, "of:far")),
          );
          await store(
            reading(
              SPACE,
              "of:near",
              await headOf(SPACE, "of:near"),
              "of:back",
            ),
            SOURCE,
          );
          await armBoth();
        };

        /**
         * Changes `SOURCE`'s document `count` times with no client behind
         * the change, arming both spaces again after each. The change
         * reaches `SPACE` and comes back to `SOURCE` each time.
         */
        const goRound = async (count: number): Promise<void> => {
          for (let round = 0; round < count; round++) {
            await change(SOURCE, "of:far");
            await armBoth();
          }
        };

        beforeEach(async () => {
          now = 1_700_000_000_000;
          clock = stub(Date, "now", () => now);
          server = newServer();
          await write(SOURCE, "of:far");
          await write(SPACE, "of:near");
          await recordBoth();
        });

        afterEach(() => {
          clock.restore();
        });

        it("passes a trigger around once, and stops at the space already told", async () => {
          await change(SOURCE, "of:far");

          expect(told).toEqual([SPACE, SOURCE]);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          expect(server.currencyReadersArmedOn(SPACE)).toEqual([]);
        });

        it("holds neither space while a change has come back fewer than eight times", async () => {
          // The first round is where the change sets out, and each further
          // one is a lap.

          await goRound(8);

          expect(server.currencyDelivery().holds).toBe(0);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
        });

        it("holds both spaces once a change has come back to them eight times, and marks `2` the slices that read them", async () => {
          await goRound(9);

          expect(server.currencyDelivery().holds).toBe(2);
          expect([await markOf(), await markOf(SOURCE, "of:back")]).toEqual([
            2,
            2,
          ]);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          expect(server.currencyReadersArmedOn(SPACE)).toEqual([]);
        });

        it("stores marked `2` a record that reads a space that is held", async () => {
          await goRound(9);

          await store(
            reading(SOURCE, "of:far", await headOf(SOURCE, "of:far")),
          );

          expect(await markOf()).toBe(2);
        });

        it("rests on a space again once its hold has passed", async () => {
          await goRound(9);
          now += 1_001;

          await recordBoth();

          expect(await servable()).toBe(true);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
        });

        it("holds a space for twice as long when the change goes on coming back", async () => {
          await goRound(9);
          now += 1_001;
          await recordBoth();
          await goRound(8);
          expect(server.currencyDelivery().holds).toBe(4);

          now += 1_001;
          await recordBoth();
          expect(await servable()).toBe(false);
          now += 1_000;
          await recordBoth();

          expect(await servable()).toBe(true);
        });

        it("holds a space for as long as the first time once it was left alone for longer than its last hold", async () => {
          await goRound(9);
          now += 2_001;
          await recordBoth();
          await goRound(8);

          now += 1_001;
          await recordBoth();

          expect(await servable()).toBe(true);
        });

        it("reports each space the change came back to, with the circle it came round", async () => {
          await goRound(2);

          const report = server.currencyDelivery();

          expect(report.armed).toBe(2);
          expect(
            report.spaces.map(({ space, laps, circle, holds }) => ({
              space,
              laps,
              circle,
              holds,
            })).sort((a, b) => a.space.localeCompare(b.space)),
          ).toEqual([
            { space: SOURCE, laps: 1, circle: [SOURCE, SPACE], holds: 0 },
            { space: SPACE, laps: 1, circle: [SPACE, SOURCE], holds: 0 },
          ]);
        });

        it("reports when the hold of a space ends, while it is held", async () => {
          await goRound(9);
          const held = server.currencyDelivery().spaces.map((entry) =>
            entry.heldUntil
          );
          now += 1_001;

          expect(held).toEqual([now - 1, now - 1]);
          expect(
            server.currencyDelivery().spaces.map((entry) => entry.heldUntil),
          ).toEqual([undefined, undefined]);
        });

        it("names the circle in the warning it logs for a hold", async () => {
          using warned = stub(console, "warn");

          await goRound(9);

          expect(warned.calls.map((call) => call.args[0])).toEqual([
            `memory v2: a change came back to the space ${SPACE} 8 times, ` +
            `round ${SPACE} -> ${SOURCE} -> ${SPACE}; no space rests on its ` +
            "currency index for 1000 ms",
            `memory v2: a change came back to the space ${SOURCE} 8 times, ` +
            `round ${SOURCE} -> ${SPACE} -> ${SOURCE}; no space rests on ` +
            "its currency index for 1000 ms",
          ]);
        });

        it("ends the hold of a space that a change with no trigger behind it reaches", async () => {
          await goRound(9);
          await author(SOURCE, "of:far");
          await recordBoth();
          expect(await servable(SOURCE, "of:back")).toBe(false);

          await change(SOURCE, "of:far");
          await recordBoth();

          expect(await servable(SOURCE, "of:back")).toBe(true);
        });

        describe("and a slice of `SOURCE` that expires", () => {
          // Each space may be rested on only until the slice expires: the
          // slice's own space, and the space that reads it, which the first
          // reads back. Nothing in either moves, so neither is to ask the
          // other anything before then.

          /** The time `SOURCE`'s slice expires at. */
          const EXPIRES = 1_700_000_060_000;

          /**
           * Records `of:clock` of `SOURCE` as computing `computed:tick` until
           * `EXPIRES`.
           */
          const storeClock = async () =>
            await store(
              {
                piece: "of:clock",
                under: [],
                vouched: true,
                writes: ["computed:tick"],
                owned: [],
                slices: [{
                  key: "space",
                  vouched: true,
                  reads: [],
                  vouches: ["computed:tick"],
                  expiresAt: EXPIRES,
                }],
              },
              SOURCE,
            );

          it("tells each space of that time, and leaves each armed with the other without asking either anything", async () => {
            told = [];
            const { pulls } = server.currencyDelivery();

            await storeClock();

            expect(told).toEqual([SPACE, SOURCE]);
            expect(server.currencyDelivery().pulls).toBe(pulls);
            expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
            expect(server.currencyReadersArmedOn(SPACE)).toEqual([SOURCE]);
          });

          it("asks neither space anything at a judgment before that time", async () => {
            await storeClock();
            await armBoth();
            const { pulls } = server.currencyDelivery();

            await armBoth();

            expect(server.currencyDelivery().pulls).toBe(pulls);
          });

          it("asks neither space anything at a second judgment before that time, once a change has disarmed both", async () => {
            await storeClock();
            await change(SOURCE, "of:far");
            await servable();
            const { pulls } = server.currencyDelivery();

            await armBoth();

            expect(server.currencyDelivery().pulls).toBe(pulls);
            expect(server.currencyReadersArmedOn(SOURCE)).toEqual([SPACE]);
            expect(server.currencyReadersArmedOn(SPACE)).toEqual([SOURCE]);
          });

          it("returns that time to each space as the time to judge it again", async () => {
            await storeClock();

            const judged = await Promise.all(
              [[SPACE, "of:piece"], [SOURCE, "of:back"]].map(([space, root]) =>
                server.judgeCurrencyRoots(space, [root], { epoch: EPOCH })
              ),
            );

            expect(judged.map(({ nextExpiry }) => nextExpiry)).toEqual([
              EXPIRES,
              EXPIRES,
            ]);
          });
        });
      });
    });
  });
});
