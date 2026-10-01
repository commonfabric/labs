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
    items: string[];
}
interface Output {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    items: string[];
    other: unknown;
    otherTitle: string;
    shouted: string;
    echoed: string[];
    kept: string[];
    bound: unknown;
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
const __cfLift_2 = __cfHelpers.lift<{
    input_SELF__title: string;
}, string>(({ input_SELF__title: _v1 }) => _v1.toUpperCase(), {
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
const __cfLift_3 = __cfHelpers.lift<{
    item: string;
}, string>(({ item }) => item + "!", {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_3({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    item: string;
}, boolean>(({ item }) => item !== "b", {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_4({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-input-self-index
// Verifies: `input[SELF]` in the pattern body reads the pattern's own result
// in place, the way a destructured `[SELF]` binding does
//   input[SELF]                  → input[__cfHelpers.SELF]
//   input[SELF].title            → input[__cfHelpers.SELF].key("title")
//   const self = input[SELF]     → const self = input[__cfHelpers.SELF]
//   input[SELF].title + "!"      → lift over input[__cfHelpers.SELF].key("title")
//   poke({ room: input[SELF] })  → poke({ room: input[__cfHelpers.SELF] })
//   input[SELF].items.map(fn)    → input[__cfHelpers.SELF].key("items").mapWithPattern(...)
//   input[SELF].items.filter(fn) → input[__cfHelpers.SELF].key("items").filterWithPattern(...)
//   const { [SELF]: s } = input  → const s = input[__cfHelpers.SELF]
//   input[SELF].title.toUpperCase() → lift capturing input[SELF].title
// Context: `SELF` adds no `$SELF` path to the pattern's input schema
export default pattern((input) => {
    const self = input[__cfHelpers.SELF];
    const bound = input[__cfHelpers.SELF];
    return {
        [NAME]: "Input SELF",
        [UI]: (<div>
        <Child room={input[__cfHelpers.SELF]}/>
        <Child room={self}/>
        <span>{input[__cfHelpers.SELF].key("title")}</span>
        <span>{__cfLift_1({ input_SELF__title: input[__cfHelpers.SELF].key("title") })}</span>
      </div>),
        title: input.key("title"),
        items: input.key("items"),
        other: input[__cfHelpers.SELF],
        otherTitle: input[__cfHelpers.SELF].key("title"),
        shouted: __cfLift_2({ input_SELF__title: input[SELF].title }).for(["__patternResult", "shouted"], true),
        echoed: input[__cfHelpers.SELF].key("items").mapWithPattern(__cfPattern_1, {}).for(["__patternResult", "echoed"], true),
        kept: input[__cfHelpers.SELF].key("items").filterWithPattern(__cfPattern_2, {}).for(["__patternResult", "kept"], true),
        bound,
        poke: poke({ room: input[__cfHelpers.SELF] }).for({ stream: ["__patternResult", "poke"] }, true)
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["title", "items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        other: {
            type: "unknown"
        },
        otherTitle: {
            type: "string"
        },
        shouted: {
            type: "string"
        },
        echoed: {
            type: "array",
            items: {
                type: "string"
            }
        },
        kept: {
            type: "array",
            items: {
                type: "string"
            }
        },
        bound: {
            type: "unknown"
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
    required: ["title", "items", "other", "otherTitle", "shouted", "echoed", "kept", "bound", "poke", "$NAME", "$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child,
    poke,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfPattern_1,
    __cfLift_4,
    __cfPattern_2
});
