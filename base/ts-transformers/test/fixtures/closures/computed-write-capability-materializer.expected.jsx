function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    title: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: __cfHelpers.ReadonlyCell<Item[]>;
    processed: __cfHelpers.WriteonlyCell<string[]>;
}, void>(({ processed, items }) => {
    processed.set(items.get().map((i) => i.title));
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["readonly"]
        },
        processed: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["items", "processed"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, { materializerWriteInputPaths: [["processed"]], completeSchedulerScopeSummary: true });
// FIXTURE: computed-write-capability-materializer
// Verifies: a computed() that WRITES to a captured cell (`.set(...)`) produces a
//   write-capability capture, which the lift-applied strategy emits with a
//   trailing `{ materializerWriteInputPaths: [...] }` options object.
//   The schema injection must keep function-first order:
//     lift(cb, argumentSchema, resultSchema, { materializerWriteInputPaths })
//   i.e. the options object stays LAST, after both schemas — NOT scrambled into
//   the argumentSchema slot. (CT-1625 regression: the function-first reorder
//   originally appended schemas after the options, corrupting the call.)
export default pattern(() => {
    const items = new Writable<Item[]>([{ title: "a" }], {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    }
                },
                required: ["title"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema).for("items", true);
    const processed = new Writable<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("processed", true);
    __cfLift_1({
        processed: processed,
        items: items
    });
    return { items: items.for(["__patternResult", "items"], true), processed: processed.for(["__patternResult", "processed"], true) };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        },
        processed: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["cell"]
        }
    },
    required: ["items", "processed"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
