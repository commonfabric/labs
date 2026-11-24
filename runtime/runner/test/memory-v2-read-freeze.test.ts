import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v2-read-freeze");
const space = signer.did();
const type = "application/json" as const;

Deno.test("memory v2 raw reads freeze the returned subtree without exposing mutable state", async () => {
  const storage = StorageManager.emulate({
    as: signer,
  });

  try {
    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-read-freeze",
      type,
      path: [],
    }, {
      value: {
        profile: { name: "Ada", title: "Dr" },
        stats: { visits: 3 },
      },
    });
    assert(writeResult.ok);

    const profile = tx.read({
      space,
      id: "of:memory-v2-read-freeze",
      type,
      path: ["value", "profile"],
    }).ok?.value as { name: string; title: string } | undefined;
    assert(profile);
    assert(Object.isFrozen(profile));
    assertThrows(() => {
      profile.name = "Grace";
    }, TypeError);

    const full = tx.read({
      space,
      id: "of:memory-v2-read-freeze",
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;
    assert(full);
    assert(Object.isFrozen(full));
    assert(Object.isFrozen(full.profile));
    assertEquals(full.profile.name, "Ada");
    assertEquals(full.stats.visits, 3);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 raw reads reuse frozen snapshots until the document changes", async () => {
  const storage = StorageManager.emulate({
    as: signer,
  });

  try {
    const tx = storage.edit();
    const id = "of:memory-v2-read-freeze-cache";
    const initialWrite = tx.write({
      space,
      id,
      type,
      path: [],
    }, {
      value: {
        profile: { name: "Ada", title: "Dr" },
        stats: { visits: 3 },
      },
    });
    assert(initialWrite.ok);

    const first = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;
    const second = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;

    assert(first);
    assert(second);
    assert(Object.isFrozen(first));
    assertStrictEquals(first, second);

    const update = tx.write({
      space,
      id,
      type,
      path: ["value", "stats", "visits"],
    }, 4);
    assert(update.ok);

    const afterWrite = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;

    assert(afterWrite);
    assertNotStrictEquals(first, afterWrite);
    assertEquals(afterWrite.stats.visits, 4);
    assert(Object.isFrozen(afterWrite));
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 read cache: sibling-path snapshot survives write, ancestor and written-subtree snapshots get rebuilt", async () => {
  const storage = StorageManager.emulate({ as: signer });

  try {
    const tx = storage.edit();
    const id = "of:memory-v2-read-freeze-prefix";

    assert(
      tx.write({ space, id, type, path: [] }, {
        value: {
          profile: { name: "Ada", title: "Dr" },
          stats: { visits: 1 },
        },
      }).ok,
    );

    // Prime the per-doc frozen-reads cache at three locations: a sibling of
    // the upcoming write, the soon-to-be-written subtree itself, and an
    // ancestor of the write.
    const profileBefore = tx.read({
      space,
      id,
      type,
      path: ["value", "profile"],
    }).ok?.value;
    const statsBefore = tx.read({
      space,
      id,
      type,
      path: ["value", "stats"],
    }).ok?.value;
    const ancestorBefore = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value;
    assert(profileBefore);
    assert(statsBefore);
    assert(ancestorBefore);

    // Write into the stats subtree only. The profile subtree is a sibling of
    // the write and must remain cached; the ancestor at ["value"] must be
    // rebuilt because its container identity changed.
    assert(
      tx.write({
        space,
        id,
        type,
        path: ["value", "stats", "visits"],
      }, 2).ok,
    );

    const profileAfter = tx.read({
      space,
      id,
      type,
      path: ["value", "profile"],
    }).ok?.value;
    const statsAfter = tx.read({
      space,
      id,
      type,
      path: ["value", "stats"],
    }).ok?.value;
    const ancestorAfter = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value;

    // Sibling-path entry: same identity — the cache held.
    assertStrictEquals(profileBefore, profileAfter);
    // Written-subtree entry: identity changes, value reflects the write.
    assertNotStrictEquals(statsBefore, statsAfter);
    // Ancestor-of-write entry: identity changes too.
    assertNotStrictEquals(ancestorBefore, ancestorAfter);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 read cache: array `.length` reads invalidate when an index extends the array", async () => {
  // Regression for the `<parent>/length` sibling case: writing to
  // `/items/1` increases the array's length from 1 to 2. The synthetic
  // `/items/length` pointer is not on the chain of `/items/1` by path-string
  // overlap, but it IS semantically dependent on the index write -- so the
  // cache invalidator must drop it.
  const storage = StorageManager.emulate({ as: signer });

  try {
    const tx = storage.edit();
    const id = "of:memory-v2-read-freeze-length";

    assert(
      tx.write({ space, id, type, path: [] }, { value: { items: ["A"] } }).ok,
    );

    // Prime the cache at `/value/items/length`.
    const lenBefore = tx.read({
      space,
      id,
      type,
      path: ["value", "items", "length"],
    }).ok?.value;
    assertEquals(lenBefore, 1);

    // Extend the array by writing index 1.
    assert(
      tx.write({ space, id, type, path: ["value", "items", "1"] }, "B").ok,
    );

    const lenAfter = tx.read({
      space,
      id,
      type,
      path: ["value", "items", "length"],
    }).ok?.value;
    assertEquals(lenAfter, 2);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 raw reads keep prior frozen snapshots stable after sibling writes", async () => {
  const storage = StorageManager.emulate({
    as: signer,
  });

  try {
    const tx = storage.edit();
    const id = "of:memory-v2-read-freeze-sibling";
    assert(
      tx.write({
        space,
        id,
        type,
        path: [],
      }, {
        value: {
          profile: { name: "Ada" },
          stats: { visits: 1 },
        },
      }).ok,
    );

    const first = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string };
        stats: { visits: number };
      }
      | undefined;
    assert(first);
    assert(Object.isFrozen(first));

    assert(
      tx.write({
        space,
        id,
        type,
        path: ["value", "stats", "visits"],
      }, 2).ok,
    );

    const second = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as typeof first;
    assert(second);
    assertNotStrictEquals(first, second);
    assertEquals(first.stats.visits, 1);
    assertEquals(second.stats.visits, 2);
    assert(Object.isFrozen(second));
    assert(Object.isFrozen(second.stats));
  } finally {
    await storage.close();
  }
});
