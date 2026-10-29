function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type Cell, sqliteQuery } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface User {
    name: string;
}
// FIXTURE: sqlite-query-row-schema
// Verifies: sqliteQuery<Row> lowers the Row type argument to an injected
//   `rowSchema` property. Cell<T> fields become asCell (keyed by the Row field
//   name, so the aliased link column `author` is detected with no `_cf_link`
//   suffix). Untyped sqliteQuery(...) injects nothing (see sibling fixture).
// deno-lint-ignore-next-line no-explicit-any
export default function TestSqliteQueryRowSchema(db: any) {
    const q = sqliteQuery<{
        author: Cell<User>;
        n: number;
    }>({
        db,
        sql: "SELECT author_cf_link AS author, count(*) AS n FROM m GROUP BY author_cf_link",
        rowSchema: {
            type: "object",
            properties: {
                author: {
                    $ref: "#/$defs/User",
                    asCell: ["cell"]
                },
                n: {
                    type: "number"
                }
            },
            required: ["author", "n"],
            $defs: {
                User: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema
    }).for("q", true);
    return { q };
}
__cfHardenFn(TestSqliteQueryRowSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
