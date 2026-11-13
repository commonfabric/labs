import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import { hasExecutableCode } from "./executable-source.ts";
import { parseLcov } from "./coverage-metrics.ts";

/** A fixture module, and whether its content compiles to code that can run. */
interface Fixture {
  name: string;
  content: string;
  executable: boolean;
}

/**
 * Fixtures for the coverage pass. The augmentation holds an import whose
 * binding is used only in a type position: both compilers drop the import, so
 * nothing of that file survives to run.
 */
const COVERAGE_FIXTURES: Fixture[] = [
  {
    name: "declarations.ts",
    content: [
      "export interface Shape {",
      "  sides: number;",
      "}",
      "export type Either = Shape | number;",
    ].join("\n"),
    executable: false,
  },
  {
    name: "augmentation.ts",
    content: [
      'import { used } from "./values.ts";',
      "declare global {",
      "  interface Window {",
      "    extra?: typeof used;",
      "  }",
      "}",
      "export {};",
    ].join("\n"),
    executable: false,
  },
  {
    name: "values.ts",
    content: [
      "export function used() {",
      "  return 1;",
      "}",
      "export function skipped() {",
      "  return 2;",
      "}",
    ].join("\n"),
    executable: true,
  },
  {
    name: "barrel.ts",
    content: 'export * from "./values.ts";\n',
    executable: false,
  },
];

describe("executable-source", () => {
  describe("hasExecutableCode()", () => {
    const declarationOnly: [string, string][] = [
      [
        "interfaces and type aliases",
        [
          "export interface Shape {",
          "  sides: number;",
          "}",
          "export type Either = Shape | number;",
        ].join("\n"),
      ],
      [
        "ambient declarations",
        [
          "declare const external: number;",
          "export declare function helper(x: number): number;",
          "export type Reference = typeof external;",
        ].join("\n"),
      ],
      [
        "a global augmentation",
        [
          "declare global {",
          "  interface Window {",
          "    extra?: number;",
          "  }",
          "}",
          "export {};",
        ].join("\n"),
      ],
      [
        "a namespace holding only types",
        [
          "export namespace Shapes {",
          "  export interface Circle {",
          "    radius: number;",
          "  }",
          "}",
        ].join("\n"),
      ],
      [
        "a type-only re-export",
        'export type { Shape } from "./shapes.ts";',
      ],
      [
        "an import used only in type positions",
        [
          'import { Widget } from "./widget.ts";',
          "export type Rendered = (widget: Widget) => string;",
        ].join("\n"),
      ],
      ["a re-export of everything", 'export * from "./values.ts";'],
      [
        "named re-exports",
        'export { used, skipped as unused } from "./values.ts";',
      ],
      ["a namespace re-export", 'export * as values from "./values.ts";'],
      [
        "comments and the module marker",
        ["/** Everything here is commented out. */", "export {};"].join("\n"),
      ],
      [
        "declarations in a file with no import or export",
        ["interface Local {", "  a: number;", "}", "type Other = Local;"].join(
          "\n",
        ),
      ],
    ];

    for (const [subject, content] of declarationOnly) {
      it(`returns \`false\` for ${subject}`, () => {
        expect(hasExecutableCode(content, "example.ts")).toBe(false);
      });
    }

    const executable: [string, string][] = [
      ["a value", "export const answer = 42;"],
      ["an enum", "export enum Color {\n  Red,\n  Green,\n}"],
      ["a const enum", "export const enum Speed {\n  Slow = 1,\n}"],
      [
        "a namespace holding a value",
        "export namespace Values {\n  export const one = 1;\n}",
      ],
      [
        "an abstract class",
        "export abstract class Base {\n  abstract run(): void;\n}",
      ],
      [
        "an import kept for its side effects",
        [
          'import "./register.ts";',
          "export interface Marker {",
          "  m: true;",
          "}",
        ].join("\n"),
      ],
      [
        "a re-export beside a value",
        'export * from "./values.ts";\nexport const answer = 42;',
      ],
      ["a default export", "export default 42;"],
      // Error recovery emits what the compiler managed to read, so a file it
      // cannot parse carries its full charge.
      ["a file that does not parse", "export const broken = {"],
      ["text that is not code at all", "This file is prose, not TypeScript.\n"],
    ];

    for (const [subject, content] of executable) {
      it(`returns \`true\` for ${subject}`, () => {
        expect(hasExecutableCode(content, "example.ts")).toBe(true);
      });
    }

    it("returns `true` for markup in a `.tsx` file", () => {
      const markup = "export const Greeting = () => <div>hello</div>;";
      expect(hasExecutableCode(markup, "component.tsx")).toBe(true);
    });

    it("returns `false` for a `.tsx` file holding only types", () => {
      const types = [
        "export interface Props {",
        "  title: string;",
        "}",
        "export type Renderer = (props: Props) => unknown;",
      ].join("\n");
      expect(hasExecutableCode(types, "component.tsx")).toBe(false);
    });

    it("returns `true` for JavaScript that declares a value", () => {
      expect(hasExecutableCode("export const value = 1;\n", "mod.js"))
        .toBe(true);
    });

    it("returns `false` for JavaScript that is all comment", () => {
      expect(hasExecutableCode("// nothing here\n", "mod.js")).toBe(false);
    });

    describe("against a real coverage run", () => {
      // The coverage gate rests on a claim about Deno: a file this function
      // calls non-executable has no line Deno's coverage can report as
      // uncovered, so charging it nothing loses nothing. Deno transpiles with
      // swc and this function asks the TypeScript compiler, so a real coverage
      // pass over fixture modules holds the two to the same answer.

      // Resolved, because the report names the real path and a temporary
      // directory can be reached through a symlink (macOS puts one in front of
      // it).
      let root: string;
      let coverage: ReturnType<typeof parseLcov>;

      const recordFor = (name: string) =>
        coverage.get(path.normalize(path.join(root, name)));

      const runInFixture = async (args: string[]) => {
        const result = await new Deno.Command(Deno.execPath(), {
          args,
          // Both runs read the same emit cache, which Deno keys on the config
          // it resolves; running them from the fixture directory keeps that the
          // same for the profile and the report.
          cwd: root,
          env: { DENO_COVERAGE_DIR: path.join(root, "raw") },
          stdout: "null",
          stderr: "piped",
        }).output();
        if (!result.success) {
          throw new Error(
            `\`deno ${args[0]}\` failed in the fixture directory: ${
              new TextDecoder().decode(result.stderr)
            }`,
          );
        }
      };

      beforeAll(async () => {
        root = await Deno.realPath(
          await Deno.makeTempDir({ prefix: "executable-source-" }),
        );
        for (const fixture of COVERAGE_FIXTURES) {
          await Deno.writeTextFile(
            path.join(root, fixture.name),
            fixture.content,
          );
        }
        await Deno.writeTextFile(
          path.join(root, "fixture.test.ts"),
          [
            // Side-effect imports, so every fixture is loaded whether or not it
            // binds anything.
            'import "./declarations.ts";',
            'import "./augmentation.ts";',
            'import { used } from "./barrel.ts";',
            'Deno.test("drive", () => {',
            '  if (used() !== 1) throw new Error("wrong");',
            "});",
          ].join("\n"),
        );

        const rawDir = path.join(root, "raw");
        await runInFixture([
          "test",
          "--no-check",
          "--no-lock",
          `--coverage=${rawDir}`,
          "fixture.test.ts",
        ]);
        const lcovPath = path.join(root, "fixture.lcov");
        await runInFixture([
          "coverage",
          "--lcov",
          `--output=${lcovPath}`,
          rawDir,
        ]);
        coverage = parseLcov(await Deno.readTextFile(lcovPath), root);
      });

      afterAll(async () => {
        await Deno.remove(root, { recursive: true });
      });

      it("reports uncovered lines for a fixture holding code no test ran", () => {
        const values = recordFor("values.ts");
        expect(values).toBeDefined();
        expect([...values!.lineHits.values()].filter((hits) => hits === 0))
          .not.toEqual([]);
      });

      for (const fixture of COVERAGE_FIXTURES) {
        it(`classifies \`${fixture.name}\` as the report does`, () => {
          expect(
            hasExecutableCode(fixture.content, path.join(root, fixture.name)),
          ).toBe(fixture.executable);

          const record = recordFor(fixture.name);
          if (fixture.executable) {
            expect(record).toBeDefined();
            return;
          }
          // Either no record at all, or one whose lines the module's own load
          // hit. A comment surviving into the emitted output can leave Deno a
          // line to report, and loading the module hits it.
          const hits = [...record?.lineHits.values() ?? []];
          expect(hits.filter((count) => count === 0)).toEqual([]);
        });
      }
    });
  });
});
