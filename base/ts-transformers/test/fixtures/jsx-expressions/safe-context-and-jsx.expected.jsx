function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
// deno-lint-ignore-file no-unused-vars
import { handler, computed } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    show: boolean;
}, boolean>(({ show }) => show, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        }
    },
    required: ["show"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: safe-context-and-jsx
// Verifies: && and || with JSX inside handler callbacks are transformed to when()/unless()
//   computed(() => show) && <span> → when(computed(() => show), <span>)
//   computed(() => value) || <span> → unless(computed(() => value), <span>)
// Context: Ensures transforms work in handler context, not just pattern context
// Test: && with JSX inside handler callback should transform to when()
const MyHandler = handler({
    type: "object",
    properties: {
        bubbles: {
            type: "boolean"
        },
        cancelBubble: {
            type: "boolean"
        },
        cancelable: {
            type: "boolean"
        },
        composed: {
            type: "boolean"
        },
        currentTarget: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        defaultPrevented: {
            type: "boolean"
        },
        eventPhase: {
            type: "number"
        },
        isTrusted: {
            type: "boolean"
        },
        returnValue: {
            type: "boolean"
        },
        srcElement: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        target: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        timeStamp: {
            type: "number"
        },
        type: {
            type: "string"
        },
        NONE: {
            type: "number",
            "enum": [0]
        },
        CAPTURING_PHASE: {
            type: "number",
            "enum": [1]
        },
        AT_TARGET: {
            type: "number",
            "enum": [2]
        },
        BUBBLING_PHASE: {
            type: "number",
            "enum": [3]
        }
    },
    required: ["bubbles", "cancelBubble", "cancelable", "composed", "currentTarget", "defaultPrevented", "eventPhase", "isTrusted", "returnValue", "srcElement", "target", "timeStamp", "type", "NONE", "CAPTURING_PHASE", "AT_TARGET", "BUBBLING_PHASE"],
    $defs: {
        EventTarget: {
            type: "object",
            properties: {}
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        }
    },
    required: ["show"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { show }) => {
    return <div>{__cfLift_1({ show: show }) && <span>Content</span>}</div>;
});
const __cfLift_2 = __cfHelpers.lift<{
    value: string | null;
}, string | null>(({ value }) => value, {
    type: "object",
    properties: {
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "string"
        }, {
            type: "null"
        }]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// Test: || with JSX inside handler callback should transform to unless()
const MyHandler2 = handler({
    type: "object",
    properties: {
        bubbles: {
            type: "boolean"
        },
        cancelBubble: {
            type: "boolean"
        },
        cancelable: {
            type: "boolean"
        },
        composed: {
            type: "boolean"
        },
        currentTarget: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        defaultPrevented: {
            type: "boolean"
        },
        eventPhase: {
            type: "number"
        },
        isTrusted: {
            type: "boolean"
        },
        returnValue: {
            type: "boolean"
        },
        srcElement: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        target: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        timeStamp: {
            type: "number"
        },
        type: {
            type: "string"
        },
        NONE: {
            type: "number",
            "enum": [0]
        },
        CAPTURING_PHASE: {
            type: "number",
            "enum": [1]
        },
        AT_TARGET: {
            type: "number",
            "enum": [2]
        },
        BUBBLING_PHASE: {
            type: "number",
            "enum": [3]
        }
    },
    required: ["bubbles", "cancelBubble", "cancelable", "composed", "currentTarget", "defaultPrevented", "eventPhase", "isTrusted", "returnValue", "srcElement", "target", "timeStamp", "type", "NONE", "CAPTURING_PHASE", "AT_TARGET", "BUBBLING_PHASE"],
    $defs: {
        EventTarget: {
            type: "object",
            properties: {}
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { value }) => {
    return <div>{__cfLift_2({ value: value }) || <span>Fallback</span>}</div>;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    MyHandler,
    __cfLift_1,
    MyHandler2,
    __cfLift_2
});
