import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("NodeRegistry", () => {
  describe("instance members", () => {
    describe("remove()", () => {
      it("retires the owed retry before the action is registered again", () => {
        const nodes = new NodeRegistry();
        const action: Action = function retiredRetry() {};
        const record = nodes.register(action, "computation");
        record.gate.retryOwed = true;
        nodes.remove(action);
        expect(nodes.register(action, "computation").gate.retryOwed)
          .toBeUndefined();
      });

      it("returns the removed record", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        const record = nodes.register(action, "computation");

        expect(nodes.remove(action)).toBe(record);
      });

      it("returns the record from `get()` after removal", () => {
        // The record is deliberately kept so a re-registration recovers the
        // ordinal and parent. `get()` therefore returns a record for a node
        // that is no longer scheduled, and cannot stand in for a registration
        // check.
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        nodes.register(action, "computation");
        nodes.remove(action);

        expect(nodes.get(action)).toBeDefined();
      });

      it("returns `false` from `isComputation()` after removal", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        nodes.register(action, "computation");
        expect(nodes.isComputation(action)).toBe(true);

        nodes.remove(action);

        expect(nodes.isComputation(action)).toBe(false);
      });

      it("returns `false` from `isEffect()` after removal", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removedEffect() {};
        nodes.register(action, "effect");
        expect(nodes.isEffect(action)).toBe(true);

        nodes.remove(action);

        expect(nodes.isEffect(action)).toBe(false);
      });

      it("omits the removed action from `nodes()`", () => {
        const nodes = new NodeRegistry();
        const kept: Action = function kept() {};
        const dropped: Action = function dropped() {};
        nodes.register(kept, "computation");
        nodes.register(dropped, "computation");

        nodes.remove(dropped);

        expect([...nodes.nodes()].map((record) => record.action)).toEqual([
          kept,
        ]);
      });
    });

    describe("register()", () => {
      it("keeps the first registration ordinal across a removal", () => {
        const nodes = new NodeRegistry();
        const first: Action = function first() {};
        const second: Action = function second() {};
        nodes.register(first, "computation");
        nodes.register(second, "computation");
        const ordinal = nodes.getRegistrationOrdinal(first);

        nodes.remove(first);
        nodes.register(first, "computation");

        expect(nodes.getRegistrationOrdinal(first)).toBe(ordinal);
      });

      it("promotes a computation registered again as an effect", () => {
        const nodes = new NodeRegistry();
        const action: Action = function promoted() {};
        nodes.register(action, "computation");

        expect(nodes.register(action, "effect").kind).toBe("effect");
        expect(nodes.isEffect(action)).toBe(true);
        expect(nodes.isComputation(action)).toBe(false);
      });

      it("throws for an effect registered again as a computation", () => {
        const nodes = new NodeRegistry();
        const action: Action = function demoted() {};
        nodes.register(action, "effect");

        expect(() => nodes.register(action, "computation")).toThrow(
          "Scheduler action re-registered as computation; was effect",
        );
        expect(nodes.isEffect(action)).toBe(true);
      });
    });

    describe("setStatus()", () => {
      it("indexes a registered node that becomes invalid", () => {
        const nodes = new NodeRegistry();
        const action: Action = function known() {};
        nodes.register(action, "computation");
        nodes.setStatus(action, "clean");

        nodes.setStatus(action, "invalid");

        expect(nodes.get(action)?.status).toBe("invalid");
        expect(nodes.getInvalidNodes().has(action)).toBe(true);
      });

      it("records nothing for an action that was never registered", () => {
        const nodes = new NodeRegistry();
        const action: Action = function unknown() {};

        nodes.setStatus(action, "invalid");

        expect(nodes.get(action)).toBeUndefined();
        expect(nodes.getInvalidNodes().has(action)).toBe(false);
      });
    });

    describe("linkParent()", () => {
      it("returns the parent's record and indexes the child under it", () => {
        const nodes = new NodeRegistry();
        const parent: Action = function parent() {};
        const child: Action = function child() {};
        const parentRecord = nodes.register(parent, "computation");
        const childRecord = nodes.register(child, "computation");

        expect(nodes.linkParent(child, parent)).toBe(parentRecord);
        expect(nodes.childrenOf(parent)).toEqual(new Set([childRecord]));
      });

      it("returns `undefined` and links nothing for a child that was never registered", () => {
        const nodes = new NodeRegistry();
        const parent: Action = function parent() {};
        const child: Action = function child() {};
        nodes.register(parent, "computation");

        expect(nodes.linkParent(child, parent)).toBeUndefined();
        expect(nodes.parentActionOf(child)).toBeUndefined();
        expect(nodes.childrenOf(parent)).toBeUndefined();
      });
    });

    describe("membership", () => {
      it("advances when a node joins the active set and when it leaves", () => {
        const nodes = new NodeRegistry();
        const action: Action = function member() {};
        const before = nodes.membership;

        nodes.register(action, "computation");
        const joined = nodes.membership;
        nodes.remove(action);
        const left = nodes.membership;
        nodes.register(action, "computation");

        expect([joined, left, nodes.membership]).toEqual([
          before + 1,
          before + 2,
          before + 3,
        ]);
      });

      it("stays put for a registration of an active node and a removal of an unknown one", () => {
        const nodes = new NodeRegistry();
        const action: Action = function active() {};
        nodes.register(action, "computation");
        const membership = nodes.membership;

        nodes.register(action, "effect");
        nodes.remove(function unknown() {});

        expect(nodes.membership).toBe(membership);
      });
    });

    describe("nodesUnderDemandRoots()", () => {
      const named = (
        name: string,
        identity?: { pieceRootId?: string; demandRootIds?: string[] },
      ): Action =>
        Object.assign(
          function () {} as Action,
          identity === undefined ? {} : {
            schedulerObservationIdentity: { pieceId: name, ...identity },
          },
        );

      /** What a walk of every active node finds beneath `roots`: the lookup
       * this method replaces, kept here as the reference. */
      const walk = (nodes: NodeRegistry, roots: string[]) =>
        [...nodes.nodes()].filter((record) => {
          const identity = (record.action as {
            schedulerObservationIdentity?: {
              pieceRootId?: string;
              demandRootIds?: readonly string[];
            };
          }).schedulerObservationIdentity;
          const ids = identity?.demandRootIds ??
            (identity?.pieceRootId !== undefined ? [identity.pieceRootId] : []);
          return ids.some((id) => roots.includes(id));
        });

      it("returns the nodes whose action names a root, by `demandRootIds` or else by `pieceRootId`", () => {
        const nodes = new NodeRegistry();
        const glazed = nodes.register(
          named("glazed", { pieceRootId: "tray" }),
          "computation",
        );
        const filled = nodes.register(
          named("filled", {
            pieceRootId: "box",
            demandRootIds: ["tray", "box"],
          }),
          "effect",
        );
        nodes.register(named("plain"), "computation");
        nodes.register(
          named("cruller", { pieceRootId: "rack" }),
          "computation",
        );

        expect(nodes.nodesUnderDemandRoots(["tray"])).toEqual([glazed, filled]);
        expect(nodes.nodesUnderDemandRoots(["box"])).toEqual([filled]);
        expect(nodes.nodesUnderDemandRoots(["counter"])).toEqual([]);
      });

      it("goes by `demandRootIds` alone where an action names any, so its `pieceRootId` is not a root of its own", () => {
        const nodes = new NodeRegistry();
        nodes.register(
          named("filled", { pieceRootId: "box", demandRootIds: ["tray"] }),
          "computation",
        );
        nodes.register(
          named("empty", { pieceRootId: "box", demandRootIds: [] }),
          "computation",
        );

        expect(nodes.nodesUnderDemandRoots(["box"])).toEqual([]);
      });

      it("returns a node once when it names several of the roots, in the order `nodes()` yields", () => {
        const nodes = new NodeRegistry();
        const first = nodes.register(
          named("first", { demandRootIds: ["tray", "box", "tray"] }),
          "computation",
        );
        const second = nodes.register(
          named("second", { pieceRootId: "box" }),
          "computation",
        );
        // Removed and registered again, `first` joins the active set after
        // `second`, which is where `nodes()` now yields it.
        nodes.remove(first.action);
        nodes.register(first.action, "computation");

        expect(nodes.nodesUnderDemandRoots(["tray", "box"])).toEqual([
          second,
          first,
        ]);
        expect([...nodes.nodes()]).toEqual([second, first]);
      });

      it("keeps one root's nodes in the order `nodes()` yields after one of them is filed again", () => {
        // Filed again, a node lands behind the ones that joined after it,
        // and the lookup has to put it back where `nodes()` has it.
        const nodes = new NodeRegistry();
        const first = named("first", { pieceRootId: "tray" });
        const firstRecord = nodes.register(first, "computation");
        const secondRecord = nodes.register(
          named("second", { pieceRootId: "tray" }),
          "computation",
        );

        (first as { schedulerObservationIdentity?: unknown })
          .schedulerObservationIdentity = {
            pieceId: "first",
            demandRootIds: ["tray", "box"],
          };
        nodes.noteObservationIdentity(first);

        expect(nodes.nodesUnderDemandRoots(["tray"])).toEqual([
          firstRecord,
          secondRecord,
        ]);
        expect(nodes.nodesUnderDemandRoots(["box"])).toEqual([firstRecord]);
      });

      it("drops a removed node, and returns it again once registered, under the roots it names then", () => {
        const nodes = new NodeRegistry();
        const action = named("glazed", { pieceRootId: "tray" });
        const record = nodes.register(action, "computation");

        nodes.remove(action);
        expect(nodes.nodesUnderDemandRoots(["tray"])).toEqual([]);

        (action as { schedulerObservationIdentity?: unknown })
          .schedulerObservationIdentity = {
            pieceId: "glazed",
            pieceRootId: "box",
          };
        nodes.register(action, "computation");
        expect(nodes.nodesUnderDemandRoots(["tray"])).toEqual([]);
        expect(nodes.nodesUnderDemandRoots(["box"])).toEqual([record]);
      });

      it("follows an identity set on an active node once `noteObservationIdentity()` says so", () => {
        const nodes = new NodeRegistry();
        const action = named("glazed", { pieceRootId: "tray" });
        const record = nodes.register(action, "computation");

        (action as { schedulerObservationIdentity?: unknown })
          .schedulerObservationIdentity = {
            pieceId: "glazed",
            pieceRootId: "box",
          };
        nodes.noteObservationIdentity(action);

        expect(nodes.nodesUnderDemandRoots(["tray"])).toEqual([]);
        expect(nodes.nodesUnderDemandRoots(["box"])).toEqual([record]);
      });

      it("returns what a walk of every active node finds, through registrations, removals, and identities set", () => {
        // A fixed sequence from a small generator, so a failure names a step.
        let seed = 20261116;
        const next = (below: number) => {
          // `Math.imul` keeps the product in 32 bits; a plain `*` loses the
          // low bits and the sequence stops moving.
          seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
          return (seed >>> 16) % below;
        };
        const roots = ["tray", "box", "rack", "counter"];
        const pick = () => roots[next(roots.length)];
        const nodes = new NodeRegistry();
        const actions = Array.from({ length: 24 }, (_, i) => named(`a${i}`));
        const identify = (action: Action) => {
          const shape = next(4);
          (action as { schedulerObservationIdentity?: unknown })
            .schedulerObservationIdentity = shape === 0
              ? undefined
              : shape === 1
              ? { pieceId: "p", pieceRootId: pick() }
              : shape === 2
              ? { pieceId: "p", pieceRootId: pick(), demandRootIds: [pick()] }
              : { pieceId: "p", demandRootIds: [pick(), pick(), pick()] };
        };
        const done = [0, 0, 0, 0];
        let found = 0;
        for (let step = 0; step < 600; step++) {
          const action = actions[next(actions.length)];
          const what = next(4);
          done[what]++;
          if (what === 0) {
            // What a subscription does: sets the identity, tells the
            // registry, and registers. A record keeps its kind across
            // removal, and an effect is never registered again as a
            // computation.
            identify(action);
            nodes.noteObservationIdentity(action);
            nodes.register(
              action,
              nodes.get(action)?.kind ??
                (next(2) === 0 ? "computation" : "effect"),
            );
          } else if (what === 1) {
            nodes.remove(action);
          } else if (what === 2) {
            identify(action);
            nodes.noteObservationIdentity(action);
          } else {
            // A registration of an action that may already be active.
            nodes.register(action, nodes.get(action)?.kind ?? "computation");
          }
          for (const asked of [[pick()], [pick(), pick()], roots]) {
            const under = nodes.nodesUnderDemandRoots(asked);
            found += under.length;
            expect([step, asked, under]).toEqual([
              step,
              asked,
              walk(nodes, asked),
            ]);
          }
          for (const root of roots) {
            expect([step, root, nodes.hasNodesUnderDemandRoot(root)]).toEqual([
              step,
              root,
              walk(nodes, [root]).length > 0,
            ]);
          }
        }
        // The sequence did each kind of step and the lookups found nodes, so
        // the comparison above was not of empty lists.
        expect(done.every((count) => count > 100)).toBe(true);
        expect(found).toBeGreaterThan(1000);
      });

      it("differs from the walk for an identity set on an active node that it was not told of", () => {
        // The reference above is only a check if it can fail. An identity
        // changed behind the registry's back is the case the index cannot
        // see, which is why the scheduler tells it of every one it sets.
        const nodes = new NodeRegistry();
        const action = named("glazed", { pieceRootId: "tray" });
        nodes.register(action, "computation");

        (action as { schedulerObservationIdentity?: unknown })
          .schedulerObservationIdentity = {
            pieceId: "glazed",
            pieceRootId: "box",
          };

        expect(walk(nodes, ["box"]).length).toBe(1);
        expect(nodes.nodesUnderDemandRoots(["box"])).toEqual([]);
      });
    });
  });
});
