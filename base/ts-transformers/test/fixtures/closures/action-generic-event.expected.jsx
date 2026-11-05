function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, pattern, action } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface MyEvent {
    data: string;
}
interface State {
    value: Cell<string>;
}
const __cfHandler_1 = __cfHelpers.handler({
    type: "object",
    properties: {
        data: {
            type: "string"
        }
    },
    required: ["data"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (e, { value }) => value.set(e.data));
// FIXTURE: action-generic-event
// Verifies: action<MyEvent>(fn) with a type parameter generates a typed event schema
//   action<MyEvent>((e) => ...) → handler(MyEvent schema, captureSchema, (e, { value }) => ...)({ value })
// Context: Event type comes from a generic type parameter, not an inline annotation
export default pattern((__cf_pattern_input) => {
    const value = __cf_pattern_input.key("value");
    return {
        // Test action<MyEvent>((e) => ...) variant (type parameter instead of inline annotation)
        update: __cfHandler_1({
            value: value
        }).for({ stream: ["__patternResult", "update"] }, true)
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        update: {
            $ref: "#/$defs/MyEvent",
            asCell: ["stream"]
        }
    },
    required: ["update"],
    $defs: {
        MyEvent: {
            type: "object",
            properties: {
                data: {
                    type: "string"
                }
            },
            required: ["data"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1
});
