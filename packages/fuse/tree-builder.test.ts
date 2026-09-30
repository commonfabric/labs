// tree-builder.test.ts — Unit tests for JSON-to-tree conversion and symlink parsing
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { FsTree } from "./tree.ts";
import {
  buildCallableScript,
  classifyCallableEntry,
  isPatternToolValue,
} from "./callables.ts";
import {
  buildFsProjection,
  buildJsonTree,
  buildJsonTreeAsync,
  buildPendingJsonTreeAsync,
  type FsValue,
  isHandlerCell,
  isSigilLink,
  isStreamValue,
  MAX_DEPTH_MARKER,
  MAX_JSON_DEPTH,
  safeStringify,
  stringifyEntryValue,
  transformStreamValues,
} from "./tree-builder.ts";
import { CellBridge } from "./cell-bridge.ts";

const decoder = new TextDecoder();

function getFileContent(tree: FsTree, parentIno: bigint, name: string): string {
  const ino = tree.lookup(parentIno, name);
  if (ino === undefined) throw new Error(`File ${name} not found`);
  const node = tree.getNode(ino);
  if (!node || node.kind !== "file") throw new Error(`${name} is not a file`);
  return decoder.decode(node.content);
}

Deno.test("buildJsonTree - null value creates empty file", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "empty", null);

  const ino = tree.lookup(tree.rootIno, "empty");
  assertEquals(ino !== undefined, true);
  const node = tree.getNode(ino!);
  assertEquals(node?.kind, "file");
  if (node?.kind === "file") {
    assertEquals(node.jsonType, "null");
    assertEquals(node.content.length, 0);
  }
});

Deno.test("buildJsonTree - boolean values", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "flag", true);
  assertEquals(getFileContent(tree, tree.rootIno, "flag"), "true");

  buildJsonTree(tree, tree.rootIno, "off", false);
  assertEquals(getFileContent(tree, tree.rootIno, "off"), "false");
});

Deno.test("buildJsonTree - number values", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "count", 42);
  assertEquals(getFileContent(tree, tree.rootIno, "count"), "42");

  buildJsonTree(tree, tree.rootIno, "pi", 3.14);
  assertEquals(getFileContent(tree, tree.rootIno, "pi"), "3.14");
});

Deno.test("buildJsonTree - string values", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "greeting", "hello world");
  assertEquals(getFileContent(tree, tree.rootIno, "greeting"), "hello world");
});

Deno.test("buildJsonTree - object creates directory with children", () => {
  const tree = new FsTree();
  const obj = { name: "Alice", age: 30, active: true };
  buildJsonTree(tree, tree.rootIno, "user", obj);

  // Should create a directory
  const dirIno = tree.lookup(tree.rootIno, "user");
  assertEquals(dirIno !== undefined, true);
  const dirNode = tree.getNode(dirIno!);
  assertEquals(dirNode?.kind, "dir");

  // Should have children
  assertEquals(getFileContent(tree, dirIno!, "name"), "Alice");
  assertEquals(getFileContent(tree, dirIno!, "age"), "30");
  assertEquals(getFileContent(tree, dirIno!, "active"), "true");

  // Should have .json sibling
  const jsonContent = getFileContent(tree, tree.rootIno, "user.json");
  assertEquals(JSON.parse(jsonContent), obj);
});

Deno.test("buildJsonTree - encodes unsafe object keys in path names", () => {
  const tree = new FsTree();
  const data = {
    "has/slash": 1,
    "of:entity": 2,
    "literal%": 3,
    ".hidden": 4,
    "..": 5,
    "value.json": 6,
  };

  buildJsonTree(tree, tree.rootIno, "data", data);

  const dataIno = tree.lookup(tree.rootIno, "data")!;
  assertEquals(getFileContent(tree, dataIno, "has%2Fslash"), "1");
  assertEquals(getFileContent(tree, dataIno, "of%3Aentity"), "2");
  assertEquals(getFileContent(tree, dataIno, "literal%25"), "3");
  assertEquals(getFileContent(tree, dataIno, "%2Ehidden"), "4");
  assertEquals(getFileContent(tree, dataIno, "%2E%2E"), "5");
  assertEquals(getFileContent(tree, dataIno, "value%2Ejson"), "6");
  assertEquals(
    JSON.parse(getFileContent(tree, tree.rootIno, "data.json")),
    data,
  );
});

Deno.test("buildJsonTree - encodes user keys that look like internal pending roots", () => {
  const tree = new FsTree();
  const data = {
    ".input.pending": 1,
    ".result.pending": 2,
  };

  buildJsonTree(tree, tree.rootIno, "data", data);

  const dataIno = tree.lookup(tree.rootIno, "data")!;
  assertEquals(tree.lookup(dataIno, ".input.pending"), undefined);
  assertEquals(tree.lookup(dataIno, ".result.pending"), undefined);
  assertEquals(getFileContent(tree, dataIno, "%2Einput.pending"), "1");
  assertEquals(getFileContent(tree, dataIno, "%2Eresult.pending"), "2");
});

Deno.test("buildJsonTree - encodes depth-zero names that look like internal pending roots by default", () => {
  const tree = new FsTree();

  buildJsonTree(tree, tree.rootIno, ".result.pending", { value: 1 });

  assertEquals(tree.lookup(tree.rootIno, ".result.pending"), undefined);
  const dataIno = tree.lookup(tree.rootIno, "%2Eresult.pending")!;
  assertEquals(getFileContent(tree, dataIno, "value"), "1");
});

Deno.test("buildJsonTreeAsync - encodes depth-zero names that look like internal pending roots by default", async () => {
  const tree = new FsTree();

  await buildJsonTreeAsync(tree, tree.rootIno, ".input.pending", { value: 1 });

  assertEquals(tree.lookup(tree.rootIno, ".input.pending"), undefined);
  const dataIno = tree.lookup(tree.rootIno, "%2Einput.pending")!;
  assertEquals(getFileContent(tree, dataIno, "value"), "1");
});

Deno.test("buildPendingJsonTreeAsync - preserves pending roots for rebuild staging", async () => {
  const tree = new FsTree();

  await buildPendingJsonTreeAsync(
    tree,
    tree.rootIno,
    "result",
    { value: 1 },
  );

  const dataIno = tree.lookup(tree.rootIno, ".result.pending")!;
  assertEquals(getFileContent(tree, dataIno, "value"), "1");
  assertEquals(tree.lookup(tree.rootIno, "%2Eresult.pending"), undefined);
});

Deno.test("buildJsonTree - array creates directory with numeric indices", () => {
  const tree = new FsTree();
  const arr = ["a", "b", "c"];
  buildJsonTree(tree, tree.rootIno, "items", arr);

  const dirIno = tree.lookup(tree.rootIno, "items");
  assertEquals(dirIno !== undefined, true);
  const dirNode = tree.getNode(dirIno!);
  assertEquals(dirNode?.kind, "dir");

  assertEquals(getFileContent(tree, dirIno!, "0"), "a");
  assertEquals(getFileContent(tree, dirIno!, "1"), "b");
  assertEquals(getFileContent(tree, dirIno!, "2"), "c");

  // Should have .json sibling
  const jsonContent = getFileContent(tree, tree.rootIno, "items.json");
  assertEquals(JSON.parse(jsonContent), arr);
});

Deno.test("buildJsonTree - nested objects", () => {
  const tree = new FsTree();
  const data = {
    user: {
      name: "Bob",
      address: {
        city: "NYC",
        zip: 10001,
      },
    },
  };
  buildJsonTree(tree, tree.rootIno, "data", data);

  const dataIno = tree.lookup(tree.rootIno, "data")!;
  const userIno = tree.lookup(dataIno, "user")!;
  const addressIno = tree.lookup(userIno, "address")!;

  assertEquals(getFileContent(tree, userIno, "name"), "Bob");
  assertEquals(getFileContent(tree, addressIno, "city"), "NYC");
  assertEquals(getFileContent(tree, addressIno, "zip"), "10001");
});

Deno.test("buildJsonTreeAsync matches synchronous nested tree structure", async () => {
  const tree = new FsTree();
  const data = {
    profile: {
      name: "Ada",
      stats: {
        score: 7,
        enabled: true,
      },
    },
    tags: ["a", "b"],
  };

  await buildJsonTreeAsync(tree, tree.rootIno, "data", data);

  const dataIno = tree.lookup(tree.rootIno, "data")!;
  const profileIno = tree.lookup(dataIno, "profile")!;
  const statsIno = tree.lookup(profileIno, "stats")!;
  const tagsIno = tree.lookup(dataIno, "tags")!;

  assertEquals(getFileContent(tree, profileIno, "name"), "Ada");
  assertEquals(getFileContent(tree, statsIno, "score"), "7");
  assertEquals(getFileContent(tree, statsIno, "enabled"), "true");
  assertEquals(getFileContent(tree, tagsIno, "0"), "a");
  assertEquals(getFileContent(tree, tagsIno, "1"), "b");
  assertEquals(
    JSON.parse(getFileContent(tree, tree.rootIno, "data.json")),
    data,
  );
});

function describeSubtree(tree: FsTree, ino: bigint): unknown {
  const node = tree.getNode(ino);
  if (!node) throw new Error(`Inode ${ino} not found`);
  // The inode is part of the description: two builds of the same value into
  // fresh trees allocate from the same starting number, so equal inodes mean
  // the two builds created the same entries in the same order.
  if (node.kind === "dir") {
    return {
      ino: String(ino),
      kind: node.kind,
      jsonType: node.jsonType,
      children: [...node.children].map((
        [name, childIno],
      ) => [name, describeSubtree(tree, childIno)]),
    };
  }
  if (node.kind === "file") {
    return {
      ino: String(ino),
      kind: node.kind,
      jsonType: node.jsonType,
      content: decoder.decode(node.content),
    };
  }
  return { ino: String(ino), kind: node.kind };
}

Deno.test("buildJsonTreeAsync matches synchronous build across many batches", async () => {
  // Wide and deep enough that both entry points run several batches, so a
  // batch boundary falls in the middle of a directory's children.
  const data = Object.fromEntries(
    Array.from({ length: 40 }, (_, group) => [
      `group${group}`,
      {
        index: group,
        items: Array.from({ length: 12 }, (_, item) => ({
          label: `g${group}i${item}`,
          nested: { deep: item },
        })),
      },
    ]),
  );

  const syncTree = new FsTree();
  buildJsonTree(syncTree, syncTree.rootIno, "data", data);

  const asyncTree = new FsTree();
  await buildJsonTreeAsync(asyncTree, asyncTree.rootIno, "data", data);

  assertEquals(
    describeSubtree(asyncTree, asyncTree.rootIno),
    describeSubtree(syncTree, syncTree.rootIno),
  );

  // The last node queued sits many batches past the first, so a batch that
  // dropped or repeated a node would show up here even if it did so on both
  // paths alike.
  const dataIno = asyncTree.lookup(asyncTree.rootIno, "data")!;
  const groupIno = asyncTree.lookup(dataIno, "group39")!;
  const itemIno = asyncTree.lookup(asyncTree.lookup(groupIno, "items")!, "11")!;
  assertEquals(getFileContent(asyncTree, itemIno, "label"), "g39i11");
  assertEquals(
    getFileContent(asyncTree, asyncTree.lookup(itemIno, "nested")!, "deep"),
    "11",
  );
});

Deno.test("FsTree - clear removes subtree", () => {
  const tree = new FsTree();
  const data = { a: { b: 1, c: 2 }, d: 3 };
  buildJsonTree(tree, tree.rootIno, "root", data);

  const rootDirIno = tree.lookup(tree.rootIno, "root")!;
  const aIno = tree.lookup(rootDirIno, "a")!;

  // Clear the 'a' subtree
  tree.clear(aIno);

  // 'a' should be gone
  assertEquals(tree.lookup(rootDirIno, "a"), undefined);
  assertEquals(tree.getNode(aIno), undefined);

  // 'd' should still exist
  assertEquals(getFileContent(tree, rootDirIno, "d"), "3");
});

Deno.test("buildJsonTree - circular references become [Circular]", () => {
  const tree = new FsTree();
  // deno-lint-ignore no-explicit-any
  const obj: any = { name: "loop" };
  obj.self = obj; // circular

  buildJsonTree(tree, tree.rootIno, "circ", obj);

  const dirIno = tree.lookup(tree.rootIno, "circ")!;
  assertEquals(getFileContent(tree, dirIno, "name"), "loop");
  assertEquals(getFileContent(tree, dirIno, "self"), "[Circular]");

  // .json sibling should also handle circularity
  const json = getFileContent(tree, tree.rootIno, "circ.json");
  const parsed = JSON.parse(json);
  assertEquals(parsed.name, "loop");
  assertEquals(parsed.self, "[Circular]");
});

Deno.test("buildJsonTree - shared DAG objects are not circular", () => {
  const tree = new FsTree();
  const shared = { leaf: "same" };
  const data = { a: shared, b: shared };

  buildJsonTree(tree, tree.rootIno, "dag", data);

  const dagIno = tree.lookup(tree.rootIno, "dag")!;
  const aIno = tree.lookup(dagIno, "a")!;
  const bIno = tree.lookup(dagIno, "b")!;

  assertEquals(getFileContent(tree, aIno, "leaf"), "same");
  assertEquals(getFileContent(tree, bIno, "leaf"), "same");
  assertEquals(JSON.parse(getFileContent(tree, tree.rootIno, "dag.json")), {
    a: { leaf: "same" },
    b: { leaf: "same" },
  });
});

Deno.test("buildJsonTreeAsync - shared DAG objects are not circular", async () => {
  const tree = new FsTree();
  const shared = { leaf: "same" };
  const data = { a: shared, b: shared };

  await buildJsonTreeAsync(tree, tree.rootIno, "dag", data);

  const dagIno = tree.lookup(tree.rootIno, "dag")!;
  const aIno = tree.lookup(dagIno, "a")!;
  const bIno = tree.lookup(dagIno, "b")!;

  assertEquals(getFileContent(tree, aIno, "leaf"), "same");
  assertEquals(getFileContent(tree, bIno, "leaf"), "same");
  assertEquals(JSON.parse(getFileContent(tree, tree.rootIno, "dag.json")), {
    a: { leaf: "same" },
    b: { leaf: "same" },
  });
});

Deno.test("safeStringify - handles circular refs", () => {
  // deno-lint-ignore no-explicit-any
  const a: any = { x: 1 };
  a.y = a;
  const result = JSON.parse(safeStringify(a));
  assertEquals(result.x, 1);
  assertEquals(result.y, "[Circular]");
});

Deno.test("safeStringify - preserves shared DAG objects", () => {
  const shared = { leaf: "same" };
  const result = JSON.parse(safeStringify({ a: shared, b: shared }));
  assertEquals(result, {
    a: { leaf: "same" },
    b: { leaf: "same" },
  });
});

/** A chain of `depth` nested objects, each under the key `next`. */
function nestedChain(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: "bottom" };
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}

/** How many levels of `next` the parsed chain spells out, and what ends it. */
function chainDepth(value: unknown): { depth: number; tail: unknown } {
  let depth = 0;
  let cursor = value;
  while (isObjectOrArray(cursor)) {
    const next = (cursor as Record<string, unknown>).next;
    if (next === undefined) break;
    depth++;
    cursor = next;
  }
  return { depth, tail: cursor };
}

Deno.test("safeStringify - a circular edge at the depth bound reads as circular", () => {
  // Objects at nesting levels 0 to the bound, the deepest pointing at the
  // root, so the back edge falls exactly where the depth bound would bite.
  const nodes: Record<string, unknown>[] = [];
  for (let level = 0; level < MAX_JSON_DEPTH; level++) nodes.push({});
  for (let level = 0; level < MAX_JSON_DEPTH - 1; level++) {
    nodes[level].next = nodes[level + 1];
  }
  nodes[MAX_JSON_DEPTH - 1].next = nodes[0];

  // Circular, not out of depth: nothing lies below the back edge that a
  // deeper bound would have shown.
  assertEquals(chainDepth(JSON.parse(safeStringify(nodes[0]))), {
    depth: MAX_JSON_DEPTH,
    tail: "[Circular]",
  });
});

Deno.test("safeStringify - spells out nesting up to the depth bound", () => {
  const shallow = JSON.parse(safeStringify(nestedChain(MAX_JSON_DEPTH - 2)));
  assertEquals(chainDepth(shallow), {
    depth: MAX_JSON_DEPTH - 2,
    tail: { leaf: "bottom" },
  });
});

Deno.test("safeStringify - marks values nested below the depth bound", () => {
  const deep = JSON.parse(safeStringify(nestedChain(MAX_JSON_DEPTH * 4)));
  assertEquals(chainDepth(deep), {
    depth: MAX_JSON_DEPTH,
    tail: MAX_DEPTH_MARKER,
  });
});

Deno.test("safeStringify - survives nesting deeper than the call stack", () => {
  // A serializer that recurses per level overflows well before this depth.
  const result = JSON.parse(safeStringify(nestedChain(100_000)));
  assertEquals(chainDepth(result).tail, MAX_DEPTH_MARKER);
});

Deno.test("safeStringify - bounds depth per value, not across siblings", () => {
  const wide = { a: nestedChain(4), b: nestedChain(4) };
  const result = JSON.parse(safeStringify(wide)) as Record<string, unknown>;
  assertEquals(chainDepth(result.a).tail, { leaf: "bottom" });
  assertEquals(chainDepth(result.b).tail, { leaf: "bottom" });
});

Deno.test("buildJsonTree - projects nesting deeper than the call stack", () => {
  const depth = MAX_JSON_DEPTH * 8;
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "deep", nestedChain(depth));

  // Every level keeps its directory entry, so the leaf the root's `.json`
  // sibling elides is still reachable through the directory tree.
  let ino = tree.lookup(tree.rootIno, "deep")!;
  for (let level = 0; level < depth; level++) {
    const next = tree.lookup(ino, "next");
    assertEquals(next !== undefined, true, `level ${level} is missing`);
    ino = next!;
  }
  assertEquals(getFileContent(tree, ino, "leaf"), "bottom");

  // A `.json` sibling far enough down the chain spells out what the root's
  // elided, so the bound hides no data.
  assertEquals(
    chainDepth(JSON.parse(getFileContent(tree, tree.rootIno, "deep.json")))
      .tail,
    MAX_DEPTH_MARKER,
  );
  const parentIno = tree.parents.get(ino)!;
  assertEquals(
    JSON.parse(getFileContent(tree, parentIno, "next.json")),
    { leaf: "bottom" },
  );
});

Deno.test("buildFsProjection - application/json writes index.json", () => {
  const tree = new FsTree();
  const fsValue: FsValue = {
    type: "application/json",
    content: { title: "My Todos", count: 3 },
  };

  const ino = buildFsProjection(tree, tree.rootIno, fsValue, "of:entity-1");

  assertEquals(tree.lookup(tree.rootIno, "index.json"), ino);
  const node = tree.getNode(ino);
  assertEquals(node?.kind === "file" ? node.jsonType : undefined, "object");
  // `entityId` leads, so a reader sees which entity the projection came from.
  assertEquals(
    JSON.parse(getFileContent(tree, tree.rootIno, "index.json")),
    { entityId: "of:entity-1", title: "My Todos", count: 3 },
  );
});

Deno.test("buildFsProjection - a pattern cannot overwrite entityId", () => {
  const tree = new FsTree();
  const fsValue = {
    type: "application/json",
    content: { entityId: "of:forged", title: "My Todos" },
  } as FsValue;

  buildFsProjection(tree, tree.rootIno, fsValue, "of:entity-1");

  assertEquals(
    JSON.parse(getFileContent(tree, tree.rootIno, "index.json")),
    { entityId: "of:entity-1", title: "My Todos" },
  );
});

Deno.test("buildFsProjection - an unknown type falls back to index.txt", () => {
  const tree = new FsTree();
  const fsValue = { type: "text/csv", content: "a,b" } as unknown as FsValue;

  const ino = buildFsProjection(tree, tree.rootIno, fsValue, "of:entity-1");

  assertEquals(tree.lookup(tree.rootIno, "index.txt"), ino);
  assertEquals(tree.lookup(tree.rootIno, "index.json"), undefined);
  assertEquals(tree.lookup(tree.rootIno, "index.md"), undefined);
  assertEquals(
    JSON.parse(getFileContent(tree, tree.rootIno, "index.txt")),
    { type: "text/csv", content: "a,b" },
  );
});

Deno.test("buildFsProjection - names the failing entry when a value cannot serialize", () => {
  const tree = new FsTree();
  const piece = tree.addDir(tree.rootIno, "todo-app");
  const fsValue = {
    type: "application/json",
    content: { count: 1n },
  } as unknown as FsValue;

  assertThrows(
    () => buildFsProjection(tree, piece, fsValue, "of:entity-1"),
    Error,
    "/todo-app/index.json",
  );
});

Deno.test("stringifyEntryValue - names the failing entry's mounted path", () => {
  const tree = new FsTree();
  const space = tree.addDir(tree.rootIno, "did:key:zSpace");
  const pieces = tree.addDir(space, "pieces");
  const piece = tree.addDir(pieces, "todo-app");

  const error = assertThrows(
    () => stringifyEntryValue(tree, piece, "result.json", { count: 1n }),
    Error,
    "/did:key:zSpace/pieces/todo-app/result.json",
  );
  assertEquals((error as Error).cause instanceof TypeError, true);
});

Deno.test("FsTree - addSymlink", () => {
  const tree = new FsTree();
  tree.addSymlink(tree.rootIno, "link", "../target/path");

  const ino = tree.lookup(tree.rootIno, "link");
  assertEquals(ino !== undefined, true);
  const node = tree.getNode(ino!);
  assertEquals(node?.kind, "symlink");
  if (node?.kind === "symlink") {
    assertEquals(node.target, "../target/path");
  }
});

//
// Sigil link tests
//

Deno.test("isSigilLink - detects valid sigil links", () => {
  assertEquals(
    isSigilLink({ "/": { "link@1": { id: "bafy123" } } }),
    true,
  );
  assertEquals(
    isSigilLink({ "/": { "link@1": { id: "bafy123", path: ["name"] } } }),
    true,
  );
  assertEquals(
    isSigilLink({
      "/": { "link@1": { id: "bafy123", space: "other" } },
    }),
    true,
  );
  assertEquals(
    isSigilLink({ "/": { "link@1": {} } }),
    true,
  );
});

Deno.test("isSigilLink - rejects non-sigil values", () => {
  assertEquals(isSigilLink(null), false);
  assertEquals(isSigilLink(42), false);
  assertEquals(isSigilLink("hello"), false);
  assertEquals(isSigilLink([1, 2]), false);
  assertEquals(isSigilLink({ name: "Alice" }), false);
  assertEquals(isSigilLink({ "/": "not-an-object" }), false);
  assertEquals(isSigilLink({ "/": { other: 1 } }), false);
  // Extra keys disqualify
  assertEquals(isSigilLink({ "/": { "link@1": {} }, extra: true }), false);
});

Deno.test("isHandlerCell - detects stream cells via duck-typing", () => {
  // Mock Cell with isStream() returning true
  assertEquals(isHandlerCell({ isStream: () => true }), true);
  // Mock Cell with isStream() returning false
  assertEquals(isHandlerCell({ isStream: () => false }), false);
  // Not a Cell — no isStream method
  assertEquals(isHandlerCell({ name: "Alice" }), false);
  assertEquals(isHandlerCell(42), false);
  assertEquals(isHandlerCell(null), false);
  assertEquals(isHandlerCell({ $stream: true }), false);
});

Deno.test("buildJsonTree - handler cells skipped via skipEntry", () => {
  const tree = new FsTree();

  // Simulate live Cell objects with isStream() (as returned by piece.result.get())
  const data = {
    value: 10,
    increment: {
      isStream: () => true,
      toJSON() {
        return { "/handler": "increment" };
      },
    },
    decrement: {
      isStream: () => true,
      toJSON() {
        return { "/handler": "decrement" };
      },
    },
  };

  const resolveLink = (_value: unknown, depth: number): string | null => {
    return "../".repeat(depth + 2) + "entities/test";
  };
  const skipEntry = (val: unknown) => isHandlerCell(val);

  const resultIno = buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    data,
    resolveLink,
    0,
    skipEntry,
  );

  // "value" should exist as a file
  const valueIno = tree.lookup(resultIno, "value");
  assertEquals(valueIno !== undefined, true);

  // "increment" and "decrement" should be skipped (not in tree)
  assertEquals(tree.lookup(resultIno, "increment"), undefined);
  assertEquals(tree.lookup(resultIno, "decrement"), undefined);

  // The .json sibling should have handler sigils
  const jsonIno = tree.lookup(tree.rootIno, "result.json");
  assertEquals(jsonIno !== undefined, true);
  const jsonContent = getFileContent(tree, tree.rootIno, "result.json");
  const parsed = JSON.parse(jsonContent);
  assertEquals(parsed.increment, { "/handler": "increment" });
  assertEquals(parsed.decrement, { "/handler": "decrement" });
  assertEquals(parsed.value, 10);
});

Deno.test("buildJsonTree - sigil link becomes symlink via resolveLink", () => {
  const tree = new FsTree();

  const resolveLink = (_value: unknown, depth: number): string | null => {
    return "../".repeat(depth + 2) + "entities/bafy123";
  };

  const data = {
    ref: { "/": { "link@1": { id: "bafy123" } } },
    name: "Alice",
  };

  buildJsonTree(tree, tree.rootIno, "result", data, resolveLink, 0);

  const resultIno = tree.lookup(tree.rootIno, "result")!;

  // "ref" should be a symlink
  const refIno = tree.lookup(resultIno, "ref")!;
  const refNode = tree.getNode(refIno);
  assertEquals(refNode?.kind, "symlink");
  if (refNode?.kind === "symlink") {
    // depth=1 (inside "result"), so depth+2=3 ups
    assertEquals(refNode.target, "../../../entities/bafy123");
  }

  // "name" should still be a normal file
  assertEquals(getFileContent(tree, resultIno, "name"), "Alice");
});

Deno.test("buildJsonTree - sigil link in nested array gets correct depth", () => {
  const tree = new FsTree();

  const resolveLink = (_value: unknown, depth: number): string | null => {
    return "../".repeat(depth + 2) + "entities/xyz";
  };

  const data = {
    items: [
      { "/": { "link@1": { id: "xyz" } } },
    ],
  };

  buildJsonTree(tree, tree.rootIno, "result", data, resolveLink, 0);

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  const itemsIno = tree.lookup(resultIno, "items")!;
  const linkIno = tree.lookup(itemsIno, "0")!;
  const linkNode = tree.getNode(linkIno);

  assertEquals(linkNode?.kind, "symlink");
  if (linkNode?.kind === "symlink") {
    // depth=2 (result/items/0), so depth+2=4 ups
    assertEquals(linkNode.target, "../../../../entities/xyz");
  }
});

Deno.test("buildJsonTree - unresolvable sigil link falls through to object", () => {
  const tree = new FsTree();

  const resolveLink = (): string | null => null;

  const data = {
    ref: { "/": { "link@1": { id: "bafy123" } } },
  };

  buildJsonTree(tree, tree.rootIno, "result", data, resolveLink, 0);

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  const refIno = tree.lookup(resultIno, "ref")!;
  const refNode = tree.getNode(refIno);
  // Falls through to directory since it's an object
  assertEquals(refNode?.kind, "dir");
});

//
// Stream / handler tests
//

Deno.test("isStreamValue - detects stream markers", () => {
  assertEquals(isStreamValue({ $stream: true }), true);
  assertEquals(isStreamValue({ $stream: true, extra: 1 }), true);
});

Deno.test("isStreamValue - rejects non-stream values", () => {
  assertEquals(isStreamValue(null), false);
  assertEquals(isStreamValue(42), false);
  assertEquals(isStreamValue("hello"), false);
  assertEquals(isStreamValue([1, 2]), false);
  assertEquals(isStreamValue({ name: "Alice" }), false);
  assertEquals(isStreamValue({ $stream: false }), false);
  assertEquals(isStreamValue({}), false);
});

Deno.test("transformStreamValues - replaces stream markers with handler sigils", () => {
  const input = {
    items: [1, 2, 3],
    count: 3,
    addItem: { $stream: true },
  };
  const result = transformStreamValues(input) as Record<string, unknown>;
  assertEquals(result.items, [1, 2, 3]);
  assertEquals(result.count, 3);
  assertEquals(result.addItem, { "/handler": "addItem" });
});

Deno.test("transformStreamValues - returns original when no streams", () => {
  const input = { name: "Alice", age: 30 };
  const result = transformStreamValues(input);
  // Should be the exact same reference
  assertEquals(result === input, true);
});

Deno.test("transformStreamValues - passes through non-objects", () => {
  assertEquals(transformStreamValues(null), null);
  assertEquals(transformStreamValues(42), 42);
  assertEquals(transformStreamValues("hello"), "hello");
  assertEquals(transformStreamValues([1, 2]), [1, 2]);
});

Deno.test("buildJsonTree - stream values are skipped in object directories", () => {
  const tree = new FsTree();
  const data = {
    items: ["a", "b"],
    count: 2,
    addItem: { $stream: true },
    reset: { $stream: true },
  };
  buildJsonTree(tree, tree.rootIno, "result", data);

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  const resultNode = tree.getNode(resultIno);
  assertEquals(resultNode?.kind, "dir");

  // Regular keys should exist
  const itemsIno = tree.lookup(resultIno, "items");
  assertEquals(itemsIno !== undefined, true);
  assertEquals(getFileContent(tree, resultIno, "count"), "2");

  // Stream keys should NOT exist as files or dirs
  assertEquals(tree.lookup(resultIno, "addItem"), undefined);
  assertEquals(tree.lookup(resultIno, "reset"), undefined);
});

Deno.test("buildJsonTree - .json sibling replaces streams with handler sigils", () => {
  const tree = new FsTree();
  const data = {
    items: ["a"],
    addItem: { $stream: true },
  };
  buildJsonTree(tree, tree.rootIno, "result", data);

  const json = getFileContent(tree, tree.rootIno, "result.json");
  const parsed = JSON.parse(json);
  assertEquals(parsed.items, ["a"]);
  assertEquals(parsed.addItem, { "/handler": "addItem" });
});

Deno.test("buildJsonTree - a nested .json sibling shows a stream handle as a handler sigil", () => {
  // A stream holds no value; what stands at a nested stream position in a
  // read value is the handle minted for it, which is not data to spell out.
  const tree = new FsTree();
  const bump = { isStream: () => true, toJSON: () => ({ "/": "a link" }) };
  const data = { nested: { count: 1, bump } };

  buildJsonTree(tree, tree.rootIno, "result", data);

  const resultIno = tree.lookup(tree.rootIno, "result");
  if (resultIno === undefined) throw new Error("result dir not found");
  assertEquals(
    JSON.parse(getFileContent(tree, resultIno, "nested.json")),
    { count: 1, bump: { "/handler": "bump" } },
  );
  // The handle is not projected as an entry of its own either.
  const nestedIno = tree.lookup(resultIno, "nested");
  if (nestedIno === undefined) throw new Error("nested dir not found");
  assertEquals(tree.lookup(nestedIno, "bump"), undefined);
});

Deno.test("classifyCallableEntry - a schema declaring a stream is a handler whatever stands at it", () => {
  assertEquals(
    classifyCallableEntry(undefined, { asCell: ["stream"], type: "object" }),
    "handler",
  );
  assertEquals(classifyCallableEntry({}, { asCell: ["stream"] }), "handler");
  assertEquals(
    classifyCallableEntry(undefined, { asCell: [{ kind: "stream" }] }),
    "handler",
  );
  assertEquals(classifyCallableEntry(undefined, { asCell: ["cell"] }), null);
  assertEquals(classifyCallableEntry({}, { type: "object" }), null);
});

Deno.test("classifyCallableEntry does not treat ordinary data as a tool when linked schema disagrees", () => {
  const value = {
    pattern: "just-data",
    extraParams: {
      source: "still-data",
    },
  };
  const schema = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      extraParams: {
        type: "object",
        properties: {
          source: { type: "string" },
        },
      },
    },
  } as const;

  assertEquals(classifyCallableEntry(value, schema), null);
});

Deno.test("buildJsonTree - nested .json siblings keep ordinary pattern-shaped objects intact", () => {
  const tree = new FsTree();
  const data = {
    nested: {
      config: {
        pattern: "literal-pattern",
        extraParams: {
          mode: "keep",
        },
      },
    },
  };

  buildJsonTree(tree, tree.rootIno, "result", data);

  const resultIno = tree.lookup(tree.rootIno, "result");
  if (resultIno === undefined) throw new Error("result dir not found");

  const nestedJson = JSON.parse(getFileContent(tree, resultIno, "nested.json"));
  assertEquals(nestedJson, {
    config: {
      pattern: "literal-pattern",
      extraParams: {
        mode: "keep",
      },
    },
  });
});

Deno.test("buildJsonTree - root .json siblings keep ordinary pattern-shaped objects intact without a classifier", () => {
  const tree = new FsTree();
  const data = {
    pattern: "literal-pattern",
    extraParams: {
      mode: "keep",
    },
  };

  buildJsonTree(tree, tree.rootIno, "result", data);

  const parsed = JSON.parse(getFileContent(tree, tree.rootIno, "result.json"));
  assertEquals(parsed, data);
});

Deno.test("FsTree - addCallable creates callable handler node", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  const handlerIno = tree.addCallable(
    dirIno,
    "addItem.handler",
    "handler",
    "addItem",
    "result",
    buildCallableScript("/tmp/cf-exec"),
  );

  const node = tree.getNode(handlerIno);
  assertEquals(node?.kind, "callable");
  if (node?.kind === "callable") {
    assertEquals(node.callableKind, "handler");
    assertEquals(node.cellKey, "addItem");
    assertEquals(node.cellProp, "result");
  }

  // Should be findable via lookup
  assertEquals(tree.lookup(dirIno, "addItem.handler"), handlerIno);
});

Deno.test("FsTree - handler nodes coexist with regular files", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  tree.addFile(dirIno, "count", "3", "number");
  tree.addCallable(
    dirIno,
    "addItem.handler",
    "handler",
    "addItem",
    "result",
    buildCallableScript("/tmp/cf-exec"),
  );
  tree.addCallable(
    dirIno,
    "reset.handler",
    "handler",
    "reset",
    "result",
    buildCallableScript("/tmp/cf-exec"),
  );

  const children = tree.getChildren(dirIno);
  const names = children.map(([name]) => name).sort();
  assertEquals(names, ["addItem.handler", "count", "reset.handler"]);
});

Deno.test("FsTree - clear removes handler nodes", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  const handlerIno = tree.addCallable(
    dirIno,
    "add.handler",
    "handler",
    "add",
    "result",
    buildCallableScript("/tmp/cf-exec"),
  );

  tree.clear(dirIno);

  assertEquals(tree.getNode(handlerIno), undefined);
  assertEquals(tree.lookup(tree.rootIno, "result"), undefined);
});

Deno.test("buildJsonTree - .tool callables appear beside ordinary fields", () => {
  const tree = new FsTree();
  const data = {
    count: 3,
    search: {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "items" },
    },
  };

  const resultIno = buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    data,
    undefined,
    0,
    (value) => isPatternToolValue(value),
  );
  const script = buildCallableScript("/tmp/cf-exec");
  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    script,
  );

  assertEquals(getFileContent(tree, resultIno, "count"), "3");
  assertEquals(tree.lookup(resultIno, "search"), undefined);
  assertEquals(tree.lookup(resultIno, "search.tool"), callableIno);

  const callableNode = tree.getNode(callableIno);
  assertEquals(callableNode?.kind, "callable");
  if (callableNode?.kind === "callable") {
    assertEquals(callableNode.callableKind, "tool");
    assertEquals(callableNode.cellKey, "search");
    assertEquals(callableNode.cellProp, "result");
  }
});

Deno.test("buildJsonTree - .json siblings replace handlers and tools with sigils", () => {
  const tree = new FsTree();
  const data = {
    count: 3,
    addItem: { $stream: true },
    search: {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "items" },
    },
  };

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    data,
    undefined,
    0,
    (value) => isHandlerCell(value) || isPatternToolValue(value),
    (_key, value) => {
      if (isHandlerCell(value) || isStreamValue(value)) return "handler";
      return isPatternToolValue(value) ? "tool" : null;
    },
  );

  const parsed = JSON.parse(getFileContent(tree, tree.rootIno, "result.json"));
  assertEquals(parsed.count, 3);
  assertEquals(parsed.addItem, { "/handler": "addItem" });
  assertEquals(parsed.search, { "/tool": "search" });
});

Deno.test("buildJsonTree - a root key the classifier names a callable projects no value", () => {
  // A declared stream is a callable whatever stands at it, so what stands
  // there is not projected beside the callable's own file.
  const tree = new FsTree();
  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { count: 3, events: 7 },
    undefined,
    0,
    undefined,
    (key) => (key === "events" ? "handler" : null),
  );

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  assertEquals(getFileContent(tree, resultIno, "count"), "3");
  assertEquals(tree.lookup(resultIno, "events"), undefined);
  const parsed = JSON.parse(getFileContent(tree, tree.rootIno, "result.json"));
  assertEquals(parsed.events, { "/handler": "events" });
});

Deno.test("callable scripts begin with a cf exec shebang and shell fallback", () => {
  const tree = new FsTree();
  const resultIno = tree.addDir(tree.rootIno, "result", "object");
  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    buildCallableScript("/tmp/cf-exec"),
  );

  const node = tree.getNode(callableIno);
  assertEquals(node?.kind, "callable");
  if (node?.kind === "callable") {
    const [firstLine, secondLine] = decoder.decode(node.script).split("\n");
    assertEquals(firstLine.startsWith("#!"), true);
    assertEquals(firstLine.includes(" exec"), true);
    assertEquals(secondLine.includes(' exec "$0" "$@"'), true);
  }
});

Deno.test("CellBridge.sendToHandler resolves mounted callable paths under pieces and entities", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree);
  const calls: Array<{
    source: "piece" | "entity";
    channel: "input" | "result";
    path: (string | number)[] | undefined;
    value: unknown;
  }> = [];
  const makeChannel = (
    source: "piece" | "entity",
    channel: "input" | "result",
  ) => ({
    key: (key: string) => ({
      send: (value: unknown) => {
        calls.push({ source, channel, value, path: [key] });
      },
    }),
  });
  const piece = {
    id: "of:entity-123",
    input: {
      getCell: () => Promise.resolve(makeChannel("piece", "input")),
    },
    result: {
      getCell: () => Promise.resolve(makeChannel("piece", "result")),
    },
    pieces: () => ({
      runtime: { idle: () => Promise.resolve() },
      synced: () => Promise.resolve(),
    }),
  };
  const hiddenEntity = {
    id: "of:hidden-456",
    input: {
      getCell: () => Promise.resolve(makeChannel("entity", "input")),
    },
    result: {
      getCell: () => Promise.resolve(makeChannel("entity", "result")),
    },
    pieces: () => ({
      runtime: { idle: () => Promise.resolve() },
      synced: () => Promise.resolve(),
    }),
  };

  const spaceIno = tree.addDir(tree.rootIno, "home");
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const entitiesIno = tree.addDir(spaceIno, "entities");
  const pieceIno = tree.addDir(piecesIno, "notes");
  const pieceResultIno = tree.addDir(pieceIno, "result", "object");
  const entityIno = tree.addDir(entitiesIno, "hidden-456");
  const entityResultIno = tree.addDir(entityIno, "result", "object");
  const script = buildCallableScript("/tmp/cf-exec");

  const piecesHandlerIno = tree.addCallable(
    pieceResultIno,
    "add.handler",
    "handler",
    "add",
    "result",
    script,
  );
  const entitiesHandlerIno = tree.addCallable(
    entityResultIno,
    "add.handler",
    "handler",
    "add",
    "result",
    script,
  );

  bridge.spaces.set("home", {
    pieces: {} as never,
    spaceIno,
    piecesIno,
    entitiesIno,
    pieceMap: new Map([["notes", "of:entity-123"]]),
    pieceInos: new Map([["notes", pieceIno]]),
    pieceControllers: new Map([["notes", piece as never]]),
    entityControllers: new Map([["of:hidden-456", hiddenEntity as never]]),
    allPieceIds: new Set(["of:entity-123"]),
    entityIds: new Set(["of:entity-123", "of:hidden-456"]),
    piecesHydrated: true,
    piecesMaterializing: false,
    pieceListSubscribed: true,
    pieceManifest: new Map(),
    pieceSubs: new Map(),
    did: "did:key:home",
    unsubscribes: [],
    usedNames: new Set(["notes"]),
    srcInos: new Map(),
    srcErrorLogInos: new Map(),
  });

  await bridge.sendToHandler(piecesHandlerIno, { count: 1 });
  await bridge.sendToHandler(entitiesHandlerIno, { count: 2 });

  assertEquals(calls, [
    {
      source: "piece",
      channel: "result",
      value: { count: 1 },
      path: ["add"],
    },
    {
      source: "entity",
      channel: "result",
      value: { count: 2 },
      path: ["add"],
    },
  ]);
});

Deno.test("CellBridge.sendToHandlerTarget survives callable inode rebuilds", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree);
  const calls: Array<{
    channel: "input" | "result";
    path: (string | number)[] | undefined;
    value: unknown;
  }> = [];
  const makeChannel = (channel: "input" | "result") => ({
    key: (key: string) => ({
      send: (value: unknown) => {
        calls.push({ channel, value, path: [key] });
      },
    }),
  });
  const piece = {
    id: "of:entity-123",
    input: {
      getCell: () => Promise.resolve(makeChannel("input")),
    },
    result: {
      getCell: () => Promise.resolve(makeChannel("result")),
    },
    pieces: () => ({
      runtime: { idle: () => Promise.resolve() },
      synced: () => Promise.resolve(),
    }),
  };

  const spaceIno = tree.addDir(tree.rootIno, "home");
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const entitiesIno = tree.addDir(spaceIno, "entities");
  const pieceIno = tree.addDir(piecesIno, "notes");
  const pieceResultIno = tree.addDir(pieceIno, "result", "object");
  const script = buildCallableScript("/tmp/cf-exec");

  const handlerIno = tree.addCallable(
    pieceResultIno,
    "add.handler",
    "handler",
    "add",
    "result",
    script,
  );

  bridge.spaces.set("home", {
    pieces: {} as never,
    spaceIno,
    piecesIno,
    entitiesIno,
    pieceMap: new Map([["notes", "of:entity-123"]]),
    pieceInos: new Map([["notes", pieceIno]]),
    pieceControllers: new Map([["notes", piece as never]]),
    entityControllers: new Map([["of:entity-123", piece as never]]),
    allPieceIds: new Set(["of:entity-123"]),
    entityIds: new Set(["of:entity-123"]),
    piecesHydrated: true,
    piecesMaterializing: false,
    pieceListSubscribed: true,
    pieceManifest: new Map(),
    pieceSubs: new Map(),
    did: "did:key:home",
    unsubscribes: [],
    usedNames: new Set(["notes"]),
    srcInos: new Map(),
    srcErrorLogInos: new Map(),
  });

  const target = bridge.resolveHandlerTarget(handlerIno);
  assertEquals(target !== null, true);

  tree.clear(pieceResultIno);

  await bridge.sendToHandlerTarget(target!, { count: 3 });

  assertEquals(calls, [
    { channel: "result", value: { count: 3 }, path: ["add"] },
  ]);
});

Deno.test("CellBridge.loadPieceTree materializes callable dirs from sparse result roots", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  interface FakeCell {
    schema: Record<string, unknown> | undefined;
    get(): unknown;
    getRaw(): unknown;
    asSchemaFromLinks(): FakeCell;
    key(segment: string): FakeCell;
    isStream?: () => boolean;
  }

  function makeCell(
    value: unknown,
    schema: Record<string, unknown> | undefined,
    children: Record<string, FakeCell> = {},
    options: { isStream?: boolean } = {},
  ): FakeCell {
    return {
      schema,
      get: () => value,
      getRaw: () => value,
      asSchemaFromLinks() {
        return this;
      },
      key(segment: string) {
        return children[segment] ?? makeCell(undefined, undefined);
      },
      isStream: options.isStream ? () => true : undefined,
    };
  }

  const handlerCell = makeCell(undefined, undefined, {}, { isStream: true });
  const toolCell = makeCell(
    {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "bound-source" },
    },
    undefined,
  );
  const resultCell = makeCell(
    undefined,
    {
      type: "object",
      properties: {
        recordMessage: { type: "object" },
        search: { type: "object" },
      },
    },
    {
      recordMessage: handlerCell,
      search: toolCell,
    },
  );

  const piece = {
    id: "of:entity-123",
    name: () => "Sparse Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () =>
        Promise.resolve(
          makeCell(undefined, { type: "object", properties: {} }),
        ),
      get: () => Promise.resolve(undefined),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve(undefined),
    },
  };

  interface SparsePiece {
    id: string;
    name(): string;
    getPatternMeta(): Promise<{ program?: unknown }>;
    input: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
    result: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
  }

  const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
    piece as never,
    tree.rootIno,
    "Sparse Fixture",
    "home",
  );
  await bridge.accessForTestingOnly.hydratePieceProp(pieceIno, "result");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(
    tree.lookup(resultIno!, "recordMessage.handler") !== undefined,
    true,
  );
  assertEquals(tree.lookup(resultIno!, "search.tool") !== undefined, true);

  const resultJson = JSON.parse(getFileContent(tree, pieceIno, "result.json"));
  assertEquals(resultJson.recordMessage, { "/handler": "recordMessage" });
  assertEquals(resultJson.search, { "/tool": "search" });
});

Deno.test("CellBridge.loadPieceTree keeps schema-backed callables beside populated result fields", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  interface FakeCell {
    schema: Record<string, unknown> | undefined;
    get(): unknown;
    getRaw(): unknown;
    asSchemaFromLinks(): FakeCell;
    key(segment: string): FakeCell;
    isStream?: () => boolean;
  }

  function makeCell(
    value: unknown,
    schema: Record<string, unknown> | undefined,
    children: Record<string, FakeCell> = {},
    options: { isStream?: boolean } = {},
  ): FakeCell {
    return {
      schema,
      get: () => value,
      getRaw: () => value,
      asSchemaFromLinks() {
        return this;
      },
      key(segment: string) {
        return children[segment] ?? makeCell(undefined, undefined);
      },
      isStream: options.isStream ? () => true : undefined,
    };
  }

  const titleCell = makeCell("hello", { type: "string" });
  const handlerCell = makeCell(undefined, undefined, {}, { isStream: true });
  const toolCell = makeCell(
    {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "bound-source" },
    },
    undefined,
  );
  const resultCell = makeCell(
    { title: "hello" },
    {
      type: "object",
      properties: {
        title: { type: "string" },
        recordMessage: { type: "object" },
        search: { type: "object" },
      },
    },
    {
      title: titleCell,
      recordMessage: handlerCell,
      search: toolCell,
    },
  );

  const piece = {
    id: "of:entity-123",
    name: () => "Mixed Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () =>
        Promise.resolve(
          makeCell(undefined, { type: "object", properties: {} }),
        ),
      get: () => Promise.resolve(undefined),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve({ title: "hello" }),
    },
  };

  interface MixedPiece {
    id: string;
    name(): string;
    getPatternMeta(): Promise<{ program?: unknown }>;
    input: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
    result: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
  }

  const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
    piece as never,
    tree.rootIno,
    "Mixed Fixture",
    "home",
  );
  await bridge.accessForTestingOnly.hydratePieceProp(pieceIno, "result");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(getFileContent(tree, resultIno!, "title"), "hello");
  assertEquals(
    tree.lookup(resultIno!, "recordMessage.handler") !== undefined,
    true,
  );
  assertEquals(tree.lookup(resultIno!, "search.tool") !== undefined, true);

  const resultJson = JSON.parse(getFileContent(tree, pieceIno, "result.json"));
  assertEquals(resultJson.title, "hello");
  assertEquals(resultJson.recordMessage, { "/handler": "recordMessage" });
  assertEquals(resultJson.search, { "/tool": "search" });
});

//
// parseSymlinkTarget tests
//

/** Helper: build a minimal tree mimicking a space with pieces. */
function buildTestTree(): {
  tree: FsTree;
  bridge: CellBridge;
  resultIno: bigint;
} {
  const tree = new FsTree();
  const bridge = new CellBridge(tree);

  // Build: /myspace/pieces/mypiece/result/
  const spaceIno = tree.addDir(tree.rootIno, "myspace");
  tree.addDir(spaceIno, "entities");
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const pieceIno = tree.addDir(piecesIno, "mypiece");
  const resultIno = tree.addDir(pieceIno, "result", "object");

  // Register known space
  bridge.knownSpaces.set("myspace", "did:key:z6MkMySpace");

  return { tree, bridge, resultIno };
}

Deno.test("parseSymlinkTarget - same-space entity ref", () => {
  const { bridge, resultIno } = buildTestTree();

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../entities/ba4jcbvpq3k5",
  );

  assertEquals(result, { id: "ba4jcbvpq3k5" });
});

Deno.test("parseSymlinkTarget - same-space entity ref with path", () => {
  const { bridge, resultIno } = buildTestTree();

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../entities/ba4jcbvpq3k5/items/0",
  );

  assertEquals(result, { id: "ba4jcbvpq3k5", path: ["items", "0"] });
});

Deno.test("parseSymlinkTarget - cross-space entity ref", () => {
  const { tree, bridge, resultIno } = buildTestTree();

  // Add another space
  const otherIno = tree.addDir(tree.rootIno, "other");
  tree.addDir(otherIno, "entities");
  bridge.knownSpaces.set("other", "did:key:z6MkOther");

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../other/entities/xyz123",
  );

  assertEquals(result, { id: "xyz123", space: "did:key:z6MkOther" });
});

Deno.test("parseSymlinkTarget - cross-space entity ref with path", () => {
  const { tree, bridge, resultIno } = buildTestTree();

  const otherIno = tree.addDir(tree.rootIno, "other");
  tree.addDir(otherIno, "entities");
  bridge.knownSpaces.set("other", "did:key:z6MkOther");

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../other/entities/xyz123/name",
  );

  assertEquals(result, {
    id: "xyz123",
    space: "did:key:z6MkOther",
    path: ["name"],
  });
});

Deno.test("parseSymlinkTarget - self-reference within piece", () => {
  const { bridge, resultIno } = buildTestTree();

  // Target points to input/items/0 within the same piece
  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../input/items/0",
  );

  assertEquals(result, { path: ["items", "0"] });
});

Deno.test("parseSymlinkTarget - escapes mount root returns null", () => {
  const { bridge, resultIno } = buildTestTree();

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../../escape",
  );

  assertEquals(result, null);
});

Deno.test("parseSymlinkTarget - unresolvable target returns null", () => {
  const { bridge, resultIno } = buildTestTree();

  // Resolves to mount root (no entities/ or pieces/ pattern)
  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../..",
  );

  assertEquals(result, null);
});

Deno.test("parseSymlinkTarget - unknown cross-space uses name as fallback", () => {
  const { bridge, resultIno } = buildTestTree();

  // "unknown" space isn't in knownSpaces
  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../unknown/entities/abc",
  );

  assertEquals(result, { id: "abc", space: "unknown" });
});

Deno.test("makeLinkResolver encodes unsafe link components", () => {
  const bridge = new CellBridge(new FsTree());
  const resolveLink = bridge.accessForTestingOnly.makeLinkResolver("home");

  assertEquals(
    resolveLink({
      "/": {
        "link@1": {
          id: "of:abc",
          space: "other:space",
          path: ["..", "has/slash", ":mac"],
        },
      },
    }, 0),
    "../../../other%3Aspace/entities/of%3Aabc/%2E%2E/has%2Fslash/%3Amac",
  );
});

Deno.test("makeLinkResolver leaves malformed link paths inert", () => {
  const bridge = new CellBridge(new FsTree());
  const resolveLink = bridge.accessForTestingOnly.makeLinkResolver("home");

  assertEquals(
    resolveLink({
      "/": {
        "link@1": {
          id: "of:abc",
          path: ["ok", 1],
        },
      },
    }, 0),
    null,
  );
});

Deno.test("a failure during a rebuild names where the entry mounts", async () => {
  // A rebuild of a prop that already exists assembles under a staging root and
  // reconciles onto the live tree afterwards. The staging name is internal and
  // never appears in the mount, so the failure names the live path instead.
  const tree = new FsTree();
  const piece = tree.addDir(tree.addDir(tree.rootIno, "pieces"), "todo-app");
  const unserializable = { items: [{ count: 1n }] };

  const rebuild = await assertRejects(
    () => buildPendingJsonTreeAsync(tree, piece, "result", unserializable),
    Error,
    "/pieces/todo-app/result.json",
  );
  assertEquals(rebuild.message.includes(".result.pending"), false);

  const firstHydration = await assertRejects(
    () => buildJsonTreeAsync(tree, piece, "result", unserializable),
    Error,
  );
  // Both routes reach the same mounted file, so both name the same path.
  assertEquals(firstHydration.message, rebuild.message);
});

Deno.test("a failure under the [FS] staging container names the piece entry", () => {
  const tree = new FsTree();
  const piece = tree.addDir(tree.addDir(tree.rootIno, "pieces"), "todo-app");
  const stage = tree.addDir(piece, ".fs.pending");
  const fsValue = {
    type: "application/json",
    content: { count: 1n },
  } as unknown as FsValue;

  // The staging container's children land on the piece directory itself, so
  // the container drops out of the path rather than being renamed.
  assertThrows(
    () => buildFsProjection(tree, stage, fsValue, "of:entity-1"),
    Error,
    "/pieces/todo-app/index.json",
  );
});
