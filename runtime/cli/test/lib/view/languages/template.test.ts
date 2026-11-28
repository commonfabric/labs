import { expect } from "@std/expect";

import { parseDiff } from "../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  diffLanguages,
} from "../../../../lib/view/diffdoc.ts";
import {
  decodeLanguageInput,
  languageForFile,
  languageForName,
  languageForSource,
  prepareLanguages,
} from "../../../../lib/view/languages/language.ts";
import { jinjaSyntax } from "../../../../lib/view/languages/jinja/jinja.ts";
import { plainTextLanguage } from "../../../../lib/view/languages/plain-text/language.ts";
import { shellLanguage } from "../../../../lib/view/languages/shell/language.ts";
import {
  templateHostName,
  templateLanguage,
} from "../../../../lib/view/languages/template.ts";
import type { Line, TokenClass } from "../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

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

const jinjaShell = templateLanguage(jinjaSyntax, shellLanguage);
await prepareLanguages(
  [
    "jinja-shell",
    "jinja-yaml",
    "jinja-python",
    "jinja-toml",
    "jinja-json",
    "jinja-hcl",
    "jinja-typescript",
  ]
    .map((name) => languageForName(name)!),
);

/** Each template in the Infra repository, and the language it selects. */
const INFRA_TEMPLATES: readonly [string, string][] = [
  [
    "ansible/roles/bastion-ssh/templates/authorized_keys.j2",
    "jinja-authorized-keys",
  ],
  [
    "ansible/roles/bastion-tailscale/templates/tailscale-healthcheck.sh.j2",
    "jinja-shell",
  ],
  ["ansible/roles/ci-mac/templates/audit-daemon.plist.j2", "jinja-xml"],
  ["ansible/roles/ci-mac/templates/dashboard.plist.j2", "jinja-xml"],
  ["ansible/roles/ci-mac/templates/fluent-bit.yaml.j2", "jinja-yaml"],
  ["ansible/roles/ci-mac/templates/publishing-runner.plist.j2", "jinja-xml"],
  ["ansible/roles/ci-mac/templates/runner.env.j2", "jinja"],
  ["ansible/roles/ci-mac/templates/runner.plist.j2", "jinja-xml"],
  ["ansible/roles/ci-mac/templates/virtual-display.plist.j2", "jinja-xml"],
  ["ansible/roles/deploy/templates/deploy.sh.j2", "jinja-shell"],
  ["ansible/roles/nginx/templates/nginx-logrotate.j2", "jinja"],
  ["ansible/roles/nginx/templates/toolshed.conf.j2", "jinja"],
  ["ansible/roles/netdata/templates/systemdunits.conf.j2", "jinja"],
  ["ansible/roles/ops-agent/templates/config.yaml.j2", "jinja-yaml"],
  [
    "ansible/roles/otel-collector/templates/otel-collector-config.yaml.j2",
    "jinja-yaml",
  ],
  ["ansible/roles/otel-collector/templates/otel-collector.env.j2", "jinja"],
  [
    "ansible/roles/otel-collector/templates/otel-collector.service.j2",
    "jinja-systemd",
  ],
  [
    "ansible/roles/replica-service/templates/cf-replica.service.j2",
    "jinja-systemd",
  ],
  [
    "ansible/roles/replica-service/templates/nginx-location.conf.j2",
    "jinja-directive",
  ],
  ["ansible/roles/replica-service/templates/replica.env.j2", "jinja"],
  ["ansible/roles/replica-service/templates/toolshed-restart.conf.j2", "jinja"],
  ["ansible/roles/ssh/templates/authorized_keys.j2", "jinja-authorized-keys"],
  [
    "ansible/roles/tailscale/templates/tailscale-healthcheck.sh.j2",
    "jinja-shell",
  ],
  [
    "ansible/roles/tailscale/templates/tailscale-serve.service.j2",
    "jinja-systemd",
  ],
  ["ansible/roles/toolshed-binary/templates/deploy-sudoers.j2", "jinja"],
  [
    "ansible/roles/toolshed-binary/templates/log_deployment.sh.j2",
    "jinja-shell",
  ],
  [
    "ansible/roles/toolshed-binary/templates/start_toolshed.sh.j2",
    "jinja-shell",
  ],
  [
    "ansible/roles/toolshed-binary/templates/toolshed-binary@.service.j2",
    "jinja-systemd",
  ],
  [
    "ansible/roles/toolshed-binary/templates/validate_binary.sh.j2",
    "jinja-shell",
  ],
  [
    "ansible/roles/toolshed-ssh/templates/deploy_authorized_keys.j2",
    "jinja-authorized-keys",
  ],
  ["ansible/roles/toolshed/templates/toolshed@.service.j2", "jinja-systemd"],
  ["ansible/templates/toolshed-execution-switch.sh.j2", "jinja-shell"],
  ["ansible/templates/toolshed-topics-shard.conf.j2", "jinja"],
];

describe("template", () => {
  describe("selection", () => {
    it("selects Jinja over the language the rest of each Infra template's name selects", () => {
      for (const [path, id] of INFRA_TEMPLATES) {
        expect([path, languageForFile(path).id]).toEqual([path, id]);
        const host = languageForFile(templateHostName(jinjaSyntax, path)!);
        expect(languageForFile(path)).toBe(
          templateLanguage(jinjaSyntax, host),
        );
      }
    });

    it("selects Jinja over dotenv for Infra's environment templates from their source", () => {
      const source = "LANG=en_US.UTF-8\nPATH={{ commands }}:/usr/bin\n";
      for (const [path] of INFRA_TEMPLATES) {
        if (!path.endsWith(".env.j2")) continue;
        expect([path, languageForSource(path, source).id]).toEqual([
          path,
          "jinja-dotenv",
        ]);
        expect(languageForSource(path, "# only a comment\n").id).toBe("jinja");
      }
    });

    it("selects Jinja over systemd for Infra's drop-in templates from their source", () => {
      const source = '[Service]\nEnvironment="A={{ a }}"\n';
      for (
        const path of [
          "ansible/roles/replica-service/templates/toolshed-restart.conf.j2",
          "ansible/templates/toolshed-topics-shard.conf.j2",
        ]
      ) {
        expect([path, languageForSource(path, source).id]).toEqual([
          path,
          "jinja-systemd",
        ]);
      }
    });

    it("reads a template's old version in a diff when only its source can select the host", () => {
      const diff = (path: string) =>
        [
          `diff --git a/${path} b/${path}`,
          "index 1111111..2222222 100755",
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -5,1 +5,1 @@",
          "-cd {{ old }}",
          "+cd {{ new }}",
          "",
        ].join("\n");
      const requested: string[][] = [];
      const workspace = {
        resolve: () => null,
        read: () => null,
        readBlobs: (objects: readonly string[]) => {
          requested.push([...objects]);
          return new Map(
            objects.map((object) => [object, "#!/bin/bash\n\n\n\ncd x\n"]),
          );
        },
      };
      const [unsettled] = diffLanguages(
        diff("deploy.j2"),
        parseDiff(diff("deploy.j2"))!,
        workspace,
      );
      expect(unsettled.oldLanguage.id).toBe("jinja-shell");
      expect(requested).toEqual([["1111111"]]);

      requested.length = 0;
      const [settled] = diffLanguages(
        diff("deploy.sh.j2"),
        parseDiff(diff("deploy.sh.j2"))!,
        workspace,
      );
      expect(settled.oldLanguage.id).toBe("jinja-shell");
      expect(requested).toEqual([[]]);
    });

    it("strips each suffix without regard to case, and nothing else", () => {
      expect(templateHostName(jinjaSyntax, "a/run.sh.J2")).toBe("a/run.sh");
      expect(templateHostName(jinjaSyntax, "page.html.jinja2")).toBe(
        "page.html",
      );
      expect(templateHostName(jinjaSyntax, "page.yaml.Jinja")).toBe(
        "page.yaml",
      );
      expect(templateHostName(jinjaSyntax, "run.sh")).toBeUndefined();
      expect(templateHostName(jinjaSyntax, "j2")).toBeUndefined();
    });

    it("selects a template by its suffix before a pattern that claims the whole name", () => {
      expect(languageForFile("LICENSE.j2").id).toBe("jinja");
      expect(languageForFile("LICENSE.txt").id).toBe("plain-text");
    });

    it("selects the host from the source when the rest of the name selects none", () => {
      expect(languageForSource("deploy.j2", "#!/bin/bash\ncd {{ d }}\n").id)
        .toBe("jinja-shell");
      expect(languageForSource("deploy.j2", "cd {{ d }}\n").id).toBe("jinja");
      expect(
        decodeLanguageInput(
          "deploy.j2",
          new TextEncoder().encode("#!/bin/sh\nls\n"),
        ).language.id,
      ).toBe("jinja-shell");
    });

    it("layers over plain text where the rest of the name selects a byte language", () => {
      expect(languageForFile("logo.png.j2")).toBe(
        templateLanguage(jinjaSyntax, plainTextLanguage),
      );
    });

    it("selects a template from its name in direct source, before its shebang", () => {
      expect(languageForSource("deploy.sh.j2", "#!/usr/bin/env python3\n").id)
        .toBe("jinja-shell");
    });
  });

  describe("names", () => {
    it("builds one language for each host, named after the syntax and the host", () => {
      expect(templateLanguage(jinjaSyntax, shellLanguage)).toBe(jinjaShell);
      expect(jinjaShell.id).toBe("jinja-shell");
      expect(templateLanguage(jinjaSyntax, plainTextLanguage).id).toBe(
        "jinja",
      );
      expect(jinjaShell.metadata.aliases).toEqual([]);
    });

    it("resolves the syntax joined to a host's identifier or alias", () => {
      expect(languageForName("jinja-shell")).toBe(jinjaShell);
      expect(languageForName("jinja-sh")).toBe(jinjaShell);
      expect(languageForName("jinja-plain-text")).toBe(
        languageForName("jinja"),
      );
      expect(languageForName("jinja-jinja-shell")).toBe(
        languageForFile("a.sh.j2.j2"),
      );
      expect(languageForName("jinja-binary")).toBeUndefined();
      expect(languageForName("jinja-ruby")).toBeUndefined();
      expect(languageForName("j2-shell")).toBeUndefined();
    });
  });

  describe("highlighting", () => {
    it("colors the host's text around the template's regions", () => {
      const lines = jinjaShell.highlightLines(
        "cd {{ repo }} && echo done\n",
        "deploy.sh.j2",
      );
      expect(classesOf(lines, "cd")).toEqual(["callName"]);
      expect(classesOf(lines, "echo")).toEqual(["callName"]);
      expect(classesOf(lines, "{{")).toEqual(["template"]);
      expect(classesOf(lines, "repo")).toEqual(["identifier"]);
    });

    it("hides an expression as a name, so it can start a name or stand for a value", () => {
      const names = (name: string, source: string) =>
        languageForName(name)!.parseDocument(source).flatStructure.map((
          node,
        ) => node.name ?? node.label);
      expect(names("jinja-python", "def {{ n }}_handler():\n  pass\n"))
        .toEqual(["{{ n }}_handler"]);
      expect(names("jinja-shell", "{{ n }}() { :; }\ng() { :; }\n"))
        .toEqual(["{{ n }}", "g"]);
      expect(names("jinja-shell", "deploy_v2{{ s }}() { :; }\n")).toEqual([
        "deploy_v2{{ s }}",
      ]);
      expect(
        jinjaShell.highlightLines("x={{ a\n    | b }}\n").map((line) =>
          line.text
        ),
      ).toEqual(["x={{ a", "    | b }}", ""]);
    });

    it("hides an expression's line breaks with it, as its output has none", () => {
      const document = languageForName("jinja-python")!.parseDocument(
        "def g():\n  return f({{ a,\n    b }})\n\ndef h():\n  pass\n",
      );
      expect(document.flatStructure.map((node) => [node.label, node.startLine]))
        .toEqual([["def g", 0], ["def h", 4]]);
    });

    it("hides an expression as a number from a host whose values are literals", () => {
      const updates: string[] = [];
      const host = {
        ...plainTextLanguage,
        literalValues: true as const,
        createHighlighter(text: string) {
          updates.push(text);
          return plainTextLanguage.createHighlighter(text);
        },
      };
      templateLanguage(jinjaSyntax, host).createHighlighter(
        "k = {{ v }}\nl = {{x}}\n  {{ y\n  }}",
      );
      expect(updates).toEqual(["k = 1999999\nl = 19999\n  199999999"]);
    });

    it("hides an expression as a value, so a host whose values are typed reads the rest", () => {
      const toml = languageForName("jinja-toml")!.parseDocument(
        '[a]\nk = {{ v }}\n[b]\nz = "s"\n',
      );
      expect(toml.flatStructure.map((node) => node.label)).toEqual([
        "[a]",
        "k",
        "[b]",
        "z",
      ]);
    });

    it("hides each region from the host, so a host that would misread it reads the rest", () => {
      const yaml = languageForName("jinja-yaml")!;
      const lines = yaml.highlightLines(
        "{% for name in sinks %}\n{{ name }}:\n  level: {{ level }}\n{% endfor %}\n",
      );
      expect(classesOf(lines, "level")).toContain("propertyName");
      expect(classesOf(lines, "name")).toContain("binding");
      expect(classesOf(lines, "endfor")).toEqual(["controlKeyword"]);
    });

    it("reconstructs incomplete source exactly", () => {
      for (
        const source of [
          "echo {{ unclosed",
          "{# open comment\nls\n",
          "{% if a %}\r\nx=1\r\n",
          "é {{ ü }} ✓",
        ]
      ) {
        expect(verbatim(jinjaShell.highlightLines(source))).toBe(source);
        expect(jinjaShell.parseDocument(source).text).toBe(source);
      }
    });

    it("recolors each edit", () => {
      const highlighter = jinjaShell.createHighlighter("echo hi\n", "a.sh.j2");
      expect(classesOf(highlighter.lines, "{{")).toEqual([]);
      const lines = highlighter.update("echo {{ hi }}\n");
      expect(classesOf(lines, "{{")).toEqual(["template"]);
      expect(highlighter.update("echo {{ hi }}\n")).toBe(lines);
    });

    it("hands each edit to the host's own highlighter with the regions hidden", () => {
      const updates: string[] = [];
      const host = {
        ...plainTextLanguage,
        createHighlighter(text: string) {
          const highlighter = plainTextLanguage.createHighlighter(text);
          return {
            get lines() {
              return highlighter.lines;
            },
            update(next: string) {
              updates.push(next);
              return highlighter.update(next);
            },
          };
        },
      };
      const highlighter = templateLanguage(jinjaSyntax, host)
        .createHighlighter("a {{ b }}");
      highlighter.update("a {{ c }} {% if d %}");
      expect(updates).toEqual(["a _999999           "]);
    });

    it("keeps a live edit's colors equal to those of the whole edited source", () => {
      const highlighter = jinjaShell.createHighlighter(
        "f() {\n  echo {{ a }}\n}\n",
        "a.sh.j2",
      );
      for (
        const next of [
          "f() {\n  echo {{ a | b }}\n}\n",
          "f() {\n  echo {{ a | b \n}\n",
          "{% if x %}\nf() {\n  ls\n}\n{% endif %}\n",
        ]
      ) {
        expect(highlighter.update(next)).toEqual(
          jinjaShell.highlightLines(next, "a.sh.j2"),
        );
      }
    });

    it("leaves the nesting of the host's brackets alone around a region whose brackets do not balance", () => {
      const lines = jinjaShell.highlightLines("a=( {{ f( }} )\n");
      const depths = lines[0].spans.filter((span) => span.cls === "bracket")
        .map((span) => [span.text, span.bracketDepth]);
      expect(depths).toEqual([["(", 0], [")", 0]]);
      expect(
        lines[0].spans.find((span) => span.text === "(" && span.col === 8)
          ?.cls,
      ).toBe("punctuation");
    });

    it("places its host's structure in a diff hunk as its host does", () => {
      // Markdown lists only the headings a hunk shows, so the headings that
      // enclose the hunk from above stay out of its outline.
      const source = "# Tool\n\n## Usage\n\n### Deep\n\nRun it now.\n\n" +
        "## Notes\n";
      const outline = (path: string) => {
        const diff = [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -5,5 +5,5 @@",
          " ### Deep",
          " ",
          "-Run it.",
          "+Run it now.",
          " ",
          " ## Notes",
          "",
        ].join("\n");
        const { doc } = buildDiffDocument(diff, parseDiff(diff)!, {
          resolve: (name) => name === path ? path : null,
          read: (name) => name === path ? source : null,
        });
        // The first entry names the file itself.
        return doc.flatStructure.slice(1).map((node) =>
          `${node.depth}:${node.label}`
        );
      };
      expect(outline("README.md")).toEqual([
        "1:@@ -5,5 +5,5",
        "2:### Deep",
        "2:## Notes",
      ]);
      expect(outline("README.md.j2")).toEqual(outline("README.md"));
    });

    it("colors both sides of a template's diff over its host", () => {
      const diff = [
        "diff --git a/deploy.sh.j2 b/deploy.sh.j2",
        "--- a/deploy.sh.j2",
        "+++ b/deploy.sh.j2",
        "@@ -1 +1 @@",
        "-cd {{ old }}",
        "+cd {{ new }}",
        "",
      ].join("\n");
      const model = parseDiff(diff)!;
      const { doc } = buildDiffDocument(diff, model, {
        resolve: () => null,
        read: () => null,
      });
      expect(classesOf(doc.lines, "cd")).toEqual(["callName"]);
      expect(classesOf(doc.lines, "old")).toEqual(["identifier"]);
      expect(classesOf(doc.lines, "new")).toEqual(["identifier"]);
    });

    it("refuses a host whose lines do not reconstruct the source it read", () => {
      const host = {
        ...plainTextLanguage,
        highlightLines: (text: string) =>
          plainTextLanguage.highlightLines(text.slice(1)),
      };
      expect(() =>
        templateLanguage(jinjaSyntax, host).highlightLines("a {{ b }}")
      )
        .toThrow("The host's lines do not reconstruct the hidden source");
      expect(verbatim(
        templateLanguage(jinjaSyntax, plainTextLanguage).highlightLines(
          "a {{ b }}",
        ),
      )).toBe("a {{ b }}");
    });
  });

  describe("structure", () => {
    it("lists the host's structure, with names spelled as the source spells them", () => {
      const source = [
        "check_{{ env }}() {",
        "  true",
        "}",
        "{% if deploy %}",
        "deploy() { :; }",
        "{% endif %}",
        "",
      ].join("\n");
      const document = jinjaShell.parseDocument(source, "run.sh.j2");
      expect(
        document.flatStructure.map((node) => [
          node.label,
          node.name,
          node.startLine,
        ]),
      ).toEqual([
        ["check_{{ env }}()", "check_{{ env }}", 0],
        ["deploy()", "deploy", 4],
      ]);
      expect([...document.definitions.keys()]).toEqual([
        "check_{{ env }}",
        "deploy",
      ]);
      expect(classesOf(document.lines, "env")).toEqual(["identifier"]);
    });

    it("spells each label as the source does, whichever host made it", () => {
      const labels = (name: string, source: string) =>
        languageForName(name)!.parseDocument(source).flatStructure.map((
          node,
        ) => node.label);
      expect(labels("jinja-markdown", "# {{ title }} notes\ntext\n"))
        .toEqual(["# {{ title }} notes"]);
      expect(labels("jinja-xml", '<a name="{{ x }}"><b/></a>\n')).toEqual([
        "a {{ x }}",
        "b",
      ]);
      expect(
        labels("jinja-authorized-keys", "ssh-ed25519 AAAA {{ user }}@host\n"),
      ).toEqual(["{{ user }}@host"]);
      expect(labels("jinja-xml", '<a name="x_{{ y }}"/>\n')).toEqual([
        "a x_{{ y }}",
      ]);
    });

    it("spells each region in a label from its own source, whatever other regions read the same", () => {
      const label = (name: string, source: string) =>
        languageForName(name)!.parseDocument(source).flatStructure[0].label;
      expect(label("jinja-python", "@{{ a }}\ndef f_{{ b }}(): pass\n")).toBe(
        "def f_{{ b }}",
      );
      expect(label("jinja-xml", '<a x="{{ p }}" name="{{ q }}"/>\n')).toBe(
        "a {{ q }}",
      );
      expect(label("jinja-authorized-keys", "ssh-rsa {{ k }} {{ c }}\n"))
        .toBe("{{ c }}");
    });

    it("spells a region that spans lines as its whole source on one line", () => {
      const document = jinjaShell.parseDocument("{{ a\n }}x() { :; }\n");
      expect(document.flatStructure.map((node) => [node.label, node.name]))
        .toEqual([["{{ a }}x()", "{{ a }}x"]]);
    });

    it("spells labels after many short expressions, which leave a mark little room", () => {
      const many = "{{x}}\n".repeat(70);
      const label = (name: string, source: string) =>
        languageForName(name)!.parseDocument(many + source).flatStructure[0]
          .label;
      expect(label("jinja-xml", '<a name="{{y}}"/>\n')).toBe("a {{y}}");
      expect(label("jinja-authorized-keys", "ssh-rsa AAAA {{u}}@h\n")).toBe(
        "{{u}}@h",
      );
    });

    it("leaves source text that reads like a mark as the source has it", () => {
      const labels = (name: string, source: string) =>
        languageForName(name)!.parseDocument(source).flatStructure.map((
          node,
        ) => node.label);
      expect(labels("jinja-json", '{"10999": {"{{x}}": 1}}\n')).toEqual([
        "10999",
        "{{x}}",
      ]);
      expect(labels("jinja-xml", '<a name="{{ "_299" }}{{b}}"/>\n'))
        .toEqual(['a {{ "_299" }}{{b}}']);
      expect(labels("jinja-xml", '<a_0999 name="{{y}}"/>\n')).toEqual([
        "a_0999 {{y}}",
      ]);
      expect(labels("jinja-hcl", 'resource "x_0999" "{{y}}" {}\n')).toEqual([
        'resource "x_0999" "{{y}}"',
      ]);
    });

    it("spells a region in a label that the host cut short", () => {
      const ts = languageForName("jinja-typescript")!;
      const labels = ts.parseDocument(
        "aaaaaaaaaaaaaaaaaaaaa{{ q }}[{{ r }}](1);\n",
      )
        .flatStructure.map((node) => node.label);
      expect(labels).toContain("aaaaaaaaaaaaaaaaaaaaa{{ q }}…(…)");
      expect(labels.filter((label) => /_[0-9a-zA-Z]/.test(label))).toEqual([]);
    });

    it("hides a region too short for its mark so that it joins nothing to form one", () => {
      const keys = Array.from(
        { length: 520 },
        (_, index) =>
          `k${index.toString(36)}x = ${index === 2 ? "{{ third }}" : "{{x}}"}`,
      );
      const document = languageForName("jinja-toml")!.parseDocument(
        [...keys, "a13{{x}} = 1", ""].join("\n"),
      );
      const last = document.flatStructure.at(-1)!;
      expect([last.label, last.name]).toEqual(["a13{{x}}", "a13{{x}}"]);
    });

    it("leaves source text before a cut as the source has it, though it starts a mark", () => {
      const ts = languageForName("jinja-typescript")!;
      const labels = ts.parseDocument(
        "a".repeat(45) + "_abcdefg(1);\n" + "{{ r }};".repeat(10),
      ).flatStructure.map((node) => node.label);
      expect(labels).toContain("a".repeat(45) + "_a…");
      expect(labels.filter((label) => label.includes("{{ r }}…"))).toEqual(
        [],
      );
    });

    it("spells a cut mark only from the region the label reaches, by position", () => {
      const labels = (name: string, source: string) =>
        languageForName(name)!.parseDocument(source).flatStructure.map((
          node,
        ) => node.label);
      expect(
        labels(
          "jinja-typescript",
          "{{ r }};\n".repeat(8) + "a".repeat(45) +
            "_abcdefg(1, () => { aaaaaaaa{{ s }}; });\n",
        ),
      ).toContain("a".repeat(45) + "_a…");
      expect(
        labels("jinja-typescript", "a".repeat(40) + "{{q\n}}{{ r }}[1](1);\n"),
      ).toContain("a".repeat(40) + "{{q }}{{ r }}…");
      expect(labels("jinja-json", '{"x1…": "x{{a}}"}\n')).toEqual(["x1…"]);
    });

    it("leaves a cut that the source could hold elsewhere in the entry as the host showed it", () => {
      const labels = languageForName("jinja-typescript")!.parseDocument(
        "a".repeat(45) + "_0x(1, () => {\n" + "a".repeat(45) +
          "{{ y }};\n});\n",
      ).flatStructure.map((node) => node.label);
      expect(labels[0]).toBe("a".repeat(45) + "_0…");
    });

    it("spells a cut mark after a `…` that the source holds", () => {
      const label = (as: number) =>
        languageForName("jinja-typescript")!.parseDocument(
          `throw "${"a".repeat(as)}…" + {{ q }};\n`,
        ).flatStructure[0].label;
      expect(label(31)).toBe(`throw "${"a".repeat(31)}…" + {{ q }}…`);
      expect(label(32)).toBe(`throw "${"a".repeat(32)}…" + {{ q }}…`);
      expect(label(33)).toBe(`throw "${"a".repeat(33)}…" + …`);
    });

    it("spells a cut mark in a label whose name holds a region", () => {
      const [node] = languageForName("jinja-typescript")!.parseDocument(
        "const f{{a}} = (gggggggggggg{{ b }} || h)(1);\n",
      ).flatStructure;
      expect([node.label, node.name]).toEqual([
        "f{{a}} = (gggggggggggg{{ b }}…(…)",
        "f{{a}}",
      ]);
    });

    it("leaves a cut in a label the host built, not cut from the entry, as the host showed it", () => {
      const filler = "a".repeat(38);
      const labels = languageForName("jinja-typescript")!.parseDocument(
        `function f() {\n  throw   ${filler}{{ a }} + "throw ${filler}{{ b }}";\n}\n`,
      ).flatStructure.map((node) => node.label);
      expect(labels.filter((label) => label.startsWith("throw"))).toEqual([
        `throw ${filler}_…`,
      ]);
    });

    it("spells a name into the label where the name stands, though its text comes earlier", () => {
      const attributes = Array.from(
        { length: 3700 },
        (_, index) => `a${index} = "{{x}}"`,
      );
      const document = languageForName("jinja-hcl")!.parseDocument(
        [...attributes, 'resource "x_999" "x{{}}" {}', ""].join("\n"),
      );
      expect(
        document.flatStructure.filter((node) =>
          node.label.startsWith("resource")
        ).map((node) => [node.label, node.name]),
      ).toEqual([['resource "x_999" "x{{}}"', "x{{}}"]]);
    });

    it("spells a name that the host cut short into the label built from it", () => {
      const [, node] = languageForName("jinja-typescript")!.parseDocument(
        "class C {\n  [aaaaaaaaaaaaaaaaaaaaa{{ k }}bbbb]() {}\n}\n",
      ).flatStructure;
      expect([node.label, node.name]).toEqual([
        "ƒ [aaaaaaaaaaaaaaaaaaaaa{{ k }}…",
        "[aaaaaaaaaaaaaaaaaaaaa{{ k }}…",
      ]);
    });

    it("takes no name from a later word in the entry", () => {
      const [node] = languageForName("jinja-typescript")!.parseDocument(
        'const a_ = "a{{x}}";\n',
      ).flatStructure;
      expect([node.label, node.name]).toEqual(["a_", "a_"]);
    });

    it("finds a name where the host put it past its name offset", () => {
      const [node] = languageForName("jinja-json")!.parseDocument(
        "[" + "{{x}},".repeat(600) + '{"{{k}}": 1}]\n',
      ).flatStructure.slice(-1);
      expect([node.label, node.name]).toEqual(["{{k}}", "{{k}}"]);
    });

    it("spells every region in a label, besides the one in its name", () => {
      const document = languageForName("jinja-hcl")!.parseDocument(
        'resource "a" "{{b}}" "{{c}}" {}\n',
      );
      expect(document.flatStructure.map((node) => [node.label, node.name]))
        .toEqual([['resource "a" "{{b}}" "{{c}}"', "{{c}}"]]);
    });

    it("widens an entry that starts inside a region to the whole region", () => {
      const [node] = jinjaShell.parseDocument("{{ a\n  b }}x() { :; }\n")
        .flatStructure;
      expect([node.label, node.startLine, node.startCol]).toEqual([
        "{{ a b }}x()",
        0,
        0,
      ]);
      const [definition] = jinjaShell.parseDocument(
        "{{ a\n  b }}x() { :; }\n",
      ).definitions.get("{{ a b }}x")!;
      expect([definition.startLine, definition.startOffset]).toEqual([0, 0]);
    });

    it("takes a name from where the host found it, not from a region before it", () => {
      const document = languageForName("jinja-python")!.parseDocument(
        "@{{ d }}\ndef _(): pass\n",
      );
      expect(document.flatStructure.map((node) => [node.label, node.name]))
        .toEqual([["def _", "_"]]);
      expect([...document.definitions.keys()]).toEqual(["_"]);
    });

    it("spells a name as the source does whatever characters the region holds", () => {
      const document = jinjaShell.parseDocument('f{{ "$&" }}() { :; }\n');
      expect(document.flatStructure.map((node) => node.label)).toEqual([
        'f{{ "$&" }}()',
      ]);
    });

    it("counts columns in the source, where a region holds a character outside the Basic Multilingual Plane", () => {
      const document = jinjaShell.parseDocument('x={{ "😀" }}; f() { :; }\n');
      const [node] = document.flatStructure;
      expect([node.label, node.startCol]).toEqual(["f()", 13]);
    });

    it("counts the lines of a definition the host lists no entry for in the source", () => {
      // The host reads the region's line break as fill, so it counts `x` on
      // its second line where the source has it on its third.
      const host = {
        ...plainTextLanguage,
        parseDocument(text: string) {
          const startOffset = text.indexOf("x");
          const line = text.slice(0, startOffset).split("\n").length - 1;
          return {
            ...plainTextLanguage.parseDocument(text),
            definitions: new Map([["x", [{
              name: "x",
              kind: "variable" as const,
              startLine: line,
              endLine: line,
              startOffset,
              endOffset: startOffset + 1,
            }]]]),
          };
        },
      };
      const document = templateLanguage(jinjaSyntax, host).parseDocument(
        "{{ a\n }}\nx\n",
      );
      expect(document.flatStructure).toEqual([]);
      expect(document.definitions.get("x")).toEqual([{
        name: "x",
        kind: "variable",
        startLine: 2,
        endLine: 2,
        startOffset: 9,
        endOffset: 10,
      }]);
    });

    it("lists the host's entries that declare no name", () => {
      const document = languageForFile("authorized_keys.j2").parseDocument(
        "{% for key in keys %}\n{{ key }}\n{% endfor %}\nssh-rsa AAAA ci\n",
      );
      expect(
        document.flatStructure.map((node) => [node.label, node.startLine]),
      ).toEqual([["ci", 3]]);
    });
  });
});
