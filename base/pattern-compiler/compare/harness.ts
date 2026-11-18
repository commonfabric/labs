/**
 * Runs a pattern through the existing transformer and builder in a test
 * process, and reads from that run what the comparison of
 * `docs/specs/compiled-pattern-language/README.md` (stage 3) needs: the
 * label each slot of the plan resolves to, and the label a reader of each
 * output path reaches.
 */
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { atomPropagationClass } from "../../../runtime/runner/src/cfc/atom-classes.ts";
import type { CfcLabelView } from "../../../runtime/runner/src/cfc/label-view-core.ts";
import { cfcLabelViewFromMetadata } from "../../../runtime/runner/src/cfc/label-view-state.ts";
import { cfcLabelViewForResolvedCellWithStatus } from "../../../runtime/runner/src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { resolveLink } from "../../../runtime/runner/src/link-resolution.ts";
import type { NormalizedFullLink } from "../../../runtime/runner/src/link-types.ts";
import { parseLink } from "../../../runtime/runner/src/link-utils.ts";
import {
  type Cell,
  isStream,
  sendEvent,
} from "../../../runtime/runner/src/cell.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import { type Name, nameText } from "../exec/store.ts";
import { eventSeed, restoreRandom, seedRandom } from "./random.ts";
import {
  type Atom,
  atomKey,
  compareLabels,
  type Comparison,
  type ElementBinding,
  type Evaluated,
  evaluateTemplate,
  type Label,
  namedTemplate,
  type Template,
  type TemplateInputs,
  TRANSFORMED_BY,
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
  /** The reference the written value is, where the body passes one on. */
  reference?: { passes?: number; oneOf?: number[] };
};

/** The members of a plan this harness reads. */
export type Plan = {
  /** The identity of each pattern the plan holds code of (PL §1.1). */
  patterns?: string[];
  slots: {
    root: PlanSlotRoot;
    path: string[];
    observes: string;
    /** The slot observes the reference where resolution ends (PL §2.5). */
    resolved?: true;
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
    name?: Name;
    handler?: { body?: number };
    state?: PlanStateEntry[];
    within?: unknown[];
    /** The schema of the event's declared type, where the plan has it. */
    eventSchema?: string;
  }[];
  bodies?: {
    kind: string;
    name?: Name;
    writes?: PlanWrite[];
    /** The inputs the instance computed (PL §1.1, `Body.computed`). */
    computed?: { observes?: string; template?: Template }[];
  }[];
  operations?: { kind?: string; input?: Template }[];
  /** The templates that a node of `op` `shared` names. */
  templates?: Template[];
  stateCells?: { name: Name; within?: unknown[] }[];
  selectors?: { arity: number }[];
};

/**
 * An input given through a cell of its own, written under `schema`.
 *
 * With `declared`, the cell is written under the schema the compiled
 * pattern's argument has for the input, where it has one, with the clause
 * of `declared` added to the clauses that schema declares at its root. A
 * handler writes an input under the schema of its own type, and the
 * runtime refuses a write that declares fewer clauses at a path than the
 * store declares there, so the store has to declare the runtime's atoms
 * and not the crate's names for them (a `PolicyOf`).
 */
export type LabeledInput = {
  schema: unknown;
  value: unknown;
  declared?: { clause?: unknown };
};

/**
 * What the harness reads of an executor of the compiled path that runs
 * beside today's run (ruling Z43). The plan does not say where the
 * stream of a binding is stored, so the harness takes the positions at
 * which the executor stored the link, and sends an event where today's
 * run holds a stream at one of them.
 */
export type StreamRecord = {
  /** Starts the executor, in the space of today's run. */
  start(space: string): void;
  /**
   * Where the executor's stored result holds the stream of a binding
   * now: the path from the root of the result, and the position of the
   * element of each enclosing collection, outermost first.
   */
  held(binding: number): { path: string[]; elements: number[] }[];
  /** The executor's result, with every link in it followed. */
  result(): unknown;
  /**
   * Has the executor handle an event that today's run committed: the
   * index of the event in the scenario, and the elements it was sent
   * for.
   */
  committed(
    index: number,
    binding: number,
    event: unknown,
    elements: readonly number[],
  ): void;
};

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
  /**
   * The executor's record of where each stream is stored. An event is
   * sent only where the scenario has one.
   */
  streams?: StreamRecord;
  /** What to call at each point of the run (`compare/cost.ts`). */
  probe?: Probe;
};

/** A point of a run that a probe is called at. */
export type ProbePoint =
  /** The runtime exists and nothing was compiled or written. */
  | "created"
  /** The program's files were read and its imports resolved. */
  | "resolved"
  /** The pattern is compiled and evaluated, and nothing was written. */
  | "compiled"
  /** The instance was started and every kept output was read. */
  | "settled"
  /** An event is about to be sent. */
  | "before event"
  /** The event's outcome is known and the result was read again. */
  | "after event";

/**
 * A measurement of a run. The harness awaits `at` at each point and does
 * nothing else with it, so what a probe counts between two points is what
 * the run did between them.
 */
export type Probe = {
  at: (
    point: ProbePoint,
    context: {
      runtime: Runtime;
      storageManager: ReturnType<typeof StorageManager.emulate>;
      space: string;
      /** From `compiled` on: the identifier of the result document. */
      result?: string;
      /** For the points of an event: the index of its binding. */
      binding?: number;
      /** For `after event`: whether the event was committed. */
      outcome?: EventOutcome["outcome"];
    },
  ) => void | Promise<void>;
};

/** One row of the comparison: an output path of one run. */
export type Row = {
  /** The index of the entry in the plan's `outputs`. */
  output: number;
  path: string[];
  runtime: Label;
  /**
   * The template's label as §3.2 gives it, with the atom of the plan's
   * pattern that every kept output carries.
   */
  stored: Evaluated;
  /**
   * The template's label with each `identity` slot joined with the label a
   * value read at the slot's path consumes: what a reader who dereferences
   * the output reaches.
   */
  reached: Evaluated;
  comparison: Comparison;
  /**
   * The template's label without the atom a kept output carries, against
   * the runtime's: what the row was before the atom was added.
   */
  comparisonOfTemplateAlone: Comparison;
  /**
   * The runtime's label read by origin (ruling T2; PL §3.1, "Which entries
   * are the static part"): the entries of each document on the way from the
   * output to its value, without the static part. The static part is the
   * entries of origin `declared` in a document that holds the result of a
   * node, and no entry of another origin: an entry of origin `structure` is
   * the stamp of a run, as a `derived` one is, and is compared. A document
   * a slot is bound in keeps its declared entries, which are the labels of
   * the places a template reads: the argument's own document, a cell the
   * argument links to, and the document of a state cell.
   */
  runtimeByOrigin: { all: Label; withoutStatic: Label };
  /** `reached` against `runtimeByOrigin.withoutStatic`. */
  comparisonWithoutStatic: Comparison;
};

/**
 * One row for a write edge of a handler's body: a path one event's
 * transaction wrote. `template` is the label of §3.2 with no slot
 * dereferenced, since the body writes through its handles and does not
 * read what they hold. Its slots are read on what is stored before the
 * event is sent, which is what the handler's run reads, and the runtime's
 * side is read after the event.
 */
export type WriteRow = {
  binding: number;
  handler: string;
  /** The index of the write in the body's `writes`. */
  write: number;
  /** The path below the target's cell, with each `*` an index. */
  path: string[];
  runtime: Label;
  /**
   * The edge's template beside the label the target's own type declares
   * for the written path, which is stored there on both sides (PL §3.1,
   * "A write edge of a handler"). For an edge with a `reference` member
   * it is joined with what a value read through the stored link consumes.
   *
   * The `identity` slot of a handle the body only passes on, one that no
   * write edge of the body targets, has the stamp of the run that wrote
   * the link and not the entry of origin `link` stored at the position
   * (PL §2.2, "The `link` entry of a handle that is only passed on is not
   * in it"). That entry holds what the schema of the link declares, which
   * for a link to a cell is what the cell's own type declares.
   */
  template: Evaluated;
  comparison: Comparison;
  runtimeByOrigin: { all: Label; withoutStatic: Label };
  comparisonWithoutStatic: Comparison;
  /**
   * Whether the row is looser, or incomparable, by the stamp of a link the
   * body passes on alone: it is not with the label of each such slot left
   * empty. The runtime's transaction reads nothing at the position of a
   * handle that is only passed on, so its join does not hold the stamp
   * (PL §8, question 81).
   */
  looserByLinkStamp: boolean;
  /**
   * Whether the row is tighter by the coordinator's join alone (PL §3.1,
   * "The coordinator's join on an element's argument document"): the
   * handler is bound in an element body, the row is tighter, and every
   * clause the template lacks is held by an entry of origin `structure` or
   * `link` of the argument document of an element's instance on the way
   * to the handler's stream. The harness does not read which of those
   * entries the event's transaction consumed.
   */
  byCoordinatorJoin: boolean;
  /**
   * Whether the row differs by the coordinator's join in confidentiality,
   * as a row of `byCoordinatorJoin` does, and is looser in integrity by
   * the atom of the handler's body alone: the template has no clause and
   * no atom, so its `derive` mints none (PL §3.2, question 66), and the
   * run's label has the join and so the atom.
   */
  noAtomBesideCoordinatorJoin: boolean;
  /** The clauses the runtime's label has and the template's lacks. */
  lacking: Atom[];
};

/** Something the harness did not compare, and why. */
export type Skipped = {
  what: string;
  reason: string;
  /** For an event or a write edge: the binding it is of. */
  binding?: number;
};

/**
 * A kept output the run holds no value at, which is not compared, with
 * what the run has there.
 */
export type Missing = {
  path: string[];
  /** The `op` of the root of the output's template. */
  root: string;
  /** The length of the shortest prefix of the path that has no value. */
  absentFrom: number;
  /** What the value above that prefix is: `object`, `array`, or a type. */
  above: string;
  /** Whether the document the path ends in stores a value at the path. */
  stored: boolean;
  /** The start of what that document stores there, as JSON. */
  raw?: string;
  /** The same for the shortest prefix of the path that has no value. */
  rawAtAbsent?: string;
  /** The same for the path above that prefix. */
  rawAbove?: string;
  /** The label a value read of the path consumes. */
  runtime: Label;
  /** The template's label, where it is evaluated. */
  template?: Label;
  /** Whether the path has a value once it is read on its own. */
  afterPull: boolean;
};

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

/**
 * What became of one event the scenario sent: whether the transaction of
 * the handler's run was committed, and where it was not, the reason the
 * runtime gives.
 */
export type EventOutcome = {
  binding: number;
  handler: string;
  outcome: "committed" | "refused" | "not sent";
  /** The name of the error the transaction ended with. */
  error?: string;
  /** The message of that error, or why the event was not sent. */
  reason?: string;
  /** What the transaction was aborted with: the error a handler threw. */
  aborted?: string;
  /** What failed after the event's outcome, where something did. */
  afterwards?: string;
  /**
   * For a binding of an element body: the element of each enclosing
   * collection the event was sent for, outermost first.
   */
  elements?: ElementBinding[];
  /**
   * For such a binding: the path of the result the stream was read at,
   * with the position of each chosen element in place of its `*`.
   */
  stream?: string[];
  /**
   * For a commit the runtime's CFC refuses: each reason of the refusal,
   * and for a reason its gate describes (`cfc/refusal-detail.ts`), the
   * write it refuses and the reads that carried the clauses it names.
   */
  refusals?: Refusal[];
};

/** One reason of a refused commit. */
export type Refusal = {
  reason: string;
  gate?: string;
  /** The document of the refused write, as the scenario knows it. */
  target?: string;
  path?: string[];
  offending?: string[];
  /** The documents the offending clauses were read from. */
  inputs?: string[];
};

/** The comparison of one run. */
export type Run = {
  rows: Row[];
  writes: WriteRow[];
  events: EventOutcome[];
  skipped: Skipped[];
  decided: Decided;
  missing: Missing[];
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

/**
 * The label view the runtime reads for `cell`: the labels of the document
 * its path is in and of the document its value resolves to. The runtime
 * says where the read failed, as it does at a path whose links are a
 * cycle, and what it returns then is the part it read before the failure.
 * That is no label of the value, so a row that needs it is not compared.
 */
const labelView = (
  cell: AnyCell,
  options?: Parameters<typeof cfcLabelViewForResolvedCellWithStatus>[1],
): CfcLabelView | undefined => {
  const { view, readFailed } = cfcLabelViewForResolvedCellWithStatus(
    cell,
    options,
  );
  if (readFailed) throw new Unsupported("a label the runtime fails to read");
  return view;
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

/**
 * The template of a write edge as evaluated before its event: with the
 * stamp of each handle the body only passes on, and with nothing for it.
 */
type WriteTemplate = { template: Evaluated; withoutStamp: Evaluated };

/** The key of the choices of the template of a write edge. */
const writeKey = (binding: number, write: number): string =>
  `write ${binding}/${write}`;

/** The value of a place the harness could not read. */
const NO_VALUE = Symbol("no value");

/** `value` as text, and `undefined` for a value that has none. */
const snapshot = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const sameValue = (a: unknown, b: unknown): boolean => {
  const text = snapshot(a);
  return text !== undefined && text === snapshot(b);
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
 * The schema `argument` has for the property `name`, as the schema of a
 * cell that holds the value, with `clause` added at its root.
 */
const argumentProperty = (
  argument: JSONSchema | undefined,
  name: string,
  clause: unknown,
): JSONSchema | undefined => {
  if (argument === undefined || typeof argument !== "object") return undefined;
  const { properties, $defs } = argument as {
    properties?: Record<string, JSONSchema>;
    $defs?: Record<string, JSONSchema>;
  };
  const property = properties?.[name];
  if (property === undefined || typeof property !== "object") return undefined;
  // The cell holds the value. Whether the pattern takes the input as a
  // handle is the pattern's own declaration.
  const { asCell: _asCell, ...own } = property as Record<string, unknown> & {
    ifc?: { confidentiality?: unknown[] };
  };
  return {
    ...own,
    ...($defs === undefined ? {} : { $defs }),
    ...(clause === undefined ? {} : {
      ifc: {
        ...own.ifc,
        confidentiality: [...(own.ifc?.confidentiality ?? []), clause],
      },
    }),
  } as JSONSchema;
};

const scenarioSigner = () =>
  Identity.fromPassphrase("pattern-compiler-compare");

/**
 * The atom of the audience of the space every scenario runs in. Every
 * store of the space admits a clause that has it as an alternative: the
 * runtime's writer-fit rule measures a write against the store's declared
 * clauses and the space's own audience (`prepareBoundaryCommit` in
 * `runtime/runner/src/cfc/prepare.ts`, `residencyCeiling`).
 */
export const scenarioAudience = async (): Promise<unknown> =>
  cfcAtom.space((await scenarioSigner()).did());

/**
 * Runs `scenario`, compares every kept output of its plan that has a
 * template, then sends each event and compares the write edges of the
 * handler's body with the labels at the paths the event's run wrote.
 */
export const runScenario = async (scenario: Scenario): Promise<Run> => {
  const signer = await scenarioSigner();
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });
  let resultId: string | undefined;
  const probe = (
    point: ProbePoint,
    detail: { binding?: number; outcome?: EventOutcome["outcome"] } = {},
  ) =>
    scenario.probe?.at(point, {
      runtime,
      storageManager,
      space,
      ...(resultId === undefined ? {} : { result: resultId }),
      ...detail,
    });
  try {
    await probe("created");
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
    await probe("resolved");
    const compiled = await runtime.patternManager.compilePattern(
      program,
      { space },
    );
    if (scenario.probe !== undefined) {
      // The compile stores its cache in the space. A probe counts those
      // documents apart from the documents of the instance.
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
    }
    await probe("compiled");
    const start = runtime.edit();
    // The documents the scenario makes, by identifier.
    const documents = new Map<string, string>();
    const given: Record<string, unknown> = { ...scenario.argument };
    const givenValue: Record<string, unknown> = { ...scenario.argument };
    for (const [name, input] of Object.entries(scenario.inputs ?? {})) {
      const cell = runtime.getCell(
        space,
        { compareInput: name },
        (input.declared === undefined ? undefined : argumentProperty(
          compiled.argumentSchema,
          name,
          input.declared.clause,
        )) ?? input.schema as JSONSchema,
        start,
      );
      cell.set(input.value as never);
      documents.set(cell.getAsNormalizedFullLink().id, `input ${name}`);
      given[name] = cell;
      givenValue[name] = input.value;
    }
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "compare",
      compiled.resultSchema,
      start,
    );
    documents.set(result.getAsNormalizedFullLink().id, "the result");
    resultId = result.getAsNormalizedFullLink().id;
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
    await probe("settled");

    const skipped: Skipped[] = [];
    const missing: Missing[] = [];
    const how = new Map<string, keyof Decided>();
    const selects = new Map<number, SelectNode>();
    const picks = new Map<number, PickNode>();
    for (const output of plan.outputs) {
      indexNodes(output.template, selects, picks);
    }
    // A template that the plan holds once for several positions.
    for (const shared of plan.templates ?? []) {
      indexNodes(shared, selects, picks);
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
    const skip = (what: string, error: unknown, binding?: number) =>
      skipped.push({
        what,
        ...(binding === undefined ? {} : { binding }),
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
      // The instances on the way to the row being read, outermost first,
      // and the `within` of what the row is about. The run of today gives
      // each instance of a pattern a result document of its own: the
      // pattern of the scenario, each run of an element callback, and each
      // pattern at a tag or a call. The `internal` metadata of that
      // document names the cells the instance's body made, a state cell
      // by the name of its declaration (`partialCause`).
      let way: { instances: AnyCell[]; within: unknown[] } = {
        instances: [],
        within: [],
      };
      const manifestOf = (instance: AnyCell) => {
        const manifest = instance.getMetaRaw("internal");
        return (Array.isArray(manifest) ? manifest : []) as unknown as {
          partialCause?: unknown;
          link?: unknown;
        }[];
      };
      const stateCell = (cell: number): AnyCell => {
        const record = plan.stateCells?.[cell];
        if (record === undefined) {
          throw new Unsupported("an unlisted state cell");
        }
        const steps = record.within ?? [];
        // A cell of a body with a `within` step is in the manifest of the
        // instance that step leads to. Where the way has one instance for
        // each step of the row's `within`, that is the instance at the
        // depth of the cell's own steps. Otherwise it is the one instance
        // on the way that names the cell.
        let owners = [output];
        if (steps.length > 0) {
          const naming = way.instances.slice(1).filter((instance) =>
            manifestOf(instance).some((entry) =>
              entry.partialCause === record.name
            )
          );
          const atDepth = way.instances.length === way.within.length + 1 &&
              sameValue(steps, way.within.slice(0, steps.length))
            ? way.instances[steps.length]
            : undefined;
          owners = atDepth !== undefined && naming.includes(atDepth)
            ? [atDepth]
            : naming;
          if (owners.length !== 1) {
            throw new Unsupported(
              "a state cell of a pattern instance the row does not lead to",
            );
          }
        }
        const found = manifestOf(owners[0]).filter((entry) =>
          entry.partialCause === record.name
        );
        const link = found.length === 1
          ? parseLink(found[0].link, owners[0])
          : undefined;
        if (link === undefined) {
          throw new Unsupported(
            "a state cell the run's manifest does not name",
          );
        }
        const made = runtime.getCellFromLink(
          link as NormalizedFullLink,
          undefined,
          read,
        ) as AnyCell;
        stateCellIds.add(made.getAsNormalizedFullLink().id);
        return made;
      };
      // The documents of the state cells the session resolved, whose
      // declared entries are the labels of places a template reads.
      const stateCellIds = new Set<string>();

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
          // "The slot has no stored address: its value is the position of
          // the current element" (PL §2.2). A path of a binding's state
          // that is bound to it has the label of its template.
          case "index":
            return undefined;
          default:
            throw new Unsupported(`a slot of root \`${root.kind}\``);
        }
      };
      // The position the run of today gives a body the handle of its
      // element from: each run of an element callback has an argument
      // document with the element at `element`, a link to the position in
      // the source. The template reads the slot at the position in the
      // source (PL §2.2, "The position of a slot of root `element`"), and
      // takes from here the entry of origin `link` alone, which holds
      // "the label that the declaration of the source collection gives
      // the element" (PL §8, question 85). For a path of a binding's
      // state that is the element itself, the position is returned where
      // the way has one instance for each step of the binding's `within`.
      const elementHeldAt = (
        slot: number,
        context: Context,
      ): AnyCell | undefined => {
        if (plan.slots[slot].root.kind !== "binding") return undefined;
        const { entry, rest } = stateEntry(slot, context);
        if (rest.length > 0 || entry.place?.slot === undefined) {
          return undefined;
        }
        const place = plan.slots[entry.place.slot];
        if (place.root.kind !== "element" || place.path.length > 0) {
          return undefined;
        }
        if (way.instances.length !== way.within.length + 1) return undefined;
        const step = way.within.findIndex((step) =>
          (step as { element?: number }).element === place.root.collection
        );
        const instance = step < 0 ? undefined : way.instances[step + 1];
        const link = instance === undefined
          ? undefined
          : parseLink(instance.getMetaRaw("argument"), instance);
        return link === undefined ? undefined : at(
          runtime.getCellFromLink(
            link as NormalizedFullLink,
            undefined,
            read,
          ) as AnyCell,
          ["element"],
        );
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
          if (root.kind === "index") {
            const binding = context.elements.findLast((element) =>
              element.collection === root.collection
            );
            return binding === undefined ? NO_VALUE : Number(binding.key);
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
        const label = consumed(labelView(cell), observes);
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
      // The documents a slot of a template is bound in, whose declared
      // entries are the labels of those places and are compared (PL §3.1,
      // "Which entries are the static part"): the argument's own, the cell
      // of each input given through a link, and each state cell the
      // manifest names. Every other document on the way from an output to
      // its value holds the result of a node.
      const inputIds = new Set([
        argument.getAsNormalizedFullLink().id,
        ...Object.keys(scenario.inputs ?? {}).flatMap((name) =>
          hops(at(argument, [name])).map((link) => link.id)
        ),
        ...(plan.stateCells ?? []).flatMap((_, cell) => {
          try {
            return [stateCell(cell).getAsNormalizedFullLink().id];
          } catch {
            // A state cell of another instance is found from the row that
            // reads it (`stateCellIds`).
            return [];
          }
        }),
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
          const kept = withStatic || inputIds.has(link.id) ||
              stateCellIds.has(link.id)
            ? metadata
            : {
              ...metadata,
              labelMap: {
                ...metadata.labelMap,
                entries: metadata.labelMap.entries.filter((entry) =>
                  entry.origin !== "declared"
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

      // The label the type of the place declares for the value at `cell`:
      // the entries of origin `declared` in the document that holds the
      // value, at the path and below it.
      const declaredAt = (cell: AnyCell): Label => {
        const link = hops(cell).at(-1);
        const metadata = link === undefined
          ? undefined
          : readStoredCfcMetadata(read, link);
        if (link === undefined || metadata === undefined) {
          return { confidentiality: [], integrity: [] };
        }
        return consumed(
          cfcLabelViewFromMetadata({
            ...metadata,
            labelMap: {
              ...metadata.labelMap,
              entries: metadata.labelMap.entries.filter((entry) =>
                entry.origin === "declared"
              ),
            },
          }, link.path),
          "value",
        );
      };

      // The cell at a path of the result. "The entries of the enclosing
      // rendered tree at the tag's position are those of the callee's
      // `[UI]`" (PL §1.1): where the run holds the result of a pattern at
      // a position and the path goes on with a member of a view node, or
      // ends there, the path is read below the result's `$UI`.
      const VIEW_NODE = new Set(["children", "props", "name", "type"]);
      const treeOf = (cell: AnyCell, next: string | undefined): AnyCell => {
        try {
          const last = hops(cell).at(-1);
          const raw = last === undefined
            ? undefined
            : read.readValueOrThrow(last);
          if (
            raw === null || typeof raw !== "object" || Array.isArray(raw) ||
            !("$UI" in raw) || (raw as { type?: unknown }).type === "vnode"
          ) return cell;
          if (next !== undefined && (!VIEW_NODE.has(next) || next in raw)) {
            return cell;
          }
          return cell.key("$UI" as never) as AnyCell;
        } catch {
          return cell;
        }
      };
      const outputAt = (path: readonly string[]): AnyCell => {
        let cell = output;
        path.forEach((key, index) => {
          if (index > 0) cell = treeOf(cell, key);
          cell = cell.key(key as never) as AnyCell;
        });
        return path.length > 0 && valueOf(cell) === undefined
          ? treeOf(cell, undefined)
          : cell;
      };

      // The instances whose result documents are on the way from the
      // result to `path`, outermost first: each document a link on the way
      // leads to that has an argument or a manifest of its own.
      const instancesAlong = (path: readonly string[]): AnyCell[] => {
        const found: AnyCell[] = [];
        const seen = new Set<string>();
        const visit = (cell: AnyCell) => {
          let links: NormalizedFullLink[] = [];
          try {
            links = hops(cell);
          } catch {
            // A path the run does not hold leads to no instance.
          }
          for (const link of links) {
            if (seen.has(link.id)) continue;
            seen.add(link.id);
            const root = runtime.getCellFromLink(
              { ...link, path: [] } as NormalizedFullLink,
              undefined,
              read,
            ) as AnyCell;
            if (
              root.getMetaRaw("internal") !== undefined ||
              root.getMetaRaw("argument") !== undefined
            ) found.push(root);
          }
        };
        let cell = output;
        visit(cell);
        path.forEach((key, index) => {
          if (index > 0) cell = treeOf(cell, key);
          cell = cell.key(key as never) as AnyCell;
          visit(cell);
        });
        return found;
      };

      // Where the run holds the stream of a binding: the path of the
      // result, and for a binding of an element body the element of each
      // enclosing collection. The executor recorded the positions at
      // which it stored the link (ruling Z43), and the harness takes the
      // first of them at which today's run holds a stream, beginning
      // with the last element of each enclosing collection.
      const streamAt = (
        binding: number,
      ): { path: string[]; elements: ElementBinding[] } => {
        const record = scenario.streams;
        if (record === undefined) {
          throw new Unsupported(
            "a scenario with no record of where a stream is stored",
          );
        }
        const steps = (plan.bindings?.[binding]?.within ?? []).flatMap(
          (step) => {
            const { element } = step as { element?: number };
            return element === undefined ? [] : [element];
          },
        );
        const held = record.held(binding).map((entry, order) => ({
          ...entry,
          order,
        })).sort((a, b) => {
          for (let step = 0; step < a.elements.length; step++) {
            const by = (b.elements[step] ?? -1) - a.elements[step];
            if (by !== 0) return by;
          }
          return a.order - b.order;
        });
        if (held.length === 0) {
          throw new Unsupported(
            "a binding whose stream the executor's result does not hold",
          );
        }
        const stored = record.result();
        for (const { path, elements } of held) {
          const found = inTodaysRun(path, stored);
          if (found === undefined || !isStream(found.cell)) continue;
          return {
            path: found.path,
            elements: elements.map((position, step) => ({
              collection: steps[step],
              key: `${position}`,
            })),
          };
        }
        throw new Unsupported(
          "a stream the run holds at no position the executor stored it at",
        );
      };
      // The position of today's run that a position of the executor's
      // stored result stands for. The two differ in two ways. Today's
      // run holds the result of a pattern at a child position, with its
      // tree under `$UI` (`treeOf`). And the children of a view node are
      // nested differently, as where a `map` over an array written in
      // place runs when today's pattern is built and its elements are
      // children of their own: the child is the one with the same
      // number of children before it, counted with each nested array
      // flat, which is the form the values are compared in.
      const inTodaysRun = (
        path: readonly string[],
        stored: unknown,
      ): { cell: AnyCell; path: string[] } | undefined => {
        const leaves = (value: unknown): number =>
          Array.isArray(value)
            ? value.reduce((sum: number, member) => sum + leaves(member), 0)
            : 1;
        let cell = output;
        let mine = stored;
        const at: string[] = [];
        const step = (key: string) => {
          cell = cell.key(key as never) as AnyCell;
          at.push(key);
        };
        let index = 0;
        while (index < path.length) {
          const key = path[index];
          if (index > 0) {
            const tree = treeOf(cell, key);
            if (tree !== cell) at.push("$UI");
            cell = tree;
          }
          step(key);
          mine = (mine as Record<string, unknown> | undefined)?.[key];
          index += 1;
          if (key !== "children" || !Array.isArray(mine)) continue;
          // The number of children before the one the path names.
          let before = 0;
          while (
            index < path.length && Array.isArray(mine) &&
            /^\d+$/.test(path[index])
          ) {
            const position = Number(path[index]);
            for (let earlier = 0; earlier < position; earlier++) {
              before += leaves(mine[earlier]);
            }
            mine = mine[position];
            index += 1;
          }
          // The child of today's run with that many before it.
          let held = valueOf(cell);
          while (Array.isArray(held)) {
            let position = 0;
            for (; position < held.length; position++) {
              const count = leaves(held[position]);
              if (before < count) break;
              before -= count;
            }
            if (position === held.length) return undefined;
            step(`${position}`);
            held = held[position];
          }
        }
        return { cell, path: at };
      };

      // What the evaluation takes as the label of the `identity` slot of a
      // handle the body only passes on: every `followRef` entry at the
      // position (an output row, which no body of a handler is evaluated
      // for), the entries that are not of origin `link` (a write row, PL
      // §2.2), or nothing (`WriteRow.looserByLinkStamp`).
      let passedHandle: "every entry" | "the stamp" | "nothing" = "every entry";
      // A handle is passed on where its `identity` slot is in the reads of
      // the handler's body and no write edge of the body has the slot as
      // its target. A handle the body writes through is not passed on: the
      // run reads the reference to find the cell it writes.
      const passedOn = (slot: number, binding: number | undefined): boolean => {
        if (binding === undefined) return false;
        const body = plan.bodies
          ?.[plan.bindings?.[binding]?.handler?.body ?? -1];
        const { root, path, resolved } = plan.slots[slot];
        // A slot with `resolved` observes the reference: the run follows
        // the links from it, and consumes what crossing them consumes.
        if (resolved === true) return false;
        const place = JSON.stringify([root, path]);
        return !(body?.writes ?? []).some(({ target }) => {
          if (target.kind !== "handle" || target.slot === undefined) {
            return false;
          }
          const written = plan.slots[target.slot];
          return JSON.stringify([written.root, written.path]) === place;
        });
      };
      // The label of the link stored at `cell`'s path without what the
      // link's own schema declares and what the link carries of its
      // target: the `followRef` entries at the path that are not of origin
      // `link`. An entry of origin `link` holds "what the reference
      // declares and carries" (`prepareBoundaryCommitSteps` in
      // `runtime/runner/src/cfc/prepare.ts`, where it persists the result
      // of `linkLabels.persisted`), and the schema of a link to a cell is
      // the cell's own, so the entry repeats the label the cell's type
      // declares. What is left is the stamp of the run that wrote the link.
      // The restrictions of a link the path crosses part way are not read.
      const linkWithoutDeclaration = (cell: AnyCell): Label => {
        const link = resolveLink(
          runtime,
          read,
          cell.getAsNormalizedFullLink(),
          "top",
        );
        const metadata = readStoredCfcMetadata(read, link);
        if (metadata === undefined) return consumed(undefined, "followRef");
        return consumed(
          cfcLabelViewFromMetadata({
            ...metadata,
            labelMap: {
              ...metadata.labelMap,
              entries: metadata.labelMap.entries.filter((entry) =>
                entry.origin !== "link"
              ),
            },
          }, link.path),
          "followRef",
        );
      };

      // What the entries of origin `link` at `cell`'s path hold: the label
      // the reference stored there declares.
      const linkDeclaration = (cell: AnyCell | undefined): Label => {
        if (cell === undefined) return { confidentiality: [], integrity: [] };
        const link = resolveLink(
          runtime,
          read,
          cell.getAsNormalizedFullLink(),
          "top",
        );
        const metadata = readStoredCfcMetadata(read, link);
        if (metadata === undefined) return consumed(undefined, "followRef");
        return consumed(
          cfcLabelViewFromMetadata({
            ...metadata,
            labelMap: {
              ...metadata.labelMap,
              entries: metadata.labelMap.entries.filter((entry) =>
                entry.origin === "link"
              ),
            },
          }, link.path),
          "followRef",
        );
      };

      // "The label that the declaration of the source collection gives
      // the element" (PL §8, question 85): the entries of origin
      // `declared` in the document that holds the element's position, at
      // the position and above it. An entry below the position is the
      // label of content, which a read through the handle brings in.
      const declaredForElement = (cell: AnyCell): Label => {
        const link = resolveLink(
          runtime,
          read,
          cell.getAsNormalizedFullLink(),
          "top",
        );
        const metadata = readStoredCfcMetadata(read, link);
        if (metadata === undefined) return consumed(undefined, "shape");
        return consumed(
          cfcLabelViewFromMetadata({
            ...metadata,
            labelMap: {
              ...metadata.labelMap,
              entries: metadata.labelMap.entries.filter((entry) =>
                entry.origin === "declared"
              ),
            },
          }, link.path),
          "shape",
        );
      };

      // The clauses of the coordinator's join on the argument documents
      // of the element instances on the way to the row (PL §3.6, "Today,
      // the argument document of an element"): the entries of origin
      // `structure` and `link` of each, at every path.
      const coordinatorClauses = (): Set<string> => {
        const found = new Set<string>();
        if (way.instances.length !== way.within.length + 1) return found;
        way.within.forEach((step, index) => {
          if ((step as { element?: number }).element === undefined) return;
          const instance = way.instances[index + 1];
          const link = parseLink(instance.getMetaRaw("argument"), instance);
          if (link === undefined) return;
          const metadata = readStoredCfcMetadata(
            read,
            link as NormalizedFullLink,
          );
          if (metadata === undefined) return;
          const view = cfcLabelViewFromMetadata({
            ...metadata,
            labelMap: {
              ...metadata.labelMap,
              entries: metadata.labelMap.entries.filter((entry) =>
                entry.origin === "structure" || entry.origin === "link"
              ),
            },
          }, (link as NormalizedFullLink).path);
          for (const entry of view?.entries ?? []) {
            for (const clause of entry.label.confidentiality ?? []) {
              found.add(atomKey(clause));
            }
          }
        });
        return found;
      };

      // Whether `template` is the label of a reference the instance
      // computed, whose target no slot names (PL §3.1, "A reference whose
      // target no slot names"): what a materializer returned, which the
      // crate writes as the template of the materializer's body, or the
      // result of a body that holds an `identity` entry of `Body.computed`.
      // A `select` is one where a branch is, and a `pick` where its body
      // is.
      // The result is `"at"` where the reference is the value at the
      // path, and `"below"` where a body's result holds it at a path the
      // plan does not name.
      const computedReference = (
        template: Template,
      ): "at" | "below" | undefined => {
        switch (template.op) {
          case "derive": {
            if (!("body" in template.by)) return undefined;
            if (
              (plan.operations ?? []).some((operation) =>
                operation.kind === "materializer" &&
                sameValue(namedTemplate(operation.input, plan), template)
              )
            ) return "at";
            const body = plan.bodies?.[template.by.body];
            return (body?.computed ?? []).some((entry) =>
                entry.observes === "identity"
              )
              ? "below"
              : undefined;
          }
          case "select":
            return template.branches.map(computedReference).find((where) =>
              where !== undefined
            );
          case "pick":
            return computedReference(template.body);
          case "output":
          case "shared": {
            const named = namedTemplate(template, plan);
            return named === undefined ? undefined : computedReference(named);
          }
          default:
            return undefined;
        }
      };
      // What a value read through each link stored at `cell`'s path or
      // below it consumes, the entries of the target's own document
      // included. The plan names no address for the target of a computed
      // reference, so the links are found in the stored value, and the
      // harness cannot tell the link of the reference from another link
      // stored below the path.
      const throughStoredLinks = (
        cell: AnyCell,
        where: "at" | "below",
      ): Label[] => {
        if (where === "at") {
          return [consumed(labelView(cell), "value")];
        }
        const last = hops(cell).at(-1);
        if (last === undefined) return [];
        const found: Label[] = [];
        const scan = (value: unknown, path: string[]) => {
          if (value === null || typeof value !== "object") return;
          if (path.length > 0 && parseLink(value, last) !== undefined) {
            found.push(
              consumed(labelView(at(cell, path)), "value"),
            );
            return;
          }
          for (const [key, inner] of Object.entries(value)) {
            scan(inner, [...path, key]);
          }
        };
        scan(read.readValueOrThrow(last), []);
        return found;
      };

      const note = (kind: string, index: number, context: Context) =>
        `${rowKey}|${kind}${index}|${JSON.stringify(context.elements)}`;

      const inputsFor = (
        dereference: boolean,
        scope: Omit<Context, "elements">,
      ): TemplateInputs => {
        const inputs: TemplateInputs = {
          slot: (slot, elements, passed) => {
            const context = { ...scope, elements };
            const { root, observes } = plan.slots[slot];
            // An event is not stored. The label of its slot is the label
            // the event arrived with, and an event the harness sends has
            // none. A label the event's schema declares is not joined to
            // it: `Slot.declared` is no lower bound there (PL §3.12, "The
            // label of an event slot").
            if (root.kind === "event") {
              return { confidentiality: [], integrity: [] };
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
                inputsFor(dereference && (passed ?? false), {}),
                elements,
                {
                  patterns: plan.patterns,
                  outputs: plan.outputs,
                  templates: plan.templates,
                },
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
              // The reference is read at the place the plan gives the
              // slot: for the handle of an element its position in the
              // source collection, and for a captured handle the captured
              // place, with nothing of the argument document of the
              // element's instance (PL §2.2).
              if (
                passedHandle !== "every entry" &&
                passedOn(slot, scope.binding)
              ) {
                return passedHandle === "the stamp"
                  ? linkWithoutDeclaration(cell)
                  : { confidentiality: [], integrity: [] };
              }
              // A handle of an element that the body resolves, or reads
              // or writes through: "the slot's label holds, in the place
              // of that `link` entry, the label that the declaration of
              // the source collection gives the element" (PL §2.2,
              // assumed under question 85).
              const held = passedHandle === "every entry"
                ? undefined
                : elementHeldAt(slot, context);
              const declared = held === undefined
                ? []
                : [linkDeclaration(held), declaredForElement(cell)];
              // The label of the link: what a `followRef` read at the
              // position that holds the reference consumes, and nothing
              // of the document the reference leads to (PL §2.2, "The
              // label of an `identity` slot"). The slot is dereferenced
              // only where it stands for the reference an output passes
              // on (PL §3.1, "What is compared").
              const reference = join([
                consumed(labelView(cell, { lastNode: "top" }), "followRef"),
                ...declared,
              ]);
              return dereference && passed
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
            if (
              current !== undefined &&
              namedTemplate(current.template, plan) === node
            ) {
              const value = valueOf(outputAt(current.path));
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
            if (
              current !== undefined &&
              namedTemplate(current.template, plan) === node &&
              node.branches.length === 2
            ) {
              const value = valueOf(outputAt(current.path));
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
            const membership = namedTemplate(record.membership, plan);
            // The membership a record iterates (PL §3.2). For a `map` it
            // is the record's own, and otherwise that of its source.
            if (
              membership !== undefined &&
              !(membership.op === "fold" &&
                membership.collection === collection)
            ) {
              const evaluated = evaluateTemplate(membership, inputs, elements, {
                patterns: plan.patterns,
                outputs: plan.outputs,
                templates: plan.templates,
              });
              if (evaluated.unsupported.length > 0) {
                throw new Unsupported(
                  `a \`${evaluated.unsupported[0]}\` node`,
                );
              }
              nestedBound ||= evaluated.bound;
              return evaluated.label;
            }
            return consumed(
              labelView(
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
            const stored = current !== undefined &&
                namedTemplate(current.template, plan) === node
              ? valueOf(outputAt(current.path))
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
          indexOf: (slot) => {
            const { root } = plan.slots[slot];
            return root.kind === "index" ? root.collection : undefined;
          },
          // Ruling Y2: "the label of the index is the label of the
          // collection's own array: its length and which link each slot
          // holds. It holds nothing of what the links point to. It is the
          // label of the whole array". That is the membership the
          // collection iterates, and for a collection over a stored slot
          // the entries of class `followRef` at each slot of the array as
          // well. A derived collection has its membership template alone.
          array: (collection, elements) => {
            const membership = inputs.membership(collection, elements);
            const { slot } = plan.collections[collection].source;
            const cell = slot === undefined
              ? undefined
              : slotCell(slot, { ...scope, elements });
            if (cell === undefined) return membership;
            // An entry of origin `link` at a slot holds what the
            // reference declares, which is the label of what the link
            // points to, and is left out.
            const last = hops(cell).at(-1);
            const metadata = last === undefined
              ? undefined
              : readStoredCfcMetadata(read, last);
            if (last === undefined || metadata === undefined) {
              return membership;
            }
            const view = cfcLabelViewFromMetadata({
              ...metadata,
              labelMap: {
                ...metadata.labelMap,
                entries: metadata.labelMap.entries.filter((entry) =>
                  entry.origin !== "link"
                ),
              },
            }, last.path);
            const slots = (view?.entries ?? []).flatMap((entry) =>
              entry.observes === "followRef" && entry.path.length === 1
                ? entry.label.confidentiality ?? []
                : []
            );
            return join([membership, {
              confidentiality: slots,
              integrity: [],
            }]);
          },
          hereditary: (atom) => atomPropagationClass(atom) === "hereditary",
        };
        return inputs;
      };

      const evaluate = (
        template: Template,
        dereference: boolean,
        context: Context,
        kept = false,
      ): Evaluated => {
        nestedBound = false;
        const evaluated = evaluateTemplate(
          template,
          inputsFor(dereference, {
            binding: context.binding,
            event: context.event,
          }),
          context.elements,
          {
            patterns: plan.patterns,
            outputs: plan.outputs,
            templates: plan.templates,
            kept,
          },
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
              way = { instances: instancesAlong(path), within: [] };
              rowKey = `output ${path.join("/")}`;
              // The entry of a collection is the label of its membership,
              // so the runtime's side is what a read of the container's
              // shape consumes, without the elements. The same holds for
              // the container entry of a constructed value, which has an
              // entry per path below it (PL §3.4).
              const observes = entry.collection === undefined && !container
                ? "value"
                : "shape";
              const cell = outputAt(path);
              if (valueOf(cell) === undefined) {
                const absentFrom = path.findIndex((_, index) =>
                  valueOf(outputAt(path.slice(0, index + 1))) === undefined
                );
                const above = valueOf(outputAt(path.slice(0, absentFrom)));
                let stored = false;
                const rawOf = (cell: AnyCell): string => {
                  try {
                    const way = hops(cell);
                    const last = way.at(-1);
                    const value = last === undefined
                      ? undefined
                      : read.readValueOrThrow(last);
                    stored = value !== undefined;
                    return `${way.length} hops: ${
                      JSON.stringify(value)?.slice(0, 200)
                    }`;
                  } catch (error) {
                    stored = false;
                    return `error: ${(error as Error)?.message}`.slice(0, 200);
                  }
                };
                const rawAtAbsent = rawOf(
                  outputAt(path.slice(0, absentFrom + 1)),
                );
                const rawAbove = rawOf(outputAt(path.slice(0, absentFrom)));
                const raw = rawOf(cell);
                let label: Label | undefined;
                try {
                  label = evaluate(template, true, { elements }, true).label;
                } catch {
                  // The template names something the run does not hold.
                }
                missing.push({
                  path,
                  root: namedTemplate(template, plan)?.op ?? "",
                  absentFrom: absentFrom + 1,
                  above: Array.isArray(above)
                    ? "array"
                    : above === NO_VALUE
                    ? "unreadable"
                    : above === null
                    ? "null"
                    : typeof above,
                  stored,
                  raw,
                  rawAtAbsent,
                  rawAbove,
                  runtime: consumed(
                    cfcLabelViewForResolvedCellWithStatus(cell).view,
                    "value",
                  ),
                  template: label,
                  afterPull: false,
                });
                throw new Unsupported("an output the run holds no value at");
              }
              const runtimeLabel = consumed(
                labelView(cell),
                observes,
              );
              // A kept output carries the atom of the plan's pattern (PL
              // §3.2). Where the output passes a value on by reference
              // the atom is on the link, and the row holds it beside the
              // integrity of the dereferenced value (PL §3.1, "An atom on
              // a link").
              const stored = evaluate(template, false, { elements }, true);
              // "The template's side is joined with what a value read
              // through the link stored at the runtime's output path
              // consumes ... Both sides then read one target" (PL §3.1,
              // "A reference whose target no slot names").
              const where = computedReference(template);
              const target = where === undefined
                ? []
                : throughStoredLinks(cell, where);
              const reading = (kept: boolean): Evaluated => {
                const evaluated = evaluate(template, true, { elements }, kept);
                return target.length === 0 ? evaluated : {
                  ...evaluated,
                  label: join([evaluated.label, ...target]),
                };
              };
              const reached = reading(true);
              const withoutStatic = byOrigin(cell, observes, false);
              rows.push({
                output: number,
                path,
                runtime: runtimeLabel,
                stored,
                reached,
                comparison: compareLabels(reached.label, runtimeLabel),
                comparisonOfTemplateAlone: compareLabels(
                  reading(false).label,
                  runtimeLabel,
                ),
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

      // The number of links stored on the way from `cell`'s path to its
      // value, and the address of the path. A path that cannot be read
      // has none.
      const linksAt = (
        cell: AnyCell,
      ): { key: string; links: number } | undefined => {
        try {
          const way = hops(cell);
          return {
            key: `${way[0].id}/${JSON.stringify(way[0].path)}`,
            links: way.length - 1,
          };
        } catch {
          return undefined;
        }
      };

      // The cell each write edge of a body targets, with the path below
      // it up to the first `*`, and the rest of the path.
      const writeTargets = (
        binding: number,
        elements: readonly ElementBinding[],
        stream: readonly string[],
      ) => {
        way = {
          instances: instancesAlong(stream),
          within: plan.bindings?.[binding]?.within ?? [],
        };
        const body = plan.bodies
          ?.[plan.bindings?.[binding]?.handler?.body ?? -1];
        return (body?.writes ?? []).map((write, index) => {
          try {
            const { target } = write;
            const path = target.path ?? [];
            const star = path.indexOf("*");
            const above = star < 0 ? path : path.slice(0, star);
            const context = { elements, binding };
            let base: AnyCell | undefined;
            if (target.kind === "handle" && target.slot !== undefined) {
              base = slotCell(target.slot, context);
              // A send to the stream of another binding stores nothing at
              // the target: what that binding's handler writes is the
              // write of another event.
              if (
                base === undefined &&
                plan.slots[target.slot].root.kind === "binding" &&
                (stateEntry(target.slot, context).entry.place as {
                    stream?: number;
                  } | undefined)?.stream !== undefined
              ) {
                throw new Unsupported(
                  "a write edge whose target is the stream of a binding",
                );
              }
            } else if (target.kind === "state" && target.cell !== undefined) {
              base = stateCell(target.cell);
            }
            if (base === undefined) {
              throw new Unsupported(
                `a write target of kind \`${target.kind}\` with no stored cell`,
              );
            }
            const cell = at(base, above);
            // What the cell holds is read here, as text and as a number
            // of elements: the value of an array or an object is a view
            // of the cell, which shows what a later transaction wrote.
            const value = valueOf(cell);
            return {
              write,
              index,
              cell,
              links: linksAt(cell),
              held: snapshot(value),
              length: Array.isArray(value) ? value.length : undefined,
              below: star < 0 ? undefined : path.slice(star + 1),
            };
          } catch (error) {
            return { write, index, error };
          }
        });
      };

      // The template of each write edge of a body, evaluated on what is
      // stored when it is called. The harness calls it before it sends the
      // event: the handler's run reads what is stored when its transaction
      // begins, and a slot of a cell the run writes has the label of the
      // run's own write afterwards, which would stand in for a read the
      // template lacks. The key of a choice names the edge and no path,
      // since the paths the run writes are not known yet.
      const writeTemplates = (
        binding: number,
        event: unknown,
        elements: readonly ElementBinding[],
        stream: readonly string[],
      ): (WriteTemplate | { error: unknown })[] => {
        way = {
          instances: instancesAlong(stream),
          within: plan.bindings?.[binding]?.within ?? [],
        };
        const body = plan.bodies
          ?.[plan.bindings?.[binding]?.handler?.body ?? -1];
        return (body?.writes ?? []).map((write, index) => {
          const { template } = write;
          try {
            if (template === undefined) {
              throw new Unsupported("a write edge with no template");
            }
            rowKey = writeKey(binding, index);
            const withHandle = (handle: typeof passedHandle) => {
              passedHandle = handle;
              return evaluate(template, false, { elements, binding, event });
            };
            return {
              template: withHandle("the stamp"),
              withoutStamp: withHandle("nothing"),
            };
          } catch (error) {
            return { error };
          } finally {
            passedHandle = "every entry";
          }
        });
      };

      const writeRow = (
        binding: number,
        write: PlanWrite,
        index: number,
        cell: AnyCell,
        path: string[],
        stream: readonly string[],
        evaluated: WriteTemplate,
      ): WriteRow => {
        way = {
          instances: instancesAlong(stream),
          within: plan.bindings?.[binding]?.within ?? [],
        };
        rowKey = `write ${binding}/${index}/${path.join("/")}`;
        const runtimeLabel = consumed(
          labelView(cell),
          "value",
        );
        // "The template's side is the edge's template, beside the label
        // that the target's own type declares for the written path, which
        // is stored there on both sides" (PL §3.1, "A write edge of a
        // handler"). An edge whose written value is a reference the body
        // passes on is joined with what a value read through the stored
        // link consumes, so that both sides read one target.
        const beside = [
          declaredAt(cell),
          ...(write.reference === undefined ? [] : [runtimeLabel]),
        ];
        const side = (evaluated: Evaluated): Evaluated => {
          const label = join([evaluated.label, ...beside]);
          // The template of such an edge is the label of the link. Its
          // integrity vouches for the reference, and a read of the value
          // through the link has the integrity of the target alone, as it
          // has with a stored `followRef` entry (`consumed`).
          return {
            ...evaluated,
            label: write.reference === undefined
              ? label
              : { ...label, integrity: runtimeLabel.integrity },
          };
        };
        const template = side(evaluated.template);
        const withoutStamp = side(evaluated.withoutStamp);
        const comparison = compareLabels(template.label, runtimeLabel);
        const worse = (relation: string) =>
          relation === "looser" || relation === "incomparable";
        const withoutStatic = byOrigin(cell, "value", false);
        // The clauses the runtime's label has and the template lacks.
        const has = new Set(template.label.confidentiality.map(atomKey));
        const lacking = [
          ...new Map(
            runtimeLabel.confidentiality.map((clause) => [
              atomKey(clause),
              clause,
            ]),
          ),
        ].filter(([key]) => !has.has(key));
        const coordinator = coordinatorClauses();
        const byJoin = comparison.confidentiality === "tighter" &&
          lacking.every(([key]) => coordinator.has(key));
        const integrity = template.label.integrity === "neutral"
          ? []
          : template.label.integrity;
        const unminted = template.label.confidentiality.length === 0 &&
          integrity.length === 0 && comparison.integrity === "looser" &&
          compareLabels({
              ...template.label,
              integrity: [{
                type: TRANSFORMED_BY,
                identity: {
                  kind: "body",
                  body: plan.bindings?.[binding]?.handler?.body,
                },
              }],
            }, runtimeLabel).integrity === "equal";
        return {
          binding,
          handler: nameText(plan.bindings?.[binding]?.name ?? ""),
          write: index,
          path,
          runtime: runtimeLabel,
          template,
          comparison,
          runtimeByOrigin: {
            all: byOrigin(cell, "value", true),
            withoutStatic,
          },
          comparisonWithoutStatic: compareLabels(
            template.label,
            withoutStatic,
          ),
          looserByLinkStamp: worse(comparison.overall) &&
            !worse(compareLabels(withoutStamp.label, runtimeLabel).overall),
          byCoordinatorJoin: byJoin && comparison.overall === "tighter",
          noAtomBesideCoordinatorJoin: byJoin && unminted,
          lacking: lacking.map(([, clause]) => clause),
        };
      };

      return {
        outputRows,
        writeTargets,
        writeTemplates,
        writeRow,
        streamAt,
        linksAt,
        at,
        read,
      };
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
    scenario.streams?.start(space);

    const writes: WriteRow[] = [];
    const events: EventOutcome[] = [];
    // The fewest links the harness saw stored at the path of each write
    // target: what the path holds where no run stored a link there.
    const fewest = new Map<string, number>();
    for (
      const [sent, { binding, event }] of (scenario.events ?? []).entries()
    ) {
      // A handler that draws from `Math.random` draws what the executor
      // draws for the same event (`random.ts`).
      seedRandom(eventSeed(sent));
      const record = plan.bindings?.[binding];
      const name = `event of ${
        record?.name === undefined ? binding : nameText(record.name)
      }`;
      const inElement = (record?.within ?? []).some((step) =>
        (step as { element?: number }).element !== undefined
      );
      let found: { path: string[]; elements: ElementBinding[] };
      try {
        found = await reading((within) => within.streamAt(binding));
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        skipped.push({ what: name, reason: error.reason, binding });
        events.push({
          binding,
          handler: nameText(record?.name ?? ""),
          outcome: "not sent",
          reason: error.reason,
        });
        continue;
      }
      const { elements } = found;
      const sentFor = inElement ? { elements, stream: found.path } : {};
      const { before, templates } = await reading((within) => ({
        before: within.writeTargets(binding, elements, found.path),
        templates: within.writeTemplates(
          binding,
          event,
          elements,
          found.path,
        ),
      }));
      const stream = found.path.reduce(
        (cell, key) => cell.key(key as never) as AnyCell,
        result as AnyCell,
      );
      // The runtime calls the callback once with the transaction of the
      // event's final outcome, also for an event it drops before a
      // handler runs.
      const settled = Promise.withResolvers<EventOutcome>();
      await probe("before event", { binding });
      sendEvent(stream, event as never, (tx) => {
        const status = tx.status();
        const handler = nameText(record?.name ?? "");
        if (status.status === "error") {
          const { name, message, reasons, refusals, reason: aborted } = status
            .error as {
              name?: string;
              message?: string;
              // What `abort` was called with: the error a handler threw.
              reason?: unknown;
              reasons?: readonly string[];
              refusals?: readonly {
                gate: string;
                target?: {
                  space: string;
                  id: string;
                  path: readonly string[];
                };
                offendingAtoms: readonly string[];
                inputs: readonly { read: { space: string; id: string } }[];
                reason: string;
              }[];
            };
          const known = (address: { space: string; id: string }) =>
            address.space !== space
              ? "a document of another space"
              : documents.get(address.id) ??
                "a document the scenario did not make";
          settled.resolve({
            binding,
            handler,
            outcome: "refused",
            ...sentFor,
            error: name,
            reason: message,
            ...(aborted === undefined ? {} : {
              aborted: aborted instanceof Error
                ? `${aborted.name}: ${aborted.message}`
                : `${aborted}`,
            }),
            ...(reasons === undefined ? {} : {
              refusals: reasons.map((reason) => {
                const detail = refusals?.find((entry) =>
                  entry.reason === reason
                );
                return detail === undefined ? { reason } : {
                  reason,
                  gate: detail.gate,
                  ...(detail.target === undefined ? {} : {
                    target: known(detail.target),
                    path: [...detail.target.path],
                  }),
                  offending: [...detail.offendingAtoms],
                  inputs: [
                    ...new Set(
                      detail.inputs.map((input) => known(input.read)),
                    ),
                  ],
                };
              }),
            }),
          });
        } else {
          settled.resolve({
            binding,
            handler,
            outcome: "committed",
            ...sentFor,
          });
        }
      });
      const outcome = await settled.promise;
      events.push(outcome);
      await runtime.idle();
      // The result is read again so that what the event's run changed is
      // computed. A read the runtime fails is recorded with the event,
      // and the write edges are compared on what is stored.
      try {
        await result.pull();
      } catch (error) {
        outcome.afterwards = `the read of the result fails: ${
          (error as Error)?.message ?? error
        }`.split("\n")[0].slice(0, 160);
      }
      await runtime.idle();
      if (scenario.probe !== undefined) await storageManager.synced();
      await probe("after event", { binding, outcome: outcome.outcome });
      await reading((within) => {
        const after = within.writeTargets(binding, elements, found.path);
        after.forEach((target, index) => {
          const what = `${name}, write ${index}`;
          const earlier = before[index];
          if ("error" in target || "error" in earlier) {
            skip(
              what,
              "error" in target ? target.error : earlier.error,
              binding,
            );
            return;
          }
          // An event whose transaction was not committed wrote nothing. A
          // target that holds no value before and after it, or one the
          // harness cannot read, is no sign of a write.
          if (outcome.outcome !== "committed") {
            skipped.push({
              what,
              reason: "a write edge of an event not committed",
              binding,
            });
            return;
          }
          // The paths the event's run wrote: a target whose value changed,
          // and for an element target the elements it added.
          // A target that holds a link where it held a value is written
          // too, also where the value read through the link is equal.
          const paths: string[][] = [];
          if (target.links !== undefined) {
            fewest.set(
              target.links.key,
              Math.min(
                fewest.get(target.links.key) ?? Infinity,
                earlier.links?.links ?? Infinity,
                target.links.links,
              ),
            );
          }
          const linked = target.links !== undefined &&
            target.links.links > (earlier.links?.links ?? Infinity);
          if (target.below === undefined) {
            if (
              earlier.held === undefined || earlier.held !== target.held ||
              linked
            ) {
              paths.push([]);
            }
          } else if (target.length !== undefined) {
            for (let at = earlier.length ?? 0; at < target.length; at++) {
              paths.push([`${at}`, ...target.below]);
            }
          }
          if (paths.length === 0) {
            skipped.push({
              what,
              reason: "a write the event's run did not make",
              binding,
            });
            // The choices of a template that is compared with nothing are
            // not counted.
            for (const key of [...how.keys()]) {
              if (key.startsWith(`${writeKey(binding, index)}|`)) {
                how.delete(key);
              }
            }
          }
          for (const path of paths) {
            try {
              const evaluated = templates[index];
              if ("error" in evaluated) throw evaluated.error;
              const row = within.writeRow(
                binding,
                target.write,
                index,
                within.at(target.cell, path),
                path,
                found.path,
                evaluated,
              );
              // "A written path that holds a link, for an edge with no
              // `reference`" (PL §3.1): the target holds more links than
              // the fewest the harness saw there. An element the run
              // added is stored through a link of its own, so a path
              // below the target is not decided this way.
              const fewer = fewest.get(target.links?.key ?? "");
              if (
                target.write.reference === undefined && path.length === 0 &&
                target.links !== undefined && fewer !== undefined &&
                target.links.links > fewer
              ) {
                throw new Unsupported(
                  "a written path that holds a link, for an edge with no `reference`",
                );
              }
              writes.push(row);
            } catch (error) {
              skip(`${what}, ${path.join("/")}`, error, binding);
            }
          }
        });
      });
      // The executor handles what today's run committed, so that its
      // record is that of the same events when the next one is sent.
      if (outcome.outcome === "committed") {
        scenario.streams?.committed(
          sent,
          binding,
          event,
          elements.map(({ key }) => Number(key)),
        );
      }
    }
    restoreRandom();

    // Whether an output with no value has one once it is read on its own:
    // the first read of the outputs reads a path up to its first `*`.
    for (const entry of missing) {
      try {
        const cell = entry.path.reduce(
          (cell, key) => cell.key(key as never) as AnyCell,
          result as AnyCell,
        );
        await cell.pull();
        await runtime.idle();
        entry.afterPull = await reading((within) => {
          try {
            return within.at(result.withTx(within.read) as AnyCell, entry.path)
              .get() !== undefined;
          } catch {
            return false;
          }
        });
      } catch {
        // A path that cannot be read has no value.
      }
    }

    const decided: Decided = {
      byValue: 0,
      byCondition: 0,
      stated: 0,
      unobserved: 0,
    };
    for (const by of how.values()) decided[by]++;
    return { rows, writes, events, skipped, decided, missing };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** Compares every kept output of `scenario.plan` that has a template. */
export const compareScenario = async (scenario: Scenario): Promise<Row[]> =>
  (await runScenario(scenario)).rows;
