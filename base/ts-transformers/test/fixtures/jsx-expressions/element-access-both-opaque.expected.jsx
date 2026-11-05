function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    items: __cfHelpers.Cell<string[]>;
    index: __cfHelpers.Cell<number>;
}, string | undefined>(({ items, index }) => items.get()[index.get()], {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        },
        index: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["items", "index"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: element-access-both-opaque
// Verifies: element access where both array and index are cell-backed Reactives is wrapped in a lift-applied computation
//   items.get()[index.get()] → lift(({items, index}) => items.get()[index.get()])({ items, index })
export default pattern((_state) => {
    const items = cell(["apple", "banana", "cherry"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("items", true);
    const index = cell(1, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("index", true);
    return {
        [UI]: (<div>
        <h3>Element Access with Both Reactives</h3>
        {/* Both items and index are Reactives */}
        <p>Selected item: {__cfLift_1({
            items: items,
            index: index
        })}</p>
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
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
