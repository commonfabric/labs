function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/// <cts-enable />
/**
 * A value handed to a pattern along with one of its members is forwarded whole,
 * so the handle covers all of it rather than the member alone.
 */
import { handler, pattern, type ReadonlyCell, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Box {
    first: string;
    second: string;
}
interface ChildInput {
    box: ReadonlyCell<Box>;
    first: ReadonlyCell<string>;
}
const Child = pattern(() => ({}), {
    type: "object",
    properties: {
        box: {
            $ref: "#/$defs/Box",
            asCell: ["readonly"]
        },
        first: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["box", "first"],
    $defs: {
        Box: {
            type: "object",
            properties: {
                first: {
                    type: "string"
                },
                second: {
                    type: "string"
                }
            },
            required: ["first", "second"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema);
export const addChild = handler({
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        box: {
            type: "object",
            properties: {
                first: {
                    type: "string"
                },
                second: {
                    type: "string"
                }
            },
            required: ["first", "second"],
            asCell: ["opaque"]
        },
        made: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["box", "made"]
} as const satisfies __cfHelpers.JSONSchema, (_, { box, made }) => {
    made.push(Child({ box, first: box.first } as any));
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child
});
