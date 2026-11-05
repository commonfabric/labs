function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Profile = {
    name: string;
    email: string;
};
type Item = {
    id: string;
    label: string;
};
type State = {
    foo: string;
    profile: Profile;
    items: Item[];
    unused: string;
};
// FIXTURE: capability-wrapper-narrowing
// Verifies: lift inputs narrow from Writable<> to the least capable cell
// wrapper required by callback usage.
const readOnly = lift((input: Writable<State>) => input.key("foo").get(), {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const setOnly = lift((input: Writable<State>) => {
    input.key("foo").set("updated");
    return 1;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["writeonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const updateOnly = lift((input: Writable<State>) => {
    input.key("profile").update({ name: "Ada" });
    return 1;
}, {
    type: "object",
    properties: {
        profile: {
            $ref: "#/$defs/Profile"
        }
    },
    required: ["profile"],
    asCell: ["writeonly"],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                email: {
                    type: "string"
                }
            },
            required: ["name", "email"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const pushOnly = lift((input: Writable<State>) => {
    input.key("items").push({ id: "1", label: "First" });
    return 1;
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    asCell: ["writeonly"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const readWrite = lift((input: Writable<State>) => {
    input.key("foo").set(input.key("foo").get().toUpperCase());
    return 1;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const comparable = lift((input: Writable<State>) => input.equals(input), {
    type: "unknown",
    asCell: ["comparable"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("id");
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["element"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const opaqueMap = lift((input: Writable<Item[]>) => input.mapWithPattern(__cfPattern_1), {
    type: "array",
    items: {
        $ref: "#/$defs/Item"
    },
    asCell: ["opaque"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
export { comparable, opaqueMap, pushOnly, readOnly, readWrite, setOnly, updateOnly, };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1
});
