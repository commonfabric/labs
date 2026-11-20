/**
 * The value store: that every row text reads back exactly, that equal values
 * and recurring subtrees are stored once, that the online rule decides which
 * subtrees become objects, and that caches keyed by vid never outlive a
 * rolled-back transaction. Every value is synthetic, generated from a fixed
 * seed.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";
import { encodeULEB128 } from "@commonfabric/bytes/leb128";
import type { FabricValue } from "@commonfabric/data-model";

import { encodeMemoryBoundary } from "../v2.ts";
import {
  readStoredValueText,
  referencedVids,
  ROW_INLINE_LIMIT,
  SUBTREE_MIN_BYTES,
  VALUE_STORE_SCHEMA,
  type ValueCell,
  ValueStore,
} from "../v2/value-store.ts";

const utf8 = new TextEncoder();
const utf8Length = (text: string): number => utf8.encode(text).length;

/** Opens an in-memory database holding the value store's tables. */
const openDatabase = (): Database => {
  const database = new Database(":memory:");
  database.exec(VALUE_STORE_SCHEMA);
  return database;
};

/** Runs `body` in a write transaction that commits. */
const inTransaction = <T>(database: Database, body: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const objectCount = (database: Database): number =>
  database.prepare("SELECT count(*) FROM mem_value_object").value<[number]>()![
    0
  ];

const bodyOf = (database: Database, vid: number): Uint8Array =>
  database.prepare("SELECT body FROM mem_value_object WHERE vid = ?")
    .value<[Uint8Array]>(vid)![0];

const allVids = (database: Database): number[] =>
  database.prepare("SELECT vid FROM mem_value_object ORDER BY vid")
    .values<[number]>().map(([vid]) => vid);

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

const EDGE_NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.1,
  1.5e-300,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  -Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  2 ** 53 + 2,
  1e21,
  1e-7,
  NaN,
  Infinity,
  -Infinity,
];

const EDGE_BIGINTS = [0n, -1n, 2n ** 64n, -(10n ** 40n)];

const STRING_PIECES = [
  "a",
  "plain",
  "é",
  "中文",
  "😀",
  "𝄞",
  '"',
  "\\",
  "\n",
  "\t",
  "\u0000",
  "\u0001",
  "\u001f",
  "\u007f",
  "\u2028",
  "/",
  "schema-ref@2:",
  "schema-cas@1:",
];

const KEYS = [
  "a",
  "b",
  "name",
  "items",
  "/",
  "/tag",
  "a/b",
  "é",
  "😀",
  "",
  "k".repeat(70),
];

/** Generates synthetic fabric values with shared subtrees and codec tags. */
const valueGenerator = (seed: number) => {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const string = (): string => {
    const long = random() < 0.25;
    const count = long ? 20 + Math.floor(random() * 80) : Math.floor(
      random() * 6,
    );
    let text = "";
    for (let index = 0; index < count; index++) text += pick(STRING_PIECES);
    return text;
  };
  const leaf = (): FabricValue => {
    const choice = random();
    if (choice < 0.35) return string();
    if (choice < 0.6) return pick(EDGE_NUMBERS);
    if (choice < 0.7) return pick(EDGE_BIGINTS);
    if (choice < 0.8) return random() < 0.5;
    if (choice < 0.9) return null;
    return Math.floor(random() * 1000);
  };
  // Subtrees of 64 bytes or more reused across values, so that the same
  // subtree turns up under many different parents.
  const shared: FabricValue[] = [];
  const value = (depth: number): FabricValue => {
    const choice = random();
    if (shared.length > 0 && choice < 0.15) return pick(shared);
    if (depth > 4 || choice < 0.35) return leaf();
    let built: FabricValue;
    if (random() < 0.5) {
      const record: Record<string, FabricValue> = {};
      const members = Math.floor(random() * 6);
      for (let index = 0; index < members; index++) {
        const key = pick(KEYS) + (random() < 0.5 ? String(index) : "");
        record[key] = random() < 0.08
          ? undefined as unknown as FabricValue
          : value(depth + 1);
      }
      built = record;
    } else {
      const length = Math.floor(random() * 6);
      const array: FabricValue[] = new Array(length);
      for (let index = 0; index < length; index++) {
        // A skipped index is a hole.
        if (random() < 0.9) array[index] = value(depth + 1);
      }
      built = array;
    }
    if (shared.length < 40 && random() < 0.1) {
      const text = encodeMemoryBoundary(built);
      if (utf8Length(text) >= SUBTREE_MIN_BYTES + 10) shared.push(built);
    }
    return built;
  };
  return { value, random };
};

/** Row texts of `count` generated values, plus nested and edge cases. */
const generatedRowTexts = (count: number): string[] => {
  const { value } = valueGenerator(0x5eed);
  const texts: string[] = [];
  for (let index = 0; index < count; index++) {
    texts.push(encodeMemoryBoundary(value(0)));
  }
  let nested: FabricValue = "x".repeat(70);
  for (let depth = 0; depth < 300; depth++) {
    nested = depth % 2 === 0 ? [nested, depth] : { d: nested, n: depth };
  }
  texts.push(encodeMemoryBoundary(nested));
  for (const empty of [[], {}, "", [[]], { "": {} }]) {
    texts.push(encodeMemoryBoundary(empty as FabricValue));
  }
  for (const number of EDGE_NUMBERS) {
    texts.push(encodeMemoryBoundary([number, "p".repeat(60)]));
  }
  texts.push(encodeMemoryBoundary("\u0001".repeat(40)));
  texts.push(encodeMemoryBoundary({ ["\u0001".repeat(20)]: "\u0001" }));
  return texts;
};

/** Whether `value` and everything beneath it, except `skip`s, is frozen. */
const isDeepFrozen = (
  value: unknown,
  skip: (node: object) => boolean,
): boolean => {
  if (value === null || typeof value !== "object") return true;
  if (skip(value)) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeepFrozen(child, skip));
};

/** A record holding `member` under `key`, padded to differ by `tag`. */
const holder = (key: string, member: string, tag: number): string =>
  `fvj1:{"${key}":${member},"tag":${tag}}`;

/** A JSON string token of exactly `bytes` UTF-8 bytes. */
const stringToken = (bytes: number, fill = "s"): string =>
  `"${fill.repeat(bytes - 2)}"`;

describe("ValueStore", () => {
  describe("round trip", () => {
    it("returns every generated row text exactly, with its UTF-8 length", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const texts = generatedRowTexts(2_000);
      const cells = inTransaction(database, () => {
        const written = texts.map((text) => values.storeRowText(text));
        written.forEach((cell, index) => {
          expect(values.rowText(cell)).toBe(texts[index]);
        });
        return written;
      });
      cells.forEach((cell, index) => {
        expect(values.rowText(cell)).toBe(texts[index]);
        expect(values.rowByteLength(cell)).toBe(utf8Length(texts[index]));
      });
      const fresh = new ValueStore(database);
      cells.forEach((cell, index) => {
        expect(fresh.rowText(cell)).toBe(texts[index]);
        expect(fresh.rowByteLength(cell)).toBe(utf8Length(texts[index]));
      });
      expect(cells.some((cell) => typeof cell === "number")).toBe(true);
      expect(values.stats().hashHits).toBeGreaterThan(0);
      values.close();
      fresh.close();
      database.close();
    });

    it("stores every vid wide enough to put a `0x01` byte inside a reference", () => {
      // Vid 129 is LEB128 `0x81 0x01`: a reader that scanned for the marker
      // byte without skipping each reference's varint would misread it.

      const database = openDatabase();
      const values = new ValueStore(database);
      const shared = stringToken(80, "q");
      const cells = inTransaction(database, () => {
        const written: ValueCell[] = [];
        for (let index = 0; index < 300; index++) {
          written.push(values.storeRowText(holder("v", shared, index)));
          written.push(
            values.storeRowText(`fvj1:${stringToken(70 + (index % 50), "n")}`),
          );
        }
        return written;
      });
      expect(allVids(database).length).toBeGreaterThan(129);
      cells.forEach((cell, index) => {
        const text = index % 2 === 0
          ? holder("v", shared, index / 2)
          : `fvj1:${stringToken(70 + (((index - 1) / 2) % 50), "n")}`;
        expect(values.rowText(cell)).toBe(text);
      });
      values.close();
      database.close();
    });
  });

  describe("storeRowText()", () => {
    it("returns text under 64 bytes as the same string, and a vid from 64 bytes", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const under = `fvj1:${stringToken(ROW_INLINE_LIMIT - 6)}`;
      const at = `fvj1:${stringToken(ROW_INLINE_LIMIT - 5)}`;
      // Fewer UTF-16 code units than the limit, more UTF-8 bytes.
      const wide = `fvj1:"${"é".repeat(30)}"`;
      expect(utf8Length(under)).toBe(63);
      expect(utf8Length(at)).toBe(64);
      expect(wide.length).toBeLessThan(ROW_INLINE_LIMIT);
      inTransaction(database, () => {
        expect(values.storeRowText(under)).toBe(under);
        expect(typeof values.storeRowText(at)).toBe("number");
        expect(typeof values.storeRowText(wide)).toBe("number");
      });
      values.close();
      database.close();
    });

    it("returns a text with no `fvj1:` prefix, or with no JSON after it, as itself", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const unprefixed = `{"a":${stringToken(80)}}`;
      const notJson = `fvj1:{"a": ${stringToken(80)}}`;
      inTransaction(database, () => {
        expect(values.storeRowText(unprefixed)).toBe(unprefixed);
        expect(values.storeRowText(notJson)).toBe(notJson);
      });
      expect(objectCount(database)).toBe(0);
      values.close();
      database.close();
    });

    it("returns the same vid for the same text and inserts nothing the second time", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const text = encodeMemoryBoundary({
        title: "t".repeat(90),
        list: [1, 2, { nested: "n".repeat(80) }],
      });
      const first = inTransaction(database, () => values.storeRowText(text));
      const stored = objectCount(database);
      const second = inTransaction(database, () => values.storeRowText(text));
      expect(second).toBe(first);
      expect(objectCount(database)).toBe(stored);
      values.close();
      database.close();
    });

    it("throws outside a transaction", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      expect(() => values.storeRowText(`fvj1:${stringToken(80)}`)).toThrow();
      expect(() => values.storeFragment(stringToken(80))).toThrow();
      values.close();
      database.close();
    });
  });

  describe("the online rule", () => {
    it("stores a subtree seen under a second parent as an object, and references it after", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const subtree = `{"payload":${stringToken(188, "p")}}`;
      expect(utf8Length(subtree)).toBe(200);
      const [first, second, third] = inTransaction(database, () => [
        values.storeRowText(holder("a", subtree, 1)),
        values.storeRowText(holder("b", subtree, 2)),
        values.storeRowText(holder("c", subtree, 3)),
      ]) as number[];
      expect(values.readObject(first).refs).toEqual([]);
      const secondRefs = values.readObject(second).refs;
      expect(secondRefs.length).toBe(1);
      expect(values.fragmentText(secondRefs[0])).toBe(subtree);
      expect(values.readObject(third).refs).toEqual(secondRefs);
      values.close();
      database.close();
    });

    it("leaves a subtree inline when it recurs under the same parent", () => {
      const subtree = `{"payload":${stringToken(188, "p")}}`;
      const parent = `{"w":${subtree}}`;

      const sameValue = openDatabase();
      const values = new ValueStore(sameValue);
      const twice = inTransaction(
        sameValue,
        () => values.storeRowText(`fvj1:[${subtree},${subtree}]`),
      ) as number;
      expect(values.readObject(twice).refs).toEqual([]);
      values.close();
      sameValue.close();

      // `parent` recurs under a second root, so it becomes an object; inside
      // it `subtree` is seen under `parent` again and stays inline.
      const sameParent = openDatabase();
      const others = new ValueStore(sameParent);
      const second = inTransaction(sameParent, () => {
        others.storeRowText(holder("x", parent, 1));
        return others.storeRowText(holder("y", parent, 2));
      }) as number;
      const [parentVid] = others.readObject(second).refs;
      expect(others.fragmentText(parentVid)).toBe(parent);
      expect(others.readObject(parentVid).refs).toEqual([]);
      others.close();
      sameParent.close();
    });

    it("makes a subtree a candidate from exactly 64 bytes", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const at = stringToken(SUBTREE_MIN_BYTES, "a");
      const under = stringToken(SUBTREE_MIN_BYTES - 1, "u");
      const cells = inTransaction(database, () => [
        values.storeRowText(holder("m", at, 1)),
        values.storeRowText(holder("n", at, 2)),
        values.storeRowText(holder("m", under, 1)),
        values.storeRowText(holder("n", under, 2)),
      ]) as number[];
      expect(values.readObject(cells[1]).refs.length).toBe(1);
      expect(values.readObject(cells[3]).refs).toEqual([]);
      values.close();
      database.close();
    });

    it("never replaces a member name", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const key = "k".repeat(98);
      expect(utf8Length(`"${key}"`)).toBe(100);
      const cells = inTransaction(database, () => [
        values.storeRowText(`fvj1:{"${key}":1}`),
        values.storeRowText(`fvj1:{"${key}":2}`),
        values.storeRowText(`fvj1:[{"${key}":3},{"${key}":4}]`),
      ]) as number[];
      for (const cell of cells) {
        const object = values.readObject(cell);
        expect(object.refs).toEqual([]);
        expect(new TextDecoder().decode(object.payload)).toContain(key);
      }
      values.close();
      database.close();
    });
  });

  describe("hash collisions", () => {
    it("keeps distinct fragments apart and equal ones together when every hash is equal", () => {
      const database = openDatabase();
      const constant = new Uint8Array(16).fill(7);
      const values = new ValueStore(database, {
        hashForTesting: () => constant,
      });
      // Flat records with short members: the root is the only candidate.
      const texts = [
        `fvj1:{"a":"${"x".repeat(60)}"}`,
        `fvj1:{"a":"${"y".repeat(60)}"}`,
        `fvj1:{"b":"${"x".repeat(60)}","c":1}`,
      ];
      const cells = inTransaction(database, () => {
        const written = texts.map((text) => values.storeRowText(text));
        written.push(values.storeRowText(texts[0]));
        return written;
      });
      expect(new Set(cells.slice(0, 3)).size).toBe(3);
      expect(cells[3]).toBe(cells[0]);
      // The second text misses the first; the third misses both.
      expect(values.stats().hashCollisions).toBe(3);
      expect(objectCount(database)).toBe(3);
      cells.forEach((cell, index) => {
        expect(values.rowText(cell)).toBe(texts[index % 3]);
      });
      values.close();
      database.close();
    });

    it("returns every generated row text exactly when every hash is equal", () => {
      const database = openDatabase();
      const constant = new Uint8Array(16);
      const values = new ValueStore(database, {
        hashForTesting: () => constant,
      });
      const texts = generatedRowTexts(150);
      const cells = inTransaction(
        database,
        () => texts.map((text) => values.storeRowText(text)),
      );
      cells.forEach((cell, index) => {
        expect(values.rowText(cell)).toBe(texts[index]);
      });
      expect(values.stats().hashCollisions).toBeGreaterThan(0);
      values.close();
      database.close();
    });
  });

  describe("compression", () => {
    it("compresses a repetitive fragment and stores a random-looking short one raw", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const repetitive = `"${"abcdefgh".repeat(1_250)}"`;
      const random = seededRandom(9);
      let noise = "";
      while (utf8Length(noise) < 38) {
        noise += String.fromCharCode(0x21 + Math.floor(random() * 90))
          .replace(/["\\]/, "z");
      }
      const short = `"${noise}"`;
      expect(utf8Length(repetitive)).toBe(10_002);
      expect(utf8Length(short)).toBe(40);
      const [big, small] = inTransaction(database, () => [
        values.storeFragment(repetitive),
        values.storeFragment(short),
      ]);
      const bigBody = bodyOf(database, big);
      expect(bigBody[0] & 1).toBe(1);
      expect(bigBody.length).toBeLessThan(10_000);
      expect(bodyOf(database, small)[0] & 1).toBe(0);
      expect(values.fragmentText(big)).toBe(repetitive);
      expect(values.fragmentText(small)).toBe(short);
      values.close();
      database.close();
    });
  });

  describe("rowMayContainReservedSchemaRef()", () => {
    it("returns true for a reserved prefix anywhere, even only inside a referenced object", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const marked = `{"ref":"schema-ref@2:${"r".repeat(70)}"}`;
      const cas = `fvj1:{"s":"x schema-cas@1:${"c".repeat(70)}"}`;
      const plain = `fvj1:{"s":"${"p".repeat(90)}"}`;
      const [first, second, third, casCell, plainCell] = inTransaction(
        database,
        () => [
          values.storeRowText(holder("a", marked, 1)),
          values.storeRowText(holder("b", marked, 2)),
          values.storeRowText(holder("c", marked, 3)),
          values.storeRowText(cas),
          values.storeRowText(plain),
        ],
      );
      const object = values.readObject(third as number);
      expect(object.refs.length).toBe(1);
      expect(new TextDecoder().decode(object.payload)).not.toContain(
        "schema-ref@2:",
      );
      for (const cell of [first, second, third, casCell]) {
        expect(values.rowMayContainReservedSchemaRef(cell)).toBe(true);
      }
      expect(values.rowMayContainReservedSchemaRef(plainCell)).toBe(false);
      expect(values.rowMayContainReservedSchemaRef('fvj1:"schema-ref@2:x"'))
        .toBe(true);
      expect(values.rowMayContainReservedSchemaRef('fvj1:"x"')).toBe(false);
      expect(values.rowMayContainReservedSchemaRef(null)).toBe(false);
      values.close();
      database.close();
    });
  });

  describe("the seen table", () => {
    it("returns every value exactly with four slots, overwriting slots as it goes", () => {
      const database = openDatabase();
      const values = new ValueStore(database, { seenSlots: 4 });
      const texts = generatedRowTexts(300);
      const cells = inTransaction(
        database,
        () => texts.map((text) => values.storeRowText(text)),
      );
      cells.forEach((cell, index) => {
        expect(values.rowText(cell)).toBe(texts[index]);
      });
      expect(values.stats().seenOverwrites).toBeGreaterThan(0);
      values.close();
      database.close();
    });

    it("forgets a sighting whose slot another subtree took", () => {
      const subtree = `{"s":${stringToken(80, "s")}}`;
      const other = `{"o":${stringToken(80, "o")}}`;
      const refsOfThird = (seenSlots: number): readonly number[] => {
        const database = openDatabase();
        const values = new ValueStore(database, { seenSlots });
        const third = inTransaction(database, () => {
          values.storeRowText(holder("a", subtree, 1));
          values.storeRowText(holder("o", other, 1));
          return values.storeRowText(holder("b", subtree, 2));
        }) as number;
        const refs = values.readObject(third).refs;
        values.close();
        database.close();
        return refs;
      };
      // One slot: the sighting of `other` evicts that of `subtree`.
      expect(refsOfThird(1)).toEqual([]);
      expect(refsOfThird(65_536).length).toBe(1);
    });

    it("refuses a slot count that is not a power of two", () => {
      const database = openDatabase();
      expect(() => new ValueStore(database, { seenSlots: 3 })).toThrow();
      expect(() => new ValueStore(database, { seenSlots: 0 })).toThrow();
      database.close();
    });
  });

  describe("caches and transactions", () => {
    const first = holder("first", stringToken(90, "f"), 1);
    const second = holder("second", stringToken(120, "g"), 2);

    it("returns the new value for a vid a rolled-back transaction had used", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      database.exec("BEGIN IMMEDIATE");
      const lost = values.storeRowText(first);
      expect(values.rowText(lost)).toBe(first);
      expect(values.rowByteLength(lost)).toBe(utf8Length(first));
      database.exec("ROLLBACK");
      const kept = inTransaction(database, () => values.storeRowText(second));
      expect(kept).toBe(lost);
      expect(values.rowText(kept)).toBe(second);
      expect(values.rowByteLength(kept)).toBe(utf8Length(second));
      values.close();
      database.close();
    });

    it("returns the new value after a staged scope settles as dropped", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      values.stage();
      database.exec("BEGIN IMMEDIATE");
      const lost = values.storeRowText(first);
      expect(values.rowText(lost)).toBe(first);
      database.exec("ROLLBACK");
      values.settle(false);
      values.stage();
      const kept = inTransaction(database, () => values.storeRowText(second));
      values.settle(true);
      expect(kept).toBe(lost);
      expect(values.rowText(kept)).toBe(second);
      expect(values.rowByteLength(kept)).toBe(utf8Length(second));
      values.close();
      database.close();
    });

    it("publishes what a committed stage read, and caches nothing read in an unstaged transaction", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const vid = inTransaction(
        database,
        () => values.storeRowText(first),
      ) as number;
      const fetches = () => values.stats().objectsFetched;

      inTransaction(database, () => values.rowText(vid));
      const afterUnstaged = fetches();
      values.rowText(vid);
      expect(fetches()).toBe(afterUnstaged + 1);

      const other = new ValueStore(database);
      other.stage();
      inTransaction(database, () => other.rowText(vid));
      other.settle(true);
      const afterStaged = other.stats().objectsFetched;
      other.rowText(vid);
      expect(other.stats().objectsFetched).toBe(afterStaged);
      expect(other.stats().textCacheEntries).toBe(1);
      values.close();
      other.close();
      database.close();
    });

    it("bounds the text cache by its byte budget", () => {
      const database = openDatabase();
      const values = new ValueStore(database, { textCacheBytes: 1_000 });
      const cells = inTransaction(database, () => {
        const written: ValueCell[] = [];
        for (let index = 0; index < 40; index++) {
          written.push(
            values.storeRowText(holder("v", stringToken(90), index)),
          );
        }
        return written;
      });
      for (const cell of cells) values.rowText(cell);
      expect(values.stats().textCacheBytes).toBeLessThanOrEqual(1_000);
      expect(values.stats().textCacheEntries).toBeGreaterThan(0);
      values.close();
      database.close();
    });
  });

  describe("rawTree()", () => {
    it("returns the parsed fragment with each child as its placeholder, deep-frozen", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const child = `{"payload":[${stringToken(80, "c")},1,{"x":null}]}`;
      const vid = inTransaction(database, () => {
        values.storeRowText(holder("a", child, 1));
        return values.storeRowText(
          `fvj1:{"b":${child},"list":[${child},"\\n😀",-0.5,true],"tag":2}`,
        );
      }) as number;
      const refs = values.readObject(vid).refs;
      expect(refs.length).toBe(2);
      class Placeholder {
        constructor(readonly vid: number) {}
      }
      const tree = values.rawTree(vid, (childVid) => new Placeholder(childVid));
      expect(
        isDeepFrozen(tree, (node) => node instanceof Placeholder),
      ).toBe(true);
      const substituted = JSON.parse(
        JSON.stringify(
          tree,
          (_key, value) =>
            value instanceof Placeholder
              ? JSON.parse(values.fragmentText(value.vid))
              : value,
        ),
      );
      expect(substituted).toEqual(JSON.parse(values.fragmentText(vid)));
      values.close();
      database.close();
    });

    it("returns undefined for an object whose own text holds the escape for U+0001", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const [own, inChild] = inTransaction(database, () => {
        const marked = `{"m":"\\u0001abc${"z".repeat(60)}"}`;
        values.storeRowText(holder("a", marked, 1));
        return [
          values.storeFragment(`["\\u0001abc",${stringToken(70)}]`),
          values.storeRowText(holder("b", marked, 2)),
        ];
      }) as number[];
      expect(values.rawTree(own, () => ({}))).toBeUndefined();
      // The escape lies only in the referenced child, not in the object's own
      // text.
      expect(values.readObject(inChild).refs.length).toBe(1);
      expect(values.rawTree(inChild, () => ({}))).not.toBeUndefined();
      values.close();
      database.close();
    });
  });

  describe("readStoredValueText()", () => {
    it("returns what `rowText()` returns for every generated cell", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const texts = generatedRowTexts(2_000);
      const cells = inTransaction(
        database,
        () => texts.map((text) => values.storeRowText(text)),
      );
      cells.forEach((cell) => {
        expect(readStoredValueText(database, cell)).toBe(values.rowText(cell));
      });
      expect(readStoredValueText(database, null)).toBeNull();
      values.close();
      database.close();
    });
  });

  describe("referencedVids()", () => {
    it("returns the refs `readObject()` reports, whose lengths add up to the fragment's", () => {
      const database = openDatabase();
      const values = new ValueStore(database);
      const texts = generatedRowTexts(2_000);
      inTransaction(database, () => {
        for (const text of texts) values.storeRowText(text);
      });
      let referencing = 0;
      for (const vid of allVids(database)) {
        const refs = referencedVids(bodyOf(database, vid));
        const object = values.readObject(vid);
        expect(refs).toEqual(object.refs);
        const ownBytes = object.payload.length -
          refs.reduce((sum, ref) => sum + 1 + encodeULEB128(ref).length, 0);
        const childBytes = refs.reduce(
          (sum, ref) => sum + values.readObject(ref).fragmentByteLength,
          0,
        );
        expect(ownBytes + childBytes).toBe(object.fragmentByteLength);
        if (refs.length > 0) referencing++;
      }
      expect(referencing).toBeGreaterThan(0);
      values.close();
      database.close();
    });
  });
});
