function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, NAME, pattern, SELF, type Stream, UI, type VNode, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    title: string;
}
interface Output {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    other: unknown;
    otherTitle: string;
    poke: Stream<void>;
}
const Child = pattern(() => ({
    [UI]: <span>child</span>,
}), {
    type: "object",
    properties: {
        room: {
            type: "unknown"
        }
    },
    required: ["room"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
const poke = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        room: {
            type: "unknown"
        }
    },
    required: ["room"]
} as const satisfies __cfHelpers.JSONSchema, (_, { room }) => {
    console.log(room);
});
const __cfLift_1 = __cfHelpers.lift<{
    input_SELF__title: string;
}, string>(({ input_SELF__title: _v1 }) => _v1 + "!", {
    type: "object",
    properties: {
        input_SELF__title: {
            type: "string"
        }
    },
    required: ["input_SELF__title"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-input-self-index
// Verifies: `input[SELF]` in the pattern body reads the pattern's own result
// in place, the way a destructured `[SELF]` binding does
//   input[SELF]                  → input[__cfHelpers.SELF]
//   input[SELF].title            → input[__cfHelpers.SELF].key("title")
//   const self = input[SELF]     → const self = input[__cfHelpers.SELF]
//   input[SELF].title + "!"      → lift over input[__cfHelpers.SELF].key("title")
//   poke({ room: input[SELF] })  → poke({ room: input[__cfHelpers.SELF] })
// Context: `SELF` adds no `$SELF` path to the pattern's input schema
export default pattern((input) => {
    const self = input[__cfHelpers.SELF];
    return {
        [NAME]: "Input SELF",
        [UI]: (<div>
        <Child room={input[__cfHelpers.SELF]}/>
        <Child room={self}/>
        <span>{input[__cfHelpers.SELF].key("title")}</span>
        <span>{__cfLift_1({ input_SELF__title: input[__cfHelpers.SELF].key("title") })}</span>
      </div>),
        title: input.key("title"),
        other: input[__cfHelpers.SELF],
        otherTitle: input[__cfHelpers.SELF].key("title"),
        poke: poke({ room: input[__cfHelpers.SELF] }).for({ stream: ["__patternResult", "poke"] }, true)
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        other: {
            type: "unknown"
        },
        otherTitle: {
            type: "string"
        },
        poke: {
            asCell: ["stream", "opaque"]
        },
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["title", "other", "otherTitle", "poke", "$NAME", "$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child,
    poke,
    __cfLift_1
});
