import { expect } from "@std/expect";

import {
  languageForFile,
  languageForName,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { systemdLanguage } from "../../../../../lib/view/languages/systemd/language.ts";
import type { Line } from "../../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Each line's spans other than white space, as `text cls` pairs, after
 * checking that the lines reconstruct `source`. */
function tokens(source: string): string[][] {
  const lines = systemdLanguage.highlightLines(source);
  expect(verbatim(lines)).toBe(source);
  return lines.map((line) =>
    line.spans.filter((span) => span.cls !== "whitespace").map((span) =>
      `${span.text} ${span.cls}`
    )
  );
}

/** Each structure entry's label, depth, and first and last lines. */
function outline(source: string): [string, number, number, number][] {
  return systemdLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

describe("systemdLanguage", () => {
  it("selects unit files by their unit type's suffix", () => {
    for (
      const name of [
        "deploy/memory-router-key.service",
        "deploy/probe-self@.service",
        "deploy/memory-router-key.socket",
        "deploy/memory-router.target",
        "backup.timer",
        "srv-data.mount",
        "srv-data.automount",
        "swapfile.swap",
        "watch.path",
        "limits.slice",
        "UPPER.SERVICE",
      ]
    ) {
      expect(languageForFile(name).id).toBe("systemd");
    }
    expect(languageForFile("dev-sda.device").id).toBe("plain-text");
    expect(languageForFile("session-1.scope").id).toBe("plain-text");
    expect(languageForFile("service").id).toBe("plain-text");
    expect(languageForFile("toolshed.service.d/override.conf").id)
      .toBe("plain-text");
    expect(languageForName("systemd")).toBe(systemdLanguage);
    expect(languageForName("systemd-unit")).toBe(systemdLanguage);
  });

  it("selects a `.conf` drop-in whose first section is one a unit holds", () => {
    for (
      const source of [
        "[Service]\nMemoryMax=4G",
        "# Limits\r\n\r\n  ; more\n\t[Unit]\nAfter=a.target",
        "\n[Install]",
      ]
    ) {
      expect(
        languageForSource("deploy/toolshed.service.d.example.conf", source).id,
      )
        .toBe("systemd");
    }
    for (const source of ["[req]\nprompt = no", "[Service", "A=1\n[Service]"]) {
      expect(languageForSource("override.conf", source).id).not.toBe("systemd");
    }
    expect(languageForSource("unit.txt", "[Service]\n").id).toBe("plain-text");
    expect(languageForSource("a.conf", "# x\n\r\r\n;y\r\n\t[Unit]").id)
      .toBe("systemd");
    // Every comment line that a `.conf` file opens with can end in either
    // order of carriage return and line feed, and the pattern must still
    // reject a file whose first section no unit holds without trying each
    // way of pairing them.
    const comments = "# setting\r\n".repeat(5000);
    expect(languageForSource("my.conf", `${comments}[mysqld]`).id)
      .not.toBe("systemd");
    expect(languageForSource("my.conf", `${comments}[Service]`).id)
      .toBe("systemd");
  });

  it("colors comments, sections, keys, and booleans, numbers, and strings", () => {
    expect(tokens(
      [
        "# A comment",
        "[Unit]",
        "Description = Memory router %i",
        "  ; An indented comment",
        "[Service]",
        "NoNewPrivileges=yes",
        "MemoryMax=5G",
        "CPUQuota=400%",
        "SocketMode=0600",
        "ProtectSystem=strict",
        'Environment="PORT=%i" A=100%%',
      ].join("\n"),
    )).toEqual([
      ["# A comment comment"],
      ["[ bracket", "Unit interfaceName", "] bracket"],
      [
        "Description propertyName",
        "= operator",
        "Memory router  string",
        "% punctuation",
        "i propertyName",
      ],
      ["; An indented comment comment"],
      ["[ bracket", "Service interfaceName", "] bracket"],
      ["NoNewPrivileges propertyName", "= operator", "yes boolean"],
      ["MemoryMax propertyName", "= operator", "5G number"],
      ["CPUQuota propertyName", "= operator", "400% number"],
      ["SocketMode propertyName", "= operator", "0600 number"],
      ["ProtectSystem propertyName", "= operator", "strict string"],
      [
        "Environment propertyName",
        "= operator",
        '"PORT= string',
        "% punctuation",
        "i propertyName",
        '" A=100 string',
        "%% punctuation",
      ],
    ]);
  });

  it("colors a command line's prefixes, programs, arguments, and expansions", () => {
    expect(tokens(
      [
        "ExecStartPre=-/usr/sbin/nft delete table",
        'ExecStart=@+/bin/run argv0 "two words" $A ${B} $$ ; !!/bin/next %n',
        "ExecStop=/bin/stop ${UNCLOSED",
        "ExecReload=",
      ].join("\n"),
    )).toEqual([
      [
        "ExecStartPre propertyName",
        "=- operator",
        "/usr/sbin/nft callName",
        "delete string",
        "table string",
      ],
      [
        "ExecStart propertyName",
        "=@+ operator",
        "/bin/run callName",
        "argv0 string",
        '"two words" string',
        "$ punctuation",
        "A propertyName",
        "${ punctuation",
        "B propertyName",
        "} punctuation",
        "$$ punctuation",
        "; punctuation",
        "!! operator",
        "/bin/next callName",
        "% punctuation",
        "n propertyName",
      ],
      [
        "ExecStop propertyName",
        "= operator",
        "/bin/stop callName",
        "${UNCLOSED string",
      ],
      ["ExecReload propertyName", "= operator"],
    ]);
  });

  it("colors settings that name paths rather than commands as strings", () => {
    expect(tokens("ExecPaths=/usr/bin /opt\nExecSearchPath=/usr/bin:/bin"))
      .toEqual([
        ["ExecPaths propertyName", "= operator", "/usr/bin /opt string"],
        ["ExecSearchPath propertyName", "= operator", "/usr/bin:/bin string"],
      ]);
  });

  it("expands a braced variable anywhere in a word, and a bare one only as the whole word", () => {
    expect(tokens('ExecStart=/bin/x a$FOO a${FOO} "$FOO" --p=$P')).toEqual([[
      "ExecStart propertyName",
      "= operator",
      "/bin/x callName",
      "a$FOO string",
      "a string",
      "${ punctuation",
      "FOO propertyName",
      "} punctuation",
      '" string',
      "$ punctuation",
      "FOO propertyName",
      '" string',
      "--p=$P string",
    ]]);
  });

  it("reads a braced name to its closing brace, and no bare name that starts with a digit", () => {
    expect(tokens("ExecStart=/bin/x ${A-B} $1")).toEqual([[
      "ExecStart propertyName",
      "= operator",
      "/bin/x callName",
      "${ punctuation",
      "A-B propertyName",
      "} punctuation",
      "$1 string",
    ]]);
  });

  it("leaves a braced name with a colon, or with no closing brace, as it is", () => {
    expect(tokens("ExecStart=/bin/x ${A:-b} ${A:b}${C} ${B")).toEqual([[
      "ExecStart propertyName",
      "= operator",
      "/bin/x callName",
      "${A:-b} string",
      "${A:b} string",
      "${ punctuation",
      "C propertyName",
      "} punctuation",
      "${B string",
    ]]);
  });

  it("keeps quotes in step after a backslash before a line separator", () => {
    expect(tokens('ExecStart=/bin/x "a\\ b" c d')[0].slice(-3)).toEqual([
      '"a\\ b" string',
      "c string",
      "d string",
    ]);
  });

  it("colors no expansions in a command whose prefix holds a colon", () => {
    expect(tokens("ExecStart=:/bin/echo $HOME ${A} $$ ; /bin/x $HOME"))
      .toEqual([[
        "ExecStart propertyName",
        "=: operator",
        "/bin/echo callName",
        "$HOME string",
        "${A} string",
        "$$ string",
        "; punctuation",
        "/bin/x callName",
        "$ punctuation",
        "HOME propertyName",
      ]]);
  });

  it("reads the shell prefix, and prefixes inside a quoted program", () => {
    expect(tokens('ExecStart=|echo hi\nExecStop="-/bin/foo" a')).toEqual([
      [
        "ExecStart propertyName",
        "=| operator",
        "echo callName",
        "hi string",
      ],
      [
        "ExecStop propertyName",
        "= operator",
        '" callName',
        "- operator",
        '/bin/foo" callName',
        "a string",
      ],
    ]);
  });

  it("colors specifiers and escaped dollar signs inside arguments", () => {
    expect(tokens("ExecStart=/bin/x a%nb 100%% $${A}")).toEqual([[
      "ExecStart propertyName",
      "= operator",
      "/bin/x callName",
      "a string",
      "% punctuation",
      "n propertyName",
      "b string",
      "100 string",
      "%% punctuation",
      "$$ punctuation",
      "{A} string",
    ]]);
  });

  it("keeps a quoted argument one word across a continuation", () => {
    expect(tokens('ExecStart=/bin/x "a \\\n b" c')).toEqual([
      [
        "ExecStart propertyName",
        "= operator",
        "/bin/x callName",
        '"a  string',
        "\\ punctuation",
      ],
      [' b" string', "c string"],
    ]);
  });

  it("reads a backslash outside quotes as escaping the character after it", () => {
    expect(tokens(
      [
        "ExecStart=/opt/my\\ app/run",
        'ExecStartPre=/bin/echo \\" ; /bin/true',
        "ExecStop=-",
      ].join("\n"),
    )).toEqual([
      [
        "ExecStart propertyName",
        "= operator",
        "/opt/my\\ callName",
        "app/run callName",
      ],
      [
        "ExecStartPre propertyName",
        "= operator",
        "/bin/echo callName",
        '\\" string',
        "; punctuation",
        "/bin/true callName",
      ],
      ["ExecStop propertyName", "=- operator"],
    ]);
  });

  it("colors only systemd's boolean words and numbers with its unit suffixes", () => {
    const source = [
      "A=y",
      "B=OFF",
      "C=10min",
      "D=1password",
      "E=1.5G",
      "F=-3",
      "G=yesno",
      "H=1min 30s",
      "I=5min30s",
      "J=5 30s",
      "K=1min x",
      "L=2 h",
      "M=10\u00b5s 5\u03bcs",
      "N=.5s",
      "O=1 password",
      "P=-",
      "Q=+",
      "R=infinity",
      "S=10.0.0.1",
      "T=1.5 .5s",
    ].join("\n");
    expect(tokens(source).map((line) => line.slice(2).join(", "))).toEqual([
      "y boolean",
      "OFF boolean",
      "10min number",
      "1password string",
      "1.5G number",
      "-3 number",
      "yesno string",
      "1min number, 30s number",
      "5min30s number",
      "5 number, 30s number",
      "1min x string",
      "2 number, h number",
      "10\u00b5s number, 5\u03bcs number",
      ".5s number",
      "1 password string",
      "- string",
      "+ string",
      "infinity number",
      "10.0.0.1 string",
      "1.5 .5s string",
    ]);
  });

  it("joins a line that ends in an odd number of backslashes to the next line that is not a comment", () => {
    const source = [
      "[Service]",
      "ExecStart=/bin/run one \\",
      "# skipped by the continuation \\",
      "  two",
      "Description=a\\\\",
      "Before=b",
      "Wants=c \\",
    ].join("\n");

    expect(tokens(source)).toEqual([
      ["[ bracket", "Service interfaceName", "] bracket"],
      [
        "ExecStart propertyName",
        "= operator",
        "/bin/run callName",
        "one string",
        "\\ punctuation",
      ],
      ["# skipped by the continuation \\ comment"],
      ["two string"],
      ["Description propertyName", "= operator", "a\\\\ string"],
      ["Before propertyName", "= operator", "b string"],
      ["Wants propertyName", "= operator", "c string", "\\ punctuation"],
    ]);
    expect(outline(source)).toEqual([
      ["[Service]", 0, 0, 6],
      ["ExecStart", 1, 1, 3],
      ["Description", 1, 4, 4],
      ["Before", 1, 5, 5],
      ["Wants", 1, 6, 6],
    ]);
  });

  it("ends a comment at the end of its line, even after a backslash", () => {
    expect(tokens("# note \\\nA=1")).toEqual([
      ["# note \\ comment"],
      ["A propertyName", "= operator", "1 number"],
    ]);
  });

  it("starts a comment only after spaces and tabs, not other white space", () => {
    expect(tokens(" \t# note\n\u00a0# key")).toEqual([
      ["# note comment"],
      ["# plain", "key plain"],
    ]);
  });

  it("reads a line feed and a carriage return in either order as one line end", () => {
    expect(tokens("A=x \\\n\rB=2\n\r\nC=3")).toEqual([
      ["A propertyName", "= operator", "x  string", "\\ punctuation"],
      ["B=2 string"],
      [],
      ["C propertyName", "= operator", "3 number"],
    ]);
  });

  it("ends a line at a carriage return that no line feed follows", () => {
    expect(tokens("A=1 \\\rB=2\rC=3")).toEqual([
      [
        "A propertyName",
        "= operator",
        "1  string",
        "\\ punctuation",
        "B=2 string",
        "C propertyName",
        "= operator",
        "3 number",
      ],
    ]);
  });

  it("ends a continuation at a blank line", () => {
    const source = "[Unit]\nA=1 \\\n\nB=2";

    expect(tokens(source)).toEqual([
      ["[ bracket", "Unit interfaceName", "] bracket"],
      ["A propertyName", "= operator", "1 number", "\\ punctuation"],
      [],
      ["B propertyName", "= operator", "2 number"],
    ]);
    expect(outline(source)).toEqual([
      ["[Unit]", 0, 0, 3],
      ["A", 1, 1, 1],
      ["B", 1, 3, 3],
    ]);
  });

  it("colors a section header that a continuation spans", () => {
    expect(tokens("[Ser\\\nvice]\nA=1")).toEqual([
      ["[ bracket", "Ser interfaceName", "\\ punctuation"],
      ["vice interfaceName", "] bracket"],
      ["A propertyName", "= operator", "1 number"],
    ]);
  });

  it("colors incomplete sections, keys, and quotes to the end of their line", () => {
    expect(
      tokens(
        '[Unit\n[Unit] junk\n[Unit]\t\nDescri\nExecStart=/bin/x "open\nA=b',
      ),
    ).toEqual([
      ["[ bracket", "Unit interfaceName"],
      ["[ bracket", "Unit interfaceName", "] bracket", "junk plain"],
      ["[ bracket", "Unit interfaceName", "] bracket"],
      ["Descri plain"],
      [
        "ExecStart propertyName",
        "= operator",
        "/bin/x callName",
        '"open string',
      ],
      ["A propertyName", "= operator", "b string"],
    ]);
  });

  it("ends each line at a carriage return before its line feed", () => {
    expect(tokens("[Unit]\r\nA=yes\r\nB=one \\\r\n two\r\n")).toEqual([
      ["[ bracket", "Unit interfaceName", "] bracket"],
      ["A propertyName", "= operator", "yes boolean"],
      ["B propertyName", "= operator", "one  string", "\\ punctuation"],
      [" two string"],
      [],
    ]);
  });

  it("lists neither a line with no `=` nor the white space after an unclosed header's name", () => {
    expect(outline("[Unit  \nDescri\nA=1")).toEqual([
      ["[Unit]", 0, 0, 2],
      ["A", 1, 2, 2],
    ]);
  });

  it("lists sections and the keys each one sets, with the keys before any section first", () => {
    expect(outline(
      [
        "Stray=1",
        "[Unit]",
        "Description=probe",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "=nameless",
      ].join("\n"),
    )).toEqual([
      ["Stray", 0, 0, 0],
      ["[Unit]", 0, 1, 2],
      ["Description", 1, 2, 2],
      ["[Install]", 0, 4, 6],
      ["WantedBy", 1, 5, 5],
    ]);
  });

  it("recolors the whole source after an edit that starts a continuation", () => {
    const highlighter = systemdLanguage.createHighlighter("A=1\nB=2");
    const lines = highlighter.update("A=1 \\\nB=2");

    expect(lines.map((line) => line.spans.map((span) => span.cls))).toEqual([
      ["propertyName", "operator", "string", "punctuation"],
      ["string"],
    ]);
    expect(highlighter.update("A=1\nB=2").map((line) => line.spans.length))
      .toEqual([3, 3]);
  });
});
