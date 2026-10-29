/**
 * What the language-neutral conformance fixtures have in common: how their
 * values are written and checked, the cases every concrete class contributes,
 * and the layout of a fixture file. An implementation in another language
 * reads a fixture through those.
 *
 * A value is written as its `fvj1:` text, with the mods to decoding it that
 * state what no text carries. What a decode returns is checked by probes,
 * paths into the value paired with what a reader finds at each.
 * `test/fixtures/value-probes.md` defines the paths, the mods and the probes.
 *
 * This is reached through `for-testing-only.ts` and the modules that write the
 * fixtures, and has no place in any barrel.
 */

import type { Constructor } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import type { FabricPlainObject, FabricValue } from "@/interface.ts";
import { ProblematicValue, UnknownValue } from "@/codec-common";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { createBaseJsonRegistry, JsonCodecEngine } from "@/codec-json";
import { deepFreeze } from "@/deep-freeze.ts";
import {
  FabricError,
  type FabricInstanceClassesByName,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@/fabric-instances";
import { FabricRegExp } from "@/fabric-primitives";
import { FABRIC_PRIMITIVE_CODEC_TYPE_TAGS } from "@/fabric-primitives/interface.ts";
import { isFabricArray, isFabricPlainObject } from "@/types";
import { createDefaultJsonRegistry, jsonFromFabricValue } from "./codecs.ts";
import { codecClasses as instanceClasses } from "./fabric-instances/impl.ts";
import { codecClasses as primitiveClasses } from "./fabric-primitives/impl.ts";

//
// Types
//

/** JSON, as a fixture holds it, so that any language can read it. */
export type FixtureJson =
  | null
  | boolean
  | number
  | string
  | readonly FixtureJson[]
  | { readonly [key: string]: FixtureJson };

/**
 * A string as a fixture writes it: the string itself, or its UTF-16 code
 * units where it holds a lone surrogate.
 */
export type FixtureString = string | { readonly utf16: readonly number[] };

/**
 * One step of a path: an array index, or a record key or an instance's field.
 */
export type PathStep = number | FixtureString;

/** A path into a value, from its root. The empty path is the root itself. */
export type ValuePath = readonly PathStep[];

/** A change made to a decoded value, putting there what no text carries. */
export type ValuePatch = {
  /** Where the change is made, at a `null` of the decoded text. */
  readonly at: ValuePath;

  /**
   * What is put there: the array, record or instance at the path `cycle`,
   * which closes a cycle, or a symbol of no registry key, under its
   * description, `null` being none.
   */
  readonly put:
    | { readonly cycle: ValuePath }
    | { readonly unregisteredSymbol: FixtureString | null };
};

/**
 * What a probe's special form says of the node at its path: an array's length,
 * a record's count of keys, a run of holes in an array and its length, or the
 * tag of an instance, or of an unknown value.
 */
export type ProbeForm =
  | { readonly array: number }
  | { readonly record: number }
  | { readonly holes: number }
  | { readonly instance: string }
  | { readonly unknown: string };

/**
 * One probe: a path into a value, and what a reader finds there, the `fvj1:`
 * text of a leaf, or a special form, in the vocabulary
 * `test/fixtures/value-probes.md` defines.
 */
export type ValueProbe = readonly [ValuePath, string | ProbeForm];

/** A value written as an `fvj1:` text, and the mods to decoding it. */
export type TextWithMods = {
  /** The text, `fvj1:` prefix and all. */
  readonly text: string;

  /** Wire tags to decode as though no codec claimed them. */
  readonly unclaimed?: readonly string[];

  /** Changes made to what decoding returns. */
  readonly patches?: readonly ValuePatch[];
};

/**
 * A measure of a value's size by which `3-json-encoding.md` section 12 has an
 * implementation state a guarantee: the longest array, the largest record, the
 * longest string, the longest byte sequence, the longest registered symbol's
 * key, and the depth.
 */
export type SizeMeasure =
  | "arrayLength"
  | "propertyCount"
  | "stringLength"
  | "bytesLength"
  | "symbolKeyLength"
  | "depth";

/**
 * What a reader must support to read a fixture entry, a reader that does not
 * skipping the entry: the flavors of regular expression whose patterns it must
 * construct, and by each measure the guarantee it must state at least, given
 * only where that is past the measure's floor.
 */
export type FixtureRequirements =
  & { readonly flavors?: readonly string[] }
  & { readonly [Measure in SizeMeasure]?: number };

/** Makers of examples of each class in one of the class tables. */
export type ExampleMakers<ClassesByName> = {
  readonly [Name in keyof ClassesByName]: readonly (() => FabricValue)[];
};

/**
 * What a class's examples need beyond their makers: the spec section, or a
 * note saying why the class's examples are not cases.
 */
export type ClassCaseNotes =
  | { readonly section: string }
  | { readonly excluded: string };

/** A case made from one class example: its name, its section, and its maker. */
export type ClassCase = {
  readonly name: string;
  readonly section: string;
  readonly make: () => FabricValue;
};

//
// Cases
//

/** Why the classes whose codecs are stubs have no cases. */
export const STUB_CODEC_EXCLUSION = "Its codec is a stub, pending general " +
  "`FabricInstance` support (1-fabric-values.md sections 1.4.3 and 1.4.4).";

/**
 * Returns one case for each maker in `makers`, named for its class and its
 * place among that class's makers.
 */
export function classCasesOf<Name extends string>(
  makers: { readonly [N in Name]: readonly (() => FabricValue)[] },
  notes: { readonly [N in Name]: ClassCaseNotes },
): ClassCase[] {
  const cases: ClassCase[] = [];
  for (const name in notes) {
    const classNotes = notes[name];
    if ("excluded" in classNotes) continue;
    makers[name].forEach((make, index) => {
      cases.push({
        name: `${name}, example ${index + 1}`,
        section: classNotes.section,
        make,
      });
    });
  }
  return cases;
}

/**
 * Returns an array of length `length` holding `entries`, each an index and the
 * value there, and a hole at every other index.
 */
export function sparseArrayOf(
  length: number,
  entries: readonly (readonly [number, FabricValue])[],
): FabricValue[] {
  const result: FabricValue[] = new Array(length);
  for (const [index, value] of entries) {
    result[index] = value;
  }
  return result;
}

//
// The fixture file
//

/**
 * Throws if two of `cases` share a name, a fixture naming each case once.
 *
 * @throws If two cases share a name.
 */
export function assertDistinctCaseNames(
  cases: readonly { readonly name: string }[],
): void {
  const names = new Set<string>();
  for (const { name } of cases) {
    if (names.has(name)) {
      throw new Error(`Two cases are named ${name}.`);
    }
    names.add(name);
  }
}

/**
 * Returns the text of a fixture file: `about`, which says what the file is,
 * and `entries`, one per case. Each entry is one line, and every character
 * past ASCII is escaped, so that the file is unchanged by any tool that
 * normalizes text.
 */
export function fixtureTextOf(
  about: string,
  entries: readonly FixtureJson[],
): string {
  const lines = entries.map(asciiJsonOf);
  return `{\n  "about": ${asciiJsonOf(about)},\n  "cases": [\n    ` +
    `${lines.join(",\n    ")}\n  ]\n}\n`;
}

/** Returns the JSON text of `value`, with every non-ASCII code unit escaped. */
function asciiJsonOf(value: FixtureJson): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

//
// Requirements
//

/** Every measure, in the order the spec's table gives them. */
const SIZE_MEASURES: readonly SizeMeasure[] = [
  "arrayLength",
  "propertyCount",
  "stringLength",
  "bytesLength",
  "symbolKeyLength",
  "depth",
];

/**
 * The floor `3-json-encoding.md` section 12 sets by each measure: the smallest
 * guarantee an implementation may state, and the size past which a fixture
 * entry states what it requires.
 */
export const SIZE_FLOORS: { readonly [Measure in SizeMeasure]: number } = Object
  .freeze({
    arrayLength: 2 ** 24,
    propertyCount: 2 ** 14,
    stringLength: 2 ** 24,
    bytesLength: 2 ** 24,
    symbolKeyLength: 2 ** 10,
    depth: 2 ** 10,
  });

/**
 * This package's guarantee by each measure, as its README states it, no
 * figure being written `Infinity`.
 */
const SIZE_GUARANTEES: { readonly [Measure in SizeMeasure]: number } = Object
  .freeze({
    arrayLength: 2 ** 26,
    propertyCount: Infinity,
    stringLength: 2 ** 26,
    bytesLength: 2 ** 27,
    symbolKeyLength: 2 ** 26,
    depth: 2 ** 11,
  });

/**
 * The tags of the primitives, whose states hold no value of their own: a
 * tagged value under one is no container, and what its state holds is
 * measured by {@link measurePrimitiveState}.
 */
const PRIMITIVE_TAGS: ReadonlySet<string> = new Set([
  CODEC_TYPE_TAGS.BigInt,
  CODEC_TYPE_TAGS.SpecialNumber,
  CODEC_TYPE_TAGS.Symbol,
  CODEC_TYPE_TAGS.Undefined,
  ...Object.values(FABRIC_PRIMITIVE_CODEC_TYPE_TAGS),
]);

/**
 * Returns what a reader must support to read the entry for `stated`: `flavors`,
 * which a case marks by hand, and by each measure the size of the value its
 * text writes, where that is past the measure's floor. Returns `undefined`
 * where a reader need support nothing beyond the floors.
 */
export function requirementsOf(
  stated: TextWithMods,
  flavors?: readonly string[],
): FixtureRequirements | undefined {
  const requires:
    & { flavors?: readonly string[] }
    & { -readonly [Measure in SizeMeasure]?: number } = {};
  if (flavors !== undefined) {
    requires.flavors = flavors;
  }
  const sizes = sizesOf(stated);
  for (const measure of SIZE_MEASURES) {
    if (sizes[measure] > SIZE_FLOORS[measure]) {
      requires[measure] = sizes[measure];
    }
  }
  return (Object.keys(requires).length === 0) ? undefined : requires;
}

/**
 * Indicates whether this package meets `requires`: that it constructs each
 * flavor named, which it does for exactly the flavors a `FabricRegExp` can
 * give a JavaScript `RegExp` of, and that its guarantee by each measure named
 * is at least the size named.
 */
export function meetsRequirements(
  requires: FixtureRequirements | undefined,
): boolean {
  if (requires === undefined) {
    return true;
  }
  const constructs = (flavor: string) => {
    try {
      new FabricRegExp(flavor, "", "").value;
      return true;
    } catch {
      return false;
    }
  };
  return (requires.flavors ?? []).every(constructs) &&
    SIZE_MEASURES.every((measure) =>
      (requires[measure] ?? 0) <= SIZE_GUARANTEES[measure]
    );
}

/**
 * Returns the size by each measure of the value `stated` writes, as
 * `3-json-encoding.md` section 12 measures it, read from the text: the longest
 * array, a `/hole` run counting every hole it stands for; the largest record,
 * any object in the JSON body counting; the longest string, byte sequence and
 * registered symbol's key; and the depth. Each is zero for a text that is not
 * `fvj1:` JSON.
 */
function sizesOf(
  { text, unclaimed = [] }: TextWithMods,
): { [Measure in SizeMeasure]: number } {
  const largest = {
    arrayLength: 0,
    propertyCount: 0,
    stringLength: 0,
    bytesLength: 0,
    symbolKeyLength: 0,
    depth: 0,
  };
  const note = (measure: SizeMeasure, size: number) => {
    largest[measure] = Math.max(largest[measure], size);
  };

  let body: unknown;
  try {
    body = JSON.parse(JsonCodecEngine.unwrapEncodedValueForTesting(text, true));
  } catch {
    return largest;
  }

  // Each visit is given the count of containers enclosing what it visits.
  // `literal` is set within a `/quote`, where nothing is a tag or a hole run.
  const visit = (node: unknown, depth: number, literal: boolean): void => {
    if (typeof node === "string") {
      note("stringLength", codePointCountOf(node));
    } else if (Array.isArray(node)) {
      note("depth", depth + 1);
      let length = 0;
      for (const entry of node) {
        const holes = literal ? undefined : holeCountOf(entry);
        if (holes === undefined) {
          visit(entry, depth + 1, literal);
          length++;
        } else {
          length += holes;
        }
      }
      note("arrayLength", length);
    } else if (typeof node === "object" && node !== null) {
      const members = Object.entries(node);
      const [sole, ...others] = members;
      if (literal || sole === undefined || others.length !== 0) {
        visitRecord(members, depth, literal);
        return;
      }
      const [key, held] = sole;
      if (!key.startsWith("/")) {
        visitRecord(members, depth, literal);
      } else if (key === `/${CODEC_META_TAGS.object}`) {
        // The escaped record's keys are literal, and its values are not.
        if (typeof held === "object" && held !== null && !Array.isArray(held)) {
          visitRecord(Object.entries(held), depth, false);
        } else {
          visit(held, depth, false);
        }
      } else if (key === `/${CODEC_META_TAGS.quote}`) {
        visit(held, depth, true);
      } else if (key === `/${CODEC_META_TAGS.hole}`) {
        // A run of holes outside an array, which is malformed.
      } else if (
        PRIMITIVE_TAGS.has(key.slice(1)) && !unclaimed.includes(key.slice(1))
      ) {
        measurePrimitiveState(key.slice(1), held, note);
      } else {
        // An instance, its state enclosed by it.
        note("depth", depth + 1);
        visit(held, depth + 1, false);
      }
    }
  };
  const visitRecord = (
    members: readonly (readonly [string, unknown])[],
    depth: number,
    literal: boolean,
  ) => {
    note("depth", depth + 1);
    note("propertyCount", members.length);
    for (const [key, held] of members) {
      note("stringLength", codePointCountOf(key));
      visit(held, depth + 1, literal);
    }
  };

  visit(body, 0, false);
  return largest;
}

/**
 * Notes the sizes of what the state of a primitive under `tag` holds: the
 * bytes a base64url state or field writes, a registered symbol's key, and any
 * other string.
 */
function measurePrimitiveState(
  tag: string,
  state: unknown,
  note: (measure: SizeMeasure, size: number) => void,
): void {
  const fieldOf = (name: string): unknown =>
    (typeof state === "object" && state !== null)
      ? Object.getOwnPropertyDescriptor(state, name)?.value
      : undefined;
  const noteBytes = (written: unknown) => {
    if (typeof written === "string") {
      note(
        "bytesLength",
        Math.floor(written.replace(/=+$/, "").length * 3 / 4),
      );
    }
  };
  const noteString = (written: unknown) => {
    if (typeof written === "string") {
      note("stringLength", codePointCountOf(written));
    }
  };

  switch (tag) {
    case CODEC_TYPE_TAGS.Bytes:
      noteBytes(state);
      break;
    case CODEC_TYPE_TAGS.Hash:
      noteString(fieldOf("tag"));
      noteBytes(fieldOf("hash"));
      break;
    case CODEC_TYPE_TAGS.KeyPair:
      noteString(fieldOf("algorithm"));
      noteBytes(fieldOf("publicKey"));
      noteBytes(fieldOf("privateKey"));
      break;
    case CODEC_TYPE_TAGS.Symbol:
      if (typeof state === "string") {
        note("symbolKeyLength", codePointCountOf(state));
      }
      break;
    case CODEC_TYPE_TAGS.BigInt:
    case CODEC_TYPE_TAGS.DurationDay:
    case CODEC_TYPE_TAGS.DurationNsec:
    case CODEC_TYPE_TAGS.EpochDay:
    case CODEC_TYPE_TAGS.EpochNsec:
    case CODEC_TYPE_TAGS.SpecialNumber:
    case CODEC_TYPE_TAGS.Undefined:
      // A number, written as a string or not at all.
      break;
    default:
      noteString(state);
      if (typeof state === "object" && state !== null) {
        Object.values(state).forEach(noteString);
      }
  }
}

/**
 * Returns the count of Unicode code points in `text`, a lone surrogate
 * counting as one, as `3-json-encoding.md` section 12 counts them.
 */
function codePointCountOf(text: string): number {
  let count = 0;
  for (const _ of text) {
    count++;
  }
  return count;
}

/**
 * Returns the count of holes `entry`, an array entry, stands for, or
 * `undefined` where it is not a well-formed `/hole` run.
 */
function holeCountOf(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  const [member, ...others] = Object.entries(entry);
  if (member === undefined || others.length !== 0) {
    return undefined;
  }
  const [key, count] = member;
  return (key === `/${CODEC_META_TAGS.hole}` && typeof count === "number" &&
      Number.isInteger(count) && count > 0)
    ? count
    : undefined;
}

//
// Texts and mods
//

/**
 * Returns `value` written as an `fvj1:` text and the mods to decoding it,
 * which {@link fabricValueOfTextWithMods} reads back. The text is the value's
 * canonical text, as sections 10 and 11 of `3-json-encoding.md` define it:
 * what {@link plainJsonTextOf} writes, for a value it writes a text for, and
 * otherwise this package's encoding with its record keys put in the UTF-8
 * order section 10 requires. The first of those covers a record holding a key
 * this package's encoder reserves.
 *
 * What no text carries is written as `null`, with a patch putting it there: a
 * cycle, where it closes, and a symbol of no registry key. An `UnknownValue`
 * under a tag one of this package's classes claims has that tag in
 * `unclaimed`. The walk finding these passes through arrays, records and the
 * fields of instances, by the paths `test/fixtures/value-probes.md` defines,
 * so that a cycle may pass through or close at an instance. Nor does a text
 * carry how a value was built: sharing, a `NaN`'s bits, bytes viewed through
 * part of a larger buffer.
 *
 * @throws If the walk reaches an `UnknownValue` under one of the tags the
 *   format itself decides, which no codec can be left out for, so that no text
 *   and mods write it; or what this package's JSON encoder throws, refusing
 *   `value` with those replaced.
 */
export function textWithModsOf(value: FabricValue): TextWithMods {
  const patches: ValuePatch[] = [];
  const unknownTags = new Set<string>();
  const replaced = replaceUntextual(value, [], [], patches, unknownTags);
  const formatOwn = createBaseJsonRegistry();
  const unclaimed = [...unknownTags]
    .filter((tag) => {
      if (formatOwn.codecFromTag(tag) !== undefined) {
        throw new Error(
          `No text and mods write an unknown value under ${tag}, a tag the ` +
            "format itself decides.",
        );
      }
      return classesClaiming(tag).length > 0;
    })
    .sort(utf8Compare);
  return {
    text: plainJsonTextOf(replaced) ??
      textInKeyOrderOf(jsonFromFabricValue(replaced)),
    ...(unclaimed.length === 0 ? {} : { unclaimed }),
    ...(patches.length === 0 ? {} : { patches }),
  };
}

/**
 * Helper for {@link textWithModsOf}, which returns `value` with what no text
 * carries replaced by `null`, adding to `patches` one putting each back, and
 * to `unknownTags` the tag of each `UnknownValue` reached. `path` leads to
 * `value`, and `enclosing` holds the arrays, records and instances along it,
 * outermost first. Each array, record and instance is copied, so that `value`
 * itself is left as it is.
 */
function replaceUntextual(
  value: FabricValue,
  path: ValuePath,
  enclosing: readonly FabricValue[],
  patches: ValuePatch[],
  unknownTags: Set<string>,
): FabricValue {
  if (typeof value === "symbol" && Symbol.keyFor(value) === undefined) {
    const { description } = value;
    patches.push({
      at: path,
      put: {
        unregisteredSymbol: (description === undefined)
          ? null
          : fixtureStringOf(description),
      },
    });
    return null;
  } else if (value instanceof UnknownValue) {
    unknownTags.add(value.wireTypeTag);
  }

  const closes = enclosing.indexOf(value);
  if (closes >= 0) {
    patches.push({ at: path, put: { cycle: path.slice(0, closes) } });
    return null;
  }

  const inner = [...enclosing, value];
  const replaceAt = (step: PathStep, held: FabricValue) =>
    replaceUntextual(held, [...path, step], inner, patches, unknownTags);
  if (isFabricArray(value)) {
    const result: FabricValue[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      if (index in value) {
        result[index] = replaceAt(index, value[index]);
      }
    }
    return result;
  } else if (isFabricPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort(utf8Compare)) {
      defineOwn(result, key, replaceAt(fixtureStringOf(key), value[key]));
    }
    return result;
  }

  const fields = instanceFieldsOf(value);
  if (fields === undefined) {
    return value;
  }
  return instanceMadeOf(
    value,
    new Map(fields.map(([field, held]) => [field, replaceAt(field, held)])),
  );
}

/**
 * Returns the `fvj1:` text the spec gives `value`, when `value` is plain JSON
 * that needs no encoding: `null`, a boolean, a finite number other than
 * negative zero, a string, or an array or record of these, holding no hole and
 * no key starting with `/`. Returns `undefined` for anything else.
 *
 * This writes the text without the codec, its numbers and strings by
 * `JSON.stringify()`, whose rules section 11 adopts, and the value's own keys
 * sorted with `utf8Compare()`, the canonical comparator section 10 names, so
 * that the codec's text is held to a computation from the case rather than to
 * the codec's output or to text typed by hand.
 */
export function plainJsonTextOf(value: FabricValue): string | undefined {
  const body = plainJsonBodyOf(value, false);
  return (body === undefined)
    ? undefined
    : JsonCodecEngine.wrapEncodedValueForTesting(body, true);
}

/**
 * Returns `text`, an `fvj1:` text this package's encoder wrote, with every
 * record's keys put in UTF-8 order.
 */
function textInKeyOrderOf(text: string): string {
  const body = plainJsonBodyOf(
    JSON.parse(JsonCodecEngine.unwrapEncodedValueForTesting(text, true)),
    true,
  );
  if (body === undefined) {
    throw new Error(`Shouldn't happen: encoded text not JSON: ${text}`);
  }
  return JsonCodecEngine.wrapEncodedValueForTesting(body, true);
}

/**
 * Helper for {@link plainJsonTextOf} and {@link textInKeyOrderOf}, which
 * writes the JSON alone, with record keys in UTF-8 order. A key starting with
 * `/` makes the result `undefined`, the format escaping such a key, unless
 * `isWire` says `value` was read off the wire, where those keys are the
 * format's own.
 */
function plainJsonBodyOf(
  value: FabricValue,
  isWire: boolean,
): string | undefined {
  if (
    value === null || typeof value === "boolean" || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value) &&
      !Object.is(value, -0))
  ) {
    return JSON.stringify(value);
  }

  const parts: string[] = [];
  if (isFabricArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const part = (index in value)
        ? plainJsonBodyOf(value[index], isWire)
        : undefined;
      if (part === undefined) return undefined;
      parts.push(part);
    }
    return `[${parts.join(",")}]`;
  } else if (isFabricPlainObject(value)) {
    for (const key of Object.keys(value).sort(utf8Compare)) {
      const part = plainJsonBodyOf(value[key], isWire);
      if (part === undefined || (key.startsWith("/") && !isWire)) {
        return undefined;
      }
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `{${parts.join(",")}}`;
  }
  return undefined;
}

/**
 * Returns the value `stated` writes: its text decoded by this package's JSON
 * codec, as though no codec claimed the tags in `unclaimed`, with `patches`
 * made to the result, which is then deep-frozen. The inverse of
 * {@link textWithModsOf}, up to what no text carries.
 *
 * `unclaimed` is in UTF-8 order, naming each tag once. Each patch's path leads
 * through arrays, records and the fields of instances of the decoded text to a
 * `null`, and is followed before any patch is made, so that no path runs into
 * what a patch put. A cycle's path is a proper prefix of the path it is put at,
 * and leads to an array, a record or an instance.
 *
 * A patch is made in place where the value lets it be: in an array or a record,
 * in an error's `cause`, and among its extras. A link holds its payload frozen,
 * and an unknown or problematic value its state for good, so a patch there
 * replaces the instance with a new one, made in the place the old one held. The
 * patches that do that are made first, so that the others, which may put one of
 * those instances where a cycle closes, find it already made. Every patch is
 * then checked to hold once all are made, so that a value the patches cannot
 * build, such as a link whose payload holds the link itself, is refused.
 *
 * @throws What the codec throws, refusing the text; if a tag in `unclaimed` is
 *   out of order, named twice, or claimed by no class this package registers
 *   beyond the four the format itself decides; or if a patch breaks the rules
 *   above, two share a path, or a patch fails to hold once all are made.
 */
export function fabricValueOfTextWithMods(
  { text, unclaimed = [], patches = [] }: TextWithMods,
): FabricValue {
  const decoded = mutableEngineUnclaiming(unclaimed).decode(text);

  const patched = new Set<string>();
  const planned = patches.map(({ at, put }) => {
    const keys = at.map(stepKeyOf);
    const patchedKey = JSON.stringify(keys);
    if (patched.has(patchedKey)) {
      throw new Error(`Two patches at ${JSON.stringify(at)}`);
    }
    patched.add(patchedKey);

    const { holders, leaf } = followPath(decoded, keys);
    if (leaf !== null) {
      throw new Error(`No \`null\` to patch at ${JSON.stringify(at)}`);
    }
    const target = patchTargetOf(put, keys);
    if (target !== undefined) {
      containerAt(decoded, target);
    }
    return { at, keys, put, target, replaces: replacesHolder(holders, keys) };
  });

  let result = decoded;
  const ordered = [
    ...planned.filter(({ replaces }) => replaces),
    ...planned.filter(({ replaces }) => !replaces),
  ];
  for (const { keys, put, target } of ordered) {
    const { holders } = followPath(result, keys);
    const value = (target === undefined)
      ? symbolOf(put)
      : containerAt(result, target);
    result = putAt(result, holders, keys, keys.length - 1, value);
  }

  for (const { at, keys, put, target } of planned) {
    const { leaf } = followPath(result, keys);
    const holds = (target === undefined)
      ? (typeof leaf === "symbol" && Symbol.keyFor(leaf) === undefined &&
        leaf.description === symbolOf(put).description)
      : (leaf === containerAt(result, target));
    if (!holds) {
      throw new Error(
        `The patch at ${JSON.stringify(at)} does not hold once all are made.`,
      );
    }
  }
  return deepFreeze(result);
}

/**
 * Returns a JSON codec engine whose decodes are left mutable, over this
 * package's classes but those {@link classesClaiming} returns for a tag in
 * `unclaimed`.
 *
 * @throws If `unclaimed` is out of UTF-8 order, names a tag twice, or names
 *   one that no such class claims.
 */
function mutableEngineUnclaiming(
  unclaimed: readonly string[],
): JsonCodecEngine {
  unclaimed.forEach((tag, index) => {
    if (index > 0 && utf8Compare(unclaimed[index - 1]!, tag) >= 0) {
      throw new Error(
        `\`unclaimed\` not in order, each tag once: ${
          JSON.stringify(unclaimed)
        }`,
      );
    }
  });

  const leftOut = new Set<Constructor>();
  for (const tag of unclaimed) {
    const claiming = classesClaiming(tag);
    if (claiming.length === 0) {
      throw new Error(`No class to leave out claims ${tag}`);
    }
    for (const cls of claiming) leftOut.add(cls);
  }
  const kept = (cls: Constructor) => !leftOut.has(cls);
  const registry = createBaseJsonRegistry().extend(
    primitiveClasses().filter(kept),
    instanceClasses().filter(kept),
  );
  return new JsonCodecEngine({ registry, mutable: true });
}

/**
 * Returns the classes of this package's two rosters whose codecs claim `tag`
 * beyond what `createBaseJsonRegistry()` claims, that registry holding the
 * tags the format itself decides. Those are the classes a decode can leave
 * out, so that a value under `tag` decodes as an `UnknownValue`.
 */
function classesClaiming(tag: string): Constructor[] {
  const base = createBaseJsonRegistry();
  return [...primitiveClasses(), ...instanceClasses()].filter((cls) =>
    base.extend(cls).codecFromTag(tag) !== base.codecFromTag(tag)
  );
}

/**
 * Returns the property key a path step names: an array index as a number,
 * and a record key as a string.
 *
 * @throws If `step` is neither a number nor a fixture string.
 */
function stepKeyOf(step: FixtureJson): number | string {
  return (typeof step === "number") ? step : stringOf(step);
}

/**
 * The extras of an error, as a path steps through them: `["extras", key]`
 * reaches the extra under `key`.
 */
class ErrorExtras {
  /** The error whose extras these are. */
  readonly error: FabricError;

  /** Constructs an instance standing for the extras of `error`. */
  constructor(error: FabricError) {
    this.error = error;
  }
}

/** What a path step is taken from. */
type PathHolder = FabricValue | ErrorExtras;

/**
 * Returns what following the property keys `keys` from `root` reaches: what
 * each step was taken from, outermost first, and what the last step reaches.
 * A number steps into an array. A string steps into a record under that key,
 * or into an instance under the name of one of its fields, as
 * `test/fixtures/value-probes.md` gives them, an error's `extras` being
 * stepped through to the extra under the key that follows.
 *
 * @throws If a step names nothing what it is taken from holds, or is taken
 *   from anything else.
 */
function followPath(
  root: FabricValue,
  keys: readonly (number | string)[],
): { readonly holders: readonly PathHolder[]; readonly leaf: PathHolder } {
  const holders: PathHolder[] = [];
  let leaf: PathHolder = root;
  for (const key of keys) {
    const next = stepFrom(leaf, key);
    if (next === undefined) {
      throw new Error(
        `No path ${JSON.stringify(keys)} through arrays, records and ` +
          "instances",
      );
    }
    holders.push(leaf);
    leaf = next.held;
  }
  return { holders, leaf };
}

/**
 * Helper for {@link followPath}, which returns what the step `key` from
 * `holder` reaches, or `undefined` if it reaches nothing.
 */
function stepFrom(
  holder: PathHolder,
  key: number | string,
): { readonly held: PathHolder } | undefined {
  if (holder instanceof ErrorExtras) {
    return (typeof key === "string" && holder.error.hasExtra(key))
      ? { held: holder.error.getExtra(key) }
      : undefined;
  } else if (typeof key === "number") {
    return (isFabricArray(holder) && Object.hasOwn(holder, key))
      ? { held: holder[key] }
      : undefined;
  } else if (isFabricPlainObject(holder)) {
    return Object.hasOwn(holder, key) ? { held: holder[key] } : undefined;
  } else if (holder instanceof FabricError && key === "extras") {
    return { held: new ErrorExtras(holder) };
  }

  const field = instanceFieldsOf(holder)?.find(([name]) => name === key);
  return (field === undefined) ? undefined : { held: field[1] };
}

/**
 * Returns the path a patch's `put` names as where a cycle closes, or
 * `undefined` for a `put` that puts something else.
 *
 * @throws If `put` is not a patch's `put`, or a cycle's path is not a proper
 *   prefix of `keys`, the path the patch is put at.
 */
function patchTargetOf(
  put: FixtureJson,
  keys: readonly (number | string)[],
): (number | string)[] | undefined {
  const [kind, payload] = soleEntryOf(put);
  switch (kind) {
    case "cycle": {
      const cycleKeys = listOf(payload).map(stepKeyOf);
      if (
        !(cycleKeys.length < keys.length &&
          cycleKeys.every((key, index) => key === keys[index]))
      ) {
        throw new Error(
          `Not a proper prefix of the path a cycle is put at: ` +
            JSON.stringify(payload),
        );
      }
      return cycleKeys;
    }
    case "unregisteredSymbol": {
      return undefined;
    }
  }
  throw new Error(`Not a patch kind: ${kind}`);
}

/** Returns the symbol of no registry key that `put` puts. */
function symbolOf(put: FixtureJson): symbol {
  const [, description] = soleEntryOf(put);
  return (description === null) ? Symbol() : Symbol(stringOf(description));
}

/**
 * Returns the array, record or instance at the path `keys` from `root`.
 *
 * @throws If the path reaches nothing, or something else.
 */
function containerAt(
  root: FabricValue,
  keys: readonly (number | string)[],
): FabricValue {
  const { leaf } = followPath(root, keys);
  if (
    !(leaf instanceof ErrorExtras) &&
    (isFabricArray(leaf) || isFabricPlainObject(leaf) ||
      instanceFieldsOf(leaf) !== undefined)
  ) {
    return leaf;
  }
  throw new Error(
    `No array, record or instance at ${JSON.stringify(keys)} for a cycle to ` +
      "close at",
  );
}

/**
 * Indicates whether putting a value at the end of a path, which steps from
 * `holders` by `keys`, replaces what the last step was taken from: a link
 * whose payload it is put in, or an instance other than an error.
 */
function replacesHolder(
  holders: readonly PathHolder[],
  keys: readonly (number | string)[],
): boolean {
  const last = holders.length - 1;
  const holder = holders[last];
  return (last > 0 && holders[last - 1] instanceof FabricLink &&
    keys[last - 1] === "payload") ||
    (!(holder instanceof FabricError) && !(holder instanceof ErrorExtras) &&
      !isFabricArray(holder) && !isFabricPlainObject(holder));
}

/**
 * Returns `root` with `value` put where the step `keys[index]` from
 * `holders[index]` leads, `holders` being what each step of `keys` is taken
 * from. That is done in place where the holder lets it be, and otherwise by
 * putting a new holder, made with `value` in it, where the old one was, and
 * so on outward. `index` being `-1` puts `value` in place of `root`.
 *
 * @throws If the step names a field of an error other than `cause`, which no
 *   text holds `null` in.
 */
function putAt(
  root: FabricValue,
  holders: readonly PathHolder[],
  keys: readonly (number | string)[],
  index: number,
  value: FabricValue,
): FabricValue {
  if (index < 0) {
    return value;
  }

  const holder = holders[index]!;
  const key = keys[index]!;
  if (holder instanceof ErrorExtras) {
    holder.error.setExtra(String(key), value);
    return root;
  } else if (holder instanceof FabricError) {
    if (key !== "cause") {
      // The other fields are strings, which the codec never decodes to `null`.
      throw new Error(`Shouldn't happen: a patch at an error's \`${key}\``);
    }
    holder.cause = value;
    return root;
  } else if (
    index > 0 && holders[index - 1] instanceof FabricLink &&
    keys[index - 1] === "payload" && isFabricPlainObject(holder)
  ) {
    // A link holds its payload frozen, so the link is made again, with a
    // copy of the payload holding `value`. The copy stands in for the old
    // payload wherever that held itself, and is frozen so that the link keeps
    // the copy rather than a copy of it.
    const payload = {};
    const copied = (held: FabricValue) => (held === holder) ? payload : held;
    for (const payloadKey of Object.keys(holder)) {
      defineOwn(payload, payloadKey, copied(holder[payloadKey]));
    }
    defineOwn(payload, key, copied(value));
    Object.freeze(payload);
    return putAt(root, holders, keys, index - 2, new FabricLink(payload));
  } else if (isFabricArray(holder) || isFabricPlainObject(holder)) {
    defineOwn(holder, key, value);
    return root;
  }

  const fields = new Map(instanceFieldsOf(holder));
  fields.set(String(key), value);
  return putAt(root, holders, keys, index - 1, instanceMadeOf(holder, fields));
}

/**
 * Defines `key` on `target` as an ordinary property holding `value`, so that
 * a key such as `__proto__` is an own property rather than a write to the
 * prototype.
 */
function defineOwn(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

//
// Probes
//

/**
 * Returns the probes of `value`: a special form for each array, record and
 * instance, before the probes of what it holds; a hole run for each maximal
 * run of holes in an array, at its first index; and the canonical `fvj1:`
 * text of each leaf, as {@link textWithModsOf} writes it. An array's elements
 * and hole runs come in index order, a record's keys in UTF-8 order, and an
 * instance's fields in the order `test/fixtures/value-probes.md` gives. There
 * is no probe at or under a path a patch in `patches` states, no text carrying
 * what a patch puts there.
 *
 * @throws If `value` holds a cycle or a symbol of no registry key at a path no
 *   patch names, either of which no probe states; a map or a set, whose codecs
 *   are stubs; or a leaf this package's JSON encoder refuses.
 */
export function probesOf(
  value: FabricValue,
  patches: readonly ValuePatch[] = [],
): ValueProbe[] {
  const probes: ValueProbe[] = [];
  walkProbed(value, patches, ({ path, expected }) => {
    probes.push([path, expected]);
  });
  return probes;
}

/**
 * Returns the path of each node of `value` that {@link probesOf} gives a
 * probe when given no patches, and for which `test` returns `true`, in the
 * order of the probes.
 *
 * @throws What {@link probesOf} throws.
 */
export function probedPathsOf(
  value: FabricValue,
  test: (node: FabricValue) => boolean,
): ValuePath[] {
  const paths: ValuePath[] = [];
  walkProbed(value, [], (probe) => {
    if ("node" in probe && test(probe.node)) {
      paths.push(probe.path);
    }
  });
  return paths;
}

/**
 * One probe {@link walkProbed} visits, with the node it is of, which a hole
 * run lacks.
 */
type VisitedProbe = {
  readonly path: ValuePath;
  readonly expected: string | ProbeForm;
  readonly node?: FabricValue;
};

/**
 * Helper for {@link probesOf} and {@link probedPathsOf}, which calls `visit`
 * with each probe of `value` they give, in their order.
 */
function walkProbed(
  value: FabricValue,
  patches: readonly ValuePatch[],
  visit: (probe: VisitedProbe) => void,
): void {
  const patched = new Set(
    patches.map(({ at }) => JSON.stringify(at.map(stepKeyOf))),
  );

  const walk = (
    node: FabricValue,
    path: ValuePath,
    enclosing: readonly FabricValue[],
  ): void => {
    if (patched.has(JSON.stringify(path.map(stepKeyOf)))) {
      return;
    } else if (enclosing.includes(node)) {
      throw new Error(`No probe for a cycle at ${JSON.stringify(path)}`);
    } else if (typeof node === "symbol" && Symbol.keyFor(node) === undefined) {
      throw new Error(
        `No probe for a symbol of no registry key at ${JSON.stringify(path)}`,
      );
    }

    const inner = [...enclosing, node];
    const walkAt = (step: PathStep, held: FabricValue) =>
      walk(held, [...path, step], inner);
    const fields = instanceFieldsOf(node);
    if (isFabricArray(node)) {
      visit({ path, expected: { array: node.length }, node });
      let index = 0;
      while (index < node.length) {
        if (index in node) {
          walkAt(index, node[index]);
          index++;
          continue;
        }
        const start = index;
        while (index < node.length && !(index in node)) {
          index++;
        }
        visit({ path: [...path, start], expected: { holes: index - start } });
      }
    } else if (isFabricPlainObject(node)) {
      const keys = Object.keys(node).sort(utf8Compare);
      visit({ path, expected: { record: keys.length }, node });
      for (const key of keys) {
        walkAt(fixtureStringOf(key), node[key]);
      }
    } else if (fields !== undefined) {
      const tag = jsonTagOf(node);
      visit({
        path,
        expected: (node instanceof UnknownValue)
          ? { unknown: tag }
          : { instance: tag },
        node,
      });
      for (const [field, held] of fields) {
        walkAt(field, held);
      }
    } else {
      visit({ path, expected: fragmentOf(node), node });
    }
  };

  walk(value, [], []);
}

/**
 * Returns the canonical `fvj1:` text of `leaf`, a value that is not an array,
 * a record or an instance, written on its own.
 *
 * @throws What this package's JSON encoder throws, refusing `leaf`.
 */
function fragmentOf(leaf: FabricValue): string {
  const { text, unclaimed, patches } = textWithModsOf(leaf);
  if (unclaimed !== undefined || patches !== undefined) {
    throw new Error("Shouldn't happen: a leaf whose text needs mods.");
  }
  return text;
}

/** A field of an instance, as probes name it, and the value it holds. */
type InstanceField = readonly [string, FabricValue];

/**
 * How the fields of one class's instances are found, and how an instance is
 * made from them. `cls` is there for its type, which ties the entry to the
 * class it is keyed under in {@link INSTANCE_FIELDS}.
 */
interface InstanceFields<Class> {
  readonly cls: Class;

  /**
   * The fields of `value`, in the order their probes take, or `undefined` if
   * it is not of this class.
   */
  readonly fieldsOf: (value: FabricValue) => InstanceField[] | undefined;

  /**
   * A new instance of this class whose fields are `fields`, each of which
   * `fieldsOf()` gives `like`, given `like` of this class, or `undefined`
   * given anything else.
   */
  readonly made: (
    like: FabricValue,
    fields: ReadonlyMap<string, FabricValue>,
  ) => FabricValue | undefined;
}

/**
 * Returns how the fields of instances of `cls` are found, `fieldsOfInstance`
 * returning those of one instance, and `madeOf` making a new one like
 * `like` from fields.
 */
function fielded<Class extends abstract new (...args: never) => object>(
  cls: Class,
  fieldsOfInstance: (value: InstanceType<Class>) => InstanceField[],
  madeOf: (
    like: InstanceType<Class>,
    fields: ReadonlyMap<string, FabricValue>,
  ) => InstanceType<Class>,
): InstanceFields<Class> {
  return {
    cls,
    fieldsOf: (value) =>
      isInstanceOf(cls, value) ? fieldsOfInstance(value) : undefined,
    made: (like, fields) =>
      isInstanceOf(cls, like) ? madeOf(like, fields) : undefined,
  };
}

/** Indicates whether `value` is an instance of `cls`. */
function isInstanceOf<Class extends abstract new (...args: never) => object>(
  cls: Class,
  value: unknown,
): value is InstanceType<Class> {
  return value instanceof cls;
}

/**
 * The fields of every concrete instance class, keyed the way the instance
 * class table keys the classes. Its type is what holds it complete. The
 * open-ended part of an instance is always one field holding a record, so
 * that its keys are probed as a record's are.
 */
const INSTANCE_FIELDS: {
  readonly [Name in keyof FabricInstanceClassesByName]: InstanceFields<
    FabricInstanceClassesByName[Name]
  >;
} = {
  FabricError: fielded(
    FabricError,
    (value) => {
      const extras = {};
      for (const [key, extra] of value.extraEntries()) {
        defineOwn(extras, key, extra);
      }
      return [
        ["type", value.type],
        ["name", value.name],
        ["message", value.message],
        ...(value.stack === undefined ? [] : [["stack", value.stack] as const]),
        ...(value.cause === undefined ? [] : [["cause", value.cause] as const]),
        ["extras", extras],
      ];
    },
    (_like, fields) =>
      new FabricError({
        type: stringField(fields, "type"),
        name: stringField(fields, "name"),
        message: stringField(fields, "message"),
        stack: fields.has("stack") ? stringField(fields, "stack") : undefined,
        cause: fields.get("cause"),
        extras: recordField(fields, "extras"),
      }),
  ),
  FabricLink: fielded(
    FabricLink,
    (value) => [["payload", value.payload]],
    (_like, fields) => new FabricLink(recordField(fields, "payload")),
  ),
  FabricMap: fielded(FabricMap, () => {
    throw new Error(`No fields for a map. ${STUB_CODEC_EXCLUSION}`);
  }, () => {
    throw new Error(`No fields for a map. ${STUB_CODEC_EXCLUSION}`);
  }),
  FabricSet: fielded(FabricSet, () => {
    throw new Error(`No fields for a set. ${STUB_CODEC_EXCLUSION}`);
  }, () => {
    throw new Error(`No fields for a set. ${STUB_CODEC_EXCLUSION}`);
  }),
  ProblematicValue: fielded(
    ProblematicValue,
    (value) => [
      ["tag", value.wireTypeTag],
      ["state", value.state],
      ["error", value.error],
    ],
    (_like, fields) =>
      new ProblematicValue(
        stringField(fields, "tag"),
        fields.get("state"),
        stringField(fields, "error"),
      ),
  ),
  UnknownValue: fielded(
    UnknownValue,
    (value) => [["state", value.state]],
    (like, fields) => new UnknownValue(like.wireTypeTag, fields.get("state")),
  ),
};

/**
 * Returns the string `fields` holds under `name`.
 *
 * @throws If it holds anything else there.
 */
function stringField(
  fields: ReadonlyMap<string, FabricValue>,
  name: string,
): string {
  const held = fields.get(name);
  if (typeof held !== "string") {
    throw new Error(`Field \`${name}\` not a string: ${String(held)}`);
  }
  return held;
}

/**
 * Returns the record `fields` holds under `name`.
 *
 * @throws If it holds anything else there.
 */
function recordField(
  fields: ReadonlyMap<string, FabricValue>,
  name: string,
): FabricPlainObject {
  const held = fields.get(name);
  if (!isFabricPlainObject(held)) {
    throw new Error(`Field \`${name}\` not a record`);
  }
  return held;
}

/**
 * Returns a new instance like `like`, an instance of a class
 * {@link INSTANCE_FIELDS} names, whose fields are `fields`.
 */
function instanceMadeOf(
  like: FabricValue,
  fields: ReadonlyMap<string, FabricValue>,
): FabricValue {
  for (const entry of Object.values(INSTANCE_FIELDS)) {
    const made = entry.made(like, fields);
    if (made !== undefined) {
      return made;
    }
  }
  throw new Error("Shouldn't happen: not an instance with fields.");
}

/**
 * Returns the fields of `value`, in the order their probes take, or
 * `undefined` if it is not an instance.
 */
function instanceFieldsOf(value: FabricValue): InstanceField[] | undefined {
  for (const entry of Object.values(INSTANCE_FIELDS)) {
    const fields = entry.fieldsOf(value);
    if (fields !== undefined) {
      return fields;
    }
  }
  return undefined;
}

/**
 * Returns the wire tag this package's JSON codec writes `value` under.
 *
 * @throws If no codec in this package's registry writes `value` under a tag.
 */
function jsonTagOf(value: FabricValue): string {
  const codec = createDefaultJsonRegistry().codecFromValue(value);
  if (codec === undefined || typeof codec !== "object") {
    throw new Error("Shouldn't happen: no codec writes the value under a tag.");
  }
  return codec.tagForValue(value);
}

//
// JSON
//

/**
 * Returns a string as a fixture writes it: the string itself when it is well
 * formed, and its UTF-16 code units when it holds a lone surrogate, which not
 * every JSON reader keeps.
 */
function fixtureStringOf(value: string): FixtureString {
  return value.isWellFormed()
    ? value
    : { utf16: Array.from(value, (_, i) => value.charCodeAt(i)) };
}

/** Returns the string a fixture's string writes. */
function stringOf(json: FixtureJson): string {
  if (typeof json === "string") {
    return json;
  }
  const [kind, units] = soleEntryOf(fieldsOf(json));
  if (kind !== "utf16") {
    throw new Error(`Not a fixture string: ${JSON.stringify(json)}`);
  }
  return listOf(units).map((unit) => {
    if (
      !(typeof unit === "number" && Number.isInteger(unit) && unit >= 0 &&
        unit <= 0xffff)
    ) {
      throw new Error(`Not a code unit: ${JSON.stringify(unit)}`);
    }
    return String.fromCharCode(unit);
  }).join("");
}

/**
 * Returns the bytes `hex` writes in lowercase hexadecimal.
 *
 * @throws If `hex` is not lowercase hexadecimal, two digits to a byte.
 */
export function bytesOfHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new Error(`Not lowercase hexadecimal bytes: ${hex}`);
  }
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

/** Returns `bytes` as lowercase hexadecimal. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns `json` as a list, throwing if it is not one. */
function listOf(json: FixtureJson): readonly FixtureJson[] {
  if (!isList(json)) {
    throw new Error(`Not a list: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Indicates whether `json` is a list. `Array.isArray()` narrows to a
 * mutable array, which leaves a read-only one in the other branch.
 */
function isList(
  json: FixtureJson,
): json is readonly FixtureJson[] {
  return Array.isArray(json);
}

/** Returns `json` as a JSON object, throwing if it is not one. */
function fieldsOf(
  json: FixtureJson,
): { readonly [key: string]: FixtureJson } {
  if (json === null || typeof json !== "object" || isList(json)) {
    throw new Error(`Not an object: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Returns the one key and value of `json`, throwing unless one. */
function soleEntryOf(
  json: FixtureJson,
): readonly [string, FixtureJson] {
  const entries = Object.entries(fieldsOf(json));
  const [entry] = entries;
  if (entry === undefined || entries.length > 1) {
    throw new Error(`Not a single-key object: ${JSON.stringify(json)}`);
  }
  return entry;
}
