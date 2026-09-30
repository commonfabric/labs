// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

/**
 * What the shell does with `/<space>/<collection>/<member>`: which piece it
 * selects, which address it settles on, what it offers to cite, which runtime
 * error it shows as its own, and how the watch behind it behaves as the
 * reference stops and starts resolving.
 *
 * `/<space>/<id>` is here too: settling an id on the slug the space gives it
 * is the rewrite that says the refusals above are about the member, rather
 * than about rewriting at all.
 *
 * The view is driven directly rather than through a runtime. Every fact these
 * tests are about is settled between a resolution's answer and the view's own
 * state, so a stub answering as the worker would is the whole environment they
 * need — and holding a resolution at a chosen outcome is the only way to
 * assert what the view made of it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { type AppView, urlToAppView } from "@commonfabric/navigation";
import { isObjectOrArray } from "@commonfabric/utils/types";

// The reader `cf cell get` takes an address through, which is what a citation
// the view offers has to satisfy. The CLI's package exports only its command
// tree, so the module is reached by path.
import { normalizeLLMFriendlyRef } from "../../cli/lib/llm-friendly-ref.ts";

function installBrowserGlobals(): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  class TestHTMLElement extends EventTarget {
    attachShadow() {
      return {
        adoptedStyleSheets: [],
        appendChild() {},
        append() {},
      };
    }
  }
  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/naming-demo/top/42",
  });
  // Captured but not replaced: `stubRuntime` installs its own timer
  // functions, and recording the originals here is what puts them back. They
  // are process-wide, so a test that left them replaced would quietly stop
  // every later test from scheduling — with nothing going red to say so.
  // Captured but not replaced: `stubRuntime` installs its own timer
  // functions, and recording the originals here is what puts them back.
  for (const name of ["setInterval", "clearInterval"]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/**
 * Record what `console.error` is given, until `restore` puts it back.
 *
 * A test that prints an error it is not about trains a reader to skip this
 * file's output, which is where the next real diagnostic goes missing. Reading
 * the log is also the only way a stub too small for what a collaborator calls
 * shows up at all, where that collaborator logs the failure and carries on.
 */
function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.error = real;
    },
  };
}

/**
 * Every value bound to the property `name` across nested Lit template
 * results, in the order the walk reaches them.
 *
 * A template result carries its literal text in `strings` and its bound
 * values in `values`, in step, so the chunk before a value ends with that
 * binding's own `.name="`. Reading a binding by name is what keeps this off
 * counting positions, which a template gains and loses. Returning every match
 * rather than the first is what tells a binding holding `undefined` from a
 * name nothing binds: the first is `[undefined]` and the second is `[]`.
 */
function templateBindings(value: unknown, name: string): unknown[] {
  if (!isObjectOrArray(value)) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => templateBindings(entry, name));
  }
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  const strings = template.strings ?? [];
  const values = template.values ?? [];
  const bound: unknown[] = [];
  for (let index = 0; index < values.length; index++) {
    if (strings[index]?.endsWith(`.${name}="`)) bound.push(values[index]);
    else bound.push(...templateBindings(values[index], name));
  }
  return bound;
}

/** Where a resolution lands, as the runtime answers it. */
interface Resolved {
  pieceId: string;
  pathAfter: string[];
  scope?: string;
}

/**
 * A reference that reached nothing, as the runtime answers it: a resolved
 * value, not a rejection. Modelling it as a throw would drive the fault path
 * instead — the one a dropped transport takes — and prove nothing about what
 * happens when a name simply is not bound.
 */
interface Refused {
  refusal: { code: string; message: string };
}

/**
 * A runtime error as the view reads one: the space it happened in, the piece
 * it names, and what to tell a reader. The notification a worker sends
 * carries more, and none of the rest decides which view shows it.
 */
interface Reported {
  space: DID;
  pieceId: string;
  message: string;
}

/**
 * A runtime that answers resolutions from a value the test controls, over a
 * slug cell whose poll the test fires by hand.
 *
 * The interval is captured rather than scheduled. A wait on wall-clock time
 * would decide nothing these tests are about, and the callback is the subject:
 * firing it is how a test says "the reference was re-resolved" without
 * standing still for a second to let it happen.
 */
interface StubRuntime {
  /** Stands in for `RuntimeInternals`. */
  rt: unknown;

  /** The arguments of each resolution, in order. */
  resolved: unknown[][];

  /** The arguments of each `getPattern`, in order. */
  started: unknown[][];

  /** How many times the slug subscription has been cancelled. */
  cancels: number;

  /** Answer every resolution from here on with `next`. */
  answer(next: Resolved | Refused | Error): void;

  /** Fire the watch's poll once, and let what it starts settle. */
  poll(): Promise<void>;

  /** Let the subscription's own opening settle, without firing the poll. */
  settle(): Promise<void>;

  /** Fail every piece load from here on, or none when given `undefined`. */
  failLoads(error: Error | undefined): void;

  /** Hold every piece load from here on, to be released by hand. */
  holdLoads(): void;

  /** Release the held loads and let what they finish settle. */
  releaseLoads(): Promise<void>;

  /** Hold every answer from here on, to be released by hand. */
  hold(): void;

  /** Release the oldest held answer, and let what it finishes settle. */
  releaseOldest(): Promise<void>;

  /** Release the newest held answer, and let what it finishes settle. */
  releaseNewest(): Promise<void>;

  /** Release the held answers, newest first. */
  releaseNewestFirst(): Promise<void>;

  /**
   * Name every piece from here on with `slug`, or with nothing when given
   * `undefined`.
   */
  nameWithSlug(slug: string | undefined): void;
}

function stubRuntime(
  first: Resolved | Refused | Error,
  aborted = false,
): StubRuntime {
  const resolved: unknown[][] = [];
  const started: unknown[][] = [];
  let answer = first;
  let poll: (() => void) | undefined;
  let pieceSlug: string | undefined;
  const stub: StubRuntime = {
    resolved,
    started,
    cancels: 0,
    answer: (next) => {
      answer = next;
    },
    nameWithSlug: (slug) => {
      pieceSlug = slug;
    },
    poll: async () => {
      poll?.();
      // A resolution and the reload it may start are each a microtask hop.
      for (let hop = 0; hop < 4; hop++) await Promise.resolve();
    },
    settle: async () => {
      for (let hop = 0; hop < 6; hop++) await Promise.resolve();
    },
    rt: undefined,
    failLoads: () => {},
    holdLoads: () => {},
    releaseLoads: async () => {},
    hold: () => {},
    releaseOldest: async () => {},
    releaseNewest: async () => {},
    releaseNewestFirst: async () => {},
  };
  let loadFailure: Error | undefined;
  stub.failLoads = (error) => {
    loadFailure = error;
  };
  let heldLoads: Array<() => void> | undefined;
  stub.holdLoads = () => {
    heldLoads = [];
  };
  stub.releaseLoads = async () => {
    const pending = heldLoads ?? [];
    heldLoads = undefined;
    for (const release of pending) release();
    for (let hop = 0; hop < 6; hop++) await Promise.resolve();
  };
  let held: Array<() => void> | undefined;
  stub.hold = () => {
    held = [];
  };
  stub.releaseOldest = async () => {
    held?.shift()?.();
    for (let hop = 0; hop < 6; hop++) await Promise.resolve();
  };
  stub.releaseNewest = async () => {
    held?.pop()?.();
    for (let hop = 0; hop < 6; hop++) await Promise.resolve();
  };
  stub.releaseNewestFirst = async () => {
    const pending = held ?? [];
    held = undefined;
    for (const release of [...pending].reverse()) release();
    for (let hop = 0; hop < 6; hop++) await Promise.resolve();
  };
  stub.rt = {
    signal: { aborted },
    // A named space resolves to its DID before anything else runs; these
    // tests address one space and it is the one they were handed.
    resolveSpaceName: () => Promise.resolve(SPACE),
    resolveSlug: (...args: unknown[]) => {
      resolved.push(args);
      const settled = answer instanceof Error
        ? Promise.reject(answer)
        : "refusal" in answer
        ? Promise.resolve(answer)
        : Promise.resolve({ scope: "space", ...answer });
      settled.catch(() => {});
      if (!held) return settled;
      // Held: the caller decides when this answer lands, and in what order
      // relative to the calls made after it.
      const queue = held;
      return new Promise((resolve, reject) => {
        queue.push(() => settled.then(resolve, reject));
      });
    },
    getPattern: (...args: unknown[]) => {
      started.push(args);
      if (loadFailure) return Promise.reject(loadFailure);
      const loaded = { id: () => "fid1:whatever" };
      if (!heldLoads) return Promise.resolve(loaded);
      const queue = heldLoads;
      return new Promise((resolve) => {
        queue.push(() => resolve(loaded));
      });
    },
    // What handing a runtime to the view's debugger controller reads, here
    // and on what `runtime()` returns. A replacement runtime goes through
    // that hand-off on its way to the watch, and the controller reports a
    // member it cannot call by logging rather than by throwing — so the case
    // driving that hand-off reads the log, and a member missing from here
    // fails it.
    addEventListener: () => {},
    removeEventListener: () => {},
    telemetry: () => [],
    runtime: () => ({
      setTelemetryEnabled: () => Promise.resolve(),
      setBreakpoints: () => Promise.resolve(),
    }),
    getSlug: () => Promise.resolve(pieceSlug),
    getSlugCell: () =>
      Promise.resolve({
        subscribe: () => () => {
          stub.cancels++;
        },
      }),
    invalidatePattern: () => {},
  };
  // Replaced, never scheduled: the poll is the subject, and firing it by
  // hand is what a test does instead of standing still for a second.
  // `installBrowserGlobals` captured these and puts them back.
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: (callback: () => void) => {
      poll = callback;
      return 0 as unknown as number;
    },
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    writable: true,
    value: () => {},
  });
  return stub;
}

const SPACE = "did:key:z6Mk-shell-collection-member" as DID;

/** A second space, for the cases that turn on which space is being read. */
const OTHER_SPACE = "did:key:z6Mk-shell-collection-member-other" as DID;

/**
 * The timer functions as this module found them, before any test ran. Every
 * test here replaces them, and they are process-wide.
 */
const NATIVE_TIMERS = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
} as const;

/**
 * Fire the watch's poll, and let the selection run if the watch asked for it.
 *
 * That second half is what Lit does when `_slugRevision` changes, and it is
 * what marks a resolution APPLIED — the view has come to show what the answer
 * named. A test that polls without it leaves every answer unapplied, which is
 * a state the shell never sits in.
 */
async function pollAndSettle(
  view: AppViewLike,
  stub: StubRuntime,
): Promise<void> {
  const before = view.accessForTestingOnly.slugRevision;
  await stub.poll();
  if (view.accessForTestingOnly.slugRevision === before) return;
  view._selectedPattern.run();
  await view._selectedPattern.taskComplete.catch(() => {});
}

/** A view of the demo space holding `overrides`. */
function viewOf(overrides: Record<string, unknown>): AppView {
  return { spaceName: "naming-demo", ...overrides } as AppView;
}

/**
 * What these tests set and read. All of it is the view's public surface
 * except the slug revision, which comes through the class's own testing
 * accessor: typed as the class types it, so a renamed member is a type error
 * rather than an `undefined` that every comparison here would accept.
 */
interface AppViewLike {
  app: unknown;
  space: DID | undefined;
  rt: unknown;
  runtimeLoadErrors: readonly Reported[];
  render(): unknown;
  updated(changed: Map<string, unknown>): void;
  _selectedPattern: { run(): void; taskComplete: Promise<unknown> };
  readonly accessForTestingOnly: { readonly slugRevision: number };
}

/** A view element wired to `stub` and addressing `view`. */
function appViewOver(
  XAppView: new () => unknown,
  stub: StubRuntime,
  view: AppView,
): AppViewLike {
  const element = new XAppView() as AppViewLike;
  element.app = { identity: {}, config: {}, view };
  element.space = SPACE;
  element.rt = stub.rt;
  return element;
}

/**
 * The reference `view` hands its header to copy, or `undefined` where it
 * offers none. Read off the binding rather than out of the rendered text, so
 * an offer is found whatever it is spelled as.
 */
function citedReference(view: AppViewLike): string | undefined {
  const bound = templateBindings(view.render(), "pieceReference");
  // One header, so one binding: none would mean the header is gone, which
  // this would otherwise read as a view offering nothing.
  expect(bound).toHaveLength(1);
  return bound[0] as string | undefined;
}

/**
 * What each reader of a cited reference takes it to name: the reader `cf cell
 * get` takes an address through, and this shell's page reader opening it
 * under an origin, as a browser does with the reference pasted after one.
 */
function readBothWays(reference: string | undefined): {
  cf: unknown;
  page: AppView;
} {
  return {
    cf: normalizeLLMFriendlyRef(String(reference)),
    page: urlToAppView(new URL(`http://page.invalid${reference}`)),
  };
}

/**
 * Drive `view` into the state the cases below turn on: the watch it was
 * running has been replaced, that watch's resolution is still out, and the
 * watch that replaced it is the one now resolving.
 *
 * The address moves off member `42`, which callers open on, and onto member
 * `43`. That is a different reference and so a different watch. Answers are
 * held from before the move, so the outgoing watch's resolution is still out
 * when the incoming one starts. The incoming watch's first answer is
 * released, because opening its poll and its subscription is what that first
 * answer finishing does.
 */
async function replaceWatchMidResolution(
  view: AppViewLike,
  stub: StubRuntime,
): Promise<void> {
  view.updated(new Map([["app", undefined]]));
  await stub.settle();

  stub.hold();
  await stub.poll();

  view.app = {
    identity: {},
    config: {},
    view: viewOf({ pieceSlug: "top", pieceMember: "43" }),
  };
  view.updated(new Map([["app", undefined]]));
  await stub.settle();

  await stub.releaseNewest();
}

describe("AppView collection members", () => {
  it("selects the member the reference names", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(stub.resolved).toEqual([[SPACE, "top", "42"]]);
      // The piece started is the one the reference resolved to, never the
      // document the slug itself lives in — and it is loaded in the scope
      // the resolution reached it in, which its id alone does not carry.
      expect(stub.started).toEqual([
        [SPACE, "fid1:member-42", { scope: "space" }],
      ]);
    } finally {
      restore();
    }
  });

  it("cites a member by a reference carrying its own space", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      const reference = citedReference(view);
      expect(reference).toBe("//naming-demo/top/42");
      // Each reader takes it for the collection, the member that collection
      // selects, and the space both are read in, with no binding supplied.
      expect(readBothWays(reference)).toEqual({
        cf: { pieceId: "top", embeddedSpace: "naming-demo", path: [42] },
        page: {
          spaceName: "naming-demo",
          pieceSlug: "top",
          pieceMember: "42",
        },
      });
    } finally {
      restore();
    }
  });

  it("cites a member of a space opened by DID by a reference carrying that DID", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(XAppView as never, stub, {
        spaceDid: SPACE,
        pieceSlug: "top",
        pieceMember: "42",
      });

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      const reference = citedReference(view);
      expect(reference).toBe(`//${SPACE}/top/42`);
      expect(readBothWays(reference)).toEqual({
        cf: { pieceId: "top", embeddedSpace: SPACE, path: [42] },
        page: { spaceDid: SPACE, pieceSlug: "top", pieceMember: "42" },
      });
    } finally {
      restore();
    }
  });

  it("cites a member of a space whose name the reference grammar cannot write by the DID the name resolved to", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      // `@` opens a qualifier in the grammar, so no reference can carry this
      // name as its space. The shell resolves it all the same.
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({
          spaceName: "naming@demo",
          pieceSlug: "top",
          pieceMember: "42",
        }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      const reference = citedReference(view);
      expect(reference).toBe(`//${SPACE}/top/42`);
      expect(readBothWays(reference)).toEqual({
        cf: { pieceId: "top", embeddedSpace: SPACE, path: [42] },
        page: { spaceDid: SPACE, pieceSlug: "top", pieceMember: "42" },
      });
    } finally {
      restore();
    }
  });

  it("cites a space by name only where a page address keeps the name as written", async () => {
    // A page URL percent-encodes a space character and a non-ASCII one, and
    // resolves a dot segment away; the page reader takes an escaped `@` at
    // the head of a space for its mark, and a name that is `..` reaches the
    // page the segments after it name. Each such name would open another
    // space, so each is cited by the DID it resolved to. A URL keeps the
    // escape in the last name as written, and both readers read it back as
    // that name, so it is cited by it.

    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const cases = [
        { spaceName: "demo space", cited: SPACE },
        { spaceName: "my space", cited: SPACE },
        { spaceName: "caf\u00e9", cited: SPACE },
        { spaceName: "..", cited: SPACE },
        { spaceName: "%40demo", cited: SPACE },
        { spaceName: "demo%20space", cited: "demo%20space" },
      ];
      const outcomes = [];
      for (const { spaceName } of cases) {
        const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
        const view = appViewOver(
          XAppView as never,
          stub,
          viewOf({ spaceName, pieceSlug: "top", pieceMember: "42" }),
        );
        view._selectedPattern.run();
        await view._selectedPattern.taskComplete;
        const reference = citedReference(view);
        outcomes.push({ spaceName, reference, read: readBothWays(reference) });
      }
      expect(outcomes).toEqual(cases.map(({ spaceName, cited }) => ({
        spaceName,
        reference: `//${cited}/top/42`,
        read: {
          cf: { pieceId: "top", embeddedSpace: cited, path: [42] },
          page: {
            ...(cited === SPACE ? { spaceDid: SPACE } : { spaceName: cited }),
            pieceSlug: "top",
            pieceMember: "42",
          },
        },
      })));
    } finally {
      restore();
    }
  });

  it("cites a member the reference's two readers read alike, and no other", async () => {
    // A member name reaches the grammar as a JSON Pointer token and the page
    // reader as a URL segment, and the two disagree on a name carrying a
    // pointer escape or one a URL path rewrites. No spelling settles that: a
    // literal `a~1b` reaches the grammar as `a/b`, and the `a~01b` that
    // reaches it as `a~1b` reaches the page reader as `a~01b`. So a member
    // there is no one address for is cited by none, rather than by an address
    // naming a different member of the same collection.
    //
    // Every name the collection-naming library issues is a canonical decimal
    // (`isMemberName` in `packages/patterns/collection-naming/allocator.ts`),
    // and every name the slug grammar admits is read alike by both, so the
    // first two rows are the members a shipped collection has.

    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const cases = [
        { pieceMember: "42", cited: "//naming-demo/top/42" },
        {
          pieceMember: "glaze-recipes",
          cited: "//naming-demo/top/glaze-recipes",
        },
        { pieceMember: "a~1b", cited: undefined },
        { pieceMember: "a b", cited: undefined },
      ];
      const outcomes = [];
      for (const { pieceMember } of cases) {
        const stub = stubRuntime({ pieceId: "fid1:member", pathAfter: [] });
        const view = appViewOver(
          XAppView as never,
          stub,
          viewOf({ pieceSlug: "top", pieceMember }),
        );
        view._selectedPattern.run();
        await view._selectedPattern.taskComplete;
        // The member is on screen either way, so what the rows differ in is
        // the citation rather than whether the page opened.
        outcomes.push({
          pieceMember,
          opened: stub.started.map((call) => call[1]),
          cited: citedReference(view),
        });
      }
      expect(outcomes).toEqual(cases.map(({ pieceMember, cited }) => ({
        pieceMember,
        opened: ["fid1:member"],
        cited,
      })));
    } finally {
      restore();
    }
  });

  it("cites nothing for a reference that stops at the collection", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:board", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // A collection's name with no member after it names no member, so
      // there is nothing for a citation to resolve to.
      expect(citedReference(view)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("refuses a member after a slug naming a piece at its root, for as long as the slug names one", async () => {
    const restore = installBrowserGlobals();
    const errors = captureErrors();
    const replaced: AppView[] = [];
    const listener = (event: Event) => {
      replaced.push((event as CustomEvent<AppView>).detail);
    };
    globalThis.addEventListener("cf-replace-navigation", listener);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      // A slug naming a piece at its root spends no segment, so the walk
      // hands the member back: it names nothing in that piece.
      const stub = stubRuntime({ pieceId: "fid1:plain", pathAfter: ["42"] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "plain", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});

      // Only resolving says what the slug names, so the reference is
      // resolved. The piece it reached is not opened, and the address stays
      // as it was written rather than settling on that piece's.
      expect(stub.resolved.at(-1)).toEqual([SPACE, "plain", "42"]);
      expect(stub.started).toEqual([]);
      expect(replaced).toEqual([]);
      const [loadError] = templateBindings(view.render(), "loadError") as [
        { kind: string; error: Error },
      ];
      expect(loadError.kind).toBe("piece");
      expect(loadError.error.message).toBe(
        "no member 42 in plain, which names a piece rather than a collection",
      );
      // Nothing offers `//naming-demo/plain/42`, which would cite a cell
      // inside the piece rather than anything the reader is looking at.
      expect(citedReference(view)).toBeUndefined();

      // The same answer again is the refusal already on screen, so nothing
      // reloads.
      const refused = view.accessForTestingOnly.slugRevision;
      await pollAndSettle(view, stub);
      expect(view.accessForTestingOnly.slugRevision).toBe(refused);

      // Bound to a collection holding the member, the address names one.
      stub.answer({ pieceId: "fid1:member-42", pathAfter: [] });
      await pollAndSettle(view, stub);
      expect(stub.started.map((call) => call[1])).toEqual(["fid1:member-42"]);
    } finally {
      globalThis.removeEventListener("cf-replace-navigation", listener);
      errors.restore();
      restore();
    }
  });

  it("settles an address naming a piece by id on the slug that names it", async () => {
    // Refusing a member is about the member. An address the space can name
    // better is still written back, and this is the case that does it: the
    // slug stands in for the id, and every other field of the view — the
    // space, the mode it is read in — comes through untouched.

    const restore = installBrowserGlobals();
    const replaced: AppView[] = [];
    const listener = (event: Event) => {
      replaced.push((event as CustomEvent<AppView>).detail);
    };
    globalThis.addEventListener("cf-replace-navigation", listener);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:plain", pathAfter: [] });
      stub.nameWithSlug("top");
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceId: "fid1:plain", mode: "embed" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(replaced).toEqual([{
        spaceName: "naming-demo",
        pieceSlug: "top",
        mode: "embed",
      }]);
    } finally {
      globalThis.removeEventListener("cf-replace-navigation", listener);
      restore();
    }
  });

  it("leaves an address naming a piece by id alone when the name the space gives it is no slug", async () => {
    // A name carrying a separator would write two segments where the address
    // holds one, and the second would read back as a member.

    const restore = installBrowserGlobals();
    const replaced: AppView[] = [];
    const listener = (event: Event) => {
      replaced.push((event as CustomEvent<AppView>).detail);
    };
    globalThis.addEventListener("cf-replace-navigation", listener);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:plain", pathAfter: [] });
      stub.nameWithSlug("top/42");
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceId: "fid1:plain" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(replaced).toEqual([]);
    } finally {
      globalThis.removeEventListener("cf-replace-navigation", listener);
      restore();
    }
  });

  it("opens nothing for an address naming segments past its member, and names them", async () => {
    const restore = installBrowserGlobals();
    const errors = captureErrors();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      // Member 42 is there to be opened, so opening nothing is the address's
      // doing rather than the collection's.
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({
          pieceSlug: "top",
          pieceMember: "42",
          pieceExtraPath: "comments/7",
        }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});

      // Decided from the address: nothing is resolved, watched, or loaded.
      expect(stub.resolved).toEqual([]);
      expect(stub.started).toEqual([]);
      const [loadError] = templateBindings(view.render(), "loadError") as [
        { kind: string; error: Error },
      ];
      expect(loadError.kind).toBe("piece");
      expect(loadError.error.message).toBe(
        "no piece at comments/7 after member 42 in top, since nothing past a member resolves",
      );
      expect(citedReference(view)).toBeUndefined();
    } finally {
      errors.restore();
      restore();
    }
  });

  it("stops watching a member once the address names segments past it", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      // The longer address names no reference to follow, so the member's
      // watch ends with it and nothing resolves for it afterwards.
      view.app = {
        identity: {},
        config: {},
        view: viewOf({
          pieceSlug: "top",
          pieceMember: "42",
          pieceExtraPath: "comments/7",
        }),
      };
      view.updated(new Map([["app", undefined]]));
      const asked = stub.resolved.length;
      await stub.poll();

      expect(stub.cancels).toBe(1);
      expect(stub.resolved.length).toBe(asked);
    } finally {
      restore();
    }
  });

  it("re-resolves the reference until it reaches somewhere else", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();
      const asked = stub.resolved.length;

      stub.answer({ pieceId: "fid1:member-42-replaced", pathAfter: [] });
      await stub.poll();

      // Re-resolving is what notices a member pointed elsewhere; no event
      // reports it, the slug document being the only thing watched.
      expect(stub.resolved.length).toBeGreaterThan(asked);
      expect(stub.resolved.at(-1)).toEqual([SPACE, "top", "42"]);
    } finally {
      restore();
    }
  });

  it("opens a member that only arrives later", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({
        refusal: { code: "missing-member", message: "no member 42 in top" },
      });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await pollAndSettle(view, stub);
      const afterFailing = view.accessForTestingOnly.slugRevision;

      // The same refusal again is no news — it is the answer the view is
      // already showing — so nothing reloads.
      stub.answer({
        refusal: { code: "missing-member", message: "no member 42 in top" },
      });
      await pollAndSettle(view, stub);
      expect(view.accessForTestingOnly.slugRevision).toBe(afterFailing);

      // The member appearing is news, and the reload it triggers goes and
      // gets it.
      stub.answer({ pieceId: "fid1:member-42", pathAfter: [] });
      await stub.poll();
      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(
        afterFailing,
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      expect(stub.started.map((call) => call[1])).toContain("fid1:member-42");
    } finally {
      restore();
    }
  });

  it("stops citing a member once the collection stops holding one", async () => {
    const restore = installBrowserGlobals();
    const replaced: AppView[] = [];
    const listener = (event: Event) => {
      replaced.push((event as CustomEvent<AppView>).detail);
    };
    globalThis.addEventListener("cf-replace-navigation", listener);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      view.updated(new Map([["app", undefined]]));
      await stub.poll();
      expect(citedReference(view)).toBe("//naming-demo/top/42");

      // `top` is repointed at that very piece's own root. The reference now
      // reaches the SAME piece and spends nothing, so member 42 names nothing
      // in it. A comparison holding only the piece calls this no change, and
      // everything derived from the member standing would go on standing
      // under an address that no longer names one.
      const before = view.accessForTestingOnly.slugRevision;
      stub.answer({ pieceId: "fid1:member-42", pathAfter: ["42"] });
      await stub.poll();

      // The watch has to see this as a new answer. It is the only thing that
      // reruns the selection, and everything below is what the rerun settles.
      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(before);

      const errors = captureErrors();
      try {
        view._selectedPattern.run();
        await view._selectedPattern.taskComplete.catch(() => {});
      } finally {
        errors.restore();
      }

      // The rerun refuses the member rather than settling the address on the
      // piece, and cites nothing.
      expect(replaced).toEqual([]);
      const [loadError] = templateBindings(view.render(), "loadError") as [
        { kind: string; error: Error },
      ];
      expect(loadError.error.message).toBe(
        "no member 42 in top, which names a piece rather than a collection",
      );
      expect(citedReference(view)).toBeUndefined();
    } finally {
      globalThis.removeEventListener("cf-replace-navigation", listener);
      restore();
    }
  });

  it("reloads when only the scope of the answer changes", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({
        pieceId: "fid1:member-42",
        pathAfter: [],
        scope: "space",
      });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();
      const before = view.accessForTestingOnly.slugRevision;

      // Same piece, same leftover, different scope: a different document,
      // and the only field that says so. A comparison built from a list of
      // fields is one this walks straight past.
      stub.answer({
        pieceId: "fid1:member-42",
        pathAfter: [],
        scope: "user",
      });
      await stub.poll();

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(before);
    } finally {
      restore();
    }
  });

  it("opens a member that arrives while the watch is still opening", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      // The selected task refuses: member 42 is not there yet.
      const stub = stubRuntime({
        refusal: { code: "missing-member", message: "no member 42 in top" },
      });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});
      const before = view.accessForTestingOnly.slugRevision;

      // The member lands in the window between that failure and the watch's
      // first resolution, so the watch's FIRST answer already differs from
      // what the task saw. Nothing later reports it: the failed task does not
      // rerun on its own, and every poll after this one matches what the
      // first recorded.
      stub.answer({ pieceId: "fid1:member-42", pathAfter: [] });
      view.updated(new Map([["app", undefined]]));
      await stub.settle();

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(before);
    } finally {
      restore();
    }
  });

  it("resolves one at a time, coalescing a poll fired while one is running", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:first", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();

      // The resolver is slower than the interval, so a second poll fires
      // while the first is still out.
      stub.hold();
      const before = stub.resolved.length;
      await stub.poll();
      await stub.poll();
      await stub.poll();

      // One in flight, whatever the polls did — two answers at once is the
      // whole of the ordering problem, and there is never a second.
      expect(stub.resolved.length).toBe(before + 1);

      // What the extra polls asked for is not lost: one more resolution runs
      // as soon as the first finishes.
      await stub.releaseNewestFirst();
      expect(stub.resolved.length).toBe(before + 2);
    } finally {
      restore();
    }
  });

  it("keeps to one resolution in flight when a replaced watch's answer lands", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:first", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      await replaceWatchMidResolution(view, stub);

      // The watch the view is running has a resolution out of its own.
      await stub.poll();
      const inFlight = stub.resolved.length;

      // The replaced watch's answer lands, and ends the run it started. The
      // run still out is the running watch's, and is not the replaced
      // watch's to end — so a poll behind it finds one running, and
      // coalesces.
      await stub.releaseOldest();
      await stub.poll();

      expect(stub.resolved.length).toBe(inFlight);
    } finally {
      restore();
    }
  });

  it("re-resolves for its own coalesced request when a replaced watch's answer lands", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:first", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      await replaceWatchMidResolution(view, stub);

      // The watch the view is running has a resolution out and a poll
      // coalesced behind it.
      await stub.poll();
      await stub.poll();

      // The replaced watch's answer lands. The request coalesced behind the
      // running watch's resolution was asked of that watch, and is still that
      // watch's to answer.
      await stub.releaseOldest();
      const asked = stub.resolved.length;

      await stub.releaseNewestFirst();

      expect(stub.resolved.length).toBe(asked + 1);
    } finally {
      restore();
    }
  });

  it("applies an answer that took longer than the poll interval", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:first", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      const before = view.accessForTestingOnly.slugRevision;

      // A slow resolution finds the reference somewhere new. Under a guard
      // that asks "am I the newest ISSUED", the polls behind it would each
      // supersede it and the view would never learn anything at all.
      stub.hold();
      stub.answer({ pieceId: "fid1:moved", pathAfter: [] });
      await stub.poll();
      await stub.poll();
      await stub.releaseNewestFirst();

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(before);
    } finally {
      restore();
    }
  });

  it("does not call a slow load's answer the newer one that arrived meanwhile", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:A", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );
      view.updated(new Map([["app", undefined]]));
      await stub.settle();

      // The selection resolves A and waits in the load.
      stub.holdLoads();
      view._selectedPattern.run();
      await stub.settle();

      // The reference moves to B while that load is out, and the watch asks
      // for a rerun.
      stub.answer({ pieceId: "fid1:B", pathAfter: [] });
      await stub.poll();

      // A's load finishes. What is on screen is A, and saying so is all it
      // may say: reporting "the newest answer is showing" would claim B.
      await stub.releaseLoads();
      const afterA = view.accessForTestingOnly.slugRevision;

      // So a resolution finding B is still news, and the view goes and gets
      // it rather than taking an early return on a claim that it already has.
      await stub.poll();
      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(afterA);
    } finally {
      restore();
    }
  });

  it("reloads when one refusal gives way to a different one", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      // `top` is not bound at all, so the reader is told the name is not
      // found.
      const stub = stubRuntime({
        refusal: { code: "missing", message: 'Slug "top" not found.' },
      });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "999" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      const before = view.accessForTestingOnly.slugRevision;

      // `top` is then bound to a collection that has no member 999. Still a
      // refusal, and a different one: keeping the first would leave the
      // reader on the wrong error about the wrong thing.
      stub.answer({
        refusal: { code: "missing-member", message: "no member 999 in top" },
      });
      await stub.poll();

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(before);
    } finally {
      restore();
    }
  });

  it("clears the load error when a faulted resolution comes back to the piece already shown", async () => {
    const restore = installBrowserGlobals();
    const errors = captureErrors();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // The selection runs again and stops in the resolution — a dropped
      // transport, which says nothing about where the reference points. The
      // view is on the error, and the reference has not moved.
      stub.answer(new Error("the socket went away"));
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});
      expect(errors.lines).toEqual([
        "[AppView] Failed to load selected piece: Error: the socket went away",
      ]);

      // The transport comes back and the reference resolves as it did before.
      // Recovery has to come from the faulted run having reported that it
      // reached nothing: an answer left standing would make this one no news,
      // and the view would sit on the error with the piece it names one
      // resolution away.
      stub.answer({ pieceId: "fid1:member-42", pathAfter: [] });
      await pollAndSettle(view, stub);

      expect(templateBindings(view.render(), "loadError")).toEqual([undefined]);
    } finally {
      errors.restore();
      restore();
    }
  });

  it("shows a refusal in the words it was refused in", async () => {
    const restore = installBrowserGlobals();
    const errors = captureErrors();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({
        refusal: { code: "missing-member", message: "no member 42 in top" },
      });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});

      // A refusal is an answer, and the load-error surface tells a reader
      // what it said. The words travel as the error the run throws rather
      // than through what it records as shown, so nothing about the recorded
      // answer decides them and this is the only place they are checked.
      const [loadError] = templateBindings(view.render(), "loadError") as [
        { kind: string; error: Error },
      ];
      expect(loadError.kind).toBe("piece");
      expect(loadError.error.message).toBe("no member 42 in top");
    } finally {
      errors.restore();
      restore();
    }
  });

  it("retries a load that failed after the reference resolved", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      // The reference resolves, and loading the piece it names fails — a
      // dropped connection, say. The answer is identified and the view is
      // not showing it.
      stub.failLoads(new Error("the socket went away"));
      view.updated(new Map([["app", undefined]]));
      await pollAndSettle(view, stub);
      const afterFailedLoad = view.accessForTestingOnly.slugRevision;

      // Nothing about the reference has changed, so no later poll brings a
      // new answer. Recovery has to come from the answer still being
      // unhandled — otherwise the view sits on the error for good.
      stub.failLoads(undefined);
      await pollAndSettle(view, stub);

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(
        afterFailedLoad,
      );
      expect(stub.started.map((call) => call[1])).toContain("fid1:member-42");
    } finally {
      restore();
    }
  });

  it("retries a load that failed after the watch behind it was replaced", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const first = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        first,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      // A piece is on screen, so an answer is recorded.
      view.updated(new Map([["app", undefined], ["rt", undefined]]));
      await first.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // A replacement runtime takes over. It reaches the same answer, and the
      // load of it fails — so what the recorded answer names is not what is
      // on screen, and the answer alone cannot say so.
      const replacement = stubRuntime({
        pieceId: "fid1:member-42",
        pathAfter: [],
      });
      replacement.failLoads(new Error("the socket went away"));
      view.rt = replacement.rt;
      view.updated(new Map([["rt", undefined]]));
      await replacement.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});
      const afterFailedLoad = view.accessForTestingOnly.slugRevision;

      // Nothing about the reference changed, so no later answer differs from
      // the one recorded. Recovery has to come from the run having reported
      // that it reached nothing to show.
      replacement.failLoads(undefined);
      await replacement.poll();

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(
        afterFailedLoad,
      );
    } finally {
      restore();
    }
  });

  it("retries a load that failed with the reference and its watch unchanged", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined], ["rt", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // A new app state naming the same reference: every input the watch is
      // built from is what it was, so the running watch stands and no
      // teardown runs at all. The selection runs again anyway, and its load
      // fails.
      view.app = {
        identity: {},
        config: {},
        view: viewOf({ pieceSlug: "top", pieceMember: "42" }),
      };
      view.updated(new Map([["app", undefined]]));
      await stub.settle();
      stub.failLoads(new Error("the socket went away"));
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete.catch(() => {});
      const afterFailedLoad = view.accessForTestingOnly.slugRevision;

      stub.failLoads(undefined);
      await stub.poll();

      expect(view.accessForTestingOnly.slugRevision).toBeGreaterThan(
        afterFailedLoad,
      );
      expect(stub.started.map((call) => call[1])).toContain("fid1:member-42");
    } finally {
      restore();
    }
  });

  it("watches each slug separately", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-1", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "1" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      // A different collection is a different reference, whatever the member
      // after it is called.
      view.app = {
        identity: {},
        config: {},
        view: viewOf({ pieceSlug: "side", pieceMember: "1" }),
      };
      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      expect(stub.cancels).toBe(1);
      expect(stub.resolved.map((call) => call[1])).toContain("side");
    } finally {
      restore();
    }
  });

  it("watches each space separately", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-1", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "1" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      // One name reads to one piece in one space and to another elsewhere,
      // so the space the reference is read in is part of what it names.
      view.space = OTHER_SPACE;
      view.app = {
        identity: {},
        config: {},
        view: viewOf({
          spaceName: "other-demo",
          pieceSlug: "top",
          pieceMember: "1",
        }),
      };
      view.updated(new Map([["app", undefined], ["space", undefined]]));
      await stub.poll();

      expect(stub.cancels).toBe(1);
      expect(stub.resolved.map((call) => call[0])).toContain(OTHER_SPACE);
    } finally {
      restore();
    }
  });

  it("watches each reference through a slug separately", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-1", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "1" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      // Two members of one collection are two references reaching two
      // pieces, so the second cannot ride the first's subscription.
      view.app = {
        identity: {},
        config: {},
        view: viewOf({ pieceSlug: "top", pieceMember: "2" }),
      } as never;
      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      expect(stub.cancels).toBe(1);
      expect(stub.resolved.map((call) => call[2])).toContain("2");
    } finally {
      restore();
    }
  });

  it("stops watching a runtime that has been disposed", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime(new Error("runtime gone"), true);
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined]]));
      await stub.poll();

      // A disposed runtime cannot answer, and asking it forever is no
      // recovery: the watch drops so a replacement runtime takes it up.
      const asked = stub.resolved.length;
      await stub.poll();
      expect(stub.resolved.length).toBe(asked);
    } finally {
      restore();
    }
  });

  it("reloads nothing when a replacement watch reaches the answer on screen", async () => {
    const restore = installBrowserGlobals();
    const errors = captureErrors();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const first = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        first,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      // The runtime arrives with the rest of the view's state, as it does on
      // a first update. Naming it is what installs it, and a runtime is
      // released only where one was installed before it — so a replacement
      // that never had a predecessor exercises less of the hand-off than a
      // replacement has to.
      view.updated(new Map([["app", undefined], ["rt", undefined]]));
      await first.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      const before = view.accessForTestingOnly.slugRevision;

      // A replacement runtime can read the same reference to a different
      // answer, so it gets a watch of its own and the running one stops. The
      // piece the stopped watch resolved is on screen throughout, and the
      // view goes on naming it — so the replacement's first answer is the one
      // the view already has, and asks for no reload.
      const replacement = stubRuntime({
        pieceId: "fid1:member-42",
        pathAfter: [],
      });
      view.rt = replacement.rt;
      view.updated(new Map([["rt", undefined]]));
      await replacement.settle();

      expect(view.accessForTestingOnly.slugRevision).toBe(before);
      // Nothing here drives an error path, so every member the hand-off
      // reaches for answered — the release of the first runtime among them,
      // which only a replacement reaches.
      expect(errors.lines).toEqual([]);
    } finally {
      errors.restore();
      restore();
    }
  });

  it("asks for no reload from a poll fired while the selection is loading", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined], ["rt", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // The selection runs again and stops in the load, which is where a run
      // spends most of its time. What the view came to show is the piece the
      // last run reached, and the run in flight is on its way to the same
      // answer.
      stub.holdLoads();
      view._selectedPattern.run();
      await stub.settle();
      const before = view.accessForTestingOnly.slugRevision;

      // A poll lands there. It reaches the answer the view is showing, so
      // there is nothing to reload — and a reload here aborts the run in
      // flight in favor of an identical one, which the next poll does again
      // for as long as a load outlasts the interval.
      await stub.poll();

      expect(view.accessForTestingOnly.slugRevision).toBe(before);

      await stub.releaseLoads();
    } finally {
      restore();
    }
  });

  it("shows no runtime error naming the piece a changed address left behind", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const stub = stubRuntime({ pieceId: "fid1:member-42", pathAfter: [] });
      const view = appViewOver(
        XAppView as never,
        stub,
        viewOf({ pieceSlug: "top", pieceMember: "42" }),
      );

      view.updated(new Map([["app", undefined], ["rt", undefined]]));
      await stub.settle();
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // Member 42 is what the view came to show, so an error the worker
      // reports against that piece is this view's to show — and reading the
      // binding at all is what the case below rests on.
      const reported: Reported = {
        space: SPACE,
        pieceId: "of:fid1:member-42",
        message: "the piece threw",
      };
      view.runtimeLoadErrors = [reported];
      expect(templateBindings(view.render(), "runtimeError")).toEqual([{
        kind: "piece",
        error: reported,
      }]);

      // The address moves to member 43, and every answer is held: the
      // selection for the new reference is still resolving, so nothing is on
      // screen and no run has said what replaced 42.
      stub.answer({ pieceId: "fid1:member-43", pathAfter: [] });
      stub.hold();
      view.app = {
        identity: {},
        config: {},
        view: viewOf({ pieceSlug: "top", pieceMember: "43" }),
      };
      view.updated(new Map([["app", undefined]]));
      view._selectedPattern.run();
      await stub.settle();

      // 42 is the answer to a reference this address does not carry, and the
      // error naming it belongs to no view the reader is looking at.
      expect(templateBindings(view.render(), "runtimeError")).toEqual([
        undefined,
      ]);
    } finally {
      restore();
    }
  });

  it("leaves the process-wide timers as it found them", () => {
    // Last, and it reads what every test before it did. These are shared with
    // the whole test process: left replaced, `setInterval` stops scheduling
    // and `clearInterval` stops cancelling for everything that runs after,
    // and no assertion anywhere goes red — things simply stop happening.
    expect(globalThis.setInterval).toBe(NATIVE_TIMERS.setInterval);
    expect(globalThis.clearInterval).toBe(NATIVE_TIMERS.clearInterval);
  });
});
