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
interface ClickEvent {
    x: number;
    y: number;
}
interface AppState {
    clicks: number;
    lastPosition: {
        x: number;
        y: number;
    };
}
// FIXTURE: schema-generation-handler-inside-jsx
// Verifies: handler() inside a JSX expression still gets schemas injected
//   handler((event: ClickEvent, state: AppState) => ...) → handler(eventSchema, stateSchema, fn)
// Context: handler() appears as a JSX child expression, not a standalone statement
export const result = (<div>
    {handler({
        type: "object",
        properties: {
            x: {
                type: "number"
            },
            y: {
                type: "number"
            }
        },
        required: ["x", "y"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            clicks: {
                type: "number"
            }
        },
        required: ["clicks"]
    } as const satisfies __cfHelpers.JSONSchema, (event: ClickEvent, state: AppState) => ({
        clicks: state.clicks + 1,
        lastPosition: { x: event.x, y: event.y },
    }))}
  </div>);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
