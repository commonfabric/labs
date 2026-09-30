/**
 * The connector handles a loom instance has injected into its space, read as
 * grants the console seeds into every session it runs.
 *
 * Two of that instance's records decide a grant, and neither is enough alone.
 * `sqlite-injection/handles.json` — the receipt the daemon's reconciler writes,
 * and what `loom connector handles` prints — says which handles exist and what
 * each one's reference is, but records no label class. `pieces.json` declares
 * each connector piece's `sqlite_sources`, whose table contract carries the
 * per-column `ifc` the daemon seeded, and that is where a handle's CFC classes are
 * written down. They join on piece, connection, and companion key. Connection
 * identity names a grant; its declared CFC classes describe what it holds.
 *
 * A handle whose class cannot be read is not guessed at and not granted: it is
 * returned as unnamed, with the reason, for the launcher to print. A console
 * that silently held one fewer reference than its report claimed would be the
 * failure this whole launch path exists to prevent.
 */

import { renderCellReference } from "@commonfabric/runner/shared";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { parseHandleRef } from "../src/handle-table.ts";
import type { HarnessConnectorGrantSpec } from "../src/contracts/well-known-grants.ts";
import { HARNESS_WELL_KNOWN_GRANT_NAMES } from "../src/contracts/well-known-grants.ts";
import {
  checkConnectorGrantSpec,
  connectorGrantName,
  isConnectorObservationTimestamp,
} from "../src/well-known-grants.ts";

/** The CFC atom type whose `class` names what a column holds. */
const RESOURCE_ATOM_TYPE = "https://commonfabric.org/cfc/atom/Resource";

/**
 * Names the harness grants on its own. A connection identity landing on one of
 * these is reported here rather than passed on, because the seeding refuses a
 * name twice and would take every session on the console down with it.
 */
const RESERVED_GRANT_NAMES: ReadonlySet<string> = new Set<string>(
  HARNESS_WELL_KNOWN_GRANT_NAMES,
);

/** The loom records a connector grant is resolved from. */
export interface LoomConnectorRecords {
  /** The verbatim `sqlite-injection/handles.json`, when the file exists. */
  handlesJson?: string;

  /** The absolute path it was read from, for error text. */
  handlesJsonPath: string;

  /** The verbatim `pieces.json`. */
  piecesJson: string;

  /** The absolute path it was read from, for error text. */
  piecesJsonPath: string;
}

/** A handle the records name but could not be granted, and why. */
export interface UnnamedConnectorHandle {
  connection: string;
  companionKey?: string;
  piece: string;
  reason: string;

  /** Operator action that addresses the refusal. */
  remedy: string;

  /** Whether the records establish a refusal or leave the handle unreadable. */
  state: "degraded" | "unknown";
}

/** What the records yielded: the grants to seed, and what they left out. */
export interface ResolvedConnectorGrants {
  grants: HarnessConnectorGrantSpec[];
  unnamed: UnnamedConnectorHandle[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isObjectNotArray(value) ? value as Record<string, unknown> : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * The distinct CFC classes one `sqlite_sources` entry's table contract
 * declares, in the order the contract states them. Reads only the `Resource`
 * atoms of each column's `ifc.confidentiality`: the owner principal beside
 * them names who the columns belong to rather than what they hold, and the
 * `ConnectorObserved` integrity beside that is provenance, so neither answers
 * the question of what the store holds.
 */
export const declaredClasses = (source: Record<string, unknown>): string[] => {
  const tables = asRecord(source.tables) ?? {};
  const classes: string[] = [];
  for (const table of Object.values(tables)) {
    const properties = asRecord(asRecord(table)?.properties) ?? {};
    for (const column of Object.values(properties)) {
      const confidentiality = asRecord(asRecord(column)?.ifc)?.confidentiality;
      if (!Array.isArray(confidentiality)) continue;
      for (const atom of confidentiality) {
        const record = asRecord(atom);
        if (record?.type !== RESOURCE_ATOM_TYPE) continue;
        const declared = asNonEmptyString(record.class);
        if (declared !== undefined && !classes.includes(declared)) {
          classes.push(declared);
        }
      }
    }
  }
  return classes;
};

/**
 * The key one injected handle is identified by on both sides of the join: the
 * piece, connection, and companion key Loom declares for the store.
 */
const handleKey = (
  piece: string,
  connection: string,
  companion: string,
): string => JSON.stringify([piece, connection, companion]);

/** Descriptive metadata published on one source receipt. */
type ConnectorReceiptMetadata = Pick<
  HarnessConnectorGrantSpec,
  "rowCount" | "viewer" | "observation"
>;

/** Keeps agreed metadata and marks disagreements without choosing one receipt. */
const mergeReceiptMetadata = (
  target: ConnectorReceiptMetadata,
  candidate: ConnectorReceiptMetadata,
): void => {
  if (target.rowCount !== candidate.rowCount) delete target.rowCount;
  if (!deepEqual(target.viewer, candidate.viewer)) {
    target.viewer = { identity: "conflicting" };
  }
  if (!deepEqual(target.observation, candidate.observation)) {
    target.observation = { newestAt: null, reason: "conflicting-receipts" };
  }
};

/** Reads source metadata by store identity, retaining agreement across repeats. */
const sourceReceiptMetadata = (
  rows: unknown,
): Map<string, ConnectorReceiptMetadata> => {
  const receipts = new Map<string, ConnectorReceiptMetadata>();
  if (!Array.isArray(rows)) return receipts;
  for (const row of rows) {
    const source = asRecord(row);
    const piece = asNonEmptyString(source?.piece);
    const connection = asNonEmptyString(source?.connection_id);
    const companion = asNonEmptyString(source?.companion_key);
    if (
      piece === undefined || connection === undefined ||
      (source?.companion_key !== undefined && companion === undefined)
    ) continue;
    const count = source?.row_count;
    const rowCount = source?.state === "linked" &&
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? count
      : undefined;
    const key = handleKey(piece, connection, companion ?? "");
    const viewer = receiptViewer(source?.viewer);
    const observation = receiptObservation(source);
    const metadata = {
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(viewer === undefined ? {} : { viewer }),
      ...(observation === undefined ? {} : { observation }),
    };
    const previous = receipts.get(key);
    if (previous === undefined) {
      receipts.set(key, metadata);
    } else {
      mergeReceiptMetadata(previous, metadata);
    }
  }
  return receipts;
};

/** Reads account identity without treating a local source as an unknown account. */
const receiptViewer = (
  value: unknown,
): HarnessConnectorGrantSpec["viewer"] => {
  const viewer = asRecord(value);
  const reason = asNonEmptyString(viewer?.absent_reason);
  if (viewer?.kind === "none") {
    return {
      identity: "none",
      reason: reason ?? "reason not reported",
    };
  }
  if (viewer?.kind === "unknown") {
    return {
      identity: "unknown",
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (viewer?.kind !== "account") {
    return undefined;
  }
  const sourceId = asNonEmptyString(viewer.source_id);
  const email = viewer.email === null ? null : asNonEmptyString(viewer.email);
  const label = asNonEmptyString(viewer.label);
  return {
    identity: "account",
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(email === undefined ? {} : { email }),
    ...(label === undefined ? {} : { label }),
    ...(reason === undefined ? {} : { reason }),
  };
};

/**
 * Reads record observation time and the receipt's reason when none is available.
 */
const receiptObservation = (
  receipt: Record<string, unknown> | undefined,
): HarnessConnectorGrantSpec["observation"] => {
  const newestAt = asNonEmptyString(receipt?.newest_observed_at);
  if (isConnectorObservationTimestamp(newestAt)) {
    return { newestAt: new Date(newestAt).toISOString() };
  }
  if (receipt?.newest_observed_at != null) return undefined;
  const reason = asNonEmptyString(receipt?.newest_observed_at_reason);
  return reason === undefined ? undefined : { newestAt: null, reason };
};

/**
 * The `sqlite_sources` entries `pieces.json` declares, keyed by
 * {@link handleKey}. The same tuple keys the receipt's entries, so this is the
 * whole of the join.
 */
const sourcesByHandle = (
  piecesJson: string,
  piecesJsonPath: string,
): Map<string, Record<string, unknown>[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(piecesJson);
  } catch (error) {
    throw new Error(
      `\`${piecesJsonPath}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const pieces = asRecord(parsed)?.pieces;
  const sources = new Map<string, Record<string, unknown>[]>();
  if (!Array.isArray(pieces)) {
    return sources;
  }
  for (const entry of pieces) {
    const piece = asRecord(entry);
    const name = asNonEmptyString(piece?.name);
    if (piece === undefined || name === undefined) continue;
    if (!Array.isArray(piece.sqlite_sources)) continue;
    for (const candidate of piece.sqlite_sources) {
      const source = asRecord(candidate);
      const connection = asNonEmptyString(source?.connection_id);
      if (source !== undefined && connection !== undefined) {
        if (
          source.companion_key !== undefined &&
          asNonEmptyString(source.companion_key) === undefined
        ) continue;
        const key = handleKey(
          name,
          connection,
          asNonEmptyString(source.companion_key) ?? "",
        );
        const entries = sources.get(key) ?? [];
        entries.push(source);
        sources.set(key, entries);
      }
    }
  }
  return sources;
};

/**
 * Resolves the grants a console launched against these records seeds, and the
 * handles it could not name.
 *
 * An absent receipt is no handles rather than an error: the daemon writes it
 * on its next reconcile pass, so a fabric that has never injected one has
 * nothing to read and nothing is wrong.
 *
 * @throws Error naming the record that does not parse. A malformed receipt is
 * not "no connectors": it is a record whose meaning is unknown, and a console
 * that started anyway would run every session one grant short while reporting
 * none missing.
 */
export const resolveConnectorGrants = (
  records: LoomConnectorRecords,
): ResolvedConnectorGrants => {
  if (records.handlesJson === undefined) {
    return { grants: [], unnamed: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(records.handlesJson);
  } catch (error) {
    throw new Error(
      `\`${records.handlesJsonPath}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const document = asRecord(parsed);
  if (document === undefined) {
    throw new Error(
      `\`${records.handlesJsonPath}\` does not hold a JSON object; loom ` +
        `writes {schema_version, written_at, space, handles, sources}`,
    );
  }
  const handles = document.handles;
  if (handles === undefined) {
    return { grants: [], unnamed: [] };
  }
  if (!Array.isArray(handles)) {
    throw new Error(
      `\`${records.handlesJsonPath}\` holds a \`handles\` that is not an array`,
    );
  }

  // The space the receipt itself names, which is the instance's. A handle
  // reference that carries a different one is not this instance's to grant.
  const receiptSpace = asNonEmptyString(document.space);
  const sources = sourcesByHandle(records.piecesJson, records.piecesJsonPath);
  const receipts = sourceReceiptMetadata(document.sources);
  const grants: HarnessConnectorGrantSpec[] = [];
  const unnamed: UnnamedConnectorHandle[] = [];
  const candidates = new Map<string, HarnessConnectorGrantSpec[]>();
  for (const entry of handles) {
    const handle = asRecord(entry);
    const connection = asNonEmptyString(handle?.connection_id) ?? "(unnamed)";
    const piece = asNonEmptyString(handle?.piece) ?? "(unnamed)";
    const companionKey = asNonEmptyString(handle?.companion_key);
    const grantSource = {
      connection,
      piece,
      ...(companionKey === undefined ? {} : { companionKey }),
    };
    const skip = (
      reason: string,
      remedy: string,
      state: "degraded" | "unknown" = "degraded",
    ): void => {
      unnamed.push({ ...grantSource, reason, remedy, state });
    };
    if (
      handle?.companion_key !== undefined &&
      companionKey === undefined
    ) {
      skip(
        "its companion key is not a non-empty string",
        "Repair this connector's injection receipt in Loom, then restart the console.",
        "unknown",
      );
      continue;
    }
    const ref = asNonEmptyString(handle?.handle_ref);
    if (ref === undefined) {
      skip(
        "the receipt records no `handle_ref` for it",
        "Reconcile this connector in Loom, then restart the console.",
        "unknown",
      );
      continue;
    }
    let link;
    try {
      link = parseHandleRef(ref);
    } catch {
      skip(
        "its `handle_ref` does not parse",
        "Repair this connector's injection receipt in Loom, then restart the console.",
        "unknown",
      );
      continue;
    }
    // A reference may carry its own space, and a grant is minted into the
    // session's. One naming another space would seed every session on this
    // console with a reference outside the authority the console runs under —
    // the boundary `--input-cell` is already held to, drawn here because the
    // receipt is a file rather than something an operator typed.
    if (link.space !== undefined && link.space !== receiptSpace) {
      // Fails closed when the receipt names no space of its own: a reference
      // that carries one is a claim about where it points, and with nothing to
      // check it against there is no reading on which granting it is safe.
      skip(
        receiptSpace === undefined
          ? `its \`handle_ref\` names space \`${link.space}\`, and the receipt ` +
            `names no space to check it against`
          : `its \`handle_ref\` names space \`${link.space}\`, which is not the ` +
            `space the receipt was written for`,
        "Reconcile the connector into the configured space, then restart the console.",
      );
      continue;
    }
    const matchingSources = sources.get(
      handleKey(piece, connection, companionKey ?? ""),
    );
    if (matchingSources === undefined) {
      skip(
        `\`${records.piecesJsonPath}\` declares no \`sqlite_sources\` entry ` +
          `for this piece, connection, and companion key`,
        "Declare this piece, connection, and companion key in pieces.json sqlite_sources, reconcile, and restart the console.",
      );
      continue;
    }
    if (matchingSources.length !== 1) {
      skip(
        "its piece declares multiple sources for the same connection and companion key",
        "Give each store a distinct companion_key in pieces.json, reconcile, and restart the console.",
      );
      continue;
    }
    const classes = declaredClasses(matchingSources[0]!);
    if (classes.length === 0) {
      skip(
        "its declared table contract carries no CFC class",
        "Declare the per-column ifc.confidentiality Resource class in this connector's sqlite_sources, then restart the console.",
      );
      continue;
    }
    const name = connectorGrantName(grantSource);
    if (RESERVED_GRANT_NAMES.has(name)) {
      skip(
        `its connection name \`${name}\` is a name the harness already grants`,
        "Rename this connection in Loom, then restart the console.",
      );
      continue;
    }
    const receipt = receipts.get(
      handleKey(piece, connection, companionKey ?? ""),
    );
    const viewer = receipt === undefined
      ? receiptViewer(handle?.viewer)
      : receipt.viewer;
    const grant: HarnessConnectorGrantSpec = {
      name,
      cfcClasses: classes,
      ...receipt,
      ...(viewer === undefined ? {} : { viewer }),
      ref: renderCellReference(link, { space: link.space, scope: "space" }),
      source: grantSource,
    };
    try {
      checkConnectorGrantSpec(grant);
    } catch (error) {
      skip(
        error instanceof Error ? error.message : String(error),
        "Correct the connection name, companion key, or CFC class in Loom, then restart the console.",
      );
      continue;
    }
    const entries = candidates.get(name) ?? [];
    entries.push(grant);
    candidates.set(name, entries);
  }
  for (const entries of candidates.values()) {
    const first = entries[0]!;
    if (
      entries.every((entry) =>
        entry.ref === first.ref &&
        entry.cfcClasses!.length === first.cfcClasses!.length &&
        entry.cfcClasses!.every((value) => first.cfcClasses!.includes(value))
      )
    ) {
      for (const entry of entries.slice(1)) {
        mergeReceiptMetadata(first, entry);
      }
      grants.push(first);
    } else {
      for (const entry of entries) {
        unnamed.push({
          ...entry.source,
          reason:
            "its connection and companion name identifies conflicting handles or classes",
          remedy:
            "Reconcile the connection's store declarations and receipts in Loom, then restart the console.",
          state: "degraded",
        });
      }
    }
  }
  return { grants, unnamed };
};

/**
 * The grants a launcher resolved, read back out of the environment variable
 * it passed them in. The launcher and the server are two processes, so the
 * variable is the whole of what crosses between them, and a value that does
 * not parse is a startup failure rather than zero grants: a console that came
 * up holding none while its launcher reported two is the silent
 * misconfiguration this path exists to rule out.
 *
 * @throws Error naming the variable and the defect.
 */
export const parseConnectorGrants = (
  json: string | undefined,
): HarnessConnectorGrantSpec[] => {
  if (json === undefined || json.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `\`CF_HARNESS_CONNECTOR_GRANTS\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "`CF_HARNESS_CONNECTOR_GRANTS` must hold an array of grants",
    );
  }
  return parsed.map((entry) => {
    const record = asRecord(entry);
    const name = asNonEmptyString(record?.name);
    const ref = asNonEmptyString(record?.ref);
    const source = asRecord(record?.source);
    const connection = asNonEmptyString(source?.connection);
    const piece = asNonEmptyString(source?.piece);
    const cfcClass = asNonEmptyString(record?.cfcClass);
    const companionKey = asNonEmptyString(source?.companionKey);
    if (
      name === undefined || ref === undefined || connection === undefined ||
      piece === undefined
    ) {
      throw new Error(
        "each `CF_HARNESS_CONNECTOR_GRANTS` entry needs a name, a ref, and " +
          "a source naming its connection and piece",
      );
    }
    if (
      (record?.cfcClass !== undefined && cfcClass === undefined) ||
      (source?.companionKey !== undefined && companionKey === undefined)
    ) {
      throw new Error(
        "`CF_HARNESS_CONNECTOR_GRANTS` cfcClass and companionKey must be nonempty strings when present",
      );
    }
    const grant = {
      name,
      ref,
      ...(record?.cfcClasses === undefined
        ? {}
        : { cfcClasses: record.cfcClasses as string[] }),
      ...(cfcClass === undefined ? {} : { cfcClass }),
      ...(record?.rowCount === undefined
        ? {}
        : { rowCount: record.rowCount as number }),
      ...(record?.viewer === undefined
        ? {}
        : { viewer: record.viewer as HarnessConnectorGrantSpec["viewer"] }),
      ...(record?.observation === undefined ? {} : {
        observation: record
          .observation as HarnessConnectorGrantSpec["observation"],
      }),
      source: {
        connection,
        piece,
        ...(companionKey === undefined ? {} : { companionKey }),
      },
    };
    checkConnectorGrantSpec(grant);
    // Held to the same rule the mint holds it to, so a reference that would
    // fail the first session fails the startup instead. An inherited variable
    // is the case this catches: the launcher checked what it resolved, and a
    // console started another way was handed whatever was in the environment.
    try {
      parseHandleRef(ref);
    } catch (error) {
      throw new Error(
        `\`CF_HARNESS_CONNECTOR_GRANTS\` grant \`${name}\` names a reference ` +
          `that does not parse: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    return grant;
  });
};
