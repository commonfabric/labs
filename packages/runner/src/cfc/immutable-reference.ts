/**
 * Acquisitions retained by a live immutable value before its data URI is
 * encoded. The table follows private views; serialized views carry no authority.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { deepFreeze, hashStringOf } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { utf8Compare } from "@commonfabric/utils/utf8";
import type { ScopeCapAtDepth } from "../link-types.ts";
import { narrowerScopeCap } from "../scope.ts";
import { joinCfcObservedConfidentiality } from "./observation.ts";
import { meetInputWitnesses } from "./input-witness.ts";
import {
  type CfcLabelView,
  cfcLabelViewOriginSpaces,
  withCfcLabelViewOrigins,
} from "./label-view-core.ts";
import {
  cfcReferenceBinding,
  cfcReferenceBindingMatches,
  cfcReferenceConfidentialityForView,
  type CfcReferenceProvenance,
  cfcReferenceSelectionWitnessesForView,
  withCfcReferenceConfidentiality,
} from "./reference-provenance.ts";
import type { CfcAddress } from "./types.ts";

/** A captured target acquisition at one exact immutable source slot. */
export type CfcImmutableReference = {
  readonly source: CfcAddress;
  readonly reference: CfcReferenceProvenance;
  /** Static runtime wiring replays its captured selection pointwise. */
  readonly transport?: true;
};

type ReferenceTable = {
  readonly identity: string;
  readonly entries: readonly CfcImmutableReference[];
};

const tables = new WeakMap<CfcLabelView, readonly ReferenceTable[]>();
const acquisitions = new WeakMap<
  CfcReferenceProvenance,
  readonly CfcImmutableReference[]
>();

/** Attaches the runtime's captured slots to an immutable value's live view. */
export function withImmutableReferenceTable(
  view: CfcLabelView | undefined,
  entries: readonly CfcImmutableReference[],
): CfcLabelView {
  const result = withCfcReferenceConfidentiality(
    { version: 1, entries: [...(view?.entries ?? [])] },
    cfcReferenceConfidentialityForView(view),
    cfcReferenceSelectionWitnessesForView(view),
  )!;
  const table = {
    identity: hashStringOf(entries),
    entries: deepFreeze(entries),
  };
  tables.set(result, [
    ...(view === undefined ? [] : tables.get(view) ?? []),
    table,
  ]);
  return withCfcLabelViewOrigins(result, cfcLabelViewOriginSpaces(view));
}

/** Preserves private tables through a label-view copy, merge, or projection. */
export function carryImmutableReferenceTables(
  sources: readonly (CfcLabelView | undefined)[],
  target: CfcLabelView | undefined,
): CfcLabelView | undefined {
  const retained = [
    ...new Map(
      sources.flatMap((view) =>
        (view === undefined ? [] : tables.get(view) ?? []).map((table) =>
          [table.identity, table] as const
        )
      ),
    ).values(),
  ].sort((left, right) => utf8Compare(left.identity, right.identity));
  if (retained.length === 0) return target;
  const result = target ?? { version: 1 as const, entries: [] };
  tables.set(result, retained);
  return result;
}

/** Separates live views with equal bytes and different acquisition tables. */
export function immutableReferenceViewIdentity(
  view: CfcLabelView | undefined,
): readonly string[] | undefined {
  return view === undefined
    ? undefined
    : tables.get(view)?.map((t) => t.identity);
}

/** Copies the private slots carried by a Runtime-attested event reference. */
export function immutableReferenceEntries(
  view: CfcLabelView | undefined,
): readonly CfcImmutableReference[] {
  return view === undefined
    ? []
    : (tables.get(view) ?? []).flatMap((table) => table.entries);
}

/** Binds a source-slot acquisition to the runtime's captured target proof. */
export function immutableReferenceSourceAcquisition(
  view: CfcLabelView | undefined,
  source: CfcAddress,
  confidentiality = cfcReferenceConfidentialityForView(view),
): CfcReferenceProvenance {
  const acquisition: CfcReferenceProvenance = {
    binding: cfcReferenceBinding(source),
    confidentiality,
    selectionWitnesses: cfcReferenceSelectionWitnessesForView(view),
    originSpaces: cfcLabelViewOriginSpaces(view),
  };
  const matching = view === undefined ? undefined : tables.get(view)?.flatMap(
    (table) => table.entries,
  ).filter((entry) => deepEqual(entry.source, source));
  if (matching !== undefined && matching.length > 0) {
    acquisitions.set(acquisition, matching);
  }
  return acquisition;
}

/** Whether an acquisition replays only runtime-marked static binding slots. */
export function immutableReferenceIsTransport(
  acquisition: CfcReferenceProvenance | undefined,
): boolean {
  const entries = acquisition === undefined
    ? undefined
    : acquisitions.get(acquisition);
  return entries !== undefined && entries.length > 0 &&
    entries.every((entry) => entry.transport === true);
}

/** Validates the captured source slot and target against the decoded value. */
export function acquiredImmutableReference(
  acquisition: CfcReferenceProvenance | undefined,
  source: CfcAddress,
  actual: CfcReferenceProvenance["binding"],
): CfcReferenceProvenance | undefined {
  const entries = acquisition === undefined
    ? undefined
    : acquisitions.get(acquisition);
  if (
    entries === undefined ||
    !entries.every((entry) =>
      deepEqual(entry.source, source) &&
      cfcReferenceBindingMatches(entry.reference, actual)
    )
  ) return undefined;
  const caps = new Map<number, ScopeCapAtDepth["scope"]>();
  for (const entry of entries) {
    for (const { depth, scope } of entry.reference.scopeCaps ?? []) {
      caps.set(depth, narrowerScopeCap(caps.get(depth), scope)!);
    }
  }
  const scopeCaps = [...caps].sort(([a], [b]) => a - b).map((
    [depth, scope],
  ) => ({
    depth,
    scope,
  }));
  let witnesses: readonly CfcAtom[] | undefined;
  for (const entry of entries) {
    if (entry.reference.confidentiality.length === 0) continue;
    const held = entry.reference.selectionWitnesses ?? [];
    witnesses = witnesses === undefined
      ? held
      : meetInputWitnesses(witnesses, held);
  }
  return {
    binding: cfcReferenceBinding(actual),
    selectionWitnesses: witnesses ?? [],
    originSpaces: [
      ...new Set(
        entries.flatMap((entry) => entry.reference.originSpaces ?? []),
      ),
    ],
    confidentiality: joinCfcObservedConfidentiality(
      entries.map((entry) => entry.reference.confidentiality),
    ),
    ...(scopeCaps.length > 0 && { scopeCaps }),
  };
}
