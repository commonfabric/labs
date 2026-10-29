/**
 * Merges a stored envelope with a candidate envelope again and again, as a
 * piece whose policies differ from each release's does on every release, and
 * holds the stored result to staying the same size and meaning the same
 * thing as the document the merge canonicalizes. The envelopes are a chat
 * room's result envelopes as one release stored and the next one presented
 * them; the uncompacted merges are envelopes an earlier merge stored for that
 * pair, merged once, twice and three times, each copying the definition map
 * onto every schema it inlined and writing the recursion in them one level
 * further out, which is the form deployed documents written then still hold.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchema } from "@commonfabric/data-model-schema";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { cfcSchemaEntries } from "../../src/cfc/schema-label-view.ts";
import {
  cfcSchemaPoliciesEqual,
  mergeCfcSchemaEnvelopes,
  mergeCfcSchemaEnvelopesBeforeCanonicalization,
} from "../../src/cfc/schema-merge.ts";
import { localDefinitionName } from "../../src/cfc/schema-refs.ts";
import { gunzip } from "../traverse-replay/gzip.ts";
import { schemaUnfoldingDifferences } from "./schema-unfolding.ts";

const fixtures = new URL("../fixtures/cfc-envelope-merge/", import.meta.url);

const envelopes: { existing: JSONSchema; candidate: JSONSchema } = JSON
  .parse(
    Deno.readTextFileSync(new URL("room-result-envelopes.json", fixtures)),
  );

// Each uncompacted merge is stored with its nested definition maps written
// once: a `$defs` holding only `$fixtureDefs: <n>` stands for the `n`th
// entry of `shared`, which is what that position held.
type EncodedDocument = { shared: Record<string, unknown>[]; document: unknown };

const decodeDocument = ({ shared, document }: EncodedDocument): JSONSchema => {
  const decoded: Record<string, unknown>[] = [];
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (!isObjectNotArray(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$fixtureDefs") {
      return decoded[value.$fixtureDefs as number];
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, decode(member)]),
    );
  };
  for (const map of shared) {
    decoded.push(
      Object.fromEntries(
        Object.entries(map).map(([key, member]) => [key, decode(member)]),
      ),
    );
  }
  return decode(document) as JSONSchema;
};

const uncompacted: JSONSchema[] = (JSON.parse(
  new TextDecoder().decode(
    await gunzip(
      Deno.readFileSync(new URL("uncompacted-merges.json.gz", fixtures)),
    ),
  ),
) as { rounds: EncodedDocument[] }).rounds.map((round) =>
  internSchema(decodeDocument(round))
);

const existing = internSchema(envelopes.existing);
const candidate = internSchema(envelopes.candidate);

// The result projection is rewritten in full by its pattern's setup, as a
// source update's commit merges it.
const merge = (stored: JSONSchema): JSONSchema =>
  mergeCfcSchemaEnvelopes(stored, candidate, { generatedOutputPaths: [[]] });

/** The array slots and record members `value` stands for once serialized. */
const slotsOf = (value: unknown): number => {
  let slots = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (Array.isArray(next)) {
      slots += next.length;
      for (const member of next) pending.push(member);
    } else if (isObjectNotArray(next)) {
      for (const member of Object.values(next)) {
        slots++;
        pending.push(member);
      }
    }
  }
  return slots;
};

/** How many schemas below the root of `schema` carry a definition map. */
const nestedDefinitionMaps = (schema: JSONSchema): number => {
  let count = 0;
  const visit = (node: JSONSchema, atRoot: boolean): void => {
    if (!isObjectNotArray(node)) return;
    if (!atRoot && node.$defs !== undefined) count++;
    forEachSubschema(node, (child) => visit(child, false), {
      includeUnused: true,
    });
    if (atRoot && isObjectNotArray(node.$defs)) {
      for (const definition of Object.values(node.$defs)) {
        visit(definition as JSONSchema, false);
      }
    }
  };
  visit(schema, true);
  return count;
};

/** The root definitions of `schema` that no reference from its root reaches. */
const unreachableDefinitions = (schema: JSONSchema): string[] => {
  const definitions = (schema as JSONSchemaObj).$defs ?? {};
  const reached = new Set<string>();
  const visit = (node: JSONSchema): void => {
    if (!isObjectNotArray(node)) return;
    if (typeof node.$ref === "string") {
      const name = localDefinitionName(node.$ref);
      if (
        name !== undefined && !reached.has(name) &&
        Object.hasOwn(definitions, name)
      ) {
        reached.add(name);
        visit(definitions[name]);
      }
    }
    forEachSubschema(node, visit, { includeUnused: true });
  };
  visit(schema);
  return Object.keys(definitions).filter((name) => !reached.has(name));
};

/**
 * The definitions the merge minted, `__cfc_<tag>_<n>_<name>`, that no
 * reference from the root of `schema` reaches. An authored definition is
 * kept whether or not anything reaches it.
 */
const unreachableMintedDefinitions = (schema: JSONSchema): string[] =>
  unreachableDefinitions(schema).filter((name) => name.startsWith("__cfc_"));

/** The label entries of `schema`, each written as one comparable string. */
const labelEntries = (schema: JSONSchema): string[] =>
  cfcSchemaEntries(schema).map((entry) =>
    JSON.stringify([entry.path, entry.label, entry.conditional ?? false])
  ).sort();

/**
 * The document the merge of `stored` with the candidate canonicalizes, which
 * `merge()` returns in canonical form.
 */
const beforeCanonicalization = (stored: JSONSchema): JSONSchema =>
  mergeCfcSchemaEnvelopesBeforeCanonicalization(stored, candidate, {
    generatedOutputPaths: [[]],
  });

/** The candidate merged into the existing envelope, once, twice and thrice. */
const mergedRounds = (() => {
  let rounds: JSONSchema[] | undefined;
  return (): JSONSchema[] => {
    if (rounds === undefined) {
      rounds = [];
      for (let stored = existing; rounds.length < 3;) {
        stored = merge(stored);
        rounds.push(stored);
      }
    }
    return rounds;
  };
})();

describe("schema-merge-idempotence", () => {
  describe("merging one candidate repeatedly", () => {
    it("returns the first merge's result when that result is merged with the same candidate", () => {
      expect(merge(mergedRounds()[0])).toStrictEqual(mergedRounds()[0]);
    });

    it("keeps the stored envelope the same size across three merges", () => {
      const sizes = mergedRounds().map(slotsOf);

      expect(sizes[0]).toBeLessThan(10_000);
      expect(sizes).toStrictEqual([sizes[0], sizes[0], sizes[0]]);
    });

    it("stores no definition map below the root", () => {
      expect(mergedRounds().map(nestedDefinitionMaps)).toStrictEqual([0, 0, 0]);
    });

    it("stores no minted definition its root does not reach", () => {
      expect(mergedRounds().map(unreachableMintedDefinitions)).toStrictEqual([
        [],
        [],
        [],
      ]);
    });
  });

  describe("meaning", () => {
    // Each round is compared with the document the merge canonicalized to
    // reach it. `schemaUnfoldingDifferences()` compares what two documents
    // unfold to, so a definition's name, a map below the root, an
    // unreferenced definition, and how many levels of a recursion are
    // written out inline all drop out, and every claim, constraint and
    // annotation stays in. The label entries are compared as well, as a
    // consumer that ends a walk at the first repeated schema object reads
    // them.

    /** The document round `round` canonicalized. */
    const canonicalized = (round: number): JSONSchema =>
      beforeCanonicalization(
        round === 1 ? existing : mergedRounds()[round - 2],
      );

    for (const round of [1, 2, 3]) {
      it(`unfolds merge ${round} alike to the document it canonicalized`, () => {
        expect(
          schemaUnfoldingDifferences(
            canonicalized(round),
            mergedRounds()[round - 1],
          ),
        ).toStrictEqual([]);
      });
    }

    it("returns the label entries the document the first merge canonicalized holds", () => {
      expect(labelEntries(mergedRounds()[0])).toStrictEqual(
        labelEntries(canonicalized(1)),
      );
    });

    it("declares the policies the document the first merge canonicalized declares", () => {
      expect(cfcSchemaPoliciesEqual(mergedRounds()[0], canonicalized(1))).toBe(
        true,
      );
    });

    it("reports a difference where a claim inside a definition changes", () => {
      const merged = mergedRounds()[0] as JSONSchemaObj;
      const unreachable = unreachableDefinitions(merged);
      const [name, claimed] = Object.entries(merged.$defs!).find((
        [held, definition],
      ) =>
        !unreachable.includes(held) && isObjectNotArray(definition) &&
        definition.ifc !== undefined
      )!;
      const changed = {
        ...merged,
        $defs: {
          ...merged.$defs,
          [name]: { ...(claimed as JSONSchemaObj), ifc: {} },
        },
      };

      expect(schemaUnfoldingDifferences(merged, changed)).not.toStrictEqual(
        [],
      );
    });
  });

  describe("a recursive definition referenced beside an annotation", () => {
    const list = (integrity: string[]): JSONSchema => ({
      type: "object",
      properties: { head: { $ref: "#/$defs/Node", description: "The head." } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node", description: "The rest." },
            value: { type: "string", ifc: { integrity } },
          },
        },
      },
    });
    const narrowed = list(["checked"]);
    const mergeNarrowed = (stored: JSONSchema) =>
      mergeCfcSchemaEnvelopes(stored, narrowed);

    it("returns the first merge's result when that result is merged with the same candidate", () => {
      const once = mergeNarrowed(list(["checked", "reviewed"]));

      expect(mergeNarrowed(once)).toStrictEqual(once);
    });

    it("unfolds the merge alike to the candidate it narrows to", () => {
      const once = mergeNarrowed(list(["checked", "reviewed"]));

      expect(schemaUnfoldingDifferences(narrowed, once)).toStrictEqual([]);
    });
  });

  describe("a stored envelope that an uncompacted merge wrote", () => {
    const bloated = uncompacted[2];
    let merged: JSONSchema | undefined;
    const mergedOnce = (): JSONSchema => merged ??= merge(bloated);

    it("merges into an envelope of under 20,000 slots", () => {
      expect(slotsOf(bloated)).toBeGreaterThan(1_000_000);
      expect(slotsOf(mergedOnce())).toBeLessThan(20_000);
      expect(nestedDefinitionMaps(mergedOnce())).toBe(0);
      expect(unreachableMintedDefinitions(mergedOnce())).toStrictEqual([]);
    });

    it("merges into an envelope that unfolds alike to it", () => {
      expect(schemaUnfoldingDifferences(bloated, mergedOnce())).toStrictEqual(
        [],
      );
    });

    it("merges into an envelope that the next merge returns", () => {
      const twice = merge(mergedOnce());

      expect(merge(twice)).toStrictEqual(twice);
      expect(slotsOf(twice)).toBeLessThanOrEqual(slotsOf(mergedOnce()));
    });
  });
});
