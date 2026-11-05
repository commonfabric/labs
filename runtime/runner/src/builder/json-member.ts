import type { FabricExecValue, toEncodableForm } from "./types.ts";

/**
 * The `toJSON` method, for use as a member of anything that carries a
 * `toEncodableForm`. `JSON.stringify` consults this name and no other.
 *
 * Both a module and its factory carry it. A factory because pattern source
 * holds one, so `JSON.stringify(someFactory)` has to keep working. A module
 * because `JSON.stringify` reaches one THROUGH A GRAPH: the internal graph
 * (`serializePatternGraph`) is the in-memory instantiation representation and
 * so holds live modules, whose `implementation` is a function. Absent this,
 * stringifying such a graph drops every function-valued member silently and
 * yields nodes with no executable body and no `$implRef` naming one.
 *
 * A real method rather than a closure: `this` is whatever it was reached
 * through, so one shared function serves every module, and a factory that
 * `Object.assign`s a module's members picks up a member that works on the
 * factory too. Nothing is captured, so it goes straight into a module's own
 * literal, with no "assign it afterwards, once the binding exists" step to
 * forget on the next module.
 *
 * `this` is safe HERE and would not be on `toEncodableForm`. This method only
 * has to FIND that one, and every receiver carrying it resolves to the same
 * closure. `toEncodableForm` instead reads its receiver's own members, and a
 * factory is a different object from its module -- it carries `asScope` besides
 * -- so reaching it through a factory would serialize the factory, sweeping a
 * live function into a value bound for the data model.
 *
 * Declared as a FUNCTION rather than held in a `const`: a module is built
 * during module evaluation (`builtins/sqlite/query-node.ts` calls `lift()` at
 * its top level) and inside an import cycle, where a `const` is still in its
 * temporal dead zone. A function declaration is hoisted at instantiation and
 * is therefore already callable.
 *
 * It delegates rather than duplicating: `toEncodableForm` is the serializer,
 * and this is the name the JSON protocol looks it up by.
 *
 * This lives in a leaf module so that `builder/pattern.ts` -- which builds a
 * module of its own and which `builder/module.ts` imports -- can reach it
 * without closing an import cycle.
 */
export function toJSONMethod(
  this: toEncodableForm,
): FabricExecValue {
  return this.toEncodableForm();
}
