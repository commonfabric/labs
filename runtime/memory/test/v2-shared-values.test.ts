/**
 * Decoded values shared by vid: that a shared decode equals the codec's own
 * decode of the full text, that every document holding one stored object
 * holds one decoded copy of it, that the table lets go of a copy nothing
 * holds, and that a decode inside a rolled-back transaction is forgotten.
 * Every value is synthetic, generated from a fixed seed.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/data-model";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  decodeStoredDocumentPayload,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
} from "../v2.ts";
import { applyCommit, close, open, read } from "../v2/engine.ts";
import { SharedValues } from "../v2/shared-values.ts";
import {
  SUBTREE_MIN_BYTES,
  VALUE_STORE_SCHEMA,
  ValueStore,
} from "../v2/value-store.ts";

const utf8Length = (text: string): number =>
  new TextEncoder().encode(text).length;

/** A value store over an in-memory database, and shared values over it. */
const openStores = () => {
  const database = new Database(":memory:");
  database.exec(VALUE_STORE_SCHEMA);
  const values = new ValueStore(database);
  const shared = new SharedValues(values);
  return { database, values, shared };
};

/** Stores each row text in one committed, staged transaction; returns the vids. */
const storeAll = (
  database: Database,
  values: ValueStore,
  texts: readonly string[],
): number[] => {
  values.stage();
  database.exec("BEGIN IMMEDIATE");
  const cells = texts.map((text) => values.storeRowText(text));
  database.exec("COMMIT");
  values.settle(true);
  return cells.map((cell) => {
    if (typeof cell !== "number") throw new Error(`stored inline: ${cell}`);
    return cell;
  });
};

/** A deterministic generator of numbers in `[0, 1)`. */
const seededRandom = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const LEAVES: readonly FabricValue[] = [
  0,
  -0,
  1.5e-300,
  Number.MAX_SAFE_INTEGER,
  NaN,
  Infinity,
  -Infinity,
  2n ** 64n,
  true,
  null,
  undefined as unknown as FabricValue,
];

const STRING_PIECES = [
  "a",
  "plain",
  "é",
  "😀",
  '"',
  "\\",
  "\n",
  "\u0000",
  "\u0001",
  " ",
  "/",
];

const KEYS = ["a", "name", "items", "/", "/tag", "é", "", "k".repeat(70)];

/**
 * Generates synthetic values whose subtrees recur under different parents,
 * with array holes, `undefined` members, special numbers, bigints and
 * `/`-keyed records (written as `/object`).
 */
const valueGenerator = (seed: number) => {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const string = (): string => {
    const count = random() < 0.25
      ? 20 + Math.floor(random() * 60)
      : Math.floor(random() * 6);
    let text = "";
    for (let index = 0; index < count; index++) text += pick(STRING_PIECES);
    return text;
  };
  const recurring: FabricValue[] = [];
  const value = (depth: number): FabricValue => {
    const choice = random();
    if (recurring.length > 0 && choice < 0.2) return pick(recurring);
    if (depth > 4 || choice < 0.35) {
      return random() < 0.5 ? string() : pick(LEAVES);
    }
    let built: FabricValue;
    if (random() < 0.5) {
      const record: Record<string, FabricValue> = {};
      const members = Math.floor(random() * 6);
      for (let index = 0; index < members; index++) {
        record[pick(KEYS) + String(index)] = value(depth + 1);
      }
      built = record;
    } else {
      const length = Math.floor(random() * 6);
      const array: FabricValue[] = new Array(length);
      for (let index = 0; index < length; index++) {
        if (random() < 0.9) array[index] = value(depth + 1);
      }
      built = array;
    }
    if (recurring.length < 40 && random() < 0.15) {
      // Bounded, so that recurring subtrees nested in one another stay small.
      const bytes = utf8Length(encodeMemoryBoundary(built));
      if (bytes >= SUBTREE_MIN_BYTES + 10 && bytes < 1_000) {
        recurring.push(built);
      }
    }
    return built;
  };
  return value;
};

/** Row texts of generated values and of documents holding them. */
const generatedRowTexts = (count: number): string[] => {
  const value = valueGenerator(0x5ba7ed);
  const texts: string[] = [];
  for (let index = 0; index < count; index++) {
    const generated = value(0);
    const text = encodeMemoryBoundary(
      index % 2 === 0 ? generated : { value: generated, n: index },
    );
    if (utf8Length(text) >= 64) texts.push(text);
  }
  return texts;
};

/**
 * Whether `actual` and `expected` have the same prototype at every object
 * beneath them, and every object in `actual` is frozen.
 */
const sameShapeFrozen = (actual: unknown, expected: unknown): boolean => {
  if (actual === null || typeof actual !== "object") {
    return expected === null || typeof expected !== "object";
  }
  if (expected === null || typeof expected !== "object") return false;
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) {
    return false;
  }
  if (!Object.isFrozen(actual)) return false;
  const keys = Reflect.ownKeys(actual);
  if (keys.length !== Reflect.ownKeys(expected).length) return false;
  return keys.every((key) =>
    sameShapeFrozen(
      (actual as Record<PropertyKey, unknown>)[key],
      (expected as Record<PropertyKey, unknown>)[key],
    )
  );
};

/** A record of at least 64 bytes that the tests store as its own object. */
const SUBTREE = `{"k":"${"x".repeat(70)}","n":1}`;

describe("SharedValues", () => {
  it("decodes every generated value to what the codec decodes from its text", () => {
    const { database, values, shared } = openStores();
    const texts = generatedRowTexts(1_500);
    const vids = storeAll(database, values, texts);

    expect(texts.length).toBeGreaterThan(500);
    for (let index = 0; index < texts.length; index++) {
      const decoded = shared.valueOf(vids[index]);
      const plain = decodeTrustedMemoryBoundary(texts[index]);
      expect(encodeMemoryBoundary(decoded)).toBe(texts[index]);
      expect(sameShapeFrozen(decoded, plain)).toBe(true);
    }
    const stats = shared.stats();
    expect(stats.decodes).toBeGreaterThan(texts.length / 2);
    expect(stats.hits).toBeGreaterThan(0);
    expect(stats.materializedChildren).toBeGreaterThan(0);
    expect(
      database.prepare("SELECT count(*) FROM mem_value_object").value<
        [number]
      >()![0],
    ).toBeGreaterThan(new Set(vids).size);
  });

  it("gives every value holding one stored object the same decoded copy of it", () => {
    const { database, values, shared } = openStores();
    const [subtree, first, second] = storeAll(database, values, [
      `fvj1:${SUBTREE}`,
      `fvj1:{"value":{"a":${SUBTREE},"own":1}}`,
      `fvj1:{"value":{"list":[2,${SUBTREE}]}}`,
    ]);

    const one = shared.documentOf(first) as {
      value: { a: FabricValue };
    };
    const other = shared.documentOf(second) as {
      value: { list: FabricValue[] };
    };
    expect(one.value.a).toBe(other.value.list[1]);
    expect(one.value.a).toBe(shared.valueOf(subtree));
    expect(shared.documentOf(first)).toBe(one);
    expect(shared.stats().decodes).toBe(3);
  });

  it("lets go of a decoded copy once nothing holds it", async () => {
    // Collecting garbage on demand needs `--expose-gc`, which only a process
    // of its own can be started with.
    const output = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("../../../", import.meta.url)),
      args: (lock) => [
        "run",
        "--frozen",
        `--lock=${lock}`,
        "--allow-read",
        "--allow-write",
        "--allow-ffi",
        "--allow-env",
        "--v8-flags=--expose-gc",
        fromFileUrl(
          new URL("./v2-shared-values-release-helper.ts", import.meta.url),
        ),
      ],
    });

    const decoder = new TextDecoder();
    expect(output.success, decoder.decode(output.stderr)).toBe(true);
    expect(JSON.parse(decoder.decode(output.stdout))).toEqual({
      liveWhileHeld: 2,
      liveOnceDropped: 0,
      decodesBeforeReadingAgain: 2,
      decodesAfterReadingAgain: 4,
      readAgainEqual: true,
    });
  });

  it("decodes a stored object under `/quote`, a class instance and `/object` as the codec does", () => {
    const { database, values, shared } = openStores();
    const objectState = `{"/raw":"${"y".repeat(70)}","b":2}`;
    const texts = [
      `fvj1:${SUBTREE}`,
      `fvj1:${objectState}`,
      `fvj1:{"q":{"/quote":{"inner":${SUBTREE}}},"plain":${SUBTREE}}`,
      `fvj1:{"l":{"/Link@1":{"id":"of:synthetic","payload":${SUBTREE}}}}`,
      `fvj1:{"u":{"/Future@2":[${SUBTREE}]}}`,
      `fvj1:{"o":{"/object":${objectState}},"m":{"/object":{"/m":${SUBTREE}}}}`,
      `fvj1:{"q1":{"/quote":${SUBTREE}},"q2":{"/quote":[1,${SUBTREE}]}}`,
    ];
    const [subtree, , ...vids] = storeAll(database, values, texts);

    for (const [index, vid] of vids.entries()) {
      const decoded = shared.valueOf(vid);
      const plain = decodeTrustedMemoryBoundary(texts[index + 2]);
      // A `/quote` decodes to its content, which encodes without the quote,
      // so the comparison is with the plain decode's encoding.
      expect(encodeMemoryBoundary(decoded)).toBe(encodeMemoryBoundary(plain));
      expect(sameShapeFrozen(decoded, plain)).toBe(true);
    }
    expect((shared.valueOf(vids[0]) as Record<string, FabricValue>).q)
      .toEqual({ inner: JSON.parse(SUBTREE) });
    const quoted = shared.valueOf(vids[0]) as Record<string, FabricValue>;
    expect(quoted.plain).toBe(shared.valueOf(subtree));
    const objects = shared.valueOf(vids[3]) as {
      m: Record<string, FabricValue>;
    };
    expect(objects.m["/m"]).toBe(shared.valueOf(subtree));
    const quotes = shared.valueOf(vids[4]) as {
      q1: FabricValue;
      q2: FabricValue[];
    };
    expect(quotes.q1).toEqual(JSON.parse(SUBTREE));
    expect(quotes.q2[1]).toBe(quotes.q1);
    expect(shared.stats().materializedChildren).toBe(6);
    expect(shared.stats().rawForms).toBe(2);
  });

  it("decodes an object whose own text holds the placeholder's escape through its full text", () => {
    const { database, values, shared } = openStores();
    const text = encodeMemoryBoundary({
      value: { note: "\u0001x", padding: "p".repeat(70) },
    });
    const [vid] = storeAll(database, values, [text]);

    expect(text).toContain("\\u0001x");
    expect(encodeMemoryBoundary(shared.valueOf(vid))).toBe(text);
    expect(shared.stats().fallbacks).toBe(1);
  });

  it("refuses a document root that is not a record as the stored-document reader does", () => {
    const { database, values, shared } = openStores();
    const text = `fvj1:[${SUBTREE},1]`;
    const [vid] = storeAll(database, values, [text]);

    const expected = (() => {
      try {
        decodeStoredDocumentPayload(decodeTrustedMemoryBoundary, text);
      } catch (error) {
        return error;
      }
    })() as Error;
    expect(expected).toBeInstanceOf(TypeError);
    expect(() => shared.documentOf(vid)).toThrow(TypeError);
    expect(() => shared.documentOf(vid)).toThrow(expected.message);
  });

  it("forgets what a decode inside a rolled-back transaction learned", () => {
    for (const staged of [false, true]) {
      const { database, values, shared } = openStores();
      if (staged) {
        values.stage();
        shared.stage();
      }
      database.exec("BEGIN IMMEDIATE");
      const before = values.storeRowText(`fvj1:{"before":"${"b".repeat(70)}"}`);
      const decodedBefore = shared.valueOf(before as number);
      database.exec("ROLLBACK");
      if (staged) {
        shared.settle(false);
        values.settle(false);
      }
      const [after] = storeAll(database, values, [
        `fvj1:{"after":"${"a".repeat(70)}"}`,
      ]);

      expect(after).toBe(before);
      expect(decodedBefore).toEqual({ before: "b".repeat(70) });
      expect(shared.valueOf(after)).toEqual({ after: "a".repeat(70) });
    }
  });

  it("gives every engine read of equal stored documents one decoded copy", async () => {
    const engine = await open({ url: new URL("memory:shared-values") });
    try {
      const document = {
        value: { title: "synthetic ".repeat(10), items: [1, 2, 3] },
      };
      for (const [localSeq, id] of ["of:first", "of:second"].entries()) {
        applyCommit(engine, {
          sessionId: "session:shared-values",
          commit: {
            localSeq: localSeq + 1,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id, value: document }],
          } as never,
        });
      }

      const first = read(engine, { id: "of:first" });
      expect(first).toEqual(document);
      expect(read(engine, { id: "of:second" })).toBe(first);
    } finally {
      close(engine);
    }
  });
});
