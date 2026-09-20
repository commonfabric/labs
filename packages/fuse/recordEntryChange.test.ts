import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { recordEntryChange, type TransplantChanges } from "./tree.ts";

/** Returns a `TransplantChanges` holding `entryChanges` and nothing else. */
function changesWith(
  entryChanges: Map<bigint, Set<string>> = new Map(),
): TransplantChanges {
  return { changedInodes: new Set(), entryChanges };
}

describe("recordEntryChange()", () => {
  it("records a name under a directory with no entry changes yet", () => {
    const changes = changesWith();
    recordEntryChange(changes, 7n, "title");
    expect(changes.entryChanges).toEqual(new Map([[7n, new Set(["title"])]]));
  });

  it("adds a name to the set a directory already has", () => {
    const names = new Set(["title"]);
    const changes = changesWith(new Map([[7n, names]]));
    recordEntryChange(changes, 7n, "count");
    expect(changes.entryChanges.get(7n)).toBe(names);
    expect(names).toEqual(new Set(["title", "count"]));
  });

  it("keeps each directory's names apart", () => {
    const changes = changesWith();
    recordEntryChange(changes, 7n, "title");
    recordEntryChange(changes, 8n, "count");
    expect(changes.entryChanges).toEqual(
      new Map([[7n, new Set(["title"])], [8n, new Set(["count"])]]),
    );
  });

  it("leaves a directory's set, and the other names in it, as they were for an entry already recorded", () => {
    const names = new Set(["title", "count"]);
    const changes = changesWith(new Map([[7n, names]]));
    recordEntryChange(changes, 7n, "title");
    expect(changes.entryChanges.size).toBe(1);
    expect(changes.entryChanges.get(7n)).toBe(names);
    expect(names).toEqual(new Set(["title", "count"]));
  });

  it("leaves `changedInodes` as it was", () => {
    const changes = changesWith();
    changes.changedInodes.add(3n);
    recordEntryChange(changes, 7n, "title");
    expect(changes.changedInodes).toEqual(new Set([3n]));
  });
});
