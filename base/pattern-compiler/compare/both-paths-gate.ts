/**
 * The comparison of the two-principal gate (`both-paths.ts`): what two runs
 * of one scenario, on today's path and on the compiled path
 * (`both-paths-serving.ts`), did differently, what each did that no
 * counterpart is needed to find wrong, and which of those the ledger of
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
 * Documents that back no member of a result (the argument and process
 * documents where nothing links them, a compiled piece's own documents such
 * as its basis and the instances of its scoped outputs where nothing links
 * them, stream markers and sidecars, schema and label documents) are not
 * matched one to one. Their clauses are pooled by the kind of their scope
 * and its principal (`pool:space`, `pool:user:A`, ...), and a clause in one
 * path's pool and not in the other's is a difference at that pool.
 *
 * **Kinds of finding.**
 * - `commit`: one path committed what the other refused.
 * - `message`: both refused, with other messages.
 * - `value`: a principal reads a value on one path and another on the
 *   other; `hidden`: a principal reads a value on one path and is refused it
 *   on the other; `read-failed`: a read failed on one path alone.
 * - `label-missing`, `label-extra`: a clause or an integrity atom today's
 *   path stores at a position and the compiled path does not, and the
 *   reverse.
 * - `policy`: the write policies the stored schema declares at a position
 *   differ, by the path of each writer's binding.
 * - `module-identity`: the identity of the module a writer claim names
 *   differs, which it does by construction (note 764 of `SPEC-NOTES.md`).
 * - `error-state`: an error state in a path's store, by message.
 * - `foreign-clause`: derived check (a), a document of the scope `space`
 *   whose label holds a clause naming one of the two principals where
 *   today's path holds no such clause at the same position. On today's path
 *   such clauses are listed (`todayForeignClauses`) and are no finding.
 * - `crossed-clause`: the same for an instance of the scope `user` or
 *   `session` of one principal whose label holds a clause naming the other.
 * - `foreign-value`: derived check (b), text of one principal's scope that
 *   the other principal reads, or that a document the other principal may
 *   read holds at a position whose label names no clause of the first
 *   principal; on either path.
 * - `failure`: a run ended with an error; `not-compiled`: a piece of the
 *   compiled path did not run as a compiled piece.
 *
 * Values are compared with `valueEqual` of `@commonfabric/data-model`,
 * labels as the text `toCompactDebugString` gives each clause and atom, with
 * the identifiers of principals, entities and hashes replaced by names.
 */
import {
  type FabricValue,
  hashStringOf,
  isFabricArray,
  isFabricPlainObject,
  toCompactDebugString,
  valueEqual,
} from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/js-values/types";

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
import { linksIn, type StoredDocument } from "./both-paths-store.ts";

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
  /** The document and the path in it, for a derived check. */
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
  confidentiality: string[];
  integrity: string[];
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

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

/** The name of a document instance's scope, with its principal named. */
const scopeName = (document: StoredDocument, run: PathRun): string => {
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

/** What `walkPositions` gives for one checkpoint of one path. */
export type Positions = {
  /** The labels at each position. */
  labels: Map<string, PositionLabels>;
  /** The position of each document instance and path a walk reached. */
  reached: Map<string, string>;
  /** The clauses of the documents no walk reached, by pool. */
  pools: Map<string, Set<string>>;
};

/** The key of a document instance and a path in it. */
const placeKey = (document: StoredDocument, path: readonly string[]) =>
  `${document.id}\n${document.scopeKey}\n${path.join("/")}`;

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
  const mountedDocuments = new Set<string>();
  const text = (value: unknown) =>
    normalized(toCompactDebugString(value as FabricValue), run);
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
  const add = (
    position: string,
    document: StoredDocument,
    entryLabels: { confidentiality: unknown[]; integrity: unknown[] },
    prefix = "",
  ) => {
    const held = labels.get(position) ?? {
      document: `${scopeName(document, run)} ${document.id.slice(0, 18)}`,
      confidentiality: [],
      integrity: [],
      policies: [],
      modules: [],
    };
    held.confidentiality = sorted([
      ...held.confidentiality,
      ...entryLabels.confidentiality.map((clause) =>
        `${prefix}${text(clause)}`
      ),
    ]);
    held.integrity = sorted([
      ...held.integrity,
      ...entryLabels.integrity.map((atom) => `${prefix}${text(atom)}`),
    ]);
    labels.set(position, held);
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
    mountedDocuments.add(`${document.id}\n${document.scopeKey}`);
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
        add(where, document, { confidentiality, integrity });
        reached.set(placeKey(document, path), where);
      } else if (startsWith(at, path)) {
        add(position, document, { confidentiality, integrity }, "above ");
      }
    }
    if (schema !== undefined) {
      const policies = policiesOf(
        schema,
        at,
        (hash) => snapshot.contentOf(`cid:${hash}`),
      );
      for (const [below, lines] of Object.entries(policies)) {
        const where = `${position}${below}`;
        const held = labels.get(where) ?? {
          document: `${scopeName(document, run)} ${document.id.slice(0, 18)}`,
          confidentiality: [],
          integrity: [],
          policies: [],
          modules: [],
        };
        held.policies = sorted([...held.policies, ...lines]);
        labels.set(where, held);
      }
      const modules = new Set<string>();
      modulesIn(schemaAt(schema, at), modules);
      if (modules.size > 0) {
        const held = labels.get(position) ?? {
          document: `${scopeName(document, run)} ${document.id.slice(0, 18)}`,
          confidentiality: [],
          integrity: [],
          policies: [],
          modules: [],
        };
        held.modules = sorted([...held.modules, ...modules]);
        labels.set(position, held);
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
  const pools = new Map<string, Set<string>>();
  for (const document of snapshot.documents) {
    if (mountedDocuments.has(`${document.id}\n${document.scopeKey}`)) continue;
    const pool = `pool:${scopeName(document, run)}`;
    const held = pools.get(pool) ?? new Set<string>();
    for (const entry of document.metadata?.labelMap.entries ?? []) {
      for (const clause of entry.label.confidentiality ?? []) {
        held.add(text(clause));
      }
    }
    pools.set(pool, held);
  }
  return { labels, reached, pools };
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

/** A clause naming a principal in a document of the scope `space`. */
export type ForeignClause = {
  document: string;
  path: string;
  /** The position a walk reached the path at, where one did. */
  position?: string;
  principal: Who;
  clause: string;
};

/**
 * Each clause of a document of the scope `space` that names A or B, and,
 * with `crossed`, each clause of an instance of the scope `user` or
 * `session` of one principal that names the other.
 */
export const foreignClausesOf = (
  run: PathRun,
  checkpoint: Checkpoint,
  positions: Positions,
  crossed = false,
): ForeignClause[] => {
  const found: ForeignClause[] = [];
  for (const document of checkpoint.snapshot.documents) {
    const scope = scopeName(document, run);
    if (
      crossed
        ? scope === "space" || scope.endsWith(":other")
        : scope !== "space"
    ) {
      continue;
    }
    for (const entry of document.metadata?.labelMap.entries ?? []) {
      const path = entry.path.map(String);
      for (const clause of entry.label.confidentiality ?? []) {
        for (const who of WHO) {
          if (crossed && scope.endsWith(`:${who}`)) continue;
          if (!namesPrincipal(clause, run.identities.principals[who])) continue;
          const position = positionOf(positions, document, path);
          found.push({
            document: document.id,
            path: `/${path.join("/")}`,
            ...(position === undefined ? {} : { position }),
            principal: who,
            clause: normalized(
              toCompactDebugString(clause as FabricValue),
              run,
            ),
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
): { path: string[]; text: string }[] => {
  if (typeof value === "string") found.push({ path: at, text: value });
  else if (isFabricArray(value as FabricValue) || Array.isArray(value)) {
    (value as unknown[]).forEach((member, index) =>
      stringsIn(member, [...at, String(index)], found)
    );
  } else if (isFabricPlainObject(value as FabricValue)) {
    for (const [name, member] of Object.entries(value as object)) {
      stringsIn(member, [...at, name], found);
    }
  }
  return found;
};

/** Text of one principal's scope where the other may read it. */
export type ForeignValue = {
  /** The member read, or the document and path. */
  where: string;
  document?: string;
  /** Whose scope the text is of. */
  of: Who;
  /** Who may read it. */
  reader: Who;
  text: string;
};

/**
 * Derived check (b) at `checkpoint` of one path: each place that `reader`
 * reads, or a document of the space or of `reader`'s scope holds at a path
 * whose label names no clause of the other principal, holding text of the
 * other principal's scope that no step shared.
 */
export const foreignValuesOf = (
  run: PathRun,
  checkpoint: Checkpoint,
  positions: Positions,
): ForeignValue[] => {
  const found: ForeignValue[] = [];
  for (const reader of WHO) {
    const of: Who = reader === "A" ? "B" : "A";
    const texts = run.scoped[of].filter((text) =>
      !checkpoint.shared.some((shared) =>
        shared.includes(text) || text.includes(shared)
      )
    );
    if (texts.length === 0) continue;
    const holds = (value: string) => texts.find((text) => value.includes(text));
    for (const [member, read] of Object.entries(checkpoint.reads[reader])) {
      if (!("value" in read)) continue;
      for (const { path, text } of stringsIn(read.value)) {
        const held = holds(text);
        if (held !== undefined) {
          found.push({
            where: `${member}${path.length === 0 ? "" : `/${path.join("/")}`}`,
            of,
            reader,
            text: held,
          });
        }
      }
    }
    const ofDid = run.identities.principals[of];
    for (const document of checkpoint.snapshot.documents) {
      const name = scopeName(document, run);
      if (name !== "space" && !name.endsWith(`:${reader}`)) continue;
      for (const { path, text } of stringsIn(document.value)) {
        const held = holds(text);
        if (held === undefined) continue;
        // A path whose label names the other principal is not one the
        // reader is shown.
        const protectedHere = (document.metadata?.labelMap.entries ?? []).some(
          (entry) =>
            startsWith(path, entry.path.map(String)) &&
            (entry.label.confidentiality ?? []).some((clause) =>
              namesPrincipal(clause, ofDid)
            ),
        );
        if (protectedHere) continue;
        const position = positionOf(positions, document, path);
        found.push({
          where: position ??
            `${name} ${document.id.slice(0, 18)}/${path.join("/")}`,
          document: `${name} ${document.id}`,
          of,
          reader,
          text: held,
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
  /** The clauses naming a principal that today's path stores in the space. */
  todayForeignClauses: ForeignClause[];
};

/** Compares the two runs of a scenario. */
export const compareRuns = (
  { scenario, today, compiled }: BothRuns,
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
  const firstSeen = new Set<string>();
  const once = (key: string, finding: Omit<Finding, "scenario">) => {
    if (firstSeen.has(key)) return;
    firstSeen.add(key);
    find(finding);
  };
  const todayForeign: ForeignClause[] = [];
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
    const positions = sorted([...pa.labels.keys(), ...pb.labels.keys()]);
    for (const position of positions) {
      const la = pa.labels.get(position);
      const lb = pb.labels.get(position);
      for (const axis of ["confidentiality", "integrity"] as const) {
        const sa = new Set(la?.[axis] ?? []);
        const sb = new Set(lb?.[axis] ?? []);
        for (const label of sa) {
          if (!sb.has(label)) {
            find({
              at,
              kind: "label-missing",
              position,
              today: `${axis} ${label}`,
              compiled: lb === undefined ? "no such position" : lb.document,
            });
          }
        }
        for (const label of sb) {
          if (!sa.has(label)) {
            find({
              at,
              kind: "label-extra",
              position,
              today: la === undefined ? "no such position" : la.document,
              compiled: `${axis} ${label}`,
            });
          }
        }
      }
      const policiesA = la?.policies ?? [];
      const policiesB = lb?.policies ?? [];
      if (policiesA.join("\n") !== policiesB.join("\n")) {
        find({
          at,
          kind: "policy",
          position,
          today: policiesA,
          compiled: policiesB,
        });
      }
      const modulesA = la?.modules ?? [];
      const modulesB = lb?.modules ?? [];
      if (modulesA.join("\n") !== modulesB.join("\n")) {
        find({
          at,
          kind: "module-identity",
          position,
          today: modulesA,
          compiled: modulesB,
        });
      }
    }
    const pools = sorted([...pa.pools.keys(), ...pb.pools.keys()]);
    for (const pool of pools) {
      const sa = pa.pools.get(pool) ?? new Set();
      const sb = pb.pools.get(pool) ?? new Set();
      for (const clause of sa) {
        if (!sb.has(clause)) {
          find({ at, kind: "label-missing", position: pool, today: clause });
        }
      }
      for (const clause of sb) {
        if (!sa.has(clause)) {
          find({ at, kind: "label-extra", position: pool, compiled: clause });
        }
      }
    }
    // Derived check (a), and a clause of one principal in an instance of
    // the other's scope.
    for (const crossed of [false, true]) {
      for (const clause of foreignClausesOf(today, a, pa, crossed)) {
        const key =
          `today ${crossed} ${clause.document} ${clause.path} ${clause.clause}`;
        if (!firstSeen.has(key)) {
          firstSeen.add(key);
          todayForeign.push(clause);
        }
      }
    }
    for (const crossed of [false, true]) {
      for (const clause of foreignClausesOf(compiled, b, pb, crossed)) {
        const atToday = clause.position !== undefined &&
          (pa.labels.get(clause.position)?.confidentiality ?? []).includes(
            clause.clause,
          );
        if (atToday) continue;
        once(
          `compiled ${crossed} ${clause.document} ${clause.path} ${clause.clause}`,
          {
            at,
            kind: crossed ? "crossed-clause" : "foreign-clause",
            position: clause.position ??
              `unreached ${clause.document.slice(0, 18)}${clause.path}`,
            principal: clause.principal,
            on: "compiled",
            document: `${clause.document}${clause.path}`,
            compiled: clause.clause,
          },
        );
      }
    }
    // Derived check (b), on each path alone.
    for (
      const [path, run, checkpoint, walked] of [
        ["today", today, a, pa],
        ["compiled", compiled, b, pb],
      ] as const
    ) {
      for (const value of foreignValuesOf(run, checkpoint, walked)) {
        once(`${path} b ${value.where} ${value.text} ${value.reader}`, {
          at,
          kind: "foreign-value",
          position: value.where,
          principal: value.reader,
          on: path,
          ...(value.document === undefined ? {} : { document: value.document }),
          [path]: `${value.of}'s "${value.text}" readable by ${value.reader}`,
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
    todayForeignClauses: todayForeign,
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
export type Ledger = { entries: LedgerEntry[] };

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
  todayForeignClauses?: ForeignClause[];
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
  const runs = { scenario: scenario.name, today, compiled };
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
    todayForeignClauses: compared.todayForeignClauses,
    compiled: compiled.compiled,
    ms,
    runs,
  };
};

/**
 * The exit status of a run of the gate: 0 only where no scenario differs in
 * a finding the ledger does not cover and no entry of the ledger covered
 * nothing. A skipped scenario is reported with its reason and is neither.
 */
export const exitStatusOf = (
  outcomes: readonly Outcome[],
  stale: readonly LedgerEntry[],
): 0 | 1 =>
  outcomes.some(({ status }) => status === "differing") || stale.length > 0
    ? 1
    : 0;
