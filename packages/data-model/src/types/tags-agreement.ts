/**
 * Compile-time agreement between `FABRIC_CONVERTIBLE_JS_OBJECT_TAGS` and
 * `FabricConvertibleJsObject`: a tag for every member of the type, a member
 * for every tag, and each tag naming the class it stands for. No module
 * imports this one: it exists to be type-checked, which `deno check` does for
 * every module under the package whether or not something imports it, and
 * everything here erases at compile time. `api-agreement.ts` is the same kind
 * of guard for the base classes.
 *
 * Nothing here names a class. A tag is `Js` followed by the name of a global
 * constructor, and that convention is what ties a string to a type: the name
 * is read off the tag, the global of that name is looked up in
 * `typeof globalThis`, and the type the tag stands for is that global's
 * declared `prototype`. The union those types form is held mutually
 * assignable to `FabricConvertibleJsObject`. A tag without a member, a member
 * without a tag, and a tag naming no global constructor -- misspelled,
 * unprefixed, or naming a namespace such as `Math` -- each fail here.
 *
 * Mutual assignability bounds what this catches. A member assignable to one
 * already present -- `TypeError` beside `Error` -- adds nothing the
 * comparison can see, and passes. A prototype declared with `any` type
 * arguments, `Map<any, any>` among them, matches its member however that
 * member's type arguments are written. And a member has to be written the way
 * its class's `prototype` is declared: bare `Uint8Array`, which is
 * `Uint8Array<ArrayBufferLike>`, rather than `Uint8Array<ArrayBuffer>`.
 */

import type { MustBeTrue, Same } from "@commonfabric/utils/types";

import type { FabricConvertibleJsObject } from "@/interface.ts";

import type { FabricConvertibleJsObjectTag } from "./tags.ts";

/**
 * The declared `prototype` of the global named `Name`, or `never` when there
 * is no such global or it declares no `prototype`.
 */
type GlobalPrototype<Name extends string> = Name extends keyof typeof globalThis
  ? typeof globalThis[Name] extends { readonly prototype: infer P } ? P : never
  : never;

/** The class a `Js`-prefixed tag names, or `never` for any other string. */
type ObjectOfTag<Tag extends string> = Tag extends `Js${infer Name}`
  ? GlobalPrototype<Name>
  : never;

/** Whether the classes the tags name are exactly the members of the type. */
export type ObjectsAgree = MustBeTrue<
  Same<ObjectOfTag<FabricConvertibleJsObjectTag>, FabricConvertibleJsObject>
>;
