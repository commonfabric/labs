import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { aclDocId } from "../acl.ts";
import {
  type Client,
  connect,
  loopback,
  type SessionOpenAuthFactory,
} from "../v2/client.ts";
import { resolveScopeKey } from "../v2.ts";
import type { CurrencyRecord } from "../v2/currency-index.ts";
import * as Engine from "../v2/engine.ts";
import {
  type CarriedDemandRow,
  Server,
  type SessionDemand,
} from "../v2/server.ts";
import {
  type SessionLifecycleEvent,
  SessionRegistry,
} from "../v2/session-registry.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

/** The space the demand is carried into. */
const SOURCE = "did:key:z6Mk-carried-demand-source";

/** The space whose loop carries it, and where the sessions are clients. */
const READER = "did:key:z6Mk-carried-demand-reader";

/** A second space that carries demand into `SOURCE`. */
const OTHER = "did:key:z6Mk-carried-demand-other";

/** A reading space whose store this server does not hold. */
const ABSENT = "did:key:z6Mk-carried-demand-absent";
const OWNER = "did:key:z6Mk-carried-demand-owner";
const ALICE = "did:key:z6Mk-carried-demand-alice";
const BOB = "did:key:z6Mk-carried-demand-bob";
const AUDIENCE = "did:key:z6Mk-carried-demand-audience";
const EPOCH = "epoch-one";

/** Opens a session as `principal`, which the test server trusts as given. */
const authAs = (principal: string): SessionOpenAuthFactory =>
(
  _space,
  _session,
  context,
) => ({
  invocation: { aud: context.audience, challenge: context.challenge.value },
  authorization: { principal },
});

describe("v2-server-carried-demand", () => {
  let server: Server;
  let sessions: SessionRegistry;
  let clients: Client[];
  let stores = 0;

  /** What the server told its serving host, in order. */
  let told: string[];

  beforeEach(async () => {
    clients = [];
    told = [];
    sessions = new SessionRegistry();
    server = new Server({
      sessions,
      store: new URL(`memory://carried-demand-${++stores}`),
      sessionOpenAuth: { audience: AUDIENCE },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      subscriptionRefreshDelayMs: 0,
    });
    // `SOURCE`'s access list gives Alice READ and Bob nothing.
    Engine.applyCommit(await server.engineForSpace(SOURCE), {
      space: SOURCE,
      sessionId: "access-list",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: aclDocId(SOURCE),
          value: { value: { [OWNER]: "OWNER", [ALICE]: "READ" } },
        }],
      },
    });
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await server.close();
  });

  /**
   * Opens a client session of `principal` on `space` under `sessionId`, and
   * returns the origin a carried row names it by.
   */
  const session = async (
    principal: string,
    sessionId: string,
    space = READER,
  ): Promise<CarriedDemandRow["origin"]> => {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    await client.mount(space, { sessionId }, authAs(principal));
    return { space, sessionId };
  };

  /** A row for the shared instance of `id`, carried for `origin`. */
  const shared = (
    id: string,
    origin: CarriedDemandRow["origin"],
  ): CarriedDemandRow => ({ id, scope: "space", scopeKey: "space", origin });

  /** A row for `principal`'s own instance of `id`, carried for `origin`. */
  const own = (
    id: string,
    principal: string,
    origin: CarriedDemandRow["origin"],
  ): CarriedDemandRow => ({
    id,
    scope: "user",
    scopeKey: `user:${principal}`,
    origin,
  });

  /** The rows of each share of `SOURCE`'s demand set, by the share's id. */
  const demand = (): Array<
    SessionDemand["rows"] extends ReadonlyMap<string, infer Row> ? Row
      : never
  > =>
    server.demandForSpace(SOURCE).flatMap((share) => [...share.rows.values()]);

  /** Records what the server tells its serving host from here on. */
  const observe = (): void => {
    server.setServerExecutionObserver({
      sessionOpened: (space) => told.push(`opened ${space}`),
      demandChanged: (space) => told.push(`demand ${space}`),
      sessionChanged: (event: SessionLifecycleEvent) => {
        if (event.space === SOURCE) told.push(`session ${event.kind}`);
      },
    });
    told = [];
  };

  describe("instance members", () => {
    describe("setCarriedDemand()", () => {
      describe("with a shared instance the reading space registered with the space's currency index", () => {
        // `SOURCE`'s piece `of:producer` computes `computed:far` from
        // `of:raw`, and `READER`'s piece `of:piece` read `computed:far`.
        let localSeq: number;

        /** Commits a write to each of `ids` in `space`, and returns its seq. */
        const write = async (
          space: string,
          ...ids: string[]
        ): Promise<number> => {
          localSeq += 1;
          return Engine.applyCommit(await server.engineForSpace(space), {
            sessionId: "writer",
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

        /** Stores `record` of a piece of `space`, as taken at its head. */
        const store = async (space: string, record: CurrencyRecord) =>
          await server.storeCurrencyRecords(space, {
            asOf: await write(space, record.piece, ...record.writes),
            seen: [],
            epoch: EPOCH,
            records: [record],
          });

        /** A record of `piece` that read `read` and computes `produces`. */
        const record = (
          piece: string,
          read: CurrencyRecord["slices"][number]["reads"][number],
          produces: string[],
        ): CurrencyRecord => ({
          piece,
          under: [],
          vouched: true,
          writes: produces,
          owned: [],
          slices: [{
            key: "space",
            vouched: true,
            reads: [read],
            vouches: produces,
          }],
        });

        /** A record of the producer, which read `of:raw`. */
        const producer = (): CurrencyRecord =>
          record("of:producer", {
            space: SOURCE,
            id: "of:raw",
            scopeKey: "space",
            derived: false,
          }, ["computed:far"]);

        /** Judges `READER`'s piece, which arms `READER` with `SOURCE`. */
        const arm = async () =>
          await server.judgeCurrencyRoots(READER, ["of:piece"], {
            epoch: EPOCH,
          });

        beforeEach(async () => {
          localSeq = 1;
          await write(SOURCE, "of:raw");
          await store(SOURCE, producer());
          const head = (await server.engineForSpace(SOURCE)).database.prepare(
            `SELECT MAX(seq) AS seq FROM head WHERE id = ?`,
          ).get("computed:far") as { seq: number };
          await store(
            READER,
            record("of:piece", {
              space: SOURCE,
              id: "computed:far",
              scopeKey: "space",
              derived: false,
              seq: head.seq,
            }, []),
          );
        });

        it("adds no row for the instance while the reading space is armed with the space and the index holds the instance current", async () => {
          const alice = await session(ALICE, "alice-one");
          await arm();

          expect(
            await server.setCarriedDemand(SOURCE, READER, [
              shared("computed:far", alice),
            ]),
          ).toEqual({ refused: 0 });

          expect(demand()).toEqual([]);
          expect(server.hasLiveSessionsForSpace(SOURCE)).toBe(false);
        });

        it("pulls for a reading space that is not armed with the space, and adds no row for an instance the pull found current", async () => {
          const alice = await session(ALICE, "alice-one");
          const { pulls } = server.currencyDelivery();

          await server.setCarriedDemand(SOURCE, READER, [
            shared("computed:far", alice),
          ]);

          expect(server.currencyDelivery().pulls).toBe(pulls + 1);
          expect(demand()).toEqual([]);
        });

        it("adds the row for an instance the pull found stale, and one for the piece that writes it", async () => {
          const alice = await session(ALICE, "alice-one");
          await write(SOURCE, "of:raw");

          await server.setCarriedDemand(SOURCE, READER, [
            shared("computed:far", alice),
          ]);

          expect(demand().map(({ id }) => id)).toEqual([
            "computed:far",
            "of:producer",
          ]);
        });

        it("adds an actor's own instance that the reading space has not registered, though it is armed", async () => {
          const alice = await session(ALICE, "alice-one");
          await arm();

          await server.setCarriedDemand(SOURCE, READER, [
            own("of:prefs", ALICE, alice),
          ]);

          expect(demand().map(({ id }) => id)).toEqual(["of:prefs"]);
        });

        it("adds no row for an actor's own instance that the reading space registered and the index holds current", async () => {
          const aliceKey = resolveScopeKey("user", { principal: ALICE });
          localSeq += 1;
          const head = Engine.applyCommit(
            await server.engineForSpace(SOURCE),
            {
              sessionId: "writer",
              principal: ALICE,
              space: SOURCE,
              commit: {
                localSeq,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: "of:prefs",
                  scope: "user",
                  value: { value: { n: localSeq } },
                }],
              },
            },
          ).seq;
          await store(READER, {
            piece: "of:viewer",
            under: [],
            vouched: true,
            writes: [],
            owned: [],
            slices: [
              { key: "space", vouched: true, reads: [], vouches: [] },
              {
                key: aliceKey,
                vouched: true,
                reads: [{
                  space: SOURCE,
                  id: "of:prefs",
                  scopeKey: aliceKey,
                  derived: false,
                  seq: head,
                }],
                vouches: [],
              },
            ],
          });
          const alice = await session(ALICE, "alice-one");

          await server.setCarriedDemand(SOURCE, READER, [{
            id: "of:prefs",
            scope: "user",
            scopeKey: aliceKey,
            origin: alice,
          }]);

          expect(demand()).toEqual([]);
        });

        it("adds, with a row for an actor's own instance, a row for the piece the index records as writing that document, for the same pair", async () => {
          // A serving loop starts no piece for a demanded document that a
          // computation derives, and the actor's instance may not exist
          // yet. The piece is what it can load.

          const alice = await session(ALICE, "alice-one");

          await server.setCarriedDemand(SOURCE, READER, [
            own("computed:far", ALICE, alice),
          ]);

          expect(
            demand().map(({ id, scopeKey, identity }) => ({
              id,
              scopeKey,
              principal: identity?.principal,
            })),
          ).toEqual([
            {
              id: "computed:far",
              scopeKey: `user:${ALICE}`,
              principal: ALICE,
            },
            { id: "of:producer", scopeKey: "space", principal: ALICE },
          ]);
        });

        it("adds the row and one for the piece that writes it, and tells the serving host, once an input of that piece changed", async () => {
          const alice = await session(ALICE, "alice-one");
          await arm();
          await server.setCarriedDemand(SOURCE, READER, [
            shared("computed:far", alice),
          ]);
          observe();

          await server.writeDocument(SOURCE, "of:raw", { n: 99 });
          await server.idle();

          expect(demand().map(({ id }) => id)).toEqual([
            "computed:far",
            "of:producer",
          ]);
          expect(told).toEqual([
            "session opened",
            `opened ${SOURCE}`,
            `demand ${SOURCE}`,
          ]);
        });

        it("drops the row again once the piece is recorded current, which the reading space is told of and pulls", async () => {
          const alice = await session(ALICE, "alice-one");
          await arm();
          await server.setCarriedDemand(SOURCE, READER, [
            shared("computed:far", alice),
          ]);
          await server.writeDocument(SOURCE, "of:raw", { n: 99 });
          await server.idle();

          // The producer ran again and wrote what it had written.
          const engine = await server.engineForSpace(SOURCE);
          await server.storeCurrencyRecords(SOURCE, {
            asOf: Engine.serverSeq(engine),
            seen: [],
            epoch: EPOCH,
            records: [producer()],
          });
          await server.idle();

          expect(demand()).toEqual([]);
        });

        describe("once a change to the instance the reading space registered disarms it", () => {
          /** Writes the registered instance and waits for what it queued. */
          const change = async () => {
            await server.writeDocument(SOURCE, "computed:far", { n: 99 });
            await server.idle();
          };

          it("pulls again for the reading space while it offers demand there, which arms it", async () => {
            const alice = await session(ALICE, "alice-one");
            await arm();
            await server.setCarriedDemand(SOURCE, READER, [
              shared("computed:far", alice),
            ]);
            const { pulls } = server.currencyDelivery();

            await change();

            expect(server.currencyDelivery().pulls).toBe(pulls + 1);
            expect(server.currencyReadersArmedOn(SOURCE)).toEqual([READER]);
          });

          it("pulls nothing for a reading space that offers no demand there", async () => {
            await arm();
            const { pulls } = server.currencyDelivery();

            await change();

            expect(server.currencyDelivery().pulls).toBe(pulls);
            expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          });

          it("warns, naming both spaces, when the pull fails, and leaves the reading space unarmed", async () => {
            const alice = await session(ALICE, "alice-one");
            await arm();
            await server.setCarriedDemand(SOURCE, READER, [
              shared("computed:far", alice),
            ]);
            const failure = new Error("the store cannot be opened");
            server.accessForTestingOnly.engineOpener = (space, open) => {
              if (space !== READER) return open(space);
              server.accessForTestingOnly.engineOpener = undefined;
              return Promise.reject(failure);
            };
            using warned = stub(console, "warn");

            await change();

            expect(server.accessForTestingOnly.engineOpener).toBeUndefined();
            expect(warned.calls.map(({ args }) => args)).toEqual([[
              `memory v2: the pull queued for ${READER} from ${SOURCE} failed`,
              failure,
            ]]);
            expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          });
        });

        it("pulls nothing for a reading space this server holds no store of, and adds the row", async () => {
          const alice = await session(ALICE, "alice-one");
          const { pulls } = server.currencyDelivery();

          await server.setCarriedDemand(SOURCE, ABSENT, [
            shared("computed:far", alice),
          ]);

          expect(server.currencyDelivery().pulls).toBe(pulls);
          expect(server.currencyReadersArmedOn(SOURCE)).toEqual([]);
          expect(demand().map(({ id }) => id)).toEqual([
            "computed:far",
            "of:producer",
          ]);
        });
      });

      it("adds a row to the space's demand set for the instance, as a root, with the pair of the origin session", async () => {
        const alice = await session(ALICE, "alice-one");

        expect(
          await server.setCarriedDemand(SOURCE, READER, [
            shared("of:far", alice),
          ]),
        ).toEqual({ refused: 0 });

        expect(demand()).toEqual([{
          id: "of:far",
          scope: "space",
          scopeKey: "space",
          identity: { principal: ALICE, sessionId: "alice-one" },
          root: true,
          origin: alice,
        }]);
      });

      it("adds a row for the actor's own instance of a document", async () => {
        const alice = await session(ALICE, "alice-one");

        await server.setCarriedDemand(SOURCE, READER, [
          own("of:prefs", ALICE, alice),
        ]);

        expect(demand()).toEqual([{
          id: "of:prefs",
          scope: "user",
          scopeKey: `user:${ALICE}`,
          identity: { principal: ALICE, sessionId: "alice-one" },
          root: true,
          origin: alice,
        }]);
      });

      it("makes the space one with a live session, and tells the serving host that a session opened and that demand changed", async () => {
        const alice = await session(ALICE, "alice-one");
        observe();
        expect(server.hasLiveSessionsForSpace(SOURCE)).toBe(false);

        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);

        expect(server.hasLiveSessionsForSpace(SOURCE)).toBe(true);
        expect(told).toEqual([
          "session opened",
          `opened ${SOURCE}`,
          `demand ${SOURCE}`,
        ]);
      });

      it("holds the row already when it tells the serving host that a session opened", async () => {
        // The host asks whether the space has a live session when it is
        // told, and wakes a parked space only if it has.

        const alice = await session(ALICE, "alice-one");
        const live: boolean[] = [];
        server.setServerExecutionObserver({
          sessionOpened: (space) => {
            if (space === SOURCE) {
              live.push(server.hasLiveSessionsForSpace(SOURCE));
            }
          },
        });

        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);

        expect(live).toEqual([true]);
      });

      it("does not make the actor a connected session of the space", async () => {
        const alice = await session(ALICE, "alice-one");

        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);

        expect(server.hasLiveSessionFor(SOURCE, ALICE, "alice-one")).toBe(
          false,
        );
      });

      it("replaces what the reading space carried with the next set, and tells the host of the change only", async () => {
        const alice = await session(ALICE, "alice-one");
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);
        observe();

        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:near", alice),
        ]);

        expect(demand().map(({ id }) => id)).toEqual(["of:near"]);
        expect(told).toEqual([`demand ${SOURCE}`]);
      });

      it("tells the host nothing when the next set is the one it holds", async () => {
        const alice = await session(ALICE, "alice-one");
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);
        observe();

        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);

        expect(told).toEqual([]);
      });

      it("withdraws everything the reading space carried when the next set is empty", async () => {
        const alice = await session(ALICE, "alice-one");
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);
        observe();

        await server.setCarriedDemand(SOURCE, READER, []);

        expect(demand()).toEqual([]);
        expect(server.hasLiveSessionsForSpace(SOURCE)).toBe(false);
        expect(told).toEqual(["session removed", `demand ${SOURCE}`]);
      });

      it("keeps what one reading space carried when another replaces its own", async () => {
        const alice = await session(ALICE, "alice-one");
        const elsewhere = await session(ALICE, "alice-two", OTHER);
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);
        await server.setCarriedDemand(SOURCE, OTHER, [
          shared("of:near", elsewhere),
        ]);

        await server.setCarriedDemand(SOURCE, OTHER, []);

        expect(demand().map(({ id }) => id)).toEqual(["of:far"]);
      });

      it("refuses a row whose origin is not a session the server holds", async () => {
        expect(
          await server.setCarriedDemand(SOURCE, READER, [
            shared("of:far", { space: READER, sessionId: "absent" }),
          ]),
        ).toEqual({ refused: 1 });
        expect(demand()).toEqual([]);
      });

      it("refuses a row whose origin is a serving session of the excluded principal", async () => {
        const alice = await session(ALICE, "alice-one");

        expect(
          await server.setCarriedDemand(
            SOURCE,
            READER,
            [shared("of:far", alice)],
            { excludePrincipal: ALICE },
          ),
        ).toEqual({ refused: 1 });
      });

      it("adds a row with no pair for a shared instance whose actor does not hold READ on the space", async () => {
        const bob = await session(BOB, "bob-one");

        expect(
          await server.setCarriedDemand(SOURCE, READER, [
            shared("of:far", bob),
          ]),
        ).toEqual({ refused: 0 });

        expect(demand()).toEqual([{
          id: "of:far",
          scope: "space",
          scopeKey: "space",
          root: true,
          origin: bob,
        }]);
      });

      it("refuses a row for the own instance of an actor who does not hold READ on the space", async () => {
        const bob = await session(BOB, "bob-one");

        expect(
          await server.setCarriedDemand(SOURCE, READER, [
            own("of:prefs", BOB, bob),
          ]),
        ).toEqual({ refused: 1 });
        expect(demand()).toEqual([]);
      });

      it("refuses a row for an instance of another actor than the origin session's", async () => {
        const alice = await session(ALICE, "alice-one");

        expect(
          await server.setCarriedDemand(SOURCE, READER, [
            own("of:prefs", BOB, alice),
          ]),
        ).toEqual({ refused: 1 });
      });

      it("refuses every row for a space whose store another owner holds", async () => {
        await server.close();
        server = new Server({
          store: new URL(`memory://carried-demand-${++stores}`),
          sessionOpenAuth: { audience: AUDIENCE },
          authorizeSessionOpen: (message) =>
            (message.authorization as { principal: string }).principal,
          subscriptionRefreshDelayMs: 0,
          ownsSpace: (space: string) => space !== SOURCE,
        });
        const alice = await session(ALICE, "alice-one");

        expect(
          await server.setCarriedDemand(SOURCE, READER, [
            shared("of:far", alice),
          ]),
        ).toEqual({ refused: 1 });
      });

      it("drops the rows carried for a session when that session ends, and tells the host", async () => {
        const alice = await session(ALICE, "alice-one");
        const again = await session(ALICE, "alice-two");
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
          shared("of:near", again),
        ]);
        observe();

        sessions.remove(READER, "alice-one");

        expect(demand().map(({ id }) => id)).toEqual(["of:near"]);
        expect(told).toEqual(["session removed", `demand ${SOURCE}`]);
      });

      describe("with rows the space's own serving loop offers", () => {
        it("holds a row whose origin is a session of the space as that session's pair, though the access list gives its actor nothing", async () => {
          // A session of the space reads it already, so the grant a row
          // from another space is admitted under is not asked.

          const bob = await session(BOB, "bob-one", SOURCE);

          const { refused } = await server.setCarriedDemand(SOURCE, SOURCE, [
            own("computed:near", BOB, bob),
          ]);

          expect(refused).toBe(0);
          expect(
            demand().map(({ id, scopeKey, identity, origin }) => ({
              id,
              scopeKey,
              principal: identity?.principal,
              origin,
            })),
          ).toEqual([{
            id: "computed:near",
            scopeKey: `user:${BOB}`,
            principal: BOB,
            origin: bob,
          }]);
        });

        it("refuses a row for an actor's own instance whose origin is a session of another space, where the access list gives the actor nothing", async () => {
          const bob = await session(BOB, "bob-one");

          const { refused } = await server.setCarriedDemand(SOURCE, SOURCE, [
            own("computed:near", BOB, bob),
          ]);

          expect(refused).toBe(1);
          expect(demand()).toEqual([]);
        });

        it("withdraws the rows once the loop offers none", async () => {
          const alice = await session(ALICE, "alice-one", SOURCE);
          await server.setCarriedDemand(SOURCE, SOURCE, [
            shared("computed:near", alice),
          ]);
          expect(demand().map(({ id }) => id)).toEqual(["computed:near"]);

          await server.setCarriedDemand(SOURCE, SOURCE, []);

          expect(demand()).toEqual([]);
        });
      });
    });

    describe("demandForSessions()", () => {
      it("returns what is carried for an origin session under the id its opening was reported with", async () => {
        const alice = await session(ALICE, "alice-one");
        const opened: string[] = [];
        server.setServerExecutionObserver({
          sessionChanged: (event) => {
            if (event.space === SOURCE && event.kind === "opened") {
              opened.push(event.sessionId);
            }
          },
        });
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);

        const shares = server.demandForSessions(SOURCE, opened);

        expect(shares.map(({ sessionId }) => sessionId)).toEqual(opened);
        expect(shares.flatMap(({ rows }) => [...rows.keys()])).toHaveLength(1);
      });
    });

    describe("setServerExecutionObserver()", () => {
      it("replays what is carried into a space as an open session", async () => {
        const alice = await session(ALICE, "alice-one");
        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);
        const replayed: SessionLifecycleEvent[] = [];

        server.setServerExecutionObserver({
          sessionChanged: (event) => {
            if (event.space === SOURCE) replayed.push(event);
          },
        });

        expect(replayed).toMatchObject([{ kind: "opened", principal: ALICE }]);
        expect(server.sessionSnapshot(SOURCE)).toEqual(replayed);
      });

      it("warns when the observer throws on `demandChanged`, and still holds the row it carried", async () => {
        const alice = await session(ALICE, "alice-one");
        const failure = new Error("observer failure");
        server.setServerExecutionObserver({
          demandChanged: () => {
            throw failure;
          },
        });
        using warned = stub(console, "warn");

        await server.setCarriedDemand(SOURCE, READER, [
          shared("of:far", alice),
        ]);

        expect(warned.calls.map(({ args }) => args)).toEqual([[
          "memory v2: server-execution observer threw on demandChanged",
          failure,
        ]]);
        expect(demand().map(({ id }) => id)).toEqual(["of:far"]);
      });
    });
  });
});
