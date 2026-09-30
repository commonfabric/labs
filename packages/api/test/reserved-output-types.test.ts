import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  CHIP_UI as CHIP_UI_TYPE,
  FactoryInput,
  FS as FS_TYPE,
  FsProjection,
  NAME as NAME_TYPE,
  PatternFunction,
  TILE_UI as TILE_UI_TYPE,
  UI as UI_TYPE,
  VIEWS as VIEWS_TYPE,
  VNode,
} from "@commonfabric/api";

// The assertions in this file are made when it is type-checked (tasks/check.sh
// runs `deno check` over packages/api), not when it runs. `pattern` and the
// reserved-key symbols are ambient declarations with no runtime value, so they
// are given local compile-time bindings here — typed from the real exports —
// and the calls below are never executed; they sit in a function that is only
// ever type-checked. A valid reserved value must type-check, and each
// `@ts-expect-error` marks a value the reserved-output types must reject — if
// the enforcement regresses, the directive becomes unused and `deno check`
// fails on it.
declare const pattern: PatternFunction;
declare const UI: typeof UI_TYPE;
declare const NAME: typeof NAME_TYPE;
declare const TILE_UI: typeof TILE_UI_TYPE;
declare const CHIP_UI: typeof CHIP_UI_TYPE;
declare const FS: typeof FS_TYPE;
declare const VIEWS: typeof VIEWS_TYPE;

/**
 * A group of facts a host may draw natively, and the field offering it. The
 * two are declared as interfaces on purpose: an interface has no implicit
 * index signature, so a `[VIEWS]` typed `Record<string, unknown>` would reject
 * the very shape a group is written in.
 */
interface InboxView {
  threads: string[];
}
interface OfferedViews {
  inboxView: InboxView;
}
declare const offeredViews: OfferedViews;

declare const reactiveUi: FactoryInput<VNode>;
declare const reactiveName: FactoryInput<string>;
declare const reactiveFs: FactoryInput<FsProjection>;
const plainVNode: VNode = { type: "vnode", name: "div", props: undefined };

function reservedOutputTypeChecks() {
  // Every reserved key with a correct shape, beside the author's own field.
  const valid = pattern(() => ({
    [NAME]: "Counter",
    [UI]: plainVNode,
    [TILE_UI]: plainVNode,
    [CHIP_UI]: plainVNode,
    [FS]: { type: "application/json" as const, content: { rows: 3 } },
    count: 3,
  }));

  // A reactive reserved value (a computed(), a cell) is accepted alongside a
  // plain one, for each key shape.
  const reactive = pattern(() => ({
    [UI]: reactiveUi,
    [NAME]: reactiveName,
    [FS]: reactiveFs,
    count: 3,
  }));

  // A pattern that omits the reserved keys is unaffected.
  const omitted = pattern(() => ({ count: 3 }));

  // A bare non-object return carries no reserved fields and still type-checks.
  const bare = pattern(() => "just a title");

  const badName = pattern(() => ({
    // @ts-expect-error [NAME] must be a string, not a number
    [NAME]: 5,
    count: 3,
  }));

  const badUi = pattern(() => ({
    // @ts-expect-error [UI] must be a VNode or JSXElement, not a number
    [UI]: 5,
    count: 3,
  }));

  // A string is not renderable: guards against [UI] being loosened to accept
  // one, which a number-only rejection would not catch.
  const badUiString = pattern(() => ({
    // @ts-expect-error [UI] must be a VNode or JSXElement, not a string
    [UI]: "not a vnode",
    count: 3,
  }));

  const badTileUi = pattern(() => ({
    // @ts-expect-error [TILE_UI] must be a VNode or JSXElement, not a number
    [TILE_UI]: 5,
    count: 3,
  }));

  const badChipUi = pattern(() => ({
    // @ts-expect-error [CHIP_UI] must be a VNode or JSXElement, not a number
    [CHIP_UI]: 5,
    count: 3,
  }));

  const badFs = pattern(() => ({
    // @ts-expect-error [FS] must be an FsProjection, not a number
    [FS]: 5,
    count: 3,
  }));

  // [VIEWS] holds the named groups this pattern offers. The framework types
  // the field, not its members: what a group holds is the pattern's to declare
  // and a host's to demand through a schema.
  const views = pattern(() => ({
    [UI]: plainVNode,
    [VIEWS]: { inboxView: { threads: ["a"] } },
    count: 3,
  }));

  // An interface-typed value is accepted, which a `Record<string, unknown>`
  // field would reject for want of an index signature.
  const viewsFromInterface = pattern(() => ({
    [UI]: plainVNode,
    [VIEWS]: offeredViews,
    count: 3,
  }));

  const badViews = pattern(() => ({
    // @ts-expect-error [VIEWS] must hold named groups, not a number
    [VIEWS]: 5,
    count: 3,
  }));

  // A string is not a group map: guards against [VIEWS] being loosened to
  // accept anything, which a number-only rejection would not catch.
  const badViewsString = pattern(() => ({
    // @ts-expect-error [VIEWS] must hold named groups, not a string
    [VIEWS]: "inboxView",
    count: 3,
  }));

  // What `object` lets through, recorded rather than left to be discovered.
  //
  // `object` rejects a primitive and nothing else, so an array and a view node
  // both compile under [VIEWS] today even though neither is a map of named
  // groups. That is a decision, not an oversight: the alternative that would
  // reject them, `Record<string, unknown>`, also rejects a group map declared
  // as an `interface` — see `viewsFromInterface` above — and rejecting the
  // idiom a group is written in costs more than admitting two shapes nobody
  // writes by accident. These two pins are here so that tightening the field
  // later is a deliberate act with a test to update, rather than a silent
  // narrowing; the two `@ts-expect-error` cases above would not notice.
  const viewsArrayCompilesToday = pattern(() => ({
    [VIEWS]: [1, 2, 3],
    count: 3,
  }));

  const viewsVNodeCompilesToday = pattern(() => ({
    [VIEWS]: plainVNode,
    count: 3,
  }));

  return {
    valid,
    reactive,
    omitted,
    bare,
    badName,
    badUi,
    badUiString,
    badTileUi,
    badChipUi,
    badFs,
    views,
    viewsFromInterface,
    badViews,
    badViewsString,
    viewsArrayCompilesToday,
    viewsVNodeCompilesToday,
  };
}

describe("reserved-output-types", () => {
  it("type-checks a pattern's reserved output keys at the authoring site", () => {
    // The reject/accept behavior is enforced by the type-checker above; at run
    // time only the carrier holding those checks is observable.
    expect(typeof reservedOutputTypeChecks).toBe("function");
  });
});
