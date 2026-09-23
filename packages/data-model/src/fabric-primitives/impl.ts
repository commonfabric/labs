/**
 * The set of concrete primitive classes, and everything that ranges over it
 * and can be derived from it: which classes travel over the wire, the names
 * in the schema `type` vocabulary, and which class each of those names stands
 * for.
 *
 * The set of classes is written out by hand rather than derived, because it
 * cannot be discovered by reflection. A class binds its codec under a wire
 * format's own symbol, so nothing here can name the symbol to look for without
 * naming a format. Adding a primitive therefore means editing this file, and
 * the set is built to fail loudly when it has not been.
 *
 * The tag vocabularies that range over the classes are in `interface.ts`.
 * Nothing here can join them: every class imports that module, so it can
 * import no class, and everything here needs the classes.
 */

import { backtickQuote } from "@commonfabric/utils/markdown";

import type { FabricPrimitiveSchemaType } from "@/api.ts";

import { FabricBytes } from "./FabricBytes.ts";
import { FabricEpochDay } from "./FabricEpochDay.ts";
import { FabricEpochNsec } from "./FabricEpochNsec.ts";
import { FabricHash } from "./FabricHash.ts";
import { FabricKeyPair } from "./FabricKeyPair.ts";
import { FabricRegExp } from "./FabricRegExp.ts";
import { FabricUnavailable } from "./FabricUnavailable.ts";

/**
 * The concrete primitive classes whose instances are available over the wire,
 * each via the codec it binds under a wire format's own symbol. This is the
 * curated source of truth for which primitive types participate in encoding:
 * add a class to the set once it binds a codec for every format that is built.
 *
 * Typed by class and not by codec, which is weaker than it looks: a
 * `FabricPrimitive` binds its codec under a wire format's own symbol, so a
 * type saying which symbol would name a format, and this list is meant to
 * serve all of them. A class here that binds no codec for the format in play
 * is refused by `CodecRegistry.registerClass()` when a registry is built.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricPrimitiveClass[] {
  return CODEC_CLASSES;
}

/**
 * The concrete primitive classes, each under the name `api.ts` declares it
 * by, which is the name a pattern binds it under. This is what spreads the
 * classes into a name-keyed table without listing them.
 *
 * Returned frozen so callers cannot mutate the shared record.
 */
export function fabricPrimitiveClassesByName(): FabricPrimitiveClassesByName {
  return CLASSES_BY_NAME;
}

/**
 * Returns the concrete primitive class whose instances report `type` as their
 * `.schemaType`. This is the inverse of reading `.schemaType` off an instance,
 * and is what ranges over the classes by schema type without listing them.
 *
 * @throws If no class reports `type`, which its declared type rules out.
 */
export function fabricPrimitiveClassOfSchemaType(
  type: FabricPrimitiveSchemaType,
): FabricPrimitiveClass {
  const result = CLASS_OF_SCHEMA_TYPE.get(type);
  if (result === undefined) {
    throw new Error(
      "Shouldn't happen: No `FabricPrimitive` class has schema type " +
        `${backtickQuote(type)}.`,
    );
  }
  return result;
}

/** Whether the given schema type names a `FabricPrimitive` class. */
export function isFabricPrimitiveSchemaType(
  type: string,
): type is FabricPrimitiveSchemaType {
  return CLASS_OF_SCHEMA_TYPE.has(type);
}

// The one place the set of classes is written out. The names are property
// keys, which a minifier that renames bindings leaves alone, where a class's
// own `.name` follows its renamed binding.
const CLASSES_BY_NAME = Object.freeze({
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  FabricUnavailable,
});

/**
 * The concrete primitive classes keyed by name. `schema-types-agreement.ts`
 * stops compiling when a class here fails to satisfy the constructor `api.ts`
 * declares under the same name.
 */
export type FabricPrimitiveClassesByName = typeof CLASSES_BY_NAME;

/**
 * One of the concrete primitive classes, as a class rather than an instance
 * of one. `schema-types-agreement.ts` stops compiling when the names these
 * report as `.schemaType` and `FabricPrimitiveSchemaType` stop agreeing, or
 * when two of these report the same name.
 */
export type FabricPrimitiveClass =
  FabricPrimitiveClassesByName[keyof FabricPrimitiveClassesByName];

const CODEC_CLASSES: readonly FabricPrimitiveClass[] = Object.freeze(
  Object.values(CLASSES_BY_NAME),
);

// Each name is read off its class's `prototype`. The contract of `.schemaType`
// is what makes that sound: the getter reads no instance state.
const CLASS_OF_SCHEMA_TYPE: ReadonlyMap<string, FabricPrimitiveClass> = new Map(
  CODEC_CLASSES.map((cls) => [cls.prototype.schemaType, cls]),
);

/**
 * Every `FabricPrimitiveSchemaType`, one entry per concrete class: the runtime
 * form of that type, and the value `api.ts` declares under this name.
 */
export const FABRIC_PRIMITIVE_SCHEMA_TYPES:
  readonly FabricPrimitiveSchemaType[] = Object.freeze(
    CODEC_CLASSES.map((cls) => cls.prototype.schemaType),
  );
