function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type Cell, lift, pattern, resultOf, sqliteDatabase, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface User {
    name: string;
}
// FIXTURE: db-query-consumer-decode
// Verifies the CONSUMER half of `_cf_link` auto-decode: reading
// `resultOf(q).rows[0].author_cf_link` off a typed
// `db.query<{ author_cf_link: Cell<User> }>`
// lowers (via the <Row> return type) to a consumer input schema where
// `rows.items.author_cf_link` carries `asCell: ["cell"]`. Combined with the
// runtime storing a sigil OBJECT (Piece A), that asCell read rehydrates the
// column to a live Cell. The cell-ness also survives the lift's RESULT type
// (factory result types are not stripped), so the pattern's result schema for
// `author` carries `asCell: ["cell"]` too — consumers of the pattern get the
// live Cell, not a dereferenced copy.
const readAuthor = lift((qv: {
    rows: Array<{
        author_cf_link: Cell<User>;
    }>;
}) => qv.rows[0]?.author_cf_link, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    author_cf_link: {
                        $ref: "#/$defs/User",
                        asCell: ["cell"]
                    }
                },
                required: ["author_cf_link"]
            }
        }
    },
    required: ["rows"],
    $defs: {
        User: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            $ref: "#/$defs/User",
            asCell: ["cell"]
        }],
    $defs: {
        User: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
export default pattern(() => {
    const db = sqliteDatabase().for("db", true);
    const q = db.query<{
        author_cf_link: Cell<User>;
    }>("SELECT author_cf_link FROM people", {
        rowSchema: {
            type: "object",
            properties: {
                author_cf_link: {
                    $ref: "#/$defs/User",
                    asCell: ["cell"]
                }
            },
            required: ["author_cf_link"],
            $defs: {
                User: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema
    }).for("q", true);
    return { author: readAuthor(resultOf(q)).for(["__patternResult", "author"], true) };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        author: {
            anyOf: [{
                    type: "undefined"
                }, {
                    $ref: "#/$defs/User",
                    asCell: ["cell"]
                }]
        }
    },
    required: ["author"],
    $defs: {
        User: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    readAuthor
});
