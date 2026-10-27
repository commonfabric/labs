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

import type {
  FabricArray,
  FabricPlainObject,
  FabricValue,
} from "@/interface.ts";
import { ProblematicValue, UnknownValue } from "@/codec-common";
import { createBaseJsonRegistry, JsonCodecEngine } from "@/codec-json";
import { deepFreeze } from "@/deep-freeze.ts";
import {
  FabricError,
  type FabricInstanceClassesByName,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@/fabric-instances";
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
   * What is put there: the array or record at the path `cycle`, which closes
   * a cycle, or a symbol of no registry key, under its description, `null`
   * being none.
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
 * `unclaimed`. The walk finding these passes through arrays and records and
 * stops at every instance, so whatever an instance holds is left for the
 * encoder to write or to refuse. Nor does a text carry how a value was built:
 * sharing, a `NaN`'s bits, bytes viewed through part of a larger buffer.
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
 * `value`, and `enclosing` holds the arrays and records along it, outermost
 * first.
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
    return value;
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
  return value;
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
 * through arrays and records of the decoded text to a `null`, and is followed
 * before any patch is made, so that no path runs into what a patch put. A
 * cycle's path is a proper prefix of the path it is put at.
 *
 * @throws What the codec throws, refusing the text; if a tag in `unclaimed` is
 *   out of order, named twice, or claimed by no class this package registers
 *   beyond the four the format itself decides; or if a patch breaks the rules
 *   above, or two share a path.
 */
export function fabricValueOfTextWithMods(
  { text, unclaimed = [], patches = [] }: TextWithMods,
): FabricValue {
  const decoded = mutableEngineUnclaiming(unclaimed).decode(text);

  const patched = new Set<string>();
  const puts = patches.map(({ at, put }) => {
    const keys = at.map(stepKeyOf);
    const patchedKey = JSON.stringify(keys);
    if (patched.has(patchedKey)) {
      throw new Error(`Two patches at ${JSON.stringify(at)}`);
    }
    patched.add(patchedKey);

    const { containers, leaf } = followPath(decoded, keys);
    if (leaf !== null) {
      throw new Error(`No \`null\` to patch at ${JSON.stringify(at)}`);
    }
    return { keys, containers, value: patchValueOf(put, keys, containers) };
  });

  let result = decoded;
  for (const { keys, containers, value } of puts) {
    const last = keys.length - 1;
    if (last < 0) {
      result = value;
    } else {
      defineOwn(containers[last]!, keys[last]!, value);
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
 * Returns what following the property keys `keys` from `root` reaches: the
 * arrays and records stepped through, outermost first, and the value at the
 * end. A number steps into an array, and a string into a record.
 *
 * @throws If a step names nothing its array or record holds, or is taken from
 *   anything else.
 */
function followPath(
  root: FabricValue,
  keys: readonly (number | string)[],
): {
  readonly containers: readonly (FabricArray | FabricPlainObject)[];
  readonly leaf: FabricValue;
} {
  const containers: (FabricArray | FabricPlainObject)[] = [];
  let leaf = root;
  for (const key of keys) {
    if (
      typeof key === "number" && isFabricArray(leaf) && Object.hasOwn(leaf, key)
    ) {
      containers.push(leaf);
      leaf = leaf[key];
    } else if (
      typeof key === "string" && isFabricPlainObject(leaf) &&
      Object.hasOwn(leaf, key)
    ) {
      containers.push(leaf);
      leaf = leaf[key];
    } else {
      throw new Error(
        `No path ${JSON.stringify(keys)} through arrays and records`,
      );
    }
  }
  return { containers, leaf };
}

/**
 * Returns the value `put` says a patch at the path `keys` puts there, where
 * `containers` holds the arrays and records the path steps through.
 *
 * @throws If `put` is not a patch's `put`, or a cycle's path is not a proper
 *   prefix of `keys`.
 */
function patchValueOf(
  put: FixtureJson,
  keys: readonly (number | string)[],
  containers: readonly (FabricArray | FabricPlainObject)[],
): FabricValue {
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
      return containers[cycleKeys.length]!;
    }
    case "unregisteredSymbol": {
      return (payload === null) ? Symbol() : Symbol(stringOf(payload));
    }
  }
  throw new Error(`Not a patch kind: ${kind}`);
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
 * How the fields of one class's instances are found. `cls` is there for its
 * type, which ties the entry to the class it is keyed under in
 * {@link INSTANCE_FIELDS}.
 */
interface InstanceFields<Class> {
  readonly cls: Class;

  /**
   * The fields of `value`, in the order their probes take, or `undefined` if
   * it is not of this class.
   */
  readonly fieldsOf: (value: FabricValue) => InstanceField[] | undefined;
}

/**
 * Returns how the fields of instances of `cls` are found, `fieldsOfInstance`
 * returning those of one instance.
 */
function fielded<Class extends abstract new (...args: never) => object>(
  cls: Class,
  fieldsOfInstance: (value: InstanceType<Class>) => InstanceField[],
): InstanceFields<Class> {
  return {
    cls,
    fieldsOf: (value) =>
      isInstanceOf(cls, value) ? fieldsOfInstance(value) : undefined,
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
  FabricError: fielded(FabricError, (value) => {
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
  }),
  FabricLink: fielded(FabricLink, (value) => [["payload", value.payload]]),
  FabricMap: fielded(FabricMap, () => {
    throw new Error(`No probe for a map. ${STUB_CODEC_EXCLUSION}`);
  }),
  FabricSet: fielded(FabricSet, () => {
    throw new Error(`No probe for a set. ${STUB_CODEC_EXCLUSION}`);
  }),
  ProblematicValue: fielded(ProblematicValue, (value) => [
    ["tag", value.wireTypeTag],
    ["state", value.state],
    ["error", value.error],
  ]),
  UnknownValue: fielded(UnknownValue, (value) => [["state", value.state]]),
};

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
