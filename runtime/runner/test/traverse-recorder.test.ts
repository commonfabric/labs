/**
 * The recorder behind traverse capture.
 *
 * It exists to turn a run's traversals into a replayable fixture, so what it
 * owes is a faithful record: every invocation in order, each doc snapshotted
 * once, repeated selectors and links shared rather than copied, and a bound on
 * how much one run may accumulate.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";

import type { FabricValue } from "@commonfabric/data-model";
import type { Entity, Revision, State } from "@commonfabric/memory/interface";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  fixtureDocKey,
  TraverseCaptureRecorder,
  type TraverseFixture,
} from "../src/traverse-recorder.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import {
  ManagedStorageTransaction,
  type SchemaPathSelector,
} from "../src/traverse.ts";

const SPACE = "did:key:zTraverse" as IMemorySpaceAddress["space"];

function address(
  id: string,
  path: string[] = [],
  extra: { type?: string; scope?: string } = {},
): IMemorySpaceAddress {
  return {
    space: SPACE,
    id: id as IMemorySpaceAddress["id"],
    path,
    ...extra,
  } as IMemorySpaceAddress;
}

const selector = (path: string[]): SchemaPathSelector =>
  ({ path, schemaContext: undefined }) as unknown as SchemaPathSelector;

/** A transaction reading from documents whose full values `docs` gives. */
function txOver(
  docs: Record<string, FabricValue>,
): IExtendedStorageTransaction {
  const store = new Map<string, Revision<State>>();
  for (const [id, is] of Object.entries(docs)) {
    store.set(`${id}/application/json`, {
      the: "application/json",
      of: id as Entity,
      is,
      since: 1,
    });
  }
  return new ExtendedStorageTransaction(
    new ManagedStorageTransaction(new StoreObjectManager(store)),
  );
}

/** Reads the root of each of `ids` through `recorder`'s wrapper of `tx`. */
function readThrough(
  recorder: TraverseCaptureRecorder,
  tx: IExtendedStorageTransaction,
  ids: string[],
): void {
  const wrapped = recorder.wrapTx(tx);
  for (const id of ids) wrapped.read(address(id, ["value"]));
}

describe("traverse-recorder", () => {
  describe("fixtureDocKey", () => {
    it("fills in the default scope and type", () => {
      expect(fixtureDocKey({ space: "s", id: "of:x" })).toBe(
        "s|space|of:x|application/json",
      );
    });

    it("keeps a scope and type the address carries", () => {
      expect(
        fixtureDocKey({
          space: "s",
          id: "of:x",
          scope: "user",
          type: "text/plain",
        }),
      ).toBe("s|user|of:x|text/plain");
    });

    it("separates two docs that differ only in scope", () => {
      const a = fixtureDocKey({ space: "s", id: "of:x", scope: "space" });
      const b = fixtureDocKey({ space: "s", id: "of:x", scope: "user" });
      expect(a).not.toBe(b);
    });
  });

  describe("recordInvocation", () => {
    it("records an invocation with its address, selector and `traverseCells` flag", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:doc", ["a"]) },
        selector(["a"]),
        undefined,
        { traverseCells: true },
        undefined,
      );

      const fixture = recorder.toFixture("name", "source");
      expect(fixture.invocations.length).toBe(1);
      const only = fixture.invocations[0];
      expect(only.address.id).toBe("of:doc");
      expect(only.address.path).toEqual(["a"]);
      expect(only.address.type).toBe("application/json");
      expect(only.traverseCells).toBe(true);
    });

    it("records `inlineArrayItemsInPlace` for a context that sets it", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:doc", ["a"]) },
        selector(["a"]),
        undefined,
        { traverseCells: true, inlineArrayItemsInPlace: true },
        undefined,
      );

      const [only] = recorder.toFixture("name", "source").invocations;
      expect(only.inlineArrayItemsInPlace).toBe(true);
    });

    it("leaves `inlineArrayItemsInPlace` out for a context that does not set it", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:doc", ["a"]) },
        selector(["a"]),
        undefined,
        { traverseCells: true, inlineArrayItemsInPlace: false },
        undefined,
      );

      const [only] = recorder.toFixture("name", "source").invocations;
      expect("inlineArrayItemsInPlace" in only).toBe(false);
    });

    it("copies the address path rather than aliasing the caller's", () => {
      const recorder = new TraverseCaptureRecorder();
      const path = ["a"];
      recorder.recordInvocation(
        { address: address("of:doc", path) },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );
      path.push("mutated");

      expect(recorder.toFixture("n", "s").invocations[0].address.path).toEqual(
        ["a"],
      );
    });

    it("gives one context object one id across invocations", () => {
      const recorder = new TraverseCaptureRecorder();
      const context = { traverseCells: false };
      for (let i = 0; i < 3; i++) {
        recorder.recordInvocation(
          { address: address(`of:doc${i}`) },
          selector(["a"]),
          undefined,
          context,
          undefined,
        );
      }

      const ids = recorder.toFixture("n", "s").invocations.map((i) =>
        i.context
      );
      expect(new Set(ids).size).toBe(1);
    });

    it("gives distinct context objects distinct ids", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:a") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );
      recorder.recordInvocation(
        { address: address("of:b") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );

      const ids = recorder.toFixture("n", "s").invocations.map((i) =>
        i.context
      );
      expect(new Set(ids).size).toBe(2);
    });

    it("records a memo only when the traversal had one", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:with") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        {},
      );
      recorder.recordInvocation(
        { address: address("of:without") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );

      const [withMemo, withoutMemo] = recorder.toFixture("n", "s").invocations;
      expect(withMemo.memo).not.toBe(undefined);
      expect("memo" in withoutMemo).toBe(false);
    });

    it("records a link only when the traversal followed one", () => {
      const recorder = new TraverseCaptureRecorder();
      const link = {
        space: SPACE,
        id: "of:target",
        path: [],
      } as unknown as NormalizedFullLink;
      recorder.recordInvocation(
        { address: address("of:doc") },
        selector(["a"]),
        link,
        { traverseCells: false },
        undefined,
      );
      recorder.recordInvocation(
        { address: address("of:doc2") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );

      const [followed, plain] = recorder.toFixture("n", "s").invocations;
      expect(followed.link).not.toBe(undefined);
      expect("link" in plain).toBe(false);
    });

    it("stops recording at the cap and keeps what it already had", () => {
      const recorder = new TraverseCaptureRecorder(2);
      for (let i = 0; i < 5; i++) {
        recorder.recordInvocation(
          { address: address(`of:doc${i}`) },
          selector(["a"]),
          undefined,
          { traverseCells: false },
          undefined,
        );
      }

      const fixture = recorder.toFixture("n", "s");
      expect(fixture.invocations.length).toBe(2);
      expect(fixture.invocations.map((i) => i.address.id)).toEqual([
        "of:doc0",
        "of:doc1",
      ]);
    });
  });

  describe("toFixture", () => {
    it("carries the name and source it is given, and when it captured", () => {
      const fixture = new TraverseCaptureRecorder().toFixture("fx", "src.ts");
      expect(fixture.meta.name).toBe("fx");
      expect(fixture.meta.source).toBe("src.ts");
      expect(typeof fixture.meta.capturedAt).toBe("string");
      expect(fixture.version).toBe(2);
    });

    it("describes a run that traversed nothing", () => {
      const fixture = new TraverseCaptureRecorder().toFixture("fx", "src.ts");
      expect(fixture.invocations).toEqual([]);
    });

    it("keeps a link's schema and a selector's local `$ref`", () => {
      const recorder = new TraverseCaptureRecorder();
      const local = {
        $ref: "#/$defs/Name",
        $defs: { Name: { type: "string" } },
      } as const;
      const link: NormalizedFullLink = {
        space: SPACE,
        id: "of:target",
        scope: "space",
        path: [],
        schema: { type: "number" },
      };
      recorder.recordInvocation(
        { address: address("of:doc") },
        { path: ["value"], schema: local },
        link,
        { traverseCells: false },
        undefined,
      );

      const fixture = recorder.toFixture("n", "s");
      expect(fixture.links[0].schema).toEqual({ type: "number" });
      expect(fixture.selectors[0].schema).toEqual(local);
    });

    it("throws for captured schema documents that name each other", () => {
      // Content-addressed schema documents cannot form a cycle, so a capture
      // holding one is corrupt.

      const recorder = new TraverseCaptureRecorder();
      readThrough(
        recorder,
        txOver({
          "cid:fid1:cycle-a": {
            value: 1,
            schema: { $ref: "cid:fid1:cycle-b" },
          },
          "cid:fid1:cycle-b": {
            value: 2,
            schema: { $ref: "cid:fid1:cycle-a" },
          },
        }),
        ["cid:fid1:cycle-a", "cid:fid1:cycle-b"],
      );

      expect(() => recorder.toFixture("n", "s")).toThrow(
        "Circular captured schema documents",
      );
    });

    it("keeps a document's schema naming a captured document that names nothing", () => {
      const recorder = new TraverseCaptureRecorder();
      readThrough(
        recorder,
        txOver({
          "cid:fid1:chain-a": {
            value: 1,
            schema: { $ref: "cid:fid1:chain-b" },
          },
          "cid:fid1:chain-b": { value: 2 },
        }),
        ["cid:fid1:chain-a", "cid:fid1:chain-b"],
      );

      expect(recorder.toFixture("n", "s").docs).toEqual({
        [fixtureDocKey({ space: SPACE, id: "cid:fid1:chain-a" })]: {
          value: 1,
          schema: { $ref: "cid:fid1:chain-b" },
        },
        [fixtureDocKey({ space: SPACE, id: "cid:fid1:chain-b" })]: {
          value: 2,
        },
      });
    });
  });

  describe("wrapTx", () => {
    it("captures each document it reads once, as its full value", () => {
      const recorder = new TraverseCaptureRecorder();
      const tx = txOver({ "of:doc": { value: { a: 1 } } });
      readThrough(recorder, tx, ["of:doc", "of:doc"]);

      expect(recorder.toFixture("n", "s").docs).toEqual({
        [fixtureDocKey({ space: SPACE, id: "of:doc" })]: { value: { a: 1 } },
      });
    });

    it("captures nothing for an inline cell, which has no document", () => {
      const recorder = new TraverseCaptureRecorder();
      readThrough(recorder, txOver({}), ["snapshot:inline"]);

      expect(recorder.toFixture("n", "s").docs).toEqual({});
    });

    it("hands members other than reads to the transaction it wraps", () => {
      const tx = txOver({});
      const wrapped = new TraverseCaptureRecorder().wrapTx(tx);

      expect(wrapped.tx).toBe(tx.tx);
      expect(wrapped.status()).toEqual(tx.status());
    });
  });

  describe("flush", () => {
    it("writes the fixture to the path, named after the file", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const path = join(dir, "flushed.json");
        const recorder = new TraverseCaptureRecorder();
        recorder.recordInvocation(
          { address: address("of:doc", ["value"]) },
          selector(["value"]),
          undefined,
          { traverseCells: false },
          undefined,
        );
        recorder.flush(path);

        const fixture: TraverseFixture = JSON.parse(
          await Deno.readTextFile(path),
        );
        expect(fixture.meta.name).toBe("flushed");
        expect(fixture.meta.source).toBe(`CF_TRAVERSE_CAPTURE=${path}`);
        expect(fixture.invocations.map((i) => i.address.id)).toEqual([
          "of:doc",
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("capture configured from the environment", () => {
    // Capture is configured when the module loads, so each case runs the
    // helper, which records three invocations, in a process of its own and
    // reads what its exit wrote.

    const captureIn = async (
      dir: string,
      env: Record<string, string>,
      permissions: string[],
    ): Promise<TraverseFixture> => {
      const path = join(dir, "env-capture.json");
      const output = await runDenoCommandWithTemporaryLock({
        root: fromFileUrl(new URL("../../../", import.meta.url)),
        args: (lock) => [
          "run",
          "--frozen",
          `--lock=${lock}`,
          ...permissions,
          `--allow-write=${path}`,
          fromFileUrl(
            new URL("./traverse-recorder-capture-helper.ts", import.meta.url),
          ),
        ],
        env: { ...env, CF_TRAVERSE_CAPTURE: path },
      });
      expect(output.success, new TextDecoder().decode(output.stderr)).toBe(
        true,
      );
      return JSON.parse(await Deno.readTextFile(path));
    };

    it("stops recording at the cap `CF_TRAVERSE_CAPTURE_MAX` sets", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const fixture = await captureIn(
          dir,
          { CF_TRAVERSE_CAPTURE_MAX: "2" },
          ["--allow-env", "--allow-read"],
        );
        expect(fixture.meta.name).toBe("env-capture");
        expect(fixture.invocations.map((i) => i.address.id)).toEqual([
          "of:capture-0",
          "of:capture-1",
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("records every invocation when the cap cannot be read", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const fixture = await captureIn(
          dir,
          { CF_TRAVERSE_CAPTURE_MAX: "2" },
          ["--allow-env=CF_TRAVERSE_CAPTURE", "--allow-read"],
        );
        expect(fixture.invocations.length).toBe(3);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
