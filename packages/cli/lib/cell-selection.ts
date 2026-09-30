/**
 * The selection a CLI read applies to a cell it has already arrived at: the
 * `--filter` predicate and the `--select`/`--schema` projection, their parsers,
 * and the step that turns a cell plus a selection into a value. Resolving an
 * address to a cell belongs to whoever holds the address, and stays there.
 */

import type { Cell } from "@commonfabric/api";
import { ANNOTATION_KEYS } from "@commonfabric/piece/schema-compatibility";
import {
  ContextualFlowControl,
  createBuilder,
  deepEqual,
  isLink,
  type JSONSchema,
  KeepAsCell,
  type MemorySpace,
  type NormalizedFullLink,
  parseLink,
  type Pattern,
  type Runtime,
  sanitizeSchemaForLinks,
} from "@commonfabric/runner";
import {
  cfcSchemaResolvedRoot,
  hoistCfcSchemaDefs,
  isEmbeddedCfcSchemaRef,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "@commonfabric/runner/cfc/schema-refs";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import {
  isInstance,
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/utils/types";
import { runtimeErrorLog } from "./callable.ts";
import {
  declaredFieldNames,
  declaredFieldsAt,
  isSchemaObject,
  schemaIsArrayShaped,
  schemaIsObjectShaped,
} from "./declared-fields.ts";
import { nearestName } from "./refusal.ts";
import { timeCliPhase } from "./trace-timing.ts";

type PredicateComparisonOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** A parsed `--filter` expression, evaluated against one array element. */
export type SelectionPredicate =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "path"; path: Array<string | number> }
  | { kind: "not"; value: SelectionPredicate }
  | {
    kind: "boolean";
    operator: "and" | "or";
    left: SelectionPredicate;
    right: SelectionPredicate;
  }
  | {
    kind: "comparison";
    operator: PredicateComparisonOperator;
    left: SelectionPredicate;
    right: SelectionPredicate;
  };

/**
 * A `--filter` argument, parsed. `source` is the text as written, kept for
 * error messages and for the result cell's cause. `paths` collects every path
 * the predicate reads, which narrows the schema the source is read through.
 */
export interface ParsedSelectionFilter {
  source: string;
  predicate: SelectionPredicate;
  paths: Array<Array<string | number>>;
}

/** The key a caller writes beside `properties` to ask for an address. */
export const LINK_MARKER_KEY = "$link";

/**
 * The character a concise field path ends a segment with to ask for the
 * address of the position that segment names. A backslash before it writes a
 * literal `@`, which a name needs only at the end of its segment: anywhere
 * else in a segment `@` is an ordinary character.
 */
const CONCISE_ADDRESS_SUFFIX = "@";

/** A phase of `deriveSelectedValue`, named for the operation like every other
 * label. The phases are strict siblings, so they add up; what they must not be
 * added to is whichever phase encloses the selection — `getCellValue.selection`
 * on `cf cell get`, and on `cf piece call` and `cf wish` nothing yet. */
const timeSelectionPhase = <T>(
  label: string,
  run: () => T | Promise<T>,
): Promise<T> => timeCliPhase(`deriveSelectedValue.${label}`, run);

/**
 * The address a marked position accumulates as the walk descends, which is
 * serialized into the LLM-friendly reference it renders as. `id` keeps its
 * scheme, because the scheme is the kind and dropping it retargets the address
 * silently; `path` is `[]` at a document's root.
 *
 * The address names the deepest stored link crossed on the way to the marked
 * position, plus the segments below that link. A link is a durable identity
 * and a position in a containing document is not: reorder the collection
 * above it and the same position holds a different value.
 *
 * `overwrite` is dropped and `schema` is never inlined. A stored link can
 * carry an entire schema with its own `$defs`, and what was asked for is
 * where the value lives, not what shape it declares.
 */
export interface RenderedLinkAddress {
  id: NormalizedFullLink["id"];
  space: NormalizedFullLink["space"];
  scope: NormalizedFullLink["scope"];
  path: string[];
}

/**
 * The positions a projection marked for their address, mirroring the
 * projection's own shape. A node exists only where it, or something below it,
 * is marked.
 */
export interface LinkMarkers {
  /** The address at this position was asked for. */
  marked?: true;

  properties?: Record<string, LinkMarkers>;
  items?: LinkMarkers;
}

/**
 * The flag a projection was written on. `--select` takes the concise field
 * list; `--schema` takes a JSON Schema, an `@file`, and the concise list too.
 * Which one was written decides nothing about what the projection means — only
 * which flag its error messages name.
 */
export type ProjectionFlag = "--select" | "--schema";

/**
 * A projection argument, parsed. `source` is the text as written; `kind`
 * records which of the two spellings it used, since a concise field list
 * traverses arrays implicitly and a JSON Schema does not. `schema` carries no
 * `$link` marker: markers move to `markers`, and a position that asked for
 * nothing but an address becomes the `false` schema there.
 */
export interface SelectionProjection {
  source: string;
  schema: JSONSchema;
  kind: "concise" | "json";
  flag: ProjectionFlag;
  markers?: LinkMarkers;
}

/**
 * What a caller asked to be returned from the cell it selected. Both parts are
 * optional; a selection with neither returns the whole value.
 */
export interface CellSelection {
  filter?: ParsedSelectionFilter;
  projection?: SelectionProjection;
}

/**
 * A selection that cannot be parsed, or that does not fit the value it was
 * pointed at — a `--filter` on a non-array, a projection whose root shape
 * disagrees with the source. Reported to the user as a data error, not as an
 * argument-parsing failure.
 */
export class CellSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CellSelectionError";
  }
}

type TokenKind =
  | "dot"
  | "left-bracket"
  | "right-bracket"
  | "left-paren"
  | "right-paren"
  | "operator"
  | "identifier"
  | "string"
  | "number"
  | "eof";

interface Token {
  kind: TokenKind;
  value?: string | number;
  position: number;
}

function expressionError(source: string, position: number, message: string) {
  return new CellSelectionError(
    `Invalid --filter predicate at column ${position + 1}: ${message}\n` +
      `  ${source}`,
  );
}

function tokenizePredicate(source: string): Token[] {
  const result: Token[] = [];
  let position = 0;

  while (position < source.length) {
    const char = source[position];
    if (/\s/.test(char)) {
      position++;
      continue;
    }
    const punctuation: Partial<Record<string, TokenKind>> = {
      ".": "dot",
      "[": "left-bracket",
      "]": "right-bracket",
      "(": "left-paren",
      ")": "right-paren",
    };
    const punctuationKind = punctuation[char];
    if (punctuationKind !== undefined) {
      result.push({ kind: punctuationKind, position });
      position++;
      continue;
    }

    const operator = source.slice(position).match(/^(==|!=|<=|>=|<|>)/)?.[0];
    if (operator !== undefined) {
      result.push({ kind: "operator", value: operator, position });
      position += operator.length;
      continue;
    }

    if (char === '"') {
      let end = position + 1;
      let escaped = false;
      for (; end < source.length; end++) {
        const candidate = source[end];
        if (!escaped && candidate === '"') break;
        if (!escaped && candidate === "\\") {
          escaped = true;
        } else {
          escaped = false;
        }
      }
      if (end >= source.length) {
        throw expressionError(source, position, "unterminated string literal");
      }
      const literal = source.slice(position, end + 1);
      let value: string;
      try {
        value = JSON.parse(literal);
      } catch {
        throw expressionError(source, position, "invalid string literal");
      }
      result.push({ kind: "string", value, position });
      position = end + 1;
      continue;
    }

    const number = source.slice(position).match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    )?.[0];
    if (number !== undefined) {
      result.push({ kind: "number", value: Number(number), position });
      position += number.length;
      continue;
    }

    const identifier = source.slice(position).match(
      /^[A-Za-z_$][A-Za-z0-9_$-]*/,
    )?.[0];
    if (identifier !== undefined) {
      result.push({ kind: "identifier", value: identifier, position });
      position += identifier.length;
      continue;
    }

    throw expressionError(
      source,
      position,
      `unexpected character ${JSON.stringify(char)}`,
    );
  }

  result.push({ kind: "eof", position: source.length });
  return result;
}

class PredicateParser {
  #index = 0;

  readonly #source: string;
  readonly #tokens: Token[];

  constructor(
    source: string,
    tokens: Token[],
  ) {
    this.#source = source;
    this.#tokens = tokens;
  }

  parse(): SelectionPredicate {
    const result = this.#parseOr();
    const trailing = this.#peek();
    if (trailing.kind !== "eof") {
      throw expressionError(
        this.#source,
        trailing.position,
        "unexpected trailing input",
      );
    }
    return result;
  }

  #peek(): Token {
    return this.#tokens[this.#index];
  }

  #take(): Token {
    return this.#tokens[this.#index++];
  }

  #takeKind(kind: TokenKind, message: string): Token {
    const token = this.#peek();
    if (token.kind !== kind) {
      throw expressionError(this.#source, token.position, message);
    }
    return this.#take();
  }

  #takeKeyword(keyword: string): boolean {
    const token = this.#peek();
    if (token.kind === "identifier" && token.value === keyword) {
      this.#take();
      return true;
    }
    return false;
  }

  #parseOr(): SelectionPredicate {
    let left = this.#parseAnd();
    while (this.#takeKeyword("or")) {
      left = {
        kind: "boolean",
        operator: "or",
        left,
        right: this.#parseAnd(),
      };
    }
    return left;
  }

  #parseAnd(): SelectionPredicate {
    let left = this.#parseComparison();
    while (this.#takeKeyword("and")) {
      left = {
        kind: "boolean",
        operator: "and",
        left,
        right: this.#parseComparison(),
      };
    }
    return left;
  }

  #parseComparison(): SelectionPredicate {
    const left = this.#parseUnary();
    const token = this.#peek();
    if (token.kind !== "operator") return left;
    this.#take();
    return {
      kind: "comparison",
      operator: token.value as PredicateComparisonOperator,
      left,
      right: this.#parseUnary(),
    };
  }

  #parseUnary(): SelectionPredicate {
    if (this.#takeKeyword("not")) {
      return { kind: "not", value: this.#parseUnary() };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): SelectionPredicate {
    const token = this.#peek();
    if (token.kind === "left-paren") {
      this.#take();
      const result = this.#parseOr();
      this.#takeKind("right-paren", 'expected ")"');
      return result;
    }
    if (token.kind === "dot") return this.#parsePath();
    if (token.kind === "string" || token.kind === "number") {
      this.#take();
      return {
        kind: "literal",
        value: token.value as string | number,
      };
    }
    if (token.kind === "identifier") {
      const literal = token.value === "true"
        ? true
        : token.value === "false"
        ? false
        : token.value === "null"
        ? null
        : undefined;
      if (literal !== undefined || token.value === "null") {
        this.#take();
        return { kind: "literal", value: literal ?? null };
      }
    }
    throw expressionError(
      this.#source,
      token.position,
      "expected a path, literal, or parenthesized expression",
    );
  }

  #parsePath(): SelectionPredicate {
    this.#take();
    const path: Array<string | number> = [];
    const first = this.#peek();
    if (first.kind === "identifier") {
      path.push(String(this.#take().value));
    }

    while (true) {
      const token = this.#peek();
      if (token.kind === "dot") {
        this.#take();
        path.push(
          String(
            this.#takeKind(
              "identifier",
              "expected a property name after dot",
            ).value,
          ),
        );
        continue;
      }
      if (token.kind === "left-bracket") {
        this.#take();
        const segment = this.#peek();
        if (segment.kind !== "string" && segment.kind !== "number") {
          throw expressionError(
            this.#source,
            segment.position,
            "expected a string or number inside brackets",
          );
        }
        this.#take();
        path.push(segment.value as string | number);
        this.#takeKind("right-bracket", 'expected "]"');
        continue;
      }
      break;
    }
    return { kind: "path", path };
  }
}

function collectPredicatePaths(
  predicate: SelectionPredicate,
  result: Array<Array<string | number>>,
): void {
  switch (predicate.kind) {
    case "path":
      result.push(predicate.path);
      break;
    case "not":
      collectPredicatePaths(predicate.value, result);
      break;
    case "boolean":
    case "comparison":
      collectPredicatePaths(predicate.left, result);
      collectPredicatePaths(predicate.right, result);
      break;
    case "literal":
      break;
  }
}

export function parseSelectionFilter(source: string): ParsedSelectionFilter {
  if (source.trim().length === 0) {
    throw new CellSelectionError("--filter predicate must not be empty");
  }
  const predicate = new PredicateParser(
    source,
    tokenizePredicate(source),
  ).parse();
  const paths: Array<Array<string | number>> = [];
  collectPredicatePaths(predicate, paths);
  return { source, predicate, paths };
}

function valueAtPredicatePath(
  value: unknown,
  path: Array<string | number>,
): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current) && typeof segment === "number") {
      const index = segment < 0 ? current.length + segment : segment;
      current = index >= 0 && index < current.length ? current[index] : null;
      continue;
    }
    if (
      typeof current === "object" && !Array.isArray(current) &&
      typeof segment === "string"
    ) {
      current = Object.hasOwn(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : null;
      continue;
    }
    return null;
  }
  return current;
}

function predicateTruthiness(value: unknown): boolean {
  return value !== false && value != null;
}

function comparePredicateValues(
  operator: PredicateComparisonOperator,
  left: unknown,
  right: unknown,
): boolean {
  if (operator === "==") return deepEqual(left, right);
  if (operator === "!=") return !deepEqual(left, right);
  if (
    (typeof left !== "number" || typeof right !== "number") &&
    (typeof left !== "string" || typeof right !== "string")
  ) {
    throw new CellSelectionError(
      `--filter ${operator} requires two numbers or two strings`,
    );
  }
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

export function evaluateSelectionPredicate(
  predicate: SelectionPredicate,
  value: unknown,
): boolean {
  const evaluate = (node: SelectionPredicate): unknown => {
    switch (node.kind) {
      case "literal":
        return node.value;
      case "path":
        return valueAtPredicatePath(value, node.path);
      case "not":
        return !predicateTruthiness(evaluate(node.value));
      case "boolean": {
        const left = predicateTruthiness(evaluate(node.left));
        if (node.operator === "and") {
          return left && predicateTruthiness(evaluate(node.right));
        }
        return left || predicateTruthiness(evaluate(node.right));
      }
      case "comparison":
        return comparePredicateValues(
          node.operator,
          evaluate(node.left),
          evaluate(node.right),
        );
    }
  };
  return predicateTruthiness(evaluate(predicate));
}

const FORBIDDEN_PROJECTION_KEYS = new Set([
  "asCell",
  "default",
  "ifc",
  "scope",
]);
const UNSUPPORTED_PROJECTION_KEYS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "contains",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "contentSchema",
]);

/**
 * The keywords that apply to an object and to nothing else. Naming one says
 * which container the position describes, so the traversal that reads the
 * projection back needs no separate `type` from the caller; the array half is
 * `ARRAY_PROJECTION_KEYS` below.
 */
const OBJECT_PROJECTION_KEYS = [
  "properties",
  "additionalProperties",
  "required",
  "minProperties",
  "maxProperties",
];

/** The keywords that apply to an array and to nothing else. */
const ARRAY_PROJECTION_KEYS = [
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
];

/**
 * What the reader does with a projection keyword. A registry that recorded a
 * spelling rather than a class could not tell `consulted` from `tolerated`:
 * both are accepted and neither reaches the schema the reader hands on, but
 * only one of them changed the read on the way. A key admitted without its
 * kind has its treatment decided by whatever the reader happens to default to.
 */
export type ProjectionKeyTier =
  | "honored"
  | "consulted"
  | "tolerated"
  | "refused";

/**
 * The keywords the projection drives itself from. These are the only ones the
 * reader carries into the schema it constructs, and `type` is why that
 * construction reads the classified projection rather than the mask: a scalar
 * leaf's declared `type` is the whole of what filters that leaf, and a mask
 * reduces every scalar position to `true`.
 */
const HONORED_PROJECTION_KEYS = new Set([
  "type",
  "properties",
  "items",
  "additionalProperties",
  LINK_MARKER_KEY,
]);

/**
 * The keywords {@link impliedProjectionType} reads to decide which container an
 * untyped position describes, less the three tier H already claims. They
 * change the read — a position naming only `minItems` reads as an array — and
 * are then consumed: nothing the caller wrote in one reaches the read
 * boundary. The reader may still emit `required` there on its own authority
 * and with the source's meaning, which is a different key of the same
 * spelling; {@link outputSchemaWithSourceRequired} is where that happens.
 */
const CONSULTED_PROJECTION_KEYS = new Set([
  "required",
  "minProperties",
  "maxProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/**
 * The annotation keywords projection refuses anyway. `default` is the source
 * schema's to state, and the two definition keys have no meaning without the
 * `$ref` projection also refuses.
 *
 * Every member is refused **by one of the two denylists above** rather than by
 * the fall-through, which is asserted over the message each one produces:
 * dropping a key from its denylist leaves it refused either way, since this set
 * is what keeps it out of tier T, and only the answer changes. Separately, the
 * coupling test asserts the two set relations in both directions — a key
 * dropped from `ANNOTATION_KEYS` and left stranded here is drift a
 * one-directional assertion misses.
 *
 * @internal Exported for the `ANNOTATION_KEYS` coupling and refusal tests.
 */
export const PROJECTION_ANNOTATION_EXCEPTIONS: ReadonlySet<string> = new Set([
  "default",
  "$defs",
  "definitions",
]);

/**
 * The keywords a caller may write that change nothing. Derived rather than
 * restated, so that admitting a keyword to the durable dialect's annotations
 * admits it here too — unless it is one of the three
 * {@link PROJECTION_ANNOTATION_EXCEPTIONS} names.
 *
 * @internal Exported so the inertness test derives the keys it probes from
 * this set rather than from a list someone typed. Membership here makes a key
 * a candidate; that it changes nothing on a read is a separate obligation, and
 * a test iterating its own copy would never notice a key that arrived without
 * discharging it.
 */
export const TOLERATED_PROJECTION_KEYS: ReadonlySet<string> = new Set(
  [...ANNOTATION_KEYS].filter((key) =>
    !PROJECTION_ANNOTATION_EXCEPTIONS.has(key)
  ),
);

/**
 * The tolerated keywords the reader accepts and drops rather than carries.
 * Membership in `ANNOTATION_KEYS` makes a key a candidate; that the checker
 * may ignore it when comparing two schemas says nothing about what the
 * **runner** does with it on a read, and only the second question decides
 * whether carrying it is inert.
 *
 * `$id` and `$schema` declare the identity and dialect of a document, and the
 * reader is not producing the caller's document. `$comment` is not inert at
 * all: `packages/runner/src/schema-view.ts` reserves `"emptyProperties"`,
 * `"missingProperty"` and `"rejectedProperty"` as control markers and
 * `packages/runner/src/traverse.ts` acts on the first two, so a carried
 * `$comment` is caller-forgeable control flow at the read boundary. Dropping
 * needs to know nothing about which values are reserved, and a marker the
 * runner reserves later cannot re-open the hole behind it.
 */
const DROPPED_TOLERATED_KEYS: ReadonlySet<string> = new Set([
  "$comment",
  "$id",
  "$schema",
]);

/** The tolerated keywords that do reach the schema the reader constructs. */
const CARRIED_TOLERATED_KEYS: readonly string[] = [
  ...TOLERATED_PROJECTION_KEYS,
].filter((key) => !DROPPED_TOLERATED_KEYS.has(key));

/**
 * What the projection reader does with `key`.
 *
 * @internal Exported for the classification and coupling tests.
 */
export function projectionKeyTier(key: string): ProjectionKeyTier {
  if (HONORED_PROJECTION_KEYS.has(key)) return "honored";
  if (CONSULTED_PROJECTION_KEYS.has(key)) return "consulted";
  if (
    FORBIDDEN_PROJECTION_KEYS.has(key) || UNSUPPORTED_PROJECTION_KEYS.has(key)
  ) {
    return "refused";
  }
  return TOLERATED_PROJECTION_KEYS.has(key) ? "tolerated" : "refused";
}

/** The honored vocabulary, as a refusal names it. */
const HONORED_PROJECTION_VOCABULARY = [...HONORED_PROJECTION_KEYS]
  .map((key) => `"${key}"`)
  .join(", ");

/**
 * The keyword `key` was most likely meant to be, or `undefined` where nothing
 * is close enough to name. No read-side surface prints the source schema, so
 * for a misspelled key the accepted vocabulary is the entire remediation, and
 * the one keyword a caller transposed two letters of is the useful half of it.
 */
function nearestProjectionKey(key: string): string | undefined {
  return nearestName(key, HONORED_PROJECTION_KEYS);
}

/**
 * The container a projection position describes but did not state. Schema
 * traversal descends `properties` only under `type: "object"` and `items` only
 * under `type: "array"`, so an omitted `type` silently empties the position —
 * and a nested position is where a caller omits it. Filling it in here keeps
 * that requirement out of what a caller has to know, and keeps traversal's
 * meaning of a stated type intact for every other reader.
 *
 * Arrays are tested first, matching {@link projectionMask}, so a position that
 * names both vocabularies reads as the array it named rather than disagreeing
 * with the selector built from it.
 */
function impliedProjectionType(
  declared: Record<string, unknown>,
): "object" | "array" | undefined {
  if (declared.type !== undefined) return undefined;
  if (ARRAY_PROJECTION_KEYS.some((key) => declared[key] !== undefined)) {
    return "array";
  }
  return OBJECT_PROJECTION_KEYS.some((key) => declared[key] !== undefined)
    ? "object"
    : undefined;
}

/** A projection schema with its `$link` markers lifted out of it. */
interface NormalizedProjectionSchema {
  schema: JSONSchema;
  markers?: LinkMarkers;
}

function normalizeProjectionSchema(
  schema: unknown,
  path = "<root>",
): NormalizedProjectionSchema {
  if (schema === true) return { schema: true };
  if (schema === false) {
    throw new CellSelectionError(
      `Invalid --schema at ${path}: false cannot project a value`,
    );
  }
  if (!isObjectNotArray(schema)) {
    throw new CellSelectionError(
      `Invalid --schema at ${path}: expected a JSON Schema object`,
    );
  }
  for (const key of Object.keys(schema)) {
    if (key === LINK_MARKER_KEY) continue;
    if (FORBIDDEN_PROJECTION_KEYS.has(key)) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "${key}" is controlled by the source ` +
          "schema and cannot be supplied by a projection",
      );
    }
    if (UNSUPPORTED_PROJECTION_KEYS.has(key)) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "${key}" is not supported by projection schemas`,
      );
    }
    if (projectionKeyTier(key) === "refused") {
      // No read-side surface prints the schema a read runs against, so a
      // refusal cannot send a caller off to lift one and prune it. What it
      // says is what the reader knows without any source at all: the key, the
      // position, and the vocabulary that position accepts.
      const nearest = nearestProjectionKey(key);
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "${key}" is not a projection schema ` +
          "keyword. " +
          (nearest === undefined ? "" : `Did you mean "${nearest}"? `) +
          `Projection reads ${HONORED_PROJECTION_VOCABULARY}`,
      );
    }
  }
  const marker = schema[LINK_MARKER_KEY];
  if (marker !== undefined && marker !== true) {
    throw new CellSelectionError(
      `Invalid --schema at ${path}: "${LINK_MARKER_KEY}" must be \`true\``,
    );
  }

  const { [LINK_MARKER_KEY]: _marker, ...declared } = schema;
  const markers: LinkMarkers = marker === true ? { marked: true } : {};
  const implied = impliedProjectionType(declared);
  // The reader constructs what it hands on rather than forwarding what a
  // caller typed. An honored key is written out below; a consulted key was
  // read by `impliedProjectionType()` just above and goes no further, so no
  // constraint of the caller's reaches a schema the runner acts on; a
  // tolerated key is carried only where carrying it is inert past the read
  // boundary; a refused key never reaches here, the projection naming it
  // having been rejected.
  //
  // An implied `type` leads the result, so a normalized schema reads the way a
  // caller would have written it out in full. A position that declared nothing
  // gains nothing: `{}` stays the wildcard it already is, and a bare marker
  // still reduces to `false` below.
  const result: Record<string, unknown> = {};
  if (implied !== undefined) result.type = implied;
  else if (declared.type !== undefined) result.type = declared.type;
  for (const key of CARRIED_TOLERATED_KEYS) {
    if (declared[key] !== undefined) result[key] = declared[key];
  }
  if (typeof declared.additionalProperties === "boolean") {
    result.additionalProperties = declared.additionalProperties;
  }
  if (declared.properties !== undefined) {
    if (!isObjectNotArray(declared.properties)) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}: "properties" must be an object`,
      );
    }
    const properties: Record<string, JSONSchema> = {};
    const childMarkers: Record<string, LinkMarkers> = {};
    for (const [key, child] of Object.entries(declared.properties)) {
      const normalized = normalizeProjectionSchema(child, `${path}.${key}`);
      properties[key] = normalized.schema;
      if (normalized.markers !== undefined) {
        childMarkers[key] = normalized.markers;
      }
    }
    result.properties = properties;
    if (Object.keys(childMarkers).length > 0) markers.properties = childMarkers;
    if (declared.additionalProperties === undefined) {
      result.additionalProperties = false;
    }
  } else if (
    schemaTypes(result as JSONSchema).includes("object") &&
    declared.additionalProperties === undefined
  ) {
    result.additionalProperties = true;
  }
  if (
    declared.additionalProperties !== undefined &&
    typeof declared.additionalProperties !== "boolean"
  ) {
    const normalized = normalizeProjectionSchema(
      declared.additionalProperties,
      `${path}.*`,
    );
    // A marker names one position, and `additionalProperties` names a set
    // whose membership the stored value decides. Refuse rather than drop the
    // marker: dropping it answers with contents where an address was asked
    // for, which reads as a successful answer to a different question.
    if (normalized.markers !== undefined) {
      throw new CellSelectionError(
        `Invalid --schema at ${path}.*: "${LINK_MARKER_KEY}" is not ` +
          'supported under "additionalProperties"',
      );
    }
    result.additionalProperties = normalized.schema;
  }
  if (declared.items !== undefined) {
    const normalized = normalizeProjectionSchema(declared.items, `${path}[]`);
    result.items = normalized.schema;
    if (normalized.markers !== undefined) markers.items = normalized.markers;
  }
  // A position whose whole selection was its address reads nothing, and says
  // so with the rejecting schema. Everything downstream — the read selector,
  // the projector, the declared output shape — already means "nothing here"
  // by `false`, and the address is composed back in from the stored link.
  const reduced = marker === true && Object.keys(result).length === 0;
  return {
    schema: reduced ? false : result as JSONSchema,
    ...(Object.keys(markers).length > 0 ? { markers } : {}),
  };
}

/** A field name one concise path segment names, and what it asks for there. */
interface ConciseSegment {
  name: string;

  /** The segment ended in an unescaped {@link CONCISE_ADDRESS_SUFFIX}. */
  marked: boolean;
}

/**
 * The positions a concise field list names, as a tree. `whole` and `marked`
 * are separate questions about one position: `topic` asks for what is stored
 * there, `topic@` asks for its address, and a list naming both asks for both.
 */
interface ConciseSelection {
  whole: boolean;
  marked: boolean;
  properties: Map<string, ConciseSelection>;
}

/**
 * Helper for {@link conciseProjectionSchema}, which reads one dot-separated
 * segment of `path`. A trailing {@link CONCISE_ADDRESS_SUFFIX} asks for the
 * named position's address unless a backslash escapes it, and the character is
 * part of the name anywhere else: `user@home` names a field, and `a\@` names
 * the field `a@`.
 */
function parseConciseSegment(
  segment: string,
  path: string,
  flag: ProjectionFlag,
): ConciseSegment {
  const escaped = `\\${CONCISE_ADDRESS_SUFFIX}`;
  const marked = segment.endsWith(CONCISE_ADDRESS_SUFFIX) &&
    !segment.endsWith(escaped);
  const name = (marked ? segment.slice(0, -1) : segment)
    .replaceAll(escaped, CONCISE_ADDRESS_SUFFIX);
  if (!/^[A-Za-z_$][A-Za-z0-9_$@-]*$/.test(name)) {
    throw new CellSelectionError(
      `Invalid ${flag} field path ${JSON.stringify(path)}`,
    );
  }
  return { name, marked };
}

/**
 * Helper for {@link conciseProjectionSchema}, which constructs a position that
 * has named nothing yet.
 */
function emptyConciseSelection(): ConciseSelection {
  return { whole: false, marked: false, properties: new Map() };
}

/**
 * Helper for {@link conciseProjectionSchema}, which says whether `node` or
 * anything below it asked for an address.
 */
function conciseSelectionMarks(node: ConciseSelection): boolean {
  return node.marked ||
    [...node.properties.values()].some(conciseSelectionMarks);
}

/**
 * Helper for {@link conciseProjectionSchema}, which writes `node` out as the
 * projection schema it describes, `$link` markers included. Normalization
 * reads those markers back out, so a concise address suffix reaches the read
 * selector and the address composition the same way a written one does.
 */
function conciseSelectionSchema(node: ConciseSelection): unknown {
  const properties: Record<string, unknown> = {};
  for (const [name, child] of node.properties) {
    // A position asked for whole already answers every path through it, so a
    // deeper path adds something only where it asked for an address.
    if (node.whole && !conciseSelectionMarks(child)) continue;
    properties[name] = conciseSelectionSchema(child);
  }
  const named = Object.keys(properties).length > 0;
  const marker = node.marked ? { [LINK_MARKER_KEY]: true } : {};
  if (!node.whole) {
    // A position whose whole request was its address says exactly that, and
    // normalization reduces it to the rejecting schema.
    return named
      ? { ...marker, type: "object", properties, additionalProperties: false }
      : marker;
  }
  if (!named && !node.marked) return true;
  // `additionalProperties` keeps what a projection did not name, which is what
  // a bare path asks for at the position it ends on. `properties` is written
  // out beside it only to carry the markers below.
  return {
    ...marker,
    type: "object",
    ...(named ? { properties } : {}),
    additionalProperties: true,
  };
}

/**
 * Reads a comma-separated field list into the projection it describes. The
 * list names positions rather than shapes, so it is collected as a tree first:
 * the same position can be reached by several paths, and `topic@` beside
 * `topic.title` is one position asked two questions rather than two answers.
 *
 * A path that is nothing but {@link CONCISE_ADDRESS_SUFFIX} names the position
 * the read is already at, which no field path reaches because it is above
 * every field.
 */
function conciseProjectionSchema(
  source: string,
  flag: ProjectionFlag,
): NormalizedProjectionSchema {
  const paths = source.split(",").map((part) => part.trim());
  if (paths.some((path) => path.length === 0)) {
    throw new CellSelectionError(
      `Invalid ${flag} concise projection: expected comma-separated field paths`,
    );
  }
  const root = emptyConciseSelection();
  for (const path of paths) {
    if (path === CONCISE_ADDRESS_SUFFIX) {
      root.marked = true;
      continue;
    }
    const segments = path.split(".").map((segment) =>
      parseConciseSegment(segment, path, flag)
    );
    let node = root;
    for (const [index, segment] of segments.entries()) {
      let child = node.properties.get(segment.name);
      if (child === undefined) {
        child = emptyConciseSelection();
        node.properties.set(segment.name, child);
      }
      if (segment.marked) child.marked = true;
      if (index === segments.length - 1 && !segment.marked) child.whole = true;
      node = child;
    }
  }
  return normalizeProjectionSchema(conciseSelectionSchema(root));
}

export interface ProjectionParseDependencies {
  readTextFile?: (path: string) => Promise<string>;
}

/**
 * Parses a `--select` argument: the comma-separated field paths, which is the
 * whole of what this flag accepts. A path segment ending in
 * {@link CONCISE_ADDRESS_SUFFIX} asks for the address of the position it
 * names, and a path that is only the suffix asks the read's own source for
 * its address. `--schema` reads the same spelling and more, so an argument
 * written in the JSON Schema language is pointed at the flag that reads it
 * rather than reported as a malformed field path.
 *
 * `@file` names a schema file, which only `--schema` accepts, and a field name
 * cannot begin with `@`. A leading one is therefore an argument for the other
 * flag wherever it is not the bare suffix.
 */
export function parseSelectProjection(source: string): SelectionProjection {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new CellSelectionError("--select must not be empty");
  }
  const leading = trimmed.split(",", 1)[0].trim();
  if (
    trimmed.startsWith("{") || trimmed === "true" || trimmed === "false" ||
    (leading.startsWith(CONCISE_ADDRESS_SUFFIX) &&
      leading !== CONCISE_ADDRESS_SUFFIX)
  ) {
    throw new CellSelectionError(
      "--select takes comma-separated field paths. Pass a JSON Schema or an " +
        "@file to --schema instead.",
    );
  }
  return {
    source,
    ...conciseProjectionSchema(trimmed, "--select"),
    kind: "concise",
    flag: "--select",
  };
}

/**
 * Parses a `--schema` argument, which is written as a JSON Schema, as `@file`
 * naming one, or as the same comma-separated field paths `--select` takes.
 */
export async function parseSelectionProjection(
  source: string,
  deps: ProjectionParseDependencies = {},
): Promise<SelectionProjection> {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new CellSelectionError("--schema must not be empty");
  }

  if (trimmed.startsWith("@")) {
    const path = trimmed.slice(1);
    if (path.length === 0) {
      throw new CellSelectionError(
        "--schema @file requires a file path",
      );
    }
    let contents: string;
    try {
      contents = await (deps.readTextFile ?? Deno.readTextFile)(path);
    } catch (error) {
      throw new CellSelectionError(
        `Could not read --schema file "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new CellSelectionError(
        `Invalid JSON in --schema file "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return {
      source,
      ...normalizeProjectionSchema(parsed),
      kind: "json",
      flag: "--schema",
    };
  }

  if (trimmed.startsWith("{") || trimmed === "true" || trimmed === "false") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new CellSelectionError(
        `Invalid JSON passed to --schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return {
      source,
      ...normalizeProjectionSchema(parsed),
      kind: "json",
      flag: "--schema",
    };
  }

  return {
    source,
    ...conciseProjectionSchema(trimmed, "--schema"),
    kind: "concise",
    flag: "--schema",
  };
}

/**
 * Parses a command's `--filter` and projection arguments into the selection
 * they describe, or `undefined` when neither was given and the caller wants
 * the whole value. `select` and `schema` are two spellings of one projection,
 * and the commands that offer them declare the two flags conflicting, so at
 * most one arrives here; `select` is the one read when both do.
 */
export async function parseCellSelectionOptions(options: {
  filter?: string;
  schema?: string;
  select?: string;
}): Promise<CellSelection | undefined> {
  const filter = options.filter === undefined
    ? undefined
    : parseSelectionFilter(options.filter);
  const projection = options.select !== undefined
    ? parseSelectProjection(options.select)
    : options.schema === undefined
    ? undefined
    : await parseSelectionProjection(options.schema);
  return filter === undefined && projection === undefined
    ? undefined
    : { filter, projection };
}

/**
 * Whether a schema position is marked a stream, which is a dispatch surface
 * rather than a value: nothing is stored at it to read or to address.
 */
function carriesStreamMarker(schema: { readonly asCell?: unknown }): boolean {
  return Array.isArray(schema.asCell) && schema.asCell.includes("stream");
}

/**
 * The `source` a derived projection records, in place of the text a caller
 * would have typed. It reaches the derived read's cause, so it is a fixed
 * string rather than a rendering of the schema: two calls that derive the same
 * bound from the same receipt should land on the same cell.
 */
const DERIVED_PROJECTION_SOURCE = "<the verb's declared result>";

/**
 * How much of a declaration a derived bound applies.
 *
 * `"recursion"` bounds the recursion and narrows nothing else: only the
 * position where the declared type re-enters itself is cut, and every other
 * position reads exactly what an unbounded readback reads there. That is the
 * bound a result which merely closes a circle needs, and applying more of the
 * declaration than that would narrow a value the caller can already read.
 *
 * `"shape"` holds every object position the declaration CLOSES to the fields
 * it gives that position as well — none of them, for a declaration that says
 * the value has no keys. One the declaration leaves open — an index signature
 * beside its named members, or an empty interface, which names no fields and
 * accepts whatever is stored — keeps reading every key stored at it, because
 * those keys are declared too. A value can reach far past what its
 * declaration describes — a verb declaring a compact row over a piece hands
 * back that piece, and the piece carries its view, and the view reaches every
 * piece it renders — and a circle out there is at no position the declaration
 * names, so cutting the declaration's own recursion does not reach it. Reading
 * the declaration as the shape it states does: what the author declared is
 * what comes back.
 */
export type DeclaredBound = "recursion" | "shape";

/**
 * One position of a derivation, and whether the walk cut anything at or below
 * it. An absent `schema` drops the position: nothing is read there and no
 * address stands in for it.
 */
interface DerivedPosition {
  schema?: unknown;

  /** The derivation reads less at this position than an unbounded readback
   * does: a `$link` marker stands in for a subtree at or below it, or an
   * object at or below it is held to the fields the declaration gives it. */
  cut: boolean;
}

/** The position reads whatever is stored, which is what an unbounded read
 * already does — so a derivation that only ever answers this bounds nothing. */
const DERIVED_WHOLE: DerivedPosition = { schema: true, cut: false };

/** The position renders its address instead of being followed. */
const DERIVED_ADDRESS: DerivedPosition = {
  schema: { [LINK_MARKER_KEY]: true },
  cut: true,
};

/** The position contributes nothing: a stream is a dispatch surface, and there
 * is no value at it to read or address. */
const DERIVED_DROPPED: DerivedPosition = { cut: false };

/**
 * Helper for {@link declaredResultProjection}: one position of the declared
 * result, written as the projection position it derives.
 *
 * `following` holds the references the walk is already inside, each paired
 * with the document root it was followed under: the same spelling in two
 * documents names two definitions, so only a reference repeated in ITS OWN
 * document is the cut — the declared type re-enters itself there, and
 * following it once more is what closes the circle. Under `"recursion"` every
 * other
 * position is left as wide as it was declared; under `"shape"` an object
 * position is additionally held to the fields it declares.
 *
 * Reference resolution is the canonical resolver's, one hop per recursion —
 * never a private pointer parser, which diverges from it on escaped names.
 * An embedded or external target is a document of its own, and its root
 * is threaded below it. A reference the resolver does not resolve leaves the
 * position unbounded, and a readback that still closes a circle then refuses
 * with the legible message rather than corrupting.
 */
function derivePosition(
  schema: JSONSchema | undefined,
  root: JSONSchema,
  following: ReadonlyArray<{ root: JSONSchema; ref: string }>,
  bound: DeclaredBound,
): DerivedPosition {
  if (schema === undefined || typeof schema === "boolean") return DERIVED_WHOLE;
  // A stream carries no value: it renders as the empty object and reading it
  // says nothing. `asCell` otherwise says how a position is held rather than
  // what shape it has, and the shape beside it is what decides the cut.
  if (carriesStreamMarker(schema)) return DERIVED_DROPPED;

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (following.some((f) => f.ref === ref && f.root === root)) {
      return DERIVED_ADDRESS;
    }
    const target = resolveCfcSchemaRef(root, ref);
    if (target === undefined) return DERIVED_WHOLE;
    return derivePosition(
      target,
      cfcSchemaResolvedRoot(
        target,
        isEmbeddedCfcSchemaRef(ref) ? target : root,
      ),
      [...following, { root, ref }],
      bound,
    );
  }

  // `allOf` is a conjunction: every member describes the same value at once,
  // so a member that re-enters says nothing about whether the members beside it
  // can be read, and cutting on its account would drop what they contribute. A
  // projection states one shape per position, so the cut and the rest cannot be
  // stated together either. The position is left as wide as it was declared,
  // and a readback that still closes a circle after that refuses and names the
  // position — which beats answering a different question quietly.
  if (schema.allOf !== undefined) return DERIVED_WHOLE;

  const branches = [...schema.anyOf ?? [], ...schema.oneOf ?? []];
  if (branches.length > 0) {
    // A projection states one shape per position, and a union does not. Where
    // any branch re-enters, the position renders its address: that answers
    // every branch, since an address names the position rather than describing
    // what sits at it. `parent: Item | null` is the case — a root's null still
    // has a position, and it is the position the caller would follow.
    //
    // Re-entry alone decides that, under either bound: the branches are read
    // as `"recursion"` reads them whatever this walk is applying, because a
    // union of shapes the declaration merely states is not a position an
    // address answers — it is a position no single shape describes, which is
    // the same reason `allOf` above is left wide.
    return branches.some((branch) =>
        derivePosition(branch, root, following, "recursion").cut
      )
      ? DERIVED_ADDRESS
      : DERIVED_WHOLE;
  }

  if (schema.type === "array" || schema.items !== undefined) {
    const items = derivePosition(schema.items, root, following, bound);
    if (!items.cut) return DERIVED_WHOLE;
    // The elements are what the bound reaches, so each is written in its own
    // right rather than the array position standing in for all of them — a
    // caller wants the children, not the slot holding them.
    return items.schema === undefined
      ? DERIVED_DROPPED
      : { schema: { type: "array", items: items.schema }, cut: true };
  }

  if (schema.type === "object" || schema.properties !== undefined) {
    const declared = isObjectNotArray(schema.properties)
      ? schema.properties
      : {};
    // A declaration naming fields can still say the value holds keys beside
    // them: an interface carrying an index signature over its own members
    // lowers to `properties` AND `additionalProperties`. Written out,
    // `properties` alone would close the position to what it lists —
    // `normalizeProjectionSchema` supplies the `additionalProperties: false` a
    // projection states none of — and the keys the declaration allows would
    // come back missing, which is a narrower answer than the author declared.
    // The open answer is written instead, so those keys read what an unbounded
    // readback reads at them. A declaration that states `false` closed the
    // position itself and is written closed.
    const open = schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false;
    // Naming no fields and saying the value has none are different
    // statements, and only the first leaves the position unbounded. An empty
    // interface names no fields and accepts whatever is stored — as does an
    // index signature with nothing beside it — so there is nothing to hold
    // the position to and it reads what an unbounded readback reads.
    // `Record<string, never>` lowers to that same empty `properties` beside
    // `additionalProperties: false`, which says the value has no keys at all;
    // `"shape"` holds the position to it below, and the answer is `{}`.
    if (
      Object.keys(declared).length === 0 &&
      schema.additionalProperties !== false
    ) {
      return DERIVED_WHOLE;
    }
    const properties: Record<string, unknown> = {};
    // An object the declaration CLOSES is the bound under `"shape"`: a written
    // `properties` holds the position to what it lists, so writing it out is
    // itself the narrowing, with no marker anywhere below needed to make it
    // one. An open one narrows nothing on its own — every key stored at it
    // still reads — so only a cut below makes it a bound.
    let cut = bound === "shape" && !open;
    for (const [key, child] of Object.entries(declared)) {
      const derived = derivePosition(
        child as JSONSchema,
        root,
        following,
        bound,
      );
      cut ||= derived.cut;
      if (derived.schema !== undefined) properties[key] = derived.schema;
    }
    // Under `"recursion"`, only where something below re-enters. An object
    // that holds no recursion is left whole, so the positions that bound does
    // not need to reach read exactly as an unbounded readback reads them.
    return cut
      ? {
        schema: open
          ? { type: "object", properties, additionalProperties: true }
          : { type: "object", properties },
        cut,
      }
      : DERIVED_WHOLE;
  }

  return DERIVED_WHOLE;
}

/**
 * The projection a verb's declared result bounds its own readback with, or
 * `undefined` where the declaration bounds nothing.
 *
 * A declared result that re-enters itself — the `parent`/`children` shape
 * `docs/common/concepts/self-reference.md` documents — describes a value that
 * closes a circle, and a circle has no JSON rendering. The bound is written in
 * the author's own terms: every position the declaration names is read as
 * declared, and the position where the declaration re-enters renders its
 * address instead of being followed. That is a cut at the boundary the author
 * drew, and it is the same `$link` vocabulary a caller writes by hand.
 *
 * Under `"recursion"`, `undefined` where nothing re-enters: a declaration that
 * describes a finite value is not a bound, and answering with one would narrow
 * a result that renders perfectly well. The caller's own `--select`/`--schema`
 * is the wider instrument and stays the only thing that narrows a result on
 * request.
 *
 * Under `"shape"` the finite declaration IS the bound, because the value under
 * it is not: a verb hands back a piece and declares a compact row over it, and
 * the piece reaches its view and every piece that view renders. That circle is
 * at no position the declaration names, so there is no re-entry to cut and
 * nothing narrower in reach than the shape the author wrote. `undefined` still
 * where that shape reads no less than the value does — a declaration of bare
 * types, or one whose every object position declares itself open or names no
 * fields without closing itself.
 *
 * The derived projection is written in the `--schema` language and reports
 * itself as that flag, which is the flag that replaces it.
 */
export function declaredResultProjection(
  declared: JSONSchema | undefined,
  bound: DeclaredBound = "recursion",
): SelectionProjection | undefined {
  if (declared === undefined || typeof declared === "boolean") return undefined;
  const derived = derivePosition(declared, declared, [], bound);
  if (!derived.cut || derived.schema === undefined) return undefined;
  return {
    source: DERIVED_PROJECTION_SOURCE,
    ...normalizeProjectionSchema(derived.schema),
    kind: "json",
    flag: "--schema",
  };
}

function schemaTypes(schema: JSONSchema | undefined): string[] {
  if (!isObjectOrArray(schema)) return [];
  return Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === "string")
    : typeof schema.type === "string"
    ? [schema.type]
    : [];
}

function schemaIsArray(schema: JSONSchema | undefined): boolean {
  return schemaTypes(schema).includes("array");
}

type SchemaRootKind = "array" | "non-array" | "unknown";

interface SchemaRootWalkBehavior<T> {
  unknown: T;
  fromTypes: (types: string[]) => T;
  fromAlternatives: (values: T[]) => T;
  fromAllOf: (values: T[]) => T;
  unresolvedRef: (error: unknown) => T;
}

function walkSchemaRoot<T>(
  schema: JSONSchema | undefined,
  behavior: SchemaRootWalkBehavior<T>,
  root: JSONSchema = schema ?? true,
  ancestors = new Set<object>(),
): T {
  if (!isObjectOrArray(schema) || ancestors.has(schema)) {
    return behavior.unknown;
  }
  ancestors.add(schema);
  try {
    // A reference is the source shape for this heuristic. Resolve it before
    // inspecting sibling keywords so a broken reference cannot lend false
    // shape authority through, for example, a sibling `type`. The root
    // moves only where the reference chain enters another document.
    if (schema.$ref !== undefined) {
      try {
        const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(
          schema,
          root,
        );
        return walkSchemaRoot(
          resolved,
          behavior,
          cfcSchemaResolvedRoot(
            resolved,
            resolveCfcSchemaRefRoot(schema, root),
          ),
          ancestors,
        );
      } catch (error) {
        return behavior.unresolvedRef(error);
      }
    }

    const types = schemaTypes(schema);
    // An explicit `type` is the authoritative root-shape signal here.
    // Combinators are conjunctive with it, so contradictory branch types
    // cannot expand the root shapes it declares.
    if (types.length > 0) return behavior.fromTypes(types);

    const alternatives = [...schema.anyOf ?? [], ...schema.oneOf ?? []];
    if (alternatives.length > 0) {
      return behavior.fromAlternatives(
        alternatives.map((option) =>
          walkSchemaRoot(option, behavior, root, ancestors)
        ),
      );
    }

    if (schema.allOf !== undefined) {
      return behavior.fromAllOf(
        schema.allOf.map((option) =>
          walkSchemaRoot(option, behavior, root, ancestors)
        ),
      );
    }
    return behavior.unknown;
  } finally {
    ancestors.delete(schema);
  }
}

/**
 * Classify a root container only when the declared schema makes its shape
 * unambiguous. This is intentionally conservative: an unknown shape falls
 * back to inspecting the value so schema-less and union-shaped cells retain
 * their existing projection semantics.
 *
 * @internal Exported for focused root-shape tests.
 */
export function schemaRootKind(
  schema: JSONSchema | undefined,
  root: JSONSchema = schema ?? true,
  ancestors = new Set<object>(),
): SchemaRootKind {
  return walkSchemaRoot(
    schema,
    {
      unknown: "unknown",
      fromTypes: (types) => {
        const hasArray = types.includes("array");
        if (!hasArray) return "non-array";
        return types.every((type) => type === "array") ? "array" : "unknown";
      },
      fromAlternatives: (kinds) => {
        const first = kinds[0];
        return first !== "unknown" && kinds.every((kind) => kind === first)
          ? first
          : "unknown";
      },
      fromAllOf: (values) => {
        const kinds = new Set(
          values.filter((kind) => kind !== "unknown"),
        );
        return kinds.size === 1 ? [...kinds][0] : "unknown";
      },
      // Root classification is an optimization only. A broken reference must
      // not prevent the existing value-shaped fallback from reporting the
      // source schema problem through the normal projection path.
      unresolvedRef: () => "unknown",
    },
    root,
    ancestors,
  );
}

function schemaAtArrayItem(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (schema === undefined) return undefined;
  const item = ContextualFlowControl.schemaAtPath(schema, ["0"]);
  return item === false ? undefined : item;
}

function dereferencedElementSchema(
  schema: JSONSchema | undefined,
): JSONSchema {
  if (!isObjectOrArray(schema) || schema.asCell === undefined) {
    return schema ?? true;
  }
  const { asCell: _asCell, ...dereferenced } = schema;
  return Object.keys(dereferenced).length === 0 ? true : dereferenced;
}

function filteredOutputSchema(
  sourceSchema: JSONSchema | undefined,
  outputItemSchema: JSONSchema | undefined,
): JSONSchema {
  if (!isObjectOrArray(sourceSchema)) {
    return { type: "array", items: true };
  }
  const { items: _items, prefixItems: _prefixItems, ...metadata } =
    sourceSchema;
  return {
    ...metadata,
    type: "array",
    items: dereferencedElementSchema(outputItemSchema),
  };
}

interface ObjectMask<Child> {
  type: "object";
  properties: Record<string, Child>;
  additionalProperties: false;
}
interface ArrayProjectionMask {
  type: "array";
  items: ProjectionMask;
}
interface ObjectProjectionMask extends ObjectMask<ProjectionMask> {}

/**
 * Which positions a selection reads. `false` is the rejecting one: the
 * position contributes nothing to the read, and the runner never loads what
 * is behind it.
 *
 * **A rejecting position is always a marked one.**
 * {@link normalizeProjectionSchema} refuses a bare `false` in a projection
 * schema, so `false` enters a mask only where a `$link` marker took the whole
 * selection at that position, and only ever spreads upward from there. A mask
 * that rejects therefore always has markers to answer with, and a selection
 * whose root mask is `false` selects no value anywhere.
 *
 * Two things rest on that. {@link deriveSelectedValue}'s whole-selection
 * short-circuit answers from the stored links alone, which is a wrong answer
 * rather than an empty one if a rejection ever arrives without a marker. And
 * the item masks it dereferences beside a `--filter` are reachable only
 * because a marker and a filter are refused together. Admitting `false` by
 * any other route breaks both, silently.
 */
type ProjectionMask =
  | true
  | false
  | ArrayProjectionMask
  | ObjectProjectionMask;

interface ObjectPredicateMask extends ObjectMask<PredicateMask> {}
type PredicateMask = true | ObjectPredicateMask;

/**
 * The mask for an array whose elements `items` selects.
 *
 * An array whose elements are not read is not read. The rejecting selector has
 * to sit at the array itself to suppress the fetch: array traversal follows
 * each element's link before it consults the item schema, so a rejection one
 * level down arrives after the load it was meant to prevent.
 */
function arrayProjectionMask(items: ProjectionMask): ProjectionMask {
  return items === false ? false : { type: "array", items };
}

/**
 * The mask for an object whose named positions `properties` selects.
 *
 * An object whose every named position rejects is not read, by the same rule
 * {@link arrayProjectionMask} applies one level up: a rejection reaches the
 * fetch it suppresses only from the position that holds the link. Reducing
 * here is what carries a rejection below a link up to the array holding it, so
 * a marker below a link costs the same one read as a marker on it.
 *
 * Callers filter out the object that admits keys it does not name, which
 * cannot be narrowed and so is never all-rejecting. An object naming no
 * positions rejects nothing and stays a selector for the empty object it
 * describes.
 */
function objectProjectionMask(
  properties: Record<string, ProjectionMask>,
): ProjectionMask {
  const children = Object.values(properties);
  return children.length > 0 && children.every((child) => child === false)
    ? false
    : { type: "object", properties, additionalProperties: false };
}

function projectionMask(schema: JSONSchema): ProjectionMask {
  if (schema === true) return true;
  if (schema === false) return false;
  const objectSchema = schema as Exclude<JSONSchema, boolean>;
  if (objectSchema.type === "array" || objectSchema.items !== undefined) {
    return arrayProjectionMask(
      objectSchema.items === undefined
        ? true
        : projectionMask(objectSchema.items),
    );
  }
  // An object that admits keys it does not name cannot be narrowed: the
  // selector has to read whatever is there. The array branch above takes a
  // position that names both vocabularies, the same way
  // `impliedProjectionType()` types one: `additionalProperties` describes no
  // part of an array, and deciding an array position by it reads the whole
  // source over a keyword that says nothing about that position.
  if (
    objectSchema.additionalProperties === true ||
    isObjectOrArray(objectSchema.additionalProperties)
  ) {
    return true;
  }
  if (
    objectSchema.type === "object" || objectSchema.properties !== undefined
  ) {
    return objectProjectionMask(
      Object.fromEntries(
        Object.entries(objectSchema.properties ?? {}).map(([key, child]) => [
          key,
          projectionMask(child),
        ]),
      ),
    );
  }
  return true;
}

function schemaFromProjectionMask(mask: ProjectionMask): JSONSchema {
  if (typeof mask === "boolean") return mask;
  if (mask.type === "array") {
    return {
      type: "array",
      items: schemaFromProjectionMask(mask.items),
    };
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(mask.properties).map(([key, child]) => [
        key,
        schemaFromProjectionMask(child),
      ]),
    ),
    additionalProperties: false,
  };
}

/** @internal Exported for focused schema-shape tests. */
export function schemaMayBeArray(
  schema: JSONSchema | undefined,
  flag: ProjectionFlag = "--schema",
  root: JSONSchema = schema ?? true,
  ancestors = new Set<object>(),
): boolean {
  return walkSchemaRoot(
    schema,
    {
      unknown: false,
      fromTypes: (types) => types.includes("array"),
      fromAlternatives: (values) => values.some(Boolean),
      fromAllOf: (values) => values.some(Boolean),
      // Unlike root classification, concise-path alignment cannot safely
      // continue without resolving the schema that determines array traversal.
      unresolvedRef: (error) => {
        throw new CellSelectionError(
          `Could not resolve source schema reference for ${flag}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      },
    },
    root,
    ancestors,
  );
}

function alignConciseProjectionMask(
  source: JSONSchema | undefined,
  mask: ProjectionMask,
  flag: ProjectionFlag,
): ProjectionMask {
  if (
    typeof mask === "boolean" || source === undefined || source === true
  ) return mask;

  if (schemaMayBeArray(source, flag)) {
    const sourceItem = schemaAtArrayItem(source);
    return arrayProjectionMask(
      alignConciseProjectionMask(sourceItem, mask, flag),
    );
  }

  const objectMask = mask as ObjectProjectionMask;
  return objectProjectionMask(
    Object.fromEntries(
      Object.entries(objectMask.properties).map(([key, childMask]) => {
        const child = ContextualFlowControl.schemaAtPath(source, [key]);
        return [
          key,
          alignConciseProjectionMask(
            child === false ? undefined : child,
            childMask,
            flag,
          ),
        ];
      }),
    ),
  );
}

/**
 * Aligns the markers a concise field list wrote against the shape the source
 * declares, the way {@link alignConciseProjectionMask} aligns the mask beside
 * them. A field list names a field wherever the value holds one rather than at
 * a fixed depth, so a name that crosses an array marks each of its elements:
 * the aligned markers say that with `items`, which is what a JSON Schema
 * states for itself. Where the source declares nothing the markers stay as
 * written, and the value the walk holds decides.
 */
function alignConciseMarkers(
  source: JSONSchema | undefined,
  markers: LinkMarkers,
  flag: ProjectionFlag,
): LinkMarkers {
  if (source === undefined || source === true) return markers;
  if (schemaMayBeArray(source, flag)) {
    return {
      items: alignConciseMarkers(schemaAtArrayItem(source), markers, flag),
    };
  }
  if (markers.properties === undefined) return markers;
  return {
    ...markers,
    properties: Object.fromEntries(
      Object.entries(markers.properties).map(([key, child]) => {
        const childSchema = ContextualFlowControl.schemaAtPath(source, [key]);
        return [
          key,
          alignConciseMarkers(
            childSchema === false ? undefined : childSchema,
            child,
            flag,
          ),
        ];
      }),
    ),
  };
}

/**
 * A field a concise list names at a position the source cannot hold it at,
 * with what that position holds instead.
 */
interface UnheldSelectionField {
  key: string;

  /**
   * The position the field was named at, spelled the way this boundary spells
   * a projection position everywhere else: `<root>` for the read's own source,
   * `.name` for a property, `[]` for the elements of an array a field list
   * crosses.
   */
  position: string;

  /**
   * What the position does hold: the field names it declares, the types it
   * states where it declares no fields, or the stream it is.
   */
  holds:
    | { fields: string[] }
    | { types: string[] }
    | { stream: true };
}

/**
 * The first field a concise list names that the source schema proves cannot be
 * there — a typo, or a name the source has since stopped declaring.
 *
 * A projection that matches nothing legitimately returns nothing: an optional
 * field is absent, a link that has not synced is unresolvable, and a read has
 * to be able to return both. What this separates out is the
 * case where no value could ever appear at the path, which the schema settles
 * before the read runs and which is never anything but a mistake.
 *
 * The walk is the caller's field list, which is finite, consulting the source
 * schema beside it — so a source that names itself terminates on the list
 * rather than on a cycle guard. Every position where the schema stops proving
 * what sits under it fails open, each one marked below: a refusal costs a
 * retype, while a read wrongly refused cannot be taken at all. That is the
 * direction the call door's gate over a payload's fields fails in too
 * (`firstUndeclaredEventField`, callable.ts).
 */
function firstUnheldSelectionField(
  source: JSONSchema | undefined,
  root: JSONSchema,
  projection: JSONSchema,
  position: string,
): UnheldSelectionField | undefined {
  if (typeof projection === "boolean") return undefined;
  const named = projection.properties;
  if (!isObjectNotArray(named)) return undefined;
  if (!isSchemaObject(source)) return undefined;
  // A stream is a dispatch surface rather than a value, so nothing is stored
  // at it for a field path to reach. The marker is read before the reference
  // beside it is followed, because that is where a verb carries it:
  // `{asCell: ["stream"], $ref: "#/$defs/AddEvent"}` puts the event's fields
  // in the definition and the marker at the site naming it.
  if (carriesStreamMarker(source)) {
    return { key: Object.keys(named)[0], position, holds: { stream: true } };
  }
  // A reference site that declares fields of its own is passed over. The
  // site's keywords and the definition's are two accounts of one position, and
  // a read draws on both — it returns whatever is stored at a name neither
  // account declares — so which of them governs a name is not a question this
  // gate settles.
  if (
    typeof source.$ref === "string" &&
    (isObjectNotArray(source.properties) || source.allOf !== undefined)
  ) {
    return undefined;
  }
  const scopeRoot = root;
  // A reference is followed the way the validator follows it, so a named
  // interface declares what it names.
  const target = resolveCfcSchemaRefs(source, scopeRoot);
  if (!isSchemaObject(target)) return undefined;
  // The marker is read again on what the reference names, since a definition
  // can carry it as readily as the site naming one.
  if (carriesStreamMarker(target)) {
    return { key: Object.keys(named)[0], position, holds: { stream: true } };
  }
  if (target.anyOf !== undefined || target.oneOf !== undefined) {
    return undefined;
  }
  const targetRoot = target !== source
    ? cfcSchemaResolvedRoot(target, scopeRoot)
    : scopeRoot;

  // A field list names a field wherever the value holds one rather than at a
  // fixed depth, so an array position is crossed and the same names are asked
  // of its elements — the traversal `alignConciseProjectionMask` applies to
  // the mask beside this.
  //
  // One rule governs the crossing: an array is crossed only where the source
  // gives its elements ONE schema, since that schema is then the vocabulary of
  // every element and of nothing else. The three ways a source falls short of
  // that are checked below and each is passed over. A position that merely may
  // hold an array — untyped beside an `items`, or a union naming both
  // containers — settles neither depth: the name belongs to an element where
  // the value is an array and to the position itself where it is not, and
  // judging it at one of them refuses a read that works at the other. A tuple
  // gives each index its own schema. And a draft-07 tuple writes that list as
  // `items` itself, which is not a schema at all and stops the walk one level
  // down, where a list of schemas is not a schema object.
  if (sourceProvesContainer("array", target, targetRoot)) {
    // A tuple declares a different shape per index, so its elements have no
    // one vocabulary: `items` describes the positions past the prefix and says
    // nothing about the prefix itself. An empty list declares no position and
    // leaves `items` describing every element.
    const prefix = target.prefixItems;
    if (
      prefix !== undefined && !(Array.isArray(prefix) && prefix.length === 0)
    ) {
      return undefined;
    }
    return firstUnheldSelectionField(
      sourceItemSchema(target),
      targetRoot,
      projection,
      `${position}[]`,
    );
  }
  if (schemaIsArrayShaped(target)) return undefined;

  if (!schemaIsObjectShaped(target, targetRoot)) {
    const types = schemaTypes(target);
    // A stated scalar type is the position saying what it holds, and a string
    // has no fields to name. Every other reading of the position — no type at
    // all, a union admitting an object, a conjunction whose members state the
    // type between them — leaves the shape open, and an open position holds
    // whatever was stored there.
    if (types.length === 0 || types.includes("object")) return undefined;
    return { key: Object.keys(named)[0], position, holds: { types } };
  }

  // A pattern-matched name is declared without being named, so a position
  // carrying one has a vocabulary no list of keys states. An empty map names
  // no pattern and so admits nothing, which leaves the declared names the
  // whole vocabulary.
  const patterns = target.patternProperties;
  if (
    patterns !== undefined &&
    !(isObjectNotArray(patterns) && Object.keys(patterns).length === 0)
  ) {
    return undefined;
  }
  const declared = declaredFieldsAt(target, targetRoot);
  // A position with no property map states no vocabulary, and returns
  // whatever the value holds there.
  if (declared.sources.length === 0) return undefined;
  const declaringSources = (key: string) =>
    declared.sources.filter((source) => Object.hasOwn(source.properties, key));
  if (!declared.honorsUndeclared) {
    for (const key of Object.keys(named)) {
      if (declaringSources(key).length === 0) {
        return {
          key,
          position,
          holds: { fields: declaredFieldNames(declared.sources) },
        };
      }
    }
  }
  for (const [key, child] of Object.entries(named)) {
    const matches = declaringSources(key);
    // A name several conjunction members declare is passed over one level
    // down: the walk cannot say which member's schema governs beneath it.
    if (matches.length > 1) continue;
    const found = firstUnheldSelectionField(
      matches.length === 1
        ? matches[0].properties[key]
        : target.additionalProperties as JSONSchema | undefined,
      matches.length === 1 ? matches[0].root : targetRoot,
      child as JSONSchema,
      `${position}.${key}`,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The names a refusal lists, quoted, in the order the source declares them. */
function quotedNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * The refusal a field the source cannot hold earns.
 *
 * The caller is handed what the reader knew before it read anything: the name
 * they wrote, the position it was named at, what that position holds instead,
 * and the declared name they are one edit from. No read-side surface prints
 * the schema a read runs against, so the vocabulary is the whole remediation.
 */
function unheldSelectionFieldError(
  flag: ProjectionFlag,
  found: UnheldSelectionField,
): CellSelectionError {
  const opening = `Invalid ${flag} at ${found.position}: "${found.key}" is ` +
    "not a field the source holds. ";
  if ("stream" in found.holds) {
    return new CellSelectionError(
      opening +
        `${found.position} is a verb, which dispatches rather than holding ` +
        "a value to select from",
    );
  }
  if ("types" in found.holds) {
    return new CellSelectionError(
      opening +
        `${found.position} holds ${
          quotedNames(found.holds.types)
        }, which has no fields`,
    );
  }
  const nearest = nearestName(found.key, found.holds.fields);
  return new CellSelectionError(
    opening +
      (nearest === undefined ? "" : `Did you mean "${nearest}"? `) +
      (found.holds.fields.length === 0
        ? `${found.position} declares no fields at all`
        : `${found.position} declares ${quotedNames(found.holds.fields)}`),
  );
}

/**
 * `value` held to `schema`, in the projection vocabulary.
 *
 * `implicitArrayTraversal` states that the schema came from a concise field
 * list, which names a field wherever the value holds one rather than at a
 * fixed depth.
 *
 * `keepComposedAddresses` states that the value may ALREADY carry addresses a
 * caller's own projection composed into it — which is the case a derived bound
 * meets, and only that one. An address is the caller's whole answer at the
 * position holding it, not a field of what sits behind it, and a schema
 * describes what sits behind it, so a position closed over declared fields
 * would drop the one thing named there and answer with contents where an
 * address was asked for. There is nothing inside an address to hold to a
 * shape, so it is carried across instead.
 */
function projectValue(
  value: unknown,
  schema: JSONSchema,
  implicitArrayTraversal = false,
  keepComposedAddresses = false,
): unknown {
  if (typeof schema === "boolean") return schema ? value : undefined;
  if (value === null) return value;
  if (Array.isArray(value)) {
    const itemSchema = schema.items ??
      (implicitArrayTraversal ? schema : true);
    return value.map((item) =>
      projectValue(
        item,
        itemSchema,
        implicitArrayTraversal,
        keepComposedAddresses,
      )
    );
  }
  if (!isObjectOrArray(value)) return value;
  if (implicitArrayTraversal && schema.items !== undefined) {
    return projectValue(
      value,
      schema.items,
      implicitArrayTraversal,
      keepComposedAddresses,
    );
  }

  const properties = schema.properties ?? {};
  const projected: Record<string, unknown> = {};
  if (schema.additionalProperties !== false) {
    // Declared keys first, in schema order, so an open projection renders
    // its declared fields the way a closed one does; the keys it retains
    // beyond the declaration follow in the value's own order. Own keys
    // only: `in` walks the prototype chain, and a stored key spelled like
    // an `Object.prototype` member (`toString`, `constructor`) is data here.
    const keys = [
      ...Object.keys(properties).filter((key) => Object.hasOwn(value, key)),
      ...Object.keys(value).filter((key) => !Object.hasOwn(properties, key)),
    ];
    for (const key of keys) {
      const childSchema = Object.hasOwn(properties, key)
        ? properties[key]
        : schema.additionalProperties ?? true;
      projected[key] = projectValue(
        value[key],
        childSchema,
        implicitArrayTraversal,
        keepComposedAddresses,
      );
    }
    return projected;
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    // Own keys only, as above: a declared `toString` the value does not
    // hold must not emit `Object.prototype.toString`.
    if (Object.hasOwn(value, key)) {
      projected[key] = projectValue(
        value[key],
        childSchema,
        implicitArrayTraversal,
        keepComposedAddresses,
      );
    }
  }
  // The address a caller already asked for at this position, carried past the
  // closing. A composed one is a string, which is what tells it apart from a
  // field of the same spelling in stored data.
  const address = value[LINK_MARKER_KEY];
  if (keepComposedAddresses && typeof address === "string") {
    projected[LINK_MARKER_KEY] = address;
  }
  return projected;
}

function maskFromPaths(
  paths: Array<Array<string | number>>,
): PredicateMask {
  if (paths.some((path) => path.length === 0)) return true;
  const build = (
    remaining: Array<Array<string | number>>,
  ): PredicateMask => {
    if (remaining.some((path) => path.length === 0)) return true;
    if (remaining.some(([head]) => typeof head === "number")) return true;
    const strings = new Map<string, Array<Array<string | number>>>();
    for (const path of remaining) {
      const [head, ...tail] = path;
      const key = head as string;
      const entries = strings.get(key) ?? [];
      entries.push(tail);
      strings.set(key, entries);
    }
    return {
      type: "object",
      properties: Object.fromEntries(
        [...strings].map(([key, children]) => [key, build(children)]),
      ),
      additionalProperties: false,
    };
  };
  return paths.length === 0 ? true : build(paths);
}

/** @internal Exported for focused mask-composition tests. */
export function mergeMasks(
  left: PredicateMask,
  right: ProjectionMask,
): ProjectionMask {
  if (left === true || right === true) return true;
  // A union: a position the projection declines still has to be read when the
  // predicate observes it.
  if (right === false) return left;
  if (right.type === "array") {
    return arrayProjectionMask(mergeMasks(left, right.items));
  }
  const properties: Record<string, ProjectionMask> = {};
  for (
    const key of new Set([
      ...Object.keys(left.properties),
      ...Object.keys(right.properties),
    ])
  ) {
    const leftChild = left.properties[key];
    const rightChild = right.properties[key];
    properties[key] = leftChild === undefined
      ? rightChild!
      : rightChild === undefined
      ? leftChild
      : mergeMasks(leftChild, rightChild);
  }
  return objectProjectionMask(properties);
}

/**
 * `source` narrowed to the positions `mask` selects.
 *
 * `root` is the document `source` sits in, which is `source` itself when a
 * caller hands in a whole document. A reference resolves against that root,
 * and the root moves only where resolution enters another document: an
 * embedded or external target, or a resolved view flattened with its ref-site
 * siblings. A `$defs` an arm or a property declares of its own is inert, so
 * the recursion below carries `root` through unchanged rather than treating
 * each subschema as a document of its own.
 *
 * @internal Exported for focused source-schema selection tests.
 */
export function selectSourceSchema(
  source: JSONSchema | undefined,
  mask: ProjectionMask,
  purpose: "source-read" | "projected-output" = "source-read",
  root: JSONSchema = source ?? true,
): JSONSchema {
  // A rejecting mask is the whole answer wherever it appears: nothing is read
  // at this position, whatever the source declares there.
  if (mask === false) return false;
  // An absent/wildcard source schema cannot prove that a structural mask has
  // the same container shape as the current value. Keep that read permissive;
  // the materializing projector still applies the mask and drops siblings.
  if (source === undefined || source === true) return true;
  if (source === false || mask === true || !isObjectOrArray(mask)) {
    return source;
  }
  if (source.$ref !== undefined) {
    try {
      const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(
        source,
        root,
      );
      return selectSourceSchema(
        resolved,
        mask,
        purpose,
        cfcSchemaResolvedRoot(resolved, resolveCfcSchemaRefRoot(source, root)),
      );
    } catch {
      // A malformed or unsupported source reference is not projection's job
      // to reinterpret. Preserve the declared selector and let the runtime
      // report the underlying schema problem.
      return source;
    }
  }
  if (
    source.anyOf !== undefined || source.oneOf !== undefined ||
    source.allOf !== undefined
  ) {
    const {
      anyOf,
      oneOf,
      allOf,
      ...metadata
    } = source;
    if (purpose === "source-read") {
      // Projection can make formerly exclusive branches overlap or discard a
      // discriminator altogether. Keep the declared composition intact at the
      // read boundary; only the materialized output schema uses projected
      // (existential) branches.
      return source;
    }
    const projectOptions = (options: readonly JSONSchema[] | undefined) =>
      options?.map((option) => selectSourceSchema(option, mask, purpose, root));
    const projectedAnyOf = projectOptions(anyOf);
    const projectedOneOf = projectOptions(oneOf);
    const projectedAllOf = projectOptions(allOf);
    const conjunctions = [
      ...projectedAllOf ?? [],
      ...(projectedOneOf === undefined ? [] : [{ anyOf: projectedOneOf }]),
    ];
    return {
      ...metadata,
      ...(projectedAnyOf === undefined ? {} : { anyOf: projectedAnyOf }),
      ...(conjunctions.length === 0 ? {} : { allOf: conjunctions }),
    };
  }

  if (mask.type === "array") {
    if (!schemaIsArray(source)) return source;
    const sourceItem = schemaAtArrayItem(source);
    const { items: _items, prefixItems: _prefixItems, ...metadata } = source;
    return {
      ...metadata,
      items: selectSourceSchema(sourceItem, mask.items, purpose, root),
    };
  }

  if (
    !schemaTypes(source).includes("object") &&
    source.properties === undefined
  ) {
    return source;
  }
  const {
    properties: _properties,
    required,
    additionalProperties: _additionalProperties,
    patternProperties: _patternProperties,
    ...metadata
  } = source;
  const properties: Record<string, JSONSchema> = {};
  for (const [key, childMask] of Object.entries(mask.properties)) {
    const child = ContextualFlowControl.schemaAtPath(source, [key]);
    properties[key] = selectSourceSchema(
      child === false ? undefined : child,
      childMask,
      purpose,
      root,
    );
  }
  // A rejected position holds nothing to require. Keeping it required makes
  // the object unsatisfiable, which reads as an absent value for the whole
  // selection rather than for the one position that declined to be read.
  //
  // That test is {@link requiredSurvivesProjection} over the only part of
  // itself a MASK can state. A mask records `false`, the two containers and
  // `true`, so a caller's own scalar type is already gone by the time it
  // reaches here, and "the caller rejected the position outright" is the whole
  // of what is left to ask. A schema built from the classified projection has
  // those types in hand and applies the rule entire, in
  // {@link outputSchemaWithSourceRequired}.
  const selectedRequired = required?.filter((key) =>
    Object.hasOwn(properties, key) && properties[key] !== false
  );
  return {
    ...metadata,
    properties,
    ...(selectedRequired?.length ? { required: selectedRequired } : {}),
    additionalProperties: false,
  };
}

/**
 * `source` with its `$ref` chain followed, paired with the document root the
 * result resolves in — or `undefined` where the chain does not resolve or
 * closes on itself.
 *
 * A named interface is ordinarily spelled as a reference, so a reader that
 * declined to follow one would prove a container only for sources written
 * inline. The root travels beside the schema because following an embedded
 * reference enters another document, and a resolved view can be a document
 * of its own — which is exactly what a walk that re-roots on each descent
 * would otherwise lose.
 *
 * Resolution is the canonical resolver's, one hop per iteration, never a
 * private pointer parser. A reference repeated in its own document closes a
 * circle and resolves to nothing, which fails closed: `undefined` here proves
 * no container and so requires nothing.
 */
function resolvedSourceNode(
  source: JSONSchema | undefined,
  root: JSONSchema,
): { schema: Exclude<JSONSchema, boolean>; root: JSONSchema } | undefined {
  const followed: Array<{ root: JSONSchema; ref: string }> = [];
  let node = source;
  let scope = source === undefined ? root : root;
  while (isObjectOrArray(node)) {
    const ref = node.$ref;
    if (typeof ref !== "string") return { schema: node, root: scope };
    if (followed.some((step) => step.ref === ref && step.root === scope)) {
      return undefined;
    }
    const target = resolveCfcSchemaRef(scope, ref);
    if (target === undefined) return undefined;
    followed.push({ root: scope, ref });
    scope = cfcSchemaResolvedRoot(
      target,
      isEmbeddedCfcSchemaRef(ref) ? target : scope,
    );
    node = target;
  }
  return undefined;
}

/**
 * The child schema a resolved source node declares at `key`, **as written**.
 *
 * Deliberately not `ContextualFlowControl.schemaAtPath`, which resolves
 * references eagerly and with no guard against one that closes a circle — a
 * self-referential definition overflows the stack inside it, before any
 * caller's own guard can run. {@link resolvedSourceNode} follows the reference
 * instead, one hop at a time, so what this hands back is the child exactly as
 * the document spells it.
 */
function sourcePropertySchema(
  node: Exclude<JSONSchema, boolean> | undefined,
  key: string,
): JSONSchema | undefined {
  const properties = node?.properties;
  if (!isObjectNotArray(properties)) return undefined;
  const child = properties[key] as JSONSchema | undefined;
  return child === false ? undefined : child;
}

/** The element schema a resolved source node declares, as written. */
function sourceItemSchema(
  node: Exclude<JSONSchema, boolean> | undefined,
): JSONSchema | undefined {
  const items = node?.items as JSONSchema | undefined;
  return items === false ? undefined : items;
}

/**
 * Whether `source` **proves** the position holds the container `named`.
 *
 * "Can this be a container" is the wrong question here and "must it be" is the
 * right one. A position the source declares as `["array","string"]` admits an
 * array and holds whichever branch was stored; where it holds the string, a
 * caller's array projection rejects it and the property is omitted. A
 * `required` retained on the strength of the array branch then voids the
 * object around a position that simply declined to be read — which is the one
 * failure this whole survival rule exists to prevent.
 *
 * A source declaring no type proves nothing either, so it is not a container
 * for this purpose: an untyped position can hold a scalar just as a union can.
 *
 * The same union has a second spelling that never reaches `schemaTypes`, so
 * `anyOf` and `oneOf` are proven only where **every** branch proves the same
 * container. `allOf` is refused outright rather than reasoned through: a
 * conjunction constrains one value from several members at once, which is not
 * a shape this derivation can state (#5761), and declining to require costs a
 * key that would have survived while requiring wrongly costs the whole read.
 *
 * A `$ref` is followed first, so a named interface proves what it names.
 *
 * `visiting` holds the schema **as the document writes it**, which is what
 * bounds the recursion: a branch is drawn from a `node.anyOf` array, resolution
 * spreads shallowly and so leaves that array's members the document's own
 * objects, and a document holds finitely many of them. Guarding the RESOLVED
 * node instead would not bound anything — `resolveCfcSchemaRef` returns a fresh
 * view whenever the target carries a reference, which is exactly the case a
 * circle is made of, so no two visits to one definition share an identity.
 */
function sourceProvesContainer(
  named: "object" | "array",
  source: JSONSchema | undefined,
  root: JSONSchema,
  visiting = new Set<object>(),
): boolean {
  if (!isObjectOrArray(source) || visiting.has(source)) return false;
  const resolved = resolvedSourceNode(source, root);
  if (resolved === undefined) return false;
  const { schema: node, root: scope } = resolved;
  const declared = schemaTypes(node);
  if (declared.length > 0) {
    return declared.every((type) => type === named);
  }
  if (node.allOf !== undefined) return false;
  visiting.add(source);
  try {
    for (const branches of [node.anyOf, node.oneOf]) {
      if (
        Array.isArray(branches) && branches.length > 0 &&
        branches.every((branch) =>
          sourceProvesContainer(named, branch, scope, visiting)
        )
      ) {
        return true;
      }
    }
  } finally {
    visiting.delete(source);
  }
  return false;
}

/**
 * Whether a source-`required` property stays required in the schema the reader
 * constructs. It stays only where nothing the caller wrote inside that
 * property can cause the property **itself** to be rejected: a position the
 * caller narrowed may be omitted, but the object holding it must not be voided
 * because it was.
 *
 * The two containers do not decide that the same way, and that is why this is
 * not one case. `traverseObjectWithSchema`
 * (`packages/runner/src/traverse.ts`) assembles an object out of the
 * properties whose traversal returned no error and carries on past one that
 * failed; `traverseArrayWithSchema` carries a single `valid` flag across every
 * element and returns `undefined` when any element fails. **A rejected object
 * property is omitted; a rejected array element voids the array around it.**
 *
 * So, against the classified projection at that property:
 *
 * - No stated type — `true`, or `{}`. The constructed child is the unprojected
 *   one, declining exactly the values an unprojected read declines, which is
 *   the source's meaning `required` is being derived to carry. Stays.
 * - A scalar `type`. The constraint is the caller's, and declining a value is
 *   what a caller writes one for. Drops. This is the case a mask cannot see,
 *   every scalar position reducing to `true` in one.
 * - An object. What the caller wrote inside narrows a descendant, which is
 *   omitted rather than rejecting the object — on the condition that each
 *   descendant's own derived `required` follows this same rule, which
 *   {@link outputSchemaWithSourceRequired} discharges by recursing.
 * - An array. What the caller wrote does not stay where it was written: it
 *   constrains elements, and one rejected element voids the array. So the
 *   answer follows the ELEMENT schema, by the same rule one level down. An
 *   array carries no `required` of its own for that recursion to empty, so
 *   there is nothing below it to absorb a rejection.
 * - `false`. Drops, as it did before any of this: a rejected position holds
 *   nothing to require.
 *
 * Both container answers stand on the source proving that container at that
 * position — {@link sourceProvesContainer}, not "the source admits one". A
 * position the source declares as either an array or a scalar is a position
 * the caller may have narrowed away from, and requiring it on the strength of
 * the branch that matches the projection voids the read the same way every
 * other case here does.
 *
 * The rule only ever declines to require. Dropping a key that would have
 * survived costs nothing; keeping one that would not costs the entire read.
 */
function requiredSurvivesProjection(
  projection: JSONSchema | undefined,
  source: JSONSchema | undefined,
  sourceRoot: JSONSchema,
): boolean {
  if (projection === false) return false;
  if (projection === undefined || projection === true) return true;
  const types = schemaTypes(projection);
  // Arrays are tested first, matching {@link impliedProjectionType} and
  // {@link projectionMask}, so a position naming both vocabularies is read as
  // the array the selector built from it reads.
  if (types.includes("array") || projection.items !== undefined) {
    if (!sourceProvesContainer("array", source, sourceRoot)) return false;
    // The element sits inside whatever the reference resolved to, so it is
    // read off the resolved node and carries that node's scope.
    const resolved = resolvedSourceNode(source, sourceRoot);
    return requiredSurvivesProjection(
      projection.items,
      sourceItemSchema(resolved?.schema),
      resolved?.root ?? sourceRoot,
    );
  }
  if (
    types.includes("object") || projection.properties !== undefined ||
    projection.additionalProperties !== undefined
  ) {
    return sourceProvesContainer("object", source, sourceRoot);
  }
  return types.length === 0;
}

/**
 * The schema a JSON projection hands the read boundary: the classified
 * projection the reader constructed, plus the one key it supplies from
 * somewhere other than the caller — `required`, taken from the SOURCE schema
 * and filtered by {@link requiredSurvivesProjection}.
 *
 * {@link selectSourceSchema} already derives `required` this way for the
 * schemas it builds out of the mask, and for the same reason. This extends
 * that derivation to the position a JSON projection reaches, which is the
 * position where the caller's own scalar types are in play — so the filter
 * here is the survival rule rather than the projection membership a mask is
 * the whole of. Both spell `required`, over two origins, and only one of them
 * is the caller's to supply.
 *
 * A key is derived only for a property the constructed schema names. An open
 * position keeps whatever the source holds there without the reader vouching
 * for it, which declines to require rather than risking an unsatisfiable one.
 *
 * `sourceRoot` is the document `source` sits in, threaded down because this
 * walk re-roots on every descent: a child three levels in still spells its
 * shape as `#/$defs/Thing` against the root, and the subtree it was read out
 * of cannot resolve that. It travels beside `source` rather than being
 * recovered from it, since only the caller of the outermost call knows which
 * document a position came from.
 *
 * @internal Exported for focused reference-resolution tests, which reach the
 * cases a read cannot: the runner resolves a source schema's references
 * eagerly, so an unresolvable one fails the read before this is consulted.
 */
export function outputSchemaWithSourceRequired(
  projection: JSONSchema,
  source: JSONSchema | undefined,
  sourceRoot: JSONSchema = source ?? true,
): JSONSchema {
  if (typeof projection === "boolean") return projection;
  const resolved = resolvedSourceNode(source, sourceRoot);
  const node = resolved?.schema;
  const scope = resolved?.root ?? sourceRoot;
  const types = schemaTypes(projection);
  if (types.includes("array") || projection.items !== undefined) {
    if (projection.items === undefined) return projection;
    return {
      ...projection,
      items: outputSchemaWithSourceRequired(
        projection.items,
        sourceItemSchema(node),
        scope,
      ),
    };
  }
  const declared = projection.properties;
  if (!isObjectNotArray(declared)) return projection;
  const sourceRequired = node !== undefined && Array.isArray(node.required)
    ? node.required
    : [];
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(declared)) {
    const childSource = sourcePropertySchema(node, key);
    properties[key] = outputSchemaWithSourceRequired(
      child as JSONSchema,
      childSource,
      scope,
    );
    if (
      sourceRequired.includes(key) &&
      requiredSurvivesProjection(child as JSONSchema, childSource, scope)
    ) {
      required.push(key);
    }
  }
  return {
    ...projection,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

interface ResolvedProjection {
  outputSchema: JSONSchema;
  projectionSchema: JSONSchema;
  mask: ProjectionMask;
  projectsArrayItems: boolean;
  itemOutputSchema?: JSONSchema;
  itemProjectionSchema?: JSONSchema;
  itemMask?: ProjectionMask;
  implicitArrayTraversal: boolean;

  /** The projection's markers, at the depth the source puts them. */
  markers?: LinkMarkers;
}

function resolveProjection(
  projection: SelectionProjection | undefined,
  sourceSchema: JSONSchema | undefined,
  sourceIsArray: boolean,
): ResolvedProjection | undefined {
  if (projection === undefined) return undefined;
  if (projection.kind === "concise") {
    // A field list names positions of the source, so the source is what says
    // whether a name can be there at all. A path it cannot hold returns
    // nothing however the read is run, and returning nothing is what a read
    // legitimately does for a field that is merely absent — so the two are
    // separated here, before the read, where the schema still distinguishes
    // them.
    const unheld = firstUnheldSelectionField(
      sourceSchema,
      sourceSchema ?? true,
      projection.schema,
      "<root>",
    );
    if (unheld !== undefined) {
      throw unheldSelectionFieldError(projection.flag, unheld);
    }
    const projectsArrayItems = sourceIsArray;
    const source = projectsArrayItems
      ? schemaAtArrayItem(sourceSchema)
      : sourceSchema;
    const mask = alignConciseProjectionMask(
      source,
      projectionMask(projection.schema),
      projection.flag,
    );
    const projectionSchema = schemaFromProjectionMask(mask);
    const outputSchema = sanitizeSchemaForLinks(
      selectSourceSchema(
        dereferencedElementSchema(source),
        mask,
        "projected-output",
        sourceSchema ?? true,
      ),
      KeepAsCell.OnlyStream,
    );
    const markers = projection.markers === undefined
      ? undefined
      : alignConciseMarkers(source, projection.markers, projection.flag);
    return projectsArrayItems
      ? {
        outputSchema: filteredOutputSchema(sourceSchema, outputSchema),
        projectionSchema: {
          type: "array",
          items: projectionSchema,
        },
        // A field list read element-wise selects the array through its
        // elements, so an element the list rejects entirely rejects the array
        // the same way an item schema does.
        mask: arrayProjectionMask(mask),
        projectsArrayItems: true,
        itemOutputSchema: outputSchema,
        itemProjectionSchema: projectionSchema,
        itemMask: mask,
        implicitArrayTraversal: true,
        // An array source is read element-wise, and a field list marks what it
        // reads, so every marker below the root belongs to an element.
        ...(markers === undefined ? {} : { markers: { items: markers } }),
      }
      : {
        outputSchema,
        projectionSchema,
        mask,
        projectsArrayItems: false,
        implicitArrayTraversal: true,
        markers,
      };
  }
  const projectsArrayItems = schemaIsArray(projection.schema);
  if (
    projection.schema !== true &&
    sourceIsArray !== projectsArrayItems
  ) {
    throw new CellSelectionError(
      sourceIsArray
        ? "A JSON --schema for an array value must describe the returned " +
          'array (for example {"type":"array","items":{...}}).'
        : "An array-rooted JSON --schema can only be applied to an array value.",
    );
  }
  const mask = projectionMask(projection.schema);
  const itemSchema = projectsArrayItems
    ? (projection.schema as Exclude<JSONSchema, boolean>).items ?? true
    : undefined;
  // The projector applies the caller's shape to a value already in hand and
  // reads only `properties`, `items` and `additionalProperties` off it, so the
  // constructed projection is what it wants. The OUTPUT schema is the one the
  // runner acts on, and it carries the source's `required` besides.
  // The source cell's own schema is the document every `#/...` in it resolves
  // against, so it is both the position the walk starts at and the root it
  // threads down.
  const outputSchema = outputSchemaWithSourceRequired(
    projection.schema,
    sourceSchema,
    sourceSchema ?? true,
  );
  return {
    outputSchema,
    projectionSchema: projection.schema,
    mask,
    projectsArrayItems,
    implicitArrayTraversal: false,
    // A JSON Schema states its own depth, so its markers sit where it put them.
    markers: projection.markers,
    ...(projectsArrayItems
      ? {
        itemOutputSchema:
          (outputSchema as Exclude<JSONSchema, boolean>).items ?? true,
        itemProjectionSchema: itemSchema,
        itemMask: projectionMask(itemSchema!),
      }
      : {}),
  };
}

/**
 * A position the address walk has reached, and what a marker there renders.
 *
 * `address` is the deepest stored link the walk has crossed, plus the segments
 * below that link. `stored` is what the document containing this position
 * holds at it, and is absent below a crossed link: that link's target is a
 * document the walk does not read, so it can see no link stored inside it.
 */
interface WalkedPosition {
  cell: Cell<unknown>;
  address: RenderedLinkAddress;

  /**
   * The space the rendered reference is written relative to: an address in
   * another space carries a `//space/` prefix, one in this space a bare `/`.
   * It is the space the READER is working in rather than the source cell's,
   * since a path that crosses a link can land the source elsewhere.
   */
  contextSpace: MemorySpace | undefined;

  stored?: { value: unknown };
}

/** The address `link` names, in the shape a marked position renders. */
function renderedLinkAddress(link: NormalizedFullLink): RenderedLinkAddress {
  return {
    id: link.id,
    space: link.space,
    scope: link.scope,
    path: link.path.map((segment) => segment.toString()),
  };
}

/**
 * Helper for {@link composeLinkAddresses}: the position `cell` names, carrying
 * `address` from the walk above it unless the containing document stores a
 * link there. A stored link is a durable identity, so it becomes the address
 * this position renders and the base everything below it is addressed from.
 *
 * `space` and `scope` come from the containing document when the stored link
 * leaves them implicit, so both are always filled in.
 */
function walkedPosition(
  cell: Cell<unknown>,
  address: RenderedLinkAddress,
  contextSpace: MemorySpace | undefined,
  stored: { value: unknown } | undefined,
): WalkedPosition {
  const link = stored === undefined
    ? undefined
    : parseLink(stored.value, address);
  return link === undefined ? { cell, address, contextSpace, stored } : {
    cell,
    address: renderedLinkAddress(link),
    contextSpace,
    stored: undefined,
  };
}

/**
 * Helper for {@link composeLinkAddresses}: the position the walk reaches by
 * one more segment. `container` is what the document stores at the position
 * above, which is where the segment's own stored value comes from — so the
 * link a segment holds is read out of a document the selection already read,
 * rather than by following anything.
 */
function positionBelow(
  position: WalkedPosition,
  segment: string | number,
  container: unknown,
): WalkedPosition {
  const key = segment.toString();
  return walkedPosition(
    position.cell.key(key),
    { ...position.address, path: [...position.address.path, key] },
    position.contextSpace,
    isObjectOrArray(container) ? { value: container[key] } : undefined,
  );
}

/**
 * Helper for {@link composeLinkAddresses}: the position a composition starts
 * from, which is the cell the selection read. `lastNode: "top"` stops at a
 * link stored at that cell rather than following it, so a source that holds
 * one is addressed by it, exactly as any position below is.
 *
 * `contextSpace` is the space the addresses this walk renders are written
 * relative to; see {@link WalkedPosition.contextSpace}.
 */
function sourcePosition(
  cell: Cell<unknown>,
  contextSpace: MemorySpace | undefined,
): WalkedPosition {
  return walkedPosition(
    cell,
    renderedLinkAddress(cell.getAsNormalizedFullLink()),
    contextSpace,
    { value: cell.getRaw({ lastNode: "top" }) },
  );
}

/**
 * Helper for {@link composeLinkAddresses}, which reads the container stored at
 * `position` so a JSON `items` marker can be walked element by element.
 * Reaches for the container's own document when the walk cannot see the
 * container: behind a link, or where the selection's read stopped above it,
 * which is what a marked collection's rejecting selector does.
 */
async function storedContainer(position: WalkedPosition): Promise<unknown> {
  if (position.stored?.value !== undefined) return position.stored.value;
  const stored = position.cell.getRaw({ lastNode: "value" });
  if (stored !== undefined) return stored;
  await position.cell.asSchema(false).pull();
  return position.cell.getRaw({ lastNode: "value" });
}

/**
 * Helper for {@link composeLinkAddresses}: `markers` asked of every element of
 * `stored`, the array a position holds. Each element is addressed from the
 * link its own slot stores, so the answers survive a reordering of the
 * collection.
 */
async function composeElementAddresses(
  position: WalkedPosition,
  stored: readonly unknown[],
  markers: LinkMarkers,
  projected: unknown,
  implicitArrayTraversal: boolean,
): Promise<unknown[]> {
  const projectedItems = Array.isArray(projected) ? projected : [];
  const items: unknown[] = [];
  for (let index = 0; index < stored.length; index++) {
    items.push(
      await composeLinkAddresses(
        positionBelow(position, index, stored),
        markers,
        projectedItems[index],
        implicitArrayTraversal,
      ),
    );
  }
  return items;
}

/**
 * Composes the addresses a selection's markers asked for into `projected`, the
 * value its projection produced.
 *
 * A marked position renders `{"$link": "/of:fid1:…/path"}` — the fabric's
 * canonical reference syntax, one string carrying id, space, scope and path,
 * so the address a read hands back is the address a later command takes in.
 * Where the same position also projected contents, the address joins them in
 * one object, because both were asked for. Where those contents are not an
 * object there is nothing to join them to, and the address is the whole
 * answer.
 *
 * `implicitArrayTraversal` states that the markers came from a concise field
 * list, which names a field wherever the value holds one rather than at a
 * fixed depth. Where the source declares that depth,
 * {@link alignConciseMarkers} has already written it out as `items`, so
 * `notes@` answers with the note documents rather than with the slots they sit
 * in. Where the source declares nothing, the value decides instead: a position
 * the walk holds an array at is asked of each of its elements, the same way
 * {@link projectValue} applies one field mask across them, and the address
 * included. A JSON Schema states its own depth, and marks elements with
 * `items`.
 */
async function composeLinkAddresses(
  position: WalkedPosition,
  markers: LinkMarkers,
  projected: unknown,
  implicitArrayTraversal = false,
): Promise<unknown> {
  // The container is the one the walk already holds. A marked position is
  // never fetched, so below a crossed link there is nothing to look inside,
  // and that link is the address.
  const elements = implicitArrayTraversal && markers.items === undefined
    ? position.stored?.value
    : undefined;
  if (Array.isArray(elements)) {
    return await composeElementAddresses(
      position,
      elements,
      markers,
      projected,
      implicitArrayTraversal,
    );
  }

  let composed = projected;
  if (markers.items !== undefined) {
    const stored = await storedContainer(position);
    if (Array.isArray(stored)) {
      composed = await composeElementAddresses(
        position,
        stored,
        markers.items,
        projected,
        implicitArrayTraversal,
      );
    }
  } else if (markers.properties !== undefined) {
    const projectedRecord = isObjectNotArray(projected) ? projected : {};
    const record: Record<string, unknown> = { ...projectedRecord };
    for (const [key, child] of Object.entries(markers.properties)) {
      record[key] = await composeLinkAddresses(
        positionBelow(position, key, position.stored?.value),
        child,
        projectedRecord[key],
        implicitArrayTraversal,
      );
    }
    composed = record;
  }
  if (markers.marked !== true) return composed;
  const address = {
    [LINK_MARKER_KEY]: createLLMFriendlyLink(
      position.address,
      position.contextSpace,
    ),
  };
  return isObjectNotArray(composed) ? { ...address, ...composed } : address;
}

/**
 * The refusal a projection over array items earns when the value it meets is
 * not an array. Both roads to that mismatch answer with it: the pattern graph
 * reaches it through the map builtin, and a selection that is entirely
 * addresses reaches it through the walk, which never runs one.
 */
function arrayItemProjectionError(flag: ProjectionFlag): CellSelectionError {
  return new CellSelectionError(
    `${flag} can only project array items from an array value`,
  );
}

/**
 * What one runtime keeps for the transform reads it has already served.
 *
 * Both fields answer the same question — which pattern object a repeat of a
 * read hands to `runtime.run`.
 *
 * `run` decides "the same pattern as last time" by comparing pattern pointers,
 * and a hand-built pattern's pointer is minted per pattern OBJECT rather than
 * per structure (#5756). A repeat that rebuilds a structurally identical
 * pattern therefore reads as a pattern change, and a change re-stages the
 * stored argument and validates it against the incoming argument schema. A
 * projection has narrowed that schema, so the source's other fields come back
 * as additional properties and the read fails with a schema error nothing in
 * the request explains. Running the pattern the cell was set up with is the
 * same setup instead, and answers.
 *
 * A pattern object does not cross runtimes: its pointer is indexed in the
 * runtime that minted it, and the nested patterns behind it do not resolve
 * elsewhere. A second runtime over one storage session therefore needs its own
 * result cell rather than the setup stored on the first runtime's, which is
 * what `discriminator` gives it.
 */
interface TransformReads {
  /** Separates this runtime's transform cells from another runtime's. */
  readonly discriminator: number;

  /** The pattern each transform result cell runs, by space-qualified id. */
  readonly patterns: Map<string, Pattern>;
}

const transformReads = new WeakMap<Runtime, TransformReads>();

let nextTransformDiscriminator = 0;

/** The reads `runtime` has served, minting the record on its first one. */
function transformReadsFor(runtime: Runtime): TransformReads {
  let reads = transformReads.get(runtime);
  if (reads === undefined) {
    reads = {
      discriminator: ++nextTransformDiscriminator,
      patterns: new Map(),
    };
    transformReads.set(runtime, reads);
  }
  return reads;
}

/** Optional hooks into {@link deriveSelectedValue}'s internals. */
export interface DeriveSelectedValueDependencies {
  /** Called with the cell the returned value was read from. */
  onOutputCell?: (cell: Cell<unknown>) => void;
}

/**
 * Whether a raw cell value establishes its container shape without following
 * a link or materializing a Fabric instance.
 */
export function isStoredContainer(value: unknown): boolean {
  return isObjectOrArray(value) && !isInstance(value) && !isLink(value);
}

/** Reads a schemaless root's array shape without traversing its children. */
async function sourceRootIsArray(cell: Cell<unknown>): Promise<boolean> {
  if (cell.schema === undefined) {
    const stored = cell.asSchema(false);
    await stored.pull();
    const raw = stored.getRaw();
    if (isStoredContainer(raw)) return Array.isArray(raw);
  }
  // A link can point at another shape, and a schema can transform the stored
  // value. Materialization decides those cases.
  return Array.isArray(await cell.pull());
}

/**
 * Applies `selection` to `sourceCell` through an actual runtime pattern graph,
 * returning the value the caller asked for.
 *
 * `runtime` and `space` say where that pattern runs, and are the caller's to
 * decide rather than the cell's: a path that crosses a link can land
 * `sourceCell` in a space other than the one its reader is working in.
 *
 * The filter uses the runner's list builtin, so predicate observations taint
 * collection membership exactly as they do in authored patterns. Array
 * projection uses the map builtin for pointwise labels. Object/scalar
 * projection uses a lift. Projection nodes construct the caller-requested
 * shape from source-schema-selected reads, preventing an identity alias from
 * widening back to a broader linked target. Caller schemas describe output
 * shape only; source schemas remain authoritative for CFC and other Fabric
 * metadata.
 *
 * A marker is answered beside that graph rather than through it: the marked
 * position contributes the rejecting selector to the read, so nothing behind
 * it is loaded, and its address is composed in from the deepest link the walk
 * down to it crosses, plus the segments below that link. That composition
 * walks the source, which a `--filter` makes unavailable — the elements a
 * predicate keeps cannot be traced back to the positions they came from — so
 * the two are refused together.
 */
export async function deriveSelectedValue(
  runtime: Runtime,
  space: MemorySpace,
  sourceCell: Cell<unknown>,
  selection: CellSelection,
  deps: DeriveSelectedValueDependencies = {},
): Promise<unknown> {
  const implicitArrayTraversal = selection.projection?.kind === "concise";
  if (
    selection.filter !== undefined &&
    selection.projection?.markers !== undefined
  ) {
    const asked = implicitArrayTraversal
      ? `an \`${CONCISE_ADDRESS_SUFFIX}\` suffix in ` +
        selection.projection!.flag
      : `a "${LINK_MARKER_KEY}" projection`;
    throw new CellSelectionError(
      `--filter cannot be combined with ${asked}: a filtered array's ` +
        "elements no longer say which positions they came from, and an " +
        "address names a position",
    );
  }
  const declaredSourceSchema = sourceCell.schema;
  const sourceSchema = isObjectOrArray(declaredSourceSchema) &&
      declaredSourceSchema.asCell !== undefined
    ? dereferencedElementSchema(declaredSourceSchema)
    : declaredSourceSchema;
  const sourceValueCell = sourceSchema === declaredSourceSchema
    ? sourceCell
    : sourceCell.asSchema(sourceSchema);
  if (selection.filter === undefined && selection.projection === undefined) {
    return await sourceValueCell.pull();
  }

  const rootKind = schemaRootKind(sourceSchema);
  const sourceIsArray = rootKind === "unknown"
    ? await sourceRootIsArray(sourceValueCell)
    : rootKind === "array";
  if (selection.filter !== undefined && !sourceIsArray) {
    throw new CellSelectionError(
      "--filter can only be applied to an array",
    );
  }
  const projection = resolveProjection(
    selection.projection,
    sourceSchema,
    sourceIsArray,
  );
  // The markers at the depth the source puts them, which is where the walk
  // below meets the positions they name.
  const markers = projection?.markers;
  if (markers !== undefined && projection?.mask === false) {
    // The whole selection was addresses. There is no value to compute, so the
    // pattern graph would run over the rejecting selector and produce nothing
    // for the composition to join. Read the stored links and answer.
    //
    // One cell reads and is walked: a sync is recorded on the cell it was
    // asked of, so walking any other instance of the same position kicks a
    // second sync of the document just loaded. The rejecting schema is what
    // holds that load to the one document, because a sync selector carries
    // the cell's schema.
    const walked = sourceValueCell.asSchema(false);
    await walked.pull();
    const position = sourcePosition(walked, space);
    // The graph path refuses a projection over array items that meets a value
    // which is not an array, and the answer to a marked one is the same
    // refusal: a walk over a non-array simply finds no elements to address,
    // which renders as an absent value rather than as the mismatch it is.
    //
    // `undefined` is not a mismatch. An unset declared array is the empty
    // array under the runner's map semantics, so the unmarked spelling
    // answers `[]` — and a marked one has to answer `[]` too, or the two
    // disagree about a piece that simply has nothing in it yet. A stored
    // `null` or object still is a mismatch and still refuses.
    const storedValue = await storedContainer(position);
    if (projection.projectsArrayItems && !Array.isArray(storedValue)) {
      // An unset declared array is the empty array under the runner's map
      // semantics, which is why the unmarked spelling answers `[]`. A marked
      // one answers `[]` as well rather than refusing or going absent: the
      // piece is not malformed, it simply holds nothing yet, and that is the
      // state every collection starts in. A stored `null` or object IS a
      // mismatch and still refuses.
      if (storedValue === undefined) return [];
      throw arrayItemProjectionError(selection.projection!.flag);
    }
    return await composeLinkAddresses(
      position,
      markers,
      undefined,
      implicitArrayTraversal,
    );
  }
  const sourceItemSchema = schemaAtArrayItem(sourceSchema);
  const predicateItemMask = selection.filter === undefined
    ? undefined
    : maskFromPaths(selection.filter.paths);
  const projectionMaskSchema = projection?.mask;
  const projectionItemMask = projection?.itemMask;

  let sourceMask: ProjectionMask = true;
  if (selection.filter !== undefined && projection === undefined) {
    // Filtering returns original elements. Keep their complete source schema
    // on the links that survive, while the predicate pattern below narrows the
    // actual predicate reads.
    sourceMask = true;
  } else if (selection.filter !== undefined) {
    sourceMask = {
      type: "array",
      items: mergeMasks(
        predicateItemMask!,
        projectionItemMask!,
      ),
    };
  } else if (projectionMaskSchema !== undefined) {
    sourceMask = projectionMaskSchema;
  }
  const sourceReadSchema = selectSourceSchema(sourceSchema, sourceMask);

  const { commonfabric } = createBuilder({
    unsafeHostTrust: runtime.createUnsafeHostTrust({
      reason: "cf cell get filter/schema computed projection",
    }),
  });
  const { lift, pattern } = commonfabric;
  const paramsSchema: JSONSchema = {
    type: "object",
    additionalProperties: true,
  };

  // Documents placed under the properties of one wrapper: their `$defs` move
  // to the wrapper's root, which is where their `#/$defs/<name>` refs point
  // once they sit below another root, with a name two documents define
  // differently renamed apart.
  const wrapProperties = (
    documents: Readonly<Record<string, JSONSchema>>,
  ): JSONSchema => {
    const keys = Object.keys(documents);
    const { fragments, definitions } = hoistCfcSchemaDefs(
      keys.map((key) => documents[key]),
    );
    return {
      type: "object",
      properties: Object.fromEntries(
        keys.map((key, index) => [key, fragments[index]]),
      ),
      required: keys,
      additionalProperties: false,
      ...(definitions !== undefined && { $defs: definitions }),
    };
  };
  const wrapUnder = (key: string, document: JSONSchema): JSONSchema =>
    wrapProperties({ [key]: document });

  let predicatePattern: ReturnType<typeof pattern> | undefined;
  if (selection.filter !== undefined) {
    const elementSchema = selectSourceSchema(
      sourceItemSchema,
      predicateItemMask!,
      "source-read",
      sourceSchema ?? true,
    );
    const argumentSchema = wrapProperties({
      element: sanitizeSchemaForLinks(
        dereferencedElementSchema(elementSchema),
        KeepAsCell.OnlyStream,
      ),
      params: paramsSchema,
    });
    const predicateModule = lift(
      ({ element, params }: {
        element: unknown;
        params: { predicate: SelectionPredicate };
      }) => evaluateSelectionPredicate(params.predicate, element),
      argumentSchema,
      { type: "boolean" },
    );
    predicatePattern = pattern(
      ({ element, params }: any) => predicateModule({ element, params }),
      argumentSchema,
      { type: "boolean" },
    );
  }

  let itemProjectionPattern: ReturnType<typeof pattern> | undefined;
  if (projection?.projectsArrayItems) {
    const itemOutputSchema = projection.itemOutputSchema!;
    const itemProjectionSchema = projection.itemProjectionSchema!;
    const elementSchema = selectSourceSchema(
      sourceItemSchema,
      projectionItemMask!,
      "source-read",
      sourceSchema ?? true,
    );
    const argumentSchema = wrapUnder(
      "element",
      sanitizeSchemaForLinks(
        dereferencedElementSchema(elementSchema),
        KeepAsCell.OnlyStream,
      ),
    );
    const projectionModule = lift(
      ({ element }: { element: unknown }) =>
        projectValue(
          element,
          itemProjectionSchema,
          projection.implicitArrayTraversal,
        ),
      argumentSchema,
      itemOutputSchema,
    );
    itemProjectionPattern = pattern(
      ({ element }: any) => projectionModule({ element }),
      argumentSchema,
      itemOutputSchema,
    );
  }

  const directProjectionArgumentSchema = wrapUnder(
    "value",
    sanitizeSchemaForLinks(sourceReadSchema, KeepAsCell.OnlyStream),
  );
  const directProjectionModule = projection !== undefined &&
      !projection.projectsArrayItems
    ? lift(
      ({ value }: { value: unknown }) =>
        projectValue(
          value,
          projection.projectionSchema,
          projection.implicitArrayTraversal,
        ),
      directProjectionArgumentSchema,
      projection.outputSchema,
    )
    : undefined;

  const outputSchema: JSONSchema = projection?.outputSchema ??
    filteredOutputSchema(sourceSchema, sourceItemSchema);
  const mainArgumentSchema = wrapUnder("value", sourceReadSchema);
  const mainResultSchema = wrapUnder("value", outputSchema);
  const mainPattern = pattern(
    ({ value }: any) => {
      let result: any = value;
      if (predicatePattern !== undefined) {
        result = result.filterWithPattern(predicatePattern as any, {
          predicate: selection.filter!.predicate,
        });
      }
      if (itemProjectionPattern !== undefined) {
        result = result.mapWithPattern(itemProjectionPattern as any, {});
      } else if (directProjectionModule !== undefined) {
        result = directProjectionModule({ value: result });
      }
      return { value: result };
    },
    mainArgumentSchema,
    mainResultSchema,
  );

  const tx = runtime.edit();
  const reads = transformReadsFor(runtime);
  const resultCell = runtime.getCell(
    space,
    {
      pieceGetTransform: {
        // A pattern graph belongs to the runtime that runs it, so two runtimes
        // sharing one storage session read from separate cells.
        runtime: reads.discriminator,
        source: sourceValueCell.getAsNormalizedFullLink(),
        filter: selection.filter?.source,
        schema: selection.projection?.source,
        // The pattern's shape branches on this, and a source whose schema names
        // no root kind reads it off the value — so a source that changes kind
        // is a different read rather than the same one answered differently.
        sourceIsArray,
      },
    },
    mainResultSchema,
    tx,
    "session",
  );
  const resultLink = resultCell.getAsNormalizedFullLink();
  const readKey = `${resultLink.space}/${resultLink.id}`;
  // The repeat runs the pattern this cell was set up with; the first read of a
  // selection is the one that installs it.
  const installedPattern = reads.patterns.get(readKey);
  if (installedPattern === undefined) reads.patterns.set(readKey, mainPattern);
  const errors = runtimeErrorLog(runtime);
  const errorCountBefore = errors.length;
  const result = await runtime.setup(
    tx,
    installedPattern ?? mainPattern,
    {
      value: sourceValueCell.asSchema(sourceReadSchema).getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.OnlyStream,
      }),
    },
    resultCell,
  );
  // Computed results can return an alias whose target carries a broader (or
  // absent) schema. Re-assert the expression's declared result shape at the
  // read boundary so following that alias cannot widen the projection.
  const outputCell = result.key("value").asSchema(outputSchema);
  try {
    runtime.prepareTxForCommit(tx);
    const committed = await timeSelectionPhase("commit", () => tx.commit());
    if (committed.error !== undefined) {
      throw new CellSelectionError(
        `Could not apply get transform: ${committed.error}`,
      );
    }
    // A session-local projection can reuse space-scoped mapped children.
    // The committed argument lets synchronized startup resolve their identities
    // and load their execution state before the coordinator initializes them.
    await timeSelectionPhase("start", async () => {
      const committedResult = result.withTx();
      try {
        await runtime.runner.syncStoredPieceCells(
          committedResult,
          installedPattern ?? mainPattern,
        );
        if (!await runtime.start(committedResult)) {
          throw new Error("projection did not start");
        }
      } catch (error) {
        throw new CellSelectionError(
          `Could not apply get transform: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    // pull() is the readiness boundary for this output: it drives transitive
    // computations, waits for linked documents those reads discover, and
    // re-idles after each arrival. Nothing downstream re-checks it: the
    // re-projection below imposes key order locally, so a pull that stopped
    // short of the fixpoint would no longer show as an out-of-order key (what
    // the four-entrypoint test could see) but as a silently absent one. The
    // cold and stale session-scoped integration reads are what stand behind
    // one pull sufficing.
    await timeSelectionPhase("output.pull", () => outputCell.pull());
    const outputValue = outputCell.get();
    // Runtime materialization can expose object children in arrival order.
    // Apply the resolved projection to the value in hand so declared fields
    // instead follow schema order, closed and open projections alike; the
    // keys an open projection retains beyond its declaration follow, in the
    // value's own order. This is local value work and starts no graph or
    // storage operation.
    const orderedOutput = projection === undefined ? outputValue : projectValue(
      outputValue,
      projection.projectionSchema,
      implicitArrayTraversal,
    );
    const recorded = errors.slice(errorCountBefore);
    if (recorded.length > 0) {
      // Translate the array-shape errors emitted by the runner filter/map
      // builtins into CLI-level messages. Keep these matches in sync with
      // packages/runner/src/builtins/{filter,map}.ts; the mismatch regression
      // test in piece-get-transform.test.ts guards this package-boundary
      // coupling.
      if (
        selection.filter !== undefined &&
        recorded.some((error) =>
          error.message === "filter currently only supports arrays"
        )
      ) {
        throw new CellSelectionError(
          "--filter can only be applied to an array",
        );
      }
      if (
        projection?.projectsArrayItems &&
        recorded.some((error) =>
          error.message === "map currently only supports arrays"
        )
      ) {
        throw arrayItemProjectionError(selection.projection!.flag);
      }
      const lastError = recorded.at(-1)!;
      throw new CellSelectionError(
        `Could not apply get transform: ${lastError.message}`,
      );
    }
    deps.onOutputCell?.(outputCell);
    return markers === undefined ? orderedOutput : await composeLinkAddresses(
      sourcePosition(sourceValueCell, space),
      markers,
      orderedOutput,
      implicitArrayTraversal,
    );
  } finally {
    runtime.runner.stop(resultCell);
  }
}

/**
 * Helper for {@link boundReadValue}: `markers` restricted to the positions the
 * value in hand actually holds.
 *
 * `values` is every value occupying one position: the single value below a
 * property, and every element below `items`, which one marker answers for at
 * once.
 *
 * The restriction is what keeps a bound from widening. A marker composition
 * writes its key whether or not the value has one, because it is normally
 * composed onto a value projected by the very schema the markers came from. A
 * bound applied to a value someone else already shaped has no such agreement:
 * every position that caller narrowed away has to lose its marker too, or it
 * comes back as an address and the answer holds more than was asked for.
 */
function markersHeldBy(
  markers: LinkMarkers,
  values: readonly unknown[],
): LinkMarkers | undefined {
  const held = values.filter((value) => value !== undefined);
  if (held.length === 0) return undefined;
  const kept: LinkMarkers = {};
  if (markers.marked === true) kept.marked = true;
  if (markers.items !== undefined) {
    const elements = held.flatMap((value) => Array.isArray(value) ? value : []);
    const items = markersHeldBy(markers.items, elements);
    if (items !== undefined) kept.items = items;
  }
  if (markers.properties !== undefined) {
    const properties: Record<string, LinkMarkers> = {};
    for (const [key, child] of Object.entries(markers.properties)) {
      const below = held.flatMap((value) =>
        isObjectNotArray(value) && Object.hasOwn(value, key)
          ? [(value as Record<string, unknown>)[key]]
          : []
      );
      const childMarkers = markersHeldBy(child, below);
      if (childMarkers !== undefined) properties[key] = childMarkers;
    }
    if (Object.keys(properties).length > 0) kept.properties = properties;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * `value`, read from `sourceCell`, held to what `declared` describes — or
 * `undefined` where the declaration bounds nothing.
 *
 * A value that closes a circle has no JSON rendering, and the declaration is
 * the boundary its author drew. `bound` says how much of that boundary to
 * apply, and {@link DeclaredBound} says what each answer means: `"recursion"`
 * cuts the position where the declared type re-enters itself, and `"shape"`
 * additionally holds every object position to the fields it declares. The
 * addresses `"recursion"` composes are composed by the same walk
 * {@link deriveSelectedValue} composes its own with, off the same cell, so a
 * derived bound and a hand-written `$link` name the same position the same
 * way.
 *
 * Applied to the value already in hand rather than read afresh, which is what
 * lets it bound a result a caller has ALREADY shaped without widening it: the
 * cut removes positions and never adds one, so whatever `--select`/`--schema`
 * narrowed to stays narrowed. An address that shape composed is one of the
 * positions it narrowed to, and stays with the rest: nothing behind an address
 * was read, so there is nothing there for a bound to hold to a shape, and
 * closing an object over the declared fields instead would answer with
 * contents where an address was asked for. Reading a second time through the
 * derived projection cannot do any of that — it answers with the declaration's
 * whole shape, which for a caller who named one field is a projection handing
 * back the fields they did not name. Working off the value in hand also runs
 * no pattern graph and commits no transaction; what remains is the address
 * walk itself, which is the same one a hand-written `$link` is composed
 * through.
 *
 * `contextSpace` is the space the reader is working in, which decides whether
 * a composed address carries a `//space/` prefix.
 */
export async function boundReadValue(
  sourceCell: Cell<unknown>,
  declared: JSONSchema | undefined,
  value: unknown,
  contextSpace: MemorySpace,
  bound: DeclaredBound = "recursion",
): Promise<unknown> {
  const projection = declaredResultProjection(declared, bound);
  if (projection === undefined) return undefined;
  // The derived projection is written at fixed depth, so it is applied at
  // fixed depth: `kind` is `"json"` for everything `declaredResultProjection`
  // returns, and a concise field list's implicit array traversal has no part
  // in a shape derived from a declaration. The value it is applied to may
  // already hold addresses a caller's own shape composed, and those are that
  // caller's answers rather than fields of what sits behind them, so they are
  // carried across the shape rather than closed out of it.
  const projected = projectValue(value, projection.schema, false, true);
  const markers = projection.markers === undefined
    ? undefined
    : markersHeldBy(projection.markers, [value]);
  return markers === undefined ? projected : await composeLinkAddresses(
    sourcePosition(sourceCell, contextSpace),
    markers,
    projected,
  );
}
