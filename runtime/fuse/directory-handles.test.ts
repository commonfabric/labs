import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  collectDirectorySnapshot,
  collectVirtualDirectorySnapshot,
  DirectoryHandleMap,
  type DirectoryPreparer,
  type DirectorySnapshotEntry,
  type FuseOperationPreparer,
  FuseOperationState,
  prepareDirectoryForHandle,
  replyWithRetainedState,
  visitDirectoryEntries,
} from "./directory-handles.ts";
import { DIR_MODE, DIR_MODE_RW } from "./platform.ts";
import { FsTree } from "./tree.ts";

function countingPreparer(
  calls: bigint[],
  prepare: (ino: bigint) => Promise<boolean> = () => Promise.resolve(true),
): DirectoryPreparer {
  return {
    shouldPrepareDirectory: () => true,
    prepareDirectory: (ino) => {
      calls.push(ino);
      return prepare(ino);
    },
  };
}

Deno.test("directory preparation runs once per open handle", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const calls: bigint[] = [];
  const preparer = countingPreparer(calls);

  const first = handles.open(ino);
  await prepareDirectoryForHandle(handles, first, ino, preparer);
  assertEquals(calls, [ino]);
  assertEquals(
    prepareDirectoryForHandle(handles, first, ino, preparer),
    undefined,
  );
  assertEquals(calls, [ino]);

  handles.close(first);
  const second = handles.open(ino);
  await prepareDirectoryForHandle(handles, second, ino, preparer);
  assertEquals(calls, [ino, ino]);
});

Deno.test("untracked readdir calls preserve per-read preparation", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const calls: bigint[] = [];
  const preparer = countingPreparer(calls);

  await prepareDirectoryForHandle(handles, 0n, ino, preparer);
  await prepareDirectoryForHandle(handles, 0n, ino, preparer);
  assertEquals(calls, [ino, ino]);
});

Deno.test("concurrent reads share one handle preparation", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const fh = handles.open(ino);
  const calls: bigint[] = [];
  const ready = Promise.withResolvers<boolean>();
  const preparer = countingPreparer(calls, () => ready.promise);

  const first = prepareDirectoryForHandle(handles, fh, ino, preparer)!;
  const second = prepareDirectoryForHandle(handles, fh, ino, preparer)!;
  assertEquals(first, second);
  assertEquals(calls, [ino]);

  ready.resolve(true);
  await Promise.all([first, second]);
});

Deno.test("failed directory preparation can be retried", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const fh = handles.open(ino);
  const error = new Error("identifier listing failed");
  let attempts = 0;
  const preparer = countingPreparer([], () => {
    attempts++;
    return attempts === 1 ? Promise.reject(error) : Promise.resolve(true);
  });

  await assertRejects(
    () => prepareDirectoryForHandle(handles, fh, ino, preparer)!,
    Error,
    error.message,
  );
  await prepareDirectoryForHandle(handles, fh, ino, preparer);
  assertEquals(attempts, 2);
});

Deno.test("directory entries remain stable for continuation offsets", () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const fh = handles.open(ino);
  let liveEntries: DirectorySnapshotEntry[] = [
    { name: "first", ino: 100n, mode: 1 },
    { name: "second", ino: 101n, mode: 1 },
    { name: "third", ino: 102n, mode: 1 },
  ];
  const readEntries = () => liveEntries.slice();

  const firstPage = handles.snapshot(fh, ino, readEntries).slice(0, 2);
  liveEntries = liveEntries.slice(1);
  const continuation = handles.snapshot(fh, ino, readEntries).slice(2);

  assertEquals(firstPage.map(({ name }) => name), ["first", "second"]);
  assertEquals(continuation.map(({ name }) => name), ["third"]);

  handles.close(fh);
  const nextFh = handles.open(ino);
  assertEquals(
    handles.snapshot(nextFh, ino, readEntries).map(({ name }) => name),
    ["second", "third"],
  );
});

Deno.test("prepared virtual entries become the open handle snapshot", async () => {
  const tree = new FsTree();
  const ino = tree.addDir(tree.rootIno, "entities");
  const handles = new DirectoryHandleMap();
  const fh = handles.open(ino);
  const virtual = collectVirtualDirectorySnapshot(tree, ino, [
    "first",
    "second",
  ]);
  const preparer: DirectoryPreparer = {
    shouldPrepareDirectory: () => true,
    prepareDirectory: () => Promise.resolve(true),
    prepareDirectorySnapshot: () => Promise.resolve(virtual),
  };

  assertEquals(
    await prepareDirectoryForHandle(handles, fh, ino, preparer),
    virtual,
  );
  assertEquals(
    handles.snapshot(fh, ino, () => []),
    virtual,
  );
  assertEquals(
    prepareDirectoryForHandle(handles, fh, ino, preparer),
    undefined,
  );
});

Deno.test("directory snapshots capture entry modes", () => {
  const tree = new FsTree(() => 0);
  const parent = tree.addDir(tree.rootIno, "parent");
  const readOnly = tree.addDir(parent, "read-only");
  const writable = tree.addDir(parent, "writable");

  assertEquals(
    collectDirectorySnapshot(tree, parent, (ino) => ino === writable),
    [
      { name: ".", ino: parent, mode: DIR_MODE },
      { name: "..", ino: tree.rootIno, mode: DIR_MODE },
      { name: "read-only", ino: readOnly, mode: DIR_MODE },
      { name: "writable", ino: writable, mode: DIR_MODE_RW },
    ],
  );
});

Deno.test("untracked directory reads use the current entries", () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  let name = "first";
  const readEntries = (): DirectorySnapshotEntry[] => [
    { name, ino: 100n, mode: 1 },
  ];

  assertEquals(handles.snapshot(0n, ino, readEntries)[0].name, "first");
  name = "second";
  assertEquals(handles.snapshot(0n, ino, readEntries)[0].name, "second");
});

Deno.test("FuseOperationState follows lookup and directory callback lifetimes", async () => {
  const tree = new FsTree();
  const directory = tree.addDir(tree.rootIno, "directory");
  const staticFile = tree.addFile(directory, "static", "value", "string");
  const dynamicFile = tree.addFile(directory, "dynamic", "value", "string");
  const lookupRefs: Array<["retain" | "forget", bigint, bigint]> = [];
  const openRefs: Array<["retain" | "release", bigint]> = [];
  const preparer: FuseOperationPreparer = {
    shouldPrepareDirectory: () => false,
    prepareDirectory: () => Promise.resolve(true),
    shouldPrepareLookup: (_parentIno, name) => name !== "static",
    prepareLookup: (_parentIno, name) => Promise.resolve(name === "dynamic"),
    retainEntityProjectionLookup: (ino, count = 1n) => {
      lookupRefs.push(["retain", ino, count]);
    },
    releaseEntityProjectionLookup: (ino, count = 1n) => {
      lookupRefs.push(["forget", ino, count]);
    },
    retainEntityProjectionOpen: (ino) => openRefs.push(["retain", ino]),
    releaseEntityProjectionOpen: (ino) => openRefs.push(["release", ino]),
  };
  const operations = new FuseOperationState(tree, preparer);

  assertEquals(await operations.prepareLookup(directory, "static"), staticFile);
  assertEquals(
    await operations.prepareLookup(directory, "dynamic"),
    dynamicFile,
  );
  assertEquals(await operations.prepareLookup(directory, "missing"), undefined);
  operations.forget(staticFile, 1n);
  operations.forget(dynamicFile, 1n);

  assertEquals(operations.openDirectory(staticFile), undefined);
  const fh = operations.openDirectory(directory);
  assertEquals(typeof fh, "bigint");
  assertEquals(operations.prepareDirectory(fh!, directory), undefined);
  assertEquals(
    operations.directorySnapshot(fh!, directory).map(({ name }) => name),
    [".", "..", "static", "dynamic"],
  );
  operations.closeDirectory(999n, directory);
  operations.closeDirectory(fh!, directory);

  assertEquals(lookupRefs, [
    ["retain", staticFile, 1n],
    ["retain", dynamicFile, 1n],
    ["forget", staticFile, 1n],
    ["forget", dynamicFile, 1n],
  ]);
  assertEquals(openRefs, [
    ["retain", directory],
    ["release", directory],
  ]);
});

Deno.test("directory callback helpers skip stale children and stop at buffer boundaries", () => {
  const tree = new FsTree();
  const directory = tree.addDir(tree.rootIno, "directory");
  const stale = tree.addFile(directory, "stale", "value", "string");
  tree.inodes.delete(stale);
  assertEquals(
    collectDirectorySnapshot(tree, directory).map(({ name }) => name),
    [".", ".."],
  );

  const visited: string[] = [];
  visitDirectoryEntries(
    [
      { name: "first", ino: 2n, mode: DIR_MODE },
      { name: "second", ino: 3n, mode: DIR_MODE },
    ],
    0,
    (entry) => {
      visited.push(entry.name);
      return false;
    },
  );
  assertEquals(visited, ["first"]);
});

Deno.test("failed FUSE replies roll back retained request state", () => {
  let rollbacks = 0;
  assertEquals(
    replyWithRetainedState(() => 0, () => rollbacks++),
    true,
  );
  assertEquals(rollbacks, 0);

  assertEquals(
    replyWithRetainedState(() => -1, () => rollbacks++),
    false,
  );
  assertEquals(rollbacks, 1);

  assertThrows(
    () =>
      replyWithRetainedState(
        () => {
          throw new Error("reply failed");
        },
        () => rollbacks++,
      ),
    Error,
    "reply failed",
  );
  assertEquals(rollbacks, 2);
});
