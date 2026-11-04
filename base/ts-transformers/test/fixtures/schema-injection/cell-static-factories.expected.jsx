function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, OpaqueCell, Stream } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cell-static-factories
// Verifies: static cell factories inject schemas from explicit, inferred, and contextual types
//   new Cell<string>("hello") → new Cell<string>("hello", { type: "string" })
//   new Cell(123) → new Cell(123, { type: "number" })
//   const cell: Cell<number> = Cell.for("cause") → Cell.for("cause").asSchema({ type: "number" })
//   new OpaqueCell<boolean>(true) / new Stream<number>(1) also receive injected schemas
export default function TestCellStaticFactories() {
    const explicitString = new Cell<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("explicitString", true);
    const inferredNumber = new Cell(123, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("inferredNumber", true);
    const explicitCause = Cell.for<string>("cause").asSchema({
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const contextualCause: Cell<number> = Cell.for("cause").asSchema({
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const opaque = new OpaqueCell<boolean>(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("opaque", true);
    const stream = new Stream<number>(1, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for({ stream: "stream" }, true);
    return {
        explicitString,
        inferredNumber,
        explicitCause,
        contextualCause,
        opaque,
        stream,
    };
}
__cfHardenFn(TestCellStaticFactories);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
