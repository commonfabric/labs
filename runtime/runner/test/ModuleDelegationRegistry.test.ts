import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { ModuleDelegationRegistry } from "../src/module-delegations.ts";

const spaceA = "did:key:z6MkModuleDelegationRegistrySpaceA";
const spaceB = "did:key:z6MkModuleDelegationRegistrySpaceB";

const delegations = (
  entries: Record<string, readonly string[]>,
): Map<string, Set<string>> =>
  new Map(
    Object.entries(entries).map(([identity, predecessors]) => [
      identity,
      new Set(predecessors),
    ]),
  );

describe("ModuleDelegationRegistry", () => {
  let registry: ModuleDelegationRegistry;

  beforeEach(() => {
    registry = new ModuleDelegationRegistry();
  });

  describe("instance members", () => {
    describe("register()", () => {
      it("publishes a snapshot holding each successor's transitive predecessors, sorted", () => {
        registry.register(
          spaceA,
          delegations({
            successor: ["predecessor"],
            predecessor: ["zeta", "ancestor"],
          }),
        );

        const space = registry.snapshot.get(spaceA)!;
        expect(space.get("successor")).toEqual([
          "ancestor",
          "predecessor",
          "zeta",
        ]);
        expect(space.get("predecessor")).toEqual(["ancestor", "zeta"]);
        expect(space.has("ancestor")).toBe(false);
      });

      it("keeps the published snapshot, by identity and by content, when the delegations add nothing", () => {
        registry.register(spaceA, delegations({ successor: ["predecessor"] }));
        const published = registry.snapshot;

        registry.register(spaceA, delegations({ successor: ["predecessor"] }));
        registry.register(
          spaceA,
          delegations({
            "": ["ignored"],
            successor: ["", "successor"],
          }),
        );
        registry.register("" as MemorySpace, delegations({ x: ["y"] }));

        expect(registry.snapshot).toBe(published);
        expect(registry.snapshot.get(spaceA)?.get("successor")).toEqual([
          "predecessor",
        ]);
        expect(registry.snapshot.has("" as MemorySpace)).toBe(false);
      });

      it("rebuilds the registering space's entries and shares every other space's with the snapshot before", () => {
        registry.register(spaceA, delegations({ successor: ["predecessor"] }));
        const before = registry.snapshot;

        registry.register(spaceB, delegations({ other: ["elder"] }));

        const after = registry.snapshot;
        expect(after).not.toBe(before);
        expect(after.get(spaceA)).toBe(before.get(spaceA));
        expect(after.get(spaceB)?.get("other")).toEqual(["elder"]);
        expect(after.get(spaceB)?.has("successor")).toBe(false);
        expect(before.has(spaceB)).toBe(false);
      });

      it("extends a successor's closure in a new snapshot and leaves the published one as it was", () => {
        registry.register(spaceA, delegations({ successor: ["first"] }));
        const before = registry.snapshot;

        registry.register(spaceA, delegations({ first: ["origin"] }));

        expect(registry.snapshot.get(spaceA)?.get("successor")).toEqual([
          "first",
          "origin",
        ]);
        expect(before.get(spaceA)?.get("successor")).toEqual(["first"]);
        expect(before.get(spaceA)?.has("first")).toBe(false);
      });

      it("leaves an identity out of its own closure through a cycle", () => {
        registry.register(
          spaceA,
          delegations({
            successor: ["predecessor"],
            predecessor: ["successor"],
          }),
        );

        expect(registry.snapshot.get(spaceA)?.get("successor")).toEqual([
          "predecessor",
        ]);
        expect(registry.snapshot.get(spaceA)?.get("predecessor")).toEqual([
          "successor",
        ]);
      });
    });

    describe("grants()", () => {
      it("returns `true` for a direct or inherited predecessor in the registering space only", () => {
        registry.register(
          spaceA,
          delegations({
            successor: ["predecessor"],
            predecessor: ["ancestor"],
          }),
        );

        expect(registry.grants(spaceA, "successor", "predecessor")).toBe(true);
        expect(registry.grants(spaceA, "successor", "ancestor")).toBe(true);
        expect(registry.grants(spaceA, "ancestor", "successor")).toBe(false);
        expect(registry.grants(spaceA, "successor", "stranger")).toBe(false);
        expect(registry.grants(spaceA, "successor", "successor")).toBe(false);
        expect(registry.grants(spaceB, "successor", "predecessor")).toBe(false);
      });
    });

    describe("snapshotWith()", () => {
      it("returns the published snapshot with the proposal layered over its space, sharing the others", () => {
        registry.register(spaceA, delegations({ previous: ["ancestor"] }));
        registry.register(spaceB, delegations({ other: ["elder"] }));
        const published = registry.snapshot;

        const layered = registry.snapshotWith(
          spaceA,
          delegations({ candidate: ["previous"] }),
        );

        expect(layered).not.toBe(published);
        expect(layered.get(spaceA)?.get("candidate")).toEqual([
          "ancestor",
          "previous",
        ]);
        expect(layered.get(spaceA)?.get("previous")).toEqual(["ancestor"]);
        expect(layered.get(spaceB)).toBe(published.get(spaceB));
        expect(registry.snapshot).toBe(published);
        expect(published.get(spaceA)?.has("candidate")).toBe(false);
        expect(registry.grants(spaceA, "candidate", "previous")).toBe(false);
      });

      it("returns the published snapshot itself when the proposal adds nothing", () => {
        registry.register(spaceA, delegations({ previous: ["ancestor"] }));

        expect(
          registry.snapshotWith(
            spaceA,
            delegations({ previous: ["ancestor"] }),
          ),
        ).toBe(registry.snapshot);
        expect(registry.snapshotWith(spaceA, new Map())).toBe(
          registry.snapshot,
        );
      });

      it("layers a proposal for a space with nothing registered", () => {
        const layered = registry.snapshotWith(
          spaceA,
          delegations({ candidate: ["previous"] }),
        );

        expect(layered.get(spaceA)?.get("candidate")).toEqual(["previous"]);
        expect(registry.snapshot.size).toBe(0);
      });
    });

    describe("getSizes()", () => {
      it("counts spaces, identities, direct predecessor entries, and snapshots built", () => {
        expect(registry.getSizes()).toEqual({
          spaces: 0,
          identities: 0,
          predecessors: 0,
          snapshotBuilds: 0,
        });

        registry.register(
          spaceA,
          delegations({
            successor: ["predecessor", "other"],
            predecessor: ["ancestor"],
          }),
        );
        registry.register(
          spaceA,
          delegations({
            successor: ["predecessor"],
          }),
        );
        registry.register(spaceB, delegations({ other: ["elder"] }));
        registry.snapshotWith(spaceB, delegations({ candidate: ["other"] }));
        registry.snapshotWith(spaceB, delegations({ other: ["elder"] }));

        expect(registry.getSizes()).toEqual({
          spaces: 2,
          identities: 3,
          predecessors: 4,
          snapshotBuilds: 3,
        });
      });
    });
  });
});
