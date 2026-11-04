function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const eventSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        message: { type: "string" },
    },
    required: ["message"],
} as const);
const stateSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        log: { type: "array", items: { type: "string" } },
    },
    required: ["log"],
} as const);
const logHandler = handler(eventSchema, stateSchema, (event, state) => {
    state.log.push(event.message);
});
// FIXTURE: preserve-explicit-schemas
// Verifies: handler with user-provided schema literals passes them through unchanged (no type-based generation)
//   handler(eventSchema, stateSchema, fn) → handler(eventSchema, stateSchema, fn) (no transformation)
// Context: schemas are pre-defined as const objects; transformer must not replace them
export { logHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
