/**
 * Reference acquisitions carried by admitted Runtime event entries. The entry's
 * transport attestation is distinct from application-owned payload fields.
 */

import {
  deepFreeze,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  dataUriFromValue,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { type CellLinkInput, convertCellsToLinks } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import {
  createSigilLinkFromParsedLink,
  inlineExternalSchemaRefsInValue,
  parseLink,
} from "../link-utils.ts";
import type { SigilLink } from "../sigil-types.ts";
import { isCellScope, isSchemaScope } from "../scope.ts";
import { linkWithRetainedScopeCaps } from "../schema.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CfcConfClause } from "./clause.ts";
import {
  type CfcImmutableReference,
  immutableReferenceEntries,
  withImmutableReferenceTable,
} from "./immutable-reference.ts";
import {
  type CfcLabelView,
  withCfcLabelViewOrigins,
} from "./label-view-core.ts";
import { joinCfcObservedConfidentiality } from "./observation.ts";
import { deriveFlowJoin } from "./prepare.ts";
import { retainedInputWitnesses } from "./input-witness.ts";
import { schemaWithRetainedReferenceScope } from "./reference-scope.ts";
import {
  cfcReferenceBindingMatches,
  cfcReferenceConfidentialityForView,
  type CfcReferenceProvenance,
  getCfcReferenceProvenance,
  getCfcReferenceView,
  registerCfcReferenceCarrier,
  withCfcReferenceConfidentiality,
} from "./reference-provenance.ts";

type EventReference = {
  path: readonly string[];
  relativeCycle?: true;
  reference: CfcReferenceProvenance;
  view?: CfcLabelView;
  viewConfidentiality: readonly CfcConfClause[];
  immutableReferences: readonly CfcImmutableReference[];
};

type EventReferenceContext = {
  version: 1 | 2;
  payloadHash: string;
  references: EventReference[];
  dispatchReference?: CfcReferenceProvenance;
};

/** A malformed attestation is a terminal event failure. */
export class InvalidRuntimeEventReferenceContext extends Error {
  constructor() {
    super("Invalid Runtime event reference context");
  }
}

function invalidContext(): never {
  throw new InvalidRuntimeEventReferenceContext();
}

const stringPath = (path: unknown): path is string[] =>
  Array.isArray(path) && path.every((part) => typeof part === "string");

function validReference(value: CfcReferenceProvenance): boolean {
  return value !== null && typeof value === "object" &&
    value.binding !== null && typeof value.binding === "object" &&
    typeof value.binding.space === "string" &&
    typeof value.binding.id === "string" &&
    isCellScope(value.binding.scope) && stringPath(value.binding.path) &&
    (value.binding.overwrite === undefined ||
      value.binding.overwrite === "redirect") &&
    Array.isArray(value.confidentiality) &&
    (value.originSpaces === undefined || stringPath(value.originSpaces)) &&
    (value.selectionWitnesses === undefined ||
      Array.isArray(value.selectionWitnesses) &&
        deepEqual(
          value.selectionWitnesses,
          retainedInputWitnesses(value.selectionWitnesses),
        )) &&
    (value.scopeCaps === undefined ||
      Array.isArray(value.scopeCaps) &&
        value.scopeCaps.every((cap) =>
          cap !== null && typeof cap === "object" &&
          Number.isSafeInteger(cap.depth) && cap.depth >= 0 &&
          isSchemaScope(cap.scope)
        ) &&
        new Set(value.scopeCaps.map((cap) => cap.depth)).size ===
          value.scopeCaps.length);
}

function restoreView(record: EventReference): CfcLabelView | undefined {
  if (
    !Array.isArray(record.viewConfidentiality) ||
    !Array.isArray(record.immutableReferences)
  ) {
    invalidContext();
  }
  if (
    record.view !== undefined && (record.view.version !== 1 ||
      !Array.isArray(record.view.entries) || record.view.entries.some((entry) =>
        !stringPath(entry.path) ||
        !Array.isArray(entry.label?.confidentiality) ||
        entry.label.integrity !== undefined ||
        (entry.observes !== undefined &&
          !["value", "shape", "enumerate", "followRef"].includes(
            entry.observes,
          ))
      ))
  ) invalidContext();
  for (const entry of record.immutableReferences) {
    if (
      entry.transport !== undefined ||
      !validReference(entry.reference) || !entry.source ||
      !isFabricDataUri(entry.source.id) || !stringPath(entry.source.path)
    ) invalidContext();
    let value = valueFromDataUri(entry.source.id);
    for (const key of entry.source.path) {
      if (
        value === null || typeof value !== "object" ||
        !Object.hasOwn(value, key)
      ) invalidContext();
      value = (value as Record<string, FabricValue>)[key];
    }
    const link = parseLink(value, {
      ...entry.source,
      id: entry.source.id as URI,
    });
    if (
      link === undefined || !cfcReferenceBindingMatches(entry.reference, link)
    ) invalidContext();
  }
  verifyImmutableReferenceTree(record.reference, record.immutableReferences);
  const view = withCfcReferenceConfidentiality(
    record.view,
    joinCfcObservedConfidentiality([
      record.viewConfidentiality,
      record.reference.confidentiality,
    ]),
    record.reference.selectionWitnesses,
  );
  return withCfcLabelViewOrigins(
    record.immutableReferences.length === 0
      ? view
      : withImmutableReferenceTable(view, record.immutableReferences),
    record.reference.originSpaces ?? [],
  );
}

function verifyImmutableReferenceTree(
  reference: CfcReferenceProvenance,
  entries: readonly CfcImmutableReference[],
  visited = new Set<string>(),
): void {
  const source = reference.binding;
  if (!isFabricDataUri(source.id)) return;
  const identity = hashStringOf(source);
  if (visited.has(identity)) return;
  visited.add(identity);
  let value = valueFromDataUri(source.id);
  for (const key of source.path) {
    if (
      value === null || typeof value !== "object" || !Object.hasOwn(value, key)
    ) invalidContext();
    value = (value as Record<string, FabricValue>)[key];
  }
  convertCellsToLinks(value, {
    allowLinkFreeFabricInstances: true,
    transformLink(_cell, link, path) {
      const slot = {
        space: source.space,
        id: source.id,
        scope: source.scope,
        path: [...source.path, ...path],
      };
      const matching = entries.filter((entry) => deepEqual(entry.source, slot));
      const actual = parseLink(link, { ...slot, id: slot.id as URI });
      if (
        matching.length === 0 || actual === undefined ||
        matching.some((entry) =>
          !cfcReferenceBindingMatches(entry.reference, actual)
        )
      ) invalidContext();
      for (const entry of matching) {
        verifyImmutableReferenceTree(entry.reference, entries, visited);
      }
      return link;
    },
  });
}

/** Captures only privately authenticated acquisitions before event encoding. */
export function serializeRuntimeEvent(
  value: CellLinkInput,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  target?: NormalizedFullLink,
): {
  payload: FabricValue;
  runtimeReferenceContext?: string;
  target?: NormalizedFullLink;
} {
  if (tx.getCfcState().flowLabelsMode !== "persist") {
    return { payload: convertCellsToLinks(value) };
  }
  const references: EventReference[] = [];
  const cycles: Array<
    { path: readonly string[]; targetPath: readonly string[] }
  > = [];
  const payload = convertCellsToLinks(value, {
    allowLinkFreeFabricInstances: true,
    transformCycle(link, path, targetPath) {
      cycles.push({ path, targetPath });
      return link;
    },
    transformLink(cell, link, path) {
      const acquired = getCfcReferenceProvenance(link);
      if (acquired === undefined) {
        throw new Error("Event reference lacks authenticated acquisition");
      }
      const binding = parseLink(link, {
        ...acquired.binding,
        id: acquired.binding.id as URI,
      });
      if (
        binding === undefined || !cfcReferenceBindingMatches(acquired, binding)
      ) invalidContext();
      const scoped = linkWithRetainedScopeCaps({
        ...binding,
        schema: cell?.getAsNormalizedFullLink().schema ?? binding.schema,
      }, acquired.scopeCaps);
      const reference = { ...acquired, scopeCaps: scoped.scopeCaps };
      const view = getCfcReferenceView(link);
      references.push({
        path: [...path],
        reference,
        ...(view === undefined ? {} : {
          view: {
            version: 1,
            entries: view.entries.map((entry) => ({
              path: entry.path,
              label: { confidentiality: entry.label.confidentiality ?? [] },
              ...(entry.observes === undefined
                ? {}
                : { observes: entry.observes }),
            })),
          },
        }),
        viewConfidentiality: cfcReferenceConfidentialityForView(view),
        immutableReferences: immutableReferenceEntries(view).map(
          ({ transport: _transport, ...entry }) => entry,
        ),
      });
      // The handler schema owns value projection. Only the acquired follow
      // restriction travels on the link, inline so event admission does not
      // depend on schema documents in the sender's space or realm registry.
      const result = inlineExternalSchemaRefsInValue(
        createSigilLinkFromParsedLink({
          ...binding,
          schema: schemaWithRetainedReferenceScope(undefined, scoped.scopeCaps),
        }, { includeSchema: true }),
      );
      registerCfcReferenceCarrier(result, () => reference, () => view);
      return result;
    },
  });
  if (references.length === 0 && cycles.length === 0 && target === undefined) {
    return { payload };
  }
  const { confidentiality: flow, labeledSpaces } = deriveFlowJoin(tx, {
    collectLabeledSpaces: true,
  });
  const withSendingOrigins = (reference: CfcReferenceProvenance) => ({
    ...reference,
    // New sender influence has no authenticated historical selection proof.
    selectionWitnesses: flow.length === 0
      ? reference.selectionWitnesses ?? []
      : [],
    originSpaces: [
      ...new Set([
        ...(reference.originSpaces ?? []),
        ...(labeledSpaces ?? []),
      ]),
    ],
  });
  const acquiredTarget = getCfcReferenceProvenance(target);
  if (
    target !== undefined &&
    (acquiredTarget === undefined ||
      !cfcReferenceBindingMatches(acquiredTarget, target))
  ) invalidContext();
  if (cycles.length > 0) {
    // A cycle names an ancestor inside these exact immutable payload bytes.
    // Its proof covers the payload's slots, including cycles back to itself.
    const payloadId = dataUriFromValue(
      inlineExternalSchemaRefsInValue(payload),
    );
    const cycleConfidentiality = joinCfcObservedConfidentiality([
      flow,
      ...references.map((record) => record.reference.confidentiality),
    ]);
    const cycleRecords: EventReference[] = cycles.map((
      { path, targetPath },
    ) => ({
      path,
      relativeCycle: true,
      reference: {
        binding: { space, id: payloadId, scope: "space", path: targetPath },
        confidentiality: cycleConfidentiality,
        originSpaces: [
          ...new Set([
            ...(labeledSpaces ?? []),
            ...references.flatMap((record) =>
              record.reference.originSpaces ?? []
            ),
          ]),
        ],
      },
      viewConfidentiality: cycleConfidentiality,
      immutableReferences: [],
    }));
    const payloadReferences: CfcImmutableReference[] = [
      ...references,
      ...cycleRecords,
    ].map((record) => ({
      source: { space, id: payloadId, scope: "space", path: record.path },
      reference: record.reference,
    }));
    const nestedReferences = references.flatMap((record) =>
      record.immutableReferences
    );
    references.push(...cycleRecords.map((record) => ({
      ...record,
      immutableReferences: [...payloadReferences, ...nestedReferences],
    })));
  }
  const context: EventReferenceContext = {
    version: target === undefined ? 1 : 2,
    payloadHash: hashStringOf(payload),
    ...(acquiredTarget === undefined ? {} : {
      dispatchReference: {
        ...withSendingOrigins(acquiredTarget),
        confidentiality: joinCfcObservedConfidentiality([
          acquiredTarget.confidentiality,
          flow,
        ]),
      },
    }),
    references: references.map((record) => ({
      ...record,
      reference: {
        ...withSendingOrigins(record.reference),
        confidentiality: joinCfcObservedConfidentiality([
          record.reference.confidentiality,
          flow,
        ]),
      },
    })),
  };
  const runtimeReferenceContext = jsonFromFabricValue(
    context as unknown as FabricValue,
  );
  return target === undefined
    ? {
      payload: restoreRuntimeEventReferences(payload, runtimeReferenceContext),
      runtimeReferenceContext,
    }
    : {
      ...restoreRuntimeEventDispatch(payload, runtimeReferenceContext, target),
      runtimeReferenceContext,
    };
}

/** Restores an admitted entry's exact acquisitions onto an isolated payload. */
export function restoreRuntimeEventReferences(
  payload: FabricValue,
  runtimeReferenceContext: string | undefined,
): FabricValue {
  if (runtimeReferenceContext === undefined) return payload;
  try {
    return restoreAttestedReferences(payload, runtimeReferenceContext).payload;
  } catch {
    return invalidContext();
  }
}

/**
 * Restores an admitted dispatch without sharing its target's private state.
 * The target is the resolved terminal stream: dispatch observes its identity
 * and aggregate acquisition confidentiality, then passes the payload to the
 * handler. Intermediate container proofs have already been consumed.
 */
export function restoreRuntimeEventDispatch(
  payload: FabricValue,
  runtimeReferenceContext: string | undefined,
  target: NormalizedFullLink,
): { payload: FabricValue; target: NormalizedFullLink } {
  if (runtimeReferenceContext === undefined) return { payload, target };
  try {
    const restored = restoreAttestedReferences(
      payload,
      runtimeReferenceContext,
      target,
    );
    return { payload: restored.payload, target: restored.target ?? target };
  } catch {
    return invalidContext();
  }
}

function restoreAttestedReferences(
  payload: FabricValue,
  runtimeReferenceContext: string,
  target?: NormalizedFullLink,
): { payload: FabricValue; target?: NormalizedFullLink } {
  const context = fabricFromJsonValue(
    runtimeReferenceContext,
  ) as unknown as EventReferenceContext;
  if (
    (context?.version !== 1 && context?.version !== 2) ||
    context.payloadHash !== hashStringOf(payload) ||
    !Array.isArray(context.references)
  ) invalidContext();
  const dispatchReference = context.dispatchReference;
  if (context.version === 2) {
    if (
      target === undefined || dispatchReference === undefined ||
      !validReference(dispatchReference) ||
      !cfcReferenceBindingMatches(dispatchReference, target)
    ) invalidContext();
  } else if (dispatchReference !== undefined) invalidContext();
  const records = new Map<string, EventReference>();
  for (const record of context.references) {
    if (
      !stringPath(record.path) || !validReference(record.reference) ||
      (record.relativeCycle !== undefined && record.relativeCycle !== true)
    ) {
      invalidContext();
    }
    const key = JSON.stringify(record.path);
    if (records.has(key)) invalidContext();
    records.set(key, deepFreeze(record));
  }
  const payloadId = context.references.some((record) => record.relativeCycle)
    ? dataUriFromValue(inlineExternalSchemaRefsInValue(payload))
    : undefined;
  const restored = convertCellsToLinks(payload, {
    allowLinkFreeFabricInstances: true,
    transformLink(_cell, link, path): SigilLink {
      const key = JSON.stringify(path);
      const record = records.get(key);
      if (record?.relativeCycle) {
        const target = record.reference.binding;
        if (
          target.id !== payloadId ||
          target.scope !== "space" || target.path.length >= path.length ||
          !target.path.every((part, index) => path[index] === part) ||
          !deepEqual(link, linkRefFrom({ path: target.path }))
        ) invalidContext();
      }
      const binding = parseLink(
        link,
        record?.relativeCycle
          ? {
            ...record.reference.binding,
            id: record.reference.binding.id as URI,
            path: [],
          }
          : undefined,
      );
      if (
        record === undefined || binding === undefined ||
        !deepEqual(record.reference.binding, {
          space: binding.space,
          id: binding.id,
          scope: binding.scope,
          path: binding.path,
          ...(binding.overwrite === "redirect"
            ? { overwrite: "redirect" }
            : {}),
        })
      ) invalidContext();
      records.delete(key);
      const view = restoreView(record);
      registerCfcReferenceCarrier(link, () => record.reference, () => view);
      return link;
    },
  });
  if (records.size !== 0) invalidContext();
  if (dispatchReference === undefined) return { payload: restored };
  const restoredTarget = linkWithRetainedScopeCaps(
    { ...target! },
    dispatchReference.scopeCaps,
  );
  const reference = deepFreeze(dispatchReference);
  const view = withCfcLabelViewOrigins(
    withCfcReferenceConfidentiality(
      undefined,
      reference.confidentiality,
      reference.selectionWitnesses,
    ),
    reference.originSpaces ?? [],
  );
  registerCfcReferenceCarrier(restoredTarget, () => reference, () => view);
  return { payload: restored, target: restoredTarget };
}
