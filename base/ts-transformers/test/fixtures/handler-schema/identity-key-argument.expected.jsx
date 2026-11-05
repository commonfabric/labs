function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, equalsKey, handler, lift, pattern, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Panel {
    name: string;
}
type PanelEvent = {
    panel: Writable<Panel>;
};
type Selection = {
    selected: Writable<Panel | undefined>;
    unused: Writable<Panel>;
};
const keyMember = handler({
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
        selected: {
            type: "unknown",
            asCell: ["comparable"]
        }
    },
    required: ["selected"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    if (equalsKey(state.selected) === equalsKey(event.panel))
        return;
});
const keyMemberInLift = lift(({ state, other }: {
    state: Selection;
    other: Writable<Panel>;
}) => equalsKey(state.selected) === equalsKey(other), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                selected: {
                    type: "unknown",
                    asCell: ["comparable"]
                }
            },
            required: ["selected"]
        },
        other: {
            type: "unknown",
            asCell: ["comparable"]
        }
    },
    required: ["state", "other"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.lift<{
    panels: __cfHelpers.ReadonlyCell<__cfHelpers.ComparableCell<unknown>[]>;
    picked: __cfHelpers.ComparableCell<unknown>;
}, number>(({ panels, picked }) => panels.get().filter((panel) => equalsKey(panel) !== equalsKey(picked))
    .length, {
    type: "object",
    properties: {
        panels: {
            type: "array",
            items: {
                type: "unknown",
                asCell: ["comparable"]
            },
            asCell: ["readonly"]
        },
        picked: {
            type: "unknown",
            asCell: ["comparable"]
        }
    },
    required: ["panels", "picked"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: identity-key-argument
// Verifies: a value handed to `equalsKey` is compared, not read, as one handed
// to `equals` is, so it is a comparable cell: a member and a list's elements
// alike, and the state's unused member is pruned.
export default pattern((__cf_pattern_input) => {
    const panels = __cf_pattern_input.key("panels");
    const picked = __cf_pattern_input.key("picked");
    const others = __cfLift_1({
        panels: panels,
        picked: picked
    }).for("others", true);
    return { others };
}, {
    type: "object",
    properties: {
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel"
            },
            asCell: ["cell"]
        },
        picked: {
            $ref: "#/$defs/Panel",
            asCell: ["cell"]
        }
    },
    required: ["panels", "picked"],
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
        others: {
            type: "number"
        }
    },
    required: ["others"]
} as const satisfies __cfHelpers.JSONSchema);
export { keyMember, keyMemberInLift };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
