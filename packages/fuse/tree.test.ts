/**
 * Unit tests for `FsTree`, the inode tree behind a mount: adding, renaming,
 * and removing entries, the CFC directory entry annotations that ride along,
 * subtree transplants, `mtime` bookkeeping, and generated files.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CfcProjectionAnnotator } from "./annotations.ts";
import { FsTree } from "./tree.ts";
import type { JsonType } from "./types.ts";

const decoder = new TextDecoder();

/** Compact description of a subtree for `build()`. */
type BuildSpec =
  | { file: string; jsonType?: JsonType }
  | { symlink: string }
  | { dir: Record<string, BuildSpec>; jsonType?: "object" | "array" };

/** Builds a subtree from a compact spec, so transplant tests stay readable. */
function build(
  tree: FsTree,
  parent: bigint,
  name: string,
  spec: BuildSpec,
): bigint {
  if ("file" in spec) {
    return tree.addFile(parent, name, spec.file, spec.jsonType ?? "string");
  }
  if ("symlink" in spec) {
    return tree.addSymlink(parent, name, spec.symlink);
  }
  const dirIno = tree.addDir(parent, name, spec.jsonType ?? "object");
  for (const [childName, childSpec] of Object.entries(spec.dir)) {
    build(tree, dirIno, childName, childSpec);
  }
  return dirIno;
}

describe("FsTree", () => {
  describe("instance members", () => {
    describe("addDir()", () => {
      it("returns an inode that `lookup()` resolves from the parent, holding a `dir` node", () => {
        const tree = new FsTree();
        const ino = tree.addDir(tree.rootIno, "mydir");
        expect(tree.lookup(tree.rootIno, "mydir")).toBe(ino);
        const node = tree.getNode(ino);
        expect(node?.kind).toBe("dir");
      });
    });

    describe("addFile()", () => {
      it("returns an inode that `lookup()` resolves, holding the string's bytes and JSON type", () => {
        const tree = new FsTree();
        const ino = tree.addFile(
          tree.rootIno,
          "hello.txt",
          "hello world",
          "string",
        );
        expect(tree.lookup(tree.rootIno, "hello.txt")).toBe(ino);
        const node = tree.getNode(ino);
        expect(node?.kind).toBe("file");
        if (node?.kind === "file") {
          expect(decoder.decode(node.content)).toBe("hello world");
          expect(node.jsonType).toBe("string");
        }
      });

      it("stores `Uint8Array` content as given", () => {
        const tree = new FsTree();
        const bytes = new TextEncoder().encode("hello world");
        const ino = tree.addFile(tree.rootIno, "hello.txt", bytes, "string");
        const node = tree.getNode(ino);
        expect(node?.kind).toBe("file");
        if (node?.kind === "file") {
          expect(decoder.decode(node.content)).toBe("hello world");
        }
      });

      it("records the clock time at the call as the node's `mtime`", () => {
        let clock = 1_000;
        const tree = new FsTree(() => clock);
        clock = 2_000;
        const ino = tree.addFile(tree.rootIno, "f", "hi", "string");
        expect(tree.getNode(ino)?.mtime).toBe(2_000);
      });
    });

    describe("getPath()", () => {
      it("returns the full path of a deeply nested directory", () => {
        const tree = new FsTree();
        const a = tree.addDir(tree.rootIno, "a");
        const b = tree.addDir(a, "b");
        const c = tree.addDir(b, "c");
        expect(tree.getPath(c)).toBe("/a/b/c");
      });
    });

    describe("rename()", () => {
      it("leaves `lookup()` returning the inode under the new name and `undefined` under the old, within one parent", () => {
        const tree = new FsTree();
        const ino = tree.addDir(tree.rootIno, "original");
        tree.rename(tree.rootIno, "original", tree.rootIno, "renamed");
        expect(tree.lookup(tree.rootIno, "original")).toBeUndefined();
        expect(tree.lookup(tree.rootIno, "renamed")).toBe(ino);
        expect(tree.getPath(ino)).toBe("/renamed");
      });

      it("carries the CFC directory entry annotation to the new name", () => {
        const tree = new FsTree();
        const annotator = new CfcProjectionAnnotator(tree, {
          space: "did:key:zSpace",
          entity: "of:piece",
          rootKind: "pieces",
          cell: "result",
          generation: "generation-1",
          labelView: {
            version: 1,
            entries: [{
              path: ["title"],
              label: {
                confidentiality: [{ type: "test-label", value: "secret" }],
              },
            }],
          },
        });
        const parentIno = tree.addDir(tree.rootIno, "result", "object");
        annotator.annotateJsonDirectory(parentIno, [], { title: "old" });
        const childIno = tree.addFile(parentIno, "title", "old", "string");
        annotator.annotateJsonScalar(childIno, ["title"], "old");
        annotator.annotateEntry(parentIno, "title", childIno, {
          labelPath: ["title"],
        });

        tree.rename(parentIno, "title", parentIno, "renamed");

        const entries = tree.getCfcAnnotation(parentIno)?.entries?.entries;
        expect(entries?.map((entry) => entry.name)).toEqual(["renamed"]);
        expect(entries?.[0].kind).toBe("file");
        expect(entries?.[0].childRef).toEqual(
          tree.getCfcAnnotation(childIno)?.ref,
        );
        expect(entries?.[0].nameDigest).toMatch(/^fnv1a32:/);
      });

      it("updates paths transitively when moving across parents", () => {
        const tree = new FsTree();
        const src = tree.addDir(tree.rootIno, "src");
        const dst = tree.addDir(tree.rootIno, "dst");
        const child = tree.addDir(src, "child");
        const grandchild = tree.addFile(child, "file.txt", "data", "string");

        tree.rename(src, "child", dst, "child");

        expect(tree.lookup(src, "child")).toBeUndefined();
        expect(tree.lookup(dst, "child")).toBe(child);
        expect(tree.getPath(child)).toBe("/dst/child");
        expect(tree.getPath(grandchild)).toBe("/dst/child/file.txt");
      });

      it("clears the target when renaming onto an existing name, leaving no orphan inode", () => {
        const tree = new FsTree();
        const a = tree.addDir(tree.rootIno, "a");
        const b = tree.addDir(tree.rootIno, "b");
        const sizeBeforeRename = tree.inodes.size;

        // rename "a" onto "b" — "b" should be cleared
        tree.rename(tree.rootIno, "a", tree.rootIno, "b");

        // "b" ino is gone, "a" ino now lives under name "b"
        expect(tree.inodes.has(b)).toBe(false);
        expect(tree.lookup(tree.rootIno, "b")).toBe(a);
        // inodes map decreased by 1 (the cleared "b" node)
        expect(tree.inodes.size).toBe(sizeBeforeRename - 1);
      });
    });

    describe("getCfcAnnotation()", () => {
      it("returns CFC directory entries sorted by name digest, whatever order they were added in", () => {
        const tree = new FsTree();
        const annotator = new CfcProjectionAnnotator(tree, {
          space: "did:key:zSpace",
          generation: "generation-1",
          labelView: { version: 1, entries: [] },
        });
        const parentIno = tree.addDir(tree.rootIno, "values", "object");
        annotator.annotateJsonDirectory(parentIno, [], {});

        const names = Array.from(
          { length: 1_000 },
          (_, index) => `entry-${(1_000 - index).toString().padStart(4, "0")}`,
        );
        for (const name of names) {
          const childIno = tree.addFile(parentIno, name, name, "string");
          annotator.annotateJsonScalar(childIno, [name], name);
          annotator.annotateEntry(parentIno, name, childIno);
        }

        const pendingEntries = tree.getNode(parentIno)?.cfc?.entries?.entries ??
          [];
        expect(pendingEntries.map((entry) => entry.name)).toEqual(names);

        const entries = tree.getCfcAnnotation(parentIno)?.entries?.entries ??
          [];
        expect(entries.map((entry) => entry.nameDigest)).toEqual(
          entries.map((entry) => entry.nameDigest).toSorted(),
        );
      });
    });

    describe("setCfcEntryAnnotation()", () => {
      it("rebuilds a missing lookup index", () => {
        const tree = new FsTree();
        const annotator = new CfcProjectionAnnotator(tree, {
          space: "did:key:zSpace",
          generation: "generation-1",
          labelView: { version: 1, entries: [] },
        });
        const parentIno = tree.addDir(tree.rootIno, "values", "object");
        annotator.annotateJsonDirectory(parentIno, [], { first: "old" });
        const firstIno = tree.addFile(parentIno, "first", "old", "string");
        annotator.annotateJsonScalar(firstIno, ["first"], "old");
        annotator.annotateEntry(parentIno, "first", firstIno);

        const indexes = tree.accessForTestingOnly.cfcEntryIndexes;
        indexes.delete(parentIno);

        annotator.annotateEntry(parentIno, "first", firstIno);
        expect(indexes.get(parentIno)?.get("first")).toBe(0);
        expect(tree.getCfcAnnotation(parentIno)?.entries?.entries.length)
          .toBe(1);
      });
    });

    describe("removeChild()", () => {
      it("leaves CFC entries unchanged when the removed child is unannotated", () => {
        const tree = new FsTree();
        const annotator = new CfcProjectionAnnotator(tree, {
          space: "did:key:zSpace",
          generation: "generation-1",
          labelView: { version: 1, entries: [] },
        });
        const parentIno = tree.addDir(tree.rootIno, "values", "object");
        annotator.annotateJsonDirectory(parentIno, [], { kept: "value" });
        const keptIno = tree.addFile(parentIno, "kept", "value", "string");
        annotator.annotateJsonScalar(keptIno, ["kept"], "value");
        annotator.annotateEntry(parentIno, "kept", keptIno);
        tree.addFile(parentIno, "unannotated", "temporary", "string");

        tree.removeChild(parentIno, "unannotated");

        expect(
          tree.getCfcAnnotation(parentIno)?.entries?.entries.map((entry) =>
            entry.name
          ),
        ).toEqual(["kept"]);
      });

      it("clears a directory and its nested file recursively", () => {
        const tree = new FsTree();
        const dir = tree.addDir(tree.rootIno, "dir");
        const file = tree.addFile(dir, "nested.txt", "content", "string");

        tree.removeChild(tree.rootIno, "dir");

        expect(tree.inodes.has(dir)).toBe(false);
        expect(tree.inodes.has(file)).toBe(false);
        expect(tree.lookup(tree.rootIno, "dir")).toBeUndefined();
      });

      it("leaves `isGenerated()` returning `false` and `refreshGenerated()` returning `undefined` for the removed inode", () => {
        const tree = new FsTree();
        const dir = tree.addDir(tree.rootIno, "d");
        const ino = tree.addGeneratedFile(
          dir,
          ".status",
          () => "{}",
          "object",
        );
        expect(tree.isGenerated(ino)).toBe(true);
        tree.removeChild(dir, ".status");
        expect(tree.isGenerated(ino)).toBe(false);
        expect(tree.refreshGenerated(ino)).toBeUndefined();
      });
    });

    describe("detachChild()", () => {
      it("returns `undefined` for a missing parent or child", () => {
        const tree = new FsTree();
        const parentIno = tree.addDir(tree.rootIno, "parent");

        expect(tree.detachChild(999_999n, "child")).toBeUndefined();
        expect(tree.detachChild(parentIno, "child")).toBeUndefined();
      });

      it("retains the unlinked subtree until it is cleared", () => {
        const tree = new FsTree();
        const detached = tree.addDir(tree.rootIno, "entity");
        const child = tree.addFile(detached, "value.txt", "old", "string");

        expect(tree.detachChild(tree.rootIno, "entity")).toBe(detached);
        expect(tree.lookup(tree.rootIno, "entity")).toBeUndefined();
        expect(tree.inodes.has(detached)).toBe(true);
        expect(tree.inodes.has(child)).toBe(true);

        const replacement = tree.addDir(tree.rootIno, "entity");
        tree.clear(detached);
        expect(tree.lookup(tree.rootIno, "entity")).toBe(replacement);
        expect(tree.inodes.has(detached)).toBe(false);
        expect(tree.inodes.has(child)).toBe(false);
      });
    });

    describe("clear()", () => {
      it("removes the subtree and keeps its sibling", () => {
        const tree = new FsTree();
        const a = tree.addDir(tree.rootIno, "a");
        const b = tree.addDir(tree.rootIno, "b");
        const aChild = tree.addFile(a, "f.txt", "x", "string");

        tree.clear(a);

        expect(tree.inodes.has(a)).toBe(false);
        expect(tree.inodes.has(aChild)).toBe(false);
        // sibling "b" is unaffected
        expect(tree.lookup(tree.rootIno, "b")).toBe(b);
        expect(tree.inodes.has(b)).toBe(true);
      });

      it("leaves the inode map unchanged for a missing inode", () => {
        const tree = new FsTree();
        const before = tree.inodes.size;
        tree.clear(9_999n);
        expect(tree.inodes.size).toBe(before);
      });
    });

    describe("getNameForIno()", () => {
      it("returns the registered child name, following a rename and a removal", () => {
        const tree = new FsTree();
        const ino = tree.addFile(
          tree.rootIno,
          "myfile.txt",
          "data",
          "string",
        );
        expect(tree.getNameForIno(ino)).toBe("myfile.txt");

        tree.rename(tree.rootIno, "myfile.txt", tree.rootIno, "renamed.txt");
        expect(tree.getNameForIno(ino)).toBe("renamed.txt");

        tree.removeChild(tree.rootIno, "renamed.txt");
        expect(tree.getNameForIno(ino)).toBeUndefined();
      });
    });

    describe("transplantSubtree()", () => {
      it("keeps the inode of a path that survives unchanged", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: {
            title: { file: "hello" },
            count: { file: "1", jsonType: "number" },
          },
        });
        const oldTitleIno = tree.lookup(oldIno, "title")!;
        const oldCountIno = tree.lookup(oldIno, "count")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: {
            title: { file: "hello" },
            count: { file: "1", jsonType: "number" },
          },
        });

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        // The survivor keeps its inodes at their original path.
        expect(tree.lookup(tree.rootIno, "input")).toBe(oldIno);
        expect(tree.lookup(oldIno, "title")).toBe(oldTitleIno);
        expect(tree.lookup(oldIno, "count")).toBe(oldCountIno);
        // Nothing changed, so no cache invalidation is reported.
        expect(changes.changedInodes.size).toBe(0);
        expect(changes.entryChanges.size).toBe(0);
        // The staging root is gone.
        expect(tree.lookup(tree.rootIno, ".input.pending")).toBeUndefined();
        expect(tree.inodes.has(pendingIno)).toBe(false);
      });

      it("preserves the inode of a changed file and reports it as changed", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: {
            title: { file: "old" },
            count: { file: "1", jsonType: "number" },
          },
        });
        const oldTitleIno = tree.lookup(oldIno, "title")!;
        const oldCountIno = tree.lookup(oldIno, "count")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: {
            title: { file: "new" },
            count: { file: "1", jsonType: "number" },
          },
        });

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        expect(tree.lookup(oldIno, "title")).toBe(oldTitleIno);
        const titleNode = tree.getNode(oldTitleIno);
        expect(titleNode?.kind).toBe("file");
        if (titleNode?.kind === "file") {
          expect(decoder.decode(titleNode.content)).toBe("new");
        }
        // Only the changed file is reported; the untouched sibling is not.
        expect([...changes.changedInodes]).toEqual([oldTitleIno]);
        expect(changes.changedInodes.has(oldCountIno)).toBe(false);
        expect(changes.entryChanges.size).toBe(0);
      });

      it("moves an added path across with its fresh inode", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { title: { file: "hello" } },
        });
        const oldTitleIno = tree.lookup(oldIno, "title")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { title: { file: "hello" }, extra: { file: "brand new" } },
        });
        const pendingExtraIno = tree.lookup(pendingIno, "extra")!;

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        // Surviving path keeps its inode; the added path keeps its fresh
        // inode.
        expect(tree.lookup(oldIno, "title")).toBe(oldTitleIno);
        const extraIno = tree.lookup(oldIno, "extra");
        expect(extraIno).toBe(pendingExtraIno);
        expect(tree.getPath(extraIno!)).toBe("/input/extra");
        // Only the parent's "extra" entry changed.
        expect(changes.entryChanges.get(oldIno)).toEqual(new Set(["extra"]));
        expect(changes.changedInodes.size).toBe(0);
      });

      it("frees the inode of a removed path", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { title: { file: "hello" }, gone: { file: "removed" } },
        });
        const oldGoneIno = tree.lookup(oldIno, "gone")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { title: { file: "hello" } },
        });

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        expect(tree.lookup(oldIno, "gone")).toBeUndefined();
        expect(tree.inodes.has(oldGoneIno)).toBe(false);
        expect(changes.entryChanges.get(oldIno)).toEqual(new Set(["gone"]));
      });

      it("replaces the inode when a path changes kind", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { data: { file: "scalar" } },
        });
        const oldDataIno = tree.lookup(oldIno, "data")!;

        // "data" goes from a file to a directory.
        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { data: { dir: { nested: { file: "x" } } } },
        });
        const pendingDataIno = tree.lookup(pendingIno, "data")!;

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        const dataIno = tree.lookup(oldIno, "data");
        expect(dataIno).toBe(pendingDataIno);
        expect(dataIno).not.toBe(oldDataIno);
        expect(tree.inodes.has(oldDataIno)).toBe(false);
        expect(tree.getNode(dataIno!)?.kind).toBe("dir");
        expect(tree.getPath(tree.lookup(dataIno!, "nested")!)).toBe(
          "/input/data/nested",
        );
        expect(changes.entryChanges.get(oldIno)).toEqual(new Set(["data"]));
      });

      it("preserves inodes through unchanged nested directories", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: {
            a: { dir: { b: { dir: { c: { file: "deep" } } } } },
          },
        });
        const oldA = tree.lookup(oldIno, "a")!;
        const oldB = tree.lookup(oldA, "b")!;
        const oldC = tree.lookup(oldB, "c")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: {
            a: { dir: { b: { dir: { c: { file: "deep" } } } } },
          },
        });

        const inodeCountBefore = tree.inodes.size;
        const changes = tree.transplantSubtree(oldIno, pendingIno);

        expect(tree.lookup(oldIno, "a")).toBe(oldA);
        expect(tree.lookup(oldA, "b")).toBe(oldB);
        expect(tree.lookup(oldB, "c")).toBe(oldC);
        expect(changes.changedInodes.size).toBe(0);
        expect(changes.entryChanges.size).toBe(0);
        // The four staging inodes (.input.pending and a/b/c) are freed;
        // nothing else leaks.
        expect(tree.inodes.size).toBe(inodeCountBefore - 4);
      });

      it("preserves a directory inode across an `object`/`array` flip", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { items: { dir: { "0": { file: "a" } }, jsonType: "object" } },
        });
        const oldItemsIno = tree.lookup(oldIno, "items")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { items: { dir: { "0": { file: "a" } }, jsonType: "array" } },
        });

        tree.transplantSubtree(oldIno, pendingIno);

        const itemsIno = tree.lookup(oldIno, "items");
        expect(itemsIno).toBe(oldItemsIno);
        const itemsNode = tree.getNode(itemsIno!);
        expect(itemsNode?.kind).toBe("dir");
        if (itemsNode?.kind === "dir") {
          expect(itemsNode.jsonType).toBe("array");
        }
      });

      it("adopts a changed symlink target", () => {
        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { link: { symlink: "../old/target" } },
        });
        const oldLinkIno = tree.lookup(oldIno, "link")!;

        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { link: { symlink: "../new/target" } },
        });

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        expect(tree.lookup(oldIno, "link")).toBe(oldLinkIno);
        const linkNode = tree.getNode(oldLinkIno);
        expect(linkNode?.kind).toBe("symlink");
        if (linkNode?.kind === "symlink") {
          expect(linkNode.target).toBe("../new/target");
        }
        expect([...changes.changedInodes]).toEqual([oldLinkIno]);
      });

      it("adopts a changed callable script", () => {
        const tree = new FsTree();
        const oldIno = tree.addDir(tree.rootIno, "result", "object");
        const oldCallableIno = tree.addCallable(
          oldIno,
          "run.handler",
          "handler",
          "cellKey",
          "result",
          new TextEncoder().encode("old script"),
        );

        const pendingIno = tree.addDir(
          tree.rootIno,
          ".result.pending",
          "object",
        );
        tree.addCallable(
          pendingIno,
          "run.handler",
          "handler",
          "cellKey",
          "result",
          new TextEncoder().encode("new script"),
        );

        const changes = tree.transplantSubtree(oldIno, pendingIno);

        expect(tree.lookup(oldIno, "run.handler")).toBe(oldCallableIno);
        const node = tree.getNode(oldCallableIno);
        expect(node?.kind).toBe("callable");
        if (node?.kind === "callable") {
          expect(new TextDecoder().decode(node.script)).toBe("new script");
        }
        expect([...changes.changedInodes]).toEqual([oldCallableIno]);
      });

      it("throws when the roots differ in kind", () => {
        const tree = new FsTree();
        const dirIno = tree.addDir(tree.rootIno, "input", "object");
        const fileIno = tree.addFile(
          tree.rootIno,
          ".input.pending",
          "x",
          "string",
        );

        expect(() => tree.transplantSubtree(dirIno, fileIno)).toThrow();
      });

      it("throws when a root inode does not exist", () => {
        const tree = new FsTree();
        const dir = tree.addDir(tree.rootIno, "dir");
        expect(() => tree.transplantSubtree(dir, 9_999n)).toThrow();
      });

      it("throws, naming the replacement's inode, when a name in both directories has no node in the replacement", () => {
        // Drops the replacement child's node through the exposed inode map
        // while leaving its entry listed, which is the state the check reports.

        const tree = new FsTree();
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { data: { file: "old" } },
        });
        const pendingIno = tree.addDir(tree.rootIno, ".input.pending");
        const pendingChildIno = tree.addFile(
          pendingIno,
          "data",
          "new",
          "string",
        );
        tree.inodes.delete(pendingChildIno);

        expect(() => tree.transplantSubtree(oldIno, pendingIno)).toThrow(
          `Transplant child "data" names inode ${pendingChildIno}, which does not exist`,
        );
      });

      it("throws, naming the live inode, when a name in both directories has no node in the live tree", () => {
        // Drops the live child's node through the exposed inode map while
        // leaving its entry listed, which is the state the check reports.

        const tree = new FsTree();
        const oldIno = tree.addDir(tree.rootIno, "input");
        const oldChildIno = tree.addFile(oldIno, "data", "old", "string");
        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { data: { file: "new" } },
        });
        tree.inodes.delete(oldChildIno);

        expect(() => tree.transplantSubtree(oldIno, pendingIno)).toThrow(
          `Transplant child "data" names inode ${oldChildIno}, which does not exist`,
        );
      });

      it("removes a vanished child's CFC directory entry", () => {
        const tree = new FsTree();
        const annotator = new CfcProjectionAnnotator(tree, {
          space: "did:key:zSpace",
          entity: "of:piece",
          rootKind: "pieces",
          cell: "result",
          generation: "generation-1",
          labelView: { version: 1, entries: [] },
        });

        const oldIno = tree.addDir(tree.rootIno, "result", "object");
        annotator.annotateJsonDirectory(oldIno, [], { keep: "a", gone: "b" });
        const keepIno = tree.addFile(oldIno, "keep", "a", "string");
        annotator.annotateJsonScalar(keepIno, ["keep"], "a");
        annotator.annotateEntry(oldIno, "keep", keepIno);
        const goneIno = tree.addFile(oldIno, "gone", "b", "string");
        annotator.annotateJsonScalar(goneIno, ["gone"], "b");
        annotator.annotateEntry(oldIno, "gone", goneIno);

        // Rebuild without "gone".
        const pendingIno = tree.addDir(
          tree.rootIno,
          ".result.pending",
          "object",
        );
        annotator.annotateJsonDirectory(pendingIno, [], { keep: "a" });
        const pendingKeepIno = tree.addFile(
          pendingIno,
          "keep",
          "a",
          "string",
        );
        annotator.annotateJsonScalar(pendingKeepIno, ["keep"], "a");
        annotator.annotateEntry(pendingIno, "keep", pendingKeepIno);

        tree.transplantSubtree(oldIno, pendingIno);

        const entries = tree.getCfcAnnotation(oldIno)?.entries?.entries;
        expect(entries?.map((entry) => entry.name)).toEqual(["keep"]);
      });

      it("advances the `mtime` of a changed file and not of an unchanged one", () => {
        let clock = 1_000;
        const tree = new FsTree(() => clock);
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: {
            title: { file: "old" },
            count: { file: "1", jsonType: "number" },
          },
        });
        const titleIno = tree.lookup(oldIno, "title")!;
        const countIno = tree.lookup(oldIno, "count")!;

        clock = 5_000;
        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: {
            title: { file: "new" },
            count: { file: "1", jsonType: "number" },
          },
        });
        tree.transplantSubtree(oldIno, pendingIno);

        // The changed file's mtime advances to the transplant time; the
        // unchanged sibling keeps its original mtime.
        expect(tree.getNode(titleIno)?.mtime).toBe(5_000);
        expect(tree.getNode(countIno)?.mtime).toBe(1_000);
      });

      it("advances a directory's `mtime` when its entries change", () => {
        let clock = 1_000;
        const tree = new FsTree(() => clock);
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { keep: { file: "a" } },
        });

        clock = 5_000;
        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { keep: { file: "a" }, added: { file: "b" } },
        });
        tree.transplantSubtree(oldIno, pendingIno);

        // The directory gained an entry, so its mtime advances.
        expect(tree.getNode(oldIno)?.mtime).toBe(5_000);
      });

      it("leaves a directory's `mtime` alone when only a child's content changes", () => {
        let clock = 1_000;
        const tree = new FsTree(() => clock);
        const oldIno = build(tree, tree.rootIno, "input", {
          dir: { title: { file: "old" } },
        });

        clock = 5_000;
        const pendingIno = build(tree, tree.rootIno, ".input.pending", {
          dir: { title: { file: "new" } },
        });
        tree.transplantSubtree(oldIno, pendingIno);

        // The directory's own entry set is unchanged, so its mtime is
        // preserved even though a child's content changed.
        expect(tree.getNode(oldIno)?.mtime).toBe(1_000);
      });
    });

    describe("updateFile()", () => {
      it("advances `mtime` only when the content changes", () => {
        let clock = 1_000;
        const tree = new FsTree(() => clock);
        const ino = tree.addFile(tree.rootIno, "f", "hi", "string");
        expect(tree.getNode(ino)?.mtime).toBe(1_000);

        clock = 2_000;
        tree.updateFile(ino, "hi", "string"); // same bytes
        expect(tree.getNode(ino)?.mtime).toBe(1_000);

        clock = 3_000;
        tree.updateFile(ino, "bye", "string"); // changed
        expect(tree.getNode(ino)?.mtime).toBe(3_000);
      });

      it("advances `mtime` strictly even when the clock does not move", () => {
        const clock = 1_000; // never advances
        const tree = new FsTree(() => clock);
        const ino = tree.addFile(tree.rootIno, "f", "a", "string");
        expect(tree.getNode(ino)?.mtime).toBe(1_000);

        tree.updateFile(ino, "b", "string");
        expect(tree.getNode(ino)?.mtime).toBe(1_001);

        tree.updateFile(ino, "c", "string");
        expect(tree.getNode(ino)?.mtime).toBe(1_002);
      });

      it("throws for a generated file", () => {
        const tree = new FsTree();
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          ".status",
          () => "{}",
          "object",
        );
        expect(() => tree.updateFile(ino, "{}")).toThrow(
          "is a generated file",
        );
      });
    });

    describe("touch()", () => {
      it("advances a directory's `mtime` strictly upward, and returns without throwing for a missing inode", () => {
        const clock = 1_000; // does not advance
        const tree = new FsTree(() => clock);
        const dir = tree.addDir(tree.rootIno, "dir");
        expect(tree.getNode(dir)?.mtime).toBe(1_000);

        tree.touch(dir);
        expect(tree.getNode(dir)?.mtime).toBe(1_001);
        tree.touch(dir);
        expect(tree.getNode(dir)?.mtime).toBe(1_002);

        // Touching a missing inode is a no-op.
        tree.touch(9_999n);
      });
    });

    describe("addGeneratedFile()", () => {
      it("publishes an initial render", () => {
        const tree = new FsTree();
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          ".status",
          () => "count=0",
          "object",
        );

        expect(tree.lookup(tree.rootIno, ".status")).toBe(ino);
        expect(tree.isGenerated(ino)).toBe(true);

        const node = tree.getNode(ino)!;
        if (node.kind !== "file") throw new Error("not a file");
        expect(decoder.decode(node.content)).toBe("count=0");
      });

      it("holds the published bytes between refreshes", () => {
        const tree = new FsTree();
        let count = 0;
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          ".status",
          () => `count=${count}`,
          "object",
        );
        const node = tree.getNode(ino)!;
        if (node.kind !== "file") throw new Error("not a file");

        // Reads serve these bytes and stop at the size reported alongside
        // them. State moving underneath must not change either until a
        // refresh.
        count = 1234;
        expect(decoder.decode(node.content)).toBe("count=0");
        expect(node.content.length).toBe("count=0".length);
      });

      it("publishes a copy of the render, on add and on refresh", () => {
        const tree = new FsTree();
        const shared = new Uint8Array([1]);
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          "bytes",
          () => shared,
          "array",
        );
        const contentOf = () =>
          (tree.getNode(ino) as { content: Uint8Array }).content;

        // The published content is a copy, not the renderer's buffer.
        expect(contentOf()).not.toBe(shared);

        // Mutating the renderer's own buffer does not change what a reader
        // is served until a refresh, and the change is then seen rather
        // than lost to an identity comparison against the same buffer.
        shared[0] = 2;
        expect([...contentOf()]).toEqual([1]);

        const published = tree.refreshGenerated(ino)!;
        expect([...published]).toEqual([2]);
        expect(published).not.toBe(shared);
      });
    });

    describe("refreshGenerated()", () => {
      it("publishes the current render", () => {
        const tree = new FsTree();
        let count = 0;
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          ".status",
          () => `count=${count}`,
          "object",
        );

        count = 7;
        expect(decoder.decode(tree.refreshGenerated(ino)!)).toBe("count=7");

        const node = tree.getNode(ino)!;
        if (node.kind !== "file") throw new Error("not a file");
        expect(decoder.decode(node.content)).toBe("count=7");
      });

      it("advances `mtime` only when the published bytes change", () => {
        let clock = 5_000;
        const tree = new FsTree(() => clock);
        let count = 0;
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          ".status",
          () => `count=${count}`,
          "object",
        );
        const mtimeOf = () => tree.getNode(ino)?.mtime;
        expect(mtimeOf()).toBe(5_000);

        // A render equal to the published one is not a modification.
        clock = 6_000;
        tree.refreshGenerated(ino);
        expect(mtimeOf()).toBe(5_000);

        // A counter moving without changing the length still advances the
        // mtime, so a client revalidating by attribute sees a change it
        // could not see by size.
        count = 9;
        clock = 7_000;
        tree.refreshGenerated(ino);
        expect(mtimeOf()).toBe(7_000);
        expect(
          decoder.decode(
            (tree.getNode(ino) as { content: Uint8Array }).content,
          ),
        ).toBe("count=9");

        // Two changes inside one clock tick still get distinct, advancing
        // times.
        count = 10;
        tree.refreshGenerated(ino);
        expect(mtimeOf()).toBe(7_001);
      });

      it("returns `undefined` for an inode that is not generated", () => {
        const tree = new FsTree();
        const ino = tree.addFile(tree.rootIno, "plain.txt", "hi", "string");
        expect(tree.refreshGenerated(ino)).toBeUndefined();
        expect(tree.refreshGenerated(999n)).toBeUndefined();
      });

      it("returns `undefined` when a tracked node is gone", () => {
        const tree = new FsTree();
        const ino = tree.addGeneratedFile(
          tree.rootIno,
          ".status",
          () => "{}",
          "object",
        );
        // The public API keeps the generated map and the inode map in step,
        // so this reaches past it, through the exposed map, to drop the node
        // while leaving it tracked. The guard has to return `undefined` for
        // the missing node rather than throw.
        tree.inodes.delete(ino);
        expect(tree.isGenerated(ino)).toBe(true);
        expect(tree.refreshGenerated(ino)).toBeUndefined();
      });
    });

    describe("isGenerated()", () => {
      it("returns `false` for a stored file", () => {
        const tree = new FsTree();
        const ino = tree.addFile(tree.rootIno, "plain.txt", "hi", "string");
        expect(tree.isGenerated(ino)).toBe(false);
      });
    });
  });
});
