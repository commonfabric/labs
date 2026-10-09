import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  ingestJUnit,
  isRelativeSourcePath,
  JUnitParseError,
  parseJUnit,
  recordedCases,
} from "./junit.ts";

// The shape `deno test --junit-path` emits for a bdd file: the file's suite
// holds a container per top-level group (carrying the aggregated failure)
// plus bare Deno.test cases; nested describes land in an ext:cli suite; the
// leaves land in a framework-named suite.
const DENO_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="deno test" tests="7" failures="2" errors="0" time="0.004">
    <testsuite name="packages/bakery/test/glaze.test.ts" tests="2" disabled="0" errors="0" failures="1">
        <testcase name="glaze" classname="test/glaze.test.ts" time="0.002" line="4" col="1">
            <failure message="1 test step failed">1 test step failed.</failure>
        </testcase>
        <testcase name="bare deno test case" classname="test/glaze.test.ts" time="0.000" line="19" col="6">
        </testcase>
    </testsuite>
    <testsuite name="ext:cli/40_test.js" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="glaze &gt; thickness" classname="ext:cli/40_test.js" time="0.001" line="239" col="28">
        </testcase>
    </testsuite>
    <testsuite name="https://jsr.io/@std/testing/1.0.19/_test_suite.ts" tests="4" disabled="1" errors="0" failures="1">
        <testcase name="glaze &gt; thickness &gt; thickens when heated" classname="https://jsr.io/@std/testing/1.0.19/_test_suite.ts" time="0.010" line="172" col="39">
        </testcase>
        <testcase name="glaze &gt; thickness &gt; thins when &quot;cooled&quot; &amp; &lt;shaken&gt;" classname="https://jsr.io/@std/testing/1.0.19/_test_suite.ts" time="0.000" line="402" col="15">
        </testcase>
        <testcase name="glaze &gt; fails on purpose" classname="https://jsr.io/@std/testing/1.0.19/_test_suite.ts" time="0.000" line="402" col="15">
            <failure message="Uncaught AssertionError: 1 &lt; 2">stack with &gt; escapes
and newlines</failure>
        </testcase>
        <testcase name="glaze &gt; is skipped" classname="https://jsr.io/@std/testing/1.0.19/_test_suite.ts" time="0.000" line="402" col="15">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

// The synthesized pattern-unit shape: no classname at all.
const SYNTHESIZED_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pattern-unit-tests" tests="2" failures="1" time="3.500">
    <testcase name="packages/patterns/counter.test.tsx" time="1.250"/>
    <testcase name="packages/patterns/list.test.tsx" time="2.250">
      <failure message="Test failed" />
    </testcase>
  </testsuite>
</testsuites>`;

// The shape `deno test --junit-path` reports for a `Deno.test` whose body threw
// after its step passed, one whose steps failed and whose body did not,
// and a describe whose `afterAll` threw after its leaf passed.
const OWN_FAILURE_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="deno test" tests="7" failures="5" errors="0" time="0.004">
    <testsuite name="./own.test.ts" tests="6" disabled="0" errors="0" failures="5">
        <testcase name="stepped" classname="./own.test.ts" time="0.003" line="2" col="6">
            <failure message="Uncaught Error: the body failed">Error: the body failed</failure>
        </testcase>
        <testcase name="two steps" classname="./own.test.ts" time="0.001" line="7" col="6">
            <failure message="2 test steps failed">2 test steps failed.</failure>
        </testcase>
        <testcase name="torn down" classname="./own.test.ts" time="0.001" line="11" col="1">
            <failure message="Uncaught Error: the teardown failed">Error: the teardown failed</failure>
        </testcase>
        <testcase name="stepped &gt; passes" classname="./own.test.ts" time="0.001" line="3" col="11">
        </testcase>
        <testcase name="two steps &gt; a" classname="./own.test.ts" time="0.000" line="8" col="11">
            <failure message="Uncaught Error: a">Error: a</failure>
        </testcase>
        <testcase name="two steps &gt; b" classname="./own.test.ts" time="0.000" line="9" col="11">
            <failure message="Uncaught Error: b">Error: b</failure>
        </testcase>
    </testsuite>
    <testsuite name="ext:cli/40_test.js" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="torn down &gt; passes" classname="ext:cli/40_test.js" time="0.000" line="239" col="28">
        </testcase>
    </testsuite>
</testsuites>`;

describe("junit", () => {
  describe("parseJUnit()", () => {
    it("returns every testcase with its suite, outcome, and time", () => {
      const cases = parseJUnit(DENO_SAMPLE);
      expect(cases.length).toBe(7);
      const failed = cases.find((c) => c.name === "glaze > fails on purpose");
      expect(failed?.outcome).toBe("fail");
      const skipped = cases.find((c) => c.name === "glaze > is skipped");
      expect(skipped?.outcome).toBe("skip");
      const timed = cases.find(
        (c) => c.name === "glaze > thickness > thickens when heated",
      );
      expect(timed?.timeSeconds).toBe(0.01);
    });

    it("decodes entities in attribute values", () => {
      const cases = parseJUnit(DENO_SAMPLE);
      const escaped = cases.find((c) => c.name.includes("cooled"));
      expect(escaped?.name).toBe(
        'glaze > thickness > thins when "cooled" & <shaken>',
      );
    });

    it("parses self-closing testcases", () => {
      const cases = parseJUnit(SYNTHESIZED_SAMPLE);
      expect(cases.length).toBe(2);
      expect(cases[0]?.classname).toBeUndefined();
    });

    it("drops a negative time rather than record it", () => {
      const cases = parseJUnit(
        '<testsuite name="s"><testcase name="t" time="-0.5"/></testsuite>',
      );
      expect(cases[0]?.timeSeconds).toBeUndefined();
    });

    it("throws for an unterminated tag", () => {
      expect(() => parseJUnit("<testsuite name=")).toThrow(JUnitParseError);
    });

    it("throws for an unquoted attribute value", () => {
      expect(() => parseJUnit("<testcase name=oops>")).toThrow(
        JUnitParseError,
      );
    });

    it("skips comments, CDATA sections, and declarations", () => {
      const cases = parseJUnit(
        "<!DOCTYPE testsuite>" +
          '<!-- a comment with a <testcase name="ghost"/> inside -->' +
          '<testsuite name="s"><![CDATA[<testcase name="ghost2"/>]]>' +
          '<testcase name="real" time="0.001"/></testsuite>',
      );
      expect(cases.map((c) => c.name)).toEqual(["real"]);
    });

    it("reads single-quoted attributes and numeric entities", () => {
      const cases = parseJUnit(
        "<testsuite name='s'><testcase name='a &#62; b &#x26; c'/>" +
          "</testsuite>",
      );
      expect(cases[0]?.name).toBe("a > b & c");
    });

    it("throws for every unterminated construct", () => {
      expect(() => parseJUnit('<?xml version="1.0"')).toThrow(
        JUnitParseError,
      );
      expect(() => parseJUnit("<!-- open comment")).toThrow(JUnitParseError);
      expect(() => parseJUnit("<![CDATA[ open")).toThrow(JUnitParseError);
      expect(() => parseJUnit("<!DOCTYPE open")).toThrow(JUnitParseError);
      expect(() => parseJUnit("</testsuite")).toThrow(JUnitParseError);
      expect(() => parseJUnit('<testcase name="a"')).toThrow(JUnitParseError);
      expect(() => parseJUnit('<testcase name="unclosed>')).toThrow(
        JUnitParseError,
      );
    });

    it("throws for a tag with no name", () => {
      expect(() => parseJUnit("< >")).toThrow(JUnitParseError);
    });

    it("ignores markers outside any open testcase", () => {
      const cases = parseJUnit(
        '<testsuite name="s"><failure message="stray"/><skipped/>' +
          "</testcase></testsuite>",
      );
      expect(cases).toEqual([]);
    });
  });

  describe("recordedCases()", () => {
    it("returns only the leaves of the bdd hierarchy", () => {
      const leaves = recordedCases(parseJUnit(DENO_SAMPLE));
      expect(leaves.map((c) => c.name).sort()).toEqual([
        "bare deno test case",
        'glaze > thickness > thins when "cooled" & <shaken>',
        "glaze > fails on purpose",
        "glaze > is skipped",
        "glaze > thickness > thickens when heated",
      ].sort());
    });

    it("keeps a container that failed on its own account", () => {
      const leaves = recordedCases(parseJUnit(OWN_FAILURE_SAMPLE));
      expect(leaves.map((c) => `${c.name}: ${c.outcome}`).sort()).toEqual([
        "stepped > passes: pass",
        "stepped: fail",
        "torn down > passes: pass",
        "torn down: fail",
        "two steps > a: fail",
        "two steps > b: fail",
      ]);
    });

    it("keeps a failed container whose failure gives no message", () => {
      const cases = [
        { suite: "a", name: "outer", outcome: "fail" as const },
        { suite: "a", name: "outer > inner", outcome: "pass" as const },
      ];
      expect(recordedCases(cases).map((c) => c.name)).toEqual([
        "outer",
        "outer > inner",
      ]);
    });

    it("records a known container with its outcome and time on its own account", () => {
      // "glaze" failed only through a leaf inside it, so on its own account
      // it passed, and the time it spent outside the cases directly inside
      // it is its own. "glaze > thickness" reports less time than its
      // leaves, which rounding allows, and is charged none.
      const kept = recordedCases(
        parseJUnit(DENO_SAMPLE),
        (name) =>
          ["glaze", "glaze > thickness", "bare deno test case"].includes(name),
      );
      const outer = kept.find((c) => c.name === "glaze");
      expect(outer?.outcome).toBe("pass");
      expect(outer?.failure).toBeUndefined();
      expect(outer?.timeSeconds).toBeCloseTo(0.001);
      const inner = kept.find((c) => c.name === "glaze > thickness");
      expect(inner?.outcome).toBe("pass");
      expect(inner?.timeSeconds).toBe(0);
      expect(kept.length).toBe(7);
    });

    it("keeps a known container's own failure as a failure", () => {
      const kept = recordedCases(
        parseJUnit(OWN_FAILURE_SAMPLE),
        (name) => name === "stepped" || name === "two steps",
      );
      expect(kept.find((c) => c.name === "stepped")?.outcome).toBe("fail");
      expect(kept.find((c) => c.name === "two steps")?.outcome).toBe("pass");
    });

    it("leaves out a known container whose name the report gives twice", () => {
      // The bdd runner names the suite of a file's top-level hooks
      // "global" in every file that has them, so the name says nothing
      // about which of them passed.
      const cases = [
        { suite: "a", name: "global", outcome: "pass" as const },
        { suite: "a", name: "global > one", outcome: "pass" as const },
        { suite: "b", name: "global", outcome: "pass" as const },
        { suite: "b", name: "global > two", outcome: "pass" as const },
      ];
      expect(
        recordedCases(cases, (name) => name === "global").map((c) => c.name),
      ).toEqual(["global > one", "global > two"]);
    });

    it("keeps two cases that share one full name", () => {
      const duplicated = [
        { suite: "a", name: "same", outcome: "pass" as const },
        { suite: "b", name: "same", outcome: "fail" as const },
      ];
      expect(recordedCases(duplicated).length).toBe(2);
    });
  });

  describe("isRelativeSourcePath()", () => {
    it("returns true for a plain relative source path", () => {
      expect(isRelativeSourcePath("test/glaze.test.ts")).toBe(true);
    });

    it("returns false for URLs, ext modules, and climbing paths", () => {
      expect(isRelativeSourcePath("https://jsr.io/x/y.ts")).toBe(false);
      expect(isRelativeSourcePath("ext:cli/40_test.js")).toBe(false);
      expect(isRelativeSourcePath("../outside/file.ts")).toBe(false);
      expect(isRelativeSourcePath("/absolute/file.ts")).toBe(false);
    });

    it("returns false for a climb hidden past the first segment", () => {
      expect(isRelativeSourcePath("./../../outside.ts")).toBe(false);
      expect(isRelativeSourcePath("test/../../outside.ts")).toBe(false);
      expect(isRelativeSourcePath("test/./glaze.test.ts")).toBe(false);
      expect(isRelativeSourcePath("test//glaze.test.ts")).toBe(false);
      expect(isRelativeSourcePath("./test/glaze.test.ts")).toBe(true);
    });
  });

  describe("ingestJUnit()", () => {
    it("returns leaf records of the given kind and scope", () => {
      const records = ingestJUnit(DENO_SAMPLE, {
        kind: "unit",
        scope: "bakery",
      });
      expect(records.length).toBe(5);
      for (const record of records) {
        expect(record.test.k).toBe("unit");
        expect(record.test.s).toBe("bakery");
      }
      const timed = records.find(
        (r) => r.test.n === "glaze > thickness > thickens when heated",
      );
      expect(timed?.durationMs).toBe(10);
    });

    it("records a test whose own body failed after its step passed", () => {
      const records = ingestJUnit(OWN_FAILURE_SAMPLE, {
        kind: "unit",
        scope: "bakery",
        filePrefix: "packages/bakery",
      });
      const stepped = records.find((r) => r.test.n === "stepped");
      expect(stepped?.outcome).toBe("fail");
      // Its own time, outside the step inside it.
      expect(stepped?.durationMs).toBe(2);
      expect(stepped?.file).toBe("packages/bakery/own.test.ts");
      expect(records.some((r) => r.test.n === "two steps")).toBe(false);
    });

    it("joins relative classnames onto the file prefix", () => {
      const records = ingestJUnit(DENO_SAMPLE, {
        kind: "unit",
        scope: "bakery",
        filePrefix: "packages/bakery",
      });
      const bare = records.find((r) => r.test.n === "bare deno test case");
      expect(bare?.file).toBe("packages/bakery/test/glaze.test.ts");
    });

    it("gives a leaf the file of the container that registered it", () => {
      const records = ingestJUnit(DENO_SAMPLE, {
        kind: "unit",
        scope: "bakery",
        filePrefix: "packages/bakery",
      });
      const leaf = records.find(
        (r) => r.test.n === "glaze > thickness > thickens when heated",
      );
      expect(leaf?.file).toBe("packages/bakery/test/glaze.test.ts");
    });

    it("prefers the preload's map over what the report claims", () => {
      const records = ingestJUnit(DENO_SAMPLE, {
        kind: "unit",
        scope: "bakery",
        filePrefix: "packages/bakery",
        fileByName: new Map([["glaze", "packages/bakery/test/moved.test.ts"]]),
      });
      const leaf = records.find(
        (r) => r.test.n === "glaze > thickness > thickens when heated",
      );
      expect(leaf?.file).toBe("packages/bakery/test/moved.test.ts");
      const bare = records.find((r) => r.test.n === "bare deno test case");
      expect(bare?.file).toBe("packages/bakery/test/glaze.test.ts");
    });

    it("records no file for a name two files both report", () => {
      // The two are one identity, and which file a leaf came from is not
      // a question the report can answer, so it answers neither.
      // A second case under the same name, from another file — which is
      // what two packages reporting one test name looks like.
      const collided = DENO_SAMPLE.replace(
        '    </testsuite>\n    <testsuite name="ext:cli/40_test.js"',
        '        <testcase name="bare deno test case" ' +
          'classname="test/other.test.ts" time="0.000" line="4" col="1">\n' +
          "        </testcase>\n    </testsuite>\n" +
          '    <testsuite name="ext:cli/40_test.js"',
      );
      const records = ingestJUnit(collided, {
        kind: "unit",
        scope: "bakery",
        filePrefix: "packages/bakery",
      });
      const bare = records.find((r) => r.test.n === "bare deno test case");
      expect(bare?.file).toBeUndefined();
      // The names that did not collide keep theirs.
      const leaf = records.find(
        (r) => r.test.n === "glaze > thickness > thickens when heated",
      );
      expect(leaf?.file).toBe("packages/bakery/test/glaze.test.ts");
    });

    it("declines a classname naming the registration wrapper", () => {
      // A path that does not climb, so `isRelativeSourcePath` accepts it
      // and the rejection under test is the one that fires. A classname
      // with `..` in it is refused before ever reaching that check.
      const wrapped = DENO_SAMPLE.replaceAll(
        'classname="test/glaze.test.ts"',
        'classname="packages/test-support/src/records/registration.ts"',
      );
      const records = ingestJUnit(wrapped, {
        kind: "unit",
        scope: "bakery",
        filePrefix: "packages/bakery",
      });
      for (const record of records) expect(record.file).toBeUndefined();
    });

    it("records no file without a prefix", () => {
      const records = ingestJUnit(DENO_SAMPLE, {
        kind: "unit",
        scope: "bakery",
      });
      for (const record of records) {
        expect(record.file).toBeUndefined();
      }
    });

    it("ingests the synthesized pattern-unit shape", () => {
      const records = ingestJUnit(SYNTHESIZED_SAMPLE, {
        kind: "pattern",
        scope: "patterns",
      });
      expect(records).toEqual([
        {
          line: "record",
          test: {
            k: "pattern",
            s: "patterns",
            n: "packages/patterns/counter.test.tsx",
          },
          outcome: "pass",
          durationMs: 1250,
        },
        {
          line: "record",
          test: {
            k: "pattern",
            s: "patterns",
            n: "packages/patterns/list.test.tsx",
          },
          outcome: "fail",
          durationMs: 2250,
        },
      ]);
    });
  });
});
