function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { fetchJson, fetchJsonUnchecked } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Repo {
    name: string;
    stars: number;
}
// FIXTURE: fetch-json-schema
// Verifies: fetchJson<T> lowers the T type argument to an injected `schema`
//   property, which the runtime verifies the fetched JSON against. An
//   explicit `schema` parameter wins over injection. fetchJson without a type
//   argument is a compile error; fetchJsonUnchecked is the untyped escape
//   hatch and injects nothing.
export default function TestFetchJsonSchema() {
    const typed = fetchJson<Repo>({
        schema: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                stars: {
                    type: "number"
                }
            },
            required: ["name", "stars"]
        } as const satisfies __cfHelpers.JSONSchema,
        url: "https://example.com/repo.json"
    }).for("typed", true);
    const explicit = fetchJson<Repo>({
        url: "https://example.com/repo.json",
        schema: { type: "object" },
    }).for("explicit", true);
    const untyped = fetchJsonUnchecked({
        url: "https://example.com/free-form.json",
    }).for("untyped", true);
    return { typed, explicit, untyped };
}
__cfHardenFn(TestFetchJsonSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
