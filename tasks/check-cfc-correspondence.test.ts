import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  Companion,
  ManifestRow,
} from "@commonfabric/runner/cfc/kernel/manifest";

import type { SpecSnapshot } from "./cfc-spec-snapshot.ts";
import {
  type CheckInput,
  collectFindings,
  type Exemption,
  exportedFunctions,
  KERNEL_DIR,
  type SourceFile,
  valueImports,
} from "./check-cfc-correspondence.ts";

const STORE = "08-12-store-label-monotonicity.md";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const snapshot: SpecSnapshot = {
  specsCommit: "9e751d583760fe44780aad2f4b138edb2667fa1a",
  sections: ["8", "8.12", "8.12.1", "8.12.4"],
  functions: [
    { file: STORE, section: "8.12.1", name: "atomLe", sha256: HASH_A },
    {
      file: STORE,
      section: "8.12.1",
      name: "isMoreRestrictiveCNF",
      sha256: HASH_A,
    },
    { file: STORE, section: "8.12.4", name: "canWrite", sha256: HASH_B },
  ],
};

const atomLeRow: ManifestRow = {
  file: STORE,
  section: "8.12.1",
  name: "atomLe",
  lean: "`Cfc/Store.lean`: `atomLeB`",
  relation: "exact",
  kernelFile: "store-labels.ts",
};

const cnfRow: ManifestRow = {
  file: STORE,
  section: "8.12.1",
  name: "isMoreRestrictiveCNF",
  lean: "`Cfc/Store.lean`: `confLeB`",
  relation: "missing",
  decidedToday: "unknown",
  note: "nothing decides it",
};

const kernelFile = (text: string): SourceFile => ({
  path: `${KERNEL_DIR}store-labels.ts`,
  text,
});

const atomLeSource = kernelFile(`
/**
 * Whether \`proposed\` is at least as restrictive as \`current\`.
 *
 * @spec ${STORE} §8.12.1 atomLe sha256:${HASH_A}
 */
export function atomLe(proposed: unknown, current: unknown): boolean {
  return proposed === current;
}
`);

const input = (overrides: Partial<CheckInput>): CheckInput => ({
  snapshot,
  manifest: [atomLeRow, cnfRow],
  companions: [],
  kernelFiles: [atomLeSource],
  citationFiles: [],
  exemptions: [],
  markerFiles: [],
  budget: 3,
  ...overrides,
});

const messages = (findings: ReturnType<typeof collectFindings>): string[] =>
  findings.map((finding) => finding.message);

describe("check-cfc-correspondence", () => {
  describe("collectFindings()", () => {
    it("returns no findings for a manifest, kernel and citations that agree with the snapshot", () => {
      const citing: SourceFile = {
        path: "packages/runner/src/cfc/prepare.ts",
        text: "// §8.12.1 decides this, and §8 frames it.\n",
      };
      expect(collectFindings(input({ citationFiles: [citing] }))).toEqual([]);
    });

    describe("the manifest against the snapshot", () => {
      it("reports a row naming a function the snapshot lacks", () => {
        const row: ManifestRow = { ...cnfRow, name: "canUpdateStoreLabel" };
        expect(messages(collectFindings(input({ manifest: [atomLeRow, row] }))))
          .toEqual([
            "08-12-store-label-monotonicity.md §8.12.1 defines " +
            "`isMoreRestrictiveCNF`, which is neither a row nor a " +
            "companion; decide which it is",
            "the row for `canUpdateStoreLabel` names " +
            "08-12-store-label-monotonicity.md §8.12.1, where the snapshot " +
            "defines no such function",
          ]);
      });

      it("reports a row naming a section other than the one defining its function", () => {
        const row: ManifestRow = { ...cnfRow, section: "8.12.4" };
        expect(messages(collectFindings(input({ manifest: [atomLeRow, row] }))))
          .toEqual([
            "08-12-store-label-monotonicity.md §8.12.1 defines " +
            "`isMoreRestrictiveCNF`, which is neither a row nor a " +
            "companion; decide which it is",
            "08-12-store-label-monotonicity.md §8.12.4 defines `canWrite`, " +
            "which is neither a row nor a companion; decide which it is",
            "the row for `isMoreRestrictiveCNF` names " +
            "08-12-store-label-monotonicity.md §8.12.4, where the snapshot " +
            "defines no such function",
          ]);
      });

      it("reports a function the snapshot defines beside a row that is neither a row nor a companion", () => {
        expect(messages(collectFindings(input({ manifest: [atomLeRow] }))))
          .toEqual([
            "08-12-store-label-monotonicity.md §8.12.1 defines " +
            "`isMoreRestrictiveCNF`, which is neither a row nor a " +
            "companion; decide which it is",
          ]);
      });

      it("accepts a companion in place of a row", () => {
        const companion: Companion = {
          file: STORE,
          section: "8.12.1",
          name: "isMoreRestrictiveCNF",
          note: "helper",
        };
        expect(
          collectFindings(
            input({ manifest: [atomLeRow], companions: [companion] }),
          ),
        ).toEqual([]);
      });

      it("reports a companion the snapshot lacks, and one that is also a row", () => {
        const companions: Companion[] = [
          { file: STORE, section: "8.12.1", name: "ghost", note: "helper" },
          { file: STORE, section: "8.12.1", name: "atomLe", note: "helper" },
        ];
        expect(messages(collectFindings(input({ companions })))).toEqual([
          "`atomLe` in 08-12-store-label-monotonicity.md §8.12.1 is both a " +
          "row and a companion",
          "the companion `ghost` names 08-12-store-label-monotonicity.md " +
          "§8.12.1, where the snapshot defines no such function",
        ]);
      });

      it("reports two rows naming one function", () => {
        expect(
          messages(
            collectFindings(input({ manifest: [atomLeRow, cnfRow, cnfRow] })),
          ),
        ).toEqual([
          "two rows name 08-12-store-label-monotonicity.md §8.12.1 " +
          "`isMoreRestrictiveCNF`",
        ]);
      });
    });

    describe("the manifest against the kernel", () => {
      it("reports a `missing` row whose function the kernel exports", () => {
        const row: ManifestRow = {
          ...cnfRow,
          name: "atomLe",
        };
        expect(messages(collectFindings(input({ manifest: [row, cnfRow] }))))
          .toEqual([
            "the row for `atomLe` reads `missing`, and " +
            "packages/runner/src/cfc/kernel/store-labels.ts exports it",
          ]);
      });

      it("reports an `exact` row whose kernel file exports no such function", () => {
        expect(
          messages(collectFindings(input({ kernelFiles: [] }))),
        ).toEqual([
          "the row for `atomLe` names " +
          "packages/runner/src/cfc/kernel/store-labels.ts, which exports " +
          "no such function",
        ]);
      });

      it("reports an `exact` row naming a kernel file other than the exporting one", () => {
        const row: ManifestRow = { ...atomLeRow, kernelFile: "label.ts" };
        expect(messages(collectFindings(input({ manifest: [row, cnfRow] }))))
          .toEqual([
            "the row for `atomLe` names " +
            "packages/runner/src/cfc/kernel/label.ts, and " +
            "packages/runner/src/cfc/kernel/store-labels.ts is where it is " +
            "exported",
          ]);
      });

      it("reports an exported kernel function no row names", () => {
        const file = kernelFile(
          atomLeSource.text + `
/** @spec ${STORE} §8.12.1 isMoreRestrictiveCNF sha256:${HASH_A} */
export const isMoreRestrictiveCNF = (a: unknown, b: unknown): boolean =>
  a === b;
`,
        );
        expect(
          messages(
            collectFindings(
              input({ manifest: [atomLeRow], kernelFiles: [file] }),
            ),
          ),
        ).toEqual([
          "08-12-store-label-monotonicity.md §8.12.1 defines " +
          "`isMoreRestrictiveCNF`, which is neither a row nor a " +
          "companion; decide which it is",
          "exports `isMoreRestrictiveCNF()`, which no manifest row names",
        ]);
      });
    });

    describe("the kernel against the snapshot", () => {
      it("reports an exported function with no `@spec` header", () => {
        const file = kernelFile(`
/** Whether one atom entails another. */
export function atomLe(a: unknown, b: unknown): boolean {
  return a === b;
}
`);
        expect(messages(collectFindings(input({ kernelFiles: [file] }))))
          .toEqual([
            "the row for `atomLe` names " +
            "packages/runner/src/cfc/kernel/store-labels.ts, which exports " +
            "no such function",
            "`atomLe()` carries no `@spec` header",
          ]);
      });

      it("reports a header whose hash is not the snapshot's", () => {
        const file = kernelFile(
          atomLeSource.text.replace(HASH_A, HASH_B),
        );
        const findings = collectFindings(input({ kernelFiles: [file] }));
        expect(findings.map((finding) => [finding.line, finding.message]))
          .toEqual([[
            7,
            "`atomLe()` was derived from a block whose hash is now " +
            "aaaaaaaaaaaa…; re-derive it from " +
            "08-12-store-label-monotonicity.md §8.12.1 and update the header",
          ]]);
      });

      it("reports a header naming a function the snapshot lacks", () => {
        const file = kernelFile(
          atomLeSource.text.replace("§8.12.1 atomLe", "§8.12.4 atomLe"),
        );
        expect(messages(collectFindings(input({ kernelFiles: [file] }))))
          .toEqual([
            "the row for `atomLe` names 08-12-store-label-monotonicity.md " +
            "§8.12.1, and its header names " +
            "08-12-store-label-monotonicity.md §8.12.4",
            "`atomLe()` names 08-12-store-label-monotonicity.md §8.12.4, " +
            "where the snapshot defines no such function",
          ]);
      });

      it("reports a header written for another function", () => {
        const file = kernelFile(
          atomLeSource.text.replace("atomLe sha256", "canWrite sha256"),
        );
        expect(messages(collectFindings(input({ kernelFiles: [file] }))))
          .toEqual([
            "the row for `atomLe` names " +
            "packages/runner/src/cfc/kernel/store-labels.ts, which exports " +
            "no such function",
            "`atomLe()` carries a header for `canWrite`",
          ]);
      });

      it("reports a value import reaching outside the kernel", () => {
        const file = kernelFile(
          `import { deepEqual } from "@commonfabric/utils/deep-equal";\n` +
            `import type { Tx } from "../../storage/interface.ts";\n` +
            `import { clauseLe } from "./label.ts";\n` +
            `import { atom } from "@commonfabric/api/cfc";\n` +
            atomLeSource.text,
        );
        const findings = collectFindings(input({ kernelFiles: [file] }));
        expect(findings.map((finding) => [finding.line, finding.message]))
          .toEqual([[
            1,
            "imports `@commonfabric/utils/deep-equal`, which is outside the " +
            "kernel and not a shared type module; a kernel function takes " +
            "no transaction, reads no dial and calls no hook",
          ]]);
      });

      it("holds a ledger file to the import rule and not the header rule", () => {
        const manifest: SourceFile = {
          path: `${KERNEL_DIR}manifest.ts`,
          text:
            `import { deepEqual } from "@commonfabric/utils/deep-equal";\n` +
            `export const rows = () => [];\n`,
        };
        expect(
          messages(
            collectFindings(input({ kernelFiles: [atomLeSource, manifest] })),
          ),
        ).toEqual([
          "imports `@commonfabric/utils/deep-equal`, which is outside the " +
          "kernel and not a shared type module; a kernel function takes no " +
          "transaction, reads no dial and calls no hook",
        ]);
      });
    });

    describe("citations against the section list", () => {
      const cited = (text: string): SourceFile => ({
        path: "packages/runner/src/cfc/prepare.ts",
        text,
      });

      it("accepts a citation of a section the snapshot has, with or without a space", () => {
        const file = cited("// §8.12.1 and § 8.12.4, and chapter §8.\n");
        expect(collectFindings(input({ citationFiles: [file] }))).toEqual([]);
      });

      it("reports a citation of a section the snapshot lacks, with its line", () => {
        const file = cited("// fine: §8.12.1\n// stale: §8.15.12 here\n");
        const findings = collectFindings(input({ citationFiles: [file] }));
        expect(findings.map((finding) => [finding.line, finding.message]))
          .toEqual([[
            2,
            "cites §8.15.12, which the specification at 9e751d58 has no " +
            "section for",
          ]]);
      });

      it("accepts a citation an exemption names, and reports one it stops writing", () => {
        const exemptions: Exemption[] = [
          {
            file: "packages/runner/src/cfc/prepare.ts",
            citation: "§3.2.1",
            reason: "a labs document's section",
          },
          {
            file: "packages/runner/src/cfc/prepare.ts",
            citation: "§9.9.9",
            reason: "gone",
          },
        ];
        const file = cited("// template-population §3.2.1\n");
        expect(
          messages(
            collectFindings(input({ citationFiles: [file], exemptions })),
          ),
        ).toEqual([
          "EXEMPTIONS excuses §9.9.9, and the file no longer writes it",
        ]);
      });

      it("reports an exemption with no reason", () => {
        const exemptions: Exemption[] = [{
          file: "packages/runner/src/cfc/prepare.ts",
          citation: "§3.2.1",
          reason: " ",
        }];
        const file = cited("// §3.2.1\n");
        expect(
          messages(
            collectFindings(input({ citationFiles: [file], exemptions })),
          ),
        ).toEqual(["the EXEMPTIONS entry for §3.2.1 gives no reason"]);
      });

      it("holds an exemption to its own file", () => {
        const exemptions: Exemption[] = [{
          file: "packages/runner/src/cfc/other.ts",
          citation: "§3.2.1",
          reason: "a labs document's section",
        }];
        const file = cited("// §3.2.1\n");
        expect(
          messages(
            collectFindings(input({ citationFiles: [file], exemptions })),
          ),
        ).toEqual([
          "EXEMPTIONS excuses §3.2.1, and the file no longer writes it",
          "cites §3.2.1, which the specification at 9e751d58 has no " +
          "section for",
        ]);
      });
    });

    describe("`SPEC-PENDING` markers", () => {
      const marked = (path: string, text: string): SourceFile => ({
        path,
        text,
      });
      const ruled =
        "// SPEC-PENDING https://github.com/commonfabric/specs/pull/61\n";

      it("accepts markers within budget that name a specs pull request", () => {
        const files = [
          marked("packages/runner/src/cfc/prepare.ts", ruled + ruled),
          marked("packages/html/src/worker/reconciler.ts", ruled),
        ];
        expect(collectFindings(input({ markerFiles: files }))).toEqual([]);
      });

      it("reports a marker naming no specs pull request, with its line", () => {
        const file = marked(
          "packages/runner/src/cfc/prepare.ts",
          "const x = 1;\n// SPEC-PENDING: waiting on the ruling\n",
        );
        const findings = collectFindings(input({ markerFiles: [file] }));
        expect(findings.map((finding) => [finding.line, finding.message]))
          .toEqual([[
            2,
            "a `SPEC-PENDING` marker names no " +
            "`https://github.com/commonfabric/specs/pull/<n>`",
          ]]);
      });

      it("reports markers over budget", () => {
        const file = marked(
          "packages/runner/src/cfc/prepare.ts",
          ruled + ruled + ruled + ruled,
        );
        expect(messages(collectFindings(input({ markerFiles: [file] }))))
          .toEqual([
            "4 `SPEC-PENDING` markers exceed the budget of 3; land a ruling " +
            "before adding another",
          ]);
      });
    });
  });

  describe("exportedFunctions()", () => {
    it("returns each exported function declaration with the doc comment above it", () => {
      const source = [
        "/** One. */",
        "export function one(): void {}",
        "",
        "/**",
        " * Two.",
        " */",
        "export const two = (a: number): number => a;",
        "",
        "export async function three(): Promise<void> {}",
        "",
        "// Not a doc comment.",
        "export const four = async (): Promise<void> => {};",
        "",
        "export const five: (a: number) => number = (a) => a;",
        "",
        "export const notAFunction = { a: 1 };",
        "export type Alias = string;",
        "function internal(): void {}",
      ].join("\n");
      expect(
        exportedFunctions(source).map(({ name, comment }) => [name, comment]),
      ).toEqual([
        ["one", " One. "],
        ["two", "\n * Two.\n "],
        ["three", null],
        ["four", null],
        ["five", null],
      ]);
    });
  });

  describe("valueImports()", () => {
    it("returns the specifiers of value and bare imports and skips type imports", () => {
      const source = [
        `import { a } from "./a.ts";`,
        `import type { B } from "../b.ts";`,
        `import * as c from "@commonfabric/api/cfc";`,
        `import "./side-effect.ts";`,
        `import d, { type E } from "./d.ts";`,
        `import {`,
        `  f,`,
        `} from "./f.ts";`,
      ].join("\n");
      expect(valueImports(source).map(({ specifier }) => specifier)).toEqual([
        "./a.ts",
        "@commonfabric/api/cfc",
        "./side-effect.ts",
        "./d.ts",
        "./f.ts",
      ]);
    });
  });
});
