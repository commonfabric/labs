function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, ComparableCell, ReadonlyCell, Stream, type PerUser, type Writable, Writable as WritableConstructor, WriteonlyCell, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Event {
    message: string;
}
// FIXTURE: cell-constructors
// Verifies: schema injection treats new CellLike(...) like cell constructor calls.
//   new Cell<string>("hello") -> new Cell<string>("hello", { type: "string" })
//   new WritableConstructor.perUser("Ada") -> schema includes scope: "user"
//   const contextual: PerUser<Writable<string>> = new WritableConstructor("")
//     -> contextual schema includes scope: "user"
export default function TestCellConstructors() {
    const explicitString = new Cell<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("explicitString", true);
    const inferredNumber = new Cell(123, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("inferredNumber", true);
    const caused = new WritableConstructor("Ada", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("name");
    const contextual: PerUser<Writable<string>> = new WritableConstructor("", {
        type: "string",
        scope: "user"
    } as const satisfies __cfHelpers.JSONSchema).for("contextual", true);
    const scoped = new WritableConstructor.perUser("Ada", {
        type: "string",
        scope: "user"
    } as const satisfies __cfHelpers.JSONSchema).for("scoped", true);
    const event = new Stream.perSpace<Event>({ message: "ready" }, {
        type: "object",
        properties: {
            message: {
                type: "string"
            }
        },
        required: ["message"],
        scope: "space"
    } as const satisfies __cfHelpers.JSONSchema).for({ stream: "event" }, true);
    const comparable = new ComparableCell(200, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("comparable", true);
    const readonly = new ReadonlyCell(300, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("readonly", true);
    const writeonly = new WriteonlyCell(400, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("writeonly", true);
    const LocalWritable = WritableConstructor;
    const aliased = new LocalWritable("aliased", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("aliased", true);
    return {
        explicitString,
        inferredNumber,
        caused,
        contextual,
        scoped,
        event,
        comparable,
        readonly,
        writeonly,
        aliased,
    };
}
__cfHardenFn(TestCellConstructors);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
