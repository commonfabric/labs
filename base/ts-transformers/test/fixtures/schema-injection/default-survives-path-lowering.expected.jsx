function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, type Default, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: default-survives-path-lowering
// Verifies: Default<…> annotations survive PATH-LOWERED captures. A scalar
// property access (`settings.note`) lowers to `settings.key("note")` with a
// leaf type node rebuilt from the checker type, so the injected lift
// capture schema silently dropped `"default"` for years (the
// destructured-binding form `({ note })` preserved the authored node and
// kept its default; the access-chain form did not). The DEFAULT_MARKER
// brand payload carries V through the rebuild and the schema generator
// reads it back from the expanded type.
interface Settings {
    note: Default<string, "n/a">;
    count: Default<number, 3>;
    // Union-VALUED default: `boolean` distributes the brand across true|false,
    // so the expanded type carries two branded members both paying `true`.
    // The payload recovery must agree across them (regression: dropped before).
    enabled: Default<boolean, true>;
}
interface Input {
    settings: Settings;
}
const __cfLift_1 = __cfHelpers.lift<{
    settings: {
        note: string | (string & { readonly [DEFAULT_MARKER]: "n/a"; });
    };
}, boolean>(({ settings }) => settings.note === "n/a", {
    type: "object",
    properties: {
        settings: {
            type: "object",
            properties: {
                note: {
                    type: "string",
                    "default": "n/a"
                }
            },
            required: ["note"]
        }
    },
    required: ["settings"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    settings: {
        count: number | (number & { readonly [DEFAULT_MARKER]: 3; });
    };
}, number>(({ settings }) => settings.count * 2, {
    type: "object",
    properties: {
        settings: {
            type: "object",
            properties: {
                count: {
                    type: "number",
                    "default": 3
                }
            },
            required: ["count"]
        }
    },
    required: ["settings"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    settings: {
        enabled: boolean | (false & { readonly [DEFAULT_MARKER]: true; }) | (true & { readonly [DEFAULT_MARKER]: true; });
    };
}, boolean>(({ settings }) => settings.enabled === true, {
    type: "object",
    properties: {
        settings: {
            type: "object",
            properties: {
                enabled: {
                    type: "boolean",
                    "default": true
                }
            },
            required: ["enabled"]
        }
    },
    required: ["settings"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
export default pattern((__cf_pattern_input) => {
    const settings = __cf_pattern_input.key("settings");
    const noteIsUnset = __cfLift_1({ settings: {
            note: settings.key("note")
        } }).for("noteIsUnset", true);
    const countTimesTwo = __cfLift_2({ settings: {
            count: settings.key("count")
        } }).for("countTimesTwo", true);
    const isEnabled = __cfLift_3({ settings: {
            enabled: settings.key("enabled")
        } }).for("isEnabled", true);
    return { noteIsUnset, countTimesTwo, isEnabled };
}, {
    type: "object",
    properties: {
        settings: {
            $ref: "#/$defs/Settings"
        }
    },
    required: ["settings"],
    $defs: {
        Settings: {
            type: "object",
            properties: {
                note: {
                    type: "string",
                    "default": "n/a"
                },
                count: {
                    type: "number",
                    "default": 3
                },
                enabled: {
                    type: "boolean",
                    "default": true
                }
            },
            required: ["note", "count", "enabled"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        noteIsUnset: {
            type: "boolean"
        },
        countTimesTwo: {
            type: "number"
        },
        isEnabled: {
            type: "boolean"
        }
    },
    required: ["noteIsUnset", "countTimesTwo", "isEnabled"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3
});
