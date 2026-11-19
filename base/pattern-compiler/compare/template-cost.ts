/**
 * Measures what labels from templates cost one commit (milestone 4 of
 * `docs/plans/compiled-pattern-language-integration.md`): a `filter` over
 * an array of plain values in place, over an array of references, and over
 * the result of a `map`, at each size given, over labeled inputs, with the
 * experimental option `compiledPatterns` on and off. One element changes,
 * and the figures are those of that change's commit: the time of the
 * commit preparation (the timing key
 * `extended-storage-transaction/prepareCfc`), the counters of template
 * instantiation, and the number of label entries the result document
 * stores below the filtered list.
 *
 * ```sh
 * deno run -A --no-check base/pattern-compiler/compare/template-cost.ts 100 1000 10000
 * ```
 */
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../logger/src/logger.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import { recordRelevantSchemaWritePolicyInput } from "../../../runtime/runner/src/cell.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import { type Artifact, Instance } from "../exec/executor.ts";
import { identifierOf } from "../exec/store.ts";
import { inputClause } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import { labeledInputs } from "./integrated.ts";
import { RuntimeTransactions } from "./runtime-transactions.ts";

/**
 * The cases of a `filter` this measures. In the first three the changed
 * element leaves the filtered list; in `map result, kept` it stays, with
 * another value.
 */
export type Case =
  | "in place"
  | "references"
  | "map result"
  | "map result, kept";

/** The figures of one change's commit. */
export type Figures = {
  case: Case;
  size: number;
  enabled: boolean;
  /** Preparations the change's commits ran, and their time in total. */
  preparations: number;
  prepareMs: number;
  planTemplatesInstantiated: number;
  planTemplateNodes: number;
  planSlotLabels: number;
  planLabelMemoHits: number;
  /** Label entries the result document stores below the filtered list. */
  listEntries: number;
  /** Of those, the entries at a path that holds `*`. */
  starEntries: number;
  /** Refused commits. */
  refused: string[];
};

const COUNTERS = [
  "planTemplatesInstantiated",
  "planTemplateNodes",
  "planSlotLabels",
  "planLabelMemoHits",
] as const;

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`./fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[patterns.length - 1];
};

const ITEM = {
  type: "object",
  properties: { title: { type: "string" }, done: { type: "boolean" } },
} as const;

/**
 * Measures one case at one size, with the option as `enabled` says.
 * `around` runs the change and its settlement, so that a profiler can
 * cover them alone.
 */
export const measure = async (
  which: Case,
  size: number,
  enabled: boolean,
  around: (change: () => Promise<string[]>) => Promise<string[]> = (
    change,
  ) => change(),
): Promise<Figures> => {
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
    experimental: { compiledPatterns: enabled },
    servingPosture: true,
  });
  const mapped = which === "map result" || which === "map result, kept";
  const artifact = await artifactOf(
    mapped ? "cost-filter-map" : "cost-filter",
  );
  const id = identifierOf({ test: "template-cost", which, size });
  const hooks = new RuntimeTransactions(runtime, space, {
    owner: id,
    artifact,
  });
  try {
    const audience = await scenarioAudience();
    const items = Array.from({ length: size }, (_, index) => ({
      title: `i${index}`,
      done: index % 3 === 0,
    }));
    let given: Record<string, unknown>;
    let documents: { id: string; kind: string; value: unknown }[];
    if (which === "references") {
      // Each item a cell of its own under one clause, the argument an
      // array of links to them.
      const schema = {
        ...ITEM,
        ifc: { confidentiality: [inputClause("items", audience)] },
      } as JSONSchema;
      const tx = runtime.edit();
      const ids = items.map((item, index) => {
        const cell = runtime.getCell(space, { item: index }, schema, tx);
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(item);
        hooks.external(link.id);
        return link.id;
      });
      const { error } = await tx.commit().settled;
      if (error !== undefined) throw error;
      given = { items: ids.map((doc) => ({ $link: { doc, path: [] } })) };
      documents = ids.map((doc, index) => ({
        id: doc,
        kind: "input",
        value: items[index],
      }));
    } else {
      ({ given, documents } = await labeledInputs(
        runtime,
        space,
        {
          items: {
            schema: {
              type: "array",
              items: ITEM,
              ifc: { confidentiality: [inputClause("items", audience)] },
            },
          },
        },
        { items },
        hooks,
      ));
    }
    const instance = new Instance(artifact, given, {
      space,
      id,
      transactions: hooks,
      documents,
    });
    const created = await hooks.settled();
    if (created.length > 0) throw new Error(created.join("; "));
    resetAllTimingStats();
    const before = runtime.getCfcStats();
    const refused = await around(() => {
      if (which === "map result") {
        instance.writeArgument(["items", "4", "title"], "skip");
      } else if (which === "map result, kept") {
        instance.writeArgument(["items", "4", "title"], "changed");
      } else instance.writeArgument(["items", "4", "done"], true);
      return hooks.settled();
    });
    const after = runtime.getCfcStats();
    const prepared = getTimingStatsBreakdown()["extended-storage-transaction"]
      ?.prepareCfc;
    const read = runtime.edit();
    let listEntries = 0;
    let starEntries = 0;
    try {
      const list = mapped ? "loud" : "open";
      for (
        const entry of readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(instance.id),
          scope: "space",
        })?.labelMap.entries ?? []
      ) {
        if (entry.path[0] !== list) continue;
        listEntries += 1;
        if (entry.path.includes("*")) starEntries += 1;
      }
    } finally {
      read.abort();
    }
    return {
      case: which,
      size,
      enabled,
      preparations: prepared?.count ?? 0,
      prepareMs: prepared?.totalTime ?? 0,
      ...Object.fromEntries(
        COUNTERS.map((name) => [name, after[name] - before[name]]),
      ) as Record<(typeof COUNTERS)[number], number>,
      listEntries,
      starEntries,
      refused,
    };
  } finally {
    hooks.close();
    await runtime.dispose();
    await storageManager.close();
  }
};

if (import.meta.main) {
  const sizes = Deno.args.length === 0
    ? [100, 1_000, 10_000]
    : Deno.args.map(Number);
  console.log(
    "case\tsize\toption\tpreps\tprepare ms\tinst\tnodes\tslots\tmemo\tlist entries\t* entries\trefused",
  );
  for (
    const which of [
      "in place",
      "references",
      "map result",
      "map result, kept",
    ] as const
  ) {
    for (const size of sizes) {
      for (const enabled of [false, true]) {
        const f = await measure(which, size, enabled);
        console.log(
          [
            f.case,
            f.size,
            f.enabled ? "on" : "off",
            f.preparations,
            f.prepareMs.toFixed(1),
            f.planTemplatesInstantiated,
            f.planTemplateNodes,
            f.planSlotLabels,
            f.planLabelMemoHits,
            f.listEntries,
            f.starEntries,
            f.refused.length,
          ].join("\t"),
        );
      }
    }
  }
}
