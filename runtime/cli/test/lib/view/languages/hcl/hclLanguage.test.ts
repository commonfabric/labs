import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { hclLanguage } from "../../../../../lib/view/languages/hcl/language.ts";
import { findReferences } from "../../../../../lib/view/references.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Every distinct class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.spans.filter((span) => span.text === text).map((span) => span.cls)
      ),
    ),
  ];
}

function highlight(source: string): Line[] {
  return hclLanguage.highlightLines(source);
}

describe("hclLanguage", () => {
  beforeAll(() => hclLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries the representative filenames and
    // aliases; these cases are the ones it does not.

    it("selects configuration files in any case", () => {
      for (const path of ["MAIN.TF", "Prod.TFVars", "Lock.HCL", "a.Tofu"]) {
        expect(languageForFile(path).id).toBe("hcl");
      }
    });

    it("leaves JSON configuration and templates to other languages", () => {
      expect(languageForFile("main.tf.json").id).toBe("json");
      expect(languageForFile("prod.tfvars.json").id).toBe("json");
      for (const path of ["startup-script.sh.tftpl", "terraform.tfstate"]) {
        expect(languageForFile(path).id).not.toBe("hcl");
      }
    });
  });

  describe("highlighting", () => {
    it("colors blocks, labels, attributes, and values", () => {
      const lines = highlight([
        "# Line comment",
        'resource "google_compute_instance" "runner" { // trailing',
        "  count        = var.enabled ? 1 : 0",
        "  machine_type = upper(local.size)",
        "  preemptible  = true",
        "  metadata     = null",
        "  disk_gb      = 2.5e3",
        "  zones        = google_compute_zone.all[*].name",
        "  /* block",
        "     comment */",
        "  service_account {",
        '    scopes = ["cloud-platform"]',
        "  }",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "# Line comment")).toEqual(["comment"]);
      expect(classesOf(lines, "// trailing")).toEqual(["comment"]);
      expect(classesOf(lines, "     comment */")).toEqual(["comment"]);
      expect(classesOf(lines, "resource")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "service_account")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "google_compute_instance")).toEqual([
        "interfaceName",
      ]);
      expect(classesOf(lines, "runner")).toEqual(["interfaceName"]);
      expect(classesOf(lines, '"')).toEqual(["string"]);
      for (const name of ["count", "machine_type", "scopes"]) {
        expect(classesOf(lines, name)).toEqual(["propertyName"]);
      }
      expect(classesOf(lines, "var")).toEqual(["keyword"]);
      expect(classesOf(lines, "local")).toEqual(["keyword"]);
      expect(classesOf(lines, "google_compute_zone")).toEqual(["identifier"]);
      // The name a reference reaches a declaration by is an identifier, and an
      // attribute read from what it reaches is a property.
      for (const name of ["enabled", "size", "all"]) {
        expect(classesOf(lines, name)).toEqual(["identifier"]);
      }
      expect(classesOf(lines, "name")).toEqual(["propertyName"]);
      expect(classesOf(lines, "upper")).toEqual(["callName"]);
      expect(classesOf(lines, "true")).toEqual(["boolean"]);
      expect(classesOf(lines, "null")).toEqual(["keyword"]);
      expect(classesOf(lines, "1")).toEqual(["number"]);
      expect(classesOf(lines, "2.5e3")).toEqual(["number"]);
      expect(classesOf(lines, '"cloud-platform"')).toEqual(["string"]);
      expect(classesOf(lines, "?")).toEqual(["operator"]);
      expect(classesOf(lines, ":")).toEqual(["operator"]);
      expect(classesOf(lines, "[*]")).toEqual(["operator"]);
      expect(classesOf(lines, ".")).toEqual(["punctuation"]);
      expect(classesOf(lines, "{")).toEqual(["bracket"]);
      expect(classesOf(lines, "[")).toEqual(["bracket"]);
    });

    it("colors object keys, for expressions, and operators", () => {
      const lines = highlight([
        "locals {",
        '  tags  = { team = "ci", "cost-center" : 42 }',
        '  names = [for i, s in var.list : lower(s) if s != ""]',
        "  byid  = { for r in var.rs : r.id => r... }",
        "  ok    = !var.off && -var.n < 2 || var.m >= 3",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "team")).toEqual(["propertyName"]);
      expect(classesOf(lines, '"cost-center"')).toEqual(["string"]);
      for (const keyword of ["for", "in", "if"]) {
        expect(classesOf(lines, keyword)).toEqual(["controlKeyword"]);
      }
      for (const binding of ["i", "s", "r"]) {
        expect(classesOf(lines, binding)).toContain("parameter");
      }
      expect(classesOf(lines, "s")).toEqual(["parameter", "identifier"]);
      for (const operator of ["=>", "...", "!", "&&", "-", "<", "||", ">="]) {
        expect(classesOf(lines, operator)).toEqual(["operator"]);
      }
      // A colon ends a for expression's introduction.
      expect(classesOf(lines, ":")).toEqual(["operator", "punctuation"]);
    });

    it("colors a template's interpolations and directives as code inside the string", () => {
      const lines = highlight([
        'name = "${var.prefix}-runner"',
        "script = <<-EOT",
        "  echo ${upper(var.x)}",
        "  %{~ if var.on ~}yes%{ else }no%{ endif }",
        "  %{ for h in var.hosts }${h} %{ endfor }",
        "  EOT",
      ].join("\n"));

      expect(classesOf(lines, '"')).toEqual(["string"]);
      expect(classesOf(lines, '-runner"')).toEqual(["string"]);
      expect(classesOf(lines, "<<-EOT")).toEqual(["string"]);
      expect(classesOf(lines, "  echo ")).toEqual(["string"]);
      expect(classesOf(lines, "yes")).toEqual(["string"]);
      expect(classesOf(lines, "  EOT")).toEqual(["string"]);
      expect(classesOf(lines, "prefix")).toEqual(["identifier"]);
      expect(classesOf(lines, "upper")).toEqual(["callName"]);
      expect(classesOf(lines, "${")).toEqual(["punctuation"]);
      expect(classesOf(lines, "%{")).toEqual(["punctuation"]);
      expect(classesOf(lines, "}")).toEqual(["punctuation"]);
      expect(classesOf(lines, "~")).toEqual(["operator"]);
      for (const keyword of ["if", "else", "endif", "for", "in", "endfor"]) {
        expect(classesOf(lines, keyword)).toEqual(["controlKeyword"]);
      }
      expect(classesOf(lines, "h")).toEqual(["parameter", "identifier"]);
      // The space inside a directive is not part of the string, while the
      // space between two directives is.
      expect(classesOf(lines, " ")).toEqual(["whitespace", "string"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'a = "open',
          'a = "${var.x',
          "a = <<EOT\nnever closed",
          'resource "x" {',
          "/* open comment",
          "= 3",
          "a = [for x in",
          "a = 1\r\nb = 2\r\n",
          "\ud800",
          "",
          " \t",
          'k = "café ☕ 😀"',
        ]
      ) {
        expect(verbatim(hclLanguage.parseDocument(source).lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    it("lists blocks with their labels, and the attributes that define values", () => {
      const source = [
        "terraform {",
        '  required_version = ">= 1.6"',
        "}",
        'variable "region" {',
        '  default = "us-central1"',
        "}",
        "locals {",
        "  name = var.region",
        "}",
        'resource "google_compute_network" "runners" {',
        "  name = local.name",
        "  dynamic legacy {",
        "  }",
        "}",
        'project_id = "cf-ci"',
      ].join("\n");
      const document = hclLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
        ]),
      ).toEqual([
        ["object", "terraform", 0, 0],
        ["object", 'variable "region"', 0, 3],
        ["object", "locals", 0, 6],
        ["variable", "name", 1, 7],
        ["object", 'resource "google_compute_network" "runners"', 0, 9],
        ["object", "dynamic legacy", 1, 11],
        ["variable", "project_id", 0, 14],
      ]);
      expect([...document.definitions.keys()]).toEqual([
        "region",
        "name",
        "runners",
        "legacy",
        "project_id",
      ]);
      expect(document.flatStructure[4].nameOffset).toBe(
        source.indexOf('"runners"') + 1,
      );
    });

    it("finds the uses of a declared name through the references that reach it", () => {
      const document = hclLanguage.parseDocument([
        'variable "zone" {}',
        'data "google_compute_image" "zone" {}',
        "locals {",
        "  primary = var.zone",
        "  image   = data.google_compute_image.zone.id",
        "  label   = local.primary.zone",
        "  key     = each.zone",
        '  set     = var.zone != "" && !data.google_compute_image.zone.ok',
        "  first   = var.zone[0]",
        "}",
      ].join("\n"));

      // A built-in namespace's attribute, such as \`each.zone\`, names no
      // declaration.
      expect(findReferences(document, "zone").map((use) => use.line)).toEqual([
        0,
        1,
        3,
        4,
        7,
        7,
        8,
      ]);
    });

    it("declares no name for a block whose label is empty", () => {
      const document = hclLanguage.parseDocument('module "" {\n}');

      expect(document.flatStructure.map((node) => [node.label, node.name]))
        .toEqual([['module ""', undefined]]);
      expect(document.definitions.size).toBe(0);
    });

    it("lists the blocks error recovery keeps inside an error", () => {
      // A brace typed after a block's end puts the block inside an error.
      const document = hclLanguage.parseDocument(
        ["locals {", "  enabled = true", "}{"].join("\n"),
      );

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["locals", 0], ["enabled", 1]]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "# café ☕ and an astral 😀",
        'variable "zone" {',
        '  default = "us-central1-a"',
        "}",
        "locals {",
        "  script = <<EOT",
        "  echo ${var.zone}",
        "EOT",
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ['"us-central1-a"', '"${var.region}-a"'],
        ['variable "zone"', 'output "zone"'],
        ["<<EOT", "<<-EOT"],
        ["EOT\n}", "EOX\n}"],
        ['"${var.region}-a"', '"${var.region'],
        ["# café", "café"],
      ];
      const highlighter = hclLanguage.createHighlighter(source);
      let current = source;
      for (const [from, to] of edits) {
        expect(current).toContain(from);
        current = current.replace(from, to);
        const updated = highlighter.update(current);
        expect(verbatim(updated)).toBe(current);
        expect(updated.map((line) => line.spans)).toEqual(
          highlight(current).map((line) => line.spans),
        );
      }
    });

    it("colors a diff of an unavailable file", () => {
      const diff = [
        "diff --git a/main.tf b/main.tf",
        "--- a/main.tf",
        "+++ b/main.tf",
        "@@ -1,3 +1,3 @@",
        ' resource "google_storage_bucket" "logs" {',
        '-  location = "US"',
        "+  location = var.location",
        " }",
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, "location")).toEqual([
        "propertyName",
        "identifier",
      ]);
      expect(classesOf(doc.lines, '"US"')).toEqual(["string"]);
      expect(classesOf(doc.lines, "var")).toEqual(["keyword"]);
      expect(classesOf(doc.lines, "logs")).toEqual(["interfaceName"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
