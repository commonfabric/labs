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
interface Panel {
    name: string;
}
function holdsName(list: readonly Writable<Panel>[], name: string): boolean {
    return list.some((panel) => panel.get().name === name);
}
__cfHardenFn(holdsName);
const addPanel = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["readonly"]
        },
        name: {
            type: "string"
        }
    },
    required: ["panel", "name"],
    $defs: {
        Panel: {
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
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel",
                asCell: ["cell"]
            },
            asCell: ["cell"]
        }
    },
    required: ["panels"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, ({ panel, name }, { panels }) => {
    const list = panels.get();
    if (list.some((existing) => existing.equals(panel)))
        return;
    if (holdsName(list, name))
        return;
    panels.set([...list, panel]);
});
function keep(value: unknown): boolean {
    return value !== undefined;
}
__cfHardenFn(keep);
type PanelEvent = {
    panel: Writable<Panel>;
};
type PanelState = {
    panels: Writable<Writable<Panel>[]>;
};
const addThroughFallback = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["comparable"]
        }
    },
    required: ["panel"],
    $defs: {
        Panel: {
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
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel",
                asCell: ["cell"]
            },
            asCell: ["readonly"]
        }
    },
    required: ["panels"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, ({ panel }, { panels }) => {
    const list = panels.get();
    if (list.some((existing) => existing.equals(panel)))
        return;
    if (keep(list ?? []))
        return;
});
const addThroughLocalHoldingRoot = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["comparable"]
        }
    },
    required: ["panel"],
    $defs: {
        Panel: {
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
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel",
                asCell: ["cell"]
            },
            asCell: ["readonly"]
        }
    },
    required: ["panels"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    const list = state.panels.get();
    if (list.some((existing) => existing.equals(event.panel)))
        return;
    const box = { state };
    if (keep(box))
        return;
});
const addThroughRootFallback = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["comparable"]
        }
    },
    required: ["panel"],
    $defs: {
        Panel: {
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
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel",
                asCell: ["cell"]
            },
            asCell: ["readonly"]
        }
    },
    required: ["panels"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    const list = state.panels.get();
    if (list.some((existing) => existing.equals(event.panel)))
        return;
    if (keep(state ?? undefined))
        return;
});
const addThroughArrayHoldingRoot = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["comparable"]
        }
    },
    required: ["panel"],
    $defs: {
        Panel: {
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
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel",
                asCell: ["cell"]
            },
            asCell: ["readonly"]
        }
    },
    required: ["panels"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    const list = state.panels.get();
    if (list.some((existing) => existing.equals(event.panel)))
        return;
    if (keep([state]))
        return;
});
// FIXTURE: identity-element-escaped-to-helper
// Verifies: elements compared with `equals` keep their full schema when the
// list also leaves whole for a helper with no summary, which may read them;
// they are not narrowed to comparable cells as elements only compared are.
// The list leaves on its own and as a fallback's operand; the state holding
// it leaves in a local, as a fallback's operand, and in an array.
export { addPanel, addThroughArrayHoldingRoot, addThroughFallback, addThroughLocalHoldingRoot, addThroughRootFallback, };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
