function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PieceEntry {
    id: string;
    name: string;
}
// FIXTURE: schema-generation-lift-cell-array
// Verifies: lift() with Cell<T[]> in the generic arg preserves asCell in the generated schema
//   lift<{ piecesList: Cell<PieceEntry[]> }>(fn) → lift(inputSchema, outputSchema, fn)
// Context: Cell wrapper must produce `asCell: true` in the schema; output schema inferred from return type
// Test that lift with single generic parameter preserves Cell wrapper
// This was broken on main - Cell would be unwrapped to ProxyArray
const logPiecesList = lift(({ piecesList }) => {
    console.log("logPiecesList: ", piecesList.get());
    return piecesList;
}, {
    type: "object",
    properties: {
        piecesList: {
            type: "array",
            items: {
                $ref: "#/$defs/PieceEntry"
            },
            asCell: ["readonly"]
        }
    },
    required: ["piecesList"],
    $defs: {
        PieceEntry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/PieceEntry"
    },
    asCell: ["cell"],
    $defs: {
        PieceEntry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
export default logPiecesList;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
