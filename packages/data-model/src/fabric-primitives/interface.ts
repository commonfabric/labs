/**
 * The vocabularies that range over the concrete primitive classes, one entry
 * per class in each: the tag a class reports to the `tagOf*()` dispatches, and
 * the tag its codec writes to the wire. They are nominally distinct from each
 * other and from the names the classes have in the schema `type` vocabulary,
 * and a class's entry in one need not match its entry in another. Adding a
 * primitive means adding to each, and they sit together so that one visit
 * does it.
 *
 * The schema `type` vocabulary is the one that is elsewhere, in `api.ts`. A
 * pattern compiles against that module, which can import nothing, and the
 * `FabricPrimitive` declaration there names the vocabulary's type.
 *
 * This module imports nothing, so that any module can import it without
 * creating a circular dependency. The classes themselves import it, which is
 * why the set of them, and what derives from it, is in `impl.ts` and not here.
 */

/**
 * The tags a `FabricPrimitive` reports, one per primitive class this package
 * defines. These are the only tags a `[VALUE_TAG]` getter may return, and the
 * only ones the primitive dispatch accepts from one.
 */
export const FABRIC_PRIMITIVE_VALUE_TAGS = Object.freeze(
  {
    FabricEpochNsec: "FabricEpochNsec",
    FabricEpochDay: "FabricEpochDay",
    FabricHash: "FabricHash",
    FabricBytes: "FabricBytes",
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
    FabricUnavailable: "FabricUnavailable",
  } as const,
);

/** One of the `FabricPrimitive` tag strings. */
export type FabricPrimitiveValueTag =
  typeof FABRIC_PRIMITIVE_VALUE_TAGS[keyof typeof FABRIC_PRIMITIVE_VALUE_TAGS];

/**
 * Canonical codec tags for the primitive classes, in `<Type>@<Version>` form.
 * These tags are for wire formats in which instances of (one or more of) these
 * classes have no protocol-specific form. `CODEC_TYPE_TAGS` includes them all.
 */
export const FABRIC_PRIMITIVE_CODEC_TYPE_TAGS = Object.freeze(
  {
    /** Constant for class `FabricBytes`. */
    Bytes: "Bytes@1",

    /** Constant for class `FabricEpochDay`. */
    EpochDay: "EpochDay@1",

    /** Constant for class `FabricEpochNsec`. */
    EpochNsec: "EpochNsec@1",

    /** Constant for class `FabricHash`. */
    Hash: "Hash@1",

    /** Constant for class `FabricKeyPair`. */
    KeyPair: "KeyPair@1",

    /** Constant for class `FabricRegExp`. */
    RegExp: "RegExp@1",

    /** Constant for class `FabricUnavailable`. */
    Unavailable: "Unavailable@1",
  } as const,
);
