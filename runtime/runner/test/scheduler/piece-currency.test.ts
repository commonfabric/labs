import { expect } from "@std/expect";
import {
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { ANY_INSTANCE } from "@commonfabric/memory/v2/currency-keys";
import { describe, it } from "@commonfabric/test-support/test";
import type { CellScope } from "../../src/builder/types.ts";
import type { SchedulerLivenessState } from "../../src/scheduler/dependency-graph.ts";
import {
  fanOutRunFinished,
  fanOutRunOpened,
  fanOutSlotChanged,
  newFanOutNodeState,
} from "../../src/scheduler/fan-out.ts";
import {
  NodeRegistry,
  type NodeStatus,
} from "../../src/scheduler/node-record.ts";
import {
  clockDocumentKey,
  type PieceCurrencyState,
  snapshotPieceCurrency,
} from "../../src/scheduler/piece-currency.ts";
import { entityNameKey } from "../../src/scheduler/keys.ts";
import type {
  Action,
  ReactivityLog,
  SpaceScopeAndURI,
  TelemetryAnnotations,
} from "../../src/scheduler/types.ts";
import type {
  IMemorySpaceAddress,
  MemorySpace,
} from "../../src/storage/interface.ts";

const SPACE = "did:key:z6Mk-piece-currency-test-space" as MemorySpace;
const PIECE = "of:piece";
const ALICE: ScopeKeyIdentity = {
  principal: "did:key:alice",
  sessionId: "session-one",
};
const BOB: ScopeKeyIdentity = {
  principal: "did:key:bob",
  sessionId: "session-two",
};

/** One read of a run, with the space these tests' piece is in by default. */
type Read = Pick<IMemorySpaceAddress, "id"> & {
  space?: MemorySpace;
  scope?: CellScope;
  scopeKey?: ScopeKey;
};

describe("piece-currency", () => {
  /** The registry the last `snapshotOf()` built. */
  let registry: NodeRegistry;

  /** The computations that name no piece in that registry, in order. */
  let unattributedWriters: Action[];

  /**
   * A snapshot of a piece with one live computation, of `status`, that
   * declares a write of `computed:out` at `declared`. `instances` are the
   * fan-out instances the computation ran at, each resolved under its own
   * identity and holding the reads given for it, of which those in `clean`
   * are current. With none, the computation has no fan-out state, and
   * `reads` is what its one run read. `clocks` are the documents of the
   * space that a clock writes, each with the interval of the clock and the
   * tick the document holds, and `sourceSeqs` the seq the replica holds
   * each document of another space at, by id. `changed` is the latest
   * change to an instance of `computed:out`: the key the instance is at,
   * and the key of the instance whose run made it, after every instance
   * ran. `root` is the scope key of the instance of the piece's result
   * document that the runtime registered the piece under, `space` unless
   * given. Each of `unattributed` is a
   * computation that names no piece, clean and live unless it says
   * otherwise, with the document it writes and what it read. With
   * `live: false` the piece's computation is registered and not live.
   */
  const snapshotOf = (options: {
    declared?: CellScope;
    instances?: Array<
      { key: ScopeKey; identity?: ScopeKeyIdentity; reads?: Read[] }
    >;
    clean?: ScopeKey[];
    changed?: { at: ScopeKey; by: ScopeKey };
    root?: ScopeKey;
    status?: NodeStatus;
    live?: boolean;
    reads?: Read[];
    clocks?: Record<string, { intervalMs: number; tick?: number }>;
    sourceSeqs?: Record<string, number>;
    unattributed?: Array<
      { writes: Read["id"]; reads: Read[]; status?: NodeStatus; live?: boolean }
    >;
  } = {}) => {
    const instances = options.instances ?? [];
    const nodes = new NodeRegistry();
    registry = nodes;
    unattributedWriters = [];
    const action: Action & Partial<TelemetryAnnotations> = function writer() {};
    action.schedulerObservationIdentity = {
      pieceId: `${options.root ?? "space"}:${PIECE}`,
      pieceRootId: PIECE,
    };
    const node = nodes.register(action, "computation");
    nodes.setStatus(action, options.status ?? "clean");
    node.liveRefs = options.live === false ? 0 : 1;
    const logOf = (reads: Read[] = []): ReactivityLog => ({
      reads: reads.map((read) => ({
        space: SPACE,
        type: "application/json",
        path: [],
        ...read,
      } as IMemorySpaceAddress)),
      shallowReads: [],
      writes: [],
    });
    if (instances.length > 0) {
      node.fanOut = newFanOutNodeState();
      for (const { key, identity, reads } of instances) {
        node.fanOut.instances.set(key, {
          identity: identity ?? ALICE,
          log: logOf(reads),
        });
      }
      for (const key of options.clean ?? instances.map(({ key }) => key)) {
        node.fanOut.clean.add(key);
      }
      if (options.changed !== undefined) {
        const { at, by } = options.changed;
        const transaction = {};
        const run = {
          key: by,
          identity: instances.find(({ key }) => key === by)?.identity ?? ALICE,
        };
        node.fanOut.narrowed = true;
        fanOutRunOpened(node.fanOut, run, transaction);
        fanOutRunFinished(node.fanOut, run, {
          discovered: "user",
          startGen: 0,
          log: node.fanOut.instances.get(by)?.log ?? logOf([]),
          transaction,
        });
        fanOutSlotChanged(node.fanOut, at, "computed:out", transaction);
      }
    }
    const surface: IMemorySpaceAddress[] = [{
      space: SPACE,
      id: "computed:out",
      type: "application/json",
      path: [],
      scope: options.declared ?? "space",
    } as IMemorySpaceAddress];
    const dependencies = new WeakMap<Action, ReactivityLog>();
    if (options.reads !== undefined) {
      dependencies.set(action, logOf(options.reads));
    }
    const writersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
    for (const writer of options.unattributed ?? []) {
      const write: Action = function unattributedWriter() {};
      unattributedWriters.push(write);
      const written = nodes.register(write, "computation");
      nodes.setStatus(write, writer.status ?? "clean");
      written.liveRefs = writer.live === false ? 0 : 1;
      dependencies.set(write, logOf(writer.reads));
      writersByEntity.set(
        entityNameKey({ space: SPACE, id: writer.writes, scope: "space" }),
        new Set([write]),
      );
    }
    const state: PieceCurrencyState = {
      nodes,
      liveness: {
        nodes,
        materializerIndex: { isMaterializer: () => false },
      } as unknown as SchedulerLivenessState,
      dependencies,
      writeIndex: {
        writersByEntity,
        getSchedulingWrites: (of) => of === action ? surface : [],
      },
      clockDocuments: new Map(
        Object.entries(options.clocks ?? {}).map((
          [id, { intervalMs, tick }],
        ) => [
          clockDocumentKey({ space: SPACE, id: id as Read["id"] }),
          { intervalMs, read: () => tick },
        ]),
      ),
      sourceSeqOf: ({ id }) => options.sourceSeqs?.[id],
    };
    return snapshotPieceCurrency(state, SPACE, PIECE)!;
  };

  /** The slice of `snapshot` at `key`. */
  const sliceOf = (
    snapshot: ReturnType<typeof snapshotOf>,
    key: ScopeKey,
  ) => snapshot.slices.find((slice) => slice.key === key);

  /**
   * Where `computed:out` is answered for, for a computation that declares it
   * at `declared` and ran clean at `keys`: each slice that answers for an
   * instance of it, with the key that instance is at, sorted.
   */
  const answersOf = (declared: CellScope, keys: ScopeKey[] = []) =>
    snapshotOf({ declared, instances: keys.map((key) => ({ key })) }).slices
      .flatMap((slice) => [
        ...(slice.vouches.includes("computed:out")
          ? [{ slice: slice.key, at: slice.key }]
          : []),
        ...slice.decides.filter(({ id }) => id === "computed:out").map((
          { scopeKey },
        ) => ({ slice: slice.key, at: scopeKey })),
      ]).sort((a, b) =>
        `${a.slice} ${a.at}`.localeCompare(`${b.slice} ${b.at}`)
      );

  const user = resolveScopeKey("user", ALICE);
  const session = resolveScopeKey("session", ALICE);
  const bobUser = resolveScopeKey("user", BOB);

  describe("snapshotPieceCurrency()", () => {
    describe("the slice that answers for a write", () => {
      it("is the space slice for a space write, for a computation with no fan-out state", () => {
        expect(answersOf("space")).toEqual([{ slice: "space", at: "space" }]);
      });

      it("is none for a user write, for a computation with no fan-out state", () => {
        expect(answersOf("user")).toEqual([]);
      });

      it("is the run's slice, for the value and for the redirect at each broader key, for a space write of a run at a session instance", () => {
        // What the redirects hold was decided by the run, whose reads are in
        // its own slice.

        expect(answersOf("space", [session])).toEqual([
          { slice: session, at: session },
          { slice: session, at: "space" },
          { slice: session, at: user },
        ]);
      });

      it("is the space slice, for the user's instance, for a user write of a run at the space instance", () => {
        expect(answersOf("user", ["space"])).toEqual([
          { slice: "space", at: user },
        ]);
      });

      it("is the user slice, for the session's instance, for a session write of a run at a user instance", () => {
        expect(answersOf("session", [user])).toEqual([
          { slice: user, at: session },
        ]);
      });

      it("is the run's slice, for the value and for the redirect at the user's key, for a user write of a run at a session instance", () => {
        expect(answersOf("user", [session])).toEqual([
          { slice: session, at: session },
          { slice: session, at: user },
        ]);
      });
    });

    describe("the reads of a slice", () => {
      it("files each instance's reads under the slice at its key, each at the instance its identity names", () => {
        const taken = snapshotOf({
          instances: [
            {
              key: user,
              reads: [{ id: "of:prefs", scope: "user" }, { id: "of:shared" }],
            },
            {
              key: bobUser,
              identity: BOB,
              reads: [{ id: "of:prefs", scope: "user" }],
            },
          ],
        });

        expect(sliceOf(taken, user)?.reads).toEqual([
          { space: SPACE, id: "of:prefs", scopeKey: user, derived: false },
          { space: SPACE, id: "of:shared", scopeKey: "space", derived: false },
        ]);
        expect(sliceOf(taken, bobUser)?.reads).toEqual([
          { space: SPACE, id: "of:prefs", scopeKey: bobUser, derived: false },
        ]);
      });

      it("names the instance a read carries over the one its scope resolves to", () => {
        const taken = snapshotOf({
          instances: [{
            key: user,
            reads: [{ id: "of:prefs", scope: "user", scopeKey: bobUser }],
          }],
        });

        expect(sliceOf(taken, user)?.reads).toEqual([
          { space: SPACE, id: "of:prefs", scopeKey: bobUser, derived: false },
        ]);
      });

      it("names no instance for a scoped read of a run that carries no identity", () => {
        const taken = snapshotOf({
          reads: [{ id: "of:prefs", scope: "user" }],
        });

        expect(sliceOf(taken, "space")?.reads).toEqual([
          {
            space: SPACE,
            id: "of:prefs",
            scopeKey: ANY_INSTANCE,
            derived: false,
          },
        ]);
      });

      it("reports a read in another space as a reason its slice alone is not vouched for", () => {
        const taken = snapshotOf({
          instances: [
            {
              key: user,
              reads: [{
                space: "did:key:z6Mk-another-space" as MemorySpace,
                id: "of:far",
              }],
            },
            { key: bobUser, identity: BOB },
          ],
        });

        expect(sliceOf(taken, user)?.unvouched).toEqual(["foreign-read"]);
        expect(sliceOf(taken, bobUser)?.unvouched).toEqual([]);
        expect(taken.unvouched).toEqual([]);
      });

      it("names the seq of a read of another space's shared instance that the replica holds, and gives it as no reason", () => {
        const far = "did:key:z6Mk-another-space" as MemorySpace;
        const taken = snapshotOf({
          reads: [
            { space: far, id: "of:far" },
            { space: far, id: "of:prefs", scope: "user" },
          ],
          sourceSeqs: { "of:far": 7, "of:prefs": 9 },
        });

        expect(sliceOf(taken, "space")?.reads).toEqual([
          {
            space: far,
            id: "of:far",
            scopeKey: "space",
            derived: false,
            seq: 7,
          },
          {
            space: far,
            id: "of:prefs",
            scopeKey: ANY_INSTANCE,
            derived: false,
          },
        ]);
        expect(sliceOf(taken, "space")?.unvouched).toEqual(["foreign-read"]);
        expect(
          sliceOf(
            snapshotOf({
              reads: [{ space: far, id: "of:far" }],
              sourceSeqs: { "of:far": 7 },
            }),
            "space",
          )?.unvouched,
        ).toEqual([]);
      });

      it("names the seq of a read of the run's own user's instance in another space that the replica holds, and gives it as no reason", () => {
        const far = "did:key:z6Mk-another-space" as MemorySpace;
        const taken = snapshotOf({
          instances: [{
            key: user,
            reads: [{ space: far, id: "of:prefs", scope: "user" }],
          }],
          sourceSeqs: { "of:prefs": 9 },
        });

        expect(sliceOf(taken, user)?.reads).toEqual([{
          space: far,
          id: "of:prefs",
          scopeKey: user,
          derived: false,
          seq: 9,
        }]);
        expect(sliceOf(taken, user)?.unvouched).toEqual([]);
      });

      it("names the seq of a read of the run's own session's instance in another space that the replica holds, and gives it as no reason", () => {
        const far = "did:key:z6Mk-another-space" as MemorySpace;
        const taken = snapshotOf({
          instances: [{
            key: session,
            reads: [{ space: far, id: "of:draft", scope: "session" }],
          }],
          sourceSeqs: { "of:draft": 4 },
        });

        expect(sliceOf(taken, session)?.reads).toEqual([{
          space: far,
          id: "of:draft",
          scopeKey: session,
          derived: false,
          seq: 4,
        }]);
        expect(sliceOf(taken, session)?.unvouched).toEqual([]);
      });

      it("gives a slice that read a document a clock writes the tick after the one the document holds as the time it expires at, and leaves it vouched for", () => {
        const taken = snapshotOf({
          instances: [
            { key: user, reads: [{ id: "of:tick" }, { id: "of:shared" }] },
            { key: bobUser, identity: BOB, reads: [{ id: "of:shared" }] },
          ],
          clocks: { "of:tick": { intervalMs: 60_000, tick: 60_000 } },
        });

        expect(sliceOf(taken, user)?.expiresAt).toBe(120_000);
        expect(sliceOf(taken, user)?.unvouched).toEqual([]);
        expect(sliceOf(taken, bobUser)?.expiresAt).toBeUndefined();
        expect(taken.unvouched).toEqual([]);
      });

      it("gives a slice that read two clocks the earlier of the times their ticks are out of date at", () => {
        const taken = snapshotOf({
          instances: [
            { key: user, reads: [{ id: "of:minute" }, { id: "of:hour" }] },
          ],
          clocks: {
            "of:minute": { intervalMs: 60_000, tick: 3_480_000 },
            "of:hour": { intervalMs: 3_600_000, tick: 0 },
          },
        });

        expect(sliceOf(taken, user)?.expiresAt).toBe(3_540_000);
      });

      it("gives a slice that read a clock's document which holds no tick a time that has passed", () => {
        const taken = snapshotOf({
          instances: [{ key: user, reads: [{ id: "of:tick" }] }],
          clocks: { "of:tick": { intervalMs: 60_000 } },
        });

        expect(sliceOf(taken, user)?.expiresAt).toBe(0);
      });

      it("takes over what a clean writer that names no piece read, and reports the document it wrote as an input", () => {
        const taken = snapshotOf({
          reads: [{ id: "of:shared" }],
          unattributed: [{ writes: "of:shared", reads: [{ id: "of:source" }] }],
        });

        expect(sliceOf(taken, "space")).toEqual({
          key: "space",
          unvouched: [],
          reads: [
            {
              space: SPACE,
              id: "of:shared",
              scopeKey: "space",
              derived: false,
            },
            {
              space: SPACE,
              id: "of:source",
              scopeKey: "space",
              derived: false,
            },
          ],
          vouches: ["computed:out"],
          decides: [],
          superseded: [],
        });
      });

      it("takes over what a writer that names no piece read through a second such writer", () => {
        const taken = snapshotOf({
          reads: [{ id: "of:shared" }],
          unattributed: [
            { writes: "of:shared", reads: [{ id: "of:middle" }] },
            { writes: "of:middle", reads: [{ id: "of:source" }] },
          ],
        });

        expect(sliceOf(taken, "space")?.unvouched).toEqual([]);
        expect(sliceOf(taken, "space")?.reads.map((read) => read.id)).toEqual(
          ["of:shared", "of:middle", "of:source"],
        );
      });

      it("has the registry report the piece as changed when a writer that names no piece, whose output it read, has its status written", () => {
        snapshotOf({
          reads: [{ id: "of:shared" }],
          unattributed: [{
            writes: "of:shared",
            reads: [{ id: "of:source" }],
            status: "invalid",
          }],
        });
        registry.trackChangedPieces();

        registry.setStatus(unattributedWriters[0], "clean");

        expect(registry.takeChangedPieces()).toEqual([PIECE]);
      });

      it("has the registry stop reporting the piece for a writer whose output a later snapshot of it did not read", () => {
        snapshotOf({
          reads: [{ id: "of:shared" }],
          unattributed: [{ writes: "of:shared", reads: [] }],
        });
        const [before] = unattributedWriters;
        const nodes = registry;
        snapshotPieceCurrency(
          {
            nodes,
            liveness: {
              nodes,
              materializerIndex: { isMaterializer: () => false },
            } as unknown as SchedulerLivenessState,
            dependencies: new WeakMap(),
            writeIndex: {
              writersByEntity: new Map(),
              getSchedulingWrites: () => [],
            },
            clockDocuments: new Map(),
            sourceSeqOf: () => undefined,
          },
          SPACE,
          PIECE,
        );
        nodes.trackChangedPieces();

        nodes.setStatus(before, "invalid");

        expect(nodes.takeChangedPieces()).toEqual([]);
      });

      for (
        const [what, given] of [
          ["is not clean", { status: "invalid" }],
          ["is not live", { live: false }],
        ] as const
      ) {
        it(`reports a read of a document whose writer names no piece and ${what} as a reason its slice is not vouched for`, () => {
          const taken = snapshotOf({
            reads: [{ id: "of:shared" }],
            unattributed: [{
              writes: "of:shared",
              reads: [{ id: "of:source" }],
              ...given,
            }],
          });

          expect(sliceOf(taken, "space")).toEqual({
            key: "space",
            unvouched: ["unattributed-writer"],
            reads: [
              {
                space: SPACE,
                id: "of:shared",
                scopeKey: "space",
                derived: true,
              },
            ],
            vouches: ["computed:out"],
            decides: [],
            superseded: [],
          });
        });
      }
    });

    describe("a read of the output of a piece that is not started", () => {
      it("is reported for a read of a derived document no registered computation writes", () => {
        expect(snapshotOf({ reads: [{ id: "computed:far" }] }).readsUnstarted)
          .toBe(true);
      });

      it("is not reported for a read of the piece's own derived document", () => {
        expect(snapshotOf({ reads: [{ id: "computed:out" }] }).readsUnstarted)
          .toBe(false);
      });

      it("is not reported for a read of a document that is no derived one", () => {
        expect(snapshotOf({ reads: [{ id: "of:input" }] }).readsUnstarted)
          .toBe(false);
      });
    });

    describe("the scope of the piece's root", () => {
      it("is the space for a piece registered under the space's instance of its result document", () => {
        expect(snapshotOf().rootScope).toBe("space");
      });

      it("is the user's for a piece registered under a user's instance", () => {
        expect(snapshotOf({ root: user }).rootScope).toBe("user");
      });

      it("is the session's for a piece registered under a session's instance", () => {
        expect(snapshotOf({ root: session }).rootScope).toBe("session");
      });

      it("keeps no slice of the piece from being vouched for", () => {
        const taken = snapshotOf({
          root: session,
          instances: [{ key: session }],
        });

        expect(taken.unvouched).toEqual([]);
        expect(sliceOf(taken, session)?.unvouched).toEqual([]);
      });
    });

    describe("the slices it names", () => {
      it("are none for a piece whose one computation is registered and not live", () => {
        const taken = snapshotOf({ live: false, reads: [{ id: "of:input" }] });

        expect(taken.slices).toEqual([]);
        expect(taken.writes).toEqual(["computed:out"]);
      });

      it("are the `space` slice alone for a live computation with no fan-out state", () => {
        const taken = snapshotOf({ reads: [{ id: "of:input" }] });

        expect(taken.slices.map(({ key }) => key)).toEqual(["space"]);
      });

      it("are the viewers' slices, and no `space` slice, for a live computation that ran at viewers' instances alone", () => {
        const taken = snapshotOf({
          instances: [{ key: user }, { key: bobUser, identity: BOB }],
        });

        expect(taken.slices.map(({ key }) => key)).toEqual([user, bobUser]);
      });
    });

    it("reports the `space` slice of a piece with a live computation that is invalid as not clean, and vouches for nothing", () => {
      const taken = snapshotOf({ status: "invalid" });

      expect(sliceOf(taken, "space")).toEqual({
        key: "space",
        unvouched: ["not-clean"],
        reads: [],
        vouches: [],
        decides: [],
        superseded: [],
      });
    });

    it("vouches for a clean instance of a computation whose status is invalid for another instance", () => {
      const taken = snapshotOf({
        status: "invalid",
        instances: [{ key: user }, { key: bobUser, identity: BOB }],
        clean: [user],
      });

      expect(sliceOf(taken, user)).toEqual({
        key: user,
        unvouched: [],
        reads: [],
        vouches: ["computed:out"],
        decides: [{ id: "computed:out", scopeKey: "space" }],
        superseded: [],
      });
      expect(sliceOf(taken, bobUser)?.unvouched).toEqual(["not-clean"]);
    });

    it("reports the slice of a stale instance as not clean, and vouches for what the clean one wrote", () => {
      const taken = snapshotOf({
        instances: [{ key: user }, { key: bobUser, identity: BOB }],
        clean: [user],
      });

      expect(sliceOf(taken, bobUser)).toEqual({
        key: bobUser,
        unvouched: ["not-clean"],
        reads: [],
        vouches: [],
        decides: [],
        superseded: [],
      });
      expect(sliceOf(taken, user)?.unvouched).toEqual([]);
      expect(
        taken.slices.filter((slice) =>
          slice.vouches.length > 0 || slice.decides.length > 0
        ).map((slice) => slice.key),
      ).toEqual([user]);
    });

    it("names an instance at another key as decided in the slice of the run that changed it last, and as superseded in a slice whose run came before", () => {
      // Both viewers' runs write the instance at the space's key, and
      // Bob's changed it after Alice's ran: it holds what Bob's run wrote.

      const taken = snapshotOf({
        instances: [{ key: user }, { key: bobUser, identity: BOB }],
        changed: { at: "space", by: bobUser },
      });

      expect(sliceOf(taken, bobUser)?.decides).toEqual([
        { id: "computed:out", scopeKey: "space" },
      ]);
      expect(sliceOf(taken, bobUser)?.superseded).toEqual([]);
      expect(sliceOf(taken, user)?.decides).toEqual([]);
      expect(sliceOf(taken, user)?.superseded).toEqual([
        { id: "computed:out", scopeKey: "space" },
      ]);
      expect(sliceOf(taken, user)?.vouches).toEqual(["computed:out"]);
    });
  });
});
