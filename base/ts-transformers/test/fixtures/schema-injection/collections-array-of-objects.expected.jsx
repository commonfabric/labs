function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: collections-array-of-objects
// Verifies: schema injection generates array-of-objects schema with typed items and required keys
//   cell([{id: 1, name: "Alice", ...}]) → cell([...], { type: "array", items: { type: "object", properties: {...}, required: [...] } })
export default function TestCollectionsArrayOfObjects() {
    // Array of objects
    const _arrayOfObjects = cell([
        { id: 1, name: "Alice", score: 95.5 },
        { id: 2, name: "Bob", score: 87.3 },
        { id: 3, name: "Charlie", score: 92.1 }
    ], {
        type: "array",
        items: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                score: {
                    type: "number"
                }
            },
            required: ["id", "name", "score"]
        }
    } as const satisfies __cfHelpers.JSONSchema).for("_arrayOfObjects", true);
    return _arrayOfObjects;
}
__cfHardenFn(TestCollectionsArrayOfObjects);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
