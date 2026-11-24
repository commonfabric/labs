function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    name: string;
}
interface Entry {
    item: Writable<Item>;
    note: string;
}
const recordMatch = handler({
    type: "object",
    properties: {
        item: {
            $ref: "#/$defs/Item",
            asCell: ["comparable"]
        }
    },
    required: ["item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            asCell: ["readonly"]
        },
        found: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["entries", "found"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                item: {
                    type: "unknown",
                    asCell: ["comparable"]
                },
                note: {
                    type: "string"
                }
            },
            required: ["item", "note"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, ({ item }, { entries, found }) => {
    const entry = entries.get().find((candidate) => candidate.item.equals(item));
    found.set(entry ? entry.note : "missing");
});
const holdsItem = handler({
    type: "object",
    properties: {
        item: {
            $ref: "#/$defs/Item",
            asCell: ["comparable"]
        }
    },
    required: ["item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            asCell: ["readonly"]
        },
        found: {
            type: "boolean",
            asCell: ["writeonly"]
        }
    },
    required: ["entries", "found"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                item: {
                    type: "unknown",
                    asCell: ["comparable"]
                },
                note: {
                    type: "string"
                }
            },
            required: ["item", "note"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, ({ item }, { entries, found }) => {
    found.set(entries.get().some((entry) => entry.item.equals(item)));
});
// FIXTURE: identity-element-field-handler
// Verifies: a cell field of an array element compared with `equals` keeps the
// element's own schema, with the field as a comparable cell, rather than
// collapsing the element to unknown as an element compared whole does.
export { holdsItem, recordMatch };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
