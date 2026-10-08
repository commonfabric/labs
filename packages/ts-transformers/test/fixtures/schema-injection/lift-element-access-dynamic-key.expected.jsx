function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const KEY = "k";
const ANY_KEY: string = "k";
type Catalog = {
    offers: Record<string, {
        space: string;
    }>;
    meta: {
        x: number;
    };
};
// FIXTURE: lift-element-access-dynamic-key
// Verifies: a module-scope lift keeps an input member it reads through an element access, beside a second member
//   catalog.get().offers[KEY]?.space shrinks catalog to offers, dropping the unread meta
//   catalog.get().offers[ANY_KEY]?.space, whose key can name any member, reads catalog in full
// Context: Explicitly typed lift inputs, as opposed to the closure-extracted computed inputs
const constKey = lift(({ catalog, n }: {
    catalog: Writable<Catalog>;
    n: Writable<number>;
}) => n.get() === 1 && catalog.get().offers[KEY]?.space === "room", {
    type: "object",
    properties: {
        catalog: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "object",
                        properties: {
                            space: {
                                type: "string"
                            }
                        },
                        required: ["space"]
                    }
                }
            },
            required: ["offers"],
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["catalog", "n"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const anyKey = lift(({ catalog, n }: {
    catalog: Writable<Catalog>;
    n: Writable<number>;
}) => n.get() === 1 && catalog.get().offers[ANY_KEY]?.space === "room", {
    type: "object",
    properties: {
        catalog: {
            $ref: "#/$defs/Catalog",
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["catalog", "n"],
    $defs: {
        Catalog: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "object",
                        properties: {
                            space: {
                                type: "string"
                            }
                        },
                        required: ["space"]
                    }
                },
                meta: {
                    type: "object",
                    properties: {
                        x: {
                            type: "number"
                        }
                    },
                    required: ["x"]
                }
            },
            required: ["offers", "meta"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
export default pattern(() => {
    const catalog = new Writable<Catalog>({ offers: {}, meta: { x: 1 } }, {
        type: "object",
        properties: {
            offers: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "object",
                    properties: {
                        space: {
                            type: "string"
                        }
                    },
                    required: ["space"]
                }
            },
            meta: {
                type: "object",
                properties: {
                    x: {
                        type: "number"
                    }
                },
                required: ["x"]
            }
        },
        required: ["offers", "meta"]
    } as const satisfies __cfHelpers.JSONSchema).for("catalog", true);
    const n = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("n", true);
    return {
        constKey: constKey({ catalog, n }).for(["__patternResult", "constKey"], true),
        anyKey: anyKey({ catalog, n }).for(["__patternResult", "anyKey"], true)
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        constKey: {
            type: "boolean"
        },
        anyKey: {
            type: "boolean"
        }
    },
    required: ["constKey", "anyKey"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    constKey,
    anyKey
});
