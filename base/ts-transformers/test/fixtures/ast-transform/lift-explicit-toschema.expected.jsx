function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift, Cell, toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PieceEntry {
    id: string;
    name: string;
}
// Test: Explicit toSchema, function-first order.
// This overload pattern: lift(fn, toSchema<T>())  (result schema omitted)
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
            asCell: ["cell"]
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
} as const satisfies __cfHelpers.JSONSchema);
const getStatus = lift(({ status }) => status, {
    type: "object",
    properties: {
        status: {
            "enum": ["open", "closed"]
        },
        ignored: {
            type: "string",
            "enum": ["draft"]
        }
    },
    required: ["status", "ignored"],
    description: "Status input"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(fn, toSchema<{ piecesList: Cell<PieceEntry[]> }>()) → lift(fn, generatedSchema)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default __cfHelpers.__cf_data({ logPiecesList, getStatus });
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    logPiecesList,
    getStatus
});
