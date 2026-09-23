/**
 * Well-known grants: handle tokens the harness seeds into a run's handle
 * table for references every run on this console is entitled to hold, before
 * the model asks for anything. Two kinds. The session space's piece registry
 * — the discovery root behind `cf piece ls` and the shell's listings — is
 * what lets an agent find pieces to compute over without an operator handing
 * it references one by one. Beside it stand the connector handles the console
 * was launched against, so a session reaches the databases its fabric holds
 * without a caller attaching them per task.
 *
 * A grant discloses nothing by itself. What the model receives is a token and
 * a harness-authored sentence saying what the token names; the address stays
 * trusted-side in the handle table, `describe_handle` answers shape, and
 * reading anything behind the token means running a pattern over it, where
 * the CFC boundary rules as it does for every other flow.
 *
 * Connection identities and CFC classes come from the operator's Loom
 * records. Each is validated before interpolation into model-facing text.
 * The name selects a store; its classes describe the data that store holds.
 */

import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { HarnessFabricSession } from "./fabric-session.ts";
import { createHarnessHandleTable, mintAddressHandle } from "./handle-table.ts";
import { HANDLE_NAME_PATTERN } from "./input-cells.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type {
  HarnessConnectorGrantSource,
  HarnessConnectorGrantSpec,
  HarnessWellKnownGrant,
  HarnessWellKnownGrantName,
} from "./contracts/well-known-grants.ts";

export type {
  HarnessConnectorGrantSource,
  HarnessConnectorGrantSpec,
  HarnessWellKnownGrant,
  HarnessWellKnownGrantName,
} from "./contracts/well-known-grants.ts";

/**
 * Model-facing description of each fixed grant. Harness-authored text — a
 * fixed grant's description never carries anything read from the fabric or
 * from the machine.
 */
const GRANT_DESCRIPTIONS: Record<HarnessWellKnownGrantName, string> = {
  "piece-registry":
    "the space's piece registry: an array of references to every registered piece. Wire it into run_pattern `inputs` to compute over what the space holds — each entry's `$NAME` field is its display name. A name computed from protected data taints a result that reads it, so a refused name read leaves the name unknown. For an explicit reference-listing task, a pattern can return entry references without reading values; that is not a fallback for identifying an unspecified target.",
};

const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const COMPANION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isDescriptionText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** Whether a receipt observation is an ISO8601 timestamp with an explicit zone. */
export const isConnectorObservationTimestamp = (
  value: unknown,
): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
    .test(value) &&
  Number.isFinite(Date.parse(value));

/** The Loom store identity, independent of which piece exposes it. */
export const connectorGrantName = (
  source: HarnessConnectorGrantSource,
): string =>
  source.companionKey === undefined
    ? source.connection
    : `${source.connection}#${source.companionKey}`;

/** Reads class metadata, including the singular and class-named record forms. */
const connectorGrantClasses = (grant: HarnessConnectorGrantSpec): string[] =>
  grant.cfcClasses !== undefined
    ? grant.cfcClasses
    : [grant.cfcClass !== undefined ? grant.cfcClass : grant.name];

/** Human-readable connection and classes, shared by prompts and launch reports. */
export const connectorGrantLabel = (grant: HarnessConnectorGrantSpec): string =>
  `${grant.source.connection}${
    grant.source.companionKey === undefined
      ? ""
      : ` / ${grant.source.companionKey}`
  } (${connectorGrantClasses(grant).join(", ")})`;

/** Describes the receipt's account state, quoting provider text as data. */
const connectorViewerDescription = (
  viewer: HarnessConnectorGrantSpec["viewer"],
): string => {
  if (viewer === undefined) {
    return "not recorded in the injection receipt";
  }
  if (viewer.identity === "none") {
    return `no account (${JSON.stringify(viewer.reason)})`;
  }
  if (viewer.identity === "conflicting") {
    return "conflicting injection receipts";
  }
  if (viewer.identity === "unknown") {
    return viewer.reason === undefined
      ? "unknown"
      : `unknown (${JSON.stringify(viewer.reason)})`;
  }
  const identity = viewer.sourceId ?? viewer.email ?? viewer.label;
  const parts = [
    identity === undefined
      ? `account (${
        viewer.reason === undefined
          ? "provider identity not reported"
          : JSON.stringify(viewer.reason)
      })`
      : JSON.stringify(identity),
  ];
  if (viewer.email === null) {
    parts.push("no email address");
  } else if (viewer.email !== undefined && viewer.email !== identity) {
    parts.push(`email ${JSON.stringify(viewer.email)}`);
  }
  if (viewer.label !== undefined && viewer.label !== identity) {
    parts.push(`label ${JSON.stringify(viewer.label)}`);
  }
  return parts.join("; ");
};

/** Describes observation time without substituting receipt or content time. */
const connectorObservationDescription = (
  observation: HarnessConnectorGrantSpec["observation"],
): string => {
  if (observation === undefined) {
    return "unknown (not reported by the injection receipt)";
  }
  if (observation.newestAt !== null) {
    return new Date(observation.newestAt).toISOString();
  }
  return observation.reason === "no-rows"
    ? "none (empty store)"
    : `unknown (${JSON.stringify(observation.reason)})`;
};

/**
 * Describes a connector using validated identity, classes, and receipt metadata.
 */
const connectorGrantDescription = (grant: HarnessConnectorGrantSpec): string =>
  `${
    connectorGrantLabel(grant)
  }: a read-only connector database whose columns carry \`${
    connectorGrantClasses(grant).join("`, `")
  }\` CFC labels. Account identity: ${
    connectorViewerDescription(grant.viewer)
  }. Physical rows at injection: ${
    grant.rowCount ?? "unknown"
  } (including metadata and history). Newest observed at: ${
    connectorObservationDescription(grant.observation)
  } (when Loom observed a record, not its content time). Wire it into run_pattern \`inputs\` and read it with \`db.query\`; use describe_handle first to see its tables and how full each column is, because a column that is empty for every row is a filter that returns nothing. Refer to the connection by its human name when speaking to the user, never by a handle token.`;

/**
 * The name a model may be handed for `grant` beside its token: a connector
 * grant's connection label, or a fixed grant's own name. Both are names this
 * module already pairs with the token in the grant context, so nothing new
 * crosses to a model given one.
 */
export const wellKnownGrantLabel = (grant: HarnessWellKnownGrant): string => {
  if (grant.source === undefined) {
    return grant.name;
  }
  // Checked here as every other model-facing use of a connector grant checks
  // it: the record may be run state this process did not write.
  checkConnectorGrantSpec(grant);
  return connectorGrantLabel(grant);
};

/**
 * Holds one connector grant to the rule its handle is minted under: a name
 * of the shape a model may be handed, and a reference naming an entity. The
 * launcher that resolves these checks them against the record they came from
 * and says which record is wrong; this is the belt on the seeding itself, for
 * a console configured by something other than that launcher.
 *
 * @throws Error naming the connector grant and the defect.
 */
export const checkConnectorGrantSpec = (
  spec: HarnessConnectorGrantSpec,
): void => {
  if (
    spec.source.connection.trim() === "" || spec.source.piece.trim() === ""
  ) {
    throw new Error(
      `connector grant \`${spec.name}\` records no connection and piece`,
    );
  }
  if (!CONNECTION_NAME_PATTERN.test(spec.source.connection)) {
    throw new Error(
      `connector connection must match ${CONNECTION_NAME_PATTERN}`,
    );
  }
  if (
    spec.source.companionKey !== undefined &&
    (typeof spec.source.companionKey !== "string" ||
      !COMPANION_KEY_PATTERN.test(spec.source.companionKey))
  ) {
    throw new Error(
      `connector companion key must match ${COMPANION_KEY_PATTERN}`,
    );
  }
  if (
    spec.cfcClasses === undefined && spec.cfcClass === undefined &&
    !HANDLE_NAME_PATTERN.test(spec.name)
  ) {
    throw new Error(
      `connector grant name must match ${HANDLE_NAME_PATTERN}, got \`${spec.name}\``,
    );
  }
  if (spec.cfcClasses !== undefined && spec.cfcClass !== undefined) {
    throw new Error("connector grant must carry only one class metadata field");
  }
  if (spec.cfcClasses !== undefined || spec.cfcClass !== undefined) {
    const classes = connectorGrantClasses(spec);
    if (
      !Array.isArray(classes) || classes.length === 0 ||
      classes.some((value) =>
        typeof value !== "string" || !HANDLE_NAME_PATTERN.test(value)
      )
    ) {
      throw new Error(`connector CFC class must match ${HANDLE_NAME_PATTERN}`);
    }
    if (spec.name !== connectorGrantName(spec.source)) {
      throw new Error(
        "connector grant name must match its connection and companion key",
      );
    }
  }
  if (
    spec.rowCount !== undefined &&
    (!Number.isSafeInteger(spec.rowCount) || spec.rowCount < 0)
  ) {
    throw new Error("connector row count must be a nonnegative safe integer");
  }
  const viewer = spec.viewer;
  if (
    viewer !== undefined &&
    (!isObjectNotArray(viewer) ||
      (viewer.identity !== "account" && viewer.identity !== "none" &&
        viewer.identity !== "unknown" && viewer.identity !== "conflicting") ||
      (viewer.identity === "conflicting" && viewer.reason !== undefined) ||
      (viewer.reason !== undefined && !isDescriptionText(viewer.reason)) ||
      (viewer.identity === "account"
        ? (viewer.sourceId !== undefined &&
          !isDescriptionText(viewer.sourceId)) ||
          (viewer.email != null && !isDescriptionText(viewer.email)) ||
          (viewer.label !== undefined && !isDescriptionText(viewer.label))
        : viewer.identity === "none" && !isDescriptionText(viewer.reason)))
  ) {
    throw new Error(
      "connector viewer must record account, none, unknown, or conflicting with nonempty string metadata",
    );
  }
  const observation = spec.observation;
  if (
    observation !== undefined &&
    (!isObjectNotArray(observation) ||
      (observation.newestAt === null
        ? !isDescriptionText(observation.reason)
        : !isConnectorObservationTimestamp(observation.newestAt) ||
          observation.reason !== undefined))
  ) {
    throw new Error(
      "connector observation must name a timestamp or explain its absence",
    );
  }
  if (spec.ref.trim() === "") {
    throw new Error(`connector grant \`${spec.name}\` names no reference`);
  }
};

/**
 * Holds a grant RECORDED in run state to the rule it was minted under.
 *
 * Run state is JSON this process may not have written — a resumed run reads a
 * file — so a connector grant can arrive here having never passed the
 * launcher's checks, and its name is interpolated into model-facing text.
 * Checking it on the way out of the record is what keeps the resume path and
 * the mint path under one rule.
 *
 * @throws Error naming the grant and the defect.
 */
export const checkRecordedWellKnownGrant = (
  grant: HarnessWellKnownGrant,
): void => {
  if (grant.source === undefined) {
    return;
  }
  checkConnectorGrantSpec(grant);
};

/**
 * One grant's name and address, before any token exists for it — the same
 * two kinds {@link HarnessWellKnownGrant} has, so the mint cannot lose track
 * of which it is holding.
 */
export type HarnessWellKnownGrantRef =
  | { name: HarnessWellKnownGrantName; ref: string; source?: undefined }
  | HarnessConnectorGrantSpec;

/**
 * Resolves the canonical references behind every well-known grant. The
 * registry's comes from `session`: its resolution reads the default pattern's
 * root pointer and appends its `pieceRegistry` path, and it does not read the
 * registry contents. A connector grant's came from the console's
 * configuration and is checked rather than resolved, the console having
 * already read it off the loom instance it was launched against.
 *
 * `getPieceRegistry()` is deliberately not used here. It syncs every listed
 * piece, which is a privileged data pull that address resolution does not
 * need. In a space with no default pattern, it also returns a detached
 * placeholder that would persist as a permanently dead grant.
 *
 * @throws Error when the space has no default pattern to anchor the
 * registry, or when a connector grant is malformed; a grant that cannot name
 * a live address is refused rather than recorded.
 */
export const resolveWellKnownGrantRefs = async (
  session: HarnessFabricSession,
  connectorGrants: readonly HarnessConnectorGrantSpec[] = [],
): Promise<HarnessWellKnownGrantRef[]> => {
  const defaultPattern = await session.pieces.getDefaultPattern(false);
  if (defaultPattern === undefined) {
    throw new Error(
      "space has no default pattern to anchor the piece registry",
    );
  }
  const registryLink = defaultPattern
    .key("pieceRegistry")
    .getAsNormalizedFullLink();
  const refs: HarnessWellKnownGrantRef[] = [{
    name: "piece-registry",
    ref: createLLMFriendlyLink(registryLink, session.pieces.getSpace()),
  }];
  const names = new Set(refs.map((entry) => entry.name));
  for (const spec of connectorGrants) {
    checkConnectorGrantSpec(spec);
    if (names.has(spec.name)) {
      throw new Error(`well-known grants name \`${spec.name}\` twice`);
    }
    names.add(spec.name);
    refs.push({ ...spec });
  }
  return refs;
};

/**
 * Mints a handle for each resolved grant into `table` (or a fresh table
 * salted with `runId` when the run has none yet), returning the extended
 * table and the grant records for run state.
 */
export const mintWellKnownGrants = async (
  table: HarnessHandleTable | undefined,
  runId: string,
  refs: readonly HarnessWellKnownGrantRef[],
): Promise<{ table: HarnessHandleTable; grants: HarnessWellKnownGrant[] }> => {
  let current = table ?? createHarnessHandleTable(runId);
  const grants: HarnessWellKnownGrant[] = [];
  for (const grant of refs) {
    const minted = await mintAddressHandle(current, grant.ref);
    current = minted.table;
    // The entry's canonical spelling rather than the one the caller passed,
    // so the run-state record and the table entry name one reference. A
    // connector grant's arrives from a loom record and need not be canonical.
    const entry = current.entries.find(
      (candidate) => candidate.token === minted.token,
    )!;
    grants.push(
      grant.source === undefined
        ? { name: grant.name, token: minted.token, ref: entry.ref }
        : {
          name: grant.name,
          ...(grant.cfcClasses === undefined
            ? {}
            : { cfcClasses: grant.cfcClasses }),
          ...(grant.cfcClass === undefined ? {} : { cfcClass: grant.cfcClass }),
          ...(grant.rowCount === undefined ? {} : { rowCount: grant.rowCount }),
          ...(grant.viewer === undefined ? {} : { viewer: grant.viewer }),
          ...(grant.observation === undefined
            ? {}
            : { observation: grant.observation }),
          token: minted.token,
          ref: entry.ref,
          source: grant.source,
        },
    );
  }
  return { table: current, grants };
};

/**
 * The sentence announcing one grant. A connector grant is the case a
 * `source` marks, and the only one whose text names something read off the
 * machine; every other name is one this module authored, so a name that is
 * neither is a grant nobody wrote a description for and is refused rather
 * than announced as an empty phrase.
 *
 * @throws Error naming the grant whose description is missing.
 */
const grantDescription = (grant: HarnessWellKnownGrant): string => {
  if (grant.source !== undefined) {
    checkConnectorGrantSpec(grant);
    return connectorGrantDescription(grant);
  }
  // Read through `Object.hasOwn` rather than indexed directly: run state is
  // JSON this process may not have written, so a resumed record can carry a
  // name no build of this module describes, and the type that rules that out
  // for a grant we mint says nothing about one we read back.
  if (!Object.hasOwn(GRANT_DESCRIPTIONS, grant.name)) {
    throw new Error(`no description for well-known grant \`${grant.name}\``);
  }
  return GRANT_DESCRIPTIONS[grant.name];
};

/**
 * The context message announcing `grants` to the model: one line per grant,
 * each pairing the token with its description. An empty grant list yields no
 * message at all rather than an empty header.
 */
export const wellKnownGrantsContextMessage = (
  grants: readonly HarnessWellKnownGrant[],
): string | undefined => {
  if (grants.length === 0) {
    return undefined;
  }
  return [
    "Granted references for this run's Fabric space:",
    ...grants.map((grant) => `- ${grant.token} — ${grantDescription(grant)}`),
    "Use describe_handle on a granted token to see its shape before authoring against it.",
  ].join("\n");
};
