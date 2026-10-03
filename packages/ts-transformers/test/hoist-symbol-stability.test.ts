import { assert, assertEquals } from "@std/assert";
import { transformSource } from "./utils.ts";

/**
 * Content-addressed hoist symbols (the fix for source-order numbering
 * stranding deployed pieces): a hoist's canonical name is a digest of its own
 * canonical print, so inserting, removing, or reordering OTHER hoists must
 * not re-key an existing one. These tests pin the three load-bearing
 * properties: insertion stability, twin determinism, and positional-alias
 * emission.
 */

const PATTERN_HASH_NAME = /__cfPattern_h[0-9a-f]{12}(?:_[2-9]\d*)?/g;

function patternNames(output: string): Set<string> {
  return new Set(output.match(PATTERN_HASH_NAME) ?? []);
}

const TWO_MAPS = `
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

export default pattern<{ items: Item[] }>(({ items }) => {
  const titles = items.map((item) => item.title);
  const flags = items.map((item) => item.done);
  return { titles, flags };
});
`;

// The same file with a NEW map inserted AHEAD of both existing ones — the
// exact edit that renumbered `_2` to `_4` under the positional scheme.
const THREE_MAPS = TWO_MAPS.replace(
  "const titles",
  "const lengths = items.map((item) => item.title.length);\n  const titles",
);

// Two byte-identical callbacks: same digest, so the second takes an
// occurrence ordinal.
const TWIN_MAPS = `
import { pattern } from "commonfabric";

interface Item {
  title: string;
}

export default pattern<{ items: Item[] }>(({ items }) => {
  const a = items.map((item) => item.title);
  const b = items.map((item) => item.title);
  return { a, b };
});
`;

Deno.test("inserting a map ahead leaves existing canonical names untouched", async () => {
  const two = await transformSource(TWO_MAPS);
  const three = await transformSource(THREE_MAPS);
  const twoNames = patternNames(two);
  const threeNames = patternNames(three);
  assertEquals(twoNames.size, 2, `expected 2 hoists in base: ${[...twoNames]}`);
  assertEquals(
    threeNames.size,
    3,
    `expected 3 hoists after insertion: ${[...threeNames]}`,
  );
  for (const name of twoNames) {
    assert(
      threeNames.has(name),
      `existing hoist ${name} was re-keyed by an unrelated insertion; ` +
        `after: ${[...threeNames]}`,
    );
  }
});

Deno.test("identical twins take deterministic occurrence ordinals", async () => {
  const output = await transformSource(TWIN_MAPS);
  const names = [...patternNames(output)];
  assertEquals(names.length, 2, `expected exactly two names: ${names}`);
  const [base, second] = names[0].length <= names[1].length
    ? [names[0], names[1]]
    : [names[1], names[0]];
  assertEquals(
    second,
    `${base}_2`,
    "twin must be the base name plus an occurrence ordinal",
  );
});

Deno.test("positional aliases are registered beside canonical names", async () => {
  const output = await transformSource(THREE_MAPS);
  // Canonical shorthand first, then the visit-order alias naming the same
  // binding — first-write-wins in the runtime's forward map is what makes new
  // serializations canonical, so the ORDER is part of the contract.
  const aliasMatches = [
    ...output.matchAll(/__cfPattern_(\d+): (__cfPattern_h[0-9a-f]{12}\w*)/g),
  ];
  assertEquals(
    aliasMatches.map((m) => m[1]),
    ["1", "2", "3"],
    "every hoist gets a visit-order alias",
  );
  for (const m of aliasMatches) {
    assert(
      output.indexOf(`${m[2]},`) < output.indexOf(`${m[1]}: ${m[2]}`) ||
        output.indexOf(`${m[2]}\n`) < output.indexOf(`${m[1]}: ${m[2]}`),
      `canonical ${m[2]} must be registered before its alias`,
    );
  }
});

Deno.test("hash names are deterministic across compilations", async () => {
  const first = await transformSource(TWO_MAPS);
  const second = await transformSource(TWO_MAPS);
  assertEquals(patternNames(first), patternNames(second));
});
