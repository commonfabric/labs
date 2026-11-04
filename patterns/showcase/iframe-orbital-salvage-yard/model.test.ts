import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  activeSnapClaims,
  applyModuleTransforms,
  canBeginDrag,
  createSalvageModule,
  dragDisposition,
  initializeGraphics,
  isBookmarked,
  markPointerCancelled,
  moduleTransformId,
  ownsDrag,
  pointerWasCancelled,
  resolveSnapClaims,
  setBookmark,
  snapTargetKey,
  type WritableBookmarkMap,
  type WritableModuleTransform,
  writeModuleTransformField,
} from "./model.ts";
import type { ModuleSnapClaim, ModuleTransform } from "./contract.ts";
import {
  connectorIdentityKey,
  findBestSnap,
  findConnections,
} from "./geometry.ts";

const firstId = "123e4567-e89b-12d3-a456-426614174000";
const secondId = "123e4567-e89b-12d3-a456-426614174001";

describe("model", () => {
  describe("pointer drag ownership", () => {
    it("lets only the initiating pointer update and finish an active drag", () => {
      const active = { pointerId: 17 };

      expect(canBeginDrag(undefined)).toBe(true);
      expect(canBeginDrag(active)).toBe(false);
      expect(ownsDrag(active, 17)).toBe(true);
      expect(ownsDrag(active, 23)).toBe(false);
      expect(ownsDrag(undefined, 17)).toBe(false);
      expect(dragDisposition({ pointerId: 17, moved: true }, 23, false)).toBe(
        "ignore",
      );
      expect(dragDisposition({ pointerId: 17, moved: false }, 17, false)).toBe(
        "restore",
      );
      expect(dragDisposition({ pointerId: 17, moved: true }, 17, true)).toBe(
        "restore",
      );
      expect(dragDisposition({ pointerId: 17, moved: true }, 17, false)).toBe(
        "commit",
      );
    });

    it("restores when capture observes cancellation before Babylon emits pointer-up", () => {
      const cancelledPointers = new Set<number>();
      const active = { pointerId: 17, moved: true };

      markPointerCancelled(cancelledPointers, 17);

      expect(pointerWasCancelled(cancelledPointers, 17)).toBe(true);
      expect(
        dragDisposition(
          active,
          17,
          pointerWasCancelled(cancelledPointers, 17),
        ),
      ).toBe("restore");
    });
  });

  describe("transform field writes", () => {
    it("composes claim-backed position and rotation edits by stable transform ID", async () => {
      let durable: ModuleTransform | undefined;
      let released = false;
      const transform = mockTransform(
        () => durable,
        (value) => durable = value,
      );
      const transformId = moduleTransformId("mover", "claim-a");
      const effective: ModuleTransform = {
        position: [0, 1.2, 5],
        rotationQuarterTurns: 3,
      };
      const release = {
        set(value: boolean) {
          released = value;
          return Promise.resolve();
        },
      };
      await Promise.all([
        writeModuleTransformField(
          transformId,
          transform,
          undefined,
          effective,
          "position",
          [1, 1.2, 5],
          release,
        ),
        writeModuleTransformField(
          transformId,
          transform,
          undefined,
          effective,
          "rotationQuarterTurns",
          0,
          release,
        ),
      ]);

      expect(durable).toEqual({
        position: [1, 1.2, 5],
        rotationQuarterTurns: 0,
      });
      expect(released).toBe(true);
    });

    it("releases only the observed claim ID without clearing a replacement", () => {
      const observed: ModuleSnapClaim = {
        id: "claim-a",
        movingConnectorId: "port-lock",
        targetModuleId: "anchor",
        targetConnectorId: "north-lock",
        rotationQuarterTurns: 3,
      };
      const replacement: ModuleSnapClaim = {
        ...observed,
        id: "claim-b",
      };
      const releases: Record<string, boolean> = { [observed.id]: true };

      expect(activeSnapClaims({ mover: observed }, releases)).toEqual({});
      expect(activeSnapClaims({ mover: replacement }, releases)).toEqual({
        mover: replacement,
      });
      releases[replacement.id] = true;
      expect(activeSnapClaims({ mover: replacement }, releases)).toEqual({});

      const module = createSalvageModule("cargo", "mover");
      const releasedTransform: ModuleTransform = {
        position: [9, 1.2, 4],
        rotationQuarterTurns: 2,
      };
      expect(
        applyModuleTransforms(
          [module],
          {
            [moduleTransformId("mover", observed.id)]: {
              position: [1, 1.2, 1],
              rotationQuarterTurns: 0,
            },
            [moduleTransformId("mover", replacement.id)]: releasedTransform,
          },
          { mover: moduleTransformId("mover", observed.id) },
          { mover: replacement },
          releases,
        )[0].transform,
      ).toEqual(releasedTransform);
    });

    it("projects a stored transform over its stable module manifest entry", () => {
      const module = createSalvageModule("cargo", "mover");
      const transformId = moduleTransformId(module.id);
      const transform: ModuleTransform = {
        position: [4, 1.2, 7],
        rotationQuarterTurns: 2,
      };

      expect(
        applyModuleTransforms(
          [module],
          { [transformId]: transform },
          { [module.id]: transformId },
        )[0].transform,
      ).toEqual(transform);
    });
  });

  describe("connectorIdentityKey()", () => {
    it("distinguishes delimiter-like module and connector IDs", () => {
      expect(connectorIdentityKey("a", "b\u0000c")).not.toBe(
        connectorIdentityKey("a\u0000b", "c"),
      );
      expect(snapTargetKey("a", "b::c")).not.toBe(
        snapTargetKey("a::b", "c"),
      );
    });
  });

  describe("initializeGraphics()", () => {
    it("surfaces and preserves a renderer bootstrap failure", () => {
      const failure = new Error("WebGL unavailable");
      const seen: unknown[] = [];

      expect(() =>
        initializeGraphics(() => {
          throw failure;
        }, (cause) => seen.push(cause))
      ).toThrow(failure);
      expect(seen).toEqual([failure]);
    });
  });

  describe("createSalvageModule()", () => {
    it("returns the same presentation and placement for one stable ID", () => {
      expect(createSalvageModule("cargo", firstId)).toEqual(
        createSalvageModule("cargo", firstId),
      );
    });

    it("returns distinct presentation and placement for concurrent same-kind additions", () => {
      const first = createSalvageModule("cargo", firstId);
      const second = createSalvageModule("cargo", secondId);

      expect(first.label).not.toBe(second.label);
      expect(first.transform.position).not.toEqual(second.transform.position);
    });
  });

  describe("setBookmark()", () => {
    it("preserves concurrent bookmarks written from the same stale snapshot", async () => {
      const values: Record<string, boolean> = {};
      const paths: string[] = [];
      const bookmarks: WritableBookmarkMap = {
        key(moduleId) {
          paths.push(moduleId);
          return {
            set(value) {
              values[moduleId] = value;
              return Promise.resolve();
            },
          };
        },
      };

      await Promise.all([
        setBookmark(bookmarks, firstId, true),
        setBookmark(bookmarks, secondId, true),
      ]);

      expect(paths).toEqual([firstId, secondId]);
      expect(values).toEqual({ [firstId]: true, [secondId]: true });
    });

    it("writes `false` at the selected module path when removing a bookmark", async () => {
      const values: Record<string, boolean> = { [firstId]: true };
      const bookmarks: WritableBookmarkMap = {
        key(moduleId) {
          return {
            set(value) {
              values[moduleId] = value;
              return Promise.resolve();
            },
          };
        },
      };

      await setBookmark(bookmarks, firstId, false);

      expect(isBookmarked(values, firstId)).toBe(false);
    });
  });

  describe("resolveSnapClaims()", () => {
    it("gives one deterministic winner to concurrent claims on one lock", () => {
      const anchor = createSalvageModule("hub", "anchor");
      anchor.transform.position = [0, 1.2, 0];
      const first = createSalvageModule("cargo", "mover-a");
      const second = createSalvageModule("cargo", "mover-b");
      first.transform.position = [8, 1.2, 0];
      second.transform.position = [-8, 1.2, 0];
      const claims: Record<string, ModuleSnapClaim> = {
        [first.id]: {
          id: "claim-a",
          movingConnectorId: "port-lock",
          targetModuleId: anchor.id,
          targetConnectorId: "east-lock",
          rotationQuarterTurns: 0,
        },
        [second.id]: {
          id: "claim-b",
          movingConnectorId: "port-lock",
          targetModuleId: anchor.id,
          targetConnectorId: "east-lock",
          rotationQuarterTurns: 0,
        },
      };

      const forward = resolveSnapClaims(
        [anchor, first, second],
        claims,
      );
      const reversed = resolveSnapClaims(
        [second, first, anchor],
        claims,
      );

      expect(
        forward.find((module) => module.id === first.id)?.transform.position,
      )
        .toEqual([5, 1.2, 0]);
      expect(
        forward.find((module) => module.id === second.id)?.transform.position,
      )
        .toEqual([-8, 1.2, 0]);
      expect(
        reversed.find((module) => module.id === first.id)?.transform.position,
      )
        .toEqual([5, 1.2, 0]);
      expect(
        reversed.find((module) => module.id === second.id)?.transform.position,
      )
        .toEqual([-8, 1.2, 0]);
      const connections = findConnections(forward);
      expect(connections).toHaveLength(1);
      expect(
        connections.flatMap((connection) => [
          `${connection.first.moduleId}:${connection.first.id}`,
          `${connection.second.moduleId}:${connection.second.id}`,
        ]),
      ).toContain("anchor:east-lock");
    });

    it("derives an acyclic chain from each target's effective transform", () => {
      const anchor = createSalvageModule("hub", "anchor");
      anchor.transform.position = [0, 1.2, 0];
      const first = createSalvageModule("cargo", "mover-a");
      first.transform.position = [8, 1.2, 0];
      const second = createSalvageModule("cargo", "mover-b");
      second.transform.position = [14, 1.2, 0];
      const claims: Record<string, ModuleSnapClaim> = {
        [first.id]: {
          id: "claim-a",
          movingConnectorId: "port-lock",
          targetModuleId: anchor.id,
          targetConnectorId: "north-lock",
          rotationQuarterTurns: 0,
        },
        [second.id]: {
          id: "claim-b",
          movingConnectorId: "port-lock",
          targetModuleId: first.id,
          targetConnectorId: "starboard-lock",
          rotationQuarterTurns: 0,
        },
      };

      const resolved = resolveSnapClaims([second, first, anchor], claims);

      expect(resolved.find(({ id }) => id === first.id)?.transform.position)
        .toEqual([0, 1.2, 5]);
      expect(
        resolved.find(({ id }) => id === first.id)?.transform
          .rotationQuarterTurns,
      ).toBe(3);
      expect(resolved.find(({ id }) => id === second.id)?.transform.position)
        .toEqual([0, 1.2, 10.2]);
      expect(
        resolved.find(({ id }) => id === second.id)?.transform
          .rotationQuarterTurns,
      ).toBe(3);
      expect(findConnections(resolved).map(({ id }) => id)).toEqual([
        "anchor:north-lock--mover-a:port-lock",
        "mover-a:starboard-lock--mover-b:port-lock",
      ]);
    });

    it("leaves reciprocal moving-target claims unapplied", () => {
      const first = createSalvageModule("cargo", "mover-a");
      first.transform.position = [5.5, 1.2, 0];
      const second = createSalvageModule("cargo", "mover-b");
      second.transform.position = [11, 1.2, 0];
      const firstSnap = findBestSnap(first, [second], 1)!;
      const secondSnap = findBestSnap(second, [first], 1)!;
      const claims: Record<string, ModuleSnapClaim> = {
        [first.id]: claimFromSnap("claim-a", firstSnap),
        [second.id]: claimFromSnap("claim-b", secondSnap),
      };

      const resolved = resolveSnapClaims([first, second], claims);

      expect(resolved.map(({ transform }) => transform)).toEqual([
        first.transform,
        second.transform,
      ]);
      expect(findConnections(resolved)).toEqual([]);
    });
  });
});

function claimFromSnap(
  id: string,
  snap: NonNullable<ReturnType<typeof findBestSnap>>,
): ModuleSnapClaim {
  return {
    id,
    movingConnectorId: snap.movingConnectorId,
    targetModuleId: snap.targetModuleId,
    targetConnectorId: snap.targetConnectorId,
    rotationQuarterTurns: snap.transform.rotationQuarterTurns,
  };
}

function mockTransform(
  read: () => ModuleTransform | undefined,
  write: (value: ModuleTransform) => void,
): WritableModuleTransform {
  return {
    initialize(value) {
      if (!read()) write(structuredClone(value));
      return Promise.resolve(read()!);
    },
    key<Key extends keyof ModuleTransform>(key: Key) {
      return {
        set(value: ModuleTransform[Key]) {
          const current = read();
          if (!current) throw new Error("Transform was not initialized.");
          write({ ...current, [key]: structuredClone(value) });
          return Promise.resolve();
        },
      };
    },
  };
}
