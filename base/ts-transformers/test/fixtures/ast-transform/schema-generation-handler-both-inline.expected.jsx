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
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface IncrementEvent {
    amount: number;
}
interface CounterState {
    count: number;
}
// FIXTURE: schema-generation-handler-both-inline
// Verifies: handler() with both params typed inline generates event and state schemas
//   handler((event: IncrementEvent, state: CounterState) => ...) → handler(eventSchema, stateSchema, fn)
// Context: Types come from inline parameter annotations, not generic type args
// Both parameters typed inline (no generic type arguments)
export const incrementer = handler({
    type: "object",
    properties: {
        amount: {
            type: "number"
        }
    },
    required: ["amount"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (event: IncrementEvent, state: CounterState) => {
    state.count += event.amount;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
