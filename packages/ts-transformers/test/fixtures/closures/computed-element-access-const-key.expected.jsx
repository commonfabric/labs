function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const KEY = "k";
type Catalog = {
    offers: {
        k: {
            space: string;
            size: number;
        };
        other: {
            space: string;
        };
    };
    meta: {
        x: number;
    };
};
const __cfLift_1 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<{
        offers: {
            k: {
                space: string;
            };
        };
    }>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers[KEY].space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {
                        k: {
                            type: "object",
                            properties: {
                                space: {
                                    type: "string"
                                }
                            },
                            required: ["space"]
                        }
                    },
                    required: ["k"]
                }
            },
            required: ["offers"],
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<{
        offers: {
            k: {
                space: string;
            };
        };
    }>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers.k.space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {
                        k: {
                            type: "object",
                            properties: {
                                space: {
                                    type: "string"
                                }
                            },
                            required: ["space"]
                        }
                    },
                    required: ["k"]
                }
            },
            required: ["offers"],
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<{
        offers: {
            k: {
                space: string;
            };
        };
    }>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers["k"].space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {
                        k: {
                            type: "object",
                            properties: {
                                space: {
                                    type: "string"
                                }
                            },
                            required: ["space"]
                        }
                    },
                    required: ["k"]
                }
            },
            required: ["offers"],
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    catalog: __cfHelpers.ReadonlyCell<{
        offers: {
            k: {
                space: string;
            };
        };
    }>;
}, boolean>(({ catalog }) => catalog.get().offers[KEY].space === "room", {
    type: "object",
    properties: {
        catalog: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {
                        k: {
                            type: "object",
                            properties: {
                                space: {
                                    type: "string"
                                }
                            },
                            required: ["space"]
                        }
                    },
                    required: ["k"]
                }
            },
            required: ["offers"],
            asCell: ["readonly"]
        }
    },
    required: ["catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-element-access-const-key
// Verifies: an element access whose key has a literal type is a static path segment, so a capture read through one is kept and shrunk to that path
//   computed(() => n.get() === 1 && catalog.get().offers[KEY].space === "room") → lift<{ n; catalog: { offers: { k: { space } } } }>
//   `offers[KEY]` with `const KEY = "k"` shrinks catalog exactly as `offers.k` and `offers["k"]` do, and a lone capture reads the same way
// Context: Two captures, one read through `[KEY]`; the dot and string-literal keys are the controls; `size`, `other` and `meta` go unread
export default pattern(() => {
    const catalog = new Writable<Catalog>({
        offers: { k: { space: "", size: 0 }, other: { space: "" } },
        meta: { x: 1 },
    }, {
        type: "object",
        properties: {
            offers: {
                type: "object",
                properties: {
                    k: {
                        type: "object",
                        properties: {
                            space: {
                                type: "string"
                            },
                            size: {
                                type: "number"
                            }
                        },
                        required: ["space", "size"]
                    },
                    other: {
                        type: "object",
                        properties: {
                            space: {
                                type: "string"
                            }
                        },
                        required: ["space"]
                    }
                },
                required: ["k", "other"]
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
    const constKey = __cfLift_1({
        n: n,
        catalog: catalog
    }).for("constKey", true);
    const dotKey = __cfLift_2({
        n: n,
        catalog: catalog
    }).for("dotKey", true);
    const literalKey = __cfLift_3({
        n: n,
        catalog: catalog
    }).for("literalKey", true);
    const loneCapture = __cfLift_4({ catalog: catalog }).for("loneCapture", true);
    return { constKey, dotKey, literalKey, loneCapture };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        constKey: {
            type: "boolean"
        },
        dotKey: {
            type: "boolean"
        },
        literalKey: {
            type: "boolean"
        },
        loneCapture: {
            type: "boolean"
        }
    },
    required: ["constKey", "dotKey", "literalKey", "loneCapture"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
