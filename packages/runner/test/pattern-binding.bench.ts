/**
 * Micro-benchmark for `unwrapOneLevelAndBindToDoc`.
 *
 * CONTEXT / CONCLUSION: reload profiling showed `bindNodeIO` is ~90% of per-node
 * instantiation cost during the `raw:map` notes-list reconcile (~3ms/node, up to
 * ~52ms for one node). `bindNodeIO` = unwrapOneLevelAndBindToDoc(in/out) +
 * findAllWriteRedirectCells(in/out). This bench was written to study the unwrap
 * part — and it PROVED unwrap is NOT the bottleneck:
 *   * unwrap is ~1.9µs/alias (5.2µs with $ref/$defs schemas) and linear — a real
 *     UI node (~30 aliases) is sub-millisecond.
 *   * A browser split-probe confirmed it: per reload, bio/unwrap = 6ms total
 *     across 133 nodes, while bio/findRedir (findAllWriteRedirectCells) = 356ms.
 * So the real cost is `findAllWriteRedirectCells`, which is NOT a pure transform:
 * it follows every write-redirect link via
 * `parseLink -> resolveLink -> readMaybeLink -> next hop`, i.e. storage
 * resolution per node. That part needs a Runtime, so it
 * isn't covered by this pure micro-bench (TODO: add an emulate-runtime bench for
 * findAllWriteRedirectCells to study/optimize the actual hotspot).
 *
 * unwrapOneLevelAndBindToDoc itself is PURE (CFC schema traversal + deep
 * clone/rebind of the binding tree; no storage/tx), studied in isolation below.
 *
 * Run as a bench:        deno bench -A packages/runner/test/pattern-binding.bench.ts
 * Run directly (study):  deno run  -A packages/runner/test/pattern-binding.bench.ts
 *                        deno run  -A packages/runner/test/pattern-binding.bench.ts 2000   # custom size
 */

import { unwrapOneLevelAndBindToDoc } from "../src/pattern-binding.ts";
import type { AnyCell } from "../src/cell.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type { FabricExecValue, JSONSchema } from "../src/builder/types.ts";

// A notebook-ish argument schema: notes[] of records with a few fields. Real
// UI bindings alias into argument.notes[i].<field>, so linkForPath walks
// this schema per path key per alias.
const ARG_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          done: { type: "boolean" },
          meta: {
            type: "object",
            properties: {
              created: { type: "number" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

function link(
  id: string,
  schema: JSONSchema | undefined,
): NormalizedFullLink {
  return {
    id: `of:${id}` as NormalizedFullLink["id"],
    space: "did:key:zBench" as NormalizedFullLink["space"],
    scope: "space",
    path: [],
    ...(schema !== undefined ? { schema } : {}),
  };
}

function cell(
  id: string,
  schema: JSONSchema | undefined,
): AnyCell<unknown> {
  const cellLink = link(id, schema);
  return {
    getAsNormalizedFullLink: () => cellLink,
    export: () => ({
      cell: cellLink.id,
      path: cellLink.path,
      scope: cellLink.scope,
    }),
  } as unknown as AnyCell<unknown>;
}

// A $ref/$defs schema as the CTS transformer actually emits (recursive piece
// shape + asCell markers), to test whether ref resolution in getSchemaAtPath is
// what's slow.
const REF_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: { $ref: "#/$defs/Note", asCell: ["cell"] },
    },
  },
  $defs: {
    Note: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        done: { type: "boolean" },
        mentioned: { type: "array", items: { $ref: "#/$defs/Note" } },
        meta: {
          type: "object",
          properties: {
            created: { type: "number" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
} as unknown as JSONSchema;

const withSchema = {
  arg: link("argument", ARG_SCHEMA),
  result: cell("result", undefined),
};
const refSchema = {
  arg: link("argument", REF_SCHEMA),
  result: cell("result", undefined),
};
const noSchema = {
  arg: link("argument", undefined),
  result: cell("result", undefined),
};

type BuildOpts = {
  /** number of `$alias` leaves (≈ the cell references in the binding) */
  aliases: number;

  /** depth of each alias path into the schema (1..4) */
  pathDepth?: number;

  /** put an explicit asCell schema on each alias (as the transformer emits) */
  aliasSchema?: boolean;
};

const FIELDS = ["title", "body", "done"] as const;

function aliasPath(i: number, depth: number): string[] {
  const p: string[] = ["notes", String(i % 50)];
  if (depth >= 2) p.push(FIELDS[i % FIELDS.length]);
  if (depth >= 3) p.push("meta", "created"); // deeper variant
  return p.slice(0, Math.max(1, depth + 1));
}

function makeAlias(i: number, opts: BuildOpts): FabricExecValue {
  return {
    $alias: {
      cell: "argument",
      path: aliasPath(i, opts.pathDepth ?? 2),
      ...(opts.aliasSchema
        ? { schema: { type: "string", asCell: ["cell"] } }
        : {}),
    },
  };
}

// Build a VNode-tree binding (what a node's `[UI]` inputBindings look like):
// a tree of {type:"vnode", name, props, children:[...]} with alias leaves.
function makeUiBinding(opts: BuildOpts): FabricExecValue {
  let leaf = 0;
  const child = (): FabricExecValue => {
    if (leaf >= opts.aliases) {
      return { type: "vnode", name: "span", props: {}, children: ["·"] };
    }
    const a = makeAlias(leaf++, opts);
    return {
      type: "vnode",
      name: "cf-cell-link",
      props: { $cell: a, style: { fontSize: "12px" } },
      children: [a],
    };
  };
  // ~branching factor 4 until all aliases are placed
  const children: FabricExecValue[] = [];
  while (leaf < opts.aliases) {
    const group: FabricExecValue[] = [];
    for (let k = 0; k < 4 && leaf < opts.aliases; k++) group.push(child());
    children.push({
      type: "vnode",
      name: "cf-vstack",
      props: {},
      children: group,
    });
  }
  return { type: "vnode", name: "cf-screen", props: {}, children };
}

type Links = typeof withSchema;

function op(binding: FabricExecValue, links: Links = withSchema): void {
  unwrapOneLevelAndBindToDoc(
    binding,
    links.arg,
    links.result,
  );
}

//
// deno bench cases
//

for (const aliases of [10, 30, 100, 300]) {
  const binding = makeUiBinding({ aliases, pathDepth: 2 });
  Deno.bench(
    `unwrapOneLevelAndBindToDoc aliases=${aliases}`,
    () => op(binding),
  );
}

//
// direct-run study harness
//

function time(
  label: string,
  binding: FabricExecValue,
  iters: number,
  links: Links = withSchema,
): void {
  for (let i = 0; i < Math.min(200, iters); i++) op(binding, links); // warmup
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) op(binding, links);
  const ms = performance.now() - t0;
  const nsPerOp = (ms * 1e6) / iters;
  console.error(label.padEnd(44), `${nsPerOp.toFixed(0).padStart(9)} ns/op`);
}

if (import.meta.main) {
  const custom = Number(Deno.args[0]);
  const sizes = Number.isFinite(custom) && custom > 0
    ? [custom]
    : [1, 10, 30, 100, 300, 1000];

  console.error(
    "\n# scaling: ns/op and ns/alias (pathDepth=2, link schema on)",
  );
  for (const aliases of sizes) {
    const binding = makeUiBinding({ aliases, pathDepth: 2 });
    const iters = aliases >= 300 ? 2000 : 20000;
    for (let i = 0; i < 200; i++) op(binding);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) op(binding);
    const ms = performance.now() - t0;
    const nsPerOp = (ms * 1e6) / iters;
    console.error(
      `aliases=${String(aliases).padStart(5)}`,
      `${nsPerOp.toFixed(0).padStart(9)} ns/op`,
      `${(nsPerOp / Math.max(1, aliases)).toFixed(0).padStart(6)} ns/alias`,
    );
  }

  console.error("\n# what drives it (aliases=100, 20000 iters each)");
  const N = 100;
  time(
    "baseline (depth2, link schema)",
    makeUiBinding({ aliases: N, pathDepth: 2 }),
    20000,
  );
  time(
    "depth1 (shallow paths)",
    makeUiBinding({ aliases: N, pathDepth: 1 }),
    20000,
  );
  time(
    "depth4 (deep paths)",
    makeUiBinding({ aliases: N, pathDepth: 4 }),
    20000,
  );
  time(
    "no link schema (linkForPath cheap)",
    makeUiBinding({ aliases: N, pathDepth: 2 }),
    20000,
    noSchema,
  );
  time(
    "aliasSchema on (transformer-style)",
    makeUiBinding({ aliases: N, pathDepth: 2, aliasSchema: true }),
    20000,
  );
  time(
    "$ref/$defs schema (transformer-style)",
    makeUiBinding({ aliases: N, pathDepth: 3 }),
    20000,
    refSchema,
  );
}
