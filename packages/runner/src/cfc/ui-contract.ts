import {
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { CellScope, FabricValue, JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { findAndInlineDataUriLinks } from "../data-uri.ts";
import { isNormalizedFullLink } from "../link-types.ts";
import { type NormalizedFullLink, parseLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
} from "./schema-refs.ts";
import type { CfcAddress } from "./types.ts";

type UiContractTrustRequirements = {
  trustedPattern?: string;
  requiredEventIntegrity?: readonly string[];
};

type UiActionContract = UiContractTrustRequirements & {
  helper: "UiAction";
  action: string;
};

type UiPromptSlotContract = UiContractTrustRequirements & {
  helper: "UiPromptSlot";
  surface: string;
  role?: string;
};

type UiDisclosureContract = UiContractTrustRequirements & {
  helper: "UiDisclosure";
  kind: string;
};

export type UiContract =
  | UiActionContract
  | UiPromptSlotContract
  | UiDisclosureContract;

export type UiContractEntry = {
  path: string[];
  contract: UiContract;
  schema?: JSONSchema;

  /** The schema document that resolves local references inside `.schema`. */
  root?: JSONSchema;

  /**
   * Set when the contract sits inside an `anyOf` or `oneOf` branch, so it
   * holds only for the values that branch matches.
   */
  conditional?: true;
};

const uiContractEntry = (
  path: string[],
  contract: UiContract,
  schema?: JSONSchema,
  root?: JSONSchema,
  conditional = false,
): UiContractEntry => {
  const entry: UiContractEntry = { path, contract };
  if (conditional) {
    Object.defineProperty(entry, "conditional", {
      value: true,
      enumerable: false,
    });
  }
  if (schema !== undefined) {
    Object.defineProperty(entry, "schema", {
      value: schema,
      enumerable: false,
    });
  }
  if (root !== undefined) {
    Object.defineProperty(entry, "root", {
      value: root,
      enumerable: false,
    });
  }
  return entry;
};

type SerializedTrustedEvent = {
  type?: string;
  provenance?: {
    origin?: string;
    trusted?: boolean;
    ui?: {
      pattern?: string;
      eventIntegrity?: FabricValue;
      uiContractDataset?: FabricValue;
    };
  };
};

type TrustedEventPolicyTx = Pick<
  IExtendedStorageTransaction,
  "getCfcState" | "recordCfcWritePolicyInput"
>;

/**
 * The schema envelope a document stores, in the form the commit boundary
 * verifies against, or `undefined` when it stores none or cannot be read.
 */
export type StoredSchemaResolver = (
  write: NormalizedFullLink,
) => JSONSchema | undefined;

type AddressLike = {
  space: string;
  id: string;
  scope: CellScope;
  path: readonly unknown[];
};

type TrustedDomProvenance = {
  origin: "dom";
  trusted: true;
  ui?: {
    pattern?: unknown;
    eventIntegrity?: unknown;
    uiContractDataset?: unknown;
  };
};

const rendererTrustedEvents = new WeakSet<object>();

const isTrustedDomProvenance = (
  provenance: unknown,
): provenance is TrustedDomProvenance =>
  isObjectOrArray(provenance) &&
  provenance.origin === "dom" &&
  provenance.trusted === true;

export const markRendererTrustedEvent = (event: unknown): void => {
  if (isObjectOrArray(event)) {
    rendererTrustedEvents.add(event);
  }
};

export const propagateRendererTrustedEvent = (
  source: unknown,
  target: unknown,
): void => {
  if (
    isObjectOrArray(source) &&
    rendererTrustedEvents.has(source) &&
    isObjectOrArray(target)
  ) {
    rendererTrustedEvents.add(target);
  }
};

export const isRendererTrustedEvent = (event: unknown): boolean =>
  isObjectOrArray(event) && rendererTrustedEvents.has(event);

const trustRequirementsFromContract = (
  contract: Record<string, unknown>,
): UiContractTrustRequirements | undefined => {
  const trustedPattern = typeof contract.trustedPattern === "string"
    ? contract.trustedPattern
    : undefined;
  const requiredEventIntegrity = Array.isArray(contract.requiredEventIntegrity)
    ? contract.requiredEventIntegrity.filter((label): label is string =>
      typeof label === "string"
    )
    : undefined;

  return {
    ...(trustedPattern ? { trustedPattern } : {}),
    ...(requiredEventIntegrity && requiredEventIntegrity.length > 0
      ? { requiredEventIntegrity }
      : {}),
  };
};

// Follow a `$ref` of any form the runtime resolves — a local pointer, an
// embedded schema, or an external `cid:` document — one chain at a time. The
// resolver guards the chain; `seenRefs`, the refs this branch of the walk has
// followed, guards the descent, where a recursive document reaches its own
// ref again below the body it resolved to. The schema comes back as it is
// where it carries no ref, where the ref closes a cycle, or where it resolves
// to nothing.
const followSchemaRef = (
  schema: JSONSchema | undefined,
  root: JSONSchema | undefined,
  seenRefs: Set<string>,
): JSONSchema | undefined => {
  if (!isObjectOrArray(schema) || typeof schema.$ref !== "string") {
    return schema;
  }
  const ref = schema.$ref;
  if (seenRefs.has(ref)) return schema;
  seenRefs.add(ref);
  return ContextualFlowControl.resolveSchemaRefs(
    schema,
    isObjectOrArray(root) ? root : schema,
  ) ?? schema;
};

// The seen refs to carry below a resolution. A resolution that enters another
// document — its root is not the one the ref was read in — leaves the local
// pointers followed so far behind: each named a definition of the document
// being left, and the same pointer in the new document is another ref. An
// embedded or external ref names its document wherever it sits, and stays.
const seenRefsBelow = (
  seenRefs: Set<string>,
  root: JSONSchema | undefined,
  resolvedRoot: JSONSchema,
): Set<string> =>
  resolvedRoot === root
    ? seenRefs
    : new Set([...seenRefs].filter((ref) => !ref.startsWith("#")));

// The root a resolved ref's target resolves against: its own document where
// the ref's chain ended in another one — a definition body that is an
// external ref — and otherwise the document the ref site belongs to.
const resolvedRootFor = (
  schema: JSONSchema,
  resolved: JSONSchema,
  root: JSONSchema | undefined,
): JSONSchema =>
  cfcSchemaResolvedRoot(
    resolved,
    resolveCfcSchemaRefRoot(schema, root ?? schema),
  );

const uiContractFromSchemaInternal = (
  schema: JSONSchema | undefined,
  root: JSONSchema | undefined,
  seenRefs: Set<string>,
): UiContract | undefined => {
  const resolvedSchema = followSchemaRef(schema, root, seenRefs);
  if (resolvedSchema !== schema && schema !== undefined) {
    const resolvedRoot = resolvedRootFor(
      schema,
      resolvedSchema ?? schema,
      root,
    );
    return uiContractFromSchemaInternal(
      resolvedSchema,
      resolvedRoot,
      seenRefsBelow(seenRefs, root, resolvedRoot),
    );
  }
  if (
    !isObjectOrArray(resolvedSchema) || !isObjectOrArray(resolvedSchema.ifc) ||
    !isObjectOrArray(resolvedSchema.ifc.uiContract)
  ) {
    return undefined;
  }
  const contract = resolvedSchema.ifc.uiContract;
  const trustRequirements = trustRequirementsFromContract(contract);
  switch (contract.helper) {
    case "UiAction":
      return typeof contract.action === "string"
        ? { helper: "UiAction", action: contract.action, ...trustRequirements }
        : undefined;
    case "UiPromptSlot":
      return typeof contract.surface === "string"
        ? {
          helper: "UiPromptSlot",
          surface: contract.surface,
          ...(typeof contract.role === "string" ? { role: contract.role } : {}),
          ...trustRequirements,
        }
        : undefined;
    case "UiDisclosure":
      return typeof contract.kind === "string"
        ? { helper: "UiDisclosure", kind: contract.kind, ...trustRequirements }
        : undefined;
    default:
      return undefined;
  }
};

export const uiContractFromSchema = (
  schema: JSONSchema | undefined,
): UiContract | undefined =>
  uiContractFromSchemaInternal(schema, schema, new Set());

const uiContractsFromSchemaInternal = (
  schema: JSONSchema | undefined,
  root: JSONSchema | undefined,
  path: string[],
  seenRefs: Set<string>,
  conditional = false,
): UiContractEntry[] => {
  const branchRefs = new Set(seenRefs);
  const resolvedSchema = followSchemaRef(schema, root, branchRefs);
  if (resolvedSchema !== schema && schema !== undefined) {
    const resolvedRoot = resolvedRootFor(
      schema,
      resolvedSchema ?? schema,
      root,
    );
    return uiContractsFromSchemaInternal(
      resolvedSchema,
      resolvedRoot,
      path,
      seenRefsBelow(branchRefs, root, resolvedRoot),
      conditional,
    );
  }
  if (!isObjectOrArray(resolvedSchema)) {
    return [];
  }

  const childRoot = root ?? resolvedSchema;
  const entries: UiContractEntry[] = [];
  const contract = uiContractFromSchemaInternal(
    resolvedSchema,
    childRoot,
    new Set(),
  );
  if (contract !== undefined) {
    entries.push(
      uiContractEntry(
        [...path],
        contract,
        resolvedSchema,
        childRoot,
        conditional,
      ),
    );
  }

  const hasProperties = isObjectOrArray(resolvedSchema.properties);
  const hasCompoundSchemas = Array.isArray(resolvedSchema.anyOf) ||
    Array.isArray(resolvedSchema.oneOf) ||
    Array.isArray(resolvedSchema.allOf);
  const hasItems = isObjectOrArray(resolvedSchema.items) ||
    typeof resolvedSchema.items === "boolean";
  // prefixItems counts as children too (PR #4969 review): an unknown-typed
  // tuple with a contract-bearing $defs entry must not mint that contract
  // at the array's own path — the slot that references the definition mints
  // it at its index via the descent below.
  const hasPrefixItems = Array.isArray(resolvedSchema.prefixItems);
  if (
    contract === undefined &&
    !hasProperties &&
    !hasCompoundSchemas &&
    !hasItems &&
    !hasPrefixItems &&
    resolvedSchema.type === "unknown" &&
    isObjectOrArray(resolvedSchema.$defs)
  ) {
    const definitionContracts = Object.values(resolvedSchema.$defs)
      .flatMap((definition) =>
        uiContractsFromSchemaInternal(
          definition as JSONSchema,
          definition as JSONSchema,
          [],
          new Set(),
        )
      )
      .map((entry) => entry.contract);
    if (definitionContracts.length === 1) {
      entries.push(
        uiContractEntry(
          [...path],
          definitionContracts[0],
          undefined,
          undefined,
          conditional,
        ),
      );
    }
  }

  if (hasProperties) {
    for (const [key, child] of Object.entries(resolvedSchema.properties)) {
      entries.push(
        ...uiContractsFromSchemaInternal(
          child as JSONSchema,
          childRoot,
          [...path, key],
          seenRefs,
          conditional,
        ),
      );
    }
  }

  const compound: [JSONSchema, boolean][] = [
    ...(Array.isArray(resolvedSchema.anyOf) ? resolvedSchema.anyOf : []),
    ...(Array.isArray(resolvedSchema.oneOf) ? resolvedSchema.oneOf : []),
  ].map((child) => [child as JSONSchema, true]);
  for (
    const child of Array.isArray(resolvedSchema.allOf)
      ? resolvedSchema.allOf
      : []
  ) {
    compound.push([child as JSONSchema, conditional]);
  }
  for (const [child, childConditional] of compound) {
    entries.push(
      ...uiContractsFromSchemaInternal(
        child,
        childRoot,
        path,
        seenRefs,
        childConditional,
      ),
    );
  }

  // `items` keeps its `*` entry even beside prefixItems, mirroring
  // walkIfcSchema (PR #4969 review): the `*` over-enforces the rest
  // contract on tuple slots, but minting nothing would silently drop the
  // tail elements' declared contract — fail-open, strictly worse. A
  // precise "past the slots" representation needs a path grammar beyond
  // `*`.
  if (
    isObjectOrArray(resolvedSchema.items) ||
    typeof resolvedSchema.items === "boolean"
  ) {
    entries.push(
      ...uiContractsFromSchemaInternal(
        resolvedSchema.items as JSONSchema,
        childRoot,
        [...path, "*"],
        seenRefs,
        conditional,
      ),
    );
  }

  if (Array.isArray(resolvedSchema.prefixItems)) {
    for (let index = 0; index < resolvedSchema.prefixItems.length; index++) {
      entries.push(
        ...uiContractsFromSchemaInternal(
          resolvedSchema.prefixItems[index] as JSONSchema,
          childRoot,
          [...path, String(index)],
          seenRefs,
          conditional,
        ),
      );
    }
  }

  return entries;
};

export const uiContractsFromSchema = (
  schema: JSONSchema | undefined,
): UiContractEntry[] =>
  uiContractsFromSchemaInternal(schema, schema, [], new Set());

export const trustedEventProvenanceMatchesUiContract = (
  provenance: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isTrustedDomProvenance(provenance)) {
    return false;
  }
  if (
    contract.trustedPattern !== undefined ||
    (contract.requiredEventIntegrity?.length ?? 0) > 0
  ) {
    if (!isObjectOrArray(provenance.ui)) {
      return false;
    }
    if (
      contract.trustedPattern !== undefined &&
      provenance.ui.pattern !== contract.trustedPattern
    ) {
      return false;
    }
    if ((contract.requiredEventIntegrity?.length ?? 0) > 0) {
      const labels = provenance.ui.eventIntegrity;
      if (!Array.isArray(labels)) {
        return false;
      }
      const presentLabels = new Set(
        labels.filter((label): label is string => typeof label === "string"),
      );
      if (
        contract.requiredEventIntegrity?.some((label) =>
          !presentLabels.has(label)
        )
      ) {
        return false;
      }
    }
  }
  return true;
};

export const recordedTrustedEventProvenanceMatchesUiContract = (
  provenance: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (!trustedEventProvenanceMatchesUiContract(provenance, contract)) {
    return false;
  }
  const dataset = isObjectOrArray(provenance) && isObjectOrArray(provenance.ui)
    ? provenance.ui.uiContractDataset
    : undefined;
  if (!isObjectOrArray(dataset)) {
    return false;
  }

  switch (contract?.helper) {
    case "UiAction":
      return dataset.uiAction === contract.action;
    case "UiPromptSlot":
      return dataset.uiSurface === contract.surface &&
        (contract.role === undefined || dataset.uiRole === contract.role);
    case "UiDisclosure":
      return dataset.uiDisclosureKind === contract.kind;
    default:
      return false;
  }
};

export const trustedEventMatchesUiContract = (
  event: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isObjectOrArray(event)) {
    return false;
  }
  const serializedEvent = event as SerializedTrustedEvent;
  if (!isRendererTrustedEvent(event)) {
    return false;
  }
  return recordedTrustedEventProvenanceMatchesUiContract(
    serializedEvent.provenance,
    contract,
  );
};

const trustedEventMatchCandidates = (event: unknown): unknown[] => {
  const candidates: unknown[] = [];
  const sourceIsRendererTrusted = isRendererTrustedEvent(event);
  const add = (candidate: unknown) => {
    if (candidate !== undefined && !candidates.includes(candidate)) {
      if (sourceIsRendererTrusted) {
        markRendererTrustedEvent(candidate);
      }
      candidates.push(candidate);
    }
  };

  add(event);
  try {
    add(findAndInlineDataUriLinks(event));
  } catch {
    // Invalid data URI links cannot establish trusted provenance.
  }

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!isObjectOrArray(candidate)) {
      continue;
    }
    if ("$event" in candidate) {
      add(candidate.$event);
    }
    if (isObjectOrArray(candidate.value) && "$event" in candidate.value) {
      add(candidate.value.$event);
    }
  }

  return candidates;
};

const pathsEqual = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((segment, index) => String(segment) === String(right[index]));

export const pathPatternMatches = (
  pattern: readonly unknown[],
  path: readonly unknown[],
): boolean =>
  pattern.length === path.length &&
  pattern.every((segment, index) =>
    String(segment) === "*" || String(segment) === String(path[index])
  );

const pathHasPrefix = (
  path: readonly unknown[],
  prefix: readonly unknown[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => String(segment) === String(path[index]));

const targetMatchesWrite = (
  target: CfcAddress,
  write: AddressLike,
): boolean =>
  target.space === write.space &&
  target.id === write.id &&
  target.scope === write.scope &&
  pathsEqual(target.path, write.path);

const sameDocument = (
  target: CfcAddress,
  write: AddressLike,
): boolean =>
  target.space === write.space &&
  target.id === write.id &&
  target.scope === write.scope;

/**
 * The contracts the write's stored envelope declares at a path above or below
 * the write rather than at it. The commit boundary judges a write against a
 * contract wherever the two paths overlap, and looks for the evidence at the
 * contract's own path, so that is where it is recorded.
 */
const storedContractsAroundWrite = (
  write: NormalizedFullLink,
  storedSchemaFor: StoredSchemaResolver,
): UiContractEntry[] =>
  uiContractsFromSchema(storedSchemaFor(write)).filter((entry) =>
    !pathPatternMatches(entry.path, write.path) &&
    pathsOverlap(entry.path, write.path)
  );

// Whether one path, `*` matching any segment, lies on the other's line of
// descent: equal, or one a prefix of the other.
const pathsOverlap = (
  pattern: readonly unknown[],
  path: readonly unknown[],
): boolean =>
  pattern.every((segment, index) =>
    index >= path.length || String(segment) === "*" ||
    String(segment) === String(path[index])
  );

const contractCandidatesForWrite = (
  tx: TrustedEventPolicyTx,
  write: NormalizedFullLink,
  storedSchemaFor: StoredSchemaResolver,
): UiContract[] => {
  const contracts: UiContract[] = [];
  if (write.schema !== undefined) {
    for (const entry of uiContractsFromSchema(write.schema)) {
      if (
        pathsEqual(entry.path, []) || pathPatternMatches(entry.path, write.path)
      ) {
        contracts.push(entry.contract);
      }
    }
  }
  // The contract the document stores binds every writer, including one
  // whose own schema declares a label without restating the contract, and
  // the commit boundary verifies the write against it. Matching the event
  // here is what records the evidence that check looks for.
  for (const entry of uiContractsFromSchema(storedSchemaFor(write))) {
    if (pathPatternMatches(entry.path, write.path)) {
      contracts.push(entry.contract);
    }
  }
  for (const input of tx.getCfcState().writePolicyInputs) {
    if (
      input.kind === "schema" &&
      input.schema !== undefined &&
      sameDocument(input.target, write) &&
      pathHasPrefix(write.path, input.target.path)
    ) {
      for (const entry of uiContractsFromSchema(input.schema)) {
        if (
          pathPatternMatches([...input.target.path, ...entry.path], write.path)
        ) {
          contracts.push(entry.contract);
        }
      }
    }
  }
  return contracts;
};

const eventEnvelopePayloads = (
  event: unknown,
): Array<{ value: unknown; space?: string }> => {
  const payloads: Array<{ value: unknown; space?: string }> = [];
  const addPayload = (value: unknown, space?: string) => {
    if (
      !payloads.some((payload) =>
        Object.is(payload.value, value) && payload.space === space
      )
    ) {
      payloads.push({ value, ...(space !== undefined ? { space } : {}) });
    }
  };

  addPayload(event);
  if (isObjectOrArray(event) && "value" in event) {
    addPayload(event.value);
  }
  try {
    const eventLink = parseLink(event);
    if (eventLink?.id && isFabricDataUri(eventLink.id)) {
      const decoded = valueFromDataUri(eventLink.id);
      addPayload(decoded, eventLink.space);
    }
  } catch {
    // Invalid data URI links cannot provide authoring context.
  }

  return payloads;
};

// Helper for the (dormant — see `contractCandidatesFromEventContext`) `$ctx`
// path. Binding lowers handler context props one level at a time but preserves
// the surrounding object/array structure (see `unwrapOneLevelAndBindToDoc`), so a
// contract-bearing link can sit nested inside a `$ctx` entry (e.g.
// `myHandler({ config: { savedTitle: state.x } })`) rather than at its top
// level. Walk plain objects/arrays to collect every reachable bound link. A
// sigil link is always a leaf: never descend into its envelope, even when it
// is rejected below — its internals are not addressable `$ctx` links.
// (`$alias` records are not links and are walked as ordinary data.) Only an
// absolute (full) link contributes a candidate; parse
// WITHOUT a base so a relative link stays relative and fails the full-link
// check, rather than inheriting the write target's id/space/scope (which would
// make the same-document guard vacuous).
const collectContextLinks = (
  value: unknown,
  seen: Set<unknown>,
  depth: number,
  out: NormalizedFullLink[],
): void => {
  if (depth > 16) {
    return;
  }
  const parsedLink = parseLink(value);
  if (parsedLink !== undefined) {
    if (isNormalizedFullLink(parsedLink)) {
      out.push(parsedLink);
    }
    return;
  }
  if (!isObjectOrArray(value)) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectContextLinks(child, seen, depth + 1, out);
  }
};

// DORMANT / forward-looking: no production caller currently reaches this.
// `recordTrustedEventPolicyInputs` is invoked with the bare sent event value
// (the handler's `$event`), never the `{ $ctx, $event }` argument envelope — the
// handler's `$ctx` is read separately by the action (see `runner.ts`, the
// `$ctx`/`$event` split in `invokeJavaScriptImplementation`) and is never handed
// to enforcement. So `payload.value.$ctx` is empty on every live path, and this
// function returns no contracts in production; it is exercised only by unit
// tests that hand-build a context envelope. It is kept as scaffolding for a
// future path that would feed the argument envelope here (which would let a
// contract be discovered via a contract-bearing `$ctx` link rather than only via
// the write's own schema). Until such a caller exists, a UI contract reachable
// ONLY through `$ctx` is NOT enforced at runtime.
//
// The shape it assumes: a `$ctx` link that addresses the write target carries
// the schema (and thus any uiContract) for that write. At handler-execution time
// these would be bound sigil links that already address an absolute document, so
// a link only contributes a contract when it points into the same document as
// `write`.
const contractCandidatesFromEventContext = (
  event: unknown,
  write: NormalizedFullLink,
): UiContract[] => {
  const contracts: UiContract[] = [];
  for (const payload of eventEnvelopePayloads(event)) {
    if (
      !isObjectOrArray(payload.value) || !isObjectOrArray(payload.value.$ctx)
    ) {
      continue;
    }
    const links: NormalizedFullLink[] = [];
    collectContextLinks(payload.value.$ctx, new Set(), 0, links);
    for (const link of links) {
      if (
        link.id !== write.id ||
        link.space !== write.space ||
        (link.scope ?? "space") !== (write.scope ?? "space") ||
        !pathHasPrefix(write.path, link.path)
      ) {
        continue;
      }
      for (const entry of uiContractsFromSchema(link.schema)) {
        if (pathPatternMatches([...link.path, ...entry.path], write.path)) {
          contracts.push(entry.contract);
        }
      }
    }
  }
  return contracts;
};

const trustedEventPolicyInputAlreadyRecorded = (
  tx: TrustedEventPolicyTx,
  target: CfcAddress,
  eventId: string,
): boolean =>
  tx.getCfcState().writePolicyInputs.some((input) =>
    input.kind === "trusted-event" &&
    input.eventId === eventId &&
    targetMatchesWrite(input.target, target)
  );

const trustedEventId = (
  event: unknown,
  write: NormalizedFullLink,
): string =>
  `trusted-event:${
    String((event as { type?: string }).type ?? "event")
  }:${write.id}:${write.path.join("/")}`;

export const recordTrustedEventPolicyInputs = (
  tx: TrustedEventPolicyTx,
  writes: readonly NormalizedFullLink[],
  event: unknown,
  storedSchemaFor: StoredSchemaResolver,
): void => {
  for (const write of writes) {
    const contracts = [
      ...contractCandidatesForWrite(tx, write, storedSchemaFor),
      ...contractCandidatesFromEventContext(event, write),
    ];
    for (const contract of contracts) {
      const matchingEvent = trustedEventMatchCandidates(event).find(
        (candidate) => trustedEventMatchesUiContract(candidate, contract),
      );
      if (matchingEvent === undefined) {
        continue;
      }
      const target = {
        space: write.space,
        id: write.id,
        scope: write.scope,
        path: [...write.path],
      };
      const eventId = trustedEventId(matchingEvent, write);
      if (trustedEventPolicyInputAlreadyRecorded(tx, target, eventId)) {
        break;
      }
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target,
        eventId,
        provenance: (matchingEvent as SerializedTrustedEvent).provenance,
      });
      break;
    }
    for (const entry of storedContractsAroundWrite(write, storedSchemaFor)) {
      const matchingEvent = trustedEventMatchCandidates(event).find(
        (candidate) => trustedEventMatchesUiContract(candidate, entry.contract),
      );
      if (matchingEvent === undefined) continue;
      const at = { ...write, path: [...entry.path] };
      const target = {
        space: write.space,
        id: write.id,
        scope: write.scope,
        path: [...entry.path],
      };
      const eventId = trustedEventId(matchingEvent, at);
      if (trustedEventPolicyInputAlreadyRecorded(tx, target, eventId)) continue;
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target,
        eventId,
        provenance: (matchingEvent as SerializedTrustedEvent).provenance,
      });
    }
  }
};
