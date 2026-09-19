// `interface.ts` extends its protocol classes from the class here, and nearly
// every module of the package imports `interface.ts`. So whatever this module
// imports has to import nothing at run time itself. `value-debug-internal.ts`,
// which is what `@/value-debug` names, is such a module.
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
   * Custom inspector, so that a `console.log()` or a debugger shows what this
   * value IS. The default rendering is `{}`: state lives in private fields,
   * which have no enumerable own properties for an inspector to find.
   *
   * Delegates to the canonical debug renderer rather than formatting here, so
   * that this surface improves whenever that one does. Where the renderers are
   * not installed, the result names the class and nothing more, an inspector
   * being the wrong place to throw from.
   */
  [Symbol.for("Deno.customInspect")](): string {
    return areDebugRenderersInstalled()
      ? toCompactDebugString(this)
      : `[${this.constructor.name}]`;
  }
}
