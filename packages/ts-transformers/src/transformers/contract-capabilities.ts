/**
 * The contract half of docs/history/plans/verb-input-contract.md, applied to
 * a verb's event as a narrowing of its generated schema.
 *
 * The event's schema is generated from its authored type as any schema is, so
 * it carries the authored structure, its `$defs`, its CFC labels, its writer
 * policies and its scopes. Each cell in it then takes the capability the
 * handler body earns at the cell's data path (`narrowEventCapabilities()`):
 * writable where the body writes, read-only where it reads, comparable where
 * it only compares, and opaque where it never touches the cell, never more
 * than the author wrote. A cell the body may use in a way its summary does
 * not record keeps the capability written for it.
 */

import type { JSONSchema } from "@commonfabric/api";
import {
  forEachSubschema,
  isSubschema,
  mapSubschemas,
} from "@commonfabric/data-model-schema/schema-walk";

import type { CapabilityParamSummary } from "../core/mod.ts";

type Path = readonly string[];
type Paths = readonly Path[];
type Schema = Record<string, unknown>;

/** A cell kind an `asCell` entry names (`CellKind` in `packages/api`). */
type CellKind =
  | "cell"
  | "opaque"
  | "stream"
  | "comparable"
  | "readonly"
  | "writeonly"
  | "sqlite";

/**
 * The kinds each kind grants at least, so a narrowing never grants more than
 * the author wrote: `opaque` grants nothing, `comparable` an identity,
 * `readonly` and `writeonly` each that and one of reading or writing, `cell`
 * all of it. A kind the table does not hold, a stream's or a SQLite handle's,
 * is authoritative, and is kept as written.
 */
const AT_MOST: Readonly<Record<string, ReadonlySet<string>>> = {
  cell: new Set(["cell", "readonly", "writeonly", "comparable", "opaque"]),
  readonly: new Set(["readonly", "comparable", "opaque"]),
  writeonly: new Set(["writeonly", "comparable", "opaque"]),
  comparable: new Set(["comparable", "opaque"]),
  opaque: new Set(["opaque"]),
};

/** `segment` with an array index read as any index, `*`. */
const normalized = (segment: string): string =>
  /^\d+$/.test(segment) ? "*" : segment;

/**
 * The uses a handler body makes of the value at one data path, each path
 * relative to it: what the summary records at or below the position, and
 * whether a use it does not record reaches the position at all.
 */
class ContractUses {
  constructor(
    readonly write: Paths,
    readonly read: Paths,
    readonly comparable: Paths,
    readonly exactComparable: Paths,
    readonly escaped: Paths,
    readonly wildcard: Paths,
    /** A value at or above the position escaped whole, or a wildcard above
     * it reaches it: the body may use it in any way. */
    readonly untracked: boolean,
  ) {}

  /** Whether a use the summary does not record may reach this position. */
  get untrackedHere(): boolean {
    return this.untracked || this.escaped.some((path) => path.length === 0);
  }

  /** Whether the body compares the value here by identity alone. */
  get comparedHere(): boolean {
    return this.exactComparable.some((path) => path.length === 0);
  }

  /**
   * Whether comparing the value here by identity is all the body does at or
   * below this position, so a comparable cell here hides nothing it uses. A
   * position several keys meet at, as a map's `additionalProperties` is,
   * gathers the uses of every key, and a read, a write, an escape or a
   * comparison below any of them needs the structure a cell would hide.
   */
  get onlyComparedHere(): boolean {
    const here = (paths: Paths) => paths.every((path) => path.length === 0);
    return this.comparedHere && !this.untrackedHere &&
      this.write.length === 0 && this.read.length === 0 &&
      this.escaped.length === 0 && this.wildcard.length === 0 &&
      here(this.comparable) && here(this.exactComparable);
  }

  /** The kind the body's uses at or below this position earn. */
  earned(): CellKind {
    if (this.write.length > 0) return "cell";
    if (this.read.length > 0) return "readonly";
    if (this.comparable.length > 0) return "comparable";
    return "opaque";
  }

  /** The uses at the property `name` names, compared as written, so a
   * declared `0` is not `1`. */
  property(name: string): ContractUses {
    return this.#below((used) => used === name);
  }

  /** The uses at an array's or a tuple's element, at whichever index. */
  element(): ContractUses {
    return this.#below((used) => normalized(used) === "*");
  }

  /** The uses at a member none of `declared` names, as an index signature
   * types. A key is compared as written, so a declared `0` does not declare
   * `1`. */
  undeclared(declared: ReadonlySet<string>): ContractUses {
    return this.#below((used) => !declared.has(used));
  }

  /** A key two equal sets of uses share, for specializing a definition:
   * each path as the summary records it, as the uses are matched, written
   * whole, so no key a segment holds can stand for a boundary between two. */
  key(): string {
    const paths = (list: Paths) =>
      list.map((path) => JSON.stringify(path)).sort();
    return JSON.stringify([
      paths(this.write),
      paths(this.read),
      paths(this.comparable),
      paths(this.exactComparable),
      paths(this.escaped),
      paths(this.wildcard),
      this.untracked,
    ]);
  }

  /** The uses at the child a segment `accepts` names, relative to it. */
  #below(accepts: (segment: string) => boolean): ContractUses {
    const strip = (paths: Paths) =>
      paths.flatMap((path) =>
        path.length > 0 && accepts(path[0]!) ? [path.slice(1)] : []
      );
    return new ContractUses(
      strip(this.write),
      strip(this.read),
      strip(this.comparable),
      strip(this.exactComparable),
      strip(this.escaped),
      strip(this.wildcard),
      // A wildcard here reaches every position strictly below it.
      this.untrackedHere || this.wildcard.some((path) => path.length === 0),
    );
  }

  static of(summary: CapabilityParamSummary): ContractUses {
    return new ContractUses(
      summary.writePaths,
      [
        ...summary.readPaths,
        ...summary.fullShapePaths ?? [],
        ...summary.opaquePaths ?? [],
      ],
      [
        ...summary.comparablePaths ?? [],
        ...summary.comparableCellPaths ?? [],
        ...summary.identityPaths ?? [],
        ...summary.identityCellPaths ?? [],
      ],
      [
        ...summary.comparableCellPaths ?? [],
        ...summary.identityCellPaths ?? [],
      ],
      summary.escapedPaths ?? [],
      summary.wildcardPaths ?? [],
      // A use the summary cannot verify, such as a mutator called by a name
      // the body computes, leaves its writes incomplete, so it may reach any
      // cell of the event.
      summary.hasUnverifiedCellUse ?? false,
    );
  }
}

/** `written` narrowed to `earned`, never granting more than `written`. */
function narrowedKind(written: string, earned: CellKind): string {
  return AT_MOST[written]?.has(earned) ? earned : written;
}

/**
 * `schema`, the schema generated from a verb's authored event type, with
 * each cell taking the capability `summary`, the handler body's capability
 * summary of the event, earns at the cell's data path.
 *
 * A data path is read from the schema's structure: a property's key, any key
 * the object does not declare for `additionalProperties`, `*` for `items`,
 * and the same path for each member of `anyOf`, `oneOf` and `allOf`. A cell's
 * value is not read: its capabilities are its own reads'. A definition a
 * `$ref` names is narrowed for the uses at the position it is referred to
 * from: kept as a reference where that changes nothing, inlined where it
 * does, and, where the narrowing refers to itself, as a recursion does, kept
 * as a definition of its own. Every other keyword is kept as generated.
 */
export function narrowEventCapabilities(
  schema: unknown,
  summary: CapabilityParamSummary,
): unknown {
  if (!isSchemaObject(schema)) {
    return comparedAny(schema, ContractUses.of(summary));
  }
  const definitions = isSchemaObject(schema.$defs) ? schema.$defs : {};
  const specialized = new Map<string, Specialization>();
  const names = new Map<string, string>();
  const added: Record<string, unknown> = {};

  const nameFor = (key: string, name: string): string => {
    let assigned = names.get(key);
    if (assigned) return assigned;
    for (let index = 1;; index++) {
      assigned = `${name}_narrowed${index === 1 ? "" : index}`;
      if (!(assigned in definitions) && !(assigned in added)) break;
    }
    names.set(key, assigned);
    return assigned;
  };

  // What a definition's reference to itself reads as while the definition is
  // narrowed: first that the narrowing changes nothing, which a recursion
  // holding nothing to narrow bears out, so it keeps its name; and, where the
  // narrowing does change it, a reference to the specialization's own name.
  const assumed = new Map<string, Specialization>();
  const referredToItself = new Set<string>();

  const specialize = (name: string, uses: ContractUses): Specialization => {
    const key = `${name}\x00${uses.key()}`;
    const known = specialized.get(key);
    if (known) return known;
    const assumption = assumed.get(key);
    if (assumption) {
      referredToItself.add(key);
      return assumption;
    }
    const definition = definitions[name];
    const settledBefore = new Set(specialized.keys());
    assumed.set(key, { kind: "same" });
    let narrowedDefinition = narrow(definition, uses);
    let result: Specialization;
    if (narrowedDefinition === definition) {
      result = { kind: "same" };
    } else if (referredToItself.has(key)) {
      // What was settled under the assumption that this changes nothing is
      // settled again.
      for (const settled of [...specialized.keys()]) {
        if (!settledBefore.has(settled)) specialized.delete(settled);
      }
      result = { kind: "ref", name: nameFor(key, name) };
      assumed.set(key, result);
      narrowedDefinition = narrow(definition, uses);
      added[result.name] = narrowedDefinition;
    } else {
      result = { kind: "inline", schema: narrowedDefinition };
    }
    assumed.delete(key);
    specialized.set(key, result);
    return result;
  };

  const narrow = (node: unknown, uses: ContractUses): unknown => {
    if (!isSchemaObject(node)) return comparedAny(node, uses);
    if (Array.isArray(node.asCell) && node.asCell.length > 0) {
      return narrowCell(node, uses);
    }
    if (uses.onlyComparedHere) return { ...node, asCell: ["comparable"] };
    let result: Schema = node;
    const set = (key: string, value: unknown) => {
      if (value === result[key]) return;
      if (result === node) result = { ...node };
      result[key] = value;
    };
    const ref = typeof node.$ref === "string"
      ? definitionName(node.$ref)
      : undefined;
    if (ref !== undefined && ref in definitions) {
      const target = specialize(ref, uses);
      if (target.kind === "ref") set("$ref", `#/$defs/${target.name}`);
      if (target.kind === "inline" && isSchemaObject(target.schema)) {
        const { $ref: _, ...siblings } = node;
        result = { ...target.schema, ...siblings };
      }
    }
    if (isSchemaObject(node.properties)) {
      const properties = node.properties;
      let changed = false;
      const narrowedProperties: Schema = {};
      for (const [key, value] of Object.entries(properties)) {
        narrowedProperties[key] = narrow(value, uses.property(key));
        if (narrowedProperties[key] !== value) changed = true;
      }
      if (changed) set("properties", narrowedProperties);
    }
    if (
      isSchemaObject(node.additionalProperties) ||
      node.additionalProperties === true
    ) {
      const declared = new Set(
        isSchemaObject(node.properties) ? Object.keys(node.properties) : [],
      );
      set(
        "additionalProperties",
        narrow(node.additionalProperties, uses.undeclared(declared)),
      );
    }
    if (isSchemaObject(node.items) || node.items === true) {
      set("items", narrow(node.items, uses.element()));
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      const members = node[keyword];
      if (!Array.isArray(members)) continue;
      const narrowedMembers = members.map((member) => narrow(member, uses));
      if (narrowedMembers.some((member, index) => member !== members[index])) {
        set(keyword, narrowedMembers);
      }
    }
    return result;
  };

  const root = narrow(schema, ContractUses.of(summary));
  // A narrowing that changes a definition changes what refers to it, up to
  // the root, so an unchanged root is the schema as it was.
  if (root === schema || !isSchemaObject(root)) return root;
  const all = { ...definitions, ...added };
  // A specialization takes the name of the definition it narrows where
  // nothing refers to that definition any more.
  const reached = reachableDefinitions(root, all);
  const renamed = new Map<string, string>();
  for (const [key, name] of names) {
    const original = key.slice(0, key.indexOf("\x00"));
    if (
      reached.has(name) && !reached.has(original) &&
      ![...renamed.values()].includes(original)
    ) {
      renamed.set(name, original);
    }
  }
  if (renamed.size === 0) return withDefinitions(root, all, reached);
  // Only schema positions are walked, so a `$ref` inside data, a `default`
  // or a `const`, stays as written.
  const rename = (node: JSONSchema): JSONSchema => {
    if (typeof node === "boolean") return node;
    const name = typeof node.$ref === "string"
      ? definitionName(node.$ref)
      : undefined;
    const to = name !== undefined ? renamed.get(name) : undefined;
    const children = mapSubschemas(node, rename, { includeUnused: true });
    return to === undefined ? children : { ...children, $ref: `#/$defs/${to}` };
  };
  const renamedDefinitions: Record<string, unknown> = {};
  for (const name of Object.keys(all)) {
    if (!reached.has(name)) continue;
    const definition = all[name];
    renamedDefinitions[renamed.get(name) ?? name] = isSubschema(definition)
      ? rename(definition)
      : definition;
  }
  const renamedRoot = isSubschema(root) ? rename(root) : root;
  if (!isSchemaObject(renamedRoot)) return renamedRoot;
  return withDefinitions(
    renamedRoot,
    renamedDefinitions,
    reachableDefinitions(renamedRoot, renamedDefinitions),
  );
}

type Specialization =
  | { readonly kind: "same" }
  | { readonly kind: "inline"; readonly schema: unknown }
  | { readonly kind: "ref"; readonly name: string };

/**
 * `node`, a schema that is not an object, as a position the body compares by
 * identity alone reads: `true`, which admits any value, becomes a comparable
 * cell; `false` admits nothing and stays as it is.
 */
function comparedAny(node: unknown, uses: ContractUses): unknown {
  return node === true && uses.onlyComparedHere
    ? { asCell: ["comparable"] }
    : node;
}

/** `node`, a cell, with its outermost entry narrowed to what `uses` earn. */
function narrowCell(node: Schema, uses: ContractUses): Schema {
  const [entry, ...rest] = node.asCell as unknown[];
  const written = typeof entry === "string"
    ? entry
    : isSchemaObject(entry) && typeof entry.kind === "string"
    ? entry.kind
    : undefined;
  if (written === undefined || uses.untrackedHere) return node;
  const kind = narrowedKind(written, uses.earned());
  if (kind === written) return node;
  return {
    ...node,
    asCell: [
      typeof entry === "string" ? kind : { ...entry as Schema, kind },
      ...rest,
    ],
  };
}

/** The names of the definitions `root` refers to, directly or through
 * another. */
function reachableDefinitions(
  root: Schema,
  definitions: Record<string, unknown>,
): Set<string> {
  const reached = new Set<string>();
  // Only schema positions are walked, so a `$ref` inside data reaches
  // nothing.
  const visit = (node: unknown): void => {
    if (!isSubschema(node) || typeof node === "boolean") return;
    const name = typeof node.$ref === "string"
      ? definitionName(node.$ref)
      : undefined;
    if (name !== undefined && !reached.has(name) && name in definitions) {
      reached.add(name);
      visit(definitions[name]);
    }
    forEachSubschema(node, (child) => {
      visit(child);
    }, { includeUnused: true });
  };
  visit(root);
  return reached;
}

/** `root` with the definitions `reached` names, in their order in
 * `definitions`, and none where it names none. */
function withDefinitions(
  root: Schema,
  definitions: Record<string, unknown>,
  reached: ReadonlySet<string>,
): Schema {
  const { $defs: _, ...body } = root;
  if (reached.size === 0) return body;
  const kept: Record<string, unknown> = {};
  for (const name of Object.keys(definitions)) {
    if (reached.has(name)) kept[name] = definitions[name];
  }
  return { ...body, $defs: kept };
}

function definitionName(ref: string): string | undefined {
  return ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
}

function isSchemaObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
