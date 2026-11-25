import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import { buildDiffDocument } from "../../../../../lib/view/diffdoc.ts";
import { hclLanguage } from "../../../../../lib/view/languages/hcl/language.ts";
import {
  languageForFile,
  prepareLanguages,
} from "../../../../../lib/view/languages/language.ts";
import { terraformTemplateSyntax } from "../../../../../lib/view/languages/terraform-template/terraform-template.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { beforeAll, describe, it } from "@commonfabric/test-support/test";

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

/** Each region the scan finds in `source`, as its text and the host's fill. */
function regionsOf(source: string): [string, string][] {
  return terraformTemplateSyntax.scan(source).regions.map((region) => [
    source.slice(region.start, region.end),
    region.fill,
  ]);
}

/**
 * The class of each character of `code`, a sequence, as the HCL language colors
 * it in a heredoc, after a made-up opener for a directive that closes one and
 * before a made-up closer for one that opens one, so that the directive parses.
 */
function hclClasses(code: string): TokenClass[] {
  const keyword = /^%\{~?\s*(if|else|endif|for|endfor)\b/.exec(code)?.[1];
  const before = keyword === "else" || keyword === "endif"
    ? "%{if a}"
    : keyword === "endfor"
    ? "%{for a in b}"
    : "";
  const after = keyword === "if" || keyword === "else"
    ? "%{endif}"
    : keyword === "for"
    ? "%{endfor}"
    : "";
  const opening = `t = <<EOT\n${before}`;
  const lines = hclLanguage.highlightLines(`${opening}${code}${after}\nEOT\n`);
  return lines.flatMap((line) => [
    ...line.spans.flatMap((span) => [...span.text].map(() => span.cls)),
    "whitespace" as const,
  ]).slice(opening.length, opening.length + code.length);
}

/**
 * Expressions that exercise every rule by which the HCL language colors a
 * template's code.
 */
const EXPRESSIONS = [
  "${controller_url}",
  "${upper(name)}",
  '${ a ? "x" : "y" }',
  '${join(",", list)}',
  '${ [for s in xs : lower(s) if s != ""] }',
  "${ { for k, v in m : k => v } }",
  "${ [for a in [for b in c : b] : a] }",
  "${ [for x in c ? a : b : x] }",
  '${ m["k"] }',
  "${ a.b.c }",
  "${ f(x).y.z }",
  "${ xs[*].id }",
  "${ 2.5e3 + -1 }",
  "${ !a && b || c }",
  "${ null }",
  "${ true }",
  "${ a.true }",
  "${ x.in }",
  "${ x.for.y }",
  '${ jsonencode({a = 1, b = "x"}) }',
  "${ {a: 1, b = a == 2} }",
  "${ {\n a = 1\n b = 2\n} }",
  "${ {a: 1\n b: 2} }",
  "${ {k = [a, b]} }",
  "${ var.x }",
  "${ local.a.b }",
  "${ each.key }",
  "${ count.index }",
  "${ data.aws_ami.ami.id }",
  "${ module.m.out }",
  "${ xs... }",
  "%{ if a ~}",
  "%{ else }",
  "%{~ endif }",
  "%{ for k, v in m }",
  "%{ endfor }",
  '${ "q${r}s" }',
  "${ <<EOT\nhi ${x}\nEOT\n}",
  "${ f(1) # c\n}",
  "${ f(/* c */ 1) }",
  "${ café.é }",
  "${ upper (x) }",
  "${ <<EOT\r\nhi\r\nEOT\r\n}",
  '${ "a%{if x}b%{endif}c" }',
  "${ {a = [b, c == d]} }",
  "${ [for x in f(a ? b : c) : x] }",
  "${ self.x }",
  "${ path.module }",
  "${ {true = 1} }",
  "${ {null: 2} }",
  "${  in  }",
  "${ {/* c */ a = 1} }",
  "${ {\n# c\na = 1} }",
  "${ {a = 1, # c\nb = 2} }",
  "${ { for k, v in m :\n k => v } }",
  "${ a.0.1 }",
  "${ c ?\n x : y }",
  "${ [for s in\n xs : s] }",
  "${ {a = x ?\n y : z} }",
  "${ {for k in\n m : k => v} }",
  "${ {a = <<EOT\nx\nEOT\nb = 1} }",
  "${ {a = true\n b = 1} }",
  "${ {a = xs.*\n b = 1} }",
  "${ f /* c */ (x) }",
  "${ {a /* c */ = 1} }",
  "${ {a # c\n= 1} }",
  "${ {each /* c */ = 1} }",
  "${ {a = x-\n b = 2} }",
  "${ {a = xs[*]\n b = 2} }",
  "${ provider::aws::f(x) }",
  "${ [for x in provider::a::f(y) : x] }",
  "${ 1e5 }",
  "${ 0x1F }",
  "${ 1.5e3 }",
  "${ a /* b }",
];

const shellTemplate = languageForFile("startup-script.sh.tftpl");

describe("terraform-template", () => {
  beforeAll(() => prepareLanguages([shellTemplate, hclLanguage]));

  describe("selection", () => {
    // The shared fixture corpus carries the plain text and shell hosts'
    // filenames and aliases; this case is a host it does not.

    it("selects the template over the language the rest of the name selects", () => {
      expect(languageForFile("cloud-init.yaml.tftpl").id).toBe(
        "terraform-template-yaml",
      );
    });
  });

  describe("scan()", () => {
    it("returns each interpolation, directive, and escape with what the host reads in its place", () => {
      expect(regionsOf(
        'URL="${url}"\n%{ if on ~}\necho "$${HOME}" %%{x}\n%{~ endif }\n',
      )).toEqual([
        ["${url}", "_"],
        ["%{ if on ~}", " "],
        ["$", "_"],
        ["%", "_"],
        ["%{~ endif }", " "],
      ]);
    });

    it("returns no region for a dollar or percent sign that starts no sequence", () => {
      expect(regionsOf("echo $HOME 50% $(date) %d $ %")).toEqual([]);
    });

    it("reads a dollar sign before an escape as text", () => {
      expect(terraformTemplateSyntax.scan("$$${x}").regions).toEqual([
        { start: 1, end: 2, fill: "_" },
      ]);
    });

    it("ends a sequence at the brace that closes it, past the braces in its strings, comments, heredocs, and brackets", () => {
      for (
        const sequence of [
          '${ {a = "}"}["a"] }',
          '${ "a\\"}" }',
          '${ "${ "}" }" }',
          '${ "$${" }',
          "${ f(1) # }\n}",
          "${ f(1) // }\n}",
          "${ f(/* } */ 1) }",
          '${ <<EOT\n}\n${ "}" }\nEOT\n}',
          "${ <<-EOT\n  }\n  EOT\n}",
          "${ <<EOT\nxEOT\n}\nEOT\n}",
          "%{ for k, v in {a = 1} ~}",
          '${ "%%{" }',
          "${ {a = f(} }",
          "${ /* }",
        ]
      ) {
        expect(regionsOf(`${sequence}tail}`)).toEqual([
          [sequence, sequence[0] === "$" ? "_" : " "],
        ]);
      }
    });

    it("ends a quoted string in a sequence at its line's end when nothing closes it", () => {
      expect(regionsOf('${ "open\n}tail}')).toEqual([['${ "open\n}', "_"]]);
      expect(regionsOf('${ "a\\\n}tail}')).toEqual([['${ "a\\\n}', "_"]]);
    });

    it("runs a sequence that nothing closes to the end of the text", () => {
      expect(regionsOf('a\n${ f("}"\nb')).toEqual([['${ f("}"\nb', "_"]]);
      expect(regionsOf("${ <<EOT\n}")).toEqual([["${ <<EOT\n}", "_"]]);
    });

    it("colors each sequence's code as HCL colors a template's code, and an escaping character as punctuation", () => {
      const source =
        'A="${upper(name)}" $${B}\n%{ for h in hosts ~}\n${h}\n%{ endfor }';
      const { classes } = terraformTemplateSyntax.scan(source);
      const classAt = (text: string) => classes[source.indexOf(text)];

      expect(classAt("${upper")).toBe("punctuation");
      expect(classAt("upper")).toBe("callName");
      expect(classAt("(name")).toBe("bracket");
      expect(classAt("name")).toBe("identifier");
      expect(classAt('}" ')).toBe("punctuation");
      expect(classAt("$${")).toBe("punctuation");
      expect(classAt("for")).toBe("controlKeyword");
      expect(classAt("h in")).toBe("parameter");
      expect(classAt("in hosts")).toBe("controlKeyword");
      expect(classAt("~")).toBe("operator");
      expect(classAt("endfor")).toBe("controlKeyword");
    });

    it("leaves the host's text, and an escape's second character, without a class", () => {
      const source = 'A="${x}" $${B}';
      const { classes } = terraformTemplateSyntax.scan(source);

      expect(
        [...source].flatMap((char, i) => classes[i] === undefined ? [char] : [])
          .join(""),
      ).toBe('A="" ${B}');
    });

    it("colors each sequence's code as the HCL language colors it", () => {
      for (const code of EXPRESSIONS) {
        const { classes } = terraformTemplateSyntax.scan(code);
        const hcl = hclClasses(code);
        for (let at = 0; at < code.length; at++) {
          if (/\s/.test(code[at])) continue;
          expect([code, at, classes[at] ?? "plain"]).toEqual([
            code,
            at,
            hcl[at],
          ]);
        }
      }
    });

    it("colors the heredocs in sequences", () => {
      const source = '${ <<EOT\nhi\nEOT\n}${ "EOT" }${ <<-EOTT\n  x\n  EOTT\n}';
      const { classes } = terraformTemplateSyntax.scan(source);

      expect(classes[source.indexOf("hi")]).toBe("string");
      expect(classes[source.indexOf("x")]).toBe("string");
      expect(classes[source.lastIndexOf("}")]).toBe("punctuation");
    });

    it("colors every form of directive, with or without the directive it closes", () => {
      for (
        const source of [
          "%{ if a ~}x%{ else ~}y%{ endif ~}%{~ for h in hs ~}z%{~ endfor ~}",
          "%{ else ~}",
          "%{~ endif }",
          "%{ endfor ~}",
        ]
      ) {
        const { regions, classes } = terraformTemplateSyntax.scan(source);
        for (const { start, end } of regions) {
          const sequence = source.slice(start, end);
          expect([sequence, classes[end - 1]]).toEqual([
            sequence,
            "punctuation",
          ]);
          for (let at = start; at < end; at++) {
            if (source[at] === " ") {
              expect([sequence, at, classes[at]]).toEqual([
                sequence,
                at,
                undefined,
              ]);
            }
          }
        }
      }
    });

    it("colors the tokens of code that is not valid HCL, and only its strings as strings", () => {
      const source = '%{ y }${ f( }%{ endif x }${ "s" }${ <<EOT\nh\nEOT\n}';
      const { classes } = terraformTemplateSyntax.scan(source);

      expect(classes[source.indexOf("y")]).toBe("identifier");
      expect(classes[source.indexOf("f")]).toBe("callName");
      expect(classes[source.indexOf("x")]).toBe("identifier");
      expect(classes[source.indexOf("s")]).toBe("string");
      expect(classes[source.indexOf("h")]).toBe("string");
    });

    it("colors the code of a last sequence that nothing closes", () => {
      const source = 'A=1 ${x}\necho "${upper(name)';
      const { classes } = terraformTemplateSyntax.scan(source);

      expect(classes[source.indexOf("upper")]).toBe("callName");
      expect(classes[source.indexOf("name")]).toBe("identifier");
    });

    it("leaves a source with no sequence without a class", () => {
      const { regions, classes } = terraformTemplateSyntax.scan("echo $HOME");

      expect(regions).toEqual([]);
      expect(classes.filter((cls) => cls !== undefined)).toEqual([]);
    });
  });

  describe("over shell", () => {
    it("colors the shell around the template's sequences, and the shell expansion an escape produces", () => {
      const lines = shellTemplate.highlightLines([
        'URL="${controller_url}"',
        "%{ if debug ~}",
        "set -x",
        "%{ endif ~}",
        "curl -w '%%{http_code}' \"$${URL}/jit\" || true",
      ].join("\n"));

      expect(classesOf(lines, "URL")).toEqual(["propertyName"]);
      expect(classesOf(lines, "controller_url")).toEqual(["identifier"]);
      expect(classesOf(lines, "debug")).toEqual(["identifier"]);
      expect(classesOf(lines, "set")).toEqual(["callName"]);
      expect(classesOf(lines, "curl")).toEqual(["callName"]);
      expect(classesOf(lines, "%")).toEqual(["punctuation"]);
      expect(classesOf(lines, "%{http_code}'")).toEqual(["string"]);
      expect(classesOf(lines, "$${")).toEqual(["punctuation"]);
      expect(classesOf(lines, "||")).toEqual(["operator"]);
      expect(classesOf(lines, "true")).toEqual(["callName"]);
    });

    it("lists the shell's functions, with names spelled as the source spells them", () => {
      const document = shellTemplate.parseDocument(
        'install_${name}() {\n  echo "$${1}"\n}\nmain() {\n  :\n}\n',
      );

      expect(document.flatStructure.map((node) => [node.label, node.startLine]))
        .toEqual([["install_${name}()", 0], ["main()", 3]]);
    });

    it("reconstructs incomplete source exactly", () => {
      for (
        const source of [
          'echo "${unclosed',
          "%{ if a }\r\nx=1\r\n",
          "$$",
          "%%{",
          "é ${ü} ✓",
          "",
        ]
      ) {
        expect(verbatim(shellTemplate.highlightLines(source))).toBe(source);
        expect(verbatim(shellTemplate.parseDocument(source).lines)).toBe(
          source,
        );
      }
    });

    it("matches a complete highlight after each update", () => {
      let source = 'A="${a}"\nrun() {\n  echo "$${A}"\n}\n';
      const highlighter = shellTemplate.createHighlighter(source);
      for (
        const [from, to] of [
          ['"${a}"', '"${upper(a)}"'],
          ["$${A}", "${A}"],
          ["run() {", "%{ if on }\nrun() {"],
          ["}\n", "}\n%{ endif }\n"],
          ['"${upper(a)}"', '"${upper(a'],
        ]
      ) {
        expect(source).toContain(from);
        source = source.replace(from, to);
        expect(highlighter.update(source).map((line) => line.spans)).toEqual(
          shellTemplate.highlightLines(source).map((line) => line.spans),
        );
      }
    });

    it("colors both sides of a diff of an unavailable file", () => {
      const diff = [
        "diff --git a/boot.sh.tftpl b/boot.sh.tftpl",
        "--- a/boot.sh.tftpl",
        "+++ b/boot.sh.tftpl",
        "@@ -1 +1 @@",
        '-URL="${url}"',
        '+URL="$${URL:-${url}}"',
        "",
      ].join("\n");
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, {
        resolve: () => null,
        read: () => null,
      });

      expect(classesOf(doc.lines, "url")).toEqual(["identifier"]);
      expect(classesOf(doc.lines, "$${")).toEqual(["punctuation"]);
      expect(classesOf(doc.lines, ":-")).toEqual(["operator"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
