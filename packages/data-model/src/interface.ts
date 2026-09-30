/**
 * The two special-object classes, `FabricInstance` and `FabricPrimitive`, and
 * the conversion-layer types of the fabric data model, together with the
 * pattern-visible value types that `api.ts` declares, re-exported here so that
 * this module carries the whole `FabricValue` vocabulary. Its runtime imports
 * are two leaves that import nothing, `api.ts` for the brand symbols and the
 * module holding the classes' common root, so any module can import this one
 * without creating a circular dependency.
 *
 * The classes here and the declarations in `api.ts` describe the same shapes,
 * and `api-agreement.ts` stops compiling when they drift. The concrete classes
 * under `fabric-primitives/` and `fabric-instances/` carry the same kind of
 * guard, each beside its own definition.
 */

import type {
  FabricArrayPlus,
  FabricInstancePlus,
  FabricPlainObjectPlus,
  FabricPrimitiveSchemaType,
  FabricValuePlus,
} from "./api.ts";
import { FABRIC_INSTANCE_PLUS_BRAND, FABRIC_PRIMITIVE_BRAND } from "./api.ts";
import { BaseFabricSpecialObject } from "./fabric-bases/BaseFabricSpecialObject.ts";

// We re-`export` all the _types_ from `./api.ts`, so that they're consistently
// available internally to `data-model` without having to `import ... from
// "./api.ts"`.
export type * from "./api.ts";

//
// "Layer" types
//
// A layer type is a `FabricValue`-like type whose claim stops at the root
// container. As with the main definitions, these have both "pure" and
// `PlusType` variants, and the former is defined in terms of the latter, while
// also being primary in terms of documentation.
//

/**
 * Single "layer" of fabric validity: a `FabricValue`, or an array or plain
 * object root whose contents are untyped. Arrays and objects have the right
 * shape but their contents may not. As with `FabricValue`, the type system
 * requires deep immutability -- the type is deeply `readonly` -- while actual
 * deep-freezing happens only tactically.
 */
export type FabricValueLayer = FabricValuePlusLayer<never>;

/** A mutable array root whose elements remain `FabricValue`s. */
export type MutableFabricArrayLayer = MutableFabricArrayPlusLayer<never>;

/** A mutable record root whose values remain `FabricValue`s. */
export type MutableFabricPlainObjectLayer = MutableFabricPlainObjectPlusLayer<
  never
>;

/**
 * A `FabricContainerValue` with a mutable root. Nested containers remain
 * ordinary (readonly) `FabricValue`s, so this models a single construction
 * layer rather than a deep thaw. A `FabricInstance` arm passes through
 * unchanged: an instance's mutability is its own frozen state to report, not
 * something a type can layer over it.
 */
export type MutableFabricContainerValueLayer =
  MutableFabricContainerValuePlusLayer<never>;

/**
 * A `FabricValue` with a mutable root container. Nested containers remain
 * ordinary (readonly) `FabricValue`s, so this models a single construction
 * layer rather than a deep thaw.
 */
export type MutableFabricValueLayer = MutableFabricValuePlusLayer<never>;

/** `PlusType` equivalent of `FabricValueLayer`. */
export type FabricValuePlusLayer<PlusType> = FabricValuePlus<
  | PlusType
  | Readonly<unknown[] | Record<string, unknown>>
>;

/** `PlusType` equivalent of `MutableFabricArrayLayer`. */
export type MutableFabricArrayPlusLayer<PlusType> = FabricValuePlus<PlusType>[];

/** `PlusType` equivalent of `MutableFabricPlainObjectLayer`. */
export type MutableFabricPlainObjectPlusLayer<PlusType> = Record<
  string,
  FabricValuePlus<PlusType>
>;

/** `PlusType` equivalent of `MutableFabricContainerValueLayer`. */
export type MutableFabricContainerValuePlusLayer<PlusType> =
  | FabricInstancePlus<PlusType>
  | MutableFabricArrayPlusLayer<PlusType>
  | MutableFabricPlainObjectPlusLayer<PlusType>;

/** `PlusType` equivalent of `MutableFabricValueLayer`. */
export type MutableFabricValuePlusLayer<PlusType> =
  | Exclude<
    FabricValuePlus<PlusType>,
    FabricArrayPlus<PlusType> | FabricPlainObjectPlus<PlusType>
  >
  | MutableFabricArrayPlusLayer<PlusType>
  | MutableFabricPlainObjectPlusLayer<PlusType>;

//
// Abstract base classes
//
// The _class_ definitions corresponding to the _interface_ definitions in
// `api.ts` of `FabricInstance` and `FabricPrimitive`, the two special-object
// classes; `FabricSpecialObject` there is their union.
//

/**
 * Abstract base class for the `FabricValue`s that participate in the fabric
 * protocol as non-primitives. An instance may hold and expose arbitrary
 * outgoing `FabricValue` references, and is mutable until frozen.
 * `FabricSpecialObject` says how this differs from `FabricPrimitive`. See
 * Section 2.3 of the formal spec.
 *
 * This is the pure abstract protocol -- the `instanceof`-able contract that
 * external code is written against. Concrete `FabricInstance` classes in the
 * data-model extend `BaseFabricInstance` (a subclass of this one) rather
 * than this class directly; `BaseFabricInstance` is where shared
 * template-method scaffolding (such as `shallowClone()`) lives.
 *
 * An instance holds all of its state privately and makes it reachable only
 * through members, so it has no enumerable own properties. A structural view
 * of one -- a spread, `Object.keys()`, a naive walk -- therefore sees nothing.
 * Mutable state is exposed as an accessor pair over a private field, whose
 * setter is responsible for honoring the instance's frozen state:
 * `Object.freeze()` bears only on own properties and so cannot enforce that
 * on its own.
 *
 * Subclasses must implement `deepClone()` and `shallowClone()`; both are
 * normally inherited from `BaseFabricInstance` as template methods, with the
 * subclass supplying the symbol-keyed clone core each one calls. The
 * freeze-protocol members `[DEEP_FREEZE]()` and `[IS_DEEP_FROZEN]()` are
 * declared on `BaseFabricInstance`, not here: they are implementation plumbing
 * and are kept off this pure-protocol class.
 */
export abstract class FabricInstance extends BaseFabricSpecialObject {
  /**
   * The nominal brand that tells a `FabricInstance` from any other object with
   * the two clone methods, in the type system, at `never` since an instance of
   * this class holds only `FabricValue`s; the runtime root carries no brand,
   * so this member is what makes the class nominal. `declare` emits no runtime
   * member, and nothing ever reads the key. `api.ts` declares the identical
   * member, and `api-agreement.ts` stops compiling if the two stop agreeing.
   */
  declare readonly [FABRIC_INSTANCE_PLUS_BRAND]: never;

  /**
   * Returns a new deep clone of this instance with equivalent data but no
   * shared structure for any unfrozen data in the original. When `frozen ===
   * true`, produces a frozen instance with maximal structural sharing,
   * including returning `this` if it is already deep-frozen. When `frozen ===
   * false`, produces an instance which is mutable at every layer its class
   * lets change, and which has no visible shared reference structure with the
   * original.
   *
   * The concrete template-method implementation lives on `BaseFabricInstance`
   * (deferring to the `[DEEP_CLONE_CORE]` sibling, mirroring the
   * `shallowClone()`/`[SHALLOW_UNFROZEN_CLONE]()` split); this declaration just
   * pins the protocol surface so that callers can invoke it through a
   * `FabricInstance` reference.
   */
  abstract deepClone(frozen: boolean): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   * The concrete template-method implementation lives on
   * `BaseFabricInstance`; this declaration just pins the protocol surface so
   * that callers can invoke it through a `FabricInstance` reference.
   */
  abstract shallowClone(frozen: boolean): FabricInstance;
}

/**
 * Abstract base class for the `FabricValue`s that participate in the fabric
 * protocol as primitives: values that behave like primitives in the fabric
 * type system but are represented as class instances for type safety and
 * dispatch. Covers temporal types, content IDs, byte sequences, and similar.
 * `FabricSpecialObject` says how this differs from `FabricInstance`.
 *
 * This class enables a single `instanceof` check where code needs to handle
 * any `FabricPrimitive` uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable), pass
 * through the convertible-JS conversions unchanged, and hold no arbitrary
 * outgoing `FabricValue` reference. `BaseFabricPrimitive` freezes each instance
 * at construction; a subclass keeps its state in private fields, which the
 * freeze does not reach.
 *
 * See Section 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive extends BaseFabricSpecialObject {
  /**
   * The nominal brand that tells a `FabricPrimitive` from a `FabricInstance`
   * and from every other object, in the type system; without it this class is
   * structurally empty. `declare` emits no runtime member, and nothing ever
   * reads the key. `api.ts` declares the identical member, and
   * `api-agreement.ts` stops compiling if the two stop agreeing.
   */
  declare readonly [FABRIC_PRIMITIVE_BRAND]: true;

  /** Constructs an instance. */
  constructor() {
    super();
  }

  /**
   * Name of this instance's class in the schema `type` vocabulary: the `type`
   * a schema names to admit this value by its class. Every instance of a class
   * reports the same name, which need not be the name of the class. Each
   * concrete class supplies its own, and the getter reads no instance state,
   * so that it returns the same name when read off the class's `prototype`.
   */
  abstract get schemaType(): FabricPrimitiveSchemaType;
}

//
// Types for dealing with convertible JS (non-fabric, a/k/a "wild west") values
//

/**
 * Union of convertible JS **object** types that the fabric type system can
 * convert into `FabricInstance` wrappers or `FabricPrimitive` values. These are
 * the inputs to the "sausage grinder" --
 * `shallowFabricFromConvertibleJsValue()` accepts `unknown`, so callers can
 * hand it `FabricValue`s or convertible JS objects alike, and whatever it
 * cannot represent is rejected there rather than excluded by the signature. The
 * conversion produces `FabricInstance` wrappers or `FabricPrimitive` values
 * that live inside `FabricValue`.
 *
 * Note: `bigint` is NOT included here -- it is a primitive (like `undefined`)
 * and belongs directly in `FabricValue` without wrapping.
 *
 * `tags-agreement.ts` stops compiling when this and
 * `FABRIC_CONVERTIBLE_JS_OBJECT_TAGS` stop agreeing, and it reads each class
 * from its declared `prototype`, so a member here is written the way the
 * class's `prototype` is declared.
 */
export type FabricConvertibleJsObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | RegExp
  | Uint8Array;

/**
 * A `FabricValue`, a `FabricConvertibleJsObject`, or a deep tree thereof -- the
 * values that convert to and from fabric form. This is the precondition of
 * `fabricFromConvertibleJsValue()` (which fails on anything else), the result
 * of `convertibleJsFromFabricValue()`, and what
 * `isValidFabricConvertibleJsValue()` tests for.
 *
 * Distinct from `FabricValue`: containers here may hold
 * `FabricConvertibleJsObject`s. Converting a `FabricError` yields an `Error`,
 * so an array of them is an array of JS objects, which has no `FabricValue`
 * name.
 */
export type FabricConvertibleJsValue = FabricValuePlus<
  FabricConvertibleJsObject
>;
