function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    prefix: string;
    count: number;
}, string>(({ prefix, count }) => ((value: number) => prefix + value)(count), {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        prefix: {
            type: "string"
        }
    },
    required: ["count", "prefix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: parameterized-inline-call-root
// Verifies: helper-owned parameterized inline-function call roots lower as a
// shared post-closure lift-applied computation around the whole call, not as a lift-applied computation inside the
// inline function body that leaves the reactive argument outside.
//   ((value) => prefix + value)(count)
//     -> lift(({ prefix, count }) => ((value) => prefix + value)(count))({ prefix, count })
export default pattern((__cf_pattern_input) => {
    const prefix = __cf_pattern_input.key("prefix");
    const count = __cf_pattern_input.key("count");
    return ({
        [UI]: <div>{__cfLift_1({
            prefix: prefix,
            count: count
        })}</div>,
    });
}, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        },
        count: {
            type: "number"
        }
    },
    required: ["prefix", "count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
