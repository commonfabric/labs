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
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
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

/** A place a state entry of a binding names, or a write edge targets. */
type PlanSlotRoot = {
  kind: string;
  collection?: number;
  handler?: number;
  cell?: number;
};

type PlanStateEntry = {
  path: string[];
  place?: { slot?: number };
  template?: Template;
};

type PlanWrite = {
  target: { kind: string; slot?: number; cell?: number; path?: string[] };
  template?: Template;
};

/** The members of a plan this harness reads. */
export type Plan = {
  slots: {
    root: PlanSlotRoot;
    path: string[];
    observes: string;
    schema?: string;
    declared?: { confidentiality?: Atom[]; integrity?: Atom[] };
  }[];
  collections: {
    source: { slot?: number; collection?: number };
    membership?: Template;
    construct?: string;
  }[];
  outputs: {
    path: string[];
    template?: Template;
    collection?: number;
    kept?: boolean;
    interim?: string;
  }[];
  bindings?: {
    name?: string;
    handler?: { body?: number };
    state?: PlanStateEntry[];
    within?: unknown[];
    /** The result path that holds the binding's stream, where one does. */
    result?: string[];
  }[];
  bodies?: {
    kind: string;
    name?: string;
    writes?: PlanWrite[];
    /** The schema of the event's declared type, where the plan has it. */
    eventSchema?: string;
  }[];
  stateCells?: { name: string; within?: unknown[] }[];
  selectors?: { arity: number }[];
};

/** An input given through a cell of its own, written under `schema`. */
export type LabeledInput = { schema: unknown; value: unknown };

/** One run of a pattern to compare. */
export type Scenario = {
  /**
   * The program, or the path of its main module on disk and the directory
   * its imports are resolved under, with the export to run where that is
   * not the default one.
   */
  program: RuntimeProgram | { main: string; root: string; export?: string };
  plan: Plan;
  argument: Record<string, unknown>;
  /**
   * Inputs the argument links to instead of holding: each is written to a
   * cell of its own under its schema, whose `ifc` annotations the runtime
   * stores as the cell's labels, and the argument holds a link to the cell.
   */
  inputs?: Record<string, LabeledInput>;
  /**
   * The branch each selector takes, by selector index. A selector that is
   * not listed is derived from the values the run stored.
   */
  selected?: Record<number, number>;
  /** Events to send, in order, each to the stream of a binding. */
  events?: { binding: number; event: unknown }[];
};

/** One row of the comparison: an output path of one run. */
export type Row = {
  /** The index of the entry in the plan's `outputs`. */
  output: number;
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

/**
 * One row for a write edge of a handler's body: a path one event's
 * transaction wrote. `template` is the label of §3.2 with no slot
 * dereferenced, since the body writes through its handles and does not
 * read what they hold.
 */
export type WriteRow = {
  binding: number;
  handler: string;
  /** The index of the write in the body's `writes`. */
  write: number;
  /** The path below the target's cell, with each `*` an index. */
  path: string[];
  runtime: Label;
  template: Evaluated;
  comparison: Comparison;
  runtimeByOrigin: { all: Label; withoutStatic: Label };
  comparisonWithoutStatic: Comparison;
};

/** Something the harness did not compare, and why. */
export type Skipped = { what: string; reason: string };

/** How the branch of each `select` and the child of each `pick` was found. */
export type Decided = {
  /** From the value stored at the output the node is the template of. */
  byValue: number;
  /** From the value of the slot the condition or the key is. */
  byCondition: number;
  /** Stated by the scenario. */
  stated: number;
  /** Not found: the label is a bound over every branch. */
  unobserved: number;
};

/** The comparison of one run. */
export type Run = {
  rows: Row[];
  writes: WriteRow[];
  skipped: Skipped[];
  decided: Decided;
};

/** A plan construct or a state of the run the harness has no reading for. */
export class Unsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

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

/** Where a slot is resolved: the elements, the binding, and its event. */
type Context = {
  elements: readonly ElementBinding[];
  binding?: number;
  event?: unknown;
};

type SelectNode = Extract<Template, { op: "select" }>;
type PickNode = Extract<Template, { op: "pick" }> & {
  from?: { container?: number; collection?: number };
};

/** The value of a place the harness could not read. */
const NO_VALUE = Symbol("no value");

const sameValue = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const isPrefix = (prefix: readonly string[], path: readonly string[]) =>
  prefix.length <= path.length &&
  prefix.every((key, index) => path[index] === key);

/** Every `select` and `pick` node of `template`, by its index. */
const indexNodes = (
  template: Template | undefined,
  selects: Map<number, SelectNode>,
  picks: Map<number, PickNode>,
): void => {
  if (template === undefined) return;
  switch (template.op) {
    case "derive":
      for (const input of template.inputs) indexNodes(input, selects, picks);
      return;
    case "select":
      if (!selects.has(template.selector)) {
        selects.set(template.selector, template);
      }
      indexNodes(template.condition, selects, picks);
      for (const branch of template.branches) {
        indexNodes(branch, selects, picks);
      }
      return;
    case "pick":
      if (!picks.has(template.pick)) picks.set(template.pick, template);
      indexNodes(template.choice, selects, picks);
      indexNodes(template.body, selects, picks);
      return;
    case "fold":
      indexNodes(template.body, selects, picks);
      return;
    default:
      return;
  }
};

/**
 * Runs `scenario`, compares every kept output of its plan that has a
 * template, then sends each event and compares the write edges of the
 * handler's body with the labels at the paths the event's run wrote.
 */
export const runScenario = async (scenario: Scenario): Promise<Run> => {
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });
  try {
    const program = "files" in scenario.program
      ? scenario.program
      : await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: scenario.program.main,
          root: scenario.program.root,
          mainExport: scenario.program.export,
        },
      );
    const compiled = await runtime.patternManager.compilePattern(
      program,
      { space },
    );
    const start = runtime.edit();
    const given: Record<string, unknown> = { ...scenario.argument };
    const givenValue: Record<string, unknown> = { ...scenario.argument };
    for (const [name, input] of Object.entries(scenario.inputs ?? {})) {
      const cell = runtime.getCell(
        space,
        { compareInput: name },
        input.schema as JSONSchema,
        start,
      );
      cell.set(input.value as never);
      given[name] = cell;
      givenValue[name] = input.value;
    }
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "compare",
      compiled.resultSchema,
      start,
    );
    runtime.run(start, compiled, given, result);
    runtime.prepareTxForCommit(start);
    const { error } = await start.commit().settled;
    if (error !== undefined) throw error;
    await result.pull();
    await runtime.idle();
    const { plan } = scenario;
    // A result path the result's schema leaves out is computed when it is
    // read: read each kept output, so that the run stores its label.
    for (const entry of plan.outputs) {
      if (entry.kept === false || entry.interim !== undefined) continue;
      const star = entry.path.indexOf("*");
      const path = star < 0 ? entry.path : entry.path.slice(0, star);
      try {
        await path.reduce(
          (cell, key) => cell.key(key as never) as AnyCell,
          result as AnyCell,
        ).pull();
      } catch {
        // A path the run does not hold has no label to compare.
      }
    }
    await runtime.idle();
    await storageManager.synced();

    const skipped: Skipped[] = [];
    const how = new Map<string, keyof Decided>();
    const selects = new Map<number, SelectNode>();
    const picks = new Map<number, PickNode>();
    for (const output of plan.outputs) {
      indexNodes(output.template, selects, picks);
    }
    for (const body of plan.bodies ?? []) {
      for (const write of body.writes ?? []) {
        indexNodes(write.template, selects, picks);
      }
    }
    for (const binding of plan.bindings ?? []) {
      for (const entry of binding.state ?? []) {
        indexNodes(entry.template, selects, picks);
      }
    }

    const at = (cell: AnyCell, path: readonly string[]): AnyCell =>
      path.reduce((inner, key) => inner.key(key as never) as AnyCell, cell);
    const valueOf = (cell: AnyCell): unknown => {
      try {
        return cell.get();
      } catch {
        return NO_VALUE;
      }
    };
    const skip = (what: string, error: unknown) =>
      skipped.push({
        what,
        reason: error instanceof Unsupported
          ? error.reason
          : `error: ${`${(error as Error)?.message ?? error}`.slice(0, 80)}`,
      });

    // What the harness reads of the run inside one transaction.
    const session = (read: ReturnType<Runtime["edit"]>) => {
      const output = result.withTx(read) as AnyCell;
      const argument = output.getArgumentCell() as AnyCell;
      // The output whose template is being evaluated, and its path.
      let current: { template: Template; path: string[] } | undefined;
      let rowKey = "";
      let nestedBound = false;

      // The cells the pattern made: its state cells by name.
      const manifest = (output.getMetaRaw("internal") ?? []) as unknown as {
        partialCause?: unknown;
        link?: unknown;
      }[];
      const stateCell = (cell: number): AnyCell => {
        const record = plan.stateCells?.[cell];
        if (record === undefined) {
          throw new Unsupported("an unlisted state cell");
        }
        if ((record.within ?? []).length > 0) {
          throw new Unsupported("a state cell of a per-element body");
        }
        const found = Array.isArray(manifest)
          ? manifest.filter((entry) => entry.partialCause === record.name)
          : [];
        const link = found.length === 1
          ? parseLink(found[0].link, output)
          : undefined;
        if (link === undefined) {
          throw new Unsupported(
            "a state cell the run's manifest does not name",
          );
        }
        return runtime.getCellFromLink(
          link as NormalizedFullLink,
          undefined,
          read,
        ) as AnyCell;
      };

      // A path of a slot with each `*` the key a pick chose in the
      // container the path is below.
      const chosenPath = (slot: number, context: Context): string[] => {
        const { root, path } = plan.slots[slot];
        return path.map((key, index) => {
          if (key !== "*") return key;
          const chosen = context.elements.findLast((element) => {
            if (element.container === undefined) return false;
            const container = plan.slots[element.container];
            return JSON.stringify(container.root) === JSON.stringify(root) &&
              JSON.stringify(container.path) ===
                JSON.stringify(path.slice(0, index + 1));
          });
          if (chosen === undefined) {
            throw new Unsupported("a slot below a child no pick chose");
          }
          return chosen.key;
        });
      };

      // The state entry of the binding a slot of root `binding` is below.
      const stateEntry = (
        slot: number,
        context: Context,
      ): { entry: PlanStateEntry; rest: string[] } => {
        if (context.binding === undefined) {
          throw new Unsupported("a slot of a binding read outside a binding");
        }
        const binding = plan.bindings?.[context.binding];
        if ((binding?.within ?? []).length > 0) {
          throw new Unsupported("a binding of a per-element body");
        }
        const path = chosenPath(slot, context);
        const entry = (binding?.state ?? [])
          .filter((entry) => isPrefix(entry.path, path))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (entry === undefined) {
          throw new Unsupported("a slot of a binding with no state entry");
        }
        return { entry, rest: path.slice(entry.path.length) };
      };

      // The cell a slot's path names, or `undefined` where the slot is of
      // an event or of a binding's state the instance computed.
      const slotCell = (
        slot: number,
        context: Context,
      ): AnyCell | undefined => {
        const { root } = plan.slots[slot];
        switch (root.kind) {
          case "argument":
            return at(argument, chosenPath(slot, context));
          case "element": {
            const binding = context.elements.findLast((element) =>
              element.collection === root.collection
            );
            if (binding === undefined) {
              throw new Unsupported("an element slot outside its collection");
            }
            return at(sourceCell(binding.collection, context), [
              binding.key,
              ...chosenPath(slot, context),
            ]);
          }
          case "state":
            return at(stateCell(root.cell ?? -1), chosenPath(slot, context));
          case "binding": {
            const { entry, rest } = stateEntry(slot, context);
            if (entry.place?.slot === undefined) return undefined;
            const place = slotCell(entry.place.slot, {
              elements: context.elements,
            });
            return place === undefined ? undefined : at(place, rest);
          }
          case "event":
            return undefined;
          default:
            throw new Unsupported(`a slot of root \`${root.kind}\``);
        }
      };
      const sourceCell = (collection: number, context: Context): AnyCell => {
        const { slot } = plan.collections[collection].source;
        const cell = slot === undefined ? undefined : slotCell(slot, context);
        if (cell === undefined) {
          throw new Unsupported(
            "a collection whose source is not a stored slot",
          );
        }
        return cell;
      };

      // The value the run holds at a slot, for finding which branch a
      // `select` took and which child a `pick` chose.
      const slotValue = (slot: number, context: Context): unknown => {
        try {
          const { root } = plan.slots[slot];
          if (root.kind === "event") {
            let value = context.event;
            for (const key of chosenPath(slot, context)) {
              if (value === null || typeof value !== "object") return NO_VALUE;
              value = (value as Record<string, unknown>)[key];
            }
            return context.event === undefined ? NO_VALUE : value;
          }
          const cell = slotCell(slot, context);
          return cell === undefined ? NO_VALUE : valueOf(cell);
        } catch {
          return NO_VALUE;
        }
      };

      // Ruling T1: integrity is anchored in an object as a whole. A read of
      // a stored object whole has the object's integrity, also where a
      // default fills one of its properties. A slot at a property a default
      // fills has the empty integrity: the argument holds no value there.
      const filledByDefault = (slot: number): boolean => {
        const { root, path } = plan.slots[slot];
        if (root.kind !== "argument" || path.includes("*")) return false;
        let value: unknown = givenValue;
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
      // The documents whose declared entries are the labels of inputs: the
      // argument's own, and the cell of each input given through a link.
      const inputIds = new Set([
        argument.getAsNormalizedFullLink().id,
        ...Object.keys(scenario.inputs ?? {}).flatMap((name) =>
          hops(at(argument, [name])).map((link) => link.id)
        ),
      ]);
      const byOrigin = (
        cell: AnyCell,
        observes: "value" | "shape",
        withStatic: boolean,
      ): Label => {
        const way = hops(cell);
        return join(way.map((link, index) => {
          const metadata = readStoredCfcMetadata(read, link);
          if (metadata === undefined) return consumed(undefined, observes);
          const kept = withStatic || inputIds.has(link.id) ? metadata : {
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

      const note = (kind: string, index: number, context: Context) =>
        `${rowKey}|${kind}${index}|${JSON.stringify(context.elements)}`;

      const inputsFor = (
        dereference: boolean,
        scope: Omit<Context, "elements">,
      ): TemplateInputs => {
        const inputs: TemplateInputs = {
          slot: (slot, elements) => {
            const context = { ...scope, elements };
            const { root, observes, declared } = plan.slots[slot];
            // An event is not stored: the label of its slot is the one
            // the event's schema declares at the path.
            if (root.kind === "event") {
              return {
                confidentiality: declared?.confidentiality ?? [],
                integrity: declared?.integrity ?? [],
              };
            }
            const cell = slotCell(slot, context);
            if (cell === undefined) {
              // A path of a binding's state that the instance computed has
              // the label of its template.
              const { entry } = stateEntry(slot, context);
              if (entry.template === undefined) {
                throw new Unsupported("a state entry with no template");
              }
              const evaluated = evaluateTemplate(
                entry.template,
                inputsFor(dereference, {}),
                elements,
              );
              if (evaluated.unsupported.length > 0) {
                throw new Unsupported(
                  `a \`${evaluated.unsupported[0]}\` node`,
                );
              }
              nestedBound ||= evaluated.bound;
              return evaluated.label;
            }
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
          selected: (selector, elements) => {
            const context = { ...scope, elements };
            const key = note("select", selector, context);
            const decide = (by: keyof Decided, branch?: number) => {
              how.set(key, by);
              return branch;
            };
            const stated = scenario.selected?.[selector];
            if (stated !== undefined) return decide("stated", stated);
            const node = selects.get(selector);
            if (node === undefined) return decide("unobserved");
            // The value stored at the output is the selected branch's.
            if (current?.template === node) {
              const value = valueOf(at(output, current.path));
              const known = node.branches.map((branch) =>
                branch.op === "slot"
                  ? slotValue(branch.slot, context)
                  : NO_VALUE
              );
              const index = (keep: (value: unknown) => boolean) =>
                known.flatMap((value, index) => keep(value) ? [index] : []);
              const equal = index((branch) =>
                branch !== NO_VALUE && sameValue(branch, value)
              );
              const unknown = index((branch) => branch === NO_VALUE);
              if (value !== NO_VALUE) {
                if (equal.length === 1 && unknown.length === 0) {
                  return decide("byValue", equal[0]);
                }
                if (equal.length === 0 && unknown.length === 1) {
                  return decide("byValue", unknown[0]);
                }
              }
            }
            // `a && b` is `select(a, [b, a])` and `a || b` is
            // `select(a, [a, b])` (PL §3.5): one branch is the condition.
            // The stored value is `a` where it converts to false under
            // `&&`, and where it converts to true under `||`.
            if (current?.template === node && node.branches.length === 2) {
              const value = valueOf(at(output, current.path));
              const same = node.branches.map((branch) =>
                sameValue(branch, node.condition)
              );
              if (value !== NO_VALUE && same[0] !== same[1]) {
                if (same[1]) return decide("byValue", value ? 0 : 1);
                if (value) return decide("byValue", 0);
              }
            }
            // A condition that is one slot: the first branch is the one
            // of a value that converts to true, and for `??`, whose
            // condition observes the slot's shape, of a value that is
            // present.
            if (node.condition.op === "slot" && node.branches.length === 2) {
              const value = slotValue(node.condition.slot, context);
              if (value !== NO_VALUE) {
                const first =
                  plan.slots[node.condition.slot].observes === "shape"
                    ? value !== undefined && value !== null
                    : Boolean(value);
                return decide("byCondition", first ? 0 : 1);
              }
            }
            return decide("unobserved");
          },
          elementKeys: (collection, elements) => {
            const value = valueOf(
              sourceCell(collection, { ...scope, elements }),
            );
            return Array.isArray(value)
              ? value.map((_, index) => `${index}`)
              : [];
          },
          membership: (collection, elements) => {
            const record = plan.collections[collection];
            const { membership } = record;
            // The membership a record iterates (PL §3.2). For a `map` it
            // is the record's own, and otherwise that of its source.
            if (
              membership !== undefined &&
              !(membership.op === "fold" &&
                membership.collection === collection)
            ) {
              const evaluated = evaluateTemplate(membership, inputs, elements);
              if (evaluated.unsupported.length > 0) {
                throw new Unsupported(
                  `a \`${evaluated.unsupported[0]}\` node`,
                );
              }
              nestedBound ||= evaluated.bound;
              return evaluated.label;
            }
            return consumed(
              cfcLabelViewForResolvedCell(
                sourceCell(collection, { ...scope, elements }),
              ),
              "shape",
            );
          },
          picked: (pick, elements) => {
            const context = { ...scope, elements };
            const key = note("pick", pick, context);
            const decide = (by: keyof Decided, chosen?: ElementBinding) => {
              how.set(key, by);
              return chosen;
            };
            const node = picks.get(pick);
            const from = node?.from;
            if (node === undefined || from === undefined) {
              return decide("unobserved");
            }
            const stored = current?.template === node
              ? valueOf(at(output, current.path))
              : NO_VALUE;
            if (from.container !== undefined) {
              const shape = from.container;
              // A key that is one slot is read from the run.
              const { choice } = node;
              if (
                choice.op === "derive" && choice.inputs.length === 2 &&
                choice.inputs[0].op === "slot" &&
                choice.inputs[1].op === "slot" &&
                choice.inputs[1].slot === shape
              ) {
                const value = slotValue(choice.inputs[0].slot, context);
                if (typeof value === "string" || typeof value === "number") {
                  return decide("byCondition", {
                    collection: -1,
                    container: shape,
                    key: `${value}`,
                  });
                }
              }
              // Otherwise the stored value is that of one child.
              if (stored !== NO_VALUE && node.body.op === "slot") {
                const { root, path } = plan.slots[shape];
                const container = plan.slots.findIndex((slot) =>
                  JSON.stringify(slot.root) === JSON.stringify(root) &&
                  JSON.stringify(slot.path) ===
                    JSON.stringify(path.slice(0, -1))
                );
                const cell = container < 0
                  ? undefined
                  : slotCell(container, context);
                const value = cell === undefined ? NO_VALUE : valueOf(cell);
                if (value !== null && typeof value === "object") {
                  const keys = Object.keys(value).filter((key) =>
                    sameValue((value as Record<string, unknown>)[key], stored)
                  );
                  if (keys.length === 1) {
                    return decide("byValue", {
                      collection: -1,
                      container: shape,
                      key: keys[0],
                    });
                  }
                }
              }
              return decide("unobserved");
            }
            if (from.collection !== undefined && stored !== NO_VALUE) {
              // The runtime's choice: the first element in the
              // collection's order whose value is the stored one.
              const source = valueOf(sourceCell(from.collection, context));
              if (Array.isArray(source)) {
                const index = source.findIndex((element) =>
                  sameValue(element, stored)
                );
                if (index >= 0) {
                  return decide("byValue", {
                    collection: from.collection,
                    key: `${index}`,
                  });
                }
              }
            }
            return decide("unobserved");
          },
          hereditary: (atom) => atomPropagationClass(atom) === "hereditary",
        };
        return inputs;
      };

      const evaluate = (
        template: Template,
        dereference: boolean,
        context: Context,
      ): Evaluated => {
        nestedBound = false;
        const evaluated = evaluateTemplate(
          template,
          inputsFor(dereference, {
            binding: context.binding,
            event: context.event,
          }),
          context.elements,
        );
        if (evaluated.unsupported.length > 0) {
          throw new Unsupported(`a \`${evaluated.unsupported[0]}\` node`);
        }
        return { ...evaluated, bound: evaluated.bound || nestedBound };
      };

      const outputRows = (): Row[] => {
        const rows: Row[] = [];
        for (const [number, entry] of plan.outputs.entries()) {
          if (entry.kept === false || entry.interim !== undefined) continue;
          const name = entry.path.join("/");
          if (entry.template === undefined) {
            skipped.push({ what: name, reason: "an output with no template" });
            continue;
          }
          const template = entry.template;
          const container = plan.outputs.some((other) =>
            other.kept !== false && other.interim === undefined &&
            other.path.length > entry.path.length &&
            isPrefix(entry.path, other.path)
          );
          // Each `*` of the path is an element of the collection the output
          // at the path above it names.
          let instances: { path: string[]; elements: ElementBinding[] }[] = [
            { path: [], elements: [] },
          ];
          try {
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
                throw new Unsupported("an element of no listed collection");
              }
              const collection = container.collection;
              instances = instances.flatMap(({ path, elements }) =>
                inputsFor(false, {}).elementKeys(collection, elements).map((
                  key,
                ) => ({
                  path: [...path, key],
                  elements: [...elements, { collection, key }],
                }))
              );
            });
          } catch (error) {
            skip(name, error);
            continue;
          }
          for (const { path, elements } of instances) {
            try {
              current = { template, path };
              rowKey = `output ${path.join("/")}`;
              // The entry of a collection is the label of its membership,
              // so the runtime's side is what a read of the container's
              // shape consumes, without the elements. The same holds for
              // the container entry of a constructed value, which has an
              // entry per path below it (PL §3.4).
              const observes = entry.collection === undefined && !container
                ? "value"
                : "shape";
              const cell = at(output, path);
              if (valueOf(cell) === undefined) {
                throw new Unsupported("an output the run holds no value at");
              }
              const runtimeLabel = consumed(
                cfcLabelViewForResolvedCell(cell),
                observes,
              );
              const stored = evaluate(template, false, { elements });
              const reached = evaluate(template, true, { elements });
              const withoutStatic = byOrigin(cell, observes, false);
              rows.push({
                output: number,
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
            } catch (error) {
              skip(path.join("/"), error);
            } finally {
              current = undefined;
            }
          }
        }
        return rows;
      };

      // The cell each write edge of a body targets, with the path below
      // it up to the first `*`, and the rest of the path.
      const writeTargets = (binding: number) => {
        const body = plan.bodies
          ?.[plan.bindings?.[binding]?.handler?.body ?? -1];
        return (body?.writes ?? []).map((write, index) => {
          try {
            const { target } = write;
            const path = target.path ?? [];
            const star = path.indexOf("*");
            const above = star < 0 ? path : path.slice(0, star);
            const context = { elements: [], binding };
            let base: AnyCell | undefined;
            if (target.kind === "handle" && target.slot !== undefined) {
              base = slotCell(target.slot, context);
            } else if (target.kind === "state" && target.cell !== undefined) {
              base = stateCell(target.cell);
            }
            if (base === undefined) {
              throw new Unsupported(
                `a write target of kind \`${target.kind}\` with no stored cell`,
              );
            }
            const cell = at(base, above);
            return {
              write,
              index,
              cell,
              value: valueOf(cell),
              below: star < 0 ? undefined : path.slice(star + 1),
            };
          } catch (error) {
            return { write, index, error };
          }
        });
      };

      const writeRow = (
        binding: number,
        event: unknown,
        write: PlanWrite,
        index: number,
        cell: AnyCell,
        path: string[],
      ): WriteRow => {
        if (write.template === undefined) {
          throw new Unsupported("a write edge with no template");
        }
        rowKey = `write ${binding}/${index}/${path.join("/")}`;
        const runtimeLabel = consumed(
          cfcLabelViewForResolvedCell(cell),
          "value",
        );
        const template = evaluate(write.template, false, {
          elements: [],
          binding,
          event,
        });
        const withoutStatic = byOrigin(cell, "value", false);
        return {
          binding,
          handler: plan.bindings?.[binding]?.name ?? "",
          write: index,
          path,
          runtime: runtimeLabel,
          template,
          comparison: compareLabels(template.label, runtimeLabel),
          runtimeByOrigin: {
            all: byOrigin(cell, "value", true),
            withoutStatic,
          },
          comparisonWithoutStatic: compareLabels(
            template.label,
            withoutStatic,
          ),
        };
      };

      return { outputRows, writeTargets, writeRow, at };
    };

    const reading = async <T>(
      body: (within: ReturnType<typeof session>) => T,
    ): Promise<T> => {
      await storageManager.synced();
      const read = runtime.edit();
      try {
        return body(session(read));
      } finally {
        read.abort();
      }
    };

    const rows = await reading((within) => within.outputRows());

    const writes: WriteRow[] = [];
    for (const { binding, event } of scenario.events ?? []) {
      const record = plan.bindings?.[binding];
      const name = `event of ${record?.name ?? binding}`;
      if (record?.result === undefined) {
        skipped.push({
          what: name,
          reason: "a binding whose stream the result does not hold",
        });
        continue;
      }
      const before = await reading((within) => within.writeTargets(binding));
      const stream = record.result.reduce(
        (cell, key) => cell.key(key as never) as AnyCell,
        result as AnyCell,
      );
      (stream as unknown as { send(event: unknown): void }).send(event);
      await runtime.idle();
      await result.pull();
      await runtime.idle();
      await reading((within) => {
        const after = within.writeTargets(binding);
        after.forEach((target, index) => {
          const what = `${name}, write ${index}`;
          const earlier = before[index];
          if ("error" in target || "error" in earlier) {
            skip(what, "error" in target ? target.error : earlier.error);
            return;
          }
          // The paths the event's run wrote: a target whose value changed,
          // and for an element target the elements it added.
          const paths: string[][] = [];
          if (target.below === undefined) {
            if (!sameValue(earlier.value, target.value)) paths.push([]);
          } else if (Array.isArray(target.value)) {
            const had = Array.isArray(earlier.value) ? earlier.value.length : 0;
            for (let at = had; at < target.value.length; at++) {
              paths.push([`${at}`, ...target.below]);
            }
          }
          if (paths.length === 0) {
            skipped.push({
              what,
              reason: "a write the event's run did not make",
            });
          }
          for (const path of paths) {
            try {
              writes.push(
                within.writeRow(
                  binding,
                  event,
                  target.write,
                  index,
                  within.at(target.cell, path),
                  path,
                ),
              );
            } catch (error) {
              skip(`${what}, ${path.join("/")}`, error);
            }
          }
        });
      });
    }

    const decided: Decided = {
      byValue: 0,
      byCondition: 0,
      stated: 0,
      unobserved: 0,
    };
    for (const by of how.values()) decided[by]++;
    return { rows, writes, skipped, decided };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** Compares every kept output of `scenario.plan` that has a template. */
export const compareScenario = async (scenario: Scenario): Promise<Row[]> =>
  (await runScenario(scenario)).rows;
