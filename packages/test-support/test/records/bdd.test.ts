/**
 * The `describe` and `it` this repository's import map resolves to.
 *
 * What matters is that the wrapper is transparent: every way the real
 * ones can be called still registers, and a call the wrapper does not
 * model reaches the real function untouched rather than being dropped.
 * The shapes below are registered for real, and a run with a capture
 * installed puts each of them through the wrapper. A run without one
 * gets the real functions back, so what the shapes prove there is that
 * the file states them as the real functions accept them; the wrapper's
 * own behavior is asserted against it directly further down, and
 * through a recording run in preload.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { bodyOf, nameOf, wrapDescribe, wrapIt } from "../../src/records/bdd.ts";

describe("bdd", () => {
  describe("the shapes a suite can be declared in", () => {
    // Nested by name and body, which is the ordinary form and the one
    // the chain tracking is built around.

    it("registers a leaf given a name and a body", () => {
      expect(true).toBe(true);
    });

    it({
      name: "registers a leaf given one whole definition",
      fn: () => {
        expect(true).toBe(true);
      },
    });

    it("registers a leaf given a name, options and a body", {
      sanitizeOps: true,
    }, () => {
      expect(true).toBe(true);
    });
  });

  describe({
    name: "a suite declared as one whole definition",
    fn: () => {
      it("still names its leaves by the whole chain", () => {
        expect(true).toBe(true);
      });
    },
  });

  // A suite named by the handle `describe` hands back, rather than by
  // nesting inside its body. Each leaf below reaches the runner through
  // the entry points a test file uses.
  const handle = describe("a suite named by its handle");

  it(handle, "registers a leaf given the suite it belongs to", () => {
    expect(true).toBe(true);
  });

  it({
    suite: handle,
    name: "registers a leaf whose definition names its suite",
    fn: () => {
      expect(true).toBe(true);
    },
  });

  describe(handle, "a suite given the suite it sits under", () => {
    it("registers a leaf beneath both of them", () => {
      expect(true).toBe(true);
    });
  });

  describe("the entry points hanging off each of them", () => {
    it.ignore("is registered as ignored rather than dropped", () => {
      throw new Error("an ignored leaf does not run");
    });

    // `describe.skip` is `describe.ignore` under another name; a suite
    // registered through either still registers, and its leaves are
    // reported as skipped rather than vanishing.
    describe.ignore("a suite registered as ignored", () => {
      it("does not run", () => {
        throw new Error("an ignored suite's leaves do not run");
      });
    });
  });
});

describe("reading the shape of a bdd call", () => {
  const body = () => {};

  it("takes the name from a string, an options object, or a function", () => {
    expect(nameOf(["a name", body])).toBe("a name");
    expect(nameOf([{ name: "from options" }, body])).toBe("from options");
    expect(nameOf([function named() {}])).toBe("named");
    expect(nameOf([{ fn: body }])).toBe("body");
    // A name the call carries stands in place of the body's, whatever
    // its length, and a body with no name of its own gives the empty
    // string. The runner reads both the same way.
    expect(nameOf([{ name: "", fn: body }])).toBe("");
    expect(nameOf([{}, () => {}])).toBe("");
    // A call carrying neither a name nor a body names nothing, and goes
    // to the real function untouched rather than being dropped.
    expect(nameOf([{ no: "name" }])).toBeUndefined();
    expect(nameOf([])).toBeUndefined();
  });

  it("finds the body whether it is an argument or a field", () => {
    expect(bodyOf(["a name", body])).toEqual({ index: 1, body });
    // A definition carrying its own body is reported at index -1,
    // because what has to be replaced is the field rather than the
    // argument.
    expect(bodyOf([{ name: "x", fn: body }])).toEqual({ index: -1, body });
    expect(bodyOf(["a name"])).toBeUndefined();
  });
});

describe("what the wrappers do once a capture is installed", () => {
  /**
   * A capture that skips what a case names, and says what it was asked.
   * One capture stands behind every call, as the installed one does, so
   * the names it was given accumulate in a map a case can read.
   */
  function capturing(skips: readonly string[] = []) {
    const asked: string[] = [];
    const names = new Map<string, string>();
    const capture = {
      names,
      attribute: (name: string, file: string) => {
        names.set(name, file);
      },
      skipped: (_file: string | undefined, name: string) => {
        asked.push(name);
        return skips.includes(name);
      },
      flush: () => {},
    };
    return Object.assign(() => capture, { asked, names });
  }

  it("passes a call it cannot read straight through", () => {
    // An unfamiliar overload still runs and still reports its own
    // error, rather than being dropped by a wrapper that did not
    // recognize it. A `describe` carrying neither a name nor a body is
    // one: it opens no chain and hands back no suite this module can
    // put a chain against. A `describe` carrying a name but no body is
    // not, since that call is where a suite handle comes from.
    const seen: unknown[][] = [];
    const through = (...args: unknown[]) => seen.push(args);
    wrapDescribe(through)();
    wrapIt(through, () => {}, capturing())({ no: "name" });
    expect(seen).toEqual([[], [{ no: "name" }]]);
  });

  it("encloses a leaf in the chain of a suite declared as one definition", () => {
    // The chain has to be pushed around the body wherever the body
    // sits, so a definition carrying its own `fn` has that field
    // replaced rather than an argument. What proves it is the name the
    // capture is asked about: the leaf's own name means the body ran
    // outside the chain, and the joined name means it ran inside.
    const inner = capturing();
    const through = (definition: { name: string; fn: () => void }) => {
      definition.fn();
    };
    const it_ = wrapIt(() => {}, () => {}, inner);
    wrapDescribe(through)({
      name: "outer",
      fn: () => it_("leaf", () => {}),
    });
    expect(inner.asked).toEqual(["outer > leaf"]);
  });

  /** A `describe` that runs the body it is given and hands back a handle. */
  function handing(...args: unknown[]): { symbol: symbol } {
    for (const arg of args) {
      if (typeof arg === "function") (arg as () => void)();
    }
    return { symbol: Symbol("suite") };
  }

  it("puts a leaf under the suite its call names", () => {
    // A leaf can name the suite it belongs to instead of sitting inside
    // it, and the runner reports it under that suite's chain. Nothing
    // encloses the calls below, so the chain the capture is asked about
    // is the handle's or nothing at all.
    const named = capturing();
    const describe_ = wrapDescribe(handing);
    const it_ = wrapIt(() => {}, () => {}, named);
    const outer = describe_("outer");
    const inner = describe_(outer, "inner");
    it_(outer, "direct", () => {});
    it_({ suite: inner, name: "by definition", fn: () => {} });
    expect(named.asked).toEqual([
      "outer > direct",
      "outer > inner > by definition",
    ]);
    // The name map is keyed by the same identity, since that is what
    // ingestion joins a report's names onto.
    expect([...named.names.keys()]).toEqual([
      "outer > direct",
      "outer > inner > by definition",
    ]);
  });

  it("ignores the chain enclosing a call that names its own suite", () => {
    // The chain a call sits in and the chain it names can differ, and
    // the runner reports the named one. A leaf that names no suite in
    // the same body still takes the chain it sits in.
    const named = capturing();
    const describe_ = wrapDescribe(handing);
    const it_ = wrapIt(() => {}, () => {}, named);
    const elsewhere = describe_("elsewhere");
    describe_("lexical", () => {
      it_(elsewhere, "named", () => {});
      it_("enclosed", () => {});
    });
    expect(named.asked).toEqual(["elsewhere > named", "lexical > enclosed"]);
  });

  it("encloses a body in the chain of the suite its call names", () => {
    const named = capturing();
    const describe_ = wrapDescribe(handing);
    const it_ = wrapIt(() => {}, () => {}, named);
    const outer = describe_("outer");
    describe_(outer, "inner", () => it_("leaf", () => {}));
    expect(named.asked).toEqual(["outer > inner > leaf"]);
  });

  it("names a leaf by itself where no suite encloses it", () => {
    const alone = capturing();
    wrapIt(() => {}, () => {}, alone)("bare leaf", () => {});
    expect(alone.asked).toEqual(["bare leaf"]);
  });

  it("names a leaf whose call carries no name after its body", () => {
    const capture = capturing();
    const passed: unknown[] = [];
    const it_ = wrapIt(
      (body: unknown) => passed.push(body),
      () => {},
      capture,
    );
    it_(() => {});
    it_(function kept() {});
    // A body with no name of its own names the leaf with the empty
    // string, which is the last element of the chain the runner reports
    // it under.
    expect(capture.asked).toEqual(["", "kept"]);
    // Each body reaches the real function as it was given rather than
    // through a wrapper of another name, so the name the runner takes
    // from it is the one recorded here.
    expect(passed.map((arg) => bodyOf([arg])?.body.name))
      .toEqual(capture.asked);
  });

  it("names a leaf given an empty name by that name and not its body", () => {
    const capture = capturing();
    wrapIt(() => {}, () => {}, capture)({
      name: "",
      fn: function unused() {},
    });
    expect(capture.asked).toEqual([""]);
  });

  it("registers a listed leaf as ignored rather than running it", () => {
    const ran: string[] = [];
    const ignored: string[] = [];
    const it_ = wrapIt(
      (name: string) => ran.push(name),
      (name: string) => ignored.push(name),
      capturing(["skipped leaf"]),
    );
    it_("kept leaf", () => {});
    it_("skipped leaf", () => {});
    expect(ran).toEqual(["kept leaf"]);
    // Listed rather than dropped, so it appears in the report as
    // skipped and the store learns it was deliberately not run.
    expect(ignored).toEqual(["skipped leaf"]);
  });
});
