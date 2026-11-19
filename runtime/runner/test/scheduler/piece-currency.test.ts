import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import type { CellScope } from "../../src/builder/types.ts";
import type { SchedulerLivenessState } from "../../src/scheduler/dependency-graph.ts";
import { newFanOutNodeState } from "../../src/scheduler/fan-out.ts";
import {
  NodeRegistry,
  type NodeStatus,
} from "../../src/scheduler/node-record.ts";
import {
  type PieceCurrencyState,
  snapshotPieceCurrency,
} from "../../src/scheduler/piece-currency.ts";
import type {
  Action,
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

describe("piece-currency", () => {
  /**
   * A snapshot of a piece with one live computation, of `status`, that
   * declares a write of `computed:out` at `declared`. `instances` are the fan-out
   * instances the computation ran at, each resolved under `ALICE`, of which
   * those in `clean` are current; with none, the computation has no fan-out
   * state.
   */
  const snapshotOf = (
    declared: CellScope,
    instances: ScopeKey[] = [],
    clean: ScopeKey[] = instances,
    status: NodeStatus = "clean",
  ) => {
    const nodes = new NodeRegistry();
    const action: Action & Partial<TelemetryAnnotations> = function writer() {};
    action.schedulerObservationIdentity = {
      pieceId: `space:${PIECE}`,
      pieceRootId: PIECE,
    };
    const node = nodes.register(action, "computation");
    nodes.setStatus(action, status);
    node.liveRefs = 1;
    if (instances.length > 0) {
      node.fanOut = newFanOutNodeState();
      for (const key of instances) {
        node.fanOut.instances.set(key, { identity: ALICE });
      }
      for (const key of clean) node.fanOut.clean.add(key);
    }
    const surface: IMemorySpaceAddress[] = [{
      space: SPACE,
      id: "computed:out",
      type: "application/json",
      path: [],
      scope: declared,
    } as IMemorySpaceAddress];
    const state: PieceCurrencyState = {
      nodes,
      liveness: {
        nodes,
        materializerIndex: { isMaterializer: () => false },
      } as unknown as SchedulerLivenessState,
      dependencies: new WeakMap(),
      writeIndex: {
        writersByEntity: new Map(),
        getSchedulingWrites: () => surface,
      },
    };
    return snapshotPieceCurrency(state, SPACE, PIECE)!;
  };

  /** The scope keys `snapshotOf()` vouches for, sorted. */
  const vouchesOf = (...parts: Parameters<typeof snapshotOf>) =>
    snapshotOf(...parts).vouches.map(({ scopeKey }) => scopeKey).sort();

  const user = resolveScopeKey("user", ALICE);
  const session = resolveScopeKey("session", ALICE);

  describe("snapshotPieceCurrency()", () => {
    describe("the instances it vouches for", () => {
      it("is the space instance of a space write, for a computation with no fan-out state", () => {
        expect(vouchesOf("space")).toEqual(["space"]);
      });

      it("is empty for a user write, for a computation with no fan-out state", () => {
        expect(vouchesOf("user")).toEqual([]);
      });

      it("is the run's instance and each broader slot, for a space write of a run at a session instance", () => {
        expect(vouchesOf("space", [session])).toEqual(
          [session, "space", user].sort(),
        );
      });

      it("is the run's user's instance alone, for a user write of a run at the space instance", () => {
        expect(vouchesOf("user", ["space"])).toEqual([user]);
      });

      it("is the run's session's instance alone, for a session write of a run at a user instance", () => {
        expect(vouchesOf("session", [user])).toEqual([session]);
      });

      it("is the run's instance and the user slot, for a user write of a run at a session instance", () => {
        expect(vouchesOf("user", [session])).toEqual([session, user].sort());
      });
    });

    it("reports a piece with a live computation that is invalid as not clean, and vouches for nothing", () => {
      const taken = snapshotOf("space", [], [], "invalid");

      expect(taken.unvouched).toEqual(["not-clean"]);
      expect(taken.vouches).toEqual([]);
    });

    it("reports a piece whose computation is stale in one instance as not clean, and vouches for nothing", () => {
      const taken = snapshotOf("space", [user, session], [user]);

      expect(taken.unvouched).toEqual(["not-clean"]);
      expect(taken.vouches).toEqual([]);
    });
  });
});
