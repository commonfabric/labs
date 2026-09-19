import {
  areDebugRenderersInstalled,
  toCompactDebugString,
} from "@/value-debug";

/**
 * The runtime root of the two special-object classes, `FabricInstance` and
 * `FabricPrimitive`: the one class both extend, so that a single `instanceof`
 * recognizes either. Its one member is the custom inspector, and it carries no
 * brand. It is not a type a caller names: the pattern-visible
 * `FabricSpecialObject` in `api.ts` is the union of the two subclasses, and
 * `isFabricSpecialObject()` in `types/narrowing.ts` is the check, narrowing to
 * that union. The data model defines no other subclass, and an instance of one
 * defined elsewhere is not a `FabricValue`.
 *
 * This module's one import is of `value-debug-internal.ts`, which itself
 * imports nothing at run time. That is what lets `interface.ts` extend the two
 * protocol classes from this one while every other module, `value-debug`
 * among them, keeps importing `interface.ts` without a circular load-time
 * dependency.
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
