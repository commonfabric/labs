function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, handler, pattern, spaceAccess, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    room: Writable<{
        title: string;
    }>;
}
// FIXTURE: space-access-arguments
// Verifies: a spaceAccess() call keeps the arguments its author wrote, in a
//   computed and in a handler alike
//   computed(() => spaceAccess(room)) → lift(({ room }) => spaceAccess(room))({ room })
//   computed(() => spaceAccess(undefined)) → lift(() => spaceAccess(undefined))()
// Context: spaceAccess() is a plain call; an `undefined` target means "not
//   known yet" and must not be dropped into a call with no target
const probe = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        room: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"],
            asCell: ["readonly"]
        }
    },
    required: ["room"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { room }) => {
    console.log(spaceAccess(room), spaceAccess(undefined));
});
const __cfLift_1 = __cfHelpers.lift<{
    room: __cfHelpers.ReadonlyCell<{ title: string; }>;
}, SpaceAccessLevel | undefined>(({ room }) => spaceAccess(room), {
    type: "object",
    properties: {
        room: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"],
            asCell: ["readonly"]
        }
    },
    required: ["room"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            type: "string",
            "enum": ["OWNER", "READ", "WRITE", "none"]
        }]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift(() => spaceAccess(undefined), false, undefined, { completeSchedulerScopeSummary: true });
export default pattern((__cf_pattern_input) => {
    const room = __cf_pattern_input.key("room");
    return {
        level: __cfLift_1({ room: room }).for(["__patternResult", "level"], true),
        unknown: __cfLift_2().for(["__patternResult", "unknown"], true),
        probe: probe({ room }).for({ stream: ["__patternResult", "probe"] }, true)
    };
}, {
    type: "object",
    properties: {
        room: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"],
            asCell: ["cell"]
        }
    },
    required: ["room"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        level: {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string",
                    "enum": ["OWNER", "READ", "WRITE", "none"]
                }]
        },
        unknown: {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string",
                    "enum": ["OWNER", "READ", "WRITE", "none"]
                }]
        },
        probe: {
            type: "unknown",
            asCell: ["stream"]
        }
    },
    required: ["level", "unknown", "probe"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    probe,
    __cfLift_1,
    __cfLift_2
});
