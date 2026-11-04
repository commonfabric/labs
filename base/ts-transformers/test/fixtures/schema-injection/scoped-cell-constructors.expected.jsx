function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, Stream, type PerUser, type Writable, Writable as WritableConstructor, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Event {
    message: string;
}
// FIXTURE: scoped-cell-constructors
// Verifies: scoped cell constructor helpers inject top-level schema scopes.
export default function TestScopedCellConstructors() {
    const name = new WritableConstructor.perUser("Ada", {
        type: "string",
        scope: "user"
    } as const satisfies __cfHelpers.JSONSchema).for("name", true);
    const draft = Cell.perSession.for<string>("draft").asSchema({
        type: "string",
        scope: "session"
    } as const satisfies __cfHelpers.JSONSchema);
    const events = new Stream.perSpace<Event>({ message: "ready" }, {
        type: "object",
        properties: {
            message: {
                type: "string"
            }
        },
        required: ["message"],
        scope: "space"
    } as const satisfies __cfHelpers.JSONSchema).for({ stream: "events" }, true);
    const contextual: PerUser<Writable<string>> = new WritableConstructor("", {
        type: "string",
        scope: "user"
    } as const satisfies __cfHelpers.JSONSchema).for("contextual", true);
    const inherited = new WritableConstructor("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("inherited", true);
    return {
        name,
        draft,
        events,
        contextual,
        inherited,
    };
}
__cfHardenFn(TestScopedCellConstructors);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
