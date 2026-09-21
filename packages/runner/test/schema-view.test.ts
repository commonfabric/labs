// The schema-observing lazy view, reached through `Cell.get()` on a
// transaction marked for lazy materialization.
//
// Two properties carry most of the confidence: a view agrees with an eager read
// on what the value is, and it reads only what the reader touches. The rest
// covers the refusal contract — where a mismatch surfaces, and where it does
// not.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLogger } from "@commonfabric/utils/logger";
import { Runtime } from "../src/runtime.ts";
import { isSchemaMismatchError } from "../src/schema-view.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toCell } from "../src/back-to-cell.ts";

const signer = await Identity.fromPassphrase("schema-view");
const space = signer.did();

describe("schema-view", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Seed a cell, then hand back a reader bound to a fresh transaction. */
  const seeded = async (
    cause: string,
    value: unknown,
    schema: JSONSchema,
  ) => {
    const write = runtime.edit();
    runtime.getCell(space, cause, undefined, write).set(value);
    await write.commit();

    const read = (lazy: boolean): {
      tx: IExtendedStorageTransaction;
      get: () => unknown;
    } => {
      const tx = runtime.edit();
      if (lazy) tx.markLazyMaterialize(true);
      const cell = runtime.getCell(space, cause, schema, tx);
      return { tx, get: () => cell.get() };
    };
    return read;
  };

  const pathsRead = (tx: IExtendedStorageTransaction): string[] =>
    [...getTransactionReadActivities(tx) ?? []].map((activity) =>
      activity.path.join("/")
    );

  /** `<id>/<path>` for plain recursive content reads — no probe, verifier or
   * ignore marker on them. Link resolution's own probes are marked and answer a
   * different question ("is there a link here?"), so this is the set that says
   * what the reader took a dependency on. */
  const contentReads = (tx: IExtendedStorageTransaction): string[] =>
    [...getTransactionReadActivities(tx) ?? []]
      .filter((activity) =>
        activity.nonRecursive !== true &&
        Object.getOwnPropertySymbols(activity.meta ?? {}).length === 0
      )
      .map((activity) => `${activity.id}/${activity.path.join("/")}`);

  describe("agreement with an eager read", () => {
    const cases: Array<[string, unknown, JSONSchema]> = [
      [
        "a flat record",
        { a: 1, b: "two" },
        {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "string" } },
        } as const,
      ],
      [
        "a nested record",
        { outer: { inner: { leaf: 7 } } },
        {
          type: "object",
          properties: {
            outer: {
              type: "object",
              properties: {
                inner: {
                  type: "object",
                  properties: { leaf: { type: "number" } },
                },
              },
            },
          },
        } as const,
      ],
      [
        "an array of scalars",
        { xs: [1, 2, 3] },
        {
          type: "object",
          properties: { xs: { type: "array", items: { type: "number" } } },
        } as const,
      ],
      [
        "an array of records",
        { xs: [{ n: 1 }, { n: 2 }] },
        {
          type: "object",
          properties: {
            xs: {
              type: "array",
              items: { type: "object", properties: { n: { type: "number" } } },
            },
          },
        } as const,
      ],
      [
        "a property the schema does not select",
        { a: 1, hidden: 2 },
        {
          type: "object",
          properties: { a: { type: "number" } },
        } as const,
      ],
      [
        "a declared default for an absent property",
        { a: 1 },
        {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "string", default: "fallback" },
          },
        } as const,
      ],
      [
        "a matching anyOf branch",
        { kind: "circle", radius: 2 },
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            radius: { type: "number" },
          },
          anyOf: [
            { type: "object", required: ["radius"] },
            { type: "object", required: ["side"] },
          ],
        } as const,
      ],
      [
        // The branch narrowing picks says nothing about `radius`; the schema
        // around the union does, and it applies to whichever branch matched.
        "a property the union's own schema rejects",
        { kind: "circle", radius: "bad" },
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            radius: { type: "number" },
          },
          anyOf: [
            { type: "object", required: ["kind"] },
            { type: "object", required: ["side"] },
          ],
        } as const,
      ],
    ];

    for (const [name, value, schema] of cases) {
      it(`returns the same value as an eager read for ${name}`, async () => {
        const read = await seeded(`agree-${name}`, value, schema);
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(JSON.parse(JSON.stringify(lazy.get()))).toEqual(
            JSON.parse(JSON.stringify(eager.get())),
          );
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });
    }
  });

  describe("reading only what is touched", () => {
    it("registers no read for a sibling the reader never looks at", async () => {
      const read = await seeded(
        "frugal",
        {
          wanted: { leaf: 1 },
          untouched: { leaf: 2 },
        },
        {
          type: "object",
          properties: {
            wanted: {
              type: "object",
              properties: { leaf: { type: "number" } },
            },
            untouched: {
              type: "object",
              properties: { leaf: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      const value = lazy.get() as { wanted: { leaf: number } };
      expect(value.wanted.leaf).toBe(1);
      const lazyPaths = pathsRead(lazy.tx);
      await lazy.tx.commit();

      const eager = read(false);
      eager.get();
      const eagerPaths = pathsRead(eager.tx);
      await eager.tx.commit();

      expect(lazyPaths.some((path) => path.includes("untouched"))).toBe(false);
      expect(eagerPaths.some((path) => path.includes("untouched"))).toBe(true);
    });

    it("registers no read for an array element the reader never looks at", async () => {
      const read = await seeded(
        "frugal-array",
        {
          xs: [{ n: 1 }, { n: 2 }, { n: 3 }],
        },
        {
          type: "object",
          properties: {
            xs: {
              type: "array",
              items: { type: "object", properties: { n: { type: "number" } } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      const value = lazy.get() as { xs: { n: number }[] };
      expect(value.xs.length).toBe(3);
      expect(value.xs[0].n).toBe(1);
      const paths = pathsRead(lazy.tx);
      await lazy.tx.commit();

      // An element is its own document, so the element's own fields are read
      // under that document rather than under `xs/<i>`. What the slot read
      // shows is which elements were reached at all.
      expect(paths.some((path) => path.endsWith("xs/0"))).toBe(true);
      expect(paths.some((path) => path.endsWith("xs/2"))).toBe(false);
    });
  });

  describe("refusal", () => {
    it("returns undefined when the root is missing a required property", async () => {
      const read = await seeded(
        "root-required",
        { b: 1 },
        {
          type: "object",
          required: ["a"],
          properties: { a: { type: "number" }, b: { type: "number" } },
        } as const,
      );

      const lazy = read(true);
      const eager = read(false);
      try {
        expect(lazy.get()).toBeUndefined();
        expect(eager.get()).toBeUndefined();
      } finally {
        await lazy.tx.commit();
        await eager.tx.commit();
      }
    });

    it("throws when the reader touches a nested missing required property", async () => {
      const read = await seeded(
        "nested-required",
        { inner: { b: 1 } },
        {
          type: "object",
          required: ["inner"],
          properties: {
            inner: {
              type: "object",
              required: ["a"],
              properties: { a: { type: "number" }, b: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      try {
        const value = lazy.get() as { inner: unknown };
        let thrown: unknown;
        try {
          value.inner;
        } catch (error) {
          thrown = error;
        }
        expect(isSchemaMismatchError(thrown)).toBe(true);
      } finally {
        await lazy.tx.commit();
      }
    });

    it("is absent from enumeration, as it is from an eager read", async () => {
      // `Object.keys`, a spread and `in` must agree with property access about
      // which keys exist, and with what an eager read leaves in the object.
      const read = await seeded(
        "absent-from-enumeration",
        { n: "not a number", ok: 1, nothing: undefined },
        {
          type: "object",
          properties: {
            n: { type: "number" },
            ok: { type: "number" },
            nothing: { type: ["number", "undefined"] },
          },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        const eagerValue = eager.get() as Record<string, unknown>;
        const lazyValue = lazy.get() as Record<string, unknown>;
        expect(Object.keys(lazyValue).sort()).toEqual(
          Object.keys(eagerValue).sort(),
        );
        expect(Object.keys(lazyValue)).not.toContain("n");
        expect("n" in lazyValue).toBe("n" in eagerValue);
        expect(Object.keys({ ...lazyValue })).not.toContain("n");
        // A property whose value is legitimately `undefined` is still there.
        expect(Object.keys(lazyValue)).toContain("nothing");
        expect("nothing" in lazyValue).toBe(true);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("throws when the reader touches a required value of the wrong type", async () => {
      const read = await seeded(
        "wrong-type-required",
        { n: "not a number" },
        {
          type: "object",
          required: ["n"],
          properties: { n: { type: "number" } },
        } as const,
      );

      const lazy = read(true);
      try {
        const value = lazy.get() as { n: unknown };
        expect(() => value.n).toThrow("Schema mismatch");
      } finally {
        await lazy.tx.commit();
      }
    });

    it("reads an optional value of the wrong type as undefined, as an eager read does", async () => {
      // An eager read leaves a property whose traversal fails out of the
      // object; only a `required` one takes the object down with it. Refusing
      // an optional one instead would stop a reader the eager path runs.
      const read = await seeded(
        "wrong-type-optional",
        { n: "not a number", ok: 1 },
        {
          type: "object",
          properties: { n: { type: "number" }, ok: { type: "number" } },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        expect((eager.get() as { n: unknown }).n).toBeUndefined();
        expect((lazy.get() as { n: unknown }).n).toBeUndefined();
        expect((lazy.get() as { ok: number }).ok).toBe(1);
        // Nothing was refused, so the run is not disposed of as an argument
        // that did not resolve.
        expect(lazy.tx.takeSchemaRefusal()).toBeUndefined();
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("runs on past a mismatch in a subtree the reader never touches", async () => {
      // The one behavior change a pattern author can observe: an eager read
      // collapses the whole value, a view hands back what was asked for.
      const read = await seeded(
        "untouched-mismatch",
        {
          wanted: 1,
          broken: { b: 1 },
        },
        {
          type: "object",
          properties: {
            wanted: { type: "number" },
            broken: {
              type: "object",
              required: ["a"],
              properties: { a: { type: "number" } },
            },
          },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        // Eager: `broken` fails, so it is dropped, and `wanted` survives —
        // the collapse only reaches the whole value when the failing property
        // is itself required.
        expect((eager.get() as { wanted: number }).wanted).toBe(1);
        expect((lazy.get() as { wanted: number }).wanted).toBe(1);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("registers the read that failed, so the reader runs again when it arrives", async () => {
      const read = await seeded(
        "registers-failure",
        { inner: { b: 1 } },
        {
          type: "object",
          required: ["inner"],
          properties: {
            inner: {
              type: "object",
              required: ["a"],
              properties: { a: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      try {
        const value = lazy.get() as { inner: unknown };
        try {
          value.inner;
        } catch {
          // The refusal is the point; what matters is what it left behind.
        }
        expect(pathsRead(lazy.tx).some((path) => path.endsWith("inner")))
          .toBe(true);
      } finally {
        await lazy.tx.commit();
      }
    });
  });

  describe("handles", () => {
    it("returns a Cell for an optional handle declared through $ref branches", async () => {
      // An optional handle — `Cell<T> | undefined` — generates as a union whose
      // one branch carries `asCell` and whose other is the absent case, and the
      // branches arrive as `$ref`s into `$defs`. Both facts hid the marker: a
      // union satisfies `hasAsCell` only when EVERY branch declares one, and a
      // bare `$ref` declares nothing until it is resolved. A reader got a plain
      // value where the pattern declared a handle.

      const read = await seeded(
        "optional-handle",
        { entry: { origin: "sent", author: { name: "ada" } } },
        {
          $defs: {
            Author: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            Sent: {
              type: "object",
              required: ["origin", "author"],
              properties: {
                origin: { type: "string" },
                author: {
                  anyOf: [
                    { anyOf: [{ $ref: "#/$defs/Author" }], asCell: ["cell"] },
                    {
                      anyOf: [
                        { type: "undefined" },
                        {
                          anyOf: [{ $ref: "#/$defs/Author" }],
                          asCell: ["cell"],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
          type: "object",
          properties: { entry: { $ref: "#/$defs/Sent" } },
        } as const,
      );

      const lazy = read(true);
      const eager = read(false);
      try {
        const lazyAuthor =
          (lazy.get() as { entry: { author: { get?: unknown } } }).entry.author;
        const eagerAuthor =
          (eager.get() as { entry: { author: { get?: unknown } } }).entry
            .author;
        expect(typeof eagerAuthor?.get).toBe("function");
        expect(typeof lazyAuthor?.get).toBe("function");
      } finally {
        await lazy.tx.commit();
        await eager.tx.commit();
      }
    });
  });

  describe("a transaction that writes under the view", () => {
    const LIST = {
      type: "object",
      properties: {
        title: { type: "string" },
        // Primitives on purpose. An inline object element is rebased onto a
        // `data:` identity derived from its own value, and a read of one never
        // reaches the document — so a list of them would hold its elements
        // still whether or not the instant did any work.
        xs: { type: "array", items: { type: "number" } },
      },
    } as const;

    /** Seed `cause`, then hand back a cell on a marked transaction. */
    const opened = async (cause: string, value: unknown) => {
      const write = runtime.edit();
      runtime.getCell(space, cause, undefined, write).set(value);
      await write.commit();

      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      return { tx, cell: runtime.getCell(space, cause, LIST, tx) };
    };

    it("keeps the value it was taken over when the reader writes it", async () => {
      const { tx, cell } = await opened("write-under-view", {
        title: "before",
        xs: [1],
      });
      try {
        const value = cell.get() as { title: string };
        cell.withTx(tx).key("title").set("after");
        expect(value.title).toBe("before");
        // Taking the read again is how the reader sees what it wrote.
        expect((cell.get() as { title: string }).title).toBe("after");
      } finally {
        await tx.commit();
      }
    });

    it("keeps the value it was taken over when the write came first", async () => {
      const { tx, cell } = await opened("write-under-later-view", {
        title: "before",
        xs: [1],
      });
      try {
        cell.withTx(tx).key("title").set("first");
        // Taken past a write, so the instant it describes is the one after it.
        const value = cell.get() as { title: string };
        cell.withTx(tx).key("title").set("second");
        expect(value.title).toBe("first");
        expect((cell.get() as { title: string }).title).toBe("second");
      } finally {
        await tx.commit();
      }
    });

    it("keeps two views taken at different instants apart", async () => {
      const { tx, cell } = await opened("two-instants", {
        title: "before",
        xs: [1],
      });
      try {
        const first = cell.get() as { title: string };
        cell.withTx(tx).key("title").set("middle");
        const second = cell.get() as { title: string };
        cell.withTx(tx).key("title").set("last");
        expect(first.title).toBe("before");
        expect(second.title).toBe("middle");
      } finally {
        await tx.commit();
      }
    });

    it("keeps an element's value across a write into the list", async () => {
      const { tx, cell } = await opened("element-under-write", {
        title: "t",
        xs: [1, 2],
      });
      try {
        const value = cell.get() as { xs: number[] };
        cell.withTx(tx).key("xs").key(1).set(99);
        expect([...value.xs]).toEqual([1, 2]);
        // The element the write landed on reads as written through a fresh
        // read, so the pinning above is the instant and not a stale container.
        expect((cell.get() as { xs: number[] }).xs[1]).toBe(99);
      } finally {
        await tx.commit();
      }
    });

    it("iterates the length the list had when the view was taken", async () => {
      // What a reader iterating a list while writing into it stands on. The
      // view answers for the container it was built over, so appending during
      // the walk cannot extend the walk.
      const { tx, cell } = await opened("iterate-while-appending", {
        title: "t",
        xs: [1, 2, 3],
      });
      try {
        const value = cell.get() as { xs: number[] };
        const visited: number[] = [];
        for (const item of value.xs) {
          visited.push(item);
          // Appending only while the walk is within its starting length keeps
          // a view that re-read the container to a walk that ends and fails
          // the assertion, rather than one that never ends.
          if (visited.length > 3) continue;
          const current = cell.withTx(tx).key("xs").get() as number[];
          cell.withTx(tx).key("xs").set([...current, 0]);
        }
        expect(visited).toEqual([1, 2, 3]);
      } finally {
        await tx.commit();
      }
    });

    it("iterates the length the list had when the write came first", async () => {
      const { tx, cell } = await opened("write-first-then-iterate", {
        title: "t",
        xs: [1, 2],
      });
      try {
        cell.withTx(tx).key("title").set("written first");
        const value = cell.get() as { xs: number[] };
        const visited: number[] = [];
        for (const item of value.xs) {
          visited.push(item);
          if (visited.length > 2) continue;
          const current = cell.withTx(tx).key("xs").get() as number[];
          cell.withTx(tx).key("xs").set([...current, 0]);
        }
        expect(visited).toEqual([1, 2]);
      } finally {
        await tx.commit();
      }
    });

    it("holds an array view's length across a write that changes it", async () => {
      const { tx, cell } = await opened("held-length", {
        title: "t",
        xs: [1],
      });
      try {
        const held = (cell.get() as { xs: number[] }).xs;
        cell.withTx(tx).key("xs").set([7, 8]);
        expect(held.length).toBe(1);
        expect(held[0]).toBe(1);
        // Asking the parent again reads the container afresh, which is how a
        // reader that wants the new list gets it.
        const fresh = (cell.get() as { xs: number[] }).xs;
        expect(fresh.length).toBe(2);
        expect(fresh[0]).toBe(7);
      } finally {
        await tx.commit();
      }
    });

    it("reads only the paths the reader touched after a write", async () => {
      const { tx, cell } = await opened("lazy-after-write", {
        title: "before",
        xs: [1, 2, 3],
      });
      try {
        cell.withTx(tx).key("title").set("after");
        const value = cell.get() as { title: string };
        expect(value.title).toBe("after");
        // An eager materialization walks the list to build it; the view never
        // looks, because the reader never asked.
        expect(pathsRead(tx).some((path) => path.includes("xs"))).toBe(false);
      } finally {
        await tx.commit();
      }
    });

    it("still reads back what a lift wrote through a handle it was passed", async () => {
      const readBack = async (lazy: boolean) => {
        const cause = `write-then-read-${lazy}`;
        const write = runtime.edit();
        runtime.getCell(space, cause, undefined, write).set({
          scratch: { n: 1 },
        });
        await write.commit();

        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const argument = runtime.getCell(
          space,
          cause,
          {
            type: "object",
            properties: {
              scratch: {
                type: "object",
                properties: { n: { type: "number" } },
                asCell: ["cell"],
              },
            },
          } as const,
          tx,
        ).get() as {
          scratch: { set: (v: unknown) => void; get: () => { n: number } };
        };

        argument.scratch.set({ n: 42 });
        const seen = argument.scratch.get()?.n;
        await tx.commit();
        return seen;
      };

      expect(await readBack(true)).toBe(42);
      expect(await readBack(false)).toBe(42);
    });
  });

  describe("a value that is not there", () => {
    it("takes the schema's declared default", async () => {
      const read = await seeded(
        "declared-default",
        undefined,
        {
          type: ["array", "undefined"],
          items: { type: "number" },
          default: [],
        },
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        expect(eager.get()).toEqual([]);
        expect(lazy.get()).toEqual([]);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("registers the read the default stands in for", async () => {
      // The value that will fill this slot arrives in a document of its own —
      // a computed's result — so resolving the link leaves no dependency on it.
      // Without one the reader keeps reading the default however late the
      // value arrives.
      const write = runtime.edit();
      const target = runtime.getCell<number>(
        space,
        "default-dependency-target",
        undefined,
        write,
      );
      const holder = runtime.getCell<Record<string, unknown>>(
        space,
        "default-dependency-holder",
        undefined,
        write,
      );
      holder.setRaw({ x: target.getAsLink() });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        "default-dependency",
        undefined,
        write,
      );
      arg.setRaw({ n: holder.key("x").getAsLink() });
      await write.commit();

      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell(
          space,
          "default-dependency",
          {
            type: "object",
            properties: { n: { type: ["number", "undefined"], default: 7 } },
          } as const,
          tx,
        ).get() as { n: number };
        expect(value.n).toBe(7);
        const targetId = target.getAsNormalizedFullLink().id;
        expect(contentReads(tx).filter((read) => read.startsWith(targetId)))
          .toContain(`${targetId}/value`);
      } finally {
        await tx.commit();
      }
    });
  });

  describe("an array view", () => {
    const ITEMS = {
      type: "object",
      properties: {
        xs: {
          type: "array",
          items: { type: "object", properties: { n: { type: "number" } } },
        },
      },
    } as const;

    const readArray = async (cause: string) => {
      const read = await seeded(
        cause,
        { xs: [{ n: 1 }, { n: 2 }, { n: 3 }] },
        ITEMS,
      );
      return read;
    };

    it("runs a read-only method against element views", async () => {
      const read = await readArray("array-methods");
      const eager = read(false);
      const lazy = read(true);
      try {
        const of = (v: unknown) => (v as { xs: Array<{ n: number }> }).xs;
        expect(of(lazy.get()).map((item) => item.n)).toEqual([1, 2, 3]);
        expect(of(lazy.get()).filter((item) => item.n > 1).map((i) => i.n))
          .toEqual([2, 3]);
        expect(of(lazy.get()).map((i) => i.n)).toEqual(
          of(eager.get()).map((i) => i.n),
        );
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("iterates and spreads into element views", async () => {
      const read = await readArray("array-iterate");
      const lazy = read(true);
      try {
        const xs = (lazy.get() as { xs: Array<{ n: number }> }).xs;
        expect([...xs].map((item) => item.n)).toEqual([1, 2, 3]);
        const seen: number[] = [];
        for (const item of xs) seen.push(item.n);
        expect(seen).toEqual([1, 2, 3]);
      } finally {
        await lazy.tx.commit();
      }
    });

    it("refuses a method that would reshape it", async () => {
      const read = await readArray("array-mutation");
      const lazy = read(true);
      try {
        const xs = (lazy.get() as { xs: Array<unknown> }).xs;
        expect(() => xs.push({ n: 4 })).toThrow("it is a read");
        expect(() => xs.sort()).toThrow("it is a read");
      } finally {
        await lazy.tx.commit();
      }
    });

    it("enumerates its indices, as an eager read does", async () => {
      const read = await readArray("array-enumerate");
      const eager = read(false);
      const lazy = read(true);
      try {
        const of = (v: unknown) => (v as { xs: Array<{ n: number }> }).xs;
        const lazyXs = of(lazy.get());
        expect(Object.keys(lazyXs)).toEqual(Object.keys(of(eager.get())));
        expect(Object.entries(lazyXs).map(([, item]) => item.n))
          .toEqual([1, 2, 3]);
        expect(1 in lazyXs).toBe(true);
        expect(9 in lazyXs).toBe(false);
        expect(lazyXs.length).toBe(3);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("hands back a Cell for the array itself", async () => {
      const read = await readArray("array-tocell");
      const lazy = read(true);
      try {
        const xs = (lazy.get() as { xs: Record<symbol, unknown> }).xs;
        const cell = (xs[toCell] as () => { get: () => unknown })();
        expect(typeof cell.get).toBe("function");
      } finally {
        await lazy.tx.commit();
      }
    });

    it("reads every element when one of them does not match", async () => {
      // An eager read walks the whole array before it calls the array invalid,
      // so each element is a dependency of the reader either way. A method that
      // stopped at the first mismatch would take a dependency on the elements
      // up to it and nothing would wake the reader when the rest arrived.
      const read = await seeded(
        "array-element-mismatch",
        { xs: [{ n: 1 }, { other: true }, { n: 3 }] },
        {
          type: "object",
          properties: {
            xs: {
              type: "array",
              items: {
                type: "object",
                properties: { n: { type: "number" } },
                required: ["n"],
              },
            },
          },
        } as const,
      );

      const lazy = read(true);
      try {
        const xs = (lazy.get() as { xs: Array<{ n: number }> }).xs;
        expect(() => xs.map((item) => item.n)).toThrow("Schema mismatch");
        const paths = pathsRead(lazy.tx);
        expect(paths.some((path) => path.endsWith("xs/0"))).toBe(true);
        expect(paths.some((path) => path.endsWith("xs/1"))).toBe(true);
        expect(paths.some((path) => path.endsWith("xs/2"))).toBe(true);
      } finally {
        await lazy.tx.commit();
      }
    });
  });

  describe("a property the schema turns down", () => {
    /** A document holding a link to another, under a schema that turns down the
     * property the link sits at — by declaring it `false`, or by refusing the
     * properties it does not name and not naming this one. */
    const seededLink = async (
      cause: string,
      rejected: JSONSchema | "unnamed",
      required?: readonly string[],
    ) => {
      const write = runtime.edit();
      const target = runtime.getCell<Record<string, unknown>>(
        space,
        `${cause}-target`,
        undefined,
        write,
      );
      target.set({ title: "Behind the link" });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        `${cause}-arg`,
        undefined,
        write,
      );
      arg.setRaw({ p: target.getAsLink(), q: 1 });
      await write.commit();

      const schema = {
        type: "object",
        properties: {
          q: { type: "number" },
          ...(rejected === "unnamed" ? {} : { p: rejected }),
        },
        additionalProperties: false,
        ...(required === undefined ? {} : { required }),
      } as JSONSchema;
      return {
        targetId: target.getAsNormalizedFullLink().id,
        read: (lazy: boolean) => {
          const tx = runtime.edit();
          if (lazy) tx.markLazyMaterialize(true);
          const cell = runtime.getCell(space, `${cause}-arg`, schema, tx);
          return { tx, get: () => cell.get() };
        },
      };
    };

    const shapes: Array<[string, JSONSchema | "unnamed"]> = [
      ["declared as `false`", false],
      [
        "left unnamed where the schema refuses what it does not name",
        "unnamed",
      ],
    ];

    for (const [index, [shape, rejected]] of shapes.entries()) {
      it(`leaves out a property ${shape}, as an eager read does`, async () => {
        const { read } = await seededLink(`turned-down-${index}`, rejected);
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(JSON.parse(JSON.stringify(lazy.get()))).toEqual(
            JSON.parse(JSON.stringify(eager.get())),
          );
          const value = lazy.get() as Record<string, unknown>;
          expect("p" in value).toBe(false);
          expect(Object.keys(value)).toEqual(["q"]);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      it(`never loads what a property ${shape} links to`, async () => {
        // The target is never fetched: a selection asking for a link's address
        // wants the address, not the document. Deciding it by reading and
        // letting the read fail would fetch the document first, which is the
        // cost turning the property down was meant to avoid.
        const { read, targetId } = await seededLink(
          `turned-down-link-${index}`,
          rejected,
        );
        const lazy = read(true);
        try {
          const value = lazy.get() as Record<string, unknown>;
          // Enumerating asks whether each key is there, which is where a reader
          // that never names `p` still reaches it.
          expect(Object.keys(value)).toEqual(["q"]);
          expect("p" in value).toBe(false);
          expect(value.p).toBe(undefined);
          const ids = [...getTransactionReadActivities(lazy.tx) ?? []]
            .map((activity) => activity.id);
          expect(ids.includes(targetId)).toBe(false);
        } finally {
          await lazy.tx.commit();
        }
      });

      it(`voids the object when a property ${shape} is required`, async () => {
        // Dropping the property is the answer for an optional one. Where the
        // schema also requires it, nothing reaches the filtered result at that
        // key, and an eager read hands back nothing rather than an object
        // missing a key it declared mandatory.
        const { read } = await seededLink(
          `turned-down-required-${index}`,
          rejected,
          ["p"],
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(eager.get()).toBe(undefined);
          expect(lazy.get()).toBe(undefined);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });
    }

    describe("under a schema that names no properties and refuses the rest", () => {
      // `additionalProperties: false` with no `properties` beside it turns down
      // every key the data carries. The narrowing reports each one as a bare
      // `false`, the same return it gives for a shape it cannot read a child out
      // of, so the view has to tell the two apart from the schema.

      const closed = { type: "object", additionalProperties: false } as const;

      it("leaves out every property, as an eager read does", async () => {
        const read = await seeded(
          "turned-down-names-none",
          { id: "a", driver: "x" },
          closed,
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(Object.keys(eager.get() as object)).toEqual([]);
          const value = lazy.get() as Record<string, unknown>;
          expect(Object.keys(value)).toEqual([]);
          expect("driver" in value).toBe(false);
          expect(value.driver).toBe(undefined);
          expect(JSON.parse(JSON.stringify(value))).toEqual(
            JSON.parse(JSON.stringify(eager.get())),
          );
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      it("leaves out every property of an array element, as an eager read does", async () => {
        const read = await seeded(
          "turned-down-names-none-element",
          { rows: [{ id: "a", driver: "x" }] },
          {
            type: "object",
            properties: { rows: { type: "array", items: closed } },
          } as const,
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          const eagerRow = (eager.get() as { rows: object[] }).rows[0];
          expect(Object.keys(eagerRow)).toEqual([]);
          const row = (lazy.get() as { rows: Record<string, unknown>[] })
            .rows[0];
          expect(Object.keys(row)).toEqual([]);
          expect("driver" in row).toBe(false);
          expect(row.driver).toBe(undefined);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      it("voids the object when the schema requires a property", async () => {
        const read = await seeded(
          "turned-down-names-none-required",
          { id: "a", driver: "x" },
          { ...closed, required: ["id"] } as const,
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(eager.get()).toBe(undefined);
          expect(lazy.get()).toBe(undefined);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      it("still reads a property that an `allOf` part names", async () => {
        // An eager read merges the keywords beside an `allOf` into each part
        // before it looks at a key, so a part can name what the schema itself
        // does not, and the refusal does not reach that key.
        const read = await seeded(
          "turned-down-names-none-allof",
          { id: "a", driver: "x" },
          {
            ...closed,
            allOf: [{ type: "object", properties: { id: { type: "string" } } }],
          } as const,
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          expect((eager.get() as { id: string }).id).toBe("a");
          const value = lazy.get() as Record<string, unknown>;
          expect("id" in value).toBe(true);
          expect(value.id).toBe("a");
          expect(Object.keys(value)).toEqual(["id"]);
          expect("driver" in value).toBe(false);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      describe("reached through", () => {
        // The plain shape is one path; each of these reaches the same
        // refusal by another — the union arm of the narrowing, a `$ref`, a
        // `default` riding beside a value that is there, a child link — so a
        // regression in one is not caught by pinning the others.

        const rows: Array<[string, JSONSchema, string[]]> = [
          ["a `type` list", { ...closed, type: ["object", "null"] }, []],
          ["a schema with no `type`", { additionalProperties: false }, []],
          [
            "a `$ref`",
            { $defs: { Closed: closed }, $ref: "#/$defs/Closed" },
            [],
          ],
          ["a `default` beside it", { ...closed, default: { id: "d" } }, []],
          [
            "a named property",
            { type: "object", properties: { row: closed } },
            ["row"],
          ],
        ];

        for (const [route, schema, path] of rows) {
          it(`leaves out every property behind ${route}, as an eager read does`, async () => {
            const value = path.length === 0
              ? { id: "a", driver: "x" }
              : { row: { id: "a", driver: "x" } };
            const read = await seeded(
              `turned-down-via-${route}`,
              value,
              schema,
            );
            const dig = (root: unknown): Record<string, unknown> =>
              path.reduce(
                (cursor, part) => (cursor as Record<string, unknown>)[part],
                root,
              ) as Record<string, unknown>;
            const eager = read(false);
            const lazy = read(true);
            try {
              expect(Object.keys(dig(eager.get()))).toEqual([]);
              const row = dig(lazy.get());
              expect(Object.keys(row)).toEqual([]);
              expect("driver" in row).toBe(false);
              expect(row.driver).toBe(undefined);
            } finally {
              await eager.tx.commit();
              await lazy.tx.commit();
            }
          });
        }
      });

      it("leaves the refused properties out of a default it takes for an absent value", async () => {
        // Nothing is stored, so each read takes the schema's `default`. A
        // default is built from the properties the schema names rather than
        // read through a view, and this schema names none.
        const schema = {
          ...closed,
          default: { id: "d", driver: "y" },
        } as const;
        const read = (lazy: boolean) => {
          const tx = runtime.edit();
          if (lazy) tx.markLazyMaterialize(true);
          const cell = runtime.getCell(
            space,
            "turned-down-names-none-absent",
            schema,
            tx,
          );
          return { tx, get: () => cell.get() };
        };
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(Object.keys(eager.get() as object)).toEqual([]);
          const value = lazy.get() as Record<string, unknown>;
          expect(Object.keys(value)).toEqual([]);
          expect("driver" in value).toBe(false);
          expect(value.driver).toBe(undefined);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      it("leaves out every property when the `allOf` beside it holds no parts", async () => {
        // An eager read passes over an `allOf` with nothing in it, so no part
        // is there to name a key and the refusal stands.
        const read = await seeded(
          "turned-down-names-none-empty-allof",
          { id: "a", driver: "x" },
          { ...closed, allOf: [] } as const,
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(Object.keys(eager.get() as object)).toEqual([]);
          const value = lazy.get() as Record<string, unknown>;
          expect(Object.keys(value)).toEqual([]);
          expect("driver" in value).toBe(false);
          expect(value.driver).toBe(undefined);
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });

      it("hands over every property where the schema refuses none", async () => {
        // Naming no properties turns nothing down; refusing the unnamed ones is
        // what does.
        const read = await seeded(
          "names-none-refuses-none",
          { id: "a", driver: "x" },
          { type: "object" } as const,
        );
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(Object.keys(eager.get() as object)).toEqual(["id", "driver"]);
          const value = lazy.get() as Record<string, unknown>;
          expect(Object.keys(value)).toEqual(["id", "driver"]);
          expect("driver" in value).toBe(true);
          expect(value.driver).toBe("x");
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });
    });

    describe("beside an `allOf`, under a schema that refuses what it does not name", () => {
      // An eager read merges the keywords beside an `allOf` into each part
      // before it looks at a key, and the part's own keywords win. So a part
      // admits a key by naming it or by an `additionalProperties` that does not
      // refuse it, and a key no part admits stays refused.

      const named = {
        type: "object",
        properties: { id: { type: "string" } },
      } as const;
      const shapes: Array<[string, Record<string, unknown>, string[]]> = [
        ["a part that names nothing", { allOf: [{ type: "object" }] }, []],
        ["a part that is `true`", { allOf: [true] }, []],
        [
          "a part that refuses the rest itself",
          { allOf: [{ type: "object", additionalProperties: false }] },
          [],
        ],
        [
          "a part whose `additionalProperties` is a schema",
          {
            allOf: [
              { type: "object", additionalProperties: { type: "string" } },
            ],
          },
          ["id", "driver"],
        ],
        [
          "a part that declares one key `false` beside an `additionalProperties` that is a schema",
          {
            allOf: [
              {
                type: "object",
                properties: { id: false },
                additionalProperties: { type: "string" },
              },
            ],
          },
          ["driver"],
        ],
        [
          "a part that is a `$ref` to a schema naming one key",
          { $defs: { Named: named }, allOf: [{ $ref: "#/$defs/Named" }] },
          ["id"],
        ],
        [
          "a part naming one key through an `anyOf` of its own",
          { allOf: [{ anyOf: [named] }] },
          ["id"],
        ],
        [
          "a part naming one key twelve `allOf`s down",
          {
            allOf: [
              Array.from({ length: 12 }).reduce<unknown>(
                (part) => ({ allOf: [part] }),
                named,
              ),
            ],
          },
          ["id"],
        ],
        [
          "a part naming one key beside `properties` naming another",
          { properties: { q: { type: "number" } }, allOf: [named] },
          ["id"],
        ],
      ];

      for (const [shape, keywords, keys] of shapes) {
        it(`reads the keys an eager read does for ${shape}`, async () => {
          const read = await seeded(
            `turned-down-allof-${shape}`,
            { id: "a", driver: "x" },
            {
              type: "object",
              additionalProperties: false,
              ...keywords,
            } as JSONSchema,
          );
          const eager = read(false);
          const lazy = read(true);
          try {
            expect(Object.keys(eager.get() as object)).toEqual(keys);
            const value = lazy.get() as Record<string, unknown>;
            expect(Object.keys(value)).toEqual(keys);
            expect("driver" in value).toBe(keys.includes("driver"));
            expect(JSON.parse(JSON.stringify(value))).toEqual(
              JSON.parse(JSON.stringify(eager.get())),
            );
          } finally {
            await eager.tx.commit();
            await lazy.tx.commit();
          }
        });
      }
    });

    it("voids the object when a required property is one it does not describe", async () => {
      // A schema that names its properties and says nothing about the rest
      // reaches the narrowing as a missing property rather than as `false`, and
      // an eager read voids the object for that one too.
      const read = await seeded(
        "turned-down-undescribed",
        { p: 1, q: 2 },
        {
          type: "object",
          properties: { q: { type: "number" } },
          required: ["p"],
        } as const,
      );
      const eager = read(false);
      const lazy = read(true);
      try {
        expect(eager.get()).toBe(undefined);
        expect(lazy.get()).toBe(undefined);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("still reads a property whose shape the narrowing cannot see through", async () => {
      // `schemaAtPath` also returns `false` where it cannot read a child out of
      // the shape it was given. That is not a rejection, and the subschema is
      // still reachable below it.
      const read = await seeded(
        "rejected-allof",
        { p: { name: "Ada", secret: "hidden" } },
        {
          type: "object",
          properties: {
            p: {
              allOf: [
                { type: "object", properties: { name: { type: "string" } } },
                { type: "object", properties: { secret: { type: "string" } } },
              ],
            },
          },
        } as const,
      );
      const eager = read(false);
      const lazy = read(true);
      try {
        expect(JSON.parse(JSON.stringify(lazy.get()))).toEqual(
          JSON.parse(JSON.stringify(eager.get())),
        );
        expect((lazy.get() as { p: { name: string } }).p.name).toBe("Ada");
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });
  });

  describe("a key the data carries and the schema does not select", () => {
    // Such a key reads as `undefined`, which is what a key that is not there
    // reads as, so the view counts the read under a warning key of its own.
    // The pattern test runner fails a test on any warning a run counts, unless
    // the test allows console warnings. Each case compares the count either
    // side of its reads, since the logger and its counts are shared by the
    // whole process.

    const ROW: JSONSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };

    const unselectedReads = (): number =>
      getLogger("schema-view").countsByKey["unselected-key-read"]?.warn ?? 0;

    /**
     * Reads `value` under `schema`, runs `body` over what the read gives, and
     * returns how many unselected-key reads the two counted together. The
     * window opens before the read: an eager read does all its work inside
     * `get()`, so a window opened after it would see none of that.
     */
    const countedDuring = async (
      cause: string,
      value: unknown,
      schema: JSONSchema,
      lazy: boolean,
      body: (view: Record<string, unknown>) => void,
    ): Promise<number> => {
      const { tx, get } = (await seeded(cause, value, schema))(lazy);
      try {
        const before = unselectedReads();
        const view = get() as Record<string, unknown>;
        body(view);
        return unselectedReads() - before;
      } finally {
        await tx.commit();
      }
    };

    it("returns `undefined` for the key and counts the read", async () => {
      const counted = await countedDuring(
        "unselected-own",
        { id: "a", driver: "x" },
        ROW,
        true,
        (view) => expect(view.driver).toBeUndefined(),
      );
      expect(counted).toBe(1);
    });

    it("prints the key and the link it was read at once the logger is enabled", async () => {
      const logger = getLogger("schema-view");
      const printed: unknown[][] = [];
      const warn = console.warn;
      // With `LOG_TO_STDERR=1` the logger writes to stderr and never reaches
      // `console.warn`, so the route is pinned for the length of the capture.
      const stderrRoute = Deno.env.get("LOG_TO_STDERR");
      Deno.env.set("LOG_TO_STDERR", "0");
      logger.disabled = false;
      console.warn = (...args: unknown[]) => {
        printed.push(args);
      };
      try {
        await countedDuring(
          "unselected-printed",
          { id: "a", driver: "x" },
          ROW,
          true,
          (view) => expect(view.driver).toBeUndefined(),
        );
      } finally {
        console.warn = warn;
        logger.disabled = true;
        if (stderrRoute === undefined) Deno.env.delete("LOG_TO_STDERR");
        else Deno.env.set("LOG_TO_STDERR", stderrRoute);
      }

      const line = printed.find((args) => args.includes("unselected-key-read"));
      const text = (line ?? []).join(" ");
      const readAt = runtime.getCell(space, "unselected-printed")
        .getAsNormalizedFullLink().id;
      expect(text).toContain("`driver`");
      expect(text).toContain(readAt);
    });

    it("counts nothing for a key the schema selects", async () => {
      const counted = await countedDuring(
        "unselected-selected",
        { id: "a", driver: "x" },
        ROW,
        true,
        (view) => expect(view.id).toBe("a"),
      );
      expect(counted).toBe(0);
    });

    it("counts nothing for a key the data does not carry", async () => {
      const counted = await countedDuring(
        "unselected-absent",
        { id: "a" },
        ROW,
        true,
        (view) => expect(view.driver).toBeUndefined(),
      );
      expect(counted).toBe(0);
    });

    it("counts nothing for a key the schema turns down", async () => {
      const counted = await countedDuring(
        "unselected-turned-down",
        { id: "a", driver: "x", owner: "o" },
        {
          ...(ROW as object),
          properties: { id: { type: "string" }, driver: false },
          additionalProperties: false,
        } as JSONSchema,
        true,
        (view) => {
          // `driver` is declared `false`; `owner` is refused by a schema that
          // refuses what it does not name.
          expect(view.driver).toBeUndefined();
          expect(view.owner).toBeUndefined();
        },
      );
      expect(counted).toBe(0);
    });

    it("counts nothing for the keys JavaScript probes on any object", async () => {
      const counted = await countedDuring(
        "unselected-machinery",
        { id: "a", then: "later", toJSON: "text" },
        ROW,
        true,
        (view) => {
          expect(view.then).toBeUndefined();
          expect(view.toJSON).toBeUndefined();
        },
      );
      expect(counted).toBe(0);
    });

    it("counts nothing on an eager read, which hands back a plain object", async () => {
      const counted = await countedDuring(
        "unselected-eager",
        { id: "a", driver: "x" },
        ROW,
        false,
        (value) => expect(value.driver).toBeUndefined(),
      );
      expect(counted).toBe(0);
    });
  });

  describe("an array element that is an inline object", () => {
    /** Seed a cell with the value stored as given — `set()` would split array
     * elements into documents of their own, which is the other shape. */
    const seededRaw = async (cause: string, value: unknown) => {
      const write = runtime.edit();
      runtime.getCell<Record<string, unknown>>(space, cause, undefined, write)
        .setRaw(value as never);
      await write.commit();
    };

    const ITEMS = {
      type: "object",
      properties: {
        xs: {
          type: "array",
          items: { type: "object", properties: { n: { type: "number" } } },
        },
      },
    } as const;

    const linkOfElement = (tx: IExtendedStorageTransaction, cause: string) => {
      const element = (runtime.getCell(space, cause, ITEMS, tx).get() as {
        xs: Array<Record<string | symbol, unknown>>;
      }).xs[0];
      const cell = (element[toCell] as () => {
        getAsNormalizedFullLink: () => {
          id: string;
          path: readonly string[];
        };
      })();
      return cell.getAsNormalizedFullLink();
    };

    it("takes its identity from its own value, not from the slot it sits in", async () => {
      // `toCell` on `xs[0]` must not name INDEX 0 of the array: written
      // anywhere else that link would follow whatever lands there next rather
      // than this object. An eager read rebases such an element onto a `data:`
      // URI, and the value is already in hand, so the identity costs no read.
      await seededRaw("inline-element", { xs: [{ n: 1 }, { n: 2 }] });

      const eagerTx = runtime.edit();
      const lazyTx = runtime.edit();
      lazyTx.markLazyMaterialize(true);
      try {
        const eager = linkOfElement(eagerTx, "inline-element");
        const lazy = linkOfElement(lazyTx, "inline-element");
        expect(eager.id.startsWith("data:")).toBe(true);
        expect(lazy.id).toBe(eager.id);
        expect(lazy.path).toEqual(eager.path);
      } finally {
        await eagerTx.commit();
        await lazyTx.commit();
      }
    });

    it("still reads only the element the reader touched", async () => {
      await seededRaw("inline-frugal", {
        xs: [{ n: 1 }, { n: 2 }, { n: 3 }],
      });

      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell(space, "inline-frugal", ITEMS, tx)
          .get() as { xs: Array<{ n: number }> };
        expect(value.xs[0].n).toBe(1);
        const paths = pathsRead(tx);
        expect(paths.some((path) => path.endsWith("xs/0"))).toBe(true);
        expect(paths.some((path) => path.endsWith("xs/2"))).toBe(false);
      } finally {
        await tx.commit();
      }
    });
  });

  describe("a $ref the schema cannot resolve", () => {
    it("matches nothing where it is a branch of a union", async () => {
      const read = await seeded(
        "unresolvable-branch",
        { inner: { a: 1 } },
        {
          type: "object",
          properties: {
            inner: {
              anyOf: [
                { $ref: "#/$defs/Missing" },
                { type: "object", required: ["never"] },
              ],
            },
          },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        // Neither branch can describe this value: one names a definition the
        // schema does not carry, the other requires a key it does not have.
        expect((eager.get() as { inner?: { a?: number } }).inner?.a)
          .toBeUndefined();
        expect((lazy.get() as { inner?: { a?: number } }).inner?.a)
          .toBeUndefined();
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("matches everything where the definition it names is `true`", async () => {
      // A boolean target is a resolution, not a failure to resolve.
      const read = await seeded(
        "permissive-ref",
        { inner: { a: 1 } },
        {
          type: "object",
          properties: {
            inner: {
              anyOf: [
                { $ref: "#/$defs/Anything" },
                { type: "object", required: ["never"] },
              ],
            },
          },
          $defs: { Anything: true },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        expect((eager.get() as { inner?: { a?: number } }).inner?.a).toBe(1);
        expect((lazy.get() as { inner?: { a?: number } }).inner?.a).toBe(1);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("matches nothing where it is the whole schema", async () => {
      const read = await seeded(
        "unresolvable-root",
        { a: 1 },
        { $ref: "#/$defs/Missing" } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        // A schema the runtime cannot read is not the same as no schema, which
        // would hand back the value untouched.
        expect(eager.get()).toBeUndefined();
        expect(lazy.get()).toBeUndefined();
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });
  });

  describe("a link that carries a schema of its own", () => {
    it("keeps the property the reader asked for and the link's schema does not name", async () => {
      // Crossing a link is where an eager read combines the link's schema into
      // the selector: the link's schema describes the value at its target, the
      // reader's describes what the reader asked for, and both apply.
      const write = runtime.edit();
      const piece = runtime.getCell<Record<string, unknown>>(
        space,
        "link-schema-piece",
        { type: "object", properties: { isHidden: { type: "boolean" } } },
        write,
      );
      piece.setRaw({ isHidden: false, title: "Linked" });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        "link-schema-arg",
        undefined,
        write,
      );
      arg.setRaw({ p: piece.getAsLink({ includeSchema: true }) });
      await write.commit();

      const schema = {
        type: "object",
        properties: {
          p: { type: "object", properties: { title: { type: "string" } } },
        },
      } as const;
      const readBack = async (lazy: boolean) => {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const seen = (runtime.getCell(space, "link-schema-arg", schema, tx)
          .get() as { p: { title: string } }).p.title;
        await tx.commit();
        return seen;
      };

      expect(await readBack(false)).toBe("Linked");
      expect(await readBack(true)).toBe("Linked");
    });
  });

  describe("a link that ends at a string's length", () => {
    it("reads the length of the string it points at", async () => {
      // `.length` on a string output lowers to a link ending in that segment,
      // and it is the one address computed rather than stored.
      const write = runtime.edit();
      const target = runtime.getCell<string>(
        space,
        "length-target",
        undefined,
        write,
      );
      target.set("Total: 0");
      const holder = runtime.getCell<Record<string, unknown>>(
        space,
        "length-holder",
        undefined,
        write,
      );
      holder.setRaw({ label: target.getAsLink() });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        "length-arg",
        undefined,
        write,
      );
      arg.setRaw({ n: holder.key("label", "length").getAsLink() });
      await write.commit();

      const schema = {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      } as const;
      const readBack = async (lazy: boolean) => {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const seen = (runtime.getCell(space, "length-arg", schema, tx)
          .get() as { n: number }).n;
        await tx.commit();
        return seen;
      };

      expect(await readBack(false)).toBe(8);
      expect(await readBack(true)).toBe(8);
    });
  });

  describe("a view is a read", () => {
    it("refuses assignment", async () => {
      const read = await seeded(
        "no-assign",
        { a: 1 },
        {
          type: "object",
          properties: { a: { type: "number" } },
        } as const,
      );
      const lazy = read(true);
      try {
        const value = lazy.get() as { a: number };
        expect(() => {
          value.a = 2;
        }).toThrow("it is a read");
      } finally {
        await lazy.tx.commit();
      }
    });
  });
});
