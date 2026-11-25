import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForName,
} from "../../../../../lib/view/languages/language.ts";
import { linkerScriptLanguage } from "../../../../../lib/view/languages/linker-script/language.ts";
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

/** Each structure entry's kind, label, depth, and first and last lines. */
function outline(
  source: string,
  fileName?: string,
): [string, string, number, number, number][] {
  return linkerScriptLanguage.parseDocument(source, fileName).flatStructure.map(
    (
      node,
    ) => [node.kind, node.label, node.depth, node.startLine, node.endLine],
  );
}

/** A name that marks a script the C preprocessor reads first. */
const PREPROCESSED = "sysmsg/pie.lds.S";

const VDSO = [
  "/* Linker script for the VDSO. */",
  "VDSO_PRELINK = 0xffffffffff700000;",
  "OUTPUT_ARCH(aarch64)",
  "SECTIONS {",
  "  _params = VDSO_PRELINK - 0x1000;",
  "  . = VDSO_PRELINK + SIZEOF_HEADERS;",
  "  .hash : { *(.hash) } :text",
  "  .eh_frame : { KEEP (*(.eh_frame)) } :text :eh_frame_hdr",
  "  . = ALIGN(0x1000);",
  "  .text : { *(.text*) } :text =0x90909090",
  "  /DISCARD/ : { *(.note*) }",
  "}",
  "PHDRS {",
  "  text PT_LOAD FLAGS(5) FILEHDR PHDRS;",
  "  eh_frame_hdr PT_GNU_EH_FRAME;",
  "}",
  "VERSION {",
  "  LINUX_2.6 {",
  "  global:",
  "    __vdso_time;",
  "  local: *;",
  "  };",
  "}",
].join("\n");

const FIRMWARE = [
  "ENTRY(_start)",
  "MEMORY {",
  "  rom (rx) : ORIGIN = 0x08000000, LENGTH = 512K",
  "  ram : ORIGIN = $20000000, LENGTH = 64k",
  "}",
  "SECTIONS {",
  "  .data : AT(LOADADDR(.text)) {",
  "    PROVIDE(__data_start = .);",
  "    HIDDEN(__data_mark = 1h);",
  "    *(.data)",
  "  } > ram AT > rom,",
  "  OVERLAY 0x1000 : {",
  "    .ov1 { *(.ov1) }",
  "    .ov2 { *(.ov2) } :text",
  "  } > ram",
  "  .bss (NOLOAD) : { . = . + 0x20; }",
  "}",
].join("\n");

describe("linkerScriptLanguage", () => {
  it("selects linker scripts by extension and by name", () => {
    expect(languageForFile("vdso/vdso_amd64.lds").id).toBe("linker-script");
    expect(languageForFile("firmware/link.LD").id).toBe("linker-script");
    expect(languageForFile("sysmsg/pie.lds.S").id).toBe("linker-script");
    expect(languageForFile("kernel/vmlinux.lds.S").id).toBe("linker-script");
    expect(languageForFile("bl31/bl31.ld.S").id).toBe("linker-script");
    expect(languageForFile("kernel/entry.S").id).not.toBe("linker-script");
    expect(languageForFile("tools/ld").id).toBe("plain-text");
    expect(languageForName("lds")).toBe(linkerScriptLanguage);
  });

  it("colors commands, assignments, output sections, and their trailers", () => {
    const lines = linkerScriptLanguage.highlightLines(VDSO);

    expect(classesOf(lines, "/* Linker script for the VDSO. */"))
      .toEqual(["comment"]);
    expect(classesOf(lines, "VDSO_PRELINK")).toEqual(["binding", "identifier"]);
    expect(classesOf(lines, "0xffffffffff700000")).toEqual(["number"]);
    expect(classesOf(lines, "OUTPUT_ARCH")).toEqual(["keyword"]);
    expect(classesOf(lines, "aarch64")).toEqual(["identifier"]);
    expect(classesOf(lines, "SECTIONS")).toEqual(["keyword"]);
    expect(classesOf(lines, "_params")).toEqual(["binding"]);
    expect(classesOf(lines, ".")).toEqual(["keyword"]);
    expect(classesOf(lines, "SIZEOF_HEADERS")).toEqual(["keyword"]);
    expect(classesOf(lines, ".hash")).toEqual(["interfaceName", "typeName"]);
    expect(classesOf(lines, "KEEP")).toEqual(["keyword"]);
    expect(classesOf(lines, "ALIGN")).toEqual(["callName"]);
    expect(classesOf(lines, ".text")).toEqual(["interfaceName", "typeName"]);
    expect(classesOf(lines, "/DISCARD/")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "text")).toEqual(["identifier", "interfaceName"]);
    expect(classesOf(lines, "=0x90909090")).toEqual([]);
    expect(classesOf(lines, "0x90909090")).toEqual(["number"]);
    expect(classesOf(lines, "PT_LOAD")).toEqual(["keyword"]);
    expect(classesOf(lines, "PT_GNU_EH_FRAME")).toEqual(["keyword"]);
    expect(classesOf(lines, "FILEHDR")).toEqual(["keyword"]);
    expect(classesOf(lines, "LINUX_2.6")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "global")).toEqual(["keyword"]);
    expect(classesOf(lines, "local")).toEqual(["keyword"]);
    expect(classesOf(lines, "__vdso_time")).toEqual(["identifier"]);
    expect(classesOf(lines, "{")).toEqual(["bracket"]);
    expect(classesOf(lines, ";")).toEqual(["punctuation"]);
    expect(
      lines.flatMap((line) => line.spans).filter((span) =>
        span.cls === "plain"
      ),
    )
      .toEqual([]);
    expect(verbatim(lines)).toBe(VDSO);
  });

  it("lists blocks, declarations, and assigned symbols as structure", () => {
    expect(outline(VDSO)).toEqual([
      ["variable", "VDSO_PRELINK", 0, 1, 1],
      ["object", "SECTIONS", 0, 3, 11],
      ["variable", "_params", 1, 4, 4],
      ["object", ".hash", 1, 6, 6],
      ["object", ".eh_frame", 1, 7, 7],
      ["object", ".text", 1, 9, 9],
      ["object", "/DISCARD/", 1, 10, 10],
      ["object", "PHDRS", 0, 12, 15],
      ["variable", "text", 1, 13, 13],
      ["variable", "eh_frame_hdr", 1, 14, 14],
      ["object", "VERSION", 0, 16, 22],
      ["object", "LINUX_2.6", 1, 17, 21],
    ]);
    const { definitions } = linkerScriptLanguage.parseDocument(VDSO);
    expect(definitions.get(".text")?.map((definition) => definition.startLine))
      .toEqual([9]);
    expect(definitions.has("SECTIONS")).toBe(false);
  });

  it("reads memory regions, provided symbols, overlays, and region trailers", () => {
    const lines = linkerScriptLanguage.highlightLines(FIRMWARE);

    expect(classesOf(lines, "rom")).toEqual(["interfaceName", "identifier"]);
    expect(classesOf(lines, "ram")).toEqual(["interfaceName", "identifier"]);
    expect(classesOf(lines, "rx")).toEqual(["identifier"]);
    expect(classesOf(lines, "ORIGIN")).toEqual(["keyword"]);
    expect(classesOf(lines, "512K")).toEqual(["number"]);
    expect(classesOf(lines, "$20000000")).toEqual(["number"]);
    expect(classesOf(lines, "64k")).toEqual(["number"]);
    expect(classesOf(lines, "1h")).toEqual(["number"]);
    expect(classesOf(lines, "LOADADDR")).toEqual(["callName"]);
    expect(classesOf(lines, "__data_start")).toEqual(["binding"]);
    expect(classesOf(lines, "__data_mark")).toEqual(["binding"]);
    expect(classesOf(lines, ".ov1")).toEqual(["interfaceName", "typeName"]);
    expect(classesOf(lines, "NOLOAD")).toEqual(["keyword"]);
    expect(outline(FIRMWARE)).toEqual([
      ["object", "MEMORY", 0, 1, 4],
      ["variable", "rom", 1, 2, 2],
      ["variable", "ram", 1, 3, 3],
      ["object", "SECTIONS", 0, 5, 16],
      ["object", ".data", 1, 6, 10],
      ["variable", "__data_start", 2, 7, 7],
      ["variable", "__data_mark", 2, 8, 8],
      ["object", "OVERLAY", 1, 11, 14],
      ["object", ".ov1", 2, 12, 12],
      ["object", ".ov2", 2, 13, 13],
      ["object", ".bss", 1, 15, 15],
    ]);
  });

  it("colors preprocessor directive lines and both comment forms", () => {
    const source = [
      "#include <asm/page.h>",
      "  # define ALIGNED(x) \\",
      "    . = ALIGN(x)",
      "// The sections the sentry maps.",
      "SECTIONS { .a : { ALIGNED(8); } } # trailing note",
      "#pragma once",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "#include")).toEqual(["keyword"]);
    expect(classesOf(lines, "asm")).toEqual(["identifier"]);
    expect(classesOf(lines, "define")).toEqual(["keyword"]);
    expect(classesOf(lines, "ALIGNED")).toEqual(["callName"]);
    expect(classesOf(lines, "// The sections the sentry maps."))
      .toEqual(["comment"]);
    expect(classesOf(lines, "# trailing note")).toEqual(["comment"]);
    expect(classesOf(lines, "#pragma")).toEqual(["keyword"]);
    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".a",
    ]);
  });

  it("does not take a name in an expression or a conditional for a declaration", () => {
    const source = [
      "SECTIONS {",
      "  . = defined ? first : second;",
      "  x == 1;",
      "  y = MAX(a, b) ? c : d;",
      "  ENTRY(start)",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source);

    expect(classesOf(lines, "defined")).toEqual(["identifier"]);
    expect(classesOf(lines, "first")).toEqual(["identifier"]);
    expect(classesOf(lines, "x")).toEqual(["identifier"]);
    expect(classesOf(lines, "b")).toEqual(["identifier"]);
    expect(outline(source).map(([, label]) => label)).toEqual([
      "SECTIONS",
      "y",
    ]);
  });

  it("starts a statement at a name right after an operand, as after a macro", () => {
    const source = [
      "SECTIONS {",
      "  .text : { TEXT_TEXT _etext = .; }",
      "  NOTES :text :note",
      "  .bss : { *(.bss) } =",
      "}",
      "PHDRS {",
      "  text PT_LOAD;",
      "}",
    ].join("\n");

    expect(outline(source).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".text",
      "_etext",
      ".bss",
      "PHDRS",
      "text",
    ]);
  });

  it("reads hyphenated section names, wildcards holding `/*`, and lowercase memory attributes", () => {
    const source = [
      "MEMORY { rom : org = 0, len = 1K }",
      "SECTIONS {",
      "  .note.gnu.build-id : { *(.note.gnu.build-id) }",
      "  . = . -4;",
      "  .text0 : { o1/*.o(.text) }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source);

    expect(classesOf(lines, "org")).toEqual(["keyword"]);
    expect(classesOf(lines, "len")).toEqual(["keyword"]);
    expect(classesOf(lines, ".note.gnu.build-id")).toEqual([
      "interfaceName",
      "typeName",
    ]);
    expect(classesOf(lines, "-")).toEqual(["operator"]);
    expect(classesOf(lines, "o1")).toEqual(["identifier"]);
    expect(outline(source).map(([, label]) => label)).toEqual([
      "MEMORY",
      "rom",
      "SECTIONS",
      ".note.gnu.build-id",
      ".text0",
    ]);
  });

  it("reads `#` as a comment and `//` as operators in a script the preprocessor does not read", () => {
    const source = [
      "VERSION {",
      "  VERS_1 {",
      "  # define the public API",
      "  global: foo; };",
      "}",
      "x = 4 // 2;",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, "# define the public API")).toEqual(["comment"]);
    expect(classesOf(lines, "//")).toEqual(["operator"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "VERSION",
      "VERS_1",
      "x",
    ]);
  });

  it("colors a `#` on a line that a directive continues onto as an operator", () => {
    const source = "#define A \\\n#define B \\\n  1\nSECTIONS { .a : { } }";
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "#define")).toEqual(["keyword"]);
    expect(classesOf(lines, "\\")).toEqual(["operator"]);
    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "define")).toEqual(["identifier"]);
    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".a",
    ]);
  });

  it("starts a statement after the parenthesis that ends a statement with no `;`", () => {
    const source = [
      "SECTIONS {",
      "  ENTRY(_start) .text : { *(.text) }",
      '  ASSERT(. < 0x1000, "big") .data : { start = .; *(.data) end = .; }',
      "  RO_DATA(4096) .rodata : { crt0.o(.rodata) }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source);

    expect(classesOf(lines, "end")).toEqual(["binding"]);
    expect(classesOf(lines, "RO_DATA")).toEqual(["callName"]);
    expect(classesOf(lines, "crt0.o")).toEqual(["identifier"]);
    expect(outline(source).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".text",
      ".data",
      "start",
      "end",
      ".rodata",
    ]);
  });

  it("starts a statement after an `INCLUDE`, and takes only attributes after an output section's `:`", () => {
    const source = [
      "SECTIONS {",
      "  INCLUDE common.ld",
      "  .b : AT(0x10) ALIGN(4) ONLY_IF_RO { *(.b) }",
      "  NOTES :text :note",
      "}",
    ].join("\n");

    expect(outline(source).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".b",
    ]);
  });

  it("colors `#` and `##` in a directive line as operators, and `$name` as a name", () => {
    const source = "#define STR(x) #x a##b\n$start = 1;";
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "x")).toEqual(["identifier"]);
    expect(classesOf(lines, "##")).toEqual(["operator"]);
    expect(classesOf(lines, "$start")).toEqual(["binding"]);
  });

  it("starts a statement after a keyword that is a whole statement and after a stray `)`, and reads a bare address", () => {
    const source = [
      "FORCE_COMMON_ALLOCATION",
      "_stack = 0x1000;",
      "SECTIONS {",
      "  .data : { *(.data) CONSTRUCTORS _edata = .; }",
      "  a ) .b : { }",
      "  FOO :)",
      "  .c _start : { }",
      "}",
    ].join("\n");

    expect(outline(source).map(([, label]) => label)).toEqual([
      "_stack",
      "SECTIONS",
      ".data",
      "_edata",
      ".b",
      ".c",
    ]);
  });

  it("gives a section its name after a macro that takes no parentheses in a preprocessed script, and reads a bare address in any other", () => {
    const source = [
      "SECTIONS {",
      "  DISCARDS",
      "  /DISCARD/ : { *(.eh_frame) }",
      "  .text ADDR(.init) : { *(.text) }",
      "  a(b, c(d, e, f(g, h) .i : { }",
      "}",
    ].join("\n");

    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      "/DISCARD/",
      ".text",
    ]);
    expect(
      outline("SECTIONS { text BASE : { *(.text) } }", "link.ld").map((
        [, label],
      ) => label),
    ).toEqual(["SECTIONS", "text"]);
  });

  it("reads a quoted `/*` or one in a `//` comment inside a preprocessed `#` comment as text, a keyword reserved only in expressions as a symbol, and ends a region before an `INCLUDE`", () => {
    const source = [
      "MEMORY {",
      "  ram : ORIGIN = 0, LENGTH = 1K",
      "  INCLUDE more.ld",
      "}",
      "INFO = 1;",
      "SECTIONS {",
      `  .a : { *(.a) } # see "lib/*.o" and 'x/*'`,
      "  .b : { *(.b) } # note // see /* below",
      "  .c : { *(.c) }",
      "}",
    ].join("\n");

    expect(outline(source, PREPROCESSED)).toEqual([
      ["object", "MEMORY", 0, 0, 3],
      ["variable", "ram", 1, 1, 1],
      ["variable", "INFO", 0, 4, 4],
      ["object", "SECTIONS", 0, 5, 9],
      ["object", ".a", 1, 6, 6],
      ["object", ".b", 1, 7, 7],
      ["object", ".c", 1, 8, 8],
    ]);
    expect(
      outline(
        "SECTIONS {\n  .c : { libfoo-1/*.o(.c) obj/1/*.o(.c) }\n  .d : { }\n}",
        "link.ld",
      ).map(([, label]) => label),
    ).toEqual(["SECTIONS", ".c", ".d"]);
  });

  it("runs a `#` comment on through a block comment and a trailing backslash in a preprocessed script", () => {
    const source = [
      "SECTIONS {",
      "  .d : { } # c \\",
      "  .e : { }",
      "  .g : { } # a /* b */ .h : { }",
      "}",
    ].join("\n");

    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".d",
      ".g",
    ]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".d",
      ".e",
      ".g",
    ]);
  });

  it("reads a `/*` that continues a pattern in an output section as part of it, and any other as a comment", () => {
    const source = [
      "MEMORY {",
      "  sram : ORIGIN = 0, LENGTH = 64K/*SRAM1*/",
      "  rom : ORIGIN = 0, LENGTH = 1M",
      "}",
      "_stack_size = 0x400/*1K*/;",
      "SECTIONS {",
      "  .ctors : { KEEP (*(EXCLUDE_FILE (*/*crtend.o) .ctors)) }",
      "  .text : { lib/*(.text) drivers/*/*.o(.text) lib/* (.text) }",
      "  .rodata : { lib[0-9]/*.o(.rodata) }",
      "  .data : { *(.data) }",
      "}",
      "VERSION {",
      "  V1 { local: */* } */; };",
      "  V2 { global: b; };",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, "/*SRAM1*/")).toEqual(["comment"]);
    expect(classesOf(lines, "/*1K*/")).toEqual(["comment"]);
    expect(classesOf(lines, "/* } */")).toEqual(["comment"]);
    expect(classesOf(lines, "crtend.o")).toEqual(["identifier"]);
    expect(classesOf(lines, "drivers")).toEqual(["identifier"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "MEMORY",
      "sram",
      "rom",
      "_stack_size",
      "SECTIONS",
      ".ctors",
      ".text",
      ".rodata",
      ".data",
      "VERSION",
      "V1",
      "V2",
    ]);
  });

  it("opens a comment at a `/*` after a name in an expression, in `OVERLAY`'s own braces, or outside an output section", () => {
    const source = [
      "}",
      "SECTIONS {",
      "  .data : { _edata = _end/* { */; *(.data) }",
      "  OVERLAY : { .ov1/* first */ { *(.ov1) } .ov2 { *(.ov2) } }",
      "  .a : { } > ram/* { */ .b : { lib/*.o(.b) }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, "/* { */")).toEqual(["comment"]);
    expect(classesOf(lines, "/* first */")).toEqual(["comment"]);
    expect(classesOf(lines, "/*")).toEqual(["operator"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".data",
      "_edata",
      "OVERLAY",
      ".ov1",
      ".ov2",
      ".a",
      ".b",
    ]);
  });

  it("starts a statement after a `,` or a `]`, and reads `PT_` names as keywords only in `PHDRS`", () => {
    const source = [
      "MEMORY { rom : ORIGIN = 0, LENGTH = 1K, ram : ORIGIN = 0x1000, LENGTH = 1K }",
      "PT_COUNT = 3;",
      "SECTIONS {",
      "  .a : { } > ram, .b : { lib[0-9]",
      "  _x = .; PT_X = .; }",
      "}",
      "PHDRS { text PT_LOAD; }",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, "PT_COUNT")).toEqual(["binding"]);
    expect(classesOf(lines, "PT_LOAD")).toEqual(["keyword"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "MEMORY",
      "rom",
      "ram",
      "PT_COUNT",
      "SECTIONS",
      ".a",
      ".b",
      "_x",
      "PT_X",
      "PHDRS",
      "text",
    ]);
  });

  it("opens a comment at a `/*` in the argument of a command that takes an expression, and reads patterns again after a `,` that ends an assignment", () => {
    const source = [
      "SECTIONS {",
      "  .data : { LONG(end/* } */) x = .; }",
      "  .text : { y = ., lib/*.o(.text) z = .; }",
      "  .bss : { *(.bss) }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, "/* } */")).toEqual(["comment"]);
    expect(classesOf(lines, "/*")).toEqual(["operator"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".data",
      "x",
      ".text",
      "y",
      "z",
      ".bss",
    ]);
  });

  it("reads a script as preprocessed when a line opens with a directive, and ends a string in a directive with its line", () => {
    const source = [
      "#include <mem.h>",
      '#error "unterminated',
      "#import <more.h>",
      "SECTIONS { .a : { *(.a) } } // done",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(
      source,
      "zephyr/linker.ld",
    );

    expect(classesOf(lines, "#include")).toEqual(["keyword"]);
    expect(classesOf(lines, "#import")).toEqual(["keyword"]);
    expect(classesOf(lines, '"unterminated')).toEqual(["string"]);
    expect(classesOf(lines, "// done")).toEqual(["comment"]);
    expect(outline(source, "zephyr/linker.ld").map(([, label]) => label))
      .toEqual(["SECTIONS", ".a"]);
  });

  it("reads a script as preprocessed from a directive a comment would not start with, and declares no program header inside parentheses", () => {
    const hunk = [
      "#else",
      "  .b : { *(.b) } // keep { in RAM",
      "#endif",
      "  .c : { *(.c) }",
    ].join("\n");
    const phdrs =
      "PHDRS {\n  text PT_LOAD AT(MAX(base, limit));\n  data PT_LOAD;\n}";

    expect(
      classesOf(
        linkerScriptLanguage.highlightLines(hunk, "linker.ld"),
        "#else",
      ),
    ).toEqual(["keyword"]);
    expect(
      classesOf(
        linkerScriptLanguage.highlightLines(hunk, "linker.ld"),
        "// keep { in RAM",
      ),
    ).toEqual(["comment"]);
    expect(outline(phdrs, "link.ld").map(([, label]) => label)).toEqual([
      "PHDRS",
      "text",
      "data",
    ]);
  });

  it("lists only the first branch of a conditional directive, and takes a section name with a `.` before a `(` for a section after a macro", () => {
    const source = [
      "SECTIONS {",
      "#ifdef CONFIG_PPC64",
      "  .text : AT(ADDR(.text) - LOAD_OFFSET) {",
      "    *(.text.head)",
      "#elif defined(CONFIG_X)",
      "  .text : {",
      "#else",
      "  .text : AT(ADDR(.text) - LOAD_OFFSET) {",
      "#endif",
      "    *(.text)",
      "  } :text",
      "  DISCARDS",
      "  .got.plt (INFO) : { *(.got.plt) }",
      "}",
      "PHDRS { text PT_LOAD; }",
    ].join("\n");

    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".text",
      ".got.plt",
      "PHDRS",
      "text",
    ]);
  });

  it("reads a script as plain when a `#` comment only starts with a word such as `if`", () => {
    const source = [
      "#if the board has more RAM, raise LENGTH below",
      "MEMORY { ram : ORIGIN = 0, LENGTH = 64K }",
      "SECTIONS {",
      "  .text : { lib/*.o(.text) *(.text) }",
      "  .data : { *(.data) }",
      "}",
    ].join("\n");

    expect(
      classesOf(
        linkerScriptLanguage.highlightLines(source, "board.ld"),
        "#if the board has more RAM, raise LENGTH below",
      ),
    ).toEqual(["comment"]);
    expect(outline(source, "board.ld").map(([, label]) => label)).toEqual([
      "MEMORY",
      "ram",
      "SECTIONS",
      ".text",
      ".data",
    ]);
  });

  it("colors the declarations of every branch of a conditional directive, and lists only the first branch's", () => {
    const source = [
      "SECTIONS {",
      "#ifdef A",
      "  .a : { *(.a) }",
      "  asym = .;",
      "#else",
      "  .b : { *(.b) }",
      "  bsym = .;",
      "#endif",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, ".a")).toEqual(["interfaceName", "typeName"]);
    expect(classesOf(lines, ".b")).toEqual(["interfaceName", "typeName"]);
    expect(classesOf(lines, "asym")).toEqual(["binding"]);
    expect(classesOf(lines, "bsym")).toEqual(["binding"]);
    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".a",
      "asym",
    ]);
  });

  it("reads a file or format name as one name, a `/*` after a `,` that ends an assignment as a comment, and a second `:` as ending a section's head", () => {
    const source = [
      "OUTPUT_ARCH(i386:x86-64)",
      "SEARCH_DIR(/usr/lib)",
      "INCLUDE common-defs.ld",
      "SECTIONS {",
      "  .h : { a = 1,/* c */ *(.h) }",
      "  f():() .i : { }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, "i386:x86-64")).toEqual(["identifier"]);
    expect(classesOf(lines, "/usr/lib")).toEqual(["identifier"]);
    expect(classesOf(lines, "common-defs.ld")).toEqual(["identifier"]);
    expect(classesOf(lines, "/* c */")).toEqual(["comment"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".h",
      "a",
      ".i",
    ]);
  });

  it("ends a string with its line and reads escaped quotes in a preprocessed script", () => {
    const source = [
      'SECTIONS { .a : { *("x',
      "#define Y 1",
      '#error "run \\"make # config\\" first"',
      'y") } }',
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, '"x')).toEqual(["string"]);
    expect(classesOf(lines, "#define")).toEqual(["keyword"]);
    expect(classesOf(lines, '"run \\"make # config\\" first"')).toEqual([
      "string",
    ]);
  });

  it("keeps a section whose head holds a conditional directive, and ends a region and a block within their own branch", () => {
    const source = [
      "MEMORY {",
      "#ifdef BIG",
      "  ram : ORIGIN = 0, LENGTH = 1M",
      "#else",
      "  ram : ORIGIN = 0, LENGTH = 64K",
      "#endif",
      "}",
      "SECTIONS {",
      "  .data : AT(ADDR(.data))",
      "#ifdef CONFIG_FOO",
      "  SUBALIGN(64)",
      "#endif",
      "  { *(.data) }",
      "  .a : {",
      "#ifdef X",
      "  }",
      "#else",
      "  }",
      "#endif",
      "}",
    ].join("\n");

    expect(outline(source, PREPROCESSED)).toEqual([
      ["object", "MEMORY", 0, 0, 6],
      ["variable", "ram", 1, 2, 2],
      ["object", "SECTIONS", 0, 7, 19],
      ["object", ".data", 1, 8, 12],
      ["object", ".a", 1, 13, 15],
    ]);
  });

  it("reads `AS_NEEDED` and `-l` names in a file list, ends a file name at a comment, and splices a preprocessed string", () => {
    const source = [
      "GROUP ( /lib/libc.so.6 AS_NEEDED ( /lib64/ld.so.2 ) -lc )",
      "INPUT(crt0.o/* startup */ libc.a)",
      '#define MSG "hello \\',
      'world /* not a comment */"',
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "AS_NEEDED")).toEqual(["keyword"]);
    expect(classesOf(lines, "-lc")).toEqual(["identifier"]);
    expect(classesOf(lines, "crt0.o")).toEqual(["identifier"]);
    expect(classesOf(lines, "/* startup */")).toEqual(["comment"]);
    expect(classesOf(lines, 'world /* not a comment */"')).toEqual(["string"]);
  });

  it("reads an `(OVERLAY)` section type as a type, not as the `OVERLAY` command, and its address as a name", () => {
    const source = [
      "SECTIONS",
      "{",
      "  .bss __bss_base (OVERLAY) : {",
      "    lib/*.o(.bss)",
      "    __bss_limit = .;",
      "  }",
      "  .a : { lib/*.o(.a) }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "f.ld");

    expect(classesOf(lines, "__bss_base")).toEqual(["identifier"]);
    expect(outline(source, "f.ld").map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".bss",
      "__bss_limit",
      ".a",
    ]);
  });

  it("reads a statement on through the first branch of a conditional directive inside it, and through parentheses it holds", () => {
    const source = [
      "SECTIONS {",
      "  .a :",
      "#ifdef X",
      "  AT(1)",
      "#else",
      "  ALIGN(4)",
      "#endif",
      "  { *(.a) }",
      "  .text : AT(ADDR(.text)",
      "#ifdef X",
      "    + 0x100",
      "#endif",
      "  ) { *(.text) }",
      "}",
      "INPUT(a.o",
      "#define Y 1 ",
      "b-x.o)",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "b-x.o")).toEqual(["identifier"]);
    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".a",
      ".text",
    ]);
  });

  it("continues a file name over `//` in a plain script, and runs a first-branch block left open to the end of the source", () => {
    expect(
      classesOf(
        linkerScriptLanguage.highlightLines("SEARCH_DIR(/usr//lib)", "a.ld"),
        "/usr//lib",
      ),
    ).toEqual(["identifier"]);
    expect(
      outline("SECTIONS {\n#ifdef X\n  .a : {\n#else\n  .b : {", PREPROCESSED),
    ).toEqual([
      ["object", "SECTIONS", 0, 0, 4],
      ["object", ".a", 1, 2, 4],
    ]);
  });

  it("reads quoted names, a C++ version pattern, a hyphen in an expression, a conditional address, and a head split across branches", () => {
    const source = [
      '"with space" = 1;',
      "SECTIONS {",
      '  PROVIDE("odd name" = .);',
      '  ".quoted" : { *(.q) }',
      "  x = .data_end-4;",
      "  .t2 DEFINED(x) ? 0x1000 : 0x2000 : { *(.t2) }",
      "}",
      'VERSION { V1 { extern "C++" { ns::global::*; }; }; }',
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, "link.ld");

    expect(classesOf(lines, '"with')).toEqual(["binding"]);
    expect(classesOf(lines, "global")).toEqual(["identifier"]);
    expect(classesOf(lines, ".data_end")).toEqual(["typeName"]);
    expect(outline(source, "link.ld").map(([, label]) => label)).toEqual([
      "with space",
      "SECTIONS",
      "odd name",
      ".quoted",
      "x",
      ".t2",
      "VERSION",
      "V1",
    ]);
    expect(
      outline(
        "SECTIONS {\n#ifdef A\n  .a : AT(1)\n#else\n  .b : AT(2)\n#endif\n  { *(.a) }\n}",
        PREPROCESSED,
      ).map(([, label]) => label),
    ).toEqual(["SECTIONS", ".a"]);
  });

  it("reads a script as plain when a comment opens with `#else` and words", () => {
    const source = [
      "#else branch of the board config: use the ROM layout",
      "SECTIONS {",
      "  .text : { lib/*.o(.text) }",
      "  .data : { *(.data) }",
      "}",
    ].join("\n");

    expect(outline(source, "board.ld").map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".text",
      ".data",
    ]);
  });

  it("opens a comment at every `/*` and lets a `//` comment run on after a backslash in a preprocessed script", () => {
    const source = [
      "#include_next <x.h>",
      "SECTIONS {",
      "  .t : { lib/*.o(.text) }",
      "  .d : { *(.data) } /* x */",
      "  // note \\",
      "  .e : { }",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "#include_next")).toEqual(["keyword"]);
    expect(classesOf(lines, "/*.o(.text) }")).toEqual(["comment"]);
    expect(classesOf(lines, "  .e : { }")).toEqual(["comment"]);
    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".t",
    ]);
  });

  it("opens a comment at `//` after a name, and at `/*` after a name outside an output section", () => {
    const source = [
      "SECTIONS {",
      "  .text : { *(.text) } > ram// keep { in RAM",
      "  .rodata : { *(.rodata) } > rom/* } */",
      "  .data : { } # a # b",
      "}",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source, PREPROCESSED);

    expect(classesOf(lines, "// keep { in RAM")).toEqual(["comment"]);
    expect(classesOf(lines, "/* } */")).toEqual(["comment"]);
    expect(classesOf(lines, "# a # b")).toEqual(["comment"]);
    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
      ".text",
      ".rodata",
      ".data",
    ]);
  });

  it("continues a directive past a comment that ends on a later line, and over a carriage return", () => {
    const source =
      "#define X /* a\n  b */ foo = 1;\n#define A \\\r\n  bar = 1\r\nSECTIONS { }";

    expect(outline(source, PREPROCESSED).map(([, label]) => label)).toEqual([
      "SECTIONS",
    ]);
  });

  it("does not take a branch of a conditional for a memory region", () => {
    const source = "MEMORY {\n  ram : ORIGIN = DEBUG ? lo : hi, LENGTH = 4K\n}";

    expect(classesOf(linkerScriptLanguage.highlightLines(source), "lo"))
      .toEqual(["identifier"]);
    expect(outline(source)).toEqual([
      ["object", "MEMORY", 0, 0, 2],
      ["variable", "ram", 1, 1, 1],
    ]);
  });

  it("ends an unclosed comment and an unclosed string at the end of the source, and lets a string span lines", () => {
    const source = 'OUTPUT_FORMAT("a\nb")\nSECTIONS {\n  .text : { /* open\n}';
    const lines = linkerScriptLanguage.highlightLines(source);

    expect(classesOf(lines, '"a')).toEqual(["string"]);
    expect(classesOf(lines, 'b"')).toEqual(["string"]);
    expect(classesOf(lines, "SECTIONS")).toEqual(["keyword"]);
    expect(classesOf(lines, "/* open")).toEqual(["comment"]);
    expect(classesOf(lines, "}")).toEqual(["comment"]);
    expect(verbatim(lines)).toBe(source);
    expect(outline(source)).toEqual([
      ["object", "SECTIONS", 0, 2, 3],
      ["object", ".text", 1, 3, 3],
    ]);
    expect(
      classesOf(linkerScriptLanguage.highlightLines('INPUT("open\nx)'), "x)"),
    ).toEqual(["string"]);
  });

  it("ends a declaration whose block never opens, and a block the source leaves open, at its last token", () => {
    expect(outline("SECTIONS {\n  .text : AT(0x10);\n  .data :")).toEqual([
      ["object", "SECTIONS", 0, 0, 2],
    ]);
    expect(outline("SECTIONS {\n  .text ALIGN(4)")).toEqual([
      ["object", "SECTIONS", 0, 0, 1],
    ]);
    expect(outline("MEMORY {\n  rom (rx")).toEqual([
      ["object", "MEMORY", 0, 0, 1],
    ]);
    expect(outline("PHDRS {\n  text PT_LOAD")).toEqual([
      ["object", "PHDRS", 0, 0, 1],
      ["variable", "text", 1, 1, 1],
    ]);
    expect(outline("SECTIONS {\n  start = (1 + 2")).toEqual([
      ["object", "SECTIONS", 0, 0, 1],
      ["variable", "start", 1, 1, 1],
    ]);
  });

  it("nests anonymous version nodes and `extern` blocks without declaring them", () => {
    const source = [
      "VERSION {",
      '  { global: extern "C++" { ns::*; }; local: *; };',
      "}",
      "} stray",
    ].join("\n");
    const lines = linkerScriptLanguage.highlightLines(source);

    expect(classesOf(lines, "extern")).toEqual(["keyword"]);
    expect(classesOf(lines, '"C++"')).toEqual(["string"]);
    expect(classesOf(lines, "stray")).toEqual(["identifier"]);
    expect(outline(source)).toEqual([["object", "VERSION", 0, 0, 2]]);
  });

  it("re-colors a live edit, and returns the same lines for unchanged text", () => {
    const highlighter = linkerScriptLanguage.createHighlighter(VDSO);
    const edited = VDSO.replace(".hash", ".gnu.hash");
    const lines = highlighter.update(edited);

    expect(classesOf(lines, ".gnu.hash")).toContain("interfaceName");
    expect(highlighter.update(edited)).toBe(lines);
    expect(linkerScriptLanguage.commentLinesAreInert).toBe(true);
    expect(linkerScriptLanguage.highlightFullFileOnDiffEdit).toBe(true);
  });
});
