import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  dropContainerCases,
  ingestJUnit,
  isRelativeSourcePath,
  JUnitParseError,
  parseJUnit,
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

  describe("dropContainerCases()", () => {
    it("returns only the leaves of the bdd hierarchy", () => {
      const leaves = dropContainerCases(parseJUnit(DENO_SAMPLE));
      expect(leaves.map((c) => c.name).sort()).toEqual([
        "bare deno test case",
        'glaze > thickness > thins when "cooled" & <shaken>',
        "glaze > fails on purpose",
        "glaze > is skipped",
        "glaze > thickness > thickens when heated",
      ].sort());
    });

    it("keeps two cases that share one full name", () => {
      const duplicated = [
        { suite: "a", name: "same", outcome: "pass" as const },
        { suite: "b", name: "same", outcome: "fail" as const },
      ];
      expect(dropContainerCases(duplicated).length).toBe(2);
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

    it("records a cancelled test as skipped only where a signal interrupted the run", () => {
      // `deno test` reports a test as cancelled when SIGINT reaches it
      // part way through "glaze > sets" and "crumb", and also when an
      // error the test did not catch stops it. A step still running is
      // reported as skipped either way.
      const report = `<testsuites>
          <testsuite name="./glaze.test.ts">
            <testcase name="glaze" classname="./glaze.test.ts" time="0.000">
              <error message="Cancelled"/>
            </testcase>
            <testcase name="glaze &gt; pours" time="0.010"></testcase>
            <testcase name="glaze &gt; sets"><skipped/></testcase>
          </testsuite>
          <testsuite name="./crumb.test.ts">
            <testcase name="crumb" time="0.020">
              <error message="Cancelled"/>
            </testcase>
            <testcase name="rise" time="0.020">
              <failure message="Cancelled"/>
            </testcase>
          </testsuite>
        </testsuites>`;
      const outcomes = (interrupted: boolean) =>
        ingestJUnit(report, { kind: "unit", scope: "bakery", interrupted })
          .map((record) => [record.test.n, record.outcome]).sort();
      expect(outcomes(true)).toEqual([
        ["crumb", "skip"],
        ["glaze > pours", "pass"],
        ["glaze > sets", "skip"],
        ["rise", "fail"],
      ]);
      expect(outcomes(false)).toEqual([
        ["crumb", "fail"],
        ["glaze > pours", "pass"],
        ["glaze > sets", "skip"],
        ["rise", "fail"],
      ]);
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
