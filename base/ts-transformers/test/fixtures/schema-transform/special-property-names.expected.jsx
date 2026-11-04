function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface LinkedData {
    "@link": string;
    "@context": string;
    "@type": string;
    "kebab-case": number;
    "with space": boolean;
    "with-special-chars!": string;
    "default": string;
    "enum": number;
    "class": boolean;
    normalProperty: string;
}
const linkedDataSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        "@link": {
            type: "string"
        },
        "@context": {
            type: "string"
        },
        "@type": {
            type: "string"
        },
        "kebab-case": {
            type: "number"
        },
        "with space": {
            type: "boolean"
        },
        "with-special-chars!": {
            type: "string"
        },
        "default": {
            type: "string"
        },
        "enum": {
            type: "number"
        },
        "class": {
            type: "boolean"
        },
        normalProperty: {
            type: "string"
        }
    },
    required: ["@link", "@context", "@type", "kebab-case", "with space", "with-special-chars!", "default", "enum", "class", "normalProperty"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: special-property-names
// Verifies: toSchema handles property names that are JSON-LD keywords, kebab-case, or JS reserved words
//   toSchema<LinkedData>() → schema with "@link", "kebab-case", "with space", "default", "enum", etc.
// Context: property names requiring quoting; ensures no mangling of special characters
export { linkedDataSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
