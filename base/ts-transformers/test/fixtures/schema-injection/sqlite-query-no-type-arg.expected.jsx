function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { sqliteQuery } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: sqlite-query-no-type-arg
// Verifies: an untyped sqliteQuery(...) call compiles and is NOT modified — no
// `rowSchema` is injected (the runtime then falls back to suffix/table
// detection). Guards the `!typeArgs` early return of the injection branch.
// deno-lint-ignore-next-line no-explicit-any
export default function TestSqliteQueryNoTypeArg(db: any) {
    const q = sqliteQuery({ db, sql: "SELECT * FROM m" }).for("q", true);
    return { q };
}
__cfHardenFn(TestSqliteQueryNoTypeArg);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
