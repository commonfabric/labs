function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    foo: string;
    count: number;
    enabled: boolean;
}
// FIXTURE: pattern-interface-default-sibling-fields
// Verifies: interface-backed destructuring defaults keep schema defaults and non-default sibling fields
//   ({ foo = "fallback", count = 0 }) → schema defaults for foo/count
//   enabled stays present in the input schema even though it is not destructured
export default pattern((__cf_pattern_input) => {
    const foo = __cf_pattern_input.key("foo");
    const count = __cf_pattern_input.key("count");
    return (<div>
    {foo}:{count}
  </div>);
}, {
    type: "object",
    properties: {
        foo: {
            type: "string",
            "default": "fallback"
        },
        count: {
            type: "number",
            "default": 0
        },
        enabled: {
            type: "boolean"
        }
    },
    required: ["foo", "count", "enabled"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
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
