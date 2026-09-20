// `interface.ts` extends its protocol classes from the class here, and nearly
// every module of the package imports `interface.ts`. So whatever this module
// imports has to import nothing at run time itself.
import {
  areDebugRenderersInstalled,
  toCompactDebugString,
} from "@/value-debug";

/**
 * The runtime root of the two special-object classes, `FabricInstance` and
 * `FabricPrimitive`: the one class both extend, so that a single `instanceof`
 * recognizes either. It carries no brand. It is not a type a caller names: the
 * pattern-visible `FabricSpecialObject` in `api.ts` is the union of the two
 * subclasses, and `isFabricSpecialObject()` in `types/narrowing.ts` is the
 * check, narrowing to that union. The data model defines no other subclass,
 * and an instance of one defined elsewhere is not a `FabricValue`.
 */
export abstract class BaseFabricSpecialObject {
  /**
   * Custom inspector: what `console.log()` and a debugger show for this value.
   * The result is the value's compact debug string, as `toCompactDebugString()`
   * renders it. Where the debug renderers are not installed, it is the name of
   * the value's class in square brackets.
   */
  [Symbol.for("Deno.customInspect")](): string {
    return areDebugRenderersInstalled()
      ? toCompactDebugString(this)
      : `[${this.constructor.name}]`;
  }
}
