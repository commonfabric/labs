/**
 * The render gate on the publish path: what a pattern's own `$UI` has to do
 * before the pattern is contributed to the index.
 *
 * Recording and surfacing are separate: a pattern that fails this gate is
 * still queued for publication in full. Once the index accepts it, it
 * resolves for `getPattern` and for a `cf:pattern:` import. What the gate
 * decides is whether to request that search offer it.
 *
 * ## What it certifies, and what it cannot
 *
 * A run validates its result against the caller's `resultSchema` and nothing
 * renders. So a pattern whose computation is right and whose rendering is
 * garbage is, to everything downstream, a pattern that works — it publishes,
 * it ranks, and a later run that composes it inherits the defect. This module
 * adds one checkable property to the publish decision: **the pattern's `$UI`,
 * rendered host-side against a synthetic instance of the pattern's own
 * argument schema, produced element content carrying no default-`toString`
 * text**. That property is real and worth having. It is not "the component
 * works", it is not "the component is usable", and no comment, message or
 * field here may be read as claiming either. Defects that appear only for
 * real data shapes, for a second synthetic instance, or after an interaction
 * are all outside what a single host-side render can see.
 *
 * ## Why a probe, and what a probe does and does not settle about CFC
 *
 * The gate renders a **probe**: a second, detached instance of the same
 * compiled pattern, built from `syntheticArgument` rather than from the run's
 * own inputs. The run's own piece is never rendered.
 *
 * What that settles: no labeled data reaches the probe **through its
 * arguments**, because its arguments are a function of the schema alone.
 * Under a `persist`/`enforce-explicit` posture that is the difference between
 * a render that is a new read of the caller's confidential data and one that
 * is not.
 *
 * What it does NOT settle: a pattern body can reach the space for itself —
 * `wish()` is the plain case, and a link the body constructs is another — and
 * the probe runs in the run's own space. A pattern that does so reads labeled
 * data whatever its arguments were, and the bounded HTML this gate keeps can
 * hold it. That HTML goes to the run artifact rather than to the tool result,
 * and the artifact is the boundary that already holds this run's `rawValue` —
 * the real piece's entire unsanitized result. So the probe adds no sink class
 * the publish path did not already have, and strictly less data than the
 * artifact beside it. It is not "CFC-neutral by construction"; it is neutral
 * on the argument path and equal to the existing artifact boundary on the
 * space-read path.
 *
 * And "the artifact" is not a boundary the model cannot cross. `read_file`,
 * `write_file`, `edit_file` and `view_image` reserve the artifact root
 * (`tools/reserved-artifacts.ts`); `bash` does not, and its stdout is
 * model-facing, so a run that lists and cats its own tool-output JSON reads
 * this HTML back. That route predates this gate and carries strictly more
 * through it — `rawValue` and every withheld thrown message travel the same
 * way — so it is a property of the artifact root, not of the probe. What is
 * true, and all that is claimed, is that nothing derived from the DOM is put
 * into the tool result the prompt loop hands the model.
 *
 * ## Why the verdict is a closed enumeration
 *
 * Nothing derived from the rendered DOM crosses to the model. What crosses is
 * the `queued` status, a `PatternPublicationReason`, one constant
 * message drawn from `PATTERN_PUBLICATION_MESSAGES`, and a boolean about the
 * synthetic instance — every one of them pinned to a fixed set, which is the
 * `schemaAllowsRawString` rule applied by construction rather than checked.
 * No count, no excerpt, no tag name, no input value.
 *
 * Two independent reasons, and the second survives the first:
 *
 * 1. Under CFC, an error message quoting rendered content is an egress of
 *    whatever that content held, through a sink nobody declared.
 * 2. Source the model authored may `cf:pattern:` import indexed patterns the
 *    model has never seen, so a probe's DOM can carry text from source that
 *    is withheld from it on grounds that have nothing to do with labels.
 *    `run-pattern.ts` already withholds compile text, thrown text and refusal
 *    text on exactly that ground; the gate follows the rule the file has
 *    rather than inventing a second one.
 *
 * The residual channel is the verdict itself: one of a fixed handful of codes
 * per publishing run, over source the model wrote. That is named here rather
 * than argued away.
 */

import type { JSONSchema } from "@commonfabric/api";

import type { Cell } from "@commonfabric/runner";
import { UI } from "@commonfabric/runner/shared";
import { uiSchema } from "@commonfabric/runner/schemas";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { renderInProcess } from "@commonfabric/html/in-process";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * The requested discoverability of a publication, before the index receives
 * it. `discoverable` requests search visibility; `recorded` requests a record
 * without search visibility. The render gate permits the former when it
 * passes or there is no `$UI`, and publication policy may restrict it to the
 * latter. Neither value confirms that the index accepted the publication.
 */
export type PatternPublicationStatus = "discoverable" | "recorded";

/**
 * Why a publication requests its discoverability, as a fixed set of codes.
 *
 * This is the whole of what the gate tells the model, and it is a closed
 * enumeration on purpose — see the module comment for why nothing
 * derived from the rendered DOM may join it.
 */
export type PatternPublicationReason =
  /** The run requests a record without asking search to surface it. */
  | "recorded-automatically"
  /** The probe rendered element content carrying no default-`toString` text. */
  | "ui-rendered"
  /**
   * The pattern's result declares no `$UI`, so there was nothing to render.
   *
   * This code exists to be QUERIED, not only to explain one decision. A
   * doubler with no UI and an entry promising "a reading list with toggles
   * and live counts" that has no UI at all are the same fact to this gate,
   * and telling them apart needs the description read against the program —
   * judgement rather than structure, and outside what a render can settle.
   * Recording it distinctly means whoever builds that check can enumerate
   * exactly these entries from the index against real data, rather than
   * re-deriving the set.
   */
  | "no-ui"
  /** The probe's rendered output carried `[object Object]` or a sibling. */
  | "ui-default-tostring"
  /**
   * The pattern declares a `$UI` that rendered a tree carrying nothing — no
   * text and no attributes. See `classifyRenderedHtml` for why that is the
   * test rather than text alone.
   */
  | "ui-rendered-empty"
  /**
   * The probe could not be started, did not settle, or the reconciler
   * reported an error, so no complete tree was read.
   */
  | "probe-failed"
  /**
   * A later iteration of the same capability, in the same session, is what
   * search offers. Decided by the publication ledger rather than by a render.
   */
  | "superseded";

/**
 * What the gate learned, in full. `status` controls requested discoverability;
 * the tool reports `queued` with the reason and `syntheticInputsComplete`.
 */
export interface PatternRenderVerdict {
  readonly status: PatternPublicationStatus;
  readonly reason: PatternPublicationReason;

  /**
   * Whether the synthetic argument below was generated in full, or stopped at
   * a bound. A render driven by a partial instance is weaker evidence, and
   * the two facts are reported side by side rather than folded into one code,
   * so neither drifts into the other.
   */
  readonly syntheticInputsComplete: boolean;

  /**
   * What a probe THREW, when one did. Artifact-only, on the same terms as
   * every other thrown message this tool withholds: a computation over data
   * the model cannot read can carry that data in what it throws.
   *
   * The rendered DOM is deliberately NOT here and is not persisted anywhere.
   * The artifact root is not a confidentiality boundary — `bash` does not
   * reserve it the way the file tools do, and two reviewers have walked that
   * route, one with a planted marker — so the only defensible amount of
   * rendered content to put in it is none.
   *
   * What that costs, stated rather than argued away. For a pattern whose view
   * is a function of its arguments, nothing: the synthetic instance is
   * deterministic and the index records the program, so an adjudicator
   * reproduces the exact render instead of reading a copy. For a pattern that
   * reaches the space for itself — `wish()` is the plain case — the render is
   * NOT reproducible, because the state it read is not recorded anywhere the
   * index can reach. For those entries the verdict and its reason are all
   * that survives, and that is the price of the artifact root not being a
   * boundary. It is the same class of pattern that made the probe's CFC
   * neutrality hold only on the argument path.
   */
  readonly thrown?: string;
}

/**
 * What each reason tells the model, drawn from here and never composed. Every
 * one of these is a constant: no count, no excerpt, and no name taken from
 * the pattern, its inputs, or its rendered output appears in any of them.
 */
export const PATTERN_PUBLICATION_MESSAGES: Readonly<
  Record<PatternPublicationReason, string>
> = {
  "recorded-automatically":
    "queued for recording in the pattern index without requesting search discoverability; publication is not confirmed. Discoverability is earned from later evidence.",
  "ui-rendered":
    "queued for publication to the pattern index with search discoverability requested; publication is not confirmed. Its $UI was rendered host-side against a synthetic instance of its own argument schema and produced text with no default-toString in it. That is all this certifies — not that the component works.",
  "no-ui":
    "queued for publication to the pattern index with search discoverability requested; publication is not confirmed. It declares no $UI, so the render check does not apply to it.",
  "ui-default-tostring":
    "queued for recording in the pattern index without requesting search discoverability; publication is not confirmed. Rendering its $UI host-side produced text of the form [object Object] — a value reaching the DOM through Object.prototype.toString rather than through a read. Indexing a reactive row by a reactive key is the usual cause: the index expression yields a proxy, and stringifying a proxy gives exactly this. Read the value out (a derive or a lift over the row and the key) and run it again to check the fixed version. The render itself is not retained anywhere. For a pattern whose view is a function of its arguments it can be reproduced once publication succeeds — the synthetic instance is deterministic and the index holds the program — and for a pattern that reads the space it cannot, since that state is not recorded. Either way the verdict above is what is kept.",
  "ui-rendered-empty":
    "queued for recording in the pattern index without requesting search discoverability; publication is not confirmed. Its $UI rendered a tree carrying no text and no attributes at all, against a synthetic instance of its own argument schema. That is an absence of evidence rather than a defect found — an empty-state list renders this way too — so the entry is uncertified rather than condemned.",
  "probe-failed":
    "queued for recording in the pattern index without requesting search discoverability; publication is not confirmed. A second instance of the pattern, built from synthetic inputs, could not be started, did not settle, or errored while rendering, so nothing was rendered and nothing was checked. The entry is uncertified rather than condemned.",
  "superseded":
    "queued for recording in the pattern index without requesting search discoverability; publication is not confirmed. A later iteration in this session was staged under the same description and hashtags, and that one is the session's retained candidate.",
};

/**
 * Why an entry is not offered to search, as the index stores it and as a
 * person reads it later when deciding whether to promote it.
 *
 * One constant per verdict, on the same terms as the model-facing messages
 * and for a stronger reason: this string leaves the process. It names what
 * was observed as a CLASS — `[object Object]` here is the literal spelling of
 * the defect, not a quotation from any rendered output. Nothing from the
 * probe's DOM, the pattern's inputs, or the run's data may be composed into
 * one of these.
 */
export const PATTERN_DISCOVERABILITY_REASONS: Readonly<
  Record<PatternPublicationReason, string>
> = {
  "recorded-automatically":
    "recorded automatically; discoverability is earned by evidence",
  "ui-rendered": "render gate: passed",
  "no-ui": "render gate: not applicable, the pattern declares no $UI",
  "ui-default-tostring":
    "render gate: the $UI rendered [object Object] against a synthetic instance of the pattern's own argument schema — a value reaching the DOM through Object.prototype.toString rather than through a read",
  "ui-rendered-empty":
    "render gate: no verdict — the $UI rendered a tree carrying no text and no attributes against a synthetic instance of the pattern's own argument schema, which an empty-state list also does",
  "probe-failed":
    "render gate: no verdict — a synthetic-input probe could not be started, did not settle, or errored while rendering",
  "superseded":
    "superseded by a later iteration of the same capability in the same authoring session",
};

/**
 * How many rendered nodes are read before the tree is cut down to size.
 *
 * Serializing first and truncating after would build the whole string in
 * memory, and what a pattern renders is bounded by nothing but the pattern.
 * So the tree is counted first and its excess children dropped before it is
 * serialized. The cost is stated rather than hidden: a marker past the cut is
 * not seen, so a cut tree is reported as truncated and the verdict it carries
 * is the verdict for the part that was read.
 */
export const PROBE_MAX_NODES = 4000;

/**
 * Text `Object.prototype.toString` produces, wherever it reaches the rendered
 * output. Matching the whole family rather than `[object Object]` alone is
 * deliberate: the defect is a value stringified by the default `toString`,
 * and which internal class it names is incidental to that.
 *
 * Nothing the framework itself renders takes this shape. The confidentiality
 * seal is the value worth checking against, since a sealed position is a
 * plain `{"@link": ...}` object that would stringify to `[object Object]` —
 * but sealing is applied by `validateAndSanitizeStructuredResult` at the
 * model boundary and by nothing in the render path (`cfcOpaqueLinkForPath`
 * has two call sites, both in `runner/src/cfc/structured-result.ts`), so a
 * sealed value never reaches a DOM. A `[object …]` in rendered output is
 * therefore a pattern stringifying something it should have read.
 */
const DEFAULT_TO_STRING = /\[object [A-Z][A-Za-z]*\]/;

/** How deep the synthetic generator walks before it stops and says so. */
const SYNTHETIC_MAX_DEPTH = 6;

/**
 * How many schema nodes the synthetic generator visits before it stops. Depth
 * alone does not bound a schema whose `$defs` refer to each other in a cycle
 * that branches, so a node budget sits beside the depth stop.
 */
const SYNTHETIC_NODE_BUDGET = 256;

/**
 * How many items an array gets, and how many keys an open object gets. One
 * item cannot distinguish a renderer that maps from one that renders its
 * first element, and the live defect this gate exists for — a table indexing
 * a reactive row by a reactive key — needs a row to index at all.
 */
const SYNTHETIC_ARRAY_LENGTH = 2;

/**
 * The vocabulary every synthetic string is drawn from, by SLOT: an array item
 * takes the name at its own index, an object property takes the name at its
 * ordinal, and the keys given to an object whose shape is open take the first
 * names in order.
 *
 * Sharing one vocabulary between values and keys is deliberate, and it is
 * what makes the instance exercise a renderer rather than merely satisfy the
 * schema. A schema carrying both a bag-of-fields object and a list of free
 * strings — `rows: Row[]`, `columns: string[]` — almost always means the
 * strings index the fields; drawing both from the same names means the lookup
 * finds something instead of finding nothing. Generated from two vocabularies
 * the table renders two empty cells and passes, which is how the defect this
 * gate exists for reached the index in the first place.
 */
const SYNTHETIC_NAMES = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
] as const;

const syntheticName = (slot: number): string =>
  SYNTHETIC_NAMES[slot % SYNTHETIC_NAMES.length];

interface SyntheticInstance {
  readonly value: unknown;

  /**
   * Whether the walk finished. `false` means a depth stop, an exhausted node
   * budget, an array with no `items`, or a schema that declares no shape —
   * in every case the instance is thinner than the schema admits, and a
   * render that produced nothing is not evidence about the pattern.
   */
  readonly complete: boolean;
}

const schemaObject = (schema: JSONSchema | undefined) =>
  isObjectNotArray(schema) ? schema as Record<string, unknown> : undefined;

/**
 * A sample value conforming to `schema`, for driving a pattern's own UI.
 *
 * Deterministic, and shaped to exercise a renderer rather than to be minimal:
 * every declared property is filled in whether or not it is required, arrays
 * get {@link SYNTHETIC_ARRAY_LENGTH} items, and strings and numbers vary
 * across positions so a UI that renders them is distinguishable from one that
 * renders nothing. Nothing here reads the space or the run's own inputs: the
 * instance is a function of the schema alone.
 *
 * `false` — a pattern that takes no arguments — yields `{}`, and that is
 * complete: there is nothing else the pattern could have been given. `true`,
 * or an absent schema, also yields `{}` but is NOT complete, since a schema
 * that declares no shape says nothing about what would have exercised it.
 */
export const syntheticArgument = (
  schema: JSONSchema | undefined,
): SyntheticInstance => {
  if (schema === false) return { value: {}, complete: true };
  const root = schemaObject(schema);
  if (root === undefined) return { value: {}, complete: false };
  const defs = schemaObject(root.$defs as JSONSchema | undefined) ?? {};
  let budget = SYNTHETIC_NODE_BUDGET;
  let complete = true;
  const incomplete = () => {
    complete = false;
  };

  const build = (
    node: JSONSchema | undefined,
    depth: number,
    seen: ReadonlySet<string>,
    slot: number,
  ): unknown => {
    if (budget-- <= 0) {
      incomplete();
      return undefined;
    }
    if (depth > SYNTHETIC_MAX_DEPTH) {
      incomplete();
      return undefined;
    }
    if (node === false) {
      incomplete();
      return undefined;
    }
    const s = schemaObject(node);
    if (s === undefined) {
      incomplete();
      return undefined;
    }
    if (typeof s.$ref === "string") {
      const name = s.$ref.startsWith("#/$defs/")
        ? s.$ref.slice("#/$defs/".length)
        : undefined;
      if (name === undefined || seen.has(name)) {
        incomplete();
        return undefined;
      }
      const target = defs[name] as JSONSchema | undefined;
      if (target === undefined) {
        incomplete();
        return undefined;
      }
      return build(target, depth + 1, new Set([...seen, name]), slot);
    }
    if (Object.hasOwn(s, "const")) return s.const;
    if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
    // `default` is deliberately NOT consulted. It is the value the pattern
    // falls back to when nothing is supplied, which for an optional array is
    // `[]` — the least exercising instance the schema admits, and the one
    // under which a table that renders every cell wrong renders no cells at
    // all. The gate wants the shape the schema declares, not its fallback.
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = s[key];
      if (Array.isArray(branches) && branches.length > 0) {
        // The first branch that is neither the null nor the absent
        // alternative — an optional field is spelled as a union with one of
        // those, and the point of the instance is to supply the field. A
        // union is a choice the schema left open, so taking one arm of it
        // leaves the others unexercised and the instance is marked partial.
        const branch = branches.find((candidate) => {
          const type = schemaObject(candidate as JSONSchema)?.type;
          return type !== "null" && type !== "undefined";
        }) ?? branches[0];
        if (branches.length > 1) incomplete();
        return build(branch as JSONSchema, depth + 1, seen, slot);
      }
    }
    const type = Array.isArray(s.type) ? s.type[0] : s.type;
    switch (type) {
      case "object": {
        const properties =
          schemaObject(s.properties as JSONSchema | undefined) ?? {};
        const out: Record<string, unknown> = {};
        let ordinal = 0;
        for (const [key, propertySchema] of Object.entries(properties)) {
          const value = build(
            propertySchema as JSONSchema,
            depth + 1,
            seen,
            ordinal++,
          );
          if (value !== undefined) out[key] = value;
        }
        // An object whose shape is open — `additionalProperties` given as a
        // schema — is given keys of its own, since an object declared as a
        // bag of fields is empty until something fills it, and an empty bag
        // exercises a renderer the same way no bag at all does. The names are
        // ours, so the instance is partial: nothing in the schema says what
        // the real keys are called.
        const additional = s.additionalProperties as JSONSchema | undefined;
        if (additional !== undefined && additional !== false) {
          incomplete();
          for (let i = 0; i < SYNTHETIC_ARRAY_LENGTH; i++) {
            // A name the object already declares is left alone: that property
            // was generated from its own schema, and a synthetic string
            // written over it would be the wrong type for whatever reads it.
            const key = syntheticName(i);
            if (Object.hasOwn(out, key)) continue;
            // `true` admits any value and describes none, so the bag gets a
            // name from the same vocabulary rather than no key at all — a bag
            // with no keys exercises an indexed renderer exactly as an absent
            // bag does, which is what this branch exists to avoid.
            const value = additional === true
              ? key
              : build(additional, depth + 1, seen, i);
            if (value !== undefined) out[key] = value;
          }
        } else if (Object.keys(properties).length === 0) {
          incomplete();
        }
        return out;
      }
      case "array": {
        const items = s.items as JSONSchema | undefined;
        if (items === undefined) {
          incomplete();
          return [];
        }
        const out: unknown[] = [];
        for (let i = 0; i < SYNTHETIC_ARRAY_LENGTH; i++) {
          const value = build(items, depth + 1, seen, i);
          if (value !== undefined) out.push(value);
        }
        return out;
      }
      case "string":
        return syntheticName(slot);
      case "number":
        return slot + 1.5;
      case "integer":
        return slot + 1;
      case "boolean":
        return true;
      case "null":
        return null;
      case "unknown":
        // The runtime's spelling for a position that admits any value. A
        // string is one such value and the one a UI is most likely to render,
        // but choosing it is a choice the schema did not make.
        incomplete();
        return syntheticName(slot);
      default:
        // A node with no `type` and no combinator constrains nothing, so
        // there is no value that exercises it more than any other.
        incomplete();
        return undefined;
    }
  };

  const value = build(root as JSONSchema, 0, new Set(), 0);
  return {
    value: isObjectNotArray(value) ? value : {},
    complete: complete && isObjectNotArray(value),
  };
};

/**
 * Renders `resultCell`'s `$UI` to HTML in this process, against a mock
 * document.
 *
 * The reconciler and the DOM applicator both run here, which is the same pair
 * a browser mounts, so the tree read back is the tree a browser would show.
 * Handlers the reconciler registers are never invoked: nothing dispatches
 * events at a document nobody is looking at.
 *
 * `mount` defaults to the real reconciler-and-applicator pair. It is a
 * parameter because the error channel `renderInProcess` offers cannot
 * otherwise be exercised: no `$UI` a pattern can express reaches it — a child
 * that is not a node, a tag name that is not a tag, a style that is not an
 * object, a cyclic tree and a bare string all render without a complaint —
 * and a verdict drawn from a channel nobody has seen fire is a check that
 * reports the same thing whether or not it ran. Supplying the mount is how
 * the arm that reads those errors is tested rather than assumed.
 *
 * Returns `undefined` when the result carries no `$UI` at all. That test goes
 * through `uiSchema` rather than reading the raw result, and the difference is
 * not cosmetic: a pattern that DECLARES its result type — `pattern<Io, Io>`,
 * which is what a self-describing component does — declares a type that does
 * not name `$UI`, and an unschema'd read returns only the declared fields. So
 * a raw read answers "no UI" for a pattern that has one, and the gate skips
 * its own check while reporting a clean run.
 *
 * Which way that fails is what makes it worth stating: the better a pattern
 * declares itself, the more certainly it went unchecked. Measured against the
 * 26 `MODULE_METADATA` components in `packages/patterns`, a raw read left 20
 * of the 24 that compile standalone recorded as `no-ui`.
 */
export const renderPatternUiToHtml = async (
  resultCell: Cell<unknown>,
  idle: () => Promise<void>,
  mount: typeof renderInProcess = renderInProcess,
): Promise<
  { html: string; errors: readonly string[]; truncated: boolean } | undefined
> => {
  const uiCell = resultCell.asSchema(uiSchema) as Cell<
    Record<string, unknown> | undefined
  >;
  await uiCell.sync();
  const result = uiCell.get();
  if (!isObjectNotArray(result) || result[UI] === undefined) {
    return undefined;
  }
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const { document, renderOptions } = mock;
  // The container is the div this function just parsed into the document a
  // line above, so there is no case where it is absent — the assertion is on
  // the literal, not on anything a caller supplies.
  const container = document.getElementById("root") as HTMLElement;
  const errors: string[] = [];
  const render = mount(container, uiCell.key(UI), {
    document,
    setProp: renderOptions.setProp,
    onError: (error) => {
      errors.push(error.message);
    },
  });
  try {
    // Mounting subscribes, and a subscription can start work the runtime has
    // not done yet, so the read waits for the runtime to go quiet and then
    // fixes the point it reads at.
    await idle();
    render.flush();
    const truncated = cutTreeToNodeBudget(container);
    return { html: container.innerHTML, errors, truncated };
  } finally {
    render.cancel();
  }
};

/**
 * Drops whatever of `container` sits past {@link PROBE_MAX_NODES}, and says
 * whether it dropped anything. Counting walks the tree without building a
 * string, so a runaway render costs the walk rather than the serialization.
 */
export const cutTreeToNodeBudget = (
  container: Element,
  budget: number = PROBE_MAX_NODES,
): boolean => {
  // The mock document's nodes are `domhandler` nodes carrying only the small
  // surface the renderer needs — `children`, `remove()`, `innerHTML` — so the
  // walk uses that and nothing more. `children` on a text node is undefined,
  // which ends a branch.
  //
  // The prune is RECURSIVE against one shared remaining count, and that is
  // the whole of it: dropping whole top-level children once a running total
  // crosses the budget leaves the child that crossed it entirely intact, so a
  // single `<section>` holding a hundred descendants passes such a check
  // while retaining all hundred. A bound that reports true and bounds nothing
  // is worse than no bound, because the caller then serializes an unbounded
  // tree believing it was cut.
  type Node = { children?: unknown[]; remove?: () => void };
  let remaining = budget;
  let cut = false;
  const prune = (node: Node): void => {
    for (const child of [...(node.children ?? [])]) {
      const typed = child as Node;
      if (remaining <= 0) {
        typed.remove?.();
        cut = true;
        continue;
      }
      remaining -= 1;
      prune(typed);
    }
  };
  prune(container as unknown as Node);
  return cut;
};

/**
 * What the rendered output says about the pattern, and nothing more.
 *
 * The one property a pass certifies is spelled in
 * `PATTERN_PUBLICATION_MESSAGES["ui-rendered"]`: *rendered text containing no
 * default-`toString` in it, for one synthetic instance of the pattern's own
 * argument schema*. It does not certify that the component works, that it is
 * usable, or that it is correct for real data — no host-side render can, and
 * nothing here should be read as claiming it.
 *
 * Only `ui-default-tostring` is refused on, and that asymmetry is the point.
 * A marker is positive evidence: something reached the DOM without being
 * read, and no correct pattern produces one. Rendering no text is an absence,
 * and an absence has honest explanations — a list with an empty state, a UI
 * built from images or canvases, a synthetic instance too thin to populate
 * it. Refusing on it would cost working parts their publication, so it is
 * reported as uncertified instead. That the corpus can then still take an
 * unchecked entry is the trade, made in the open rather than by silence.
 */
export const classifyRenderedHtml = (
  html: string,
  errors: readonly string[] = [],
):
  | "ui-rendered"
  | "ui-default-tostring"
  | "ui-rendered-empty"
  | "probe-failed" => {
  if (DEFAULT_TO_STRING.test(html)) return "ui-default-tostring";
  // A render the reconciler complained about is no evidence either way: the
  // tree read back is whatever got applied before the complaint. The marker
  // above outranks it, because a marker is positive evidence about what the
  // pattern does regardless of how complete the render was.
  if (errors.length > 0) return "probe-failed";
  // Text alone is the wrong test, and measurably so: a form of labelled
  // fields with placeholders — `<cf-field label="Email"><cf-input
  // placeholder="email@example.com">` — renders correctly and carries no
  // text node anywhere, and reading that as empty hid a working component.
  // What a rendered tree carries is its text AND its attribute values, so
  // both are weighed. A tree with neither carries nothing; a UI built only
  // from bare tags with no attributes reads as empty here too, which errs
  // toward not certifying rather than toward certifying wrongly.
  const text = html.replaceAll(/<[^>]*>/g, "").trim();
  const attributes = html.match(/=\s*"([^"]*)"/g) ?? [];
  return text === "" && attributes.every((pair) => /="\s*"$/.test(pair))
    ? "ui-rendered-empty"
    : "ui-rendered";
};
