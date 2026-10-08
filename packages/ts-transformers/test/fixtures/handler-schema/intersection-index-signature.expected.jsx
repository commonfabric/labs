function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    text: string;
}
interface ListState {
    items: Cell<Item[]>;
}
// The index signature merges beside the members of `ListState`.
type Indexed = {
    [k: string]: unknown;
};
const removeItem = handler({
    type: "object",
    properties: {
        key: {
            type: "string"
        }
    },
    required: ["key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        }
    },
    additionalProperties: {
        type: "unknown"
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.items.get();
    state[event.key];
});
// FIXTURE: intersection-index-signature
// Verifies: an intersection with an index signature merges into one open object
//   handler<{key:string}, ListState & Indexed>() → context: { properties: { items }, additionalProperties: { type: "unknown" } }
// Context: the dynamic key read keeps the index signature's values beside
//   `items`; without it, shrinking can safely keep only `items`.
export { removeItem };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
