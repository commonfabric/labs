/**
 * Runs a pattern through the existing transformer and builder in a test
 * process, and reads from that run what the comparison of
 * `docs/specs/compiled-pattern-language/README.md` (stage 3) needs: the
 * label each slot of the plan resolves to, and the label a reader of each
 * output path reaches.
 */
import { Identity } from "@commonfabric/identity";

import { atomPropagationClass } from "../../../runtime/runner/src/cfc/atom-classes.ts";
import type { CfcLabelView } from "../../../runtime/runner/src/cfc/label-view-core.ts";
import { cfcLabelViewFromMetadata } from "../../../runtime/runner/src/cfc/label-view-state.ts";
import { cfcLabelViewForResolvedCell } from "../../../runtime/runner/src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { resolveLink } from "../../../runtime/runner/src/link-resolution.ts";
import type { NormalizedFullLink } from "../../../runtime/runner/src/link-types.ts";
import { parseLink } from "../../../runtime/runner/src/link-utils.ts";
import type { Cell } from "../../../runtime/runner/src/cell.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import {
  type Atom,
  compareLabels,
  type Comparison,
  type ElementBinding,
  type Evaluated,
  evaluateTemplate,
  type Label,
  type Template,
  type TemplateInputs,
} from "./template.ts";

/** The members of a plan this harness reads. */
export type Plan = {
  slots: {
    root: { kind: string; collection?: number };
    path: string[];
    observes: string;
  }[];
  collections: { source: { slot?: number }; membership: Template }[];
  outputs: { path: string[]; template?: Template; collection?: number }[];
};

/** One run of a pattern to compare. */
export type Scenario = {
  program: RuntimeProgram;
  plan: Plan;
  argument: Record<string, unknown>;
  /** The branch each selector takes with `argument`, by selector index. */
  selected?: Record<number, number>;
};

/** One row of the comparison: an output path of one run. */
export type Row = {
  path: string[];
  runtime: Label;
  /** The template's label as §3.2 gives it. */
  stored: Evaluated;
  /**
   * The template's label with each `identity` slot joined with the label a
   * value read at the slot's path consumes: what a reader who dereferences
   * the output reaches.
   */
  reached: Evaluated;
  comparison: Comparison;
  /**
   * The runtime's label read by origin (ruling T2): the entries of each
   * document on the way from the output to its value, without the entries of
   * origin `declared` that a module's result document carries, and without
   * the entries of origin `structure` the runtime makes from them for a
   * container. Those are the join of the labels the module's argument schema
   * declares, which does not depend on what the run read. The argument's own
   * document keeps its declared entries: they are the labels of the inputs.
   */
  runtimeByOrigin: { all: Label; withoutStatic: Label };
  /** `reached` against `runtimeByOrigin.withoutStatic`. */
  comparisonWithoutStatic: Comparison;
};

type AnyCell = Cell<unknown>;

/**
 * The label a read of `observes` at the root of `view` consumes. A view's
 * entries are relative to the cell it was read for, and an entry without a
 * class covers the content classes. The confidentiality of a `followRef`
 * entry is what crossing a link on the way consumed, which every read below
 * it retains; its integrity vouches for the reference and is left out.
 */
const consumed = (
  view: CfcLabelView | undefined,
  observes: "value" | "shape" | "followRef",
): Label => {
  const confidentiality: Atom[] = [];
  const integrity: Atom[] = [];
  for (const entry of view?.entries ?? []) {
    const reference = entry.observes === "followRef";
    const below = entry.path.length > 0;
    if (observes === "followRef" && (!reference || below)) continue;
    if (observes === "shape" && below) continue;
    if (
      observes === "shape" && !reference && entry.observes === "value"
    ) continue;
    for (const clause of entry.label.confidentiality ?? []) {
      confidentiality.push(clause);
    }
    if (reference) continue;
    for (const atom of entry.label.integrity ?? []) integrity.push(atom);
  }
  return { confidentiality, integrity };
};

const join = (labels: Label[]): Label => ({
  confidentiality: labels.flatMap((label) => label.confidentiality),
  integrity: labels.flatMap((label) =>
    label.integrity === "neutral" ? [] : label.integrity
  ),
});

/** Compares every output of `scenario.plan` that has a template. */
export const compareScenario = async (scenario: Scenario): Promise<Row[]> => {
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(
      scenario.program,
      { space },
    );
    const start = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "compare",
      compiled.resultSchema,
      start,
    );
    runtime.run(start, compiled, scenario.argument, result);
    runtime.prepareTxForCommit(start);
    const { error } = await start.commit().settled;
    if (error !== undefined) throw error;
    await result.pull();
    await runtime.idle();
    await storageManager.synced();

    const { plan } = scenario;
    const read = runtime.edit();
    try {
      const output = result.withTx(read) as AnyCell;
      const argument = output.getArgumentCell() as AnyCell;
      const at = (cell: AnyCell, path: readonly string[]): AnyCell =>
        path.reduce((inner, key) => inner.key(key as never) as AnyCell, cell);

      // The cell a slot's path names, with each element root bound.
      const slotCell = (
        slot: number,
        elements: readonly ElementBinding[],
      ): AnyCell => {
        const { root, path } = plan.slots[slot];
        if (root.kind === "argument") return at(argument, path);
        if (root.kind === "element") {
          const binding = elements.findLast((element) =>
            element.collection === root.collection
          );
          if (binding === undefined) {
            throw new Error(`slot ${slot}: no element of ${root.collection}`);
          }
          return at(sourceCell(binding.collection, elements), [
            binding.key,
            ...path,
          ]);
        }
        throw new Error(`slot ${slot}: root ${root.kind} is not supported`);
      };
      const sourceCell = (
        collection: number,
        elements: readonly ElementBinding[],
      ): AnyCell => {
        const { slot } = plan.collections[collection].source;
        if (slot === undefined) {
          throw new Error(`collection ${collection}: source is not a slot`);
        }
        return slotCell(slot, elements);
      };

      // Ruling T1: integrity is anchored in an object as a whole. A read of
      // a stored object whole has the object's integrity, also where a
      // default fills one of its properties. A slot at a property a default
      // fills has the empty integrity: the argument holds no value there.
      const filledByDefault = (slot: number): boolean => {
        const { root, path } = plan.slots[slot];
        if (root.kind !== "argument") return false;
        let value: unknown = scenario.argument;
        for (const key of path) {
          if (value === null || typeof value !== "object") return false;
          value = (value as Record<string, unknown>)[key];
        }
        return value === undefined;
      };
      const readSlot = (
        slot: number,
        cell: AnyCell,
        observes: "value" | "shape",
      ): Label => {
        const label = consumed(cfcLabelViewForResolvedCell(cell), observes);
        return filledByDefault(slot) ? { ...label, integrity: [] } : label;
      };

      // The documents on the way from `cell` to the value it reads: the one
      // its path is in, and the one each link stored at the path leads to.
      const hops = (cell: AnyCell): NormalizedFullLink[] => {
        const found: NormalizedFullLink[] = [];
        let link = cell.getAsNormalizedFullLink();
        for (let depth = 0; depth < 32; depth++) {
          link = resolveLink(runtime, read, link, "top");
          found.push(link);
          const next = parseLink(read.readValueOrThrow(link), link);
          if (next === undefined) break;
          link = next as NormalizedFullLink;
        }
        return found;
      };
      const argumentId = argument.getAsNormalizedFullLink().id;
      const byOrigin = (
        cell: AnyCell,
        observes: "value" | "shape",
        withStatic: boolean,
      ): Label => {
        const way = hops(cell);
        return join(way.map((link, index) => {
          const metadata = readStoredCfcMetadata(read, link);
          if (metadata === undefined) return consumed(undefined, observes);
          const kept = withStatic || link.id === argumentId
            ? metadata
            : {
              ...metadata,
              labelMap: {
                ...metadata.labelMap,
                entries: metadata.labelMap.entries.filter((entry) =>
                  entry.origin !== "declared" && entry.origin !== "structure"
                ),
              },
            };
          const view = cfcLabelViewFromMetadata(kept, link.path);
          // A document the way passes through contributes the
          // confidentiality of its entries at the link, which a read through
          // the link retains, and the last one what the read consumes.
          return index === way.length - 1
            ? consumed(view, observes)
            : { ...consumed(view, "value"), integrity: [] };
        }));
      };

      const inputsFor = (dereference: boolean): TemplateInputs => ({
        slot: (slot, elements) => {
          const cell = slotCell(slot, elements);
          const { observes } = plan.slots[slot];
          if (observes === "identity") {
            const reference = consumed(
              cfcLabelViewForResolvedCell(cell, { lastNode: "top" }),
              "followRef",
            );
            return dereference
              ? join([reference, readSlot(slot, cell, "value")])
              : reference;
          }
          return readSlot(
            slot,
            cell,
            observes === "value" ? "value" : "shape",
          );
        },
        selected: (selector) => scenario.selected?.[selector],
        elementKeys: (collection, elements) => {
          const value = sourceCell(collection, elements).get();
          return Array.isArray(value)
            ? value.map((_, index) => `${index}`)
            : [];
        },
        membership: (collection, elements) =>
          evaluateTemplate(
            plan.collections[collection].membership,
            inputsFor(dereference),
            elements,
          ).label,
        hereditary: (atom) => atomPropagationClass(atom) === "hereditary",
      });

      const rows: Row[] = [];
      for (const entry of plan.outputs) {
        if (entry.template === undefined) continue;
        // Each `*` of the path is an element of the collection the output
        // at the path above it names.
        let instances: { path: string[]; elements: ElementBinding[] }[] = [
          { path: [], elements: [] },
        ];
        entry.path.forEach((segment, index) => {
          if (segment !== "*") {
            for (const instance of instances) instance.path.push(segment);
            return;
          }
          const container = plan.outputs.find((other) =>
            other.collection !== undefined &&
            other.path.join("/") === entry.path.slice(0, index).join("/")
          );
          if (container?.collection === undefined) {
            throw new Error(`${entry.path.join("/")}: no collection at *`);
          }
          const collection = container.collection;
          instances = instances.flatMap(({ path, elements }) =>
            inputsFor(false).elementKeys(collection, elements).map((key) => ({
              path: [...path, key],
              elements: [...elements, { collection, key }],
            }))
          );
        });
        for (const { path, elements } of instances) {
          // The entry of a collection is the label of its membership,
          // so the runtime's side is what a read of the container's shape
          // consumes, without the elements.
          const runtimeLabel = consumed(
            cfcLabelViewForResolvedCell(at(output, path)),
            entry.collection === undefined ? "value" : "shape",
          );
          const stored = evaluateTemplate(
            entry.template,
            inputsFor(false),
            elements,
          );
          const reached = evaluateTemplate(
            entry.template,
            inputsFor(true),
            elements,
          );
          const observes = entry.collection === undefined ? "value" : "shape";
          const cell = at(output, path);
          const withoutStatic = byOrigin(cell, observes, false);
          rows.push({
            path,
            runtime: runtimeLabel,
            stored,
            reached,
            comparison: compareLabels(reached.label, runtimeLabel),
            runtimeByOrigin: {
              all: byOrigin(cell, observes, true),
              withoutStatic,
            },
            comparisonWithoutStatic: compareLabels(
              reached.label,
              withoutStatic,
            ),
          });
        }
      }
      return rows;
    } finally {
      read.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};
