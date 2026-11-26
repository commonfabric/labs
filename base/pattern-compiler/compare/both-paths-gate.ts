/**
 * The comparison of the two-principal gate (`both-paths.ts`): what two runs
 * of one scenario, on today's path and on the compiled path
 * (`both-paths-serving.ts`), did differently, what each did that breaks a
 * rule no counterpart is needed for, and which of those the ledger of
 * accepted differences (`both-paths-accepted.json`) covers.
 *
 * **Positions.** Document names differ between the paths by construction,
 * so a stored label is compared at a position named by what it backs: the
 * piece and the path of the result from its result document, followed
 * through every link a stored value holds (`linksIn`), with the target of a
 * link mounted at the path of the link. A link of the scope `user` or
 * `session` is followed into the instance of each principal, and the
 * position is named for that principal (`@A`, `@B`). A document is mounted
 * once at each path into it that a link names, at the first position a walk
 * of the shortest paths, in the order of the members' names, reaches it by.
 * The labels of an entry at a path above the one a link names are counted at
 * the position of the link, marked `above`.
 *
 * **Documents no walk reaches** (`unreachedNames`) are matched between the
 * paths by a name each path gives them alike, where one is found:
 * - a stream's event sidecar (`of:stream-events:…`) by the binding the
 *   harness sent the event to, `<piece>/<path>`, found from the stream
 *   document an entry's event names;
 * - a scope instance of a document whose instance of another scope a walk
 *   reached, by that position and the instance's principal;
 * - any other document by its scope and its value, with every link, entity,
 *   principal and hash in it masked, where that value is held by one
 *   document of that scope alone on the path. A row document is matched
 *   this way: its name on the compiled path is a hash of its output and its
 *   element key, which no stored value spells out, and on today's path a
 *   cause.
 * A document matched on both paths has its labels compared as a position's
 * are, at the position `unreached <name>`. The rest (receipts, the compiled
 * piece's own records, process and source documents, documents whose value
 * repeats) cannot be matched; they are compared by the number of documents
 * of each pool (the kind of the scope and its principal, `pool:space`,
 * `pool:user:A`, ...) that hold each clause.
 *
 * **Labels** are compared by the value hash (`hashStringOf`) of each clause
 * and atom, after every principal, entity and hash in it is replaced by a
 * name; `toCompactDebugString` gives the text that is shown. An integrity
 * atom `TransformedBy` is a flow atom, which the flow of a transaction
 * stores: it is compared by its presence at a position, with its identity
 * masked, as the kind `flow`.
 *
 * **Kinds of finding.**
 * - `commit`: one path committed what the other refused.
 * - `message`: both refused, with other messages.
 * - `value`: a principal reads a value on one path and another on the
 *   other; `hidden`: a principal reads a value on one path and is refused it
 *   on the other; `read-failed`: a read failed on one path alone.
 * - `label-missing`, `label-extra`: a clause or a non-flow integrity atom
 *   today's path stores at a position and the compiled path does not, and
 *   the reverse; at a pool, a clause more documents hold on one path.
 * - `flow`: a position where one path stores a flow atom and the other none.
 * - `policy`: the write policies the stored schema declares at a position
 *   differ, by the path of each writer's binding.
 * - `module-identity`: the identity of the module a writer claim names
 *   differs, which it does by construction (note 764 of `SPEC-NOTES.md`).
 * - `error-state`: an error state in a path's store, by message.
 * - `foreign-clause` and `crossed-clause`, on the compiled path, and
 *   `today-foreign-clause` and `today-crossed-clause`, on today's path: the
 *   scope rule of section 2 of the ship criteria, on each path by itself.
 *   An instance of the scope `user` or `session` of one principal holds no
 *   `User` clause of the other (`crossed`), and a document of the scope
 *   `space` holds no `User` clause of either (`foreign`), unless the value
 *   at the labeled path holds text a step declared shared (P524), or the
 *   stored schema declares a `User` clause there or above (a value a
 *   declared policy labels, such as `Confidential<T, CurrentPrincipal>`).
 * - `foreign-value`: derived check (b), text of one principal's scope, or a
 *   value only that principal's inputs produce (`derived` of a scenario),
 *   that the other principal reads, or that a document the other principal
 *   may read holds at a path whose label names no clause of the first
 *   principal; on either path.
 * - `event-payload`: the same text in the payload of an event in a stream's
 *   sidecar, which holds what a client sent: reported apart, as Z100's case.
 * - `unsettled`: a checkpoint whose passes of reads did not come to one that
 *   moved nothing, with what kept moving.
 * - `failure`: a run ended with an error; `not-compiled`: a piece of the
 *   compiled path did not run as a compiled piece.
 *
 * Values are compared with `valueEqual` of `@commonfabric/data-model`.
 */
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  hashStringOf,
  isFabricArray,
  isFabricPlainObject,
  toCompactDebugString,
  valueEqual,
} from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { decodedLinkOf } from "@commonfabric/state-inspector";

import type { PatternCompiler } from "../../../runtime/runner/src/compiled/compile.deno.ts";
import { policiesOf } from "./both-paths.ts";
import {
  type Checkpoint,
  type GateScenario,
  type PathRun,
  programsOf,
  type Read,
  type Roles,
  runPath,
  WHO,
  type Who,
} from "./both-paths-serving.ts";
import { linksIn, MAX_DEPTH, type StoredDocument } from "./both-paths-store.ts";

/** One thing the comparison found. */
export type Finding = {
  scenario: string;
  /** The checkpoint: `start <piece>`, `step <n>`, or `run`. */
  at: string;
  kind: string;
  /** The position, the member read, or the message of an error state. */
  position: string;
  /** The principal whose read or scope it concerns. */
  principal?: Who;
  /** Which path alone it is found on, for a check of one path. */
  on?: "today" | "compiled";
  today?: unknown;
  compiled?: unknown;
  /** The document and the path in it, for a check of one path. */
  document?: string;
  /**
   * The last checkpoint the same finding was made at, where it was made at
   * more than one: a finding is reported once, at the first.
   */
  through?: string;
  /** The ledger entry that accepts it, by its index. */
  acceptedBy?: number;
};

/** The labels stored at one position. */
export type PositionLabels = {
  /** The document instance, as `<scope> <id>`. */
  document: string;
  /** The clauses, by the value hash of each, with its text. */
  confidentiality: Map<string, string>;
  /** The integrity atoms that are not flow atoms, by hash, with text. */
  integrity: Map<string, string>;
  /** The flow atoms, as text. */
  flow: string[];
  policies: string[];
  /** The modules writer claims at the position name. */
  modules: string[];
};

/** The names the identifiers of a run are replaced by. */
const namesOf = (run: PathRun): [string, string][] => [
  [run.identities.principals.A, "A"],
  [run.identities.principals.B, "B"],
  // The committed form of a principal in a stored atom: the digest of its
  // identifier (`commitCfcFieldValue`).
  [hashStringOf(run.identities.principals.A), "A"],
  [hashStringOf(run.identities.principals.B), "B"],
  [run.identities.homes.A.profile, "profile-space-A"],
  [run.identities.homes.B.profile, "profile-space-B"],
  [run.identities.space, "space"],
  [run.identities.service, "service"],
];

/** `text` with identifiers replaced by the names of `run`. */
export const normalized = (text: string, run: PathRun): string => {
  let out = text;
  for (const [did, name] of namesOf(run)) out = out.replaceAll(did, name);
  return out
    .replace(/(?:of|cid|receipt):[A-Za-z0-9_:%-]+/g, "<entity>")
    .replace(/fid1:[A-Za-z0-9_-]{20,}/g, "<hash>")
    .replace(/did:key:[A-Za-z0-9]+/g, "<principal>")
    .replace(/\bba[a-z0-9]{20,}\b/g, "<hash>")
    .replace(/sha256:[0-9a-f]{16,}/g, "sha256:<hash>");
};

/**
 * `value` with each string and each member's name normalized as text is
 * (`normalized`), and, with `masking`, each link a stored value holds as
 * the text `<link>`.
 */
export const maskedValue = (
  value: unknown,
  run: PathRun,
  masking = false,
  depth = 0,
): FabricValue => {
  if (depth > MAX_DEPTH) return "<deep>";
  if (typeof value === "string") return normalized(value, run);
  if (masking && value !== null && typeof value === "object") {
    if (decodedLinkOf(value as FabricValue) !== null) return "<link>";
  }
  if (isFabricArray(value as FabricValue) || Array.isArray(value)) {
    return (value as unknown[]).map((member) =>
      maskedValue(member, run, masking, depth + 1)
    );
  }
  if (isFabricPlainObject(value as FabricValue)) {
    return Object.fromEntries(
      Object.entries(value as object).map(([name, member]) => [
        normalized(name, run),
        maskedValue(member, run, masking, depth + 1),
      ]),
    );
  }
  return value as FabricValue;
};

/**
 * The key a clause or an atom is compared by: the value hash of the masked
 * value, which does not depend on the order of a record's members.
 */
export const labelKey = (value: unknown, run: PathRun): string =>
  hashStringOf(maskedValue(value, run));

/** The text a clause or an atom is shown as. */
const labelText = (value: unknown, run: PathRun): string =>
  normalized(toCompactDebugString(value as FabricValue), run);

/** Whether `atom` is a flow atom: one the flow of a transaction stores. */
export const isFlowAtom = (atom: unknown): boolean =>
  isObjectNotArray(atom) && atom.type === CFC_ATOM_TYPE.TransformedBy;

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

/** The name of a document instance's scope, with its principal named. */
export const scopeName = (document: StoredDocument, run: PathRun): string => {
  const { kind, principal } = document.scope;
  if (kind === "space") return "space";
  const who = principal === run.identities.principals.A
    ? "A"
    : principal === run.identities.principals.B
    ? "B"
    : "other";
  return `${kind}:${who}`;
};

/** Whether `path` begins with `prefix`. */
const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.every((step, index) => path[index] === step);

/** The writer claims `node` holds, by the module each names. */
const modulesIn = (node: unknown, into: Set<string>, depth = 0): void => {
  if (depth > 16 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const member of node) modulesIn(member, into, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  const claim = record.__ctWriterIdentityOf;
  if (isObjectNotArray(claim)) {
    const path = Array.isArray(claim.path) ? claim.path.join(".") : "?";
    into.add(`${path} in ${String(claim.moduleIdentity ?? "no module")}`);
  }
  for (const member of Object.values(record)) {
    modulesIn(member, into, depth + 1);
  }
};

/** The schema node at `path` of `schema`, through properties and items. */
const schemaAt = (schema: unknown, path: readonly string[]): unknown => {
  let node = schema;
  for (const step of path) {
    if (!isObjectNotArray(node)) return undefined;
    const properties = isObjectNotArray(node.properties) ? node.properties : {};
    node = Object.hasOwn(properties, step)
      ? properties[step]
      : node.items ?? node.additionalProperties;
  }
  return node;
};

/** A document instance and a path in it. */
export type Place = { document: StoredDocument; path: string[] };

/** What `walkPositions` gives for one checkpoint of one path. */
export type Positions = {
  /** The labels at each position. */
  labels: Map<string, PositionLabels>;
  /** The position of each document instance and path a walk reached. */
  reached: Map<string, string>;
  /** The document instance and path each position is mounted from. */
  places: Map<string, Place>;
  /** The document instances no walk reached. */
  unreached: StoredDocument[];
};

/** The key of a document instance and a path in it. */
const placeKey = (document: StoredDocument, path: readonly string[]) =>
  `${document.id}\n${document.scopeKey}\n${path.join("/")}`;

/** The key of a document instance. */
const instanceKey = (document: StoredDocument) =>
  `${document.id}\n${document.scopeKey}`;

/**
 * The position of `path` of `document`: below the longest path of it a walk
 * reached, or `undefined` where a walk reached none.
 */
const positionOf = (
  positions: Pick<Positions, "reached">,
  document: StoredDocument,
  path: readonly string[],
): string | undefined => {
  for (let length = path.length; length >= 0; length--) {
    const at = positions.reached.get(placeKey(document, path.slice(0, length)));
    if (at === undefined) continue;
    const rest = path.slice(length);
    return rest.length === 0 ? at : `${at}/${rest.join("/")}`;
  }
  return undefined;
};

/** Empty labels for a position of `document`. */
const emptyLabels = (
  document: StoredDocument,
  run: PathRun,
): PositionLabels => ({
  document: `${scopeName(document, run)} ${document.id.slice(0, 18)}`,
  confidentiality: new Map(),
  integrity: new Map(),
  flow: [],
  policies: [],
  modules: [],
});

/** Adds the clauses and atoms of one label entry to `held`. */
const addEntry = (
  held: PositionLabels,
  run: PathRun,
  entry: { confidentiality: readonly unknown[]; integrity: readonly unknown[] },
  prefix = "",
): void => {
  for (const clause of entry.confidentiality) {
    held.confidentiality.set(
      `${prefix}${labelKey(clause, run)}`,
      `${prefix}${labelText(clause, run)}`,
    );
  }
  for (const atom of entry.integrity) {
    if (isFlowAtom(atom)) {
      held.flow = sorted([...held.flow, `${prefix}${labelText(atom, run)}`]);
    } else {
      held.integrity.set(
        `${prefix}${labelKey(atom, run)}`,
        `${prefix}${labelText(atom, run)}`,
      );
    }
  }
};

/** The labels of a whole document instance, as one position holds them. */
export const documentLabels = (
  document: StoredDocument,
  run: PathRun,
  contentOf: (id: string) => FabricValue | undefined,
): PositionLabels => {
  const held = emptyLabels(document, run);
  for (const entry of document.metadata?.labelMap.entries ?? []) {
    const path = entry.path.map(String);
    addEntry(held, run, {
      confidentiality: entry.label.confidentiality ?? [],
      integrity: entry.label.integrity ?? [],
    }, path.length === 0 ? "" : `/${path.join("/")} `);
  }
  const schema = document.metadata === undefined
    ? undefined
    : contentOf(`cid:${document.metadata.schemaHash}`);
  if (schema !== undefined) {
    const policies = policiesOf(
      schema,
      [],
      (hash) => contentOf(`cid:${hash}`),
    );
    held.policies = sorted(
      Object.entries(policies).flatMap(([below, lines]) =>
        lines.map((line) => `${below} ${line}`)
      ),
    );
  }
  return held;
};

/**
 * The positions of every result of `run` at `checkpoint`, walked from each
 * result document through the links the stored values hold.
 */
export const walkPositions = (
  run: PathRun,
  checkpoint: Checkpoint,
): Positions => {
  const snapshot = checkpoint.snapshot;
  const labels = new Map<string, PositionLabels>();
  const reached = new Map<string, string>();
  const places = new Map<string, Place>();
  const mountedDocuments = new Set<string>();
  // The instances of a document a link of a scope reaches, by principal.
  const instancesOf = (
    id: string,
    scope: string,
  ): { document: StoredDocument; suffix: string }[] => {
    if (scope === "space") {
      const document = snapshot.get(id, "space");
      return document === undefined ? [] : [{ document, suffix: "" }];
    }
    return snapshot.documents.filter((document) =>
      document.id === id && document.scope.kind === scope
    ).flatMap((document) => {
      const name = scopeName(document, run);
      return name.endsWith(":other") ? [] : [{
        document,
        suffix: `@${name.split(":")[1]}`,
      }];
    });
  };
  const held = (position: string, document: StoredDocument) => {
    const at = labels.get(position) ?? emptyLabels(document, run);
    labels.set(position, at);
    return at;
  };
  // Mounts the subtree at `at` of `document` at `position`, and queues the
  // links it holds.
  const queue: {
    position: string;
    document: StoredDocument;
    at: string[];
  }[] = [];
  const mount = (position: string, document: StoredDocument, at: string[]) => {
    const key = placeKey(document, at);
    if (reached.has(key)) return;
    reached.set(key, position);
    // The target of a link is what the position holds, rather than the
    // entry of the link itself.
    places.set(position, { document, path: at });
    mountedDocuments.add(instanceKey(document));
    const schema = document.metadata === undefined
      ? undefined
      : snapshot.contentOf(`cid:${document.metadata.schemaHash}`);
    for (const entry of document.metadata?.labelMap.entries ?? []) {
      const path = entry.path.map(String);
      const confidentiality = entry.label.confidentiality ?? [];
      const integrity = entry.label.integrity ?? [];
      if (startsWith(path, at)) {
        const rest = path.slice(at.length);
        const where = rest.length === 0
          ? position
          : `${position}/${rest.join("/")}`;
        addEntry(held(where, document), run, { confidentiality, integrity });
        reached.set(placeKey(document, path), where);
        if (!places.has(where)) places.set(where, { document, path });
      } else if (startsWith(at, path)) {
        addEntry(
          held(position, document),
          run,
          { confidentiality, integrity },
          "above ",
        );
      }
    }
    if (schema !== undefined) {
      const policies = policiesOf(
        schema,
        at,
        (hash) => snapshot.contentOf(`cid:${hash}`),
      );
      for (const [below, lines] of Object.entries(policies)) {
        const at = held(`${position}${below}`, document);
        at.policies = sorted([...at.policies, ...lines]);
      }
      const modules = new Set<string>();
      modulesIn(schemaAt(schema, at), modules);
      if (modules.size > 0) {
        const at = held(position, document);
        at.modules = sorted([...at.modules, ...modules]);
      }
    }
    queue.push({ position, document, at });
  };
  for (const [piece, id] of Object.entries(run.results).sort()) {
    const document = snapshot.get(id, "space");
    if (document !== undefined) mount(piece, document, []);
  }
  for (let next = 0; next < queue.length; next++) {
    const { position, document, at } = queue[next];
    const links = linksIn(document).filter(({ path }) => startsWith(path, at))
      .sort((a, b) => a.path.join("/") < b.path.join("/") ? -1 : 1);
    for (const { path, link } of links) {
      if (link.space !== document.space) continue;
      const where = path.length === at.length
        ? position
        : `${position}/${path.slice(at.length).join("/")}`;
      for (
        const { document: target, suffix } of instancesOf(link.id, link.scope)
      ) {
        mount(`${where}${suffix}`, target, link.path);
      }
    }
  }
  const unreached = snapshot.documents.filter((document) =>
    !mountedDocuments.has(instanceKey(document))
  );
  return { labels, reached, places, unreached };
};

/** The prefix of the id of a stream's event sidecar. */
const SIDECAR = "of:stream-events:";

/** Whether `document` is a stream's event sidecar. */
export const isSidecar = (document: StoredDocument): boolean =>
  document.id.startsWith(SIDECAR);

/**
 * The name each document no walk reached is matched between the paths by,
 * where one is found; a document with none is left out. A name two
 * documents of the path would share names neither.
 */
export const unreachedNames = (
  run: PathRun,
  positions: Positions,
): Map<string, StoredDocument> => {
  const named = new Map<string, StoredDocument[]>();
  const name = (key: string, document: StoredDocument) =>
    named.set(key, [...(named.get(key) ?? []), document]);
  // The position each document id was reached at, at any scope.
  const reachedIds = new Map<string, string>();
  for (const [key, position] of positions.reached) {
    const [id, , path] = key.split("\n");
    if (path === "" && !reachedIds.has(id)) reachedIds.set(id, position);
  }
  for (const document of positions.unreached) {
    if (document.id.startsWith("cid:")) continue;
    const scope = scopeName(document, run);
    if (isSidecar(document)) {
      // An entry's event id ends with the stream's document.
      const texts = stringsIn(document.value).map(({ text }) => text);
      const bindings = Object.entries(run.streams).filter(([id]) =>
        texts.some((text) => text.endsWith(`:${id}`))
      ).map(([, binding]) => binding);
      if (bindings.length > 0) {
        name(`stream-events ${sorted(bindings).join(" ")}`, document);
        continue;
      }
    }
    const sibling = reachedIds.get(document.id);
    if (sibling !== undefined && scope !== "space") {
      name(`instance ${sibling}@${scope}`, document);
      continue;
    }
    name(
      `${scope} value ${hashStringOf(maskedValue(document.value, run, true))}`,
      document,
    );
  }
  const unique = new Map<string, StoredDocument>();
  for (const [key, documents] of named) {
    if (documents.length === 1) unique.set(key, documents[0]);
  }
  return unique;
};

/**
 * The clauses of the documents of each pool that `matched` leaves out: for
 * each pool and clause key, the number of documents that hold it and the
 * clause's text.
 */
const poolCounts = (
  run: PathRun,
  positions: Positions,
  matched: ReadonlySet<StoredDocument>,
): Map<string, Map<string, { count: number; text: string }>> => {
  const pools = new Map<string, Map<string, { count: number; text: string }>>();
  for (const document of positions.unreached) {
    if (matched.has(document)) continue;
    const pool = `pool:${scopeName(document, run)}`;
    const held = pools.get(pool) ?? new Map();
    pools.set(pool, held);
    const clauses = new Map<string, string>();
    for (const entry of document.metadata?.labelMap.entries ?? []) {
      for (const clause of entry.label.confidentiality ?? []) {
        clauses.set(labelKey(clause, run), labelText(clause, run));
      }
    }
    for (const [key, text] of clauses) {
      const count = held.get(key)?.count ?? 0;
      held.set(key, { count: count + 1, text });
    }
  }
  return pools;
};

/**
 * Whether `atom`, or a member of it, names the principal `did`: as a `User`
 * or `PersonalSpace` atom, by the identifier itself or by its committed
 * form (`{ digestOf }`), or as the bare identifier.
 */
export const namesPrincipal = (atom: unknown, did: string): boolean => {
  if (atom === did) return true;
  if (Array.isArray(atom)) {
    return atom.some((member) => namesPrincipal(member, did));
  }
  if (!isObjectNotArray(atom)) return false;
  const is = (field: unknown) =>
    field === did ||
    (isObjectNotArray(field) && field.digestOf === hashStringOf(did));
  const type = typeof atom.type === "string" ? atom.type : "";
  if (
    (type.endsWith("User") && is(atom.subject)) ||
    (type.endsWith("PersonalSpace") && is(atom.owner))
  ) return true;
  return Object.values(atom).some((member) => namesPrincipal(member, did));
};

/** Whether `value`, or a member of it, is a `User` atom of any subject. */
const holdsUserAtom = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return false;
  if (Array.isArray(value)) {
    return value.some((member) => holdsUserAtom(member, depth + 1));
  }
  if (!isObjectNotArray(value)) return false;
  return value.type === CFC_ATOM_TYPE.User ||
    Object.values(value).some((member) => holdsUserAtom(member, depth + 1));
};

/** The lines of an `ifc` record that declares a `User` clause. */
const userClauseLines = (ifc: Record<string, unknown>): string[] =>
  Array.isArray(ifc.confidentiality) && holdsUserAtom(ifc.confidentiality)
    ? ["confidentiality User"]
    : [];

/**
 * Whether the stored schema of `document` declares a `User` clause at
 * `path` or above it: a value a declared policy labels.
 */
export const declaresUserClause = (
  document: StoredDocument,
  path: readonly string[],
  contentOf: (id: string) => FabricValue | undefined,
): boolean => {
  if (document.metadata === undefined) return false;
  const schema = contentOf(`cid:${document.metadata.schemaHash}`);
  if (schema === undefined) return false;
  for (let length = path.length; length >= 0; length--) {
    const declared = policiesOf(
      schema,
      path.slice(0, length),
      (hash) => contentOf(`cid:${hash}`),
      userClauseLines,
    );
    if (declared[""] !== undefined) return true;
  }
  return false;
};

/** The value at `path` of `value`. */
const valueAt = (value: unknown, path: readonly string[]): unknown => {
  let node = value;
  for (const step of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return node;
};

/** A clause that breaks the scope rule. */
export type ScopeViolation = {
  document: string;
  path: string;
  /** The position a walk reached the path at, or the unreached name. */
  position?: string;
  /** Whose clause it is. */
  principal: Who;
  /** Whether the document is an instance of the other principal's scope. */
  crossed: boolean;
  clause: string;
};

/**
 * Each clause of `checkpoint`'s store that breaks the scope rule of section
 * 2 of the ship criteria on the path of `run`, on that path alone: a `User`
 * clause of one principal in an instance of the scope `user` or `session`
 * of the other, or of either in a document of the scope `space`, unless the
 * value at the labeled path holds text a step declared shared, or the
 * stored schema declares a `User` clause there (`declaresUserClause`).
 */
export const scopeViolationsOf = (
  run: PathRun,
  checkpoint: Checkpoint,
  positions: Positions,
  names: ReadonlyMap<StoredDocument, string> = new Map(),
): ScopeViolation[] => {
  const found: ScopeViolation[] = [];
  const { snapshot } = checkpoint;
  for (const document of snapshot.documents) {
    const scope = scopeName(document, run);
    if (scope.endsWith(":other")) continue;
    for (const entry of document.metadata?.labelMap.entries ?? []) {
      const path = entry.path.map(String);
      for (const clause of entry.label.confidentiality ?? []) {
        for (const who of WHO) {
          if (scope.endsWith(`:${who}`)) continue;
          if (!namesPrincipal(clause, run.identities.principals[who])) continue;
          const crossed = scope !== "space";
          if (!crossed) {
            const shared = stringsIn(valueAt(document.value, path)).some((
              { text },
            ) => checkpoint.shared.some((share) => text.includes(share)));
            if (shared) continue;
            if (declaresUserClause(document, path, snapshot.contentOf)) {
              continue;
            }
          }
          const position = positionOf(positions, document, path) ??
            (names.has(document)
              ? `unreached ${names.get(document)}${
                path.length === 0 ? "" : `/${path.join("/")}`
              }`
              : undefined);
          found.push({
            document: document.id,
            path: `/${path.join("/")}`,
            ...(position === undefined ? {} : { position }),
            principal: who,
            crossed,
            clause: labelText(clause, run),
          });
        }
      }
    }
  }
  return found;
};

/** Each string `value` holds, with its path. */
const stringsIn = (
  value: unknown,
  at: string[] = [],
  found: { path: string[]; text: string }[] = [],
  within: unknown[] = [],
): { path: string[]; text: string }[] => {
  if (at.length > MAX_DEPTH || within.includes(value)) return found;
  if (typeof value === "string") found.push({ path: at, text: value });
  const inside = [...within, value];
  if (isFabricArray(value as FabricValue) || Array.isArray(value)) {
    (value as unknown[]).forEach((member, index) =>
      stringsIn(member, [...at, String(index)], found, inside)
    );
  } else if (isFabricPlainObject(value as FabricValue)) {
    for (const [name, member] of Object.entries(value as object)) {
      stringsIn(member, [...at, name], found, inside);
    }
  }
  return found;
};

/**
 * The values at `path` of `value`, with `*` for every member of an array
 * or a record, each with the path it was found at.
 */
const valuesMatching = (
  value: unknown,
  path: readonly string[],
  at: string[] = [],
): { path: string[]; value: unknown }[] => {
  if (path.length === 0) return [{ path: at, value }];
  if (value === null || typeof value !== "object") return [];
  const [step, ...rest] = path;
  const names = step === "*" ? Object.keys(value as object) : [step];
  return names.flatMap((name) =>
    Object.hasOwn(value as object, name)
      ? valuesMatching(
        (value as Record<string, unknown>)[name],
        rest,
        [...at, name],
      )
      : []
  );
};

/** Whether the segments of `position`, `@A` and `@B` dropped, match `path`. */
const positionMatches = (
  position: string,
  path: readonly string[],
): boolean => {
  const steps = position.replace(/@[AB](?=\/|$)/g, "").split("/");
  return steps.length === path.length &&
    path.every((step, index) => step === "*" || step === steps[index]);
};

/** Text or a value of one principal's scope where the other may read it. */
export type ForeignValue = {
  /** The member read, or the document and path. */
  where: string;
  document?: string;
  /** Whose scope the value is of. */
  of: Who;
  /** Who may read it. */
  reader: Who;
  /** The text, or the derived value as text. */
  text: string;
  /** Whether it is in the payload of an event in a stream's sidecar. */
  payload?: boolean;
};

/**
 * Derived check (b) at `checkpoint` of one path: each place that `reader`
 * reads, or a document of the space or of `reader`'s scope holds at a path
 * whose label names no clause of the other principal, holding text of the
 * other principal's scope that no step shared, or a value that only the
 * other principal's inputs produce (`derived`) and that differs from what
 * `reader`'s inputs produce.
 */
export const foreignValuesOf = (
  run: PathRun,
  checkpoint: Checkpoint,
  positions: Positions,
  derived: GateScenario["derived"] = [],
  roles: Roles = {},
): ForeignValue[] => {
  const found: ForeignValue[] = [];
  const nameOf = (who: Who) =>
    Object.entries(roles).find(([, role]) => role === who)?.[0];
  for (const reader of WHO) {
    const of: Who = reader === "A" ? "B" : "A";
    const ofDid = run.identities.principals[of];
    // A path whose label names the other principal is not one the reader
    // is shown.
    const protectedAt = (document: StoredDocument, path: readonly string[]) =>
      (document.metadata?.labelMap.entries ?? []).some((entry) =>
        startsWith(path, entry.path.map(String)) &&
        (entry.label.confidentiality ?? []).some((clause) =>
          namesPrincipal(clause, ofDid)
        )
      );
    const readable = (document: StoredDocument) => {
      const name = scopeName(document, run);
      return name === "space" || name.endsWith(`:${reader}`);
    };
    const texts = run.scoped[of].filter((text) =>
      !checkpoint.shared.some((shared) =>
        shared.includes(text) || text.includes(shared)
      )
    );
    const holds = (value: string) => texts.find((text) => value.includes(text));
    if (texts.length > 0) {
      for (const [member, read] of Object.entries(checkpoint.reads[reader])) {
        if (!("value" in read)) continue;
        for (const { path, text } of stringsIn(read.value)) {
          const held = holds(text);
          if (held !== undefined) {
            found.push({
              where: `${member}${
                path.length === 0 ? "" : `/${path.join("/")}`
              }`,
              of,
              reader,
              text: held,
            });
          }
        }
      }
      for (const document of checkpoint.snapshot.documents) {
        if (!readable(document)) continue;
        const name = scopeName(document, run);
        for (const { path, text } of stringsIn(document.value)) {
          const held = holds(text);
          if (held === undefined || protectedAt(document, path)) continue;
          const position = positionOf(positions, document, path);
          found.push({
            where: position ??
              `${name} ${document.id.slice(0, 18)}/${path.join("/")}`,
            document: `${name} ${document.id}`,
            of,
            reader,
            text: held,
            ...(isSidecar(document) && path.includes("payload")
              ? { payload: true }
              : {}),
          });
        }
      }
    }
    const readerName = nameOf(reader);
    const ofName = nameOf(of);
    if (readerName === undefined || ofName === undefined) continue;
    for (const { path, values } of derived) {
      if (!(ofName in values) || !(readerName in values)) continue;
      const theirs = values[ofName];
      const own = values[readerName];
      if (valueEqual(theirs, own)) continue;
      const only = (value: unknown) =>
        valueEqual(value as FabricValue, theirs) &&
        !valueEqual(value as FabricValue, own);
      const [piece, member, ...below] = path;
      const read = checkpoint.reads[reader][`${piece}.${member}`];
      if (read !== undefined && "value" in read) {
        for (const leaf of valuesMatching(read.value, below)) {
          if (!only(leaf.value)) continue;
          found.push({
            where: `${piece}.${member}${
              leaf.path.length === 0 ? "" : `/${leaf.path.join("/")}`
            }`,
            of,
            reader,
            text: labelText(theirs, run),
          });
        }
      }
      for (const [position, place] of positions.places) {
        if (!positionMatches(position, path)) continue;
        if (!readable(place.document)) continue;
        if (protectedAt(place.document, place.path)) continue;
        if (!only(valueAt(place.document.value, place.path))) continue;
        found.push({
          where: position,
          document: `${scopeName(place.document, run)} ${place.document.id}`,
          of,
          reader,
          text: labelText(theirs, run),
        });
      }
    }
  }
  return found;
};

/** A read, as the comparison holds it. */
const readKind = (read: Read | undefined) =>
  read === undefined
    ? "absent"
    : "value" in read
    ? "value"
    : "hidden" in read
    ? "hidden"
    : "failed";

/** Whether two reads are equal. */
const readsEqual = (a: Read | undefined, b: Read | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  if ("value" in a && "value" in b) return valueEqual(a.value, b.value);
  if ("hidden" in a && "hidden" in b) return true;
  if ("failed" in a && "failed" in b) return true;
  return false;
};

/** A read as text, for a report. */
const readText = (read: Read | undefined, run: PathRun): string =>
  read === undefined
    ? "absent"
    : "value" in read
    ? normalized(toCompactDebugString(read.value), run).slice(0, 400)
    : "hidden" in read
    ? read.hidden
    : `not read: ${normalized(read.failed, run)}`;

/** The two runs of one scenario. */
export type BothRuns = {
  scenario: string;
  today: PathRun;
  compiled: PathRun;
  /** The values derived from each principal's scoped values, for check (b). */
  derived?: GateScenario["derived"];
  /** The roles the scenario ran with, to name the principals of `derived`. */
  roles?: Roles;
};

/** An example of a position with a flow atom on one path or both. */
export type FlowExample = {
  at: string;
  position: string;
  today?: { document: string; atoms: string[] };
  compiled?: { document: string; atoms: string[] };
};

/** The positions with a flow atom, counted over every checkpoint. */
export type FlowCounts = {
  both: number;
  compiledOnly: number;
  todayOnly: number;
  /** Up to three examples of each. */
  examples: {
    both: FlowExample[];
    compiledOnly: FlowExample[];
    todayOnly: FlowExample[];
  };
};

/** What the comparison found for one scenario, before the ledger. */
export type Compared = {
  findings: Finding[];
  /** What each checkpoint wrote on each path, side by side. */
  written: {
    at: string;
    today?: Checkpoint["written"];
    compiled?: Checkpoint["written"];
  }[];
  /** The error states of each path's store after the last checkpoint. */
  errors: { today?: Checkpoint["errors"]; compiled?: Checkpoint["errors"] };
  /** The positions with a flow atom on each path. */
  flow: FlowCounts;
  /** How many passes of reads each checkpoint took, on each path. */
  passes: { at: string; today?: number; compiled?: number }[];
};

/** Compares the labels of `la` and `lb`, held at `position`. */
const compareLabels = (
  position: string,
  la: PositionLabels | undefined,
  lb: PositionLabels | undefined,
  find: (finding: Omit<Finding, "scenario" | "at">) => void,
): void => {
  for (const axis of ["confidentiality", "integrity"] as const) {
    const sa = la?.[axis] ?? new Map<string, string>();
    const sb = lb?.[axis] ?? new Map<string, string>();
    for (const [key, text] of sa) {
      if (sb.has(key)) continue;
      find({
        kind: "label-missing",
        position,
        today: `${axis} ${text}`,
        compiled: lb === undefined ? "no such position" : lb.document,
      });
    }
    for (const [key, text] of sb) {
      if (sa.has(key)) continue;
      find({
        kind: "label-extra",
        position,
        today: la === undefined ? "no such position" : la.document,
        compiled: `${axis} ${text}`,
      });
    }
  }
  const policiesA = la?.policies ?? [];
  const policiesB = lb?.policies ?? [];
  if (policiesA.join("\n") !== policiesB.join("\n")) {
    find({ kind: "policy", position, today: policiesA, compiled: policiesB });
  }
  const modulesA = la?.modules ?? [];
  const modulesB = lb?.modules ?? [];
  if (modulesA.join("\n") !== modulesB.join("\n")) {
    find({
      kind: "module-identity",
      position,
      today: modulesA,
      compiled: modulesB,
    });
  }
};

/** Compares the two runs of a scenario. */
export const compareRuns = (
  { scenario, today, compiled, derived = [], roles = {} }: BothRuns,
): Compared => {
  const findings: Finding[] = [];
  // A finding made again at a later checkpoint is the same finding: it is
  // reported at the first, with the last it was made at.
  const made = new Map<string, Finding>();
  const find = (finding: Omit<Finding, "scenario">) => {
    const key = JSON.stringify([
      finding.kind,
      finding.position,
      finding.principal,
      finding.on,
      finding.today,
      finding.compiled,
    ]);
    const before = made.get(key);
    if (before !== undefined) {
      before.through = finding.at;
      return;
    }
    const full = { scenario, ...finding };
    made.set(key, full);
    findings.push(full);
  };
  if (today.failure !== undefined || compiled.failure !== undefined) {
    if (today.failure !== compiled.failure) {
      find({
        at: "run",
        kind: "failure",
        position: "run",
        today: today.failure,
        compiled: compiled.failure,
      });
    }
  }
  for (const [piece, ran] of Object.entries(compiled.compiled)) {
    if (!ran) {
      find({
        at: `start ${piece}`,
        kind: "not-compiled",
        position: piece,
        on: "compiled",
        compiled: compiled.refused.find((reason) =>
          reason.startsWith(`${piece}:`)
        ) ?? "the serving runtime started no compiled piece",
      });
    }
  }
  const written: Compared["written"] = [];
  const passes: Compared["passes"] = [];
  const firstSeen = new Set<string>();
  const once = (key: string, finding: Omit<Finding, "scenario">) => {
    if (firstSeen.has(key)) return;
    firstSeen.add(key);
    find(finding);
  };
  const flow: FlowCounts = {
    both: 0,
    compiledOnly: 0,
    todayOnly: 0,
    examples: { both: [], compiledOnly: [], todayOnly: [] },
  };
  const flowSeen = new Set<string>();
  // The index of each checkpoint a derived value holds from.
  const from = new Map<string, number>();
  for (const [index, checkpoint] of today.checkpoints.entries()) {
    if (!from.has(checkpoint.at)) from.set(checkpoint.at, index);
  }
  const count = Math.max(today.checkpoints.length, compiled.checkpoints.length);
  for (let index = 0; index < count; index++) {
    const a = today.checkpoints[index];
    const b = compiled.checkpoints[index];
    const at = a?.at ?? b?.at ?? `checkpoint ${index}`;
    written.push({
      at,
      ...(a === undefined ? {} : { today: a.written }),
      ...(b === undefined ? {} : { compiled: b.written }),
    });
    passes.push({
      at,
      ...(a === undefined ? {} : { today: a.passes }),
      ...(b === undefined ? {} : { compiled: b.passes }),
    });
    if (a === undefined || b === undefined) {
      find({
        at,
        kind: "failure",
        position: "checkpoint",
        today: a === undefined ? "not reached" : "reached",
        compiled: b === undefined ? "not reached" : "reached",
      });
      continue;
    }
    for (
      const [path, checkpoint] of [["today", a], ["compiled", b]] as const
    ) {
      if (checkpoint.unsettled === undefined) continue;
      find({
        at,
        kind: "unsettled",
        position: at,
        on: path,
        [path]: {
          passes: checkpoint.passes,
          moving: checkpoint.unsettled.map((document) =>
            normalized(document, path === "today" ? today : compiled)
          ),
        },
      });
    }
    if (a.committed !== b.committed) {
      find({
        at,
        kind: "commit",
        position: a.actor,
        today: a.committed ? "committed" : normalized(a.message ?? "", today),
        compiled: b.committed
          ? "committed"
          : normalized(b.message ?? "", compiled),
      });
    } else if (!a.committed) {
      const ta = normalized(a.message ?? "", today);
      const tb = normalized(b.message ?? "", compiled);
      if (ta !== tb) {
        find({
          at,
          kind: "message",
          position: a.actor,
          today: ta,
          compiled: tb,
        });
      }
    }
    for (const who of WHO) {
      const members = sorted([
        ...Object.keys(a.reads[who]),
        ...Object.keys(b.reads[who]),
      ]);
      for (const member of members) {
        const ra = a.reads[who][member];
        const rb = b.reads[who][member];
        if (readsEqual(ra, rb)) continue;
        const ka = readKind(ra);
        const kb = readKind(rb);
        find({
          at,
          kind: ka === kb
            ? ka === "value" ? "value" : "read-failed"
            : ka === "hidden" || kb === "hidden"
            ? "hidden"
            : ka === "failed" || kb === "failed"
            ? "read-failed"
            : "value",
          position: member,
          principal: who,
          today: readText(ra, today),
          compiled: readText(rb, compiled),
        });
      }
    }
    const pa = walkPositions(today, a);
    const pb = walkPositions(compiled, b);
    const atFind = (finding: Omit<Finding, "scenario" | "at">) =>
      find({ at, ...finding });
    const flowAt = (
      position: string,
      la: PositionLabels | undefined,
      lb: PositionLabels | undefined,
    ) => {
      const ta = (la?.flow.length ?? 0) > 0;
      const tb = (lb?.flow.length ?? 0) > 0;
      if (!ta && !tb) return;
      const which = ta && tb ? "both" : tb ? "compiledOnly" : "todayOnly";
      const key = `${which} ${position}`;
      if (!flowSeen.has(key)) {
        flowSeen.add(key);
        flow[which] += 1;
        if (flow.examples[which].length < 3) {
          flow.examples[which].push({
            at,
            position,
            ...(la === undefined || !ta
              ? {}
              : { today: { document: la.document, atoms: la.flow } }),
            ...(lb === undefined || !tb
              ? {}
              : { compiled: { document: lb.document, atoms: lb.flow } }),
          });
        }
      }
      if (which !== "both") {
        find({
          at,
          kind: "flow",
          position,
          today: ta ? "a flow atom" : "none",
          compiled: tb ? "a flow atom" : "none",
        });
      }
    };
    const positions = sorted([...pa.labels.keys(), ...pb.labels.keys()]);
    for (const position of positions) {
      const la = pa.labels.get(position);
      const lb = pb.labels.get(position);
      compareLabels(position, la, lb, atFind);
      flowAt(position, la, lb);
    }
    // The documents no walk reached: matched by name where both paths name
    // one, and counted by pool otherwise.
    const na = unreachedNames(today, pa);
    const nb = unreachedNames(compiled, pb);
    const matchedA = new Set<StoredDocument>();
    const matchedB = new Set<StoredDocument>();
    for (const name of sorted([...na.keys()])) {
      const da = na.get(name)!;
      const db = nb.get(name);
      if (db === undefined) continue;
      matchedA.add(da);
      matchedB.add(db);
      const position = `unreached ${name}`;
      const la = documentLabels(da, today, a.snapshot.contentOf);
      const lb = documentLabels(db, compiled, b.snapshot.contentOf);
      compareLabels(position, la, lb, atFind);
      flowAt(position, la, lb);
    }
    const poolsA = poolCounts(today, pa, matchedA);
    const poolsB = poolCounts(compiled, pb, matchedB);
    for (const pool of sorted([...poolsA.keys(), ...poolsB.keys()])) {
      const ca = poolsA.get(pool) ?? new Map();
      const cb = poolsB.get(pool) ?? new Map();
      for (const key of sorted([...ca.keys(), ...cb.keys()])) {
        const ha = ca.get(key)?.count ?? 0;
        const hb = cb.get(key)?.count ?? 0;
        if (ha === hb) continue;
        const text = ca.get(key)?.text ?? cb.get(key)!.text;
        find({
          at,
          kind: ha > hb ? "label-missing" : "label-extra",
          position: pool,
          today: `${text} in ${ha} documents`,
          compiled: `${text} in ${hb} documents`,
        });
      }
    }
    // The scope rule, on each path by itself.
    const namesBy = (named: Map<string, StoredDocument>) =>
      new Map([...named].map(([name, document]) => [document, name]));
    for (
      const [path, run, checkpoint, walked, named] of [
        ["today", today, a, pa, namesBy(na)],
        ["compiled", compiled, b, pb, namesBy(nb)],
      ] as const
    ) {
      for (const clause of scopeViolationsOf(run, checkpoint, walked, named)) {
        const where = clause.position ??
          `unreached ${clause.document.slice(0, 18)}${clause.path}`;
        const kind = `${path === "today" ? "today-" : ""}${
          clause.crossed ? "crossed-clause" : "foreign-clause"
        }`;
        once(`${kind} ${where} ${clause.principal} ${clause.clause}`, {
          at,
          kind,
          position: where,
          principal: clause.principal,
          on: path,
          document: `${clause.document}${clause.path}`,
          [path]: clause.clause,
        });
      }
    }
    // Derived check (b), on each path alone.
    for (
      const [path, run, checkpoint, walked] of [
        ["today", today, a, pa],
        ["compiled", compiled, b, pb],
      ] as const
    ) {
      for (
        const value of foreignValuesOf(
          run,
          checkpoint,
          walked,
          derived.filter((entry) =>
            entry.from === undefined ||
            (from.get(entry.from) ?? Infinity) <= index
          ),
          roles,
        )
      ) {
        const kind = value.payload === true ? "event-payload" : "foreign-value";
        // A sidecar's or a document's name differs by path; the place in
        // it does not.
        const where = value.where.replace(/^(\S+) [^\s/]+\//, "$1 <document>/");
        once(`${path} ${kind} ${where} ${value.text} ${value.reader}`, {
          at,
          kind,
          position: where,
          principal: value.reader,
          on: path,
          ...(value.document === undefined ? {} : { document: value.document }),
          [path]: `${value.of}'s ${
            value.text.startsWith('"') ? value.text : `"${value.text}"`
          } readable by ${value.reader}`,
        });
      }
    }
    // Error states, by message, where they first appear on each path.
    for (
      const [path, checkpoint] of [["today", a], ["compiled", b]] as const
    ) {
      const messages = sorted([
        ...Object.keys(checkpoint.errors.current),
        ...Object.keys(checkpoint.errors.all),
      ]);
      for (const message of messages) {
        once(`${path} error ${message}`, {
          at,
          kind: "error-state",
          position: normalized(message, path === "today" ? today : compiled)
            .slice(0, 300),
          on: path,
          [path]: {
            current: checkpoint.errors.current[message] ?? 0,
            all: checkpoint.errors.all[message] ?? 0,
          },
        });
      }
    }
  }
  return {
    findings,
    written,
    errors: {
      ...(today.checkpoints.length === 0
        ? {}
        : { today: today.checkpoints.at(-1)!.errors }),
      ...(compiled.checkpoints.length === 0
        ? {}
        : { compiled: compiled.checkpoints.at(-1)!.errors }),
    },
    flow,
    passes,
  };
};

/** One accepted difference. */
export type LedgerEntry = {
  /** The scenario, or `*` for every one. */
  scenario: string;
  /** The checkpoint, or `*`. */
  step: string;
  /** The position, or `*`. */
  position: string;
  kind: string;
  /** What each path gave, in words. */
  today: string;
  compiled: string;
  /** The ruling or the provisional decision that accepts it. */
  decision: string;
  /** False for a provisional decision the owner has not ratified. */
  ratified: boolean;
};

/** The ledger of accepted differences. */
export type Ledger = {
  /** How many scenarios a full run (`--sets` all, no `--only`) must hold. */
  fullRun?: FullRun;
  entries: LedgerEntry[];
};

/** Whether `pattern`, with `*` for any text, matches `text`. */
const matches = (pattern: string, text: string): boolean =>
  pattern === "*" ||
  new RegExp(
    `^${
      pattern.split("*").map((part) =>
        part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      ).join(".*")
    }$`,
  ).test(text);

/** The index of the first entry of `ledger` that covers `finding`. */
export const coveringEntry = (
  ledger: Ledger,
  finding: Finding,
): number | undefined => {
  const index = ledger.entries.findIndex((entry) =>
    entry.kind === finding.kind &&
    matches(entry.scenario, finding.scenario) &&
    matches(entry.step, finding.at) &&
    matches(entry.position, finding.position)
  );
  return index < 0 ? undefined : index;
};

/** Marks each finding the ledger covers, and counts what each entry covers. */
export const applyLedger = (
  ledger: Ledger,
  findings: Finding[],
  covered: number[] = ledger.entries.map(() => 0),
): number[] => {
  for (const finding of findings) {
    const index = coveringEntry(ledger, finding);
    if (index === undefined) continue;
    finding.acceptedBy = index;
    covered[index] += 1;
  }
  return covered;
};

/**
 * The entries of `ledger` that covered nothing, among those whose scenario
 * matches one that ran.
 */
export const staleEntries = (
  ledger: Ledger,
  covered: readonly number[],
  ran: readonly string[],
): LedgerEntry[] =>
  ledger.entries.filter((entry, index) =>
    covered[index] === 0 && ran.some((name) => matches(entry.scenario, name))
  );

/** How a scenario came out. */
export type Outcome =
  | { status: "equal" }
  | { status: "differing"; counts: Record<string, number> }
  | { status: "skipped"; reason: string };

/**
 * How a scenario came out from its findings after the ledger: equal where
 * every finding is accepted, differing where one is not. A scenario that
 * did not run is skipped, never equal.
 */
export const outcomeOf = (findings: readonly Finding[]): Outcome => {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    if (finding.acceptedBy !== undefined) continue;
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return Object.keys(counts).length === 0
    ? { status: "equal" }
    : { status: "differing", counts };
};

/** What the gate holds of one scenario. */
export type ScenarioResult = {
  scenario: string;
  outcome: Outcome;
  findings: Finding[];
  written?: Compared["written"];
  errors?: Compared["errors"];
  flow?: FlowCounts;
  passes?: Compared["passes"];
  /** Whether each piece ran as a compiled piece on the compiled path. */
  compiled?: Record<string, boolean>;
  /** Events a client could not send, for a scenario of the corpus. */
  unsent?: number;
  ms?: number;
};

/** What `runScenario` takes beside the scenario. */
export type RunScenarioOptions = {
  roles: Roles;
  compiler: PatternCompiler;
  /**
   * Whether a piece the compiled path did not run compiled makes the
   * scenario skipped, as for a module of the corpus the serving compiler
   * refuses, rather than a finding.
   */
  skipNotCompiled?: boolean;
  /**
   * Called with both runs before they are compared: a test of the
   * comparison edits what a run read from its store here.
   */
  edit?: (runs: BothRuns) => void;
};

/** Runs `scenario` on both paths and compares the runs. */
export const runScenario = async (
  scenario: GateScenario,
  options: RunScenarioOptions,
): Promise<ScenarioResult & { runs?: BothRuns }> => {
  const began = performance.now();
  if (scenario.skip !== undefined) {
    return {
      scenario: scenario.name,
      outcome: { status: "skipped", reason: scenario.skip },
      findings: [],
    };
  }
  let programs: Awaited<ReturnType<typeof programsOf>>;
  try {
    programs = await programsOf(scenario);
  } catch (error) {
    return {
      scenario: scenario.name,
      outcome: {
        status: "skipped",
        reason: `the program does not resolve: ${
          (error instanceof Error ? error.message : String(error)).split(
            "\n",
          )[0]
        }`,
      },
      findings: [],
    };
  }
  const today = await runPath(scenario, {
    path: "today",
    programs,
    roles: options.roles,
  });
  const compiled = await runPath(scenario, {
    path: "compiled",
    programs,
    roles: options.roles,
    compiler: options.compiler,
  });
  const runs: BothRuns = {
    scenario: scenario.name,
    today,
    compiled,
    ...(scenario.derived === undefined ? {} : { derived: scenario.derived }),
    roles: options.roles,
  };
  options.edit?.(runs);
  const ms = Math.round(performance.now() - began);
  if (today.failure !== undefined && compiled.failure !== undefined) {
    return {
      scenario: scenario.name,
      outcome: {
        status: "skipped",
        reason: `neither path ran it: ${today.failure}`,
      },
      findings: [],
      ms,
      runs,
    };
  }
  const notCompiled = Object.entries(compiled.compiled).filter(([, ran]) =>
    !ran
  );
  if (options.skipNotCompiled === true && notCompiled.length > 0) {
    return {
      scenario: scenario.name,
      outcome: {
        status: "skipped",
        reason: `the serving runtime did not run it compiled: ${
          compiled.refused[0] ?? "no compiled piece started"
        }`,
      },
      findings: [],
      compiled: compiled.compiled,
      ms,
      runs,
    };
  }
  const compared = compareRuns(runs);
  return {
    scenario: scenario.name,
    outcome: outcomeOf(compared.findings),
    findings: compared.findings,
    written: compared.written,
    errors: compared.errors,
    flow: compared.flow,
    passes: compared.passes,
    compiled: compiled.compiled,
    ms,
    runs,
  };
};

/** How many scenarios a full run must hold, as the ledger records it. */
export type FullRun = {
  /** The scenarios a full run plans, skipped ones among them. */
  scenarios: number;
  /** The scenarios a full run runs on both paths, not skipped. */
  ran: number;
};

/**
 * The exit status of a run of the gate: 0 only where at least one scenario
 * ran, no scenario differs in a finding the ledger does not cover, no entry
 * of the ledger covered nothing, and, for a full run (`full`, the figures
 * the ledger records), no fewer scenarios were planned and ran than the
 * ledger records. A skipped scenario is reported with its reason and is
 * neither equal nor differing.
 */
export const exitStatusOf = (
  outcomes: readonly Outcome[],
  stale: readonly LedgerEntry[],
  full?: FullRun,
): 0 | 1 => {
  const ran = outcomes.filter(({ status }) => status !== "skipped").length;
  if (ran === 0) return 1;
  if (
    full !== undefined && (outcomes.length < full.scenarios || ran < full.ran)
  ) {
    return 1;
  }
  return outcomes.some(({ status }) => status === "differing") ||
      stale.length > 0
    ? 1
    : 0;
};
