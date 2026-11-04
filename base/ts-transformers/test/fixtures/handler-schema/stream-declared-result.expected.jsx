function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, cell, handler, pattern, Stream } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface AddTopic {
    title: string;
}
interface AddTopicResult {
    topic: {
        fid: string;
    };
}
interface Verbs {
    addTopic: Stream<AddTopic, AddTopicResult>;
    renameTopic: Stream<AddTopic, AddTopicResult>;
    touch: Stream<AddTopic>;
}
// The other result-authoring surface: `handler`'s THIRD type argument, bound
// to its state at the call site rather than by closure capture.
const renameTopic = handler({
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
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (event, _state) => {
    return { topic: { fid: event.title } };
}, { resultSchema: {
        type: "object",
        properties: {
            topic: {
                type: "object",
                properties: {
                    fid: {
                        type: "string"
                    }
                },
                required: ["fid"]
            }
        },
        required: ["topic"]
    } as const satisfies __cfHelpers.JSONSchema });
const __cfHandler_1 = __cfHelpers.handler({
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
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (event, { count }) => {
    count.set(count.get() + 1);
    return { topic: { fid: event.title } };
}, { resultSchema: {
        type: "object",
        properties: {
            topic: {
                type: "object",
                properties: {
                    fid: {
                        type: "string"
                    }
                },
                required: ["fid"]
            }
        },
        required: ["topic"]
    } as const satisfies __cfHelpers.JSONSchema });
const __cfHandler_2 = __cfHelpers.handler({
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
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { count }) => {
    count.set(count.get() + 1);
});
export default pattern(() => {
    const count = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("count", true);
    // A verb that declares what it produces (verb contract rule 3). The result
    // rides `Stream`'s second type parameter and is opt-in by naming both type
    // arguments — it is never inferred from the body.
    const addTopic = __cfHandler_1({
        count: count
    }).for({ stream: "addTopic" }, true);
    // The value-less shape, unchanged, for contrast.
    const touch = __cfHandler_2({
        count: count
    }).for({ stream: "touch" }, true);
    // Returned against the `Verbs` annotation on `pattern<>` above, so the
    // declared result is LOAD-BEARING here rather than decorative: fixture
    // inputs are type-checked (only `*.expected.*` is excluded from the check
    // task), so if a returning verb ever stops satisfying `Stream<E, R>` this
    // file fails to compile. An earlier revision declared `Verbs` and never
    // returned against it, which asserted nothing.
    return { addTopic: addTopic.for({ stream: ["__patternResult", "addTopic"] }, true), renameTopic: renameTopic({ count }).for({ stream: ["__patternResult", "renameTopic"] }, true), touch: touch.for({ stream: ["__patternResult", "touch"] }, true) };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        addTopic: {
            $ref: "#/$defs/AddTopic",
            asCell: ["stream"]
        },
        renameTopic: {
            $ref: "#/$defs/AddTopic",
            asCell: ["stream"]
        },
        touch: {
            $ref: "#/$defs/AddTopic",
            asCell: ["stream"]
        }
    },
    required: ["addTopic", "renameTopic", "touch"],
    $defs: {
        AddTopic: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: stream-declared-result
// Verifies: a declared result on Stream's second parameter reaches the
//   emitted module, and still satisfies the pattern's own Output annotation.
//   Both authoring surfaces are covered: `action<Event, Result>`, whose
//   lowering to `handler` carries the result into handler's third
//   type-argument slot, and `handler<Event, State, Result>` written
//   directly. Either way the schema lands in the trailing handler options as
//   `{ resultSchema: … }`, which is where the runtime reads it
//   (`builder/module.ts`) to describe a receipt whose result launched a
//   pattern. The value-less `touch` beside them emits no options object at
//   all — the declaration is opt-in, and its absence stays absent.
//
// The result does NOT reach the pattern's own `resultSchema`: the verbs there
// keep the bare `asCell: ["stream"]` marker. That boundary is deliberate.
// `Pattern.resultSchema` is what `assertPatternSchemasBackwardCompatible`
// compares across versions, so a result landing there would make every
// declared verb result permanently binding on the next deploy.
//
// The explicit type-argument form does NOT cost the input schema: `addTopic`
// emits `{title: string}` from `action<AddTopic, …>` with an unannotated
// callback parameter, exactly as `touch` does from an annotated one. Worth
// stating because the opposite is easy to conclude from a hand-rolled
// transform — the schema comes out `true` unless the real `commonfabric`
// types are supplied, which the fixture runner does and an ad-hoc script
// does not.
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    renameTopic,
    __cfHandler_1,
    __cfHandler_2
});
