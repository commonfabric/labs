function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, SqliteDb } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface DbState {
    db: SqliteDb;
}
// FIXTURE: sqlite-db-handler-state
// Verifies: a SqliteDb-typed handler-state field lowers to an `asCell: ["sqlite"]`
// wrapper, so the handler receives the live handle cell and `db.exec(...)` is valid.
// The "sqlite" cell brand is authoritative and survives capability shrinking (like
// Stream): the read/write inference would otherwise collapse SqliteDb's read-only
// method surface to `asCell: ["readonly"]`, disagreeing with the schema generator's
// object-formatter path (which stamps "sqlite"). Both paths now agree — this closed
// the two-path brand inconsistency (#20 in 08-open-questions).
const writeNote = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        db: {
            $ref: "#/$defs/SqliteDatabase",
            asCell: ["sqlite"]
        }
    },
    required: ["db"],
    $defs: {
        SqliteDatabase: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                tables: {
                    type: "object",
                    additionalProperties: true
                },
                rev: {
                    type: "number"
                }
            },
            additionalProperties: true
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { db }) => {
    db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
});
export { writeNote };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
