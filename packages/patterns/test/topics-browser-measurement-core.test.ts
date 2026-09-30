/**
 * Unit tests of `topics-browser-measurement-core.ts`. Several cases read
 * `topics-browser-measurement-core.fixture.json`, which holds output recorded
 * from the Topics sources at one revision: each named lift's compiled module
 * text around its declaration and the length of its compiled function; the
 * preview a browser running a board seeded from those sources reported for it,
 * and for `cardsByActivity`; the identities the Topics modules compile to with
 * root `packages/patterns`, and the identity `/topics/main.tsx` compiles to
 * with 68 lines added above it; and a preview from a compile with pattern
 * coverage on.
 *
 * Nothing recompiles those sources to check the recording against them, which
 * is what lets these cases hold still as the Topics sources move.
 * `docs/development/BENCHMARKS.md` says how the recording is taken again.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  compiledLiftText,
  type CompiledTopicsLift,
  confirmLiftImplementations,
  confirmSampledLifts,
  COVERAGE_HIT_CALL,
  liftRunningStates,
  locateLift,
  parseSrc,
  PREVIEW_LENGTH,
  requireAttributableRuns,
  requireNoCoverageCollector,
  requireSameProgram,
  requireUninstrumentedPreviews,
  runThenStop,
  timingDelta,
  type TopicsLiftSite,
  WORKER_RUN_TIMING_KEY,
  workerRunCount,
} from "../integration/topics-browser-measurement-core.ts";
import fixture from "./topics-browser-measurement-core.fixture.json" with {
  type: "json",
};

describe("topics-browser-measurement-core", () => {
  const fryer = [
    'import { lift } from "commonfabric";',
    "",
    "const doubled = lift(",
    "  (value: number) => value * 2,",
    ");",
    "",
    "/** Counts the glazed donuts. */",
    "const glazeCount = lift(({ donuts }: { donuts: Donut[] }) =>",
    "  donuts.filter((donut) => donut.glazed).length",
    ");",
    "",
  ].join("\n");

  describe("the recorded fixture", () => {
    it("holds a lift under each of the four names measured separately", () => {
      expect(Object.keys(fixture.lifts).toSorted()).toEqual([
        "backlinksOf",
        "crossrefTable",
        "lastActivityOf",
        "presentCommentCountOf",
      ]);
    });
  });

  describe("locateLift()", () => {
    it("returns the line and column where the lift's function starts", () => {
      expect(locateLift(fryer, "doubled")).toEqual({ line: 4, col: 2 });
    });

    it("returns a later line for the same lift once lines are added above it", () => {
      expect(locateLift(`// one\n// two\n\n${fryer}`, "doubled"))
        .toEqual({ line: 7, col: 2 });
    });

    it("returns the position after a comment between the call and the function", () => {
      const text = "const doubled = lift( /* note */ (value: number) => 2);";
      expect(locateLift(text, "doubled")).toEqual({ line: 1, col: 33 });
    });

    it("throws for a binding that is not declared as a lift", () => {
      expect(() =>
        locateLift("const doubled = computed(() => 2);", "doubled", "fryer.tsx")
      ).toThrow("`const doubled = lift(<function>)` declaration in fryer.tsx");
    });

    it("reads no declaration out of a string, a comment, a template literal, or a regular expression", () => {
      const text = [
        'const note = "const doubled = lift((value) => value)";',
        "// const doubled = lift((value) => value)",
        "const label = `const doubled = lift((value) => value)`;",
        "const pattern = /const doubled = lift\\(/;",
        "const doubled = lift((value: number) => value * 2);",
      ].join("\n");

      expect(locateLift(text, "doubled")).toEqual({ line: 5, col: 21 });
    });

    it("throws for a lift declared twice", () => {
      expect(() => locateLift(`${fryer}\n${fryer}`, "doubled"))
        .toThrow("found 2");
    });
  });

  describe("compiledLiftText()", () => {
    it("returns each Topics lift's compiled function, which the browser's preview begins", () => {
      for (const [name, lift] of Object.entries(fixture.lifts)) {
        const text = compiledLiftText(lift.excerpt, name, lift.module);

        expect([name, text.length, text.slice(0, PREVIEW_LENGTH)]).toEqual([
          name,
          lift.length,
          lift.preview,
        ]);
      }
    });

    it("returns a function holding brackets in strings, template literals, regular expressions, and comments", () => {
      const emitted = [
        "const other = 1;",
        "const glazed = (0, commonfabric_2.lift)((value) => {",
        '    const note = "a ) b";',
        "    const label = `glazed ${value} }`;",
        "    // a ) in a comment",
        "    return /[)]/.test(value);",
        '}, { type: "string" });',
        "const next = 2;",
      ].join("\n");

      expect(compiledLiftText(emitted, "glazed")).toBe(
        [
          "(value) => {",
          '    const note = "a ) b";',
          "    const label = `glazed ${value} }`;",
          "    // a ) in a comment",
          "    return /[)]/.test(value);",
          "}",
        ].join("\n"),
      );
    });

    it("returns a function whose body divides twice after a postfix increment", () => {
      const emitted = [
        "const rate = (0, commonfabric_2.lift)((counts) => {",
        "    let index = 0;",
        "    const ratio = counts[index++] / (counts.length / 2);",
        "    return ratio;",
        "});",
      ].join("\n");

      expect(compiledLiftText(emitted, "rate")).toBe(
        [
          "(counts) => {",
          "    let index = 0;",
          "    const ratio = counts[index++] / (counts.length / 2);",
          "    return ratio;",
          "}",
        ].join("\n"),
      );
    });

    it("reads no second declaration out of a string or a comment in the function", () => {
      const emitted = [
        "const glazed = (0, commonfabric_2.lift)((value) => {",
        '    const note = "const glazed = (0, commonfabric_2.lift)((v) => v)";',
        "    // const glazed = (0, commonfabric_2.lift)((v) => v)",
        "    return value;",
        "});",
      ].join("\n");

      expect(compiledLiftText(emitted, "glazed")).toBe(
        [
          "(value) => {",
          '    const note = "const glazed = (0, commonfabric_2.lift)((v) => v)";',
          "    // const glazed = (0, commonfabric_2.lift)((v) => v)",
          "    return value;",
          "}",
        ].join("\n"),
      );
    });

    it("reads no declaration out of a comma expression whose left operand is not `0`", () => {
      const emitted = [
        "const glazed = (1, commonfabric_2.lift)((value) => value);",
        "const frosted = (count(), commonfabric_2.lift)((value) => value);",
      ].join("\n");

      expect(() => compiledLiftText(emitted, "glazed", "/fryer.js"))
        .toThrow("declaration in /fryer.js, found 0");
      expect(() => compiledLiftText(emitted, "frosted", "/fryer.js"))
        .toThrow("declaration in /fryer.js, found 0");
    });

    it("throws for a module declaring the lift twice or not at all", () => {
      const once = "const glazed = (0, commonfabric_2.lift)((value) => value);";

      expect(() => compiledLiftText("const other = 1;", "glazed", "/fryer.js"))
        .toThrow("declaration in /fryer.js, found 0");
      expect(() => compiledLiftText(`${once}\n${once}`, "glazed"))
        .toThrow("found 2");
    });
  });

  describe("parseSrc()", () => {
    it("returns the module identity and the site of a run's `src`", () => {
      expect(parseSrc("cf:module/fryer1/donuts/fryer.tsx:12:20")).toEqual({
        identity: "fryer1",
        site: "/donuts/fryer.tsx:12:20",
      });
    });

    it("returns `undefined` for a `src` of another form", () => {
      expect(parseSrc("file:///donuts/fryer.tsx:12:20")).toBeUndefined();
    });
  });

  describe("liftRunningStates()", () => {
    const lifts: TopicsLiftSite[] = [{
      name: "glazeCount",
      module: "donuts/fryer.tsx",
      role: "consumer",
      site: "/donuts/fryer.tsx:12:20",
    }];
    const src = (path: string, identity = "fryer1") =>
      `cf:module/${identity}${path}`;

    it("returns `true` for a lift whose module runs an action at its site", () => {
      expect(
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20"),
          src("/donuts/fryer.tsx:40:2"),
        ]),
      ).toEqual(new Map([["/donuts/fryer.tsx:12:20", true]]));
    });

    it("returns `true` for a running lift beside another module with the same file name", () => {
      expect(
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20"),
          src("/bagels/fryer.tsx:3:2", "bagels1"),
        ]),
      ).toEqual(new Map([["/donuts/fryer.tsx:12:20", true]]));
    });

    it("returns `false` for a lift whose module file no `src` names", () => {
      expect(
        liftRunningStates(lifts, [src("/donuts/glaze.tsx:3:2", "glaze1"), ""]),
      ).toEqual(new Map([["/donuts/fryer.tsx:12:20", false]]));
    });

    it("throws for a module that has not started while its file runs under another path", () => {
      expect(() =>
        liftRunningStates(lifts, [src("/bagels/fryer.tsx:12:20", "bagels1")])
      ).toThrow(
        "which has not started, but its file runs as `/bagels/fryer.tsx`",
      );
    });

    it("throws for a module deployed under another root than the one resolved", () => {
      const topics: TopicsLiftSite[] = [{
        name: "crossrefTable",
        module: "topics/main.tsx",
        role: "producer",
        site: "/topics/main.tsx:337:2",
      }];
      expect(() =>
        liftRunningStates(topics, [
          src("/packages/patterns/topics/main.tsx:337:2", "board1"),
        ])
      ).toThrow("also runs as `/packages/patterns/topics/main.tsx`");
    });

    it("throws for a copy of the module under another root beside the resolved one", () => {
      expect(() =>
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20"),
          src("/bakery/donuts/fryer.tsx:12:20", "bakery1"),
        ])
      ).toThrow("also runs as `/bakery/donuts/fryer.tsx`");
    });

    it("throws for a module file named by a `src` it cannot parse", () => {
      expect(() => liftRunningStates(lifts, ["file:///bagels/fryer.tsx:12:20"]))
        .toThrow("its file runs as `file:///bagels/fryer.tsx:12:20`");
    });

    it("throws for a running module with no action at the lift's site", () => {
      expect(() => liftRunningStates(lifts, [src("/donuts/fryer.tsx:19:20")]))
        .toThrow(
          "no action of the running `/donuts/fryer.tsx` is at that position",
        );
    });

    it("throws for a module running as two versions", () => {
      expect(() =>
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20", "fryer1"),
          src("/donuts/fryer.tsx:12:20", "fryer2"),
        ])
      ).toThrow("runs as 2 module versions");
    });
  });

  describe("requireSameProgram()", () => {
    const lifts: TopicsLiftSite[] = [
      {
        name: "crossrefTable",
        module: "topics/main.tsx",
        role: "producer",
        site: "/topics/main.tsx:337:2",
      },
      {
        name: "backlinksOf",
        module: "topics/topic.tsx",
        role: "consumer",
        site: "/topics/topic.tsx:1715:25",
      },
    ];
    const identities = new Map(Object.entries(fixture.identities));
    const mainIdentity = fixture.identities["/topics/main.tsx"];
    const topicIdentity = fixture.identities["/topics/topic.tsx"];

    it("returns for running modules that carry the compiled identities", () => {
      expect(() =>
        requireSameProgram(lifts, identities, [
          `cf:module/${mainIdentity}/topics/main.tsx:337:2`,
          `cf:module/${topicIdentity}/topics/topic.tsx:1715:25`,
          "",
        ])
      ).not.toThrow();
    });

    it("returns for a lift module no running action names", () => {
      expect(() =>
        requireSameProgram(lifts, identities, [
          `cf:module/${mainIdentity}/topics/main.tsx:337:2`,
        ])
      ).not.toThrow();
    });

    it("throws for a running module compiled from other sources, as sources with 68 more lines above the pivot are", () => {
      // With those lines, the pivot's position in the sources read is where
      // the running `cardsByActivity` starts; the identity check fails first.

      const shifted = new Map([
        ...identities,
        ["/topics/main.tsx", fixture.shiftedMainIdentity],
      ]);

      expect(fixture.shiftedMainIdentity).not.toBe(mainIdentity);
      expect(() =>
        requireSameProgram(lifts, shifted, [
          `cf:module/${mainIdentity}/topics/main.tsx:405:2`,
        ])
      ).toThrow("the board does not run the program the sources read");
    });

    it("throws for a running Topics module without a named lift that carries another identity", () => {
      expect(() =>
        requireSameProgram(
          lifts,
          new Map([...identities, ["/topics/schemas.ts", "schemas1"]]),
          [`cf:module/schemas2/topics/schemas.ts:4:2`],
        )
      ).toThrow("`/topics/schemas.ts` runs under identity `schemas2`");
    });

    it("throws for a lift module the compiled program lacks", () => {
      expect(() =>
        requireSameProgram(
          lifts,
          new Map([["/topics/main.tsx", mainIdentity]]),
          [],
        )
      ).toThrow("has no module `/topics/topic.tsx`");
    });
  });

  describe("requireNoCoverageCollector()", () => {
    it("throws naming pattern coverage for a worker that collects it", () => {
      expect(() => requireNoCoverageCollector(true))
        .toThrow("The page's worker collects pattern coverage");
    });

    it("returns for a worker that collects no coverage", () => {
      expect(() => requireNoCoverageCollector(false)).not.toThrow();
    });
  });

  describe("requireUninstrumentedPreviews()", () => {
    it("throws naming pattern coverage for a preview holding a coverage hit call", () => {
      expect(fixture.instrumentedPreview).toContain(COVERAGE_HIT_CALL);
      expect(() => requireUninstrumentedPreviews([fixture.instrumentedPreview]))
        .toThrow("holds pattern coverage instrumentation");
    });

    it("returns for previews without hit calls", () => {
      expect(() =>
        requireUninstrumentedPreviews(
          Object.values(fixture.lifts).map((lift) => lift.preview),
        )
      ).not.toThrow();
    });
  });

  describe("confirmLiftImplementations()", () => {
    const pivot: CompiledTopicsLift = {
      name: "crossrefTable",
      module: "topics/main.tsx",
      role: "producer",
      site: "/topics/main.tsx:337:2",
      compiledText: compiledLiftText(
        fixture.lifts.crossrefTable.excerpt,
        "crossrefTable",
      ),
    };
    const src = `cf:module/${
      fixture.identities["/topics/main.tsx"]
    }${pivot.site}`;
    const running = new Map([[pivot.site, true]]);

    it("returns the preview at a running lift's site that equals the start of its compiled text", () => {
      expect(
        confirmLiftImplementations(
          [pivot],
          [{ [src]: [fixture.lifts.crossrefTable.preview] }],
          running,
        ),
      ).toEqual(new Map([[pivot.site, fixture.lifts.crossrefTable.preview]]));
    });

    it("throws naming the lift and the first difference for a preview one character off", () => {
      const preview = fixture.lifts.crossrefTable.preview;
      const offByOne = `${preview.slice(0, 50)}${
        preview[50] === "x" ? "y" : "x"
      }${preview.slice(51)}`;

      expect(() =>
        confirmLiftImplementations([pivot], [{ [src]: [offByOne] }], running)
      ).toThrow(
        "`crossrefTable` at `/topics/main.tsx:337:2` runs an implementation " +
          "that differs from its compiled text at character 50",
      );
    });

    it("throws for another lift's implementation at the site, as where `cardsByActivity` starts", () => {
      expect(() =>
        confirmLiftImplementations(
          [pivot],
          [{ [src]: [fixture.cardsByActivityPreview] }],
          running,
        )
      ).toThrow("differs from its compiled text at character 3");
    });

    it("returns no entry for a lift that is not running", () => {
      expect(
        confirmLiftImplementations(
          [pivot],
          [{}],
          new Map([[pivot.site, false]]),
        ),
      ).toEqual(new Map());
    });

    it("throws when no snapshot shows an implementation at a running lift's site", () => {
      expect(() => confirmLiftImplementations([pivot], [{}], running))
        .toThrow(
          "no action in a graph snapshot there shows its implementation",
        );
    });
  });

  describe("requireAttributableRuns()", () => {
    const lifts: TopicsLiftSite[] = [
      {
        name: "pivotTable",
        module: "donuts/board.tsx",
        role: "producer",
        site: "/donuts/board.tsx:30:2",
      },
      {
        name: "glazeCount",
        module: "donuts/fryer.tsx",
        role: "consumer",
        site: "/donuts/fryer.tsx:12:20",
      },
    ];

    it("throws for runs whose source locations cannot be parsed, which would read every lift as not running", () => {
      // A run carrying no source location never reaches here: the sampler
      // counts those apart and leaves them out of `srcs`. What does reach here
      // is a location that cannot be read, which says nothing about the run.
      const unreadable = ["not a source location", "cf:module/no-position"];
      const running = liftRunningStates(lifts, unreadable);

      expect([...running.values()]).toEqual([false, false]);
      expect(() => requireAttributableRuns(lifts, running, unreadable))
        .toThrow("carried no source location to attribute them by");
    });

    it("throws for a producer whose module is not running", () => {
      const running = liftRunningStates(lifts, [
        "cf:module/fryer1/donuts/fryer.tsx:12:20",
      ]);

      expect(() =>
        requireAttributableRuns(lifts, running, [
          "cf:module/fryer1/donuts/fryer.tsx:12:20",
        ])
      ).toThrow("`pivotTable`'s module `/donuts/board.tsx` is not running");
    });

    it("returns for attributable runs with the producer running and a consumer not running", () => {
      const srcs = [
        "cf:module/board1/donuts/board.tsx:30:2",
        "not a source location",
      ];
      const running = liftRunningStates(lifts, srcs);

      expect(() => requireAttributableRuns(lifts, running, srcs)).not.toThrow();
    });
  });

  describe("confirmSampledLifts()", () => {
    const pivot: CompiledTopicsLift = {
      name: "crossrefTable",
      module: "topics/main.tsx",
      role: "producer",
      site: "/topics/main.tsx:337:2",
      compiledText: compiledLiftText(
        fixture.lifts.crossrefTable.excerpt,
        "crossrefTable",
      ),
    };
    const identity = fixture.identities["/topics/main.tsx"];
    const identities = new Map([["/topics/main.tsx", identity]]);
    const preview = fixture.lifts.crossrefTable.preview;
    const confirm = (implementation: string, runs = identity) => {
      const src = `cf:module/${runs}${pivot.site}`;
      return confirmSampledLifts(
        [pivot],
        identities,
        [{ [src]: [implementation] }],
        [src],
      );
    };

    it("returns the lift as running with the implementation its compiled text names", () => {
      expect(preview).toBe(pivot.compiledText.slice(0, PREVIEW_LENGTH));
      expect(confirm(preview)).toEqual({
        running: new Map([[pivot.site, true]]),
        implementations: new Map([[pivot.site, preview]]),
      });
    });

    it("throws for an implementation one character shorter than the compiled text", () => {
      expect(() => confirm(preview.slice(0, -1)))
        .toThrow("differs from its compiled text at character 199");
    });

    it("throws for an implementation with a trailing space", () => {
      expect(() => confirm(`${preview} `))
        .toThrow("differs from its compiled text at character 200");
    });

    it("throws for an implementation with one letter's case flipped", () => {
      const at = preview.search(/[a-z]/);
      const flipped = preview.slice(0, at) + preview[at].toUpperCase() +
        preview.slice(at + 1);

      expect(flipped).not.toBe(preview);
      expect(() => confirm(flipped))
        .toThrow(`differs from its compiled text at character ${at}`);
    });

    it("throws for an implementation whose runs of whitespace are one space each", () => {
      const collapsed = preview.replace(/\s+/g, " ");

      expect(collapsed).not.toBe(preview);
      expect(() => confirm(collapsed))
        .toThrow("differs from its compiled text at character");
    });

    it("throws for a module running under an identity differing from the compiled one in its last character alone", () => {
      const last = identity.slice(-1);
      const near = `${identity.slice(0, -1)}${last === "a" ? "b" : "a"}`;

      expect(near).not.toBe(identity);
      expect(near.slice(0, -1)).toBe(identity.slice(0, -1));
      expect(() => confirm(preview, near))
        .toThrow("the board does not run the program the sources read");
    });

    it("throws naming coverage, not the text, for an implementation carrying coverage instrumentation", () => {
      expect(() => confirm(fixture.instrumentedPreview))
        .toThrow("holds pattern coverage instrumentation");
    });
  });

  describe("timingDelta()", () => {
    it("returns each key's samples since the first snapshot, joining all-digit segments and dropping excluded requests", () => {
      expect(
        timingDelta(
          {
            "vdom-renderer/batch/0": [1, 2],
            "runtime-client/ipc/cell:get": [3, 30],
          },
          {
            "vdom-renderer/batch/0": [1, 2],
            "vdom-renderer/batch/7": [1, 5],
            "vdom-renderer/batch/8": [1, 4],
            "runtime-client/ipc/cell:get": [5, 50],
            "runtime-client/ipc/runtime:getGraphSnapshot": [1, 9],
          },
          new Set(["runtime:getGraphSnapshot"]),
        ),
      ).toEqual([
        { key: "runtime-client/ipc/cell:get", count: 2, totalMs: 20 },
        { key: "vdom-renderer/batch/*", count: 2, totalMs: 9 },
      ]);
    });
  });

  describe("workerRunCount()", () => {
    it("returns the runs counted under the scheduler's run span, not its children", () => {
      // The worker's `scheduler` logger reports these three keys: the span
      // `runSchedulerAction` opens around a run, and the action and commit
      // spans inside it.

      const before = {
        "scheduler/scheduler/run": [40, 80],
        "scheduler/scheduler/run/action": [40, 50],
        "scheduler/scheduler/run/commit": [12, 9],
      } as const;
      const after = {
        "scheduler/scheduler/run": [47, 95],
        "scheduler/scheduler/run/action": [55, 64],
        "scheduler/scheduler/run/commit": [15, 11],
      } as const;
      expect(WORKER_RUN_TIMING_KEY).toBe("scheduler/scheduler/run");
      expect(workerRunCount(before, after)).toBe(7);
    });

    it("throws for timing without the scheduler's run span", () => {
      expect(() =>
        workerRunCount({}, { "scheduler/scheduler/run/action": [3, 1] })
      ).toThrow("no `scheduler/scheduler/run` key");
    });
  });

  describe("runThenStop()", () => {
    it("returns both results when neither step fails", async () => {
      expect(
        await runThenStop(() => Promise.resolve(1), () => Promise.resolve(2)),
      ).toEqual({ value: 1, stopped: 2 });
    });

    it("throws the operation's error after stopping when only the operation fails", async () => {
      const operation = new Error("fryer jammed");
      let stops = 0;
      await expect(runThenStop(() => Promise.reject(operation), () => {
        stops++;
        return Promise.resolve();
      })).rejects.toBe(operation);
      expect(stops).toBe(1);
    });

    it("throws the stop error when only stopping fails", async () => {
      const stop = new Error("oil still hot");
      await expect(
        runThenStop(() => Promise.resolve(1), () => Promise.reject(stop)),
      ).rejects.toBe(stop);
    });

    it("throws an `AggregateError` holding the operation's error, then the stop error, when both fail", async () => {
      const operation = new Error("fryer jammed");
      const stop = new Error("oil still hot");
      const thrown = await runThenStop(
        () => Promise.reject(operation),
        () => Promise.reject(stop),
      ).then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([operation, stop]);
    });
  });
});
