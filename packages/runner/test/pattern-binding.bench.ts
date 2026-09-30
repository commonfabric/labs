/**
 * Measures alias binding with real Runtime acquisition and retained scope caps.
 * Runtime construction and disposal are outside each benchmark's timed region.
 * Run a diagnostic comparison with `deno run -A <this file> [alias-count]`.
 */

import { Identity } from "@commonfabric/identity";

import { unwrapOneLevelAndBindToDoc } from "../src/pattern-binding.ts";
import type { AnyCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
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
};

const signer = await Identity.fromPassphrase("pattern-binding-benchmark");

type Posture = "off" | "persist" | "persist with retained cap";
type Links = { arg: NormalizedFullLink; result: AnyCell<unknown> };

function fixture(posture: Posture, schema: JSONSchema | undefined) {
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({ as: signer }),
    cfcFlowLabels: posture === "off" ? "off" : "persist",
  });
  const tx = runtime.edit();
  const argument = runtime.getCellFromLink(
    {
      space: signer.did(),
      id: "of:argument",
      scope: "space",
      path: [],
      ...(schema === undefined ? {} : { schema }),
      ...(posture === "persist with retained cap"
        ? { scopeCaps: [{ depth: 0, scope: "space" as const }] }
        : {}),
    },
    undefined,
    tx,
  );
  return {
    arg: argument.getAsNormalizedFullLink(),
    result: runtime.getCell(signer.did(), "result", undefined, tx),
    async close() {
      tx.abort();
      await runtime.dispose();
    },
  };
}

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

function op(binding: FabricExecValue, links: Links): void {
  unwrapOneLevelAndBindToDoc(binding, links.arg, links.result);
}

for (const aliases of [10, 30, 100, 300]) {
  const binding = makeUiBinding({ aliases, pathDepth: 2 });
  for (
    const posture of ["off", "persist", "persist with retained cap"] as const
  ) {
    Deno.bench({
      name: `unwrapOneLevelAndBindToDoc aliases=${aliases}${
        posture === "off" ? "" : ` (${posture})`
      }`,
      async fn(b) {
        const links = fixture(posture, ARG_SCHEMA);
        try {
          for (let i = 0; i < 20; i++) op(binding, links);
          b.start();
          op(binding, links);
          b.end();
        } finally {
          await links.close();
        }
      },
    });
  }
}

/** Reports warm alias-binding cost with one Runtime held across iterations. */
async function time(
  label: string,
  binding: FabricExecValue,
  aliases: number,
  posture: Posture,
  schema: JSONSchema | undefined,
): Promise<void> {
  const links = fixture(posture, schema);
  const iterations = Math.max(20, Math.floor(20000 / aliases));
  try {
    for (let i = 0; i < 20; i++) op(binding, links);
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) op(binding, links);
    const nsPerOp = ((performance.now() - t0) * 1e6) / iterations;
    console.error(
      `${posture}: ${label}`,
      `${nsPerOp.toFixed(0)} ns/op`,
      `${(nsPerOp / aliases).toFixed(0)} ns/alias`,
    );
  } finally {
    await links.close();
  }
}

if (import.meta.main) {
  const custom = Number(Deno.args[0]);
  const sizes = Number.isFinite(custom) && custom > 0
    ? [custom]
    : [1, 10, 30, 100, 300, 1000];
  for (
    const posture of ["off", "persist", "persist with retained cap"] as const
  ) {
    for (const aliases of sizes) {
      await time(
        `aliases=${aliases}`,
        makeUiBinding({ aliases, pathDepth: 2 }),
        aliases,
        posture,
        ARG_SCHEMA,
      );
    }
    for (
      const [label, schema] of [
        ["no schema", undefined],
        ["recursive schema", REF_SCHEMA],
      ] as const
    ) {
      await time(
        label,
        makeUiBinding({ aliases: 100, pathDepth: 2 }),
        100,
        posture,
        schema,
      );
    }
  }
}
