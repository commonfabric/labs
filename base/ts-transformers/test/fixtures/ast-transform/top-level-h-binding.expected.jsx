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
// FIXTURE: top-level-h-binding
// Verifies: a module binding `h` at top level gets a `__cfHelpersShim()` trailer
//   forwarding to `__cfHelpers.h()` to keep the import live without duplicating
//   the authored `h` binding; JSX still dispatches through `__cfHelpers.h()`.
const h = __cfHelpers.__cf_data(["a", "b"]);
export default pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    return (<ul title={title}>{h.map((item) => <li>{item}</li>)}</ul>);
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
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
function __cfHelpersShim(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(__cfHelpersShim);
