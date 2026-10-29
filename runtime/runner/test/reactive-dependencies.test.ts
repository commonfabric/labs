import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import {
  FabricError,
  FabricMap,
} from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { MemorySpace } from "@commonfabric/memory/interface";

import {
  addressesToPathByEntity,
  arraysOverlap,
  determineTriggeredActions,
  sortAndCompactPaths,
  type SortedAndCompactPaths,
} from "../src/reactive-dependencies.ts";
import type { Action, SpaceScopeAndURI } from "../src/scheduler.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "../src/storage/interface.ts";

// Helper function to create IMemorySpaceAddress for testing
const createAddress = (
  path: MemoryAddressPathComponent[],
  space: MemorySpace = "did:test:space",
  id: string = "https://example.com/entity",
  type: string = "application/json",
): IMemorySpaceAddress => ({
  space,
  id: id as `${string}:${string}`, // URI type alias
  type: type as `${string}/${string}`, // MediaType type alias
  scope: "space",
  path,
});

// Helper to create multiple addresses with the same space/id/type but different paths
const createAddresses = (
  paths: MemoryAddressPathComponent[][],
  space: MemorySpace = "did:test:space",
  id: string = "https://example.com/entity",
  type: string = "application/json",
): IMemorySpaceAddress[] =>
  paths.map((path) => createAddress(path, space, id, type));

describe("arraysOverlap", () => {
  it("returns true when arrays are identical", () => {
    expect(arraysOverlap(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
    expect(arraysOverlap([], [])).toBe(true);
    expect(arraysOverlap(["single"], ["single"])).toBe(true);
  });

  it("returns true when first array is prefix of second", () => {
    expect(arraysOverlap(["a"], ["a", "b", "c"])).toBe(true);
    expect(arraysOverlap(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(arraysOverlap([], ["a", "b", "c"])).toBe(true); // empty array is prefix of any array
  });

  it("returns true when second array is prefix of first", () => {
    expect(arraysOverlap(["a", "b", "c"], ["a"])).toBe(true);
    expect(arraysOverlap(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(arraysOverlap(["a", "b", "c"], [])).toBe(true); // empty array is prefix of any array
  });

  it("returns false when arrays don't overlap", () => {
    expect(arraysOverlap(["a", "b"], ["c", "d"])).toBe(false);
    expect(arraysOverlap(["a", "b"], ["a", "c"])).toBe(false);
    expect(arraysOverlap(["x"], ["y"])).toBe(false);
  });

  it("returns false when arrays share common prefix but diverge", () => {
    expect(arraysOverlap(["a", "b", "c"], ["a", "b", "d"])).toBe(false);
    expect(arraysOverlap(["users", "123"], ["users", "456"])).toBe(false);
    expect(arraysOverlap(["path", "to", "x"], ["path", "to", "y"])).toBe(false);
  });

  it("handles arrays of different lengths correctly", () => {
    // Shorter array is prefix of longer
    expect(arraysOverlap(["users"], ["users", "123", "profile", "name"])).toBe(
      true,
    );
    expect(arraysOverlap(["users", "123"], ["users", "123", "profile"])).toBe(
      true,
    );

    // Longer array is not prefix of shorter when they differ
    expect(arraysOverlap(["users", "123", "profile"], ["users", "456"])).toBe(
      false,
    );
  });

  it("works with numeric strings", () => {
    expect(arraysOverlap(["123"], ["123", "456"])).toBe(true);
    expect(arraysOverlap(["123", "456"], ["123"])).toBe(true);
    expect(arraysOverlap(["123"], ["456"])).toBe(false);
  });

  it("handles edge cases", () => {
    // One empty array
    expect(arraysOverlap([], ["a"])).toBe(true);
    expect(arraysOverlap(["a"], [])).toBe(true);

    // Arrays with undefined or null (if they can occur)
    expect(arraysOverlap(["a", "b"], ["a", "b", "c"])).toBe(true);
  });

  it("respects exact string matching", () => {
    // Different strings that might be similar
    expect(arraysOverlap(["user"], ["users"])).toBe(false);
    expect(arraysOverlap(["123"], ["1234"])).toBe(false);
    expect(arraysOverlap(["User"], ["user"])).toBe(false); // case sensitive
  });

  it("demonstrates the bug fix scenario", () => {
    // The bug was that when startPath is longer than some dependency paths,
    // those dependencies were incorrectly ignored. This test shows the correct behavior.
    const shortPath = ["users"];
    const mediumPath = ["users", "123"];
    const longPath = ["users", "123", "profile"];
    const startPath = ["users", "123"];

    // All these should overlap with startPath
    expect(arraysOverlap(shortPath, startPath)).toBe(true); // shortPath is prefix of startPath
    expect(arraysOverlap(mediumPath, startPath)).toBe(true); // exact match
    expect(arraysOverlap(longPath, startPath)).toBe(true); // startPath is prefix of longPath

    // The function should work symmetrically
    expect(arraysOverlap(startPath, shortPath)).toBe(true);
    expect(arraysOverlap(startPath, mediumPath)).toBe(true);
    expect(arraysOverlap(startPath, longPath)).toBe(true);
  });
});

describe("sortAndCompactPaths", () => {
  it("returns empty array for empty input", () => {
    const result = sortAndCompactPaths([]);
    expect(result).toEqual([]);
  });

  it("returns single path unchanged", () => {
    const addresses = createAddresses([["a", "b", "c"]]);
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual(addresses);
  });

  it("sorts paths lexicographically", () => {
    const addresses = createAddresses([
      ["b", "c"],
      ["a", "z"],
      ["a", "b"],
      ["c"],
    ]);
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual(createAddresses([
      ["a", "b"],
      ["a", "z"],
      ["b", "c"],
      ["c"],
    ]));
  });

  it("removes paths that are prefixes of other paths", () => {
    const addresses = createAddresses([
      ["a", "b", "c", "d"],
      ["a", "b"],
      ["a", "b", "c"],
      ["x", "y"],
    ]);
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual(createAddresses([
      ["a", "b"],
      ["x", "y"],
    ]));
  });

  it("handles complex compactification", () => {
    const addresses = createAddresses([
      ["users", "123", "name"],
      ["users", "123"],
      ["users", "456", "email"],
      ["users", "456"],
      ["posts", "abc", "title"],
      ["posts"],
    ]);
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual(createAddresses([
      ["posts"],
      ["users", "123"],
      ["users", "456"],
    ]));
  });

  it("preserves paths with common prefixes but different suffixes", () => {
    const addresses = createAddresses([
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "e"],
    ]);
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual(createAddresses([
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "e"],
    ]));
  });

  it("handles paths with numeric strings correctly", () => {
    const addresses = createAddresses([
      ["2", "b"],
      ["10", "a"],
      ["1", "c"],
    ]);
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual(createAddresses([
      ["1", "c"],
      ["10", "a"],
      ["2", "b"],
    ]));
  });

  it("sorts by space, id, then path", () => {
    const addresses: IMemorySpaceAddress[] = [
      createAddress(
        ["a"],
        "did:test:space2",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["b"],
        "did:test:space1",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["c"],
        "did:test:space1",
        "test://entity2",
        "application/json",
      ),
      createAddress(
        ["d"],
        "did:test:space1",
        "test://entity1",
        "application/json",
      ),
      createAddress(["e"], "did:test:space1", "test://entity1", "text/plain"),
      createAddress(
        ["f"],
        "did:test:space1",
        "test://entity1",
        "application/json",
      ),
    ];
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual([
      createAddress(
        ["b"],
        "did:test:space1",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["d"],
        "did:test:space1",
        "test://entity1",
        "application/json",
      ),
      createAddress(["e"], "did:test:space1", "test://entity1", "text/plain"),
      createAddress(
        ["f"],
        "did:test:space1",
        "test://entity1",
        "application/json",
      ),
      createAddress(
        ["c"],
        "did:test:space1",
        "test://entity2",
        "application/json",
      ),
      createAddress(
        ["a"],
        "did:test:space2",
        "test://entity",
        "application/json",
      ),
    ]);
  });

  describe("compactifyChildren = false", () => {
    it("preserves child paths", () => {
      const addresses = createAddresses([["a"], ["a", "b"], ["a", "b", "c"]]);
      const result = sortAndCompactPaths(addresses, false);
      expect(result).toEqual(addresses);
    });

    it("still removes exact duplicates", () => {
      const addresses = createAddresses([
        ["a", "b"],
        ["a", "b"],
        ["a", "c"],
      ]);
      const result = sortAndCompactPaths(addresses, false);
      expect(result).toEqual(createAddresses([["a", "b"], ["a", "c"]]));
    });
  });

  it("only compacts paths within same space/id/type", () => {
    const addresses: IMemorySpaceAddress[] = [
      createAddress(
        ["user"],
        "did:test:space1",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["user", "name"],
        "did:test:space1",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["user"],
        "did:test:space2",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["user", "name"],
        "did:test:space2",
        "test://entity",
        "application/json",
      ),
    ];
    const result = sortAndCompactPaths(addresses);
    expect(result).toEqual([
      createAddress(
        ["user"],
        "did:test:space1",
        "test://entity",
        "application/json",
      ),
      createAddress(
        ["user"],
        "did:test:space2",
        "test://entity",
        "application/json",
      ),
    ]);
  });
});

// Identity entity keys resolve scoped addresses against (stage E); the
// space-scoped addresses in these tests are identity-independent.
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

describe("addresssesToPathByEntity", () => {
  it("returns empty map for empty input", () => {
    const result = addressesToPathByEntity([], TEST_IDENTITY);
    expect(result.size).toBe(0);
  });

  it("groups paths by space and id", () => {
    const addresses: IMemorySpaceAddress[] = [
      createAddress(
        ["a"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/json",
      ),
      createAddress(
        ["b"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/json",
      ),
      createAddress(
        ["c"],
        "did:test:space1",
        "https://example.com/entity2",
        "application/json",
      ),
      createAddress(
        ["d"],
        "did:test:space2",
        "https://example.com/entity1",
        "application/json",
      ),
    ];

    const result = addressesToPathByEntity(addresses, TEST_IDENTITY);

    expect(result.size).toBe(3);
    expect(
      result.has(
        "did:test:space1/space/https://example.com/entity1" as SpaceScopeAndURI,
      ),
    ).toBe(true);
    expect(
      result.has(
        "did:test:space1/space/https://example.com/entity2" as SpaceScopeAndURI,
      ),
    ).toBe(true);
    expect(
      result.has(
        "did:test:space2/space/https://example.com/entity1" as SpaceScopeAndURI,
      ),
    ).toBe(true);

    const space1Entity1 = result.get(
      "did:test:space1/space/https://example.com/entity1" as SpaceScopeAndURI,
    )!;
    expect(space1Entity1).toHaveLength(2);
    expect(space1Entity1[0]).toEqual(["a"]);
    expect(space1Entity1[1]).toEqual(["b"]);

    const space1Entity2 = result.get(
      "did:test:space1/space/https://example.com/entity2" as SpaceScopeAndURI,
    )!;
    expect(space1Entity2).toHaveLength(1);
    expect(space1Entity2[0]).toEqual(["c"]);

    const space2Entity1 = result.get(
      "did:test:space2/space/https://example.com/entity1" as SpaceScopeAndURI,
    )!;
    expect(space2Entity1).toHaveLength(1);
    expect(space2Entity1[0]).toEqual(["d"]);
  });

  it("groups document addresses without considering type", () => {
    const addresses: IMemorySpaceAddress[] = [
      createAddress(
        ["a"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/json",
      ),
      createAddress(
        ["b"],
        "did:test:space1",
        "https://example.com/entity1",
        "text/plain",
      ),
      createAddress(
        ["c"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/xml",
      ),
      createAddress(
        ["d"],
        "did:test:space1",
        "https://example.com/entity2",
        "application/json",
      ),
    ];

    const result = addressesToPathByEntity(addresses, TEST_IDENTITY);

    expect(result.size).toBe(2);

    const space1Entity1 = result.get(
      "did:test:space1/space/https://example.com/entity1" as SpaceScopeAndURI,
    )!;
    expect(space1Entity1).toHaveLength(3);
    expect(space1Entity1[0]).toEqual(["a"]);
    expect(space1Entity1[1]).toEqual(["b"]);
    expect(space1Entity1[2]).toEqual(["c"]);

    const space1Entity2 = result.get(
      "did:test:space1/space/https://example.com/entity2" as SpaceScopeAndURI,
    )!;
    expect(space1Entity2).toHaveLength(1);
    expect(space1Entity2[0]).toEqual(["d"]);
  });

  it("preserves order of paths within each entity", () => {
    const addresses: IMemorySpaceAddress[] = [
      createAddress(
        ["z"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/json",
      ),
      createAddress(
        ["a"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/json",
      ),
      createAddress(
        ["m"],
        "did:test:space1",
        "https://example.com/entity1",
        "application/json",
      ),
    ];

    const result = addressesToPathByEntity(addresses, TEST_IDENTITY);

    const paths = result.get(
      "did:test:space1/space/https://example.com/entity1" as SpaceScopeAndURI,
    )!;
    expect(paths).toHaveLength(3);
    expect(paths[0]).toEqual(["z"]);
    expect(paths[1]).toEqual(["a"]);
    expect(paths[2]).toEqual(["m"]);
  });

  it("handles complex scenario with multiple spaces and entities", () => {
    const addresses: IMemorySpaceAddress[] = [
      // Space 1, Entity 1
      createAddress(
        ["users", "123"],
        "did:test:space1",
        "https://api.example.com/data",
        "application/json",
      ),
      createAddress(
        ["users", "456"],
        "did:test:space1",
        "https://api.example.com/data",
        "application/json",
      ),
      createAddress(
        ["posts"],
        "did:test:space1",
        "https://api.example.com/data",
        "application/json",
      ),

      // Space 1, Entity 2
      createAddress(
        ["config"],
        "did:test:space1",
        "https://api.example.com/settings",
        "application/json",
      ),
      createAddress(
        ["theme"],
        "did:test:space1",
        "https://api.example.com/settings",
        "text/plain",
      ),

      // Space 2, Entity 1 (same URI as space1 but different space)
      createAddress(
        ["users", "789"],
        "did:test:space2",
        "https://api.example.com/data",
        "application/json",
      ),

      // Space 2, Entity 3
      createAddress(
        ["analytics"],
        "did:test:space2",
        "https://api.example.com/metrics",
        "application/json",
      ),
    ];

    const result = addressesToPathByEntity(addresses, TEST_IDENTITY);

    expect(result.size).toBe(4);

    // Check Space 1, Entity 1
    const s1e1 = result.get(
      "did:test:space1/space/https://api.example.com/data" as SpaceScopeAndURI,
    )!;
    expect(s1e1).toHaveLength(3);
    expect(s1e1).toEqual([
      ["users", "123"],
      ["users", "456"],
      ["posts"],
    ]);

    // Check Space 1, Entity 2
    const s1e2 = result.get(
      "did:test:space1/space/https://api.example.com/settings" as SpaceScopeAndURI,
    )!;
    expect(s1e2).toHaveLength(2);
    expect(s1e2[0]).toEqual(["config"]);
    expect(s1e2[1]).toEqual(["theme"]);

    // Check Space 2, Entity 1
    const s2e1 = result.get(
      "did:test:space2/space/https://api.example.com/data" as SpaceScopeAndURI,
    )!;
    expect(s2e1).toHaveLength(1);
    expect(s2e1[0]).toEqual(["users", "789"]);

    // Check Space 2, Entity 3
    const s2e3 = result.get(
      "did:test:space2/space/https://api.example.com/metrics" as SpaceScopeAndURI,
    )!;
    expect(s2e3).toHaveLength(1);
    expect(s2e3[0]).toEqual(["analytics"]);
  });
});

describe("determineTriggeredActions", () => {
  // Helper to create mock actions
  const createAction = (id: string): Action => ({
    schedule: () => {},
    name: id,
  } as unknown as Action);

  describe("basic functionality", () => {
    it("returns empty array when no dependencies", () => {
      const dependencies = new Map<Action, SortedAndCompactPaths>();
      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 2 },
      );
      expect(result).toEqual([]);
    });

    it("triggers action when simple path value changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 2 },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger action when value remains the same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 1 },
      );
      expect(result).toEqual([]);
    });

    it("triggers multiple actions for same path", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
        [action2, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 2 },
      );
      expect(result).toContain(action1);
      expect(result).toContain(action2);
      expect(result).toHaveLength(2);
    });
  });

  describe("nested paths", () => {
    it("triggers on nested path changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice", age: 30 } },
        { user: { name: "Bob", age: 30 } },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers on deeply nested path changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b", "c", "d"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: { b: { c: { d: 1 } } } },
        { a: { b: { c: { d: 2 } } } },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when nested value unchanged", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice", age: 30 } },
        { user: { name: "Alice", age: 31 } },
      );
      expect(result).toEqual([]);
    });

    it("triggers parent path when child changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice" } },
        { user: { name: "Bob" } },
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("multiple paths per action", () => {
    it("triggers when any watched path changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"], ["b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1, b: 2 },
        { a: 1, b: 3 },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers only once even if multiple paths change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"], ["b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1, b: 2 },
        { a: 2, b: 3 },
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("undefined and null handling", () => {
    it("triggers when value becomes undefined", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: undefined },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers when undefined becomes value", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        undefined,
        { a: 1 },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers when path doesn't exist in before", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { x: 1 },
        { a: { b: 2 } },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers when path doesn't exist in after", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: { b: 2 } },
        { x: 1 },
      );
      expect(result).toEqual([action1]);
    });

    it("handles null values correctly", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: null },
        { a: null },
      );
      expect(result).toEqual([]);
    });

    it("triggers when null changes to value", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: null },
        { a: 1 },
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("array handling", () => {
    it("triggers on array element change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items", "0"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b", "c"] },
        { items: ["x", "b", "c"] },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers on array length change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b"] },
        { items: ["a", "b", "c"] },
      );
      expect(result).toEqual([action1]);
    });

    it("handles array index paths correctly", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items", "1", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: [{ name: "a" }, { name: "b" }] },
        { items: [{ name: "a" }, { name: "c" }] },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger on non-existent array index", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items", "5"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b"] },
        { items: ["x", "y"] },
      );
      expect(result).toEqual([]);
    });
  });

  describe("startPath parameter", () => {
    it("filters dependencies based on startPath", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
        [action2, [["post", "title"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice" }, post: { title: "Hello" } },
        { user: { name: "Bob" }, post: { title: "Hello" } },
        ["user"],
      );
      expect(result).toEqual([action1]);
    });

    it("handles nested startPath correctly", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b", "c"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: { b: { c: 1 } } },
        { a: { b: { c: 2 } } },
        ["a", "b"],
      );
      expect(result).toEqual([action1]);
    });

    it("returns empty when startPath doesn't match any dependencies", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { post: { title: "Old" }, user: { name: "Alice" } },
        { post: { title: "New" }, user: { name: "Alice" } },
        ["post"],
      );
      expect(result).toEqual([]);
    });

    it("handles multiple levels with startPath", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["users", "123", "profile", "name"]]],
        [action2, [["users", "123", "settings"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        {
          users: {
            "123": { profile: { name: "Alice" }, settings: { theme: "dark" } },
          },
        },
        {
          users: {
            "123": { profile: { name: "Bob" }, settings: { theme: "dark" } },
          },
        },
        ["users", "123"],
      );
      expect(result).toEqual([action1]);
    });

    it("works with undefined data and startPath", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        undefined,
        { a: { b: 1 } },
        ["a"],
      );
      expect(result).toEqual([action1]);
    });

    it("triggers actions with paths shorter than startPath", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const action3 = createAction("action3");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["users"]]], // Shorter than startPath
        [action2, [["users", "123"]]], // Same length as startPath
        [action3, [["users", "123", "profile"]]], // Longer than startPath
      ]);

      const result = determineTriggeredActions(
        dependencies,
        {
          users: {
            "123": {
              profile: { name: "Alice" },
              settings: { theme: "dark" },
            },
          },
        },
        {
          users: {
            "123": {
              profile: { name: "Alice Updated" }, // Changed
              settings: { theme: "dark" },
            },
          },
        },
        ["users", "123"],
      );

      // All three actions should trigger because:
      // - action1 watches ["users"] which is a parent of the startPath
      // - action2 watches ["users", "123"] which matches the startPath
      // - action3 watches ["users", "123", "profile"] which changed
      expect(result).toContain(action1);
      expect(result).toContain(action2);
      expect(result).toContain(action3);
      expect(result).toHaveLength(3);
    });

    it("handles startPath longer than all dependency paths", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
        [action2, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        {
          a: {
            b: {
              c: {
                d: "old value",
              },
            },
          },
        },
        {
          a: {
            b: {
              c: {
                d: "new value",
              },
            },
          },
        },
        ["a", "b", "c", "d"], // StartPath is deeper than any dependency
      );

      // Both actions should trigger because they watch ancestor paths
      expect(result).toContain(action1);
      expect(result).toContain(action2);
      expect(result).toHaveLength(2);
    });
  });

  describe("edge cases", () => {
    it("handles empty object to empty object", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        {},
        {},
      );
      expect(result).toEqual([]);
    });

    it("handles complex object equality", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data"]]],
      ]);

      const obj = { x: { y: { z: [1, 2, 3] } } };
      const result = determineTriggeredActions(
        dependencies,
        { data: obj },
        { data: obj },
      );
      expect(result).toEqual([]);
    });

    it("detects deep object changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { data: { x: { y: { z: [1, 2, 3] } } } },
        { data: { x: { y: { z: [1, 2, 4] } } } },
      );
      expect(result).toEqual([action1]);
    });

    it("handles mixed primitive types", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["value"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { value: "123" },
        { value: 123 },
      );
      expect(result).toEqual([action1]);
    });

    it("handles boolean values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["flag"]]],
      ]);

      const result1 = determineTriggeredActions(
        dependencies,
        { flag: true },
        { flag: false },
      );
      expect(result1).toEqual([action1]);

      const result2 = determineTriggeredActions(
        dependencies,
        { flag: true },
        { flag: true },
      );
      expect(result2).toEqual([]);
    });
  });

  describe("literal values", () => {
    it("triggers when number value changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["count"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { count: 42 },
        { count: 43 },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when number value stays the same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["count"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { count: 42 },
        { count: 42 },
      );
      expect(result).toEqual([]);
    });

    it("triggers when string value changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["message"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { message: "hello" },
        { message: "world" },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when string value stays the same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["message"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { message: "hello" },
        { message: "hello" },
      );
      expect(result).toEqual([]);
    });

    it("handles root-level number values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        42,
        43,
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when root-level number stays same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        42,
        42,
      );
      expect(result).toEqual([]);
    });

    it("handles root-level string values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        "before",
        "after",
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when root-level string stays same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        "hello",
        "hello",
      );
      expect(result).toEqual([]);
    });

    it("handles root-level boolean values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        true,
        false,
      );
      expect(result).toEqual([action1]);
    });

    it("handles root-level null values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        null,
        "value",
      );
      expect(result).toEqual([action1]);
    });

    it("handles changing from literal to object", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        42,
        { value: 42 },
      );
      expect(result).toEqual([action1]);
    });

    it("handles changing from object to literal", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { value: 42 },
        42,
      );
      expect(result).toEqual([action1]);
    });

    it("ignores path dependencies when data is literal", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["field"]]],
      ]);

      // Since data is literal, path ["field"] doesn't exist
      const result = determineTriggeredActions(
        dependencies,
        42,
        43,
      );
      expect(result).toEqual([]);
    });

    it("handles mixed literal types at nested paths", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const action3 = createAction("action3");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "age"]]],
        [action2, [["user", "name"]]],
        [action3, [["user", "active"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { age: 25, name: "Alice", active: true } },
        { user: { age: 26, name: "Alice", active: false } },
      );
      expect(result).toContain(action1); // age changed
      expect(result).not.toContain(action2); // name stayed same
      expect(result).toContain(action3); // active changed
    });
  });

  describe("array values", () => {
    it("triggers when array changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["numbers"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { numbers: [1, 2, 3] },
        { numbers: [1, 2, 3, 4] },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when array stays the same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["numbers"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { numbers: [1, 2, 3] },
        { numbers: [1, 2, 3] },
      );
      expect(result).toEqual([]);
    });

    it("triggers when array element order changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b", "c"] },
        { items: ["c", "b", "a"] },
      );
      expect(result).toEqual([action1]);
    });

    it("handles root-level array values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        [1, 2, 3],
        [1, 2, 3, 4],
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when root-level array stays same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        [1, 2, 3],
        [1, 2, 3],
      );
      expect(result).toEqual([]);
    });

    it("triggers on root-level array element change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        ["a", "b", "c"],
        ["a", "x", "c"],
      );
      expect(result).toEqual([action1]);
    });

    it("handles specific index dependency on root-level array", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["1"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        ["a", "b", "c"],
        ["a", "x", "c"],
      );
      expect(result).toEqual([action1]);
    });

    it("handles changing from array to non-array", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [[]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        [1, 2, 3],
        "not an array",
      );
      expect(result).toEqual([action1]);
    });

    it("handles empty arrays", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items"]]],
      ]);

      const result1 = determineTriggeredActions(
        dependencies,
        { items: [] },
        { items: [1] },
      );
      expect(result1).toEqual([action1]);

      const result2 = determineTriggeredActions(
        dependencies,
        { items: [1] },
        { items: [] },
      );
      expect(result2).toEqual([action1]);

      const result3 = determineTriggeredActions(
        dependencies,
        { items: [] },
        { items: [] },
      );
      expect(result3).toEqual([]);
    });

    it("handles arrays of mixed types", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["mixed"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { mixed: [1, "two", true, null] },
        { mixed: [1, "two", false, null] },
      );
      expect(result).toEqual([action1]);
    });

    it("handles arrays of objects", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["users"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] },
        { users: [{ id: 1, name: "Alice" }, { id: 2, name: "Charlie" }] },
      );
      expect(result).toEqual([action1]);
    });

    it("handles nested arrays", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["matrix"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { matrix: [[1, 2], [3, 4]] },
        { matrix: [[1, 2], [3, 5]] },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers on specific array index with literal value", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["scores", "2"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { scores: [10, 20, 30, 40] },
        { scores: [10, 20, 35, 40] },
      );
      expect(result).toEqual([action1]);
    });

    it("handles arrays at multiple levels", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data", "items"]]],
        [action2, [["data", "tags"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        {
          data: {
            items: [1, 2, 3],
            tags: ["red", "blue"],
          },
        },
        {
          data: {
            items: [1, 2, 3],
            tags: ["red", "green"],
          },
        },
      );
      expect(result).toEqual([action2]); // only tags changed
    });
  });

  describe("performance and stress tests", () => {
    it("handles many dependencies efficiently", () => {
      const actions: Action[] = [];
      const dependencies = new Map<Action, SortedAndCompactPaths>();

      // Create 1000 actions with different paths
      for (let i = 0; i < 1000; i++) {
        const action = createAction(`action${i}`);
        actions.push(action);
        dependencies.set(action, [[`item${i}`]]);
      }

      const before: FabricValue = {};
      const after: FabricValue = {};
      for (let i = 0; i < 1000; i++) {
        (before as any)[`item${i}`] = i;
        (after as any)[`item${i}`] = i;
      }
      // Change one value
      (after as any).item500 = "changed";

      const startTime = performance.now();
      const result = determineTriggeredActions(dependencies, before, after);
      const endTime = performance.now();

      expect(result).toEqual([actions[500]]);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast
    });

    it("handles deeply nested paths efficiently", () => {
      const action1 = createAction("action1");
      const deepPath = Array.from({ length: 20 }, (_, i) => `level${i}`);
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [deepPath]],
      ]);

      // Create deeply nested objects
      const before: any = {};
      const after: any = {};
      let currentBefore = before;
      let currentAfter = after;
      for (let i = 0; i < deepPath.length - 1; i++) {
        currentBefore[deepPath[i]] = {};
        currentAfter[deepPath[i]] = {};
        currentBefore = currentBefore[deepPath[i]];
        currentAfter = currentAfter[deepPath[i]];
      }
      currentBefore[deepPath[deepPath.length - 1]] = "before";
      currentAfter[deepPath[deepPath.length - 1]] = "after";

      const result = determineTriggeredActions(dependencies, before, after);
      expect(result).toEqual([action1]);
    });

    it("handles many paths per action", () => {
      const action1 = createAction("action1");
      const paths: SortedAndCompactPaths = Array.from(
        { length: 100 },
        (_, i) => [`field${i}`],
      );
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, paths],
      ]);

      const before: any = {};
      const after: any = {};
      for (let i = 0; i < 100; i++) {
        before[`field${i}`] = i;
        after[`field${i}`] = i;
      }
      after.field50 = "changed";

      const result = determineTriggeredActions(dependencies, before, after);
      expect(result).toEqual([action1]);
    });
  });

  describe("bug: action should trigger when intermediate path appears", () => {
    it("triggers when intermediate path appears even if final value remains undefined", () => {
      // Bug scenario:
      // Action B watches ["a", "b", "c"]
      // Before: { a: {} } - no 'b' key, so path a.b.c is "unreachable"
      // After: { a: { b: { x: 1 } } } - 'b' exists but no 'c' key
      //
      // In both cases the final value at a.b.c is undefined, BUT:
      // - Before: we couldn't traverse past 'a' because 'b' doesn't exist
      // - After: we can traverse to 'b', but 'c' doesn't exist there
      //
      // This structural change should trigger the action, because the
      // "reachability" of the path changed.
      const actionB = createAction("actionB");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [actionB, [["a", "b", "c"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: {} },
        { a: { b: { x: 1 } } },
      );

      // Action B should trigger because the path structure changed
      expect(result).toContain(actionB);
    });

    it("real-world case: triggers when __#0 key appears in internal", () => {
      // Simplified version of the real bug from production
      // Action B watches a path through __#0.pieceRegistry
      // Before: internal doesn't have __#0
      // After: internal has __#0 (but no pieceRegistry inside)
      const actionA = createAction("actionA");
      const actionB = createAction("actionB");
      const actionC = createAction("actionC");

      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [actionA, [
          ["value", "internal", "$NAME"],
          ["value", "internal", "$alias", "path"],
          ["value", "internal", "/", "link@1"],
          ["value", "internal", "cell", "/"],
        ]],
        [actionB, [
          ["value", "internal", "$alias", "path"],
          ["value", "internal", "/", "link@1"],
          ["value", "internal", "__#0", "pieceRegistry"],
          ["value", "internal", "cell", "/"],
        ]],
        [actionC, [
          ["value", "internal", "$alias", "path"],
          ["value", "internal", "/", "link@1"],
          ["value", "internal", "__#0", "pieceRegistry"],
          ["value", "internal", "cell", "/"],
        ]],
      ]);

      const before = {
        value: {
          internal: {
            backlinksIndex: { "/": { "link@1": { path: [], id: "of:123" } } },
            "__#2": { "/": { "link@1": { path: [], id: "of:456" } } },
            // Note: NO __#0 key
          },
        },
      };

      const after = {
        value: {
          internal: {
            backlinksIndex: { "/": { "link@1": { path: [], id: "of:123" } } },
            "__#2": { "/": { "link@1": { path: [], id: "of:456" } } },
            // __#0 now exists! (but doesn't have pieceRegistry)
            "__#0": {
              "/": {
                "link@1": { path: [], id: "of:789", space: "did:key:abc" },
              },
            },
          },
        },
      };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
      );

      // Action B and C should trigger because __#0 appeared,
      // even though pieceRegistry is still undefined in both cases
      expect(result).toContain(actionB);
      expect(result).toContain(actionC);
      // Action A should NOT trigger (none of its paths changed)
      expect(result).not.toContain(actionA);
    });
  });

  describe("complex scenarios", () => {
    it("handles multiple actions with different nested dependencies", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const action3 = createAction("action3");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user"]]], // Watches entire user object
        [action2, [["user", "profile", "name"]]], // Watches specific nested field
        [action3, [["user", "settings"]]], // Watches different branch
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { profile: { name: "Alice", age: 30 }, settings: {} } },
        { user: { profile: { name: "Bob", age: 30 }, settings: {} } },
      );

      expect(result).toContain(action1); // Should trigger because user.profile changed
      expect(result).toContain(action2); // Should trigger because user.profile.name changed
      expect(result).not.toContain(action3); // Should not trigger because user.settings didn't change
    });

    it("does not trigger sibling key reader when a new key is added to an object", () => {
      const actionA = createAction("actionA");
      const actionB = createAction("actionB");
      const actionC = createAction("actionC");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [actionA, [["obj", "existing"]]], // Watches the unchanged sibling key
        [actionB, [["obj", "newKey"]]], // Watches the newly added key
        [actionC, [["obj"]]], // Watches the whole object
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { obj: { existing: 42 } },
        { obj: { existing: 42, newKey: "hello" } },
      );

      expect(result).not.toContain(actionA); // sibling key unchanged, must not trigger
      expect(result).toContain(actionB); // newly added key, must trigger
      expect(result).toContain(actionC); // whole object changed, must trigger
    });

    it("handles type changes in nested structures", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data", "value"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { data: { value: { nested: true } } },
        { data: { value: "string" } },
      );
      expect(result).toEqual([action1]);
    });

    it("handles array to object conversion", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { data: [1, 2, 3] },
        { data: { "0": 1, "1": 2, "2": 3 } },
      );
      expect(result).toEqual([action1]);
    });

    it("handles complex real-world scenario", () => {
      const userPrefsAction = createAction("userPrefsAction");
      const userNameAction = createAction("userNameAction");
      const featuredPostsAction = createAction("featuredPostsAction");
      const recentPostsAction = createAction("recentPostsAction");
      const unreadCountAction = createAction("unreadCountAction");
      const notificationItemsAction = createAction("notificationItemsAction");
      const settingsAction = createAction("settingsAction");
      const analyticsAction = createAction("analyticsAction");

      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [userPrefsAction, [["currentUser", "preferences"]]],
        [userNameAction, [["currentUser", "name"]]],
        [featuredPostsAction, [["posts", "featured"]]],
        [recentPostsAction, [["posts", "recent"]]],
        [unreadCountAction, [["notifications", "unread"]]],
        [notificationItemsAction, [["notifications", "items"]]],
        [settingsAction, [["settings"]]],
        [analyticsAction, [["analytics", "pageViews"], [
          "analytics",
          "sessions",
        ]]],
      ]);

      const before = {
        currentUser: {
          id: "123",
          name: "Alice",
          preferences: { theme: "light", language: "en" },
          lastLogin: "2024-01-01",
        },
        posts: {
          featured: ["post1", "post2"],
          recent: ["post3", "post4"],
          drafts: [],
        },
        notifications: {
          unread: 5,
          items: [],
          settings: { email: true, push: false },
        },
        settings: {
          privacy: "public",
          autoSave: true,
        },
        analytics: {
          pageViews: 1000,
          sessions: 50,
          bounceRate: 0.3,
        },
      };

      const after = {
        currentUser: {
          id: "123",
          name: "Alice", // Same name
          preferences: { theme: "dark", language: "en" }, // Theme changed
          lastLogin: "2024-01-02", // Changed but not watched
        },
        posts: {
          featured: ["post1", "post2"], // Same featured posts
          recent: ["post3", "post4", "post5"], // Added a new recent post
          drafts: ["draft1"], // Changed but not watched
        },
        notifications: {
          unread: 6, // Incremented
          items: [{ id: "n1" }], // Added new item
          settings: { email: false, push: false }, // Changed but not watched
        },
        settings: {
          privacy: "public", // Same
          autoSave: true, // Same
        },
        analytics: {
          pageViews: 1250, // Changed
          sessions: 50, // Same
          bounceRate: 0.25, // Changed but not watched
        },
      };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
      );

      // Should trigger
      expect(result).toContain(userPrefsAction); // preferences.theme changed
      expect(result).toContain(recentPostsAction); // posts.recent changed
      expect(result).toContain(unreadCountAction); // notifications.unread changed
      expect(result).toContain(notificationItemsAction); // notifications.items changed
      expect(result).toContain(analyticsAction); // analytics.pageViews changed

      // Should NOT trigger
      expect(result).not.toContain(userNameAction); // name didn't change
      expect(result).not.toContain(featuredPostsAction); // featured posts didn't change
      expect(result).not.toContain(settingsAction); // settings didn't change
    });
  });

  describe("non-recursive reads", () => {
    it("does not trigger on child value updates for non-recursive reads", () => {
      const action = createAction("nonRecursiveChildUpdate");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: { existing: 1 } } };
      const after = { value: { a: { existing: 2 } } };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
        ["value", "a", "existing"],
        { nonRecursive: true },
      );
      expect(result).toEqual([]);
    });

    it("triggers when a child write creates a new key for non-recursive reads", () => {
      const action = createAction("nonRecursiveNewChildKey");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: { existing: 1 } } };
      const after = { value: { a: { existing: 1, added: 2 } } };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
        ["value", "a", "added"],
        { nonRecursive: true },
      );
      expect(result).toEqual([action]);
    });

    it("triggers when a child write removes a key for non-recursive reads", () => {
      const action = createAction("nonRecursiveNewChildKey");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: { existing: 1, added: 2 } } };
      const after = { value: { a: { existing: 1 } } };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
        ["value", "a", "added"],
        { nonRecursive: true },
      );
      expect(result).toEqual([action]);
    });

    it("does not trigger a read below a special object that was replaced", () => {
      // A special object is not key-able: no property name reaches its state,
      // so the descent stops at one and a read below it is unreachable on
      // both sides rather than present-and-empty.

      const action = createAction("readBelowSpecialObject");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "b"]]],
      ]);
      const before = { value: { a: new FabricBytes(new Uint8Array([1])) } };
      const after = { value: { a: new FabricBytes(new Uint8Array([2])) } };

      const result = determineTriggeredActions(dependencies, before, after);
      expect(result).toEqual([]);
    });

    it("does not trigger a read below a scalar that became a special object", () => {
      // The reachability verdict follows the value's kind and not its
      // `typeof`: `value.a.b` was absent before and is absent after, because
      // a path does not address anything inside a leaf, whatever kind of leaf
      // it is.

      const action = createAction("scalarBecameSpecialObject");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "b"]]],
      ]);
      const before = { value: { a: 1 } };
      const after = { value: { a: new FabricBytes(new Uint8Array([1])) } };

      const result = determineTriggeredActions(dependencies, before, after);
      expect(result).toEqual([]);
    });

    it("propagates the failure from a leaf it cannot compare", () => {
      // A read landing on a special object has to compare it, and a class
      // whose comparison is an unimplemented stub cannot. That failure is left
      // to propagate rather than being caught and turned into "unchanged",
      // which would report a changed value as unchanged. The descent is a
      // separate question and does not decide this one: `isKeyable()` returns
      // `true` for the `FabricMap` here, so the walk reaches it by descending
      // rather than by stopping short.

      const action = createAction("nonRecursiveUncomparableLeaf");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: new FabricMap(new Map([["k", 1]])) } };
      const after = { value: { a: new FabricMap(new Map([["k", 2]])) } };

      expect(() =>
        determineTriggeredActions(
          dependencies,
          before,
          after,
          ["value", "a"],
          { nonRecursive: true },
        )
      ).toThrow("`FabricMap`: not yet implemented");
    });

    it("triggers a read below an instance replaced by a scalar", () => {
      // `value.a.b` is reachable while `a` is a container and absent once it
      // is a scalar, so the two sides stop at different depths and the read
      // is triggered. The same holds for each transition below.

      const action = createAction("instanceToScalar");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "b"]]],
      ]);
      const before = { value: { a: new FabricMap(new Map([["b", 1]])) } };
      const after = { value: { a: 5 } };

      expect(determineTriggeredActions(dependencies, before, after))
        .toEqual([action]);
    });

    it("triggers a read below an instance that was deleted", () => {
      const action = createAction("instanceDeleted");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "b"]]],
      ]);
      const before = { value: { a: new FabricMap(new Map([["b", 1]])) } };
      const after = { value: {} };

      expect(determineTriggeredActions(dependencies, before, after))
        .toEqual([action]);
    });

    it("triggers a read below a scalar replaced by an instance", () => {
      const action = createAction("scalarToInstance");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "b"]]],
      ]);
      const before = { value: { a: 5 } };
      const after = { value: { a: new FabricMap(new Map([["b", 1]])) } };

      expect(determineTriggeredActions(dependencies, before, after))
        .toEqual([action]);
    });

    it("triggers a read below an error that was deleted", () => {
      const action = createAction("errorDeleted");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "message"]]],
      ]);
      const before = {
        value: { a: FabricError.fromNativeError(new Error("boom")) },
      };
      const after = { value: {} };

      expect(determineTriggeredActions(dependencies, before, after))
        .toEqual([action]);
    });

    it("triggers a read of a property an error carries when it changes", () => {
      // A `FabricInstance` is not stateless with respect to property names:
      // `FabricError` reaches `message`, `name` and `type` through prototype
      // accessors, so a descent through one reads values rather than vacancy.

      const action = createAction("errorMessageChanged");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a", "message"]]],
      ]);
      const before = {
        value: { a: FabricError.fromNativeError(new Error("boom one")) },
      };
      const after = {
        value: { a: FabricError.fromNativeError(new Error("boom two")) },
      };

      expect(determineTriggeredActions(dependencies, before, after))
        .toEqual([action]);
    });

    it("triggers on a special object replaced at the read's own path", () => {
      const action = createAction("nonRecursiveSpecialLeaf");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: new FabricBytes(new Uint8Array([1])) } };
      const after = { value: { a: new FabricBytes(new Uint8Array([2])) } };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
        ["value", "a"],
        { nonRecursive: true },
      );
      expect(result).toEqual([action]);
    });

    it("triggers on same-path write for non-recursive reads", () => {
      const action = createAction("nonRecursiveSamePathWrite");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: 1 } };
      const after = { value: { a: 2 } };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
        ["value", "a"],
        { nonRecursive: true },
      );
      expect(result).toEqual([action]);
    });

    it("non-recursive and recursive reads of same path respond differently to a deep child write", () => {
      // A recursive reader subscribes to ["value", "a"] and should be woken up
      // when a deeply nested value changes. A non-recursive reader of the same
      // path only cares about changes to the direct keys of the object at that
      // path, so updating an existing nested value should leave it unaffected.
      const recursiveAction = createAction("recursive");
      const nonRecursiveAction = createAction("nonRecursive");

      const before = { value: { a: { existing: 1 } } };
      const after = { value: { a: { existing: 2 } } };

      const recursiveResult = determineTriggeredActions(
        new Map([[recursiveAction, [["value", "a"]]]]),
        before,
        after,
        ["value", "a", "existing"],
      );
      expect(recursiveResult).toEqual([recursiveAction]);

      const nonRecursiveResult = determineTriggeredActions(
        new Map([[nonRecursiveAction, [["value", "a"]]]]),
        before,
        after,
        ["value", "a", "existing"],
        { nonRecursive: true },
      );
      expect(nonRecursiveResult).toEqual([]);
    });

    it("still triggers on parent writes that change for non-recursive reads", () => {
      const action = createAction("nonRecursiveParentWrite");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action, [["value", "a"]]],
      ]);
      const before = { value: { a: { b: 1 }, x: 1 } };
      const after = { value: { a: [], x: 2 } };

      const result = determineTriggeredActions(
        dependencies,
        before,
        after,
        ["value"],
        { nonRecursive: true },
      );
      expect(result).toEqual([action]);
    });
  });
});

//
// Benchmarks
//

Deno.bench("sortAndCompactPaths - small dataset", () => {
  const addresses = createAddresses([
    ["user", "name"],
    ["user"],
    ["posts", "0", "title"],
    ["posts"],
    ["settings", "theme"],
  ]);
  sortAndCompactPaths(addresses);
});

Deno.bench("sortAndCompactPaths - large dataset", () => {
  const paths: MemoryAddressPathComponent[][] = [];
  for (let i = 0; i < 1000; i++) {
    paths.push([`field${i}`]);
    if (i % 10 === 0) {
      paths.push([`field${i}`, "nested"]);
      paths.push([`field${i}`, "nested", "deep"]);
    }
  }
  const addresses = createAddresses(paths);
  sortAndCompactPaths(addresses);
});

Deno.bench("sortAndCompactPaths - deeply nested paths", () => {
  const paths: MemoryAddressPathComponent[][] = [];
  for (let i = 0; i < 100; i++) {
    const depth = Math.floor(Math.random() * 10) + 1;
    const path = Array.from({ length: depth }, (_, j) => `level${j}`);
    paths.push(path);
  }
  const addresses = createAddresses(paths);
  sortAndCompactPaths(addresses);
});

Deno.bench("sortAndCompactPaths - multiple spaces/ids/types", () => {
  const addresses: IMemorySpaceAddress[] = [];
  const spaces = [
    "did:test:space1",
    "did:test:space2",
    "did:test:space3",
  ] as MemorySpace[];
  const ids = ["test://entity1", "test://entity2", "test://entity3"];
  const types = ["application/json", "text/plain", "application/xml"];

  for (let i = 0; i < 100; i++) {
    const space = spaces[i % 3];
    const id = ids[Math.floor(i / 3) % 3];
    const type = types[Math.floor(i / 9) % 3];
    addresses.push(createAddress([`field${i}`], space, id, type));
    if (i % 5 === 0) {
      addresses.push(createAddress([`field${i}`, "nested"], space, id, type));
    }
  }
  sortAndCompactPaths(addresses);
});

Deno.bench("determineTriggeredActions - simple change", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, [["user", "name"]]],
  ]);

  determineTriggeredActions(
    dependencies,
    { user: { name: "Alice", age: 30 } },
    { user: { name: "Bob", age: 30 } },
  );
});

Deno.bench("determineTriggeredActions - no changes", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, [["user", "name"]]],
  ]);

  const data = { user: { name: "Alice", age: 30 } };
  determineTriggeredActions(dependencies, data, data);
});

Deno.bench("determineTriggeredActions - many dependencies", () => {
  const dependencies = new Map<Action, SortedAndCompactPaths>();
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};

  for (let i = 0; i < 100; i++) {
    const action = {
      schedule: () => {},
      name: `action${i}`,
    } as unknown as Action;
    dependencies.set(action, [[`field${i}`]]);
    before[`field${i}`] = i;
    after[`field${i}`] = i;
  }
  // Change one field
  after.field50 = -1;

  determineTriggeredActions(
    dependencies,
    before,
    after,
  );
});

Deno.bench("determineTriggeredActions - deep nesting", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const deepPath = Array.from({ length: 10 }, (_, i) => `level${i}`);
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, [deepPath]],
  ]);

  // Create deeply nested objects
  const createNested = (value: string) => {
    let result: any = value;
    for (let i = deepPath.length - 1; i >= 0; i--) {
      result = { [deepPath[i]]: result };
    }
    return result;
  };

  determineTriggeredActions(
    dependencies,
    createNested("before"),
    createNested("after"),
  );
});

Deno.bench("determineTriggeredActions - multiple paths per action", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const paths: SortedAndCompactPaths = Array.from(
    { length: 20 },
    (_, i) => [`field${i}`],
  );
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, paths],
  ]);

  const before: any = {};
  const after: any = {};
  for (let i = 0; i < 20; i++) {
    before[`field${i}`] = i;
    after[`field${i}`] = i;
  }
  after.field10 = "changed";

  determineTriggeredActions(dependencies, before, after);
});

Deno.bench("determineTriggeredActions - complex real-world", () => {
  const dependencies = new Map<Action, SortedAndCompactPaths>();

  // Simulate a real app with various watchers
  const actions = [
    { paths: [["currentUser"]], name: "userWatcher" },
    { paths: [["currentUser", "preferences"]], name: "prefsWatcher" },
    { paths: [["posts"]], name: "postsWatcher" },
    {
      paths: [["posts", "0"], ["posts", "1"], ["posts", "2"]],
      name: "topPostsWatcher",
    },
    { paths: [["notifications", "unread"]], name: "unreadWatcher" },
    { paths: [["ui", "theme"]], name: "themeWatcher" },
    { paths: [["ui", "sidebar", "collapsed"]], name: "sidebarWatcher" },
  ];

  for (const { paths, name } of actions) {
    const action = { schedule: () => {}, name } as unknown as Action;
    dependencies.set(action, paths);
  }

  const before = {
    currentUser: {
      id: "123",
      name: "Alice",
      preferences: { theme: "light", notifications: true },
    },
    posts: [
      { id: "p1", title: "Post 1", likes: 10 },
      { id: "p2", title: "Post 2", likes: 20 },
      { id: "p3", title: "Post 3", likes: 30 },
    ],
    notifications: { unread: 5, items: [] },
    ui: {
      theme: "light",
      sidebar: { collapsed: false, width: 250 },
    },
  };

  const after = {
    currentUser: {
      id: "123",
      name: "Alice",
      preferences: { theme: "dark", notifications: true },
    },
    posts: [
      { id: "p1", title: "Post 1", likes: 11 },
      { id: "p2", title: "Post 2", likes: 20 },
      { id: "p3", title: "Post 3", likes: 30 },
    ],
    notifications: { unread: 6, items: [{ id: "n1" }] },
    ui: {
      theme: "dark",
      sidebar: { collapsed: false, width: 250 },
    },
  };

  determineTriggeredActions(
    dependencies,
    before,
    after,
  );
});
