import { FABRIC_PRIMITIVE_CODEC_TYPE_TAGS } from "@/fabric-primitives/interface.ts";

/**
 * Canonical tags for value types, in `<Type>@<Version>` form. This is collected
 * here for ease of reference. It is in the form of a frozen `const` to help
 * prevent inadvertent skew.
 */
export const CODEC_TYPE_TAGS = Object.freeze(
  {
    // Tags for JavaScript primitives that aren't representable in JSON. These
    // tags are for wire formats that are layered on top of JSON and so require
    // _some_ way of indicating non-JSON-compatible values.

    /** Constant representing JavaScript type `bigint`. */
    BigInt: "BigInt@1",

    /**
     * Constant representing JavaScript type `number`, specifically for
     * representing numeric values not supported by JSON.
     */
    SpecialNumber: "SpecialNumber@1",

    /** Constant representing JavaScript type `symbol`. */
    Symbol: "Symbol@1",

    /** Constant representing JavaScript type `undefined`. */
    Undefined: "Undefined@1",

    // Tags for the built-in "primitive" `FabricPrimitive` classes, which are
    // defined beside those classes.
    ...FABRIC_PRIMITIVE_CODEC_TYPE_TAGS,

    // Tags for the primary versions built-in non-primitive `FabricInstance`
    // classes, specifically the tags used to _encode_ instances from a live
    // system. This is as opposed to the tags used for versions of the (in some
    // sense) "same" classes which are recognized for _decoding_ only (and which
    // get decoded into the corresponding primary versions).

    /** Constant for class `FabricError`. */
    Error: "Error@1",

    /** Constant for class `ProblematicValue`. */
    Problematic: "Problematic@1",

    /** Constant for class `FabricLink`. */
    Link: "Link@1",

    /** Constant for class `FabricMap`. */
    Map: "Map@1",

    /** Constant for class `FabricSet`. */
    Set: "Set@1",

    // Tags for non-primary versions of built-in non-primitive classes. These
    // generally correspond to _older_ encoded forms. The property names of
    // these constants encode the versions of the corresponding classes (e.g.,
    // `MapV2`), unlike the property names in the other sections.
    //
    // As of this writing, there are none of these, so this section is empty
    // except for an example, waiting patiently for a glorious future where this
    // system needs to support data migration.

    /** Example version-2 constant. */
    ExampleV2: "Example@2",
  } as const,
);
