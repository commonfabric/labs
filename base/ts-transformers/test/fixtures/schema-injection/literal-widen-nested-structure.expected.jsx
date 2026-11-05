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
// FIXTURE: literal-widen-nested-structure
// Verifies: nested object+array literal produces a fully recursive schema with widened leaf types
//   cell({ users: [{id, name, active}], count }) → cell(..., { type: "object", properties: { users: { type: "array", items: { type: "object", ... } }, count: { type: "number" } } })
export default function TestLiteralWidenNestedStructure() {
    const _nested = cell({
        users: [
            { id: 1, name: "Alice", active: true },
            { id: 2, name: "Bob", active: false }
        ],
        count: 2
    }, {
        type: "object",
        properties: {
            users: {
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
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "name", "active"]
                }
            },
            count: {
                type: "number"
            }
        },
        required: ["users", "count"]
    } as const satisfies __cfHelpers.JSONSchema).for("_nested", true);
    return null;
}
__cfHardenFn(TestLiteralWidenNestedStructure);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
