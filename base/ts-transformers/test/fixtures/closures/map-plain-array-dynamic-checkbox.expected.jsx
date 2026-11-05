function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type SelectedScopes = {
    gmail: boolean;
    calendar: boolean;
};
const SCOPE_DESCRIPTIONS = __cfHelpers.__cf_data({
    gmail: "Gmail",
    calendar: "Calendar",
} as const);
interface Input {
    selectedScopes: SelectedScopes;
}
// FIXTURE: map-plain-array-dynamic-checkbox
// Verifies: plain-array callback roots stay plain while dynamic JSX bindings still lower to a lift-applied computation
//   Object.entries(...).map(fn)                     -> plain .map() remains plain
//   selectedScopes[key as keyof SelectedScopes]     -> lift-applied binding with selectedScopes and key captures
// Context: Dynamic property access in a plain array callback used as a cf-checkbox binding
export default pattern((__cf_pattern_input) => {
    const selectedScopes = __cf_pattern_input.key("selectedScopes");
    return {
        [UI]: (<div>
        {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (<label>
            <cf-checkbox $checked={selectedScopes[key as keyof SelectedScopes]}>
              {description}
            </cf-checkbox>
          </label>))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        selectedScopes: {
            $ref: "#/$defs/SelectedScopes"
        }
    },
    required: ["selectedScopes"],
    $defs: {
        SelectedScopes: {
            type: "object",
            properties: {
                gmail: {
                    type: "boolean"
                },
                calendar: {
                    type: "boolean"
                }
            },
            required: ["gmail", "calendar"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
