import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema, JSONValue } from "@commonfabric/api";
import {
  deepFreeze,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";

import { internSchema } from "@commonfabric/data-model-schema";

import {
  bindImmutableCells,
  immutableCellsFor,
  ImmutableCellStore,
  immutableSnapshot,
  mintedFromUnstoredValue,
  ownImmutableCells,
} from "../src/immutable-cell.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { load } from "../src/storage/transaction/attestation.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { TraverseCaptureRecorder } from "../src/traverse-recorder.ts";
import { replayFixture } from "./traverse-replay/replay.ts";
import {
  dataUriFromValueWithResolvedLinks,
  findAndInlineDataUriLinks,
  immutableContentId,
  portableSnapshotId,
  portableSnapshotLinks,
  resolveImmutableValueLinks,
} from "../src/data-uri.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import { areLinksSame } from "../src/link-equality.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

describe("immutable-cell", () => {
  it("requires ownership and follows transaction wrappers", () => {
    expect(() => immutableCellsFor({})).toThrow("explicitly bound");
    const owner = {};
    const store = ownImmutableCells(owner);
    try {
      expect(immutableCellsFor({ wrappedTransaction: owner })).toBe(store);
      expect(immutableCellsFor({ tx: owner })).toBe(store);
    } finally {
      store.dispose();
    }
  });

  it("inherits an existing store when wrapping a bound transaction", () => {
    const raw = new ManagedStorageTransaction(
      new StoreObjectManager(new Map()),
    );
    const store = ownImmutableCells(raw);
    try {
      const first = new ExtendedStorageTransaction(raw);
      const second = new ExtendedStorageTransaction(first);
      expect(immutableCellsFor(first)).toBe(store);
      expect(immutableCellsFor(second)).toBe(store);
      expect(immutableCellsFor(raw)).toBe(store);
    } finally {
      store.dispose();
    }
  });

  it("compares legacy schema references with native and portable snapshots", () => {
    const release = acquireSchemaRegistryLease();
    const store = new ImmutableCellStore();
    try {
      const schema = decomposeSchema({
        type: "string",
        default: "legacy identity",
      });
      for (const [hash, document] of schema.documents) {
        registerSchemaDocument(hash, document);
      }
      const value = deepFreeze({
        ref: linkRefFrom({
          id: "of:legacy-target",
          schema: { $ref: schema.rootRef },
        }),
      });
      const legacy = linkRefFrom({
        id: dataUriFromValueWithResolvedLinks(value),
      });
      const native = store.create(value);
      const portable = linkRefFrom({ id: portableSnapshotId(native.id) });
      expect(areLinksSame(legacy, linkRefFrom({ id: native.id }))).toBe(true);
      expect(areLinksSame(legacy, portable)).toBe(true);
    } finally {
      store.dispose();
      release();
    }
  });

  it("reuses resolved raw values and portable exports within a registry epoch", () => {
    let visits = 0;
    const value = deepFreeze(
      new Proxy({ ref: linkRefFrom({ path: ["target"] }) }, {
        ownKeys(target) {
          visits++;
          return Reflect.ownKeys(target);
        },
      }),
    );
    const store = new ImmutableCellStore();
    try {
      const snapshot = store.create(value, { id: "of:origin", path: [] });
      const first = resolveImmutableValueLinks(value, snapshot.id);
      expect(first).not.toBe(value);
      expect(resolveImmutableValueLinks(value, snapshot.id)).toBe(first);
      const portable = portableSnapshotId(snapshot.id);
      visits = 0;
      expect(portableSnapshotId(snapshot.id)).toBe(portable);
      expect(resolveImmutableValueLinks(value, snapshot.id)).toBe(first);
      expect(visits).toBe(0);
    } finally {
      store.dispose();
    }
  });

  for (const timing of ["before", "after"] as const) {
    it(`retains schema-default snapshots when their closure arrives ${timing} adoption`, () => {
      const release = acquireSchemaRegistryLease();
      const source = new ImmutableCellStore();
      const receiver = new ImmutableCellStore();
      try {
        const nested = source.create({ schemaDefault: timing });
        const schema = decomposeSchema({
          // Schema defaults carry links in either cell representation.
          default: linkRefFrom({ id: nested.id }) as JSONValue,
        });
        const register = () => {
          for (const [hash, document] of schema.documents) {
            registerSchemaDocument(hash, document);
          }
        };
        if (timing === "before") register();
        const outer = receiver.create({
          ref: linkRefFrom({
            id: "of:target",
            schema: { $ref: schema.rootRef },
          }),
        });
        immutableContentId(outer.id);
        if (timing === "after") register();
        source.dispose();
        expect(immutableSnapshot(nested.id).value).toEqual({
          schemaDefault: timing,
        });
        expect(
          areLinksSame(
            linkRefFrom({ id: outer.id }),
            linkRefFrom({ id: portableSnapshotId(outer.id) }),
          ),
        ).toBe(true);
        receiver.dispose();
        expect(() => immutableSnapshot(nested.id)).toThrow(/expired/);
      } finally {
        source.dispose();
        receiver.dispose();
        release();
      }
    });
  }

  it("acquires reader-schema dependencies when their closure arrives after adoption", () => {
    const release = acquireSchemaRegistryLease();
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    try {
      const inner = source.create({ lateReaderDefault: 42 });
      const schema = decomposeSchema({
        default: linkRefFrom({ id: inner.id }) as JSONValue,
      });
      receiver.retainSchema({ $ref: schema.rootRef });
      for (const [hash, document] of schema.documents) {
        registerSchemaDocument(hash, document);
      }
      source.dispose();
      expect(immutableSnapshot(inner.id).value).toEqual({
        lateReaderDefault: 42,
      });
      receiver.dispose();
      expect(() => immutableSnapshot(inner.id)).toThrow("expired");
    } finally {
      source.dispose();
      receiver.dispose();
      release();
    }
  });

  it("retains defaults in cyclic reader schemas while rejecting cyclic snapshot data", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    try {
      const inner = source.create({ cyclicReaderDefault: 42 });
      const schema: JSONSchema & { properties: Record<string, JSONSchema> } = {
        type: "object",
        properties: {},
        default: linkRefFrom({ id: inner.id }) as JSONValue,
      };
      schema.properties.next = schema;
      receiver.retainSchema(internSchema(schema));
      expect(() => receiver.create(schema)).toThrow(/cyclic/);
      source.dispose();
      expect(immutableSnapshot(inner.id).value).toEqual({
        cyclicReaderDefault: 42,
      });
    } finally {
      source.dispose();
      receiver.dispose();
    }
  });

  it("keeps an expired hidden reference from interrupting other pending owners", () => {
    const release = acquireSchemaRegistryLease();
    const source = new ImmutableCellStore();
    const expired = source.create({ expiredSchemaDefault: true });
    source.dispose();
    const liveSource = new ImmutableCellStore();
    const badOwner = new ImmutableCellStore();
    const goodOwner = new ImmutableCellStore();
    try {
      const live = liveSource.create({ liveSchemaDefault: true });
      const schema = decomposeSchema({
        default: {
          bad: linkRefFrom({ id: expired.id }) as JSONValue,
          good: linkRefFrom({ id: live.id }) as JSONValue,
        },
      });
      const value = {
        ref: linkRefFrom({ id: "of:target", schema: { $ref: schema.rootRef } }),
      };
      badOwner.create(value);
      goodOwner.create(value);
      for (const [hash, document] of schema.documents) {
        registerSchemaDocument(hash, document);
      }
      liveSource.dispose();
      expect(immutableSnapshot(live.id).value).toEqual({
        liveSchemaDefault: true,
      });
    } finally {
      liveSource.dispose();
      badOwner.dispose();
      goodOwner.dispose();
      release();
    }
  });

  it("refreshes portable identity when the schema registry is cleared", () => {
    const store = new ImmutableCellStore();
    let release = acquireSchemaRegistryLease();
    const schema = decomposeSchema({ type: "string", default: "epoch test" });
    const register = () => {
      for (const [hash, document] of schema.documents) {
        registerSchemaDocument(hash, document);
      }
    };
    try {
      register();
      const snapshot = store.create({
        ref: linkRefFrom({
          id: "of:target",
          schema: { $ref: schema.rootRef },
        }),
      });
      const native = linkRefFrom({ id: snapshot.id });
      const beforeClear = portableSnapshotId(snapshot.id);
      expect(areLinksSame(native, linkRefFrom({ id: beforeClear }))).toBe(true);
      release();
      release = acquireSchemaRegistryLease();
      const whileMissing = portableSnapshotId(snapshot.id);
      expect(whileMissing).not.toBe(beforeClear);
      expect(areLinksSame(native, linkRefFrom({ id: whileMissing }))).toBe(
        true,
      );
      register();
      expect(portableSnapshotId(snapshot.id)).toBe(beforeClear);
      expect(areLinksSame(native, linkRefFrom({ id: beforeClear }))).toBe(true);
    } finally {
      store.dispose();
      release();
    }
  });

  it("does not freeze caller-owned codec state while rewriting links", () => {
    const cause = {
      kept: { mutable: true },
      ref: linkRefFrom({ path: ["target"] }),
    };
    const failure = new FabricError({
      type: "Error",
      message: "boom",
      stack: undefined,
      cause,
      extras: undefined,
    });
    dataUriFromValueWithResolvedLinks(failure, { id: "of:origin", path: [] });
    expect(Object.isFrozen(cause.kept)).toBe(false);
    cause.kept.mutable = false;
    expect(cause.kept.mutable).toBe(false);
  });

  it("retains snapshots in codec state and schema defaults", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    const nested = source.create({ n: 9 });
    const ref = linkRefFrom({ id: nested.id });
    const outer = receiver.create({
      carried: new UnknownValue("SnapshotFixture@1", deepFreeze({ ref })),
      link: linkRefFrom({ id: "of:target", schema: { default: ref } }),
    });
    source.dispose();
    try {
      const portable = valueFromDataUri(portableSnapshotId(outer.id)) as {
        carried: UnknownValue;
        link: ReturnType<typeof linkRefFrom>;
      };
      expect(findAndInlineDataUriLinks(portable.carried.state)).toEqual({
        ref: { n: 9 },
      });
      expect(parseLink(portable.link)?.schema).toEqual({
        default: linkRefFrom({ id: portableSnapshotId(nested.id) }),
      });
      expect(immutableSnapshot(nested.id).value).toEqual({ n: 9 });
    } finally {
      receiver.dispose();
    }
    expect(() => immutableSnapshot(nested.id)).toThrow(/expired/);
  });

  it("compares native and portable content transitively without losing relative origins", () => {
    const store = new ImmutableCellStore();
    try {
      const baseA = {
        id: "of:a" as const,
        space: "did:key:test" as const,
        path: [],
      };
      const baseB = { ...baseA, id: "of:b" as const };
      const a = store.create({ n: 1 }, baseA);
      const b = store.create({ n: 1 }, baseB);
      const link = (id: typeof a.id) => linkRefFrom({ id });
      const portable = link(portableSnapshotId(a.id));
      expect(areLinksSame(link(a.id), portable)).toBe(true);
      expect(areLinksSame(link(b.id), portable)).toBe(true);
      expect(areLinksSame(link(a.id), link(b.id))).toBe(true);
      const relative = linkRefFrom({ path: ["target"] });
      const relativeA = store.create({ relative }, baseA);
      const relativeB = store.create({ relative }, baseB);
      expect(areLinksSame(link(relativeA.id), link(relativeB.id))).toBe(false);
      expect(
        areLinksSame(
          link(relativeA.id),
          link(portableSnapshotId(relativeA.id)),
        ),
      ).toBe(true);
    } finally {
      store.dispose();
    }
  });

  it("retains a native relative origin without an explicit snapshot link", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    const parent = source.create({ target: 8 });
    const child = receiver.create({ ref: linkRefFrom({ path: ["target"] }) }, {
      id: parent.id,
      path: [],
    });
    source.dispose();
    try {
      expect(findAndInlineDataUriLinks(linkRefFrom({ id: child.id }))).toEqual({
        ref: 8,
      });
    } finally {
      receiver.dispose();
    }
  });

  it("retains nested snapshots after their original store is disposed", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    const inner = source.create({ count: 7 });
    const outer = receiver.create({ child: linkRefFrom({ id: inner.id }) });
    source.dispose();
    try {
      expect(findAndInlineDataUriLinks(linkRefFrom({ id: outer.id })))
        .toEqual({ child: { count: 7 } });
      expect(
        findAndInlineDataUriLinks(
          valueFromDataUri(portableSnapshotId(outer.id)),
        ),
      )
        .toEqual({ child: { count: 7 } });
    } finally {
      receiver.dispose();
    }
    expect(() => immutableSnapshot(inner.id)).toThrow(/expired/);
  });

  it("reports an expired snapshot as a transaction error", () => {
    const store = new ImmutableCellStore();
    const snapshot = store.create({ expired: true });
    store.dispose();
    const result = load({
      id: snapshot.id,
      type: "application/json",
    });
    expect(result.error).toBeDefined();
  });

  it("rejects frozen cycles before registering a snapshot", () => {
    const store = new ImmutableCellStore();
    const value: Record<string, FabricValue> = {};
    value.self = value;
    try {
      expect(() => store.create(deepFreeze(value))).toThrow(/cyclic/);
    } finally {
      store.dispose();
    }
  });
  it("shares a frozen graph and keeps its identifier bounded", () => {
    const store = new ImmutableCellStore();
    try {
      const value = deepFreeze({ text: "x".repeat(1_000_000) });
      const snapshot = store.create(value);
      expect(snapshot.value).toBe(value);
      expect(snapshot.id.length).toBeLessThan(100);
      expect(immutableSnapshot(snapshot.id)).toBe(snapshot);
      expect(store.create(value)).toBe(snapshot);
    } finally {
      store.dispose();
    }
  });

  it("isolates mutable input while sharing frozen children", () => {
    const store = new ImmutableCellStore();
    try {
      const child = deepFreeze({ n: 1 });
      const input = { child, n: 2 };
      const snapshot = store.create(input);
      input.n = 3;
      expect(snapshot.value).toEqual({ child, n: 2 });
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen(snapshot.value)).toBe(true);
      expect(snapshot.value).toHaveProperty("child", child);
      expect((snapshot.value as { child: unknown }).child).toBe(child);
      expect(findAndInlineDataUriLinks(linkRefFrom({ id: snapshot.id })))
        .toEqual({ child, n: 2 });
    } finally {
      store.dispose();
    }
  });

  it("classifies a snapshot by the stored document at the root of its origins", () => {
    // A snapshot with no origin was minted from a value no space has stored,
    // and so was an element snapshot read out of it, however many elements
    // deep. An element read out of a stored document was not.
    const SPACE = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
    const store = new ImmutableCellStore();
    try {
      const unstored = store.create({ items: [{ nested: [{ n: 1 }] }] });
      const element = store.createElement({ nested: [{ n: 1 }] }, {
        id: unstored.id,
        space: SPACE,
        scope: "space",
        path: [],
      });
      const nested = store.createElement({ n: 1 }, {
        id: element.id,
        space: SPACE,
        scope: "space",
        path: [],
      });
      const stored = store.createElement({ n: 2 }, {
        id: "of:stored-source",
        space: SPACE,
        scope: "space",
        path: [],
      });

      expect(mintedFromUnstoredValue(unstored.id)).toBe(true);
      expect(mintedFromUnstoredValue(element.id)).toBe(true);
      expect(mintedFromUnstoredValue(nested.id)).toBe(true);
      expect(mintedFromUnstoredValue(stored.id)).toBe(false);
      expect(mintedFromUnstoredValue("of:stored-source")).toBe(false);
    } finally {
      store.dispose();
    }
  });

  it("deduplicates equal content regardless of object key order", () => {
    const store = new ImmutableCellStore();
    try {
      expect(store.create({ a: 1, b: 2 }).id)
        .toBe(store.create({ b: 2, a: 1 }).id);
      expect(store.create(-0).id).not.toBe(store.create(0).id);
    } finally {
      store.dispose();
    }
  });

  it("resolves links at their saved origin and expands them on export", () => {
    const store = new ImmutableCellStore();
    try {
      const link = linkRefFrom({ path: ["target"] });
      const value = deepFreeze({ link });
      const base = {
        id: "of:source",
        path: ["rows", "0"],
        scope: "user",
      } as const;
      const snapshot = store.create(value, base);
      expect(snapshot.value).toBe(value);
      expect(parseLink(link, { id: snapshot.id, path: ["link"] }))
        .toMatchObject({ id: "of:source", path: ["target"], scope: "user" });
      const expanded = findAndInlineDataUriLinks(
        linkRefFrom({ id: snapshot.id }),
      );
      expect(parseLink(expanded.link)).toMatchObject({
        id: "of:source",
        path: ["target"],
        scope: "user",
      });
      expect(store.create(value, { ...base, path: ["rows", "1"] }).id)
        .toBe(snapshot.id);
      expect(store.create(value, { ...base, id: "of:other" }).id)
        .not.toBe(snapshot.id);
    } finally {
      store.dispose();
    }
  });

  it("keeps nested snapshots rooted in the original document", () => {
    const store = new ImmutableCellStore();
    try {
      const value = deepFreeze({
        child: { link: linkRefFrom({ path: ["x"] }) },
      });
      const parent = store.create(value, { id: "of:source", path: [] });
      const child = store.create(value.child, {
        id: parent.id,
        path: ["child"],
      });
      expect(parseLink(value.child.link, { id: child.id, path: ["link"] }).id)
        .toBe("of:source");
    } finally {
      store.dispose();
    }
  });

  it("expands snapshot links inside carried instance state", () => {
    const store = new ImmutableCellStore();
    try {
      const inner = store.create({ answer: 42 });
      const wrapped = new UnknownValue(
        "SnapshotFixture@1",
        deepFreeze({
          link: linkRefFrom({ id: inner.id }),
        }),
      );
      const outer = store.create({ wrapped });
      const expanded = findAndInlineDataUriLinks(linkRefFrom({ id: outer.id }));
      expect(expanded.wrapped).toBeInstanceOf(UnknownValue);
      expect(expanded.wrapped.state).toEqual({ link: { answer: 42 } });
      expect(wrapped.state).toEqual({ link: linkRefFrom({ id: inner.id }) });
    } finally {
      store.dispose();
    }
  });

  it("captures a portable invocation that replays after the owner is disposed", () => {
    const store = new ImmutableCellStore();
    const recorder = new TraverseCaptureRecorder();
    const snapshot = store.create({ n: 17 });
    const address = {
      id: snapshot.id,
      space: "did:key:fixture",
      path: ["value"],
    } as const;
    recorder.recordInvocation(
      { address },
      { path: ["value"], schema: true },
      undefined,
      { traverseCells: false },
      undefined,
    );
    const fixture = recorder.toFixture("native snapshot", "unit test");
    store.dispose();
    expect(fixture.invocations[0].address.id.startsWith("data:")).toBe(true);
    const replay = replayFixture(fixture, { collectOracle: true });
    expect(replay.oracle!.invocations[0]).toMatchObject({ ok: true });
  });

  for (const scope of ["space", "user"] as const) {
    it(`readdresses captured schema documents for a ${scope}-scoped invocation`, () => {
      const snapshots = new ImmutableCellStore();
      try {
        const inner = snapshots.create({ answer: 42 });
        const decomposition = decomposeSchema({
          type: "object",
          properties: {
            foo: {
              default: linkRefFrom({ id: inner.id }) as JSONValue,
              asCell: ["cell"],
            },
          },
        });
        const store = new Map();
        const put = (id: string, value: FabricValue) =>
          store.set(`${id}/application/json`, {
            the: "application/json",
            of: id,
            is: { value },
            since: 1,
          });
        put("of:root", {});
        for (const [hash, document] of decomposition.documents) {
          put(`cid:${hash}`, document);
        }
        const raw = new ExtendedStorageTransaction(
          new ManagedStorageTransaction(new StoreObjectManager(store)),
        );
        const recorder = new TraverseCaptureRecorder();
        const tx = recorder.wrapTx(raw);
        const address = {
          space: "did:key:capture" as const,
          scope,
          id: "of:root" as const,
          type: "application/json" as const,
          path: ["value"] as const,
        };
        const value = tx.readOrThrow(address);
        const context = createDefaultTraversalContext({
          principal: "did:key:capture",
          sessionId: "session:capture",
        });
        const selector = {
          path: ["value"],
          schema: { $ref: decomposition.rootRef },
        };
        recorder.recordInvocation(
          { address },
          selector,
          undefined,
          context,
          undefined,
        );
        const live = new SchemaObjectTraverser(tx, selector, context).traverse({
          address,
          value,
        });
        expect(live.ok).toBeDefined();
        const expectedHash = hashStringOf(portableSnapshotLinks(live.ok)).slice(
          0,
          16,
        );
        const fixture = recorder.toFixture("native-schema", "unit test");
        expect(JSON.stringify(fixture)).not.toContain("snapshot:");
        expect(fixture.selectors[0].schema).not.toEqual(selector.schema);
        snapshots.dispose();
        const replay = replayFixture(fixture, { collectOracle: true });
        expect(replay.oracle!.invocations).toHaveLength(1);
        expect(replay.oracle!.invocations[0]).toEqual({
          ok: true,
          hash: expectedHash,
        });
      } finally {
        snapshots.dispose();
      }
    });
  }

  it("expands and captures snapshot links held in link schema defaults", () => {
    const store = new ImmutableCellStore();
    const inner = store.create({ answer: 42 });
    const link = linkRefFrom({
      id: "of:target",
      schema: { default: linkRefFrom({ id: inner.id }) },
    });
    const referenced = createSigilLinkFromParsedLink({
      id: "of:target",
      path: [],
      schema: parseLink(link)!.schema,
    }, { includeSchema: true });
    const outer = store.create({ link, again: link, referenced });
    const expanded = findAndInlineDataUriLinks(linkRefFrom({ id: outer.id }));
    const portable = portableSnapshotId(outer.id);
    store.dispose();
    expect(parseLink(expanded.link)!.id).toBe("of:target");
    expect(parseLink(expanded.link)!.schema).toEqual({
      default: { answer: 42 },
    });
    expect(parseLink(expanded.referenced)!.schema).toEqual({
      default: { answer: 42 },
    });
    const decoded = valueFromDataUri(portable) as {
      link: typeof link;
      again: typeof link;
    };
    const schema = parseLink(decoded.link)!.schema as { default: typeof link };
    const capturedId = parseLink(schema.default)!.id!;
    expect(capturedId.startsWith("data:")).toBe(true);
    expect(valueFromDataUri(capturedId)).toEqual({ answer: 42 });
    expect(decoded.link).toEqual(decoded.again);
  });

  it("keeps capture transactions in their owner's snapshot store", () => {
    const store = new ImmutableCellStore();
    const tx = {} as IExtendedStorageTransaction;
    bindImmutableCells(tx, store);
    const wrapped = new TraverseCaptureRecorder().wrapTx(tx);
    const snapshot = immutableCellsFor(wrapped).create({ n: 1 });
    expect(immutableCellsFor(wrapped)).toBe(store);
    store.dispose();
    expect(() => immutableSnapshot(snapshot.id)).toThrow("expired");
  });

  it("keeps equal content stable across live runtimes and releases the last owner", () => {
    const first = new ImmutableCellStore();
    const second = new ImmutableCellStore();
    const a = first.create({ shared: 42 });
    const b = second.create({ shared: 42 });
    expect(b.id).toBe(a.id);
    first.dispose();
    expect(immutableSnapshot(b.id).value).toEqual({ shared: 42 });
    second.dispose();
    expect(() => immutableSnapshot(b.id)).toThrow("expired");
  });

  it("invalidates all identifiers when their runtime store is disposed", () => {
    const store = new ImmutableCellStore();
    const { id } = store.create({ n: 1 });
    store.dispose();
    expect(() => immutableSnapshot(id)).toThrow("expired");
    expect(() => store.create({ n: 2 })).toThrow("disposed");
  });
});
