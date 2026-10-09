function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { equals, handler, lift, Writable } from "commonfabric";
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
const compareMember = handler({
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
    if (equals(state.selected, event.panel))
        return;
});
const compareDestructured = handler({
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
} as const satisfies __cfHelpers.JSONSchema, (event, { selected }) => {
    if (equals(selected, event.panel))
        return;
});
const compareMemberAsMethodArgument = handler({
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
    if (event.panel.equals(state.selected))
        return;
});
const compareMemberInLift = lift(({ state, other }: {
    state: Selection;
    other: Writable<Panel>;
}) => equals(state.selected, other), {
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
// FIXTURE: identity-member-argument
// Verifies: a member handed to a known identity call is compared, not read,
// so it is a comparable cell as a destructured binding compared the same way
// is, and in every spelling the state's unused member is pruned.
export { compareDestructured, compareMember, compareMemberAsMethodArgument, compareMemberInLift, };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
