/**
 * The pre-pass of the commit preparation that instantiates the label of each
 * path a compiled pattern's write covers (`instantiatePlanLabels`). It runs
 * before the persist loop, because a slot bound to an address this
 * transaction wrote takes the label staged there, which a loop over targets
 * cannot give in order.
 *
 * A slot is bound to an address the transaction journaled a read of in the
 * slot's class, to one it wrote, for a staged label, or to one it did not
 * read: by ruling, a label may rest on labels observed in an earlier
 * transaction. For an address of the last kind the pre-pass observes the
 * stored label in the committing transaction (`observeLabel`), which reads
 * no value, and resolves the slot from that label; the commit then
 * validates the version of the document it observed, so a concurrent change
 * of the label conflicts. Every target must be a path the transaction wrote,
 * and each instantiated confidentiality must be a subset of the transaction
 * join's together with the labels resolved from those observations. A
 * violation refuses the commit.
 */

import type { FabricValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import {
  cfcCanonicalClauseDigest,
} from "@commonfabric/memory/v2/cfc-clause-identity";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import { encodePointer } from "../../../memory/v2/path.ts";
import { normalizeCellScope } from "../scope.ts";
import type { MediaType } from "../storage/interface.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import type { CompiledPlan, CompiledPlanRegistry } from "./compiled-plans.ts";
import { mintTransformedBy } from "./input-witness.ts";
import {
  type ObservationLabelResolver,
  type ObservationProfile,
  type ObservedDocument,
  observedDocumentKey,
} from "./observation-label.ts";
import type { ReadObservationShape } from "./observation-classes.ts";
import {
  type DerivedBy,
  type ElementInputs,
  emptyTemplateWork,
  type Instantiated,
  instantiateTemplate,
  type InternedLabel,
  NEUTRAL,
  type Template,
  type TemplateInputs,
  TemplateInstantiationError,
  type TemplateWork,
} from "./plan-template.ts";
import {
  type CfcAddress,
  type CfcPreparationWork,
  type PlanElements,
  type PlanInputs,
  type PlanWrite,
  runtimeWritePolicyAuthorization,
  type SlotBinding,
  type WritePolicyInput,
} from "./types.ts";
import { verdictReason } from "./verdict-reason.ts";

/**
 * The number of labels and memoized results the runtime's label table holds
 * at most at the start of a pre-pass.
 */
export const LABEL_TABLE_LIMIT = 100_000;

/** A `plan-write` write-policy input. */
type PlanWriteInput = Extract<WritePolicyInput, { kind: "plan-write" }>;

/** A journaled read the preparation found for a slot's address. */
export interface JournaledRead {
  readonly document: ObservedDocument;
  readonly type: MediaType;
  readonly profile: ObservationProfile;
}

/** What the pre-pass reads of the transaction, supplied by the preparation. */
export interface PlanLabelEnvironment {
  readonly registry: CompiledPlanRegistry;
  readonly resolver: ObservationLabelResolver;

  /**
   * The journaled read of `address` in the class `observes`, or `undefined`
   * where the transaction journaled none: a read at the address itself, or a
   * recursive content read at or above it, or for an address holding `*` a
   * read at a position the `*` matches.
   */
  journaled(
    address: CfcAddress,
    observes: ReadObservationShape,
  ): JournaledRead | undefined;

  /**
   * Observes, in the transaction, the stored label of `address`, which the
   * transaction did not read in the class `observes`, and returns the read
   * to resolve its label under. It journals the read of the document's
   * label metadata alone, so the commit validates that the label is
   * current, and reads no value.
   */
  observeLabel(
    address: CfcAddress,
    observes: ReadObservationShape,
  ): JournaledRead;

  /** Whether the transaction wrote `address`, at it or at a path above it. */
  wrote(address: CfcAddress): boolean;

  /** The transaction's join, which every path not covered keeps. */
  readonly join: {
    readonly confidentiality: readonly CfcConfClause[];
    readonly integrity: readonly CfcAtom[];
  };

  /** Counts work, as `noteCfcPreparationWork` does. */
  noteWork?(kind: CfcPreparationWork, count: number): void;
}

/** The labels of covered paths, and why the commit is refused, if it is. */
export interface PlanLabels {
  /**
   * The label of each covered path, by document key (`observedDocumentKey`)
   * and then by the encoded canonical path.
   */
  readonly byTarget: ReadonlyMap<string, ReadonlyMap<string, InternedLabel>>;

  /** The canonical path of each covered path, by document key. */
  readonly paths: ReadonlyMap<string, readonly (readonly string[])[]>;

  /** Refusal reasons; the commit is refused when there is any. */
  readonly reasons: readonly string[];
}

/**
 * The inputs of one place a template is instantiated at, with the inputs
 * reported for each output it or an enclosing place names.
 */
interface PlaceInputs extends TemplateInputs {
  reported(output: number): PlanInputs | undefined;
}

/** Thrown inside the pre-pass for a report the transaction does not back. */
class PlanLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLabelError";
  }
}

/** The key a covered path is held under in `PlanLabels.byTarget`. */
export const planLabelPathKey = (path: readonly string[]): string =>
  encodePointer(canonicalizeLogicalPath(path));

const documentOf = (address: CfcAddress): ObservedDocument => ({
  space: address.space,
  id: address.id as ObservedDocument["id"],
  scope: normalizeCellScope(address.scope),
});

/**
 * Instantiates the label of every path the honored `plan-write` inputs cover
 * (`planWritesByTarget` in `prepare.ts`). Returns no label and a reason for
 * each report the transaction does not back. Counts the work through
 * `env.noteWork`.
 */
// SPEC-PENDING https://github.com/commonfabric/specs/pull/91
// A path a compiled pattern's write covers takes the label instantiated
// from its template, a subset of the transaction's join, behind the
// experimental option `compiledPatterns`.
export const instantiatePlanLabels = (
  writes: ReadonlyMap<string, readonly PlanWriteInput[]>,
  env: PlanLabelEnvironment,
): PlanLabels => {
  const table = env.registry.labels;
  // The table keeps what it interned across transactions; a pass holds none
  // of it before it starts, so it bounds the table there.
  table.trim(LABEL_TABLE_LIMIT);
  const work = emptyTemplateWork();
  let bounds = 0;
  const reasons: string[] = [];
  const join = table.intern({
    confidentiality: [...env.join.confidentiality],
    integrity: [...env.join.integrity],
  });
  const joinClauses = new Set(
    join.confidentiality.map((clause) => cfcCanonicalClauseDigest(clause)),
  );
  // The write that covers each path, the last one recorded where several do.
  const covering = new Map<
    string,
    { documentKey: string; pathKey: string; input: PlanWriteInput }
  >();
  for (const [documentKey, inputs] of writes) {
    for (const input of inputs) {
      const pathKey = planLabelPathKey(input.target.path);
      covering.set(stringKey([documentKey, pathKey]), {
        documentKey,
        pathKey,
        input,
      });
    }
  }
  const labels = new Map<string, InternedLabel>();
  const inProgress = new Set<string>();
  // Per transaction and set of inputs: the label of an `output` or `shared`
  // node, and the mint of a derivation.
  const named = new Map<string, Instantiated>();

  /** The label of the covered path at `coveringKey`, instantiated once. */
  const labelOfCovered = (coveringKey: string): InternedLabel => {
    const known = labels.get(coveringKey);
    if (known !== undefined) return known;
    if (inProgress.has(coveringKey)) {
      throw new PlanLabelError(
        "the staged labels of the transaction's writes form a cycle",
      );
    }
    inProgress.add(coveringKey);
    try {
      const label = instantiateWrite(covering.get(coveringKey)!.input);
      labels.set(coveringKey, label);
      return label;
    } finally {
      inProgress.delete(coveringKey);
    }
  };

  /** The label staged at an address this transaction wrote. */
  const stagedLabel = (address: CfcAddress): InternedLabel => {
    if (!env.wrote(address)) {
      throw new PlanLabelError(
        `a slot is bound to /${
          address.path.join("/")
        } of ${address.id} as staged, which the transaction did not write`,
      );
    }
    // A write covers its path and what is below it: the nearest covered
    // path at or above the address gives the label. A write above the
    // address whose own label is being instantiated is passed over: it
    // read below its target, where the label is that of a write further
    // up, or the join.
    const documentKey = observedDocumentKey(documentOf(address));
    for (let length = address.path.length; length >= 0; length--) {
      const coveringKey = stringKey([
        documentKey,
        planLabelPathKey(address.path.slice(0, length)),
      ]);
      if (!covering.has(coveringKey)) continue;
      if (length < address.path.length && inProgress.has(coveringKey)) {
        continue;
      }
      return labelOfCovered(coveringKey);
    }
    return join;
  };

  /**
   * Whether the nearest covered path at or above `address` is that of a
   * write whose label is being instantiated.
   */
  const coveredInProgress = (address: CfcAddress): boolean => {
    const documentKey = observedDocumentKey(documentOf(address));
    for (let length = address.path.length; length >= 0; length--) {
      const coveringKey = stringKey([
        documentKey,
        planLabelPathKey(address.path.slice(0, length)),
      ]);
      if (covering.has(coveringKey)) return inProgress.has(coveringKey);
    }
    return false;
  };

  /** The label one journaled observation of `address` consumed. */
  const observed = (
    address: CfcAddress,
    observes: ReadObservationShape,
  ): { confidentiality: readonly CfcConfClause[]; integrity: CfcAtom[] } => {
    const journaled = env.journaled(address, observes);
    // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
    // An address the transaction did not read: the label stored there, from
    // an observation of the label alone.
    const read = journaled ?? env.observeLabel(address, observes);
    const label = env.resolver.resolve(
      read.document,
      read.type,
      canonicalizeLogicalPath(address.path),
      read.profile,
    ).label;
    if (journaled === undefined) {
      for (const clause of label?.confidentiality ?? []) {
        joinClauses.add(cfcCanonicalClauseDigest(clause as CfcConfClause));
      }
    }
    return {
      confidentiality: (label?.confidentiality ?? []) as CfcConfClause[],
      integrity: observes === "followRef"
        ? []
        : [...(label?.integrity ?? [])] as CfcAtom[],
    };
  };

  /**
   * The label of a slot bound to an address: the observation at the end of
   * its chain, with the pointer labels of the link positions before it
   * joined in.
   */
  const slotLabel = (
    binding: Exclude<SlotBinding, { output: number }>,
    slot: number,
  ): InternedLabel => {
    if ("constant" in binding) {
      // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
      // A constant of the plan, as a `const` node is, contributes nothing.
      return table.empty;
    }
    if (!("chain" in binding)) return stagedLabel(binding.staged);
    const { chain, observes } = binding;
    // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
    // A read made after the transaction wrote its position observes, at
    // each position the transaction wrote, the label staged there.
    const at = (
      address: CfcAddress,
      observes: ReadObservationShape,
    ): { confidentiality: readonly CfcConfClause[]; integrity: CfcAtom[] } => {
      // A position the write being instantiated covers is read as it was
      // stored: what the write itself stages there adds nothing to its own
      // label.
      if (
        binding.staged !== true || !env.wrote(address) ||
        coveredInProgress(address)
      ) {
        return observed(address, observes);
      }
      const staged = stagedLabel(address);
      return {
        confidentiality: staged.confidentiality,
        integrity: observes === "followRef" ? [] : [...staged.integrity],
      };
    };
    if (chain.length === 0) {
      throw new PlanLabelError(`slot ${slot} is bound to an empty chain`);
    }
    // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
    // A read of a value that holds links observes, in the slot's class,
    // each position a link in the value led to, as a recursive read does:
    // the slot's confidentiality joins what every chain consumes, and its
    // integrity is the atoms the observation at the end of every chain
    // carries.
    const clauses: CfcConfClause[] = [];
    let integrity: CfcAtom[] | undefined;
    for (const each of [chain, ...(binding.below ?? [])]) {
      if (each.length === 0) {
        throw new PlanLabelError(`slot ${slot} is bound to an empty chain`);
      }
      for (const link of each.slice(0, -1)) {
        for (const clause of at(link, "followRef").confidentiality) {
          clauses.push(clause);
        }
      }
      const last = at(each[each.length - 1], observes);
      for (const clause of last.confidentiality) clauses.push(clause);
      // The table holds each atom once, so two are equal where they are
      // one object.
      const atoms = table.intern({ integrity: last.integrity }).integrity;
      integrity = integrity === undefined
        ? [...atoms]
        : integrity.filter((atom) => atoms.includes(atom));
    }
    return table.intern({
      confidentiality: clauses,
      integrity: integrity ?? [],
    });
  };

  /** Instantiates the template of one write. */
  const instantiateWrite = (input: PlanWriteInput): InternedLabel => {
    if (!env.wrote(input.target)) {
      throw new PlanLabelError(
        `a plan-write names /${
          input.target.path.join("/")
        } of ${input.target.id}, which the transaction did not write`,
      );
    }
    const plan = env.registry.plan(
      input.compiledPattern,
      runtimeWritePolicyAuthorization,
    )!;
    if ("operation" in input.record) {
      return wishOutcomeLabel(plan, input, input.record.operation);
    }
    const { template, kept } = templateOf(plan, input.record);
    const inputs = inputsFor(plan, input, input, undefined);
    let label = instantiateTemplate(template, inputs, table, work);
    if (kept) {
      // Every kept output carries the atom of its pattern, a neutral one
      // included.
      label = table.withIntegrity(
        label === NEUTRAL ? table.empty : label,
        mint(input.compiledPattern, { expression: true }, undefined),
      );
    }
    return label === NEUTRAL ? table.empty : label;
  };

  /**
   * The label of the outcome of a `wish` (PL §3.19, "The outcome of each
   * `wish` has a label of its own"): the instantiated `Operation.input`
   * joined with the label of what the resolution read, which the write
   * reports under the entry of `Plan.dynamicReads` of kind `search` that
   * names the operation. It mints no integrity. A write that reports no
   * reads for that entry takes the transaction's join for them.
   */
  // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
  const wishOutcomeLabel = (
    plan: CompiledPlan,
    input: PlanWriteInput,
    index: number,
  ): InternedLabel => {
    const operation = plan.operations?.[index];
    if (operation?.kind !== "wish" || operation.input === undefined) {
      throw new PlanLabelError(
        "a plan-write names an operation that is no `wish` of the plan",
      );
    }
    const inputs = inputsFor(plan, input, input, undefined);
    const operands = instantiateTemplate(operation.input, inputs, table, work);
    const reads = (plan.dynamicReads ?? []).findIndex(({ why }) =>
      why?.kind === "search" && why.operation === index
    );
    const searched = reads < 0 ? table.empty : inputs.dynamicLabel(reads);
    return table.intern({
      confidentiality: [
        ...(operands === NEUTRAL ? [] : operands.confidentiality),
        ...searched.confidentiality,
      ],
      integrity: [],
    });
  };

  /**
   * The pattern a derivation mints the atom of (PL §3.2, "The atom of the
   * pattern"). A derivation by expression code, a fold and a kept output
   * name the entry of `Plan.patterns` of the pattern whose source holds
   * the code, entry 0 where `pattern` is absent. An entry is the identity
   * of that pattern's own source, so the atom is the same whether the
   * pattern is registered alone or compiled into another. A derivation by
   * a body names the registered plan, whose bodies its index numbers, as
   * does a plan that lists no patterns.
   */
  // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
  const mintedPattern = (compiledPattern: string, by: DerivedBy): string => {
    if ("body" in by) return compiledPattern;
    const patterns = env.registry.plan(
      compiledPattern,
      runtimeWritePolicyAuthorization,
    )?.patterns;
    if (patterns === undefined || patterns.length === 0) {
      return compiledPattern;
    }
    const entry = patterns[by.pattern ?? 0];
    if (entry === undefined) {
      throw new PlanLabelError(
        `a derivation names entry ${by.pattern} of the plan's patterns, which the plan does not list`,
      );
    }
    return entry;
  };

  /** The `TransformedBy` atoms of a derivation, as an integrity label. */
  const mint = (
    compiledPattern: string,
    by: DerivedBy,
    witnesses: InternedLabel | undefined,
  ): InternedLabel => {
    const pattern = mintedPattern(compiledPattern, by);
    const key = stringKey([
      "mint",
      pattern,
      "body" in by ? String(by.body) : "expression",
      witnesses?.id ?? "",
    ]);
    const known = named.get(key);
    if (known !== undefined && known !== NEUTRAL) {
      work.memoHits++;
      return known;
    }
    const minted = table.intern({
      integrity: mintTransformedBy(
        "body" in by
          ? { kind: "compiled", pattern, body: by.body }
          : { kind: "compiled", pattern },
        witnesses?.integrity,
      ),
    });
    named.set(key, minted);
    return minted;
  };

  /**
   * The `TemplateInputs` of one place: `place` holds its bindings, and an
   * enclosing place's bindings answer a slot, selection or output it does
   * not name.
   */
  const inputsFor = (
    plan: CompiledPlan,
    write: PlanWrite,
    place: PlanInputs,
    enclosing: PlaceInputs | undefined,
  ): PlaceInputs => {
    const memberships = new Map<number, InternedLabel>();
    const self: PlaceInputs = {
      reported: (output) =>
        place.outputs?.[output] ?? enclosing?.reported(output),
      slotLabel: (slot) => {
        const binding = place.slots[slot];
        if (binding !== undefined && "output" in binding) {
          const label = self.outputLabel(binding.output);
          return label === NEUTRAL ? table.empty : label;
        }
        if (binding !== undefined) return slotLabel(binding, slot);
        if (enclosing !== undefined) return enclosing.slotLabel(slot);
        throw new TemplateInstantiationError(`slot ${slot} has no binding`);
      },
      selection: (selector) =>
        place.selections?.[selector] ?? enclosing?.selection(selector),
      elements: (collection) => {
        const elements = place.elements?.[collection];
        if (elements !== undefined) {
          return elementsOf(plan, write, elements, self);
        }
        if (enclosing !== undefined) return enclosing.elements(collection);
        throw new TemplateInstantiationError(
          `collection ${collection} has no elements reported`,
        );
      },
      chosen: (pick) => {
        const reported = place.picks?.[pick];
        if (reported === undefined) return enclosing?.chosen(pick);
        return {
          chosen: reported === null
            ? undefined
            : inputsFor(plan, write, { slots: reported.slots }, self),
        };
      },
      children: (pick, from) => {
        if ("collection" in from) return self.elements(from.collection);
        throw new TemplateInstantiationError(
          `the choice at pick ${pick} was not reported, and it chooses from no collection`,
        );
      },
      membership: (collection) => {
        let label = memberships.get(collection);
        if (label === undefined) {
          const record = plan.collections[collection];
          if (record === undefined) {
            throw new TemplateInstantiationError(
              `collection ${collection} is not in the plan`,
            );
          }
          // The membership template of a `filter` is the fold that decides
          // which elements it keeps, over its own elements; the membership
          // it iterates is that of its source.
          const source = record.source;
          const result = !isFoldOver(record.membership, collection, plan)
            ? instantiateTemplate(record.membership, self, table, work)
            : source?.collection !== undefined
            ? self.membership(source.collection)
            : source?.slot !== undefined
            ? self.slotLabel(source.slot)
            // SPEC-PENDING https://github.com/commonfabric/specs/pull/91
            // A collection over the array an output computes iterates
            // that output: its membership is the output's label.
            : source?.output !== undefined
            ? self.outputLabel(source.output)
            : undefined;
          if (result === undefined) {
            throw new TemplateInstantiationError(
              `collection ${collection} iterates no source`,
            );
          }
          label = result === NEUTRAL ? table.empty : result;
          memberships.set(collection, label);
        }
        return label;
      },
      outputLabel: (output, site) => {
        if (site !== undefined) {
          throw new TemplateInstantiationError(
            "an output of a pattern compiled in is not supported",
          );
        }
        const template = plan.outputs[output]?.template;
        if (template === undefined) {
          throw new TemplateInstantiationError(
            `output ${output} is not in the plan`,
          );
        }
        const reported = self.reported(output);
        return cached(
          [
            "output",
            write.compiledPattern,
            String(output),
            ...(reported === undefined
              ? [writeKey(write), inputsKey(place)]
              : [inputsKey(reported)]),
          ],
          () =>
            instantiateTemplate(
              template,
              reported === undefined
                ? self
                : inputsFor(plan, write, reported, undefined),
              table,
              work,
            ),
        );
      },
      sharedLabel: (index) => {
        const template = plan.templates[index];
        if (template === undefined) {
          throw new TemplateInstantiationError(
            `template ${index} is not in the plan`,
          );
        }
        return cached(
          [
            "shared",
            write.compiledPattern,
            String(index),
            writeKey(write),
            inputsKey(place),
          ],
          () => instantiateTemplate(template, self, table, work),
        );
      },
      dynamicLabel: (reads) => {
        const addresses = place.dynamic?.[reads];
        if (addresses === undefined) {
          if (enclosing !== undefined) return enclosing.dynamicLabel(reads);
          // Not attributed: the transaction's join is the bound.
          bounds++;
          return join;
        }
        const parts = addresses.map((address) => {
          const read = observed(address, "value");
          return table.intern({
            confidentiality: [...read.confidentiality],
            integrity: read.integrity,
          });
        });
        return table.combine(parts).label;
      },
      mint: (by, witnesses) => mint(write.compiledPattern, by, witnesses),
      noteBound: () => {
        bounds++;
      },
    };
    return self;
  };

  /** The element inputs of a reported collection. */
  const elementsOf = (
    plan: CompiledPlan,
    write: PlanWrite,
    elements: PlanElements,
    enclosing: PlaceInputs,
  ): ElementInputs =>
    "uniform" in elements
      ? { uniform: inputsFor(plan, write, elements.uniform, enclosing) }
      : {
        groups: elements.groups.map((group) => ({
          inputs: inputsFor(plan, write, group, enclosing),
          count: group.count,
        })),
      };

  /** The label under `key`, instantiated once per transaction. */
  const cached = (
    key: readonly string[],
    compute: () => Instantiated,
  ): Instantiated => {
    const at = stringKey(key);
    if (named.has(at)) {
      work.memoHits++;
      return named.get(at)!;
    }
    const result = compute();
    named.set(at, result);
    return result;
  };

  for (const coveringKey of covering.keys()) {
    try {
      const label = labelOfCovered(coveringKey);
      // A template label only narrows: each clause it carries is one the
      // transaction's join carries.
      const outside = label.confidentiality.filter((clause) =>
        !joinClauses.has(cfcCanonicalClauseDigest(clause))
      );
      if (outside.length > 0) {
        throw new PlanLabelError(
          `the template label of a write carries ${outside.length} clause(s) the transaction's join does not`,
        );
      }
    } catch (error) {
      if (
        !(error instanceof PlanLabelError) &&
        !(error instanceof TemplateInstantiationError)
      ) {
        throw error;
      }
      const { input } = covering.get(coveringKey)!;
      reasons.push(verdictReason(
        `plan-label refused for ${input.target.id} at /${
          input.target.path.join("/")
        }: ${error.message}`,
      ));
      labels.delete(coveringKey);
    }
  }
  noteWork(env, work, bounds);
  const byTarget = new Map<string, Map<string, InternedLabel>>();
  const paths = new Map<string, (readonly string[])[]>();
  if (reasons.length === 0) {
    for (const [coveringKey, label] of labels) {
      const { documentKey, pathKey, input } = covering.get(coveringKey)!;
      let labelsByPath = byTarget.get(documentKey);
      if (labelsByPath === undefined) {
        labelsByPath = new Map();
        byTarget.set(documentKey, labelsByPath);
        paths.set(documentKey, []);
      }
      labelsByPath.set(pathKey, label);
      paths.get(documentKey)!.push(
        canonicalizeLogicalPath(input.target.path),
      );
    }
  }
  return { byTarget, paths, reasons };
};

/** Reports the counts of one pre-pass. */
const noteWork = (
  env: PlanLabelEnvironment,
  work: TemplateWork,
  bounds: number,
): void => {
  if (env.noteWork === undefined) return;
  env.noteWork("planTemplatesInstantiated", work.instantiations);
  env.noteWork("planTemplateNodes", work.nodes);
  env.noteWork("planSlotLabels", work.slotLabels);
  env.noteWork("planLabelMemoHits", work.memoHits);
  env.noteWork("planLabelBounds", bounds);
  env.noteWork("planInputKeys", inputKeysFormed);
  inputKeysFormed = 0;
};

/** The template and keep flag of the plan record a write names. */
const templateOf = (
  plan: CompiledPlan,
  record: PlanWrite["record"],
): { template: Template; kept: boolean } => {
  let found: { template: Template; kept: boolean } | undefined;
  if ("output" in record) {
    const output = plan.outputs[record.output];
    found = output && { template: output.template, kept: output.kept === true };
  } else if ("body" in record) {
    const edge = plan.bodies[record.body]?.writes[record.write];
    found = edge && { template: edge.template, kept: false };
  } else if ("cone" in record) {
    const edge = plan.cones[record.cone]?.writes[record.write];
    found = edge && { template: edge.template, kept: false };
  } else if ("stateFirst" in record) {
    const first = plan.stateCells[record.stateFirst]?.first;
    const edge = first && plan.cones[first.cone]?.writes[first.write];
    found = edge && { template: edge.template, kept: false };
  }
  if (found === undefined) {
    throw new PlanLabelError("a plan-write names a record the plan lacks");
  }
  return found;
};

/** Whether `template`, with `shared` expanded, is a fold over `collection`. */
const isFoldOver = (
  template: Template,
  collection: number,
  plan: CompiledPlan,
): boolean => {
  const expanded = template.op === "shared"
    ? plan.templates[template.template]
    : template;
  return expanded?.op === "fold" && expanded.collection === collection;
};

/** The content keys `inputsKey` formed since the last pass reported them. */
let inputKeysFormed = 0;

/**
 * The content key of each place's inputs formed so far, by the object. A
 * write-policy input is frozen when it is recorded, so the key of one
 * object stays what it is.
 */
const inputKeys = new WeakMap<object, string>();

/** The content key of a place's inputs, formed once per object. */
const inputsKey = (inputs: object): string => {
  let key = inputKeys.get(inputs);
  if (key === undefined) {
    inputKeysFormed++;
    key = hashStringOf(inputs as unknown as FabricValue);
    inputKeys.set(inputs, key);
  }
  return key;
};

/** The key `writeKey` formed for each write so far, by the write. */
const writeKeys = new WeakMap<PlanWrite, string>();

/**
 * The content key of a write's own inputs, without its target and record,
 * so that two writes with equal inputs share their `output` and `shared`
 * labels.
 */
const writeKey = (write: PlanWrite): string => {
  let key = writeKeys.get(write);
  if (key === undefined) {
    key = inputsKey({
      slots: write.slots,
      ...(write.selections === undefined
        ? {}
        : { selections: write.selections }),
      ...(write.picks === undefined ? {} : { picks: write.picks }),
      ...(write.elements === undefined ? {} : { elements: write.elements }),
      ...(write.dynamic === undefined ? {} : { dynamic: write.dynamic }),
      ...(write.outputs === undefined ? {} : { outputs: write.outputs }),
    });
    writeKeys.set(write, key);
  }
  return key;
};

/** Joins key parts unambiguously. */
const stringKey = (parts: readonly string[]): string =>
  parts.map((part) => `${part.length}:${part}`).join("");
