import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_ALPHABET,
  HANDLE_TOKEN_PATTERN,
  HARNESS_HANDLE_TABLE_TYPE,
  type HarnessHandleTable,
  MIN_HANDLE_TOKEN_SUFFIX_LENGTH,
} from "../src/contracts/handle-table.ts";
import type { HarnessSkillAcquisition } from "../src/contracts/skill.ts";
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  type HandleTokenHasher,
  mergeHarnessHandleTables,
  mintAddressHandle,
  mintReferentHandle,
  resolveHandleRef,
  resolveHandleToken,
  swapLinksForTokens,
  swapTokensForRefs,
} from "../src/handle-table.ts";

const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);
const LINK_A = `/of:fid1:${HASH_A}`;
const LINK_B = `/of:fid1:${HASH_B}`;
const SPACE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
} as const;
const ACQUISITION = {
  registryId: "owner/repository/slug",
  commitSha: "f484c8265e70ec910a57342389cca5c5de7d8167",
  sourceUrl:
    "https://raw.githubusercontent.com/owner/repository/f484c8265e70ec910a57342389cca5c5de7d8167/skills/slug/SKILL.md",
  verification: "git-commit-sha",
  valueDigest: "sha256:B0YTDTjHlcVP6qHSqd5d4P5aGgCp9TS8VTB92T-rosg",
  receivedAt: "2026-04-15T19:00:00.000Z",
} as const satisfies HarnessSkillAcquisition;

/**
 * A hasher that yields the same digest for every first-attempt preimage
 * (`<salt>\0<key>`, two segments) and a different digest once a retry
 * counter joins the preimage, forcing exactly one suffix collision.
 */
const collidingHasher: HandleTokenHasher = (input) => {
  const segments = new TextDecoder().decode(input).split("\0");
  return Promise.resolve(
    new Uint8Array(32).fill(segments.length > 2 ? 1 : 0),
  );
};

const tokenPattern = () => new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`);

describe("handle-table", () => {
  describe("createHarnessHandleTable()", () => {
    it("returns an empty version-1 table salted with the given salt", () => {
      expect(createHarnessHandleTable("run-1")).toEqual({
        type: HARNESS_HANDLE_TABLE_TYPE,
        version: 1,
        salt: "run-1",
        entries: [],
      });
    });
  });

  describe("mergeHarnessHandleTables()", () => {
    it("keeps the additions of two tables minted from one base", async () => {
      const base = createHarnessHandleTable("run-1");
      const first = await mintAddressHandle(base, `of:fid1:${HASH_A}`);
      const second = await mintAddressHandle(base, `of:fid1:${HASH_B}`);

      const merged = mergeHarnessHandleTables(first.table, second.table);

      expect(merged.entries.map((entry) => entry.token).toSorted()).toEqual(
        [first.token, second.token].toSorted(),
      );
    });

    it("lets the incoming table's version of a shared entry stand", async () => {
      const base = createHarnessHandleTable("run-1");
      const plain = await mintAddressHandle(base, `of:fid1:${HASH_A}`);
      const withSchema = await mintAddressHandle(base, `of:fid1:${HASH_A}`, {
        schema: { type: "number" },
      });

      const merged = mergeHarnessHandleTables(plain.table, withSchema.table);

      expect(merged.entries).toHaveLength(1);
      expect(merged.entries[0].schema).toEqual({ type: "number" });
    });

    it("keeps an enrichment the incoming table's older copy lacks", async () => {
      const base = (await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        `of:fid1:${HASH_A}`,
      )).table;
      const enriched = await mintAddressHandle(base, `of:fid1:${HASH_A}`, {
        schema: { type: "number" },
      });
      const other = await mintAddressHandle(base, `of:fid1:${HASH_B}`);

      const merged = mergeHarnessHandleTables(enriched.table, other.table);

      expect(merged.entries).toHaveLength(2);
      expect(
        merged.entries.find((entry) => entry.token === enriched.token)?.schema,
      ).toEqual({ type: "number" });
    });

    it("takes an entry's schema source from the side whose schema it keeps", () => {
      const entry = {
        token: "cfh:a:22222",
        kind: "address" as const,
        ref: `/of:fid1:${HASH_A}`,
        addressKey: "key-a",
      };
      const held: HarnessHandleTable = {
        ...createHarnessHandleTable("run-1"),
        entries: [{ ...entry, schema: { type: "number" } }],
      };
      const incoming: HarnessHandleTable = {
        ...createHarnessHandleTable("run-1"),
        entries: [{
          ...entry,
          schema: { type: "string" },
          schemaSource: "harness",
        }],
      };

      const [merged] = mergeHarnessHandleTables(held, incoming).entries;

      expect(merged.schema).toEqual({ type: "number" });
      expect(merged.schemaSource).toBeUndefined();
    });

    it("keeps a restriction and an acquisition the incoming copy lacks", async () => {
      const base = (await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        `of:fid1:${HASH_A}`,
      )).table;
      const restricted = await mintAddressHandle(base, `of:fid1:${HASH_A}`, {
        capability: "skill-context",
        acquisition: ACQUISITION,
      });
      const other = await mintAddressHandle(base, `of:fid1:${HASH_B}`);

      const merged = mergeHarnessHandleTables(restricted.table, other.table);
      const entry = merged.entries.find((held) =>
        held.token === restricted.token
      );

      expect(entry?.capability).toBe("skill-context");
      expect(entry?.acquisition).toEqual(ACQUISITION);
    });

    it("refuses one token minted for two different addresses", () => {
      const entry = { kind: "address" as const, token: "cfh:a:22222" };
      const held: HarnessHandleTable = {
        ...createHarnessHandleTable("run-1"),
        entries: [{ ...entry, ref: `/of:fid1:${HASH_A}`, addressKey: "key-a" }],
      };
      const incoming: HarnessHandleTable = {
        ...createHarnessHandleTable("run-1"),
        entries: [{ ...entry, ref: `/of:fid1:${HASH_B}`, addressKey: "key-b" }],
      };

      expect(() => mergeHarnessHandleTables(held, incoming)).toThrow(
        "two different addresses",
      );
    });

    it("keeps the referents two writers minted from one base", async () => {
      const base = createHarnessHandleTable("run-1");
      const row = (value: string) => ({
        kind: "document" as const,
        source: "loom:rows",
        value,
        label: { confidentiality: [] },
        labelSource: "row" as const,
      });
      const first = await mintReferentHandle(base, row("first row"));
      const second = await mintReferentHandle(base, row("second row"));

      const merged = mergeHarnessHandleTables(first.table, second.table);

      expect(merged.referents?.map((referent) => referent.token).toSorted())
        .toEqual([first.token, second.token].toSorted());
    });

    it("refuses one address recorded under two different tokens", () => {
      const entry = {
        kind: "address" as const,
        ref: `/of:fid1:${HASH_A}`,
        addressKey: "key-a",
      };
      const held: HarnessHandleTable = {
        ...createHarnessHandleTable("run-1"),
        entries: [{ ...entry, token: "cfh:a:22222" }],
      };
      const incoming: HarnessHandleTable = {
        ...createHarnessHandleTable("run-1"),
        entries: [{ ...entry, token: "cfh:a:33333" }],
      };

      expect(() => mergeHarnessHandleTables(held, incoming)).toThrow(
        "two different tokens",
      );
    });

    it("refuses one token minted for two different referents", async () => {
      const constant: HandleTokenHasher = () =>
        Promise.resolve(new Uint8Array(32));
      const base = createHarnessHandleTable("run-1");
      const first = await mintReferentHandle(base, {
        kind: "document",
        source: "loom:rows",
        value: "first row",
        label: { confidentiality: [] },
        labelSource: "row",
      }, { hasher: constant });
      const second = await mintReferentHandle(base, {
        kind: "document",
        source: "loom:rows",
        value: "second row",
        label: { confidentiality: [] },
        labelSource: "row",
      }, { hasher: constant });

      expect(first.token).toBe(second.token);
      expect(() => mergeHarnessHandleTables(first.table, second.table))
        .toThrow("two different referents");
    });

    it("refuses tables salted by different runs", () => {
      expect(() =>
        mergeHarnessHandleTables(
          createHarnessHandleTable("run-1"),
          createHarnessHandleTable("run-2"),
        )
      ).toThrow("different runs");
    });
  });

  describe("mintAddressHandle()", () => {
    it("mints the same target from padded ID-only references", async () => {
      for (const prefix of ["", "/", `//${SPACE_DID}/`, `/@${SPACE_DID}/`]) {
        const ref = `${prefix}of:fid1:${HASH_A}`;
        const plain = await mintAddressHandle(
          createHarnessHandleTable("run-1"),
          ref,
        );
        const padded = await mintAddressHandle(plain.table, `  ${ref}  `);
        expect(padded.token).toBe(plain.token);
        expect(padded.table.entries).toEqual(plain.table.entries);
      }
    });

    it("retains trailing whitespace in a referenced path key", async () => {
      const ref = `${LINK_A}/a#argument `;
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        ref,
      );
      expect(resolveHandleToken(table, token)?.ref).toBe(ref);
    });

    it("records and never downgrades the skill-context capability", async () => {
      const restricted = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { capability: "skill-context" },
      );
      const reminted = await mintAddressHandle(restricted.table, LINK_A);

      expect(resolveHandleToken(reminted.table, reminted.token)?.capability)
        .toBe("skill-context");

      const general = await mintAddressHandle(
        createHarnessHandleTable("run-2"),
        LINK_A,
      );
      const upgraded = await mintAddressHandle(general.table, LINK_A, {
        capability: "skill-context",
      });
      expect(resolveHandleToken(upgraded.table, upgraded.token)?.capability)
        .toBe("skill-context");
    });

    it("returns a well-formed token drawn from the handle alphabet", async () => {
      const { token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(token).toMatch(tokenPattern());
      expect(token.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX)).toBe(true);
      const suffix = token.slice(ADDRESS_HANDLE_TOKEN_PREFIX.length);
      expect(suffix.length).toBe(MIN_HANDLE_TOKEN_SUFFIX_LENGTH);
      for (const char of suffix) {
        expect(HANDLE_TOKEN_ALPHABET.includes(char)).toBe(true);
      }
    });

    it("returns the same token for the same salt and ref across separate table instances", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(second.token).toBe(first.token);
    });

    it("returns different tokens for the same ref under different salts", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(
        createHarnessHandleTable("run-2"),
        LINK_A,
      );
      expect(second.token).not.toBe(first.token);
    });

    it("returns the existing token without adding an entry when the same ref is minted twice", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_A);
      expect(second.token).toBe(first.token);
      expect(second.table.entries.length).toBe(1);
    });

    it("returns one token for an LLM-friendly link and the bare entity URI of the same cell", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(
        first.table,
        `of:fid1:${HASH_A}`,
      );
      expect(second.token).toBe(first.token);
      expect(second.table.entries.length).toBe(1);
    });

    it("returns one token for the `@space`-suffixed and unsuffixed spellings of a link", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, `${LINK_A}@space`);
      expect(second.token).toBe(first.token);
    });

    it("records a schema supplied with the mint on the entry", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { schema: SUMMARY_SCHEMA },
      );
      expect(resolveHandleToken(table, token)?.schema).toEqual(SUMMARY_SCHEMA);
    });

    it("fills in a schema on an entry minted without one", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_A, {
        schema: SUMMARY_SCHEMA,
      });
      expect(second.token).toBe(first.token);
      expect(second.table.entries.length).toBe(1);
      expect(resolveHandleToken(second.table, second.token)?.schema).toEqual(
        SUMMARY_SCHEMA,
      );
    });

    it("keeps the first schema when a later mint supplies a different one", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { schema: SUMMARY_SCHEMA },
      );
      const second = await mintAddressHandle(first.table, LINK_A, {
        schema: { type: "string" },
      });
      expect(resolveHandleToken(second.table, second.token)?.schema).toEqual(
        SUMMARY_SCHEMA,
      );
    });

    it("stores the canonical ref, space DID and path included, for a cross-space link", async () => {
      const ref = `/@${SPACE_DID}${LINK_A}/items/0`;
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        ref,
      );
      expect(resolveHandleToken(table, token)?.ref).toBe(
        `//${SPACE_DID}${LINK_A}@space/items/0`,
      );
    });

    it("re-derives a fixed-width suffix on collision, keeping both tokens five characters and distinct", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { hasher: collidingHasher },
      );
      const second = await mintAddressHandle(
        first.table,
        LINK_B,
        { hasher: collidingHasher },
      );
      expect(first.token).toBe(
        ADDRESS_HANDLE_TOKEN_PREFIX +
          HANDLE_TOKEN_ALPHABET[0].repeat(MIN_HANDLE_TOKEN_SUFFIX_LENGTH),
      );
      expect(second.token).toBe(
        ADDRESS_HANDLE_TOKEN_PREFIX +
          HANDLE_TOKEN_ALPHABET[1].repeat(MIN_HANDLE_TOKEN_SUFFIX_LENGTH),
      );
      expect(first.token.length).toBe(second.token.length);
      expect(second.table.entries.length).toBe(2);
    });

    it("throws for a bare tagged hash without an entity URI scheme", async () => {
      await expect(
        mintAddressHandle(
          createHarnessHandleTable("run-1"),
          `fid1:${HASH_A}`,
        ),
      ).rejects.toThrow();
    });

    it("throws for an `opaque:`-schemed handle", async () => {
      await expect(
        mintAddressHandle(
          createHarnessHandleTable("run-1"),
          `opaque:${HASH_A}`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("resolveHandleToken()", () => {
    it("returns the entry holding the token", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(resolveHandleToken(table, token)).toEqual({
        token,
        kind: "address",
        ref: LINK_A,
        addressKey: table.entries[0].addressKey,
      });
    });

    it("returns `undefined` for a token the table does not hold", () => {
      const table = createHarnessHandleTable("run-1");
      expect(resolveHandleToken(table, "cfh:a:22222")).toBe(undefined);
    });
  });

  describe("resolveHandleRef()", () => {
    it("returns the entry for any spelling of an address the table holds", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      // The LLM-friendly link and the bare entity URI are one address.
      expect(resolveHandleRef(table, LINK_A)?.token).toBe(token);
      expect(resolveHandleRef(table, `of:fid1:${HASH_A}`)?.token).toBe(token);
    });

    it("returns `undefined` for an address the table does not hold", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(resolveHandleRef(table, LINK_B)).toBe(undefined);
    });

    it("returns `undefined` for text that names no address at all", () => {
      const table = createHarnessHandleTable("run-1");
      expect(resolveHandleRef(table, "the traveller's name")).toBe(undefined);
    });
  });

  describe("swapLinksForTokens()", () => {
    it("replaces an embedded LLM-friendly link, stopping the path at closing punctuation", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `See ${LINK_A}/items/0, then stop.`,
      );
      const token = table.entries[0].token;
      expect(value).toBe(`See ${token}, then stop.`);
      expect(resolveHandleToken(table, token)?.ref).toBe(`${LINK_A}/items/0`);
    });

    it("replaces a standalone schemed entity URI at a word boundary", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `the cell of:fid1:${HASH_A} holds it`,
      );
      expect(value).toBe(`the cell ${table.entries[0].token} holds it`);
    });

    it("replaces a `computed:`-schemed URI", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `computed:fid1:${HASH_A}`,
      );
      expect(value).toBe(table.entries[0].token);
    });

    it("replaces a cross-space link, DID prefix included", async () => {
      const text = `/@${SPACE_DID}${LINK_A}/items`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(table.entries[0].token);
      expect(table.entries[0].ref).toBe(`//${SPACE_DID}${LINK_A}@space/items`);
    });

    it("consumes complete references and named qualifiers without minting a shorter address", async () => {
      const text = `//${SPACE_DID}${LINK_A}@scope=user@pin=${HASH_B}/items/`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(table.entries[0].token);
      expect(table.entries[0].ref).toBe(`//${SPACE_DID}${LINK_A}@user/items/`);
      for (
        const invalid of [
          `//unresolved${LINK_A}`,
          `${LINK_A}@owner/items`,
          `${LINK_A}@`,
          `${LINK_A}#`,
          `${LINK_A}#argument/items`,
        ]
      ) {
        const result = await swapLinksForTokens(
          createHarnessHandleTable("run-1"),
          invalid,
        );
        expect(result.value).toBe(invalid);
        expect(result.table.entries).toEqual([]);
      }
    });

    it("mints one token for repeated occurrences of the same address", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `${LINK_A} and again ${LINK_A}`,
      );
      const token = table.entries[0].token;
      expect(table.entries.length).toBe(1);
      expect(value).toBe(`${token} and again ${token}`);
    });

    it("leaves a bare `fid1:` hash without a scheme untouched", async () => {
      const text = `hash fid1:${HASH_A} names nothing addressable`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(text);
      expect(table.entries).toEqual([]);
    });

    it("leaves a `/`-prefixed bare hash untouched", async () => {
      const text = `/fid1:${HASH_A}/path`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(text);
      expect(table.entries).toEqual([]);
    });

    it("leaves near-miss text untouched: a too-short id and a scheme-like word ending", async () => {
      const text = `of:fid1:abc and proof:fid1:${HASH_A}`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(text);
      expect(table.entries).toEqual([]);
    });

    it("replaces a schemed URI carrying a tagged hash with a non-`fid1` tag", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `stored at of:fid9:${HASH_A} today`,
      );
      expect(value).toBe(`stored at ${table.entries[0].token} today`);
      expect(table.entries[0].ref).toBe(`/of:fid9:${HASH_A}`);
    });

    it("consumes an `@space` scope suffix, minting the canonical unsuffixed ref", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `${LINK_A}@space holds it`,
      );
      expect(value).toBe(`${table.entries[0].token} holds it`);
      expect(table.entries[0].ref).toBe(LINK_A);
    });

    it("preserves an own `__proto__` key as data through a swap round-trip", async () => {
      const input = JSON.parse(
        `{"__proto__": {"note": "${LINK_A}"}}`,
      ) as Record<string, unknown>;
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      const swappedValue = swapped.value as Record<string, unknown>;
      expect(Object.getPrototypeOf(swappedValue)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(swappedValue, "__proto__")?.value,
      ).toEqual({ note: swapped.table.entries[0].token });
      const restored = swapTokensForRefs(
        swapped.table,
        swappedValue,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(restored, "__proto__")?.value,
      ).toEqual({ note: LINK_A });
    });

    it("replaces a single-key `@link` object wholesale with the token string", async () => {
      const input = { note: { "@link": `${LINK_A}/title` } };
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(value).toEqual({ note: table.entries[0].token });
    });

    it("leaves an `@link` object with an `opaque:` handle untouched", async () => {
      const input = { note: { "@link": "opaque:abcdefghij1234567890" } };
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(value).toEqual(input);
      expect(table.entries).toEqual([]);
    });

    it("walks arrays and nested objects without mutating the input", async () => {
      const input = {
        items: [`${LINK_A}/a`, { deep: `see of:fid1:${HASH_B}` }],
      };
      const snapshot = structuredClone(input);
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(input).toEqual(snapshot);
      expect(value).toEqual({
        items: [
          table.entries[0].token,
          { deep: `see ${table.entries[1].token}` },
        ],
      });
    });
  });

  describe("swapTokensForRefs()", () => {
    it("leaves skill-context handles opaque to the generic resolver", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { capability: "skill-context" },
      );

      expect(swapTokensForRefs(table, { handle: token })).toEqual({
        handle: token,
      });
    });

    it("restores canonical link text swapped out by `swapLinksForTokens()`", async () => {
      const text = `Read ${LINK_A}/items/0 and of:fid1:${HASH_B} now`;
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(swapTokensForRefs(swapped.table, swapped.value)).toBe(
        `Read ${LINK_A}/items/0 and ${LINK_B} now`,
      );
    });

    it("restores refs across arrays and nested objects", async () => {
      const input = { items: [`${LINK_A}/a`], meta: { link: LINK_B } };
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(swapTokensForRefs(swapped.table, swapped.value)).toEqual(input);
    });

    it("restores a token standing alone in an object key to the canonical ref", async () => {
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        { [LINK_A]: { note: "keyed" } },
      );
      const swappedValue = swapped.value as Record<string, unknown>;
      // The outbound swap really tokenised the key, so the restoration below
      // is a round trip rather than a key that was never touched.
      expect(Object.keys(swappedValue)).toEqual([
        swapped.table.entries[0].token,
      ]);
      expect(swapTokensForRefs(swapped.table, swappedValue)).toEqual({
        [LINK_A]: { note: "keyed" },
      });
    });

    it("restores a token embedded in a longer object key alongside surrounding text", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(swapTokensForRefs(table, { [`see ${token} now`]: 1 })).toEqual({
        [`see ${LINK_A} now`]: 1,
      });
    });

    it("keeps the last entry walked when a restored key collides with a literal key of the same object", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      // Both spellings name one address, so one key is the honest answer; the
      // last one walked is the one that survives.
      const restored = swapTokensForRefs(table, {
        [LINK_A]: "literal",
        [token]: "tokenised",
      }) as Record<string, unknown>;
      expect(Object.keys(restored)).toEqual([LINK_A]);
      expect(restored[LINK_A]).toBe("tokenised");
    });

    it("leaves a well-formed token the table does not hold untouched", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const text = "see cfh:a:99999 for details";
      expect(swapTokensForRefs(table, text)).toBe(text);
    });

    it("returns a non-string primitive unchanged", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(swapTokensForRefs(table, 7)).toBe(7);
      expect(swapTokensForRefs(table, true)).toBe(true);
      expect(swapTokensForRefs(table, null)).toBe(null);
    });

    it("leaves a longer alphabet run that starts with a held token untouched while replacing the standalone token", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const longer = `${token}xyz`;
      const text = `real ${token} beside fake ${longer} end`;
      expect(swapTokensForRefs(table, text)).toBe(
        `real ${LINK_A} beside fake ${longer} end`,
      );
    });
  });

  describe("assertValidHarnessHandleTable()", () => {
    it("accepts a freshly minted table", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(() => assertValidHarnessHandleTable(table)).not.toThrow();
    });

    it("throws for an unsupported version", () => {
      const table = {
        ...createHarnessHandleTable("run-1"),
        version: 2,
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "unsupported handle table version: 2",
      );
    });

    it("throws for a wrong type discriminator", () => {
      const table = {
        ...createHarnessHandleTable("run-1"),
        type: "cf-harness.other",
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "type must be",
      );
    });

    it("throws for an empty salt", () => {
      expect(() => assertValidHarnessHandleTable(createHarnessHandleTable("")))
        .toThrow("salt must be a non-empty string");
    });

    it("throws for an entry claiming schema provenance with no schema", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: table.entries.map((entry) => ({
          ...entry,
          schemaSource: "harness",
        })),
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "claims schema provenance",
      );
    });

    it("throws for entries that are not an array", () => {
      const table = {
        ...createHarnessHandleTable("run-1"),
        entries: "not-entries",
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "entries must be an array",
      );
    });

    it("throws for an entry that is not an object", () => {
      const table = {
        ...createHarnessHandleTable("run-1"),
        entries: [null],
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "entry is not an object",
      );
    });

    it("throws for an entry with an empty addressKey", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], addressKey: "" }],
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "empty addressKey",
      );
    });

    it("throws for a token outside the token grammar", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], token: "cfh:a:1!" }],
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "malformed token",
      );
    });

    it("throws for an entry kind other than `address`", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], kind: "value" }],
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "entry kind must be `address`",
      );
    });

    it("throws for an entry with an empty ref", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], ref: "" }],
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "empty ref",
      );
    });

    it("throws for an entry schema that is not a JSON Schema", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { schema: SUMMARY_SCHEMA },
      );
      for (const schema of ["a string", 42, ["an", "array"], null]) {
        const broken = {
          ...table,
          entries: [{ ...table.entries[0], schema }],
        } as unknown as HarnessHandleTable;
        expect(() => assertValidHarnessHandleTable(broken)).toThrow(
          "not a JSON Schema object or boolean",
        );
      }
      // A boolean schema is a JSON Schema, so it passes.
      expect(() =>
        assertValidHarnessHandleTable({
          ...table,
          entries: [{ ...table.entries[0], schema: false }],
        } as unknown as HarnessHandleTable)
      ).not.toThrow();
    });

    it("throws for an entry schemaSource other than `harness`", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { schema: SUMMARY_SCHEMA },
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], schemaSource: "model" }],
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "unknown schemaSource `model`",
      );
    });

    it("throws for an entry capability outside the vocabulary", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: table.entries.map((entry) => ({
          ...entry,
          capability: "browser-value",
        })),
      } as unknown as HarnessHandleTable;

      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "unknown capability",
      );
    });

    it("throws for acquisition provenance on an entry without the skill-context capability", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { acquisition: ACQUISITION },
      );

      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "without the `skill-context` capability",
      );
    });

    it("throws for an acquisition that is not an object", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { capability: "skill-context", acquisition: ACQUISITION },
      );
      for (const acquisition of [null, ["not", "an", "object"], "text"]) {
        const broken = {
          ...table,
          entries: table.entries.map((entry) => ({ ...entry, acquisition })),
        } as unknown as HarnessHandleTable;

        expect(() => assertValidHarnessHandleTable(broken)).toThrow(
          "an acquisition that is not an object",
        );
      }
    });

    it("throws for an acquisition field that is not a non-empty string", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { capability: "skill-context", acquisition: ACQUISITION },
      );
      const broken = {
        ...table,
        entries: table.entries.map((entry) => ({
          ...entry,
          acquisition: { ...ACQUISITION, commitSha: "" },
        })),
      } as unknown as HarnessHandleTable;

      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "empty acquisition `commitSha`",
      );
    });

    it("throws for an acquisition verification outside the vocabulary", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        { capability: "skill-context", acquisition: ACQUISITION },
      );
      const broken = {
        ...table,
        entries: table.entries.map((entry) => ({
          ...entry,
          acquisition: { ...ACQUISITION, verification: "vibes" },
        })),
      } as unknown as HarnessHandleTable;

      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "unknown acquisition verification",
      );
    });

    it("throws for a duplicate token", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_B);
      const broken = {
        ...second.table,
        entries: second.table.entries.map((entry) => ({
          ...entry,
          token: first.token,
        })),
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "duplicate token",
      );
    });

    it("throws for a duplicate addressKey", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_B);
      const broken = {
        ...second.table,
        entries: second.table.entries.map((entry) => ({
          ...entry,
          addressKey: second.table.entries[0].addressKey,
        })),
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "duplicate addressKey",
      );
    });
  });

  describe("serialized table round trip", () => {
    it("behaves identically after JSON serialization and back", async () => {
      const text = `Read ${LINK_A}/items/0 now`;
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      const rehydrated = JSON.parse(
        JSON.stringify(swapped.table),
      ) as HarnessHandleTable;
      expect(rehydrated).toEqual(swapped.table);
      expect(swapTokensForRefs(rehydrated, swapped.value)).toBe(text);
      const reminted = await mintAddressHandle(
        rehydrated,
        `${LINK_A}/items/0`,
      );
      expect(reminted.token).toBe(rehydrated.entries[0].token);
      expect(reminted.table.entries.length).toBe(1);
    });
  });
});
