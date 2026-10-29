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
const key = "foo" as const;
// FIXTURE: pattern-computed-binding-key-destructure
// Verifies: computed binding-name destructuring is lowered structurally
//   ({ [key]: foo }) → const foo = __cf_pattern_input.key(key)
export default pattern((__cf_pattern_input) => {
    const foo = __cf_pattern_input.key(key);
    return <div>{foo}</div>;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"]
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
