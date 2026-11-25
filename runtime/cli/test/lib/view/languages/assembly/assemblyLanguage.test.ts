import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForName,
} from "../../../../../lib/view/languages/language.ts";
import { assemblyLanguage } from "../../../../../lib/view/languages/assembly/language.ts";
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

/** The labels of the functions in the structure tree, in order. */
function functions(source: string): string[] {
  return outline(source).filter(([kind]) => kind === "function").map((
    [, label],
  ) => label);
}

/** Each structure entry's kind, label, depth, and first and last lines. */
function outline(source: string): [string, string, number, number, number][] {
  return assemblyLanguage.parseDocument(source).flatStructure.map((node) => [
    node.kind,
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

const GO = [
  '#include "textflag.h"',
  "",
  "#define FRAME_SIZE 16",
  "",
  "// func muldiv64(value, multiplier uint64) (uint64, bool)",
  "TEXT ·muldiv64(SB),NOSPLIT|NOFRAME,$0-33",
  "\tMOVQ value+0(FP), AX",
  "\tCMPQ CX, DX",
  "\tJLE overflow",
  "\tMOVB $1, ret1+32(FP)",
  "\tRET",
  "overflow:",
  "\tMOVQ $0, ret+24(FP)",
  "\tRET",
  "",
  "// The table below is data.",
  "GLOBL ·table(SB), RODATA, $8",
  "DATA ·table+0(SB)/8, $0x10",
  "TEXT runtime∕internal·spin(SB),NOSPLIT,$0",
  "\tMOVD V0.B16, R1",
  "\tRET",
].join("\n");

const GNU = [
  "#include <sys/syscall.h>",
  "# a comment, as the GNU assembler reads it on x86",
  "/* A comment",
  "   that spans lines. */",
  "  .text",
  "  .globl  rseq_loop",
  "  .type   rseq_loop, @function",
  "rseq_loop:",
  "  movq %rsi, 8(%rdi)",
  "1:",
  "  jmp 1b",
  "begin:",
  "  call memcpy@PLT",
  "  .byte 'a', \"text\"",
  "  ret",
  "  .size  rseq_loop,.-rseq_loop",
  '  .section .note.GNU-stack,"",%progbits',
  "  .type table, %object",
  "table:",
  "  .quad 0",
  "orphan:",
  "  BRK #0xdead",
].join("\n");

const MACROS = [
  "#define REGISTERS_SAVE(reg, offset) \\",
  "  MOVQ R15, offset+PTRACE_R15(reg); \\ // first register",
  "  MOVQ R14, offset+PTRACE_R14(reg);",
  "#define CPU_ERROR_CODE CPU_ARCH_STATE+0",
  "#define ADDR_OF_FUNC(name, symbol) \\",
  "TEXT name,$0-8; \\",
  "inside: \\",
  "  RET",
  "# define SPACED 1",
  "#ifdef GOARCH_amd64",
  "#endif",
  "#define",
  "TEXT ·entry(SB),NOSPLIT,$0",
  "\tREGISTERS_SAVE(AX, 0)",
  "\tRET",
].join("\n");

describe("assemblyLanguage", () => {
  it("selects assembly for `.s` and `.S` files and the `asm` name", () => {
    expect(languageForFile("pkg/sentry/time/muldiv_amd64.s").id)
      .toBe("assembly");
    expect(languageForFile("test/syscalls/linux/rseq/critical_amd64.S").id)
      .toBe("assembly");
    expect(languageForFile("pkg/goid/goid_amd64.tmpl.s").id).toBe("assembly");
    expect(languageForName("asm")?.id).toBe("assembly");
    expect(languageForName("assembly")?.id).toBe("assembly");

    expect(
      languageForFile("pkg/sentry/platform/systrap/sysmsg/pie.lds.S").id,
    ).not.toBe("assembly");
    expect(languageForFile("boot.asm").id).toBe("plain-text");
    expect(languageForFile("styles.css").id).not.toBe("assembly");
    expect(languageForFile("notes.ss").id).toBe("plain-text");
  });

  it("colors the Go assembler's directives, symbols, operands, and labels", () => {
    const lines = assemblyLanguage.highlightLines(GO);

    expect(classesOf(lines, "#include")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, '"textflag.h"')).toEqual(["string"]);
    expect(classesOf(lines, "// The table below is data.")).toEqual([
      "comment",
    ]);
    expect(classesOf(lines, "TEXT")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "·muldiv64")).toEqual(["functionName"]);
    expect(classesOf(lines, "runtime∕internal·spin")).toEqual([
      "functionName",
    ]);
    expect(classesOf(lines, "SB")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "NOSPLIT")).toEqual(["identifier"]);
    expect(classesOf(lines, "|")).toEqual(["operator"]);
    expect(classesOf(lines, "$")).toEqual(["operator"]);
    expect(classesOf(lines, "0x10")).toEqual(["number"]);
    expect(classesOf(lines, "33")).toEqual(["number"]);
    expect(classesOf(lines, "MOVQ")).toEqual(["keyword"]);
    expect(classesOf(lines, "value")).toEqual(["parameter"]);
    expect(classesOf(lines, "ret1")).toEqual(["parameter"]);
    expect(classesOf(lines, "FP")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "AX")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "V0.B16")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "(")).toEqual(["bracket"]);
    expect(classesOf(lines, ",")).toEqual(["punctuation"]);
    // A label's definition is colored as a declaration; a jump to it is not.
    expect(classesOf(lines, "overflow")).toEqual([
      "identifier",
      "functionName",
    ]);
    expect(classesOf(lines, ":")).toEqual(["punctuation"]);
    expect(classesOf(lines, "GLOBL")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "·table")).toEqual(["binding"]);
    expect(classesOf(lines, "RODATA")).toEqual(["identifier"]);
    expect(verbatim(lines)).toBe(GO);
  });

  it("colors GNU assembler directives, registers, symbol types, and comments", () => {
    const lines = assemblyLanguage.highlightLines(GNU);

    expect(classesOf(lines, "<sys/syscall.h>")).toEqual(["string"]);
    expect(
      classesOf(lines, "# a comment, as the GNU assembler reads it on x86"),
    ).toEqual(["comment"]);
    expect(classesOf(lines, "/* A comment")).toEqual(["comment"]);
    expect(classesOf(lines, "   that spans lines. */")).toEqual(["comment"]);
    expect(classesOf(lines, ".globl")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "rseq_loop")).toEqual([
      "identifier",
      "functionName",
    ]);
    expect(classesOf(lines, "@function")).toEqual(["keyword"]);
    expect(classesOf(lines, "%progbits")).toEqual(["keyword"]);
    expect(classesOf(lines, "%object")).toEqual(["keyword"]);
    expect(classesOf(lines, "@PLT")).toEqual(["keyword"]);
    expect(classesOf(lines, "%rsi")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "movq")).toEqual(["keyword"]);
    expect(classesOf(lines, "1")).toEqual(["functionName"]);
    expect(classesOf(lines, "1b")).toEqual(["number"]);
    expect(classesOf(lines, "memcpy")).toEqual(["identifier"]);
    expect(classesOf(lines, "'a'")).toEqual(["string"]);
    expect(classesOf(lines, '"text"')).toEqual(["string"]);
    expect(classesOf(lines, ".")).toEqual(["identifier"]);
    // On Arm, `#` marks an immediate value rather than a comment.
    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "0xdead")).toEqual(["number"]);
    expect(verbatim(lines)).toBe(GNU);
  });

  it("colors macro definitions, their parameters, bodies, and calls", () => {
    const lines = assemblyLanguage.highlightLines(MACROS);

    expect(classesOf(lines, "#define")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "define")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "SPACED")).toEqual(["binding"]);
    expect(classesOf(lines, "REGISTERS_SAVE")).toEqual([
      "binding",
      "callName",
    ]);
    expect(classesOf(lines, "reg")).toEqual(["parameter"]);
    expect(classesOf(lines, "\\")).toEqual(["punctuation"]);
    expect(classesOf(lines, "// first register")).toEqual(["comment"]);
    // Statements in a macro's body start on its continuation lines and after
    // each `;`, and a value on the `#define` line is an operand.
    expect(classesOf(lines, "MOVQ")).toEqual(["keyword"]);
    expect(classesOf(lines, "CPU_ARCH_STATE")).toEqual(["identifier"]);
    expect(classesOf(lines, "name")).toEqual(["parameter"]);
    expect(classesOf(lines, "inside")).toEqual(["functionName"]);
    expect(classesOf(lines, "#ifdef")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "GOARCH_amd64")).toEqual(["identifier"]);
    expect(classesOf(lines, "#endif")).toEqual(["storageKeyword"]);
    expect(verbatim(lines)).toBe(MACROS);
  });

  it("colors a `#` before white space as a comment, and a `#` before a value as an operator", () => {
    const source = [
      "  movq %rsp, %rdi # save the stack, don't clobber rax",
      "  cmpb $'0, %al",
      "  fmov d0, #1.5",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "# save the stack, don't clobber rax")).toEqual([
      "comment",
    ]);
    expect(classesOf(lines, "'0")).toEqual(["string"]);
    expect(classesOf(lines, "%al")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "1.5")).toEqual(["number"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("colors `#` and `##` in a `#define` body as preprocessor operators", () => {
    const source = "#define CAT(a, b) a ## b\n#define STR(x) #x";
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "##")).toEqual(["operator"]);
    expect(classesOf(lines, "x")).toEqual(["parameter"]);
  });

  it("colors a `#` before white space in an object-like macro's body as a comment", () => {
    const lines = assemblyLanguage.highlightLines(
      "#define SAVE movq %rax, %rbx # keep rax",
    );

    expect(classesOf(lines, "# keep rax")).toEqual(["comment"]);
  });

  it("colors the header that `#include_next` or `#import` names as a string", () => {
    const lines = assemblyLanguage.highlightLines(
      "#include_next <asm/unistd.h>\n#import <sys/types.h>",
    );

    expect(classesOf(lines, "#include_next")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "<asm/unistd.h>")).toEqual(["string"]);
    expect(classesOf(lines, "#import")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "<sys/types.h>")).toEqual(["string"]);
  });

  it("colors a GNU macro's parameters, and lists it once with nothing its body declares", () => {
    const source = [
      ".macro save_fpstate reg, offset",
      "  movq \\reg, \\offset(%rsp)",
      "use_xsave:",
      "  ret",
      ".endm",
      "  .globl __export_syshandler",
      "  .type __export_syshandler, @function",
      "__export_syshandler:",
      "  save_fpstate %rax, 8",
      "  ret",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, ".macro")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "save_fpstate")).toEqual(["binding", "keyword"]);
    expect(classesOf(lines, "reg")).toEqual(["parameter"]);
    expect(classesOf(lines, "\\reg")).toEqual(["parameter"]);
    expect(classesOf(lines, "\\offset")).toEqual(["parameter"]);
    expect(classesOf(lines, "use_xsave")).toEqual(["functionName"]);
    expect(classesOf(lines, ".endm")).toEqual(["storageKeyword"]);
    expect(outline(source)).toEqual([
      ["variable", ".macro save_fpstate", 0, 0, 4],
      ["function", "__export_syshandler:", 0, 7, 9],
    ]);
  });

  it("reads a `.type` directive's type in any of its spellings, and none inside a comment", () => {
    const source = [
      "/*",
      "  .type commented, @function",
      "*/",
      '  .type arm, #function; .type quoted, "object"',
      "  .type object, @function",
      "  .type untyped, @notype",
      "commented:",
      "  nop",
      "arm:",
      "  ret",
      "  .size elsewhere, 4",
      "  ret",
      "quoted:",
      "  .quad 0",
      "object:",
      "  ret",
      "untyped:",
      "  ret",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "function")).toEqual(["keyword"]);
    expect(classesOf(lines, '"object"')).toEqual(["string"]);
    expect(classesOf(lines, "object")).toEqual(["identifier", "functionName"]);
    expect(classesOf(lines, "@notype")).toEqual(["keyword"]);
    // A `.size` directive for another symbol leaves the function open.
    expect(outline(source)).toEqual([
      ["statement", "commented:", 0, 6, 7],
      ["function", "arm:", 0, 8, 11],
      ["variable", "quoted:", 0, 12, 13],
      ["function", "object:", 0, 14, 17],
      ["statement", "untyped:", 1, 16, 17],
    ]);
  });

  it("ends a Go function at the next declaration, and not at a macro inside it", () => {
    const source = [
      "TEXT ·spin(SB),NOSPLIT,$0",
      "#define get_tls(r) MOVQ TLS, r",
      "loop:",
      "  get_tls(AX)",
      "  JMP loop",
      "",
      "// The table.",
      "DATA ·table+0(SB)/8, $1",
      "GLOBL ·table(SB), RODATA, $8",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    // A function-like macro's body is a statement.
    expect(classesOf(lines, "MOVQ")).toEqual(["keyword"]);
    expect(classesOf(lines, "TLS")).toEqual(["typeKeyword"]);
    expect(outline(source)).toEqual([
      ["function", "TEXT ·spin", 0, 0, 4],
      ["variable", "#define get_tls", 1, 1, 1],
      ["statement", "loop:", 1, 2, 4],
      ["variable", "GLOBL ·table", 0, 8, 8],
    ]);
  });

  it("lists a macro inside a function only when the function's code continues after it", () => {
    const source = [
      "TEXT ·foo(SB),NOSPLIT,$0",
      "#define ADDR_OF(name, symbol) \\",
      "TEXT name,$0-8; \\",
      "  MOVQ $symbol, AX",
      "  RET",
      "",
      "#define BAR 1",
      "",
      "TEXT ·baz(SB),NOSPLIT,$0",
      "  RET",
      "#define TRAILING 2",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["function", "TEXT ·foo", 0, 0, 4],
      ["variable", "#define ADDR_OF", 1, 1, 3],
      ["variable", "#define BAR", 0, 6, 6],
      ["function", "TEXT ·baz", 0, 8, 9],
      ["variable", "#define TRAILING", 0, 10, 10],
    ]);
  });

  it("ends a GNU function or object at its last code before the next symbol, macro, or preprocessor line", () => {
    const source = [
      "  .type tbl, @object",
      "tbl:",
      "  .quad 0",
      "  .size tbl, 8",
      "  .text",
      "  .type f, @function",
      "f:",
      "  ret",
      ".macro m",
      "  nop",
      ".endm",
      "#ifdef X",
      '#include "y.h"',
      "#endif",
      "  .type g, @function",
      "g:",
      "loop:",
      "#define D 1",
      "  jmp loop",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["variable", "tbl:", 0, 1, 2],
      ["function", "f:", 0, 6, 7],
      ["variable", ".macro m", 0, 8, 10],
      ["function", "g:", 0, 15, 18],
      ["statement", "loop:", 1, 16, 18],
      ["variable", "#define D", 2, 17, 17],
    ]);
  });

  it("lists a label after a function's `.size` at the top level", () => {
    const source = [
      "  .type f, @function",
      "f:",
      "  ret",
      "  .size f, .-f",
      "  .pushsection .rodata",
      "after:",
      "  .quad 0",
      "  .popsection",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["function", "f:", 0, 1, 2],
      ["statement", "after:", 0, 5, 6],
    ]);
  });

  it("lists the functions a macro call declares, under the arguments that name them", () => {
    const source = [
      "#define ADDR_OF_FUNC(name, symbol) \\",
      "TEXT name,$0-8; \\",
      "  MOVQ $symbol, AX; \\",
      "  RET",
      "#define EXCEPTION(value, symbol, addr) \\",
      "ADDR_OF_FUNC(addr, symbol); \\",
      "TEXT symbol,NOSPLIT|NOFRAME,$0; \\",
      "  PUSHQ $value; \\",
      "  JMP ·exception(SB);",
      "TEXT ·a(SB),$0",
      "  RET",
      "",
      "EXCEPTION(DivideByZero, ·divideByZero(SB), ·addrOfDivideByZero(SB))",
      "  NOP",
      "ADDR_OF_FUNC(·unclosed(SB),",
      "ADDR_OF_FUNC()",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "ADDR_OF_FUNC")).toEqual(["binding", "callName"]);
    expect(classesOf(lines, "·divideByZero")).toEqual(["functionName"]);
    expect(classesOf(lines, "DivideByZero")).toEqual(["identifier"]);
    // Code after the call belongs to the last function it declares.
    expect(outline(source)).toEqual([
      ["variable", "#define ADDR_OF_FUNC", 0, 0, 3],
      ["variable", "#define EXCEPTION", 0, 4, 8],
      ["function", "TEXT ·a", 0, 9, 10],
      ["function", "EXCEPTION ·addrOfDivideByZero", 0, 12, 12],
      ["function", "EXCEPTION ·divideByZero", 0, 12, 13],
      // A call that names no function leaves the open one open.
      ["function", "ADDR_OF_FUNC ·unclosed", 0, 14, 15],
    ]);
  });

  it("resolves a macro's functions through the macros defined before it", () => {
    const source = [
      "EARLY(·tooEarly(SB))",
      "#define EARLY(name) TEXT name,$0",
      "EARLY(·later(SB))",
      "#define INNER(name, target) TEXT name,$0-8; MOVQ $target, AX",
      "#define OUTER(symbol, addr) \\",
      "INNER(addr, symbol); \\",
      "TEXT symbol,$0; RET",
      "#define FIRST(x, y) LATER(y); TEXT x,$0",
      "#define LATER(z) TEXT z,$0",
      "OUTER(/* the handler */ ·handler(SB), ·addrOfHandler(SB))",
      "INNER (·spaced(SB), ·handler(SB)) // `INNER` is called with a space",
      "FIRST(·first(SB), ·second(SB))",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "INNER")).toEqual(["binding", "callName"]);
    expect(classesOf(lines, "·tooEarly")).toEqual(["identifier"]);
    expect(classesOf(lines, "·second")).toEqual(["identifier"]);
    expect(functions(source)).toEqual([
      "EARLY ·later",
      "OUTER ·addrOfHandler",
      "OUTER ·handler",
      "INNER ·spaced",
      "FIRST ·first",
    ]);
  });

  it("adds nothing for a macro's call of itself, and forgets a macro that is undefined or redefined", () => {
    const source = [
      "#define A(x, y) TEXT x,$0; A(y, x)",
      "A(·a(SB), ·notExpanded(SB))",
      "#define INNER(n) TEXT n,$0",
      "#undef INNER",
      "INNER(·undefined(SB))",
      "#define B(n) TEXT n,$0",
      "#define B 1",
      "B(·redefined(SB))",
      "#define X(n) TEXT n,$0",
      "#undef X",
      "#define X(n) TEXT n,$0",
      "X(·back(SB))",
    ].join("\n");

    expect(functions(source)).toEqual(["A ·a", "X ·back"]);
  });

  it("reads a macro call's arguments across a `\\` and comments, to its `)` or `;`", () => {
    const source = [
      "#define X(n) TEXT n,$0",
      '#define S(a, b) X(b); MOVQ $")", AX',
      "S(x, ·s(SB))",
      "#define E(a, b) TEXT a,$0; TEXT b,$0",
      "E(·a(SB), \\ // the second",
      "  ·b(SB))",
      "E(·unclosed(SB); ·notAnArgument(SB))",
      "#define Q(a, n) TEXT n,$0",
      "#define STRING(p) Q(# p, p)",
      "STRING(·quoted)",
    ].join("\n");
    const expected = ["S ·s", "E ·a", "E ·b", "E ·unclosed", "STRING ·quoted"];

    expect(functions(source)).toEqual(expected);
    expect(functions(source.replaceAll("\n", "\r\n"))).toEqual(expected);
  });

  it("names a function by a parameter passed with Go's `<>`, and by none pasted onto with `##`", () => {
    const source = [
      "TEXT ·f<>(SB),NOSPLIT,$0",
      "#define LOCAL(name) TEXT name<>(SB),NOSPLIT,$0",
      "LOCAL(·local)",
      "#define PASTED(n) TEXT n##_impl(SB),$0",
      "PASTED(·pasted)",
      "#define INNER(n) TEXT n,$0",
      "#define OUTER(p) INNER(p ## _impl)",
      "OUTER(·outer)",
    ].join("\n");

    expect(functions(source)).toEqual(["TEXT ·f<>", "LOCAL ·local"]);
  });

  it("resolves the functions of a deep chain and a widely branching set of macros", () => {
    const chain = Array.from(
      { length: 5000 },
      (_, i) => `#define M${i + 1}(a) M${i}(a)`,
    );
    const branching = Array.from(
      { length: 24 },
      (_, i) => `#define D${i + 1}(a) D${i}(a); D${i}(a)`,
    );
    const source = [
      "#define M0(a) TEXT a,$0",
      ...chain,
      "M5000(·deep(SB))",
      "#define D0(a) TEXT a,$0",
      ...branching,
      "D24(·wide(SB))",
      `#define MANY(${
        Array.from({ length: 4000 }, (_, i) => `p${i}`).join(", ")
      }) ${Array.from({ length: 4000 }, (_, i) => `TEXT p${i},$0`).join("; ")}`,
      ...Array.from({ length: 4000 }, () => "MANY(x)"),
      "#define UNCLOSED(x) \\",
      ..."M0(x \\\n".repeat(4000).split("\n").slice(0, -1),
      "  RET",
      "\\/**/x".repeat(10000),
      "#define Q(n) TEXT n,$0",
      `#define G(a) Q(${"# ".repeat(20000)})`,
    ].join("\n");

    expect(
      outline(source).filter(([kind]) => kind === "function").map(([, label]) =>
        label
      ),
    ).toEqual(["M5000 ·deep", "D24 ·wide", ...Array(4000).fill("MANY x")]);
  });

  it("reads GNU directives without regard to case, and a `.type` in a `#define` as part of its body", () => {
    const source = [
      ".MACRO m reg=foo, n:req",
      "  movq \\reg, %rax",
      ".ENDM",
      "#define ENTRY(name) .globl name; .type name, @function; name:",
      "name:",
      "  ret",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "reg")).toEqual(["parameter"]);
    expect(classesOf(lines, "foo")).toEqual(["identifier"]);
    expect(classesOf(lines, "req")).toEqual(["identifier"]);
    expect(classesOf(lines, "name")).toEqual(["parameter", "functionName"]);
    expect(outline(source)).toEqual([
      ["variable", ".macro m", 0, 0, 2],
      ["variable", "#define ENTRY", 0, 3, 3],
      ["statement", "name:", 0, 4, 5],
    ]);
  });

  it("spans a whole macro call in each function it declares, and a whole `#define`", () => {
    const source = [
      "#define TWO(a, b) TEXT a,$0; TEXT b,$0",
      "#define EMPTY(x)",
      "#define END(name) .size name, .-name",
      "TWO(·a(SB), ·b(SB)); NOP",
      "x;",
    ].join("\n");
    const entries = assemblyLanguage.parseDocument(source).flatStructure.map(
      (node) => source.slice(node.startOffset, node.endOffset),
    );

    expect(entries).toEqual([
      "#define TWO(a, b) TEXT a,$0; TEXT b,$0",
      "#define EMPTY(x)",
      "#define END(name) .size name, .-name",
      "TWO(·a(SB), ·b(SB))",
      "TWO(·a(SB), ·b(SB)); NOP\nx;",
    ]);
  });

  it("colors a `#define` parameter wherever its body uses it, and comments in its parameter list", () => {
    const lines = assemblyLanguage.highlightLines(
      [
        "#define LOAD(op, /* the register */ reg, v, ...) \\",
        "  op 8(SP), reg; VMOV v.B16, V1.B16; reg: CALL __VA_ARGS__",
      ].join("\n"),
    );

    expect(classesOf(lines, "op")).toEqual(["parameter"]);
    expect(classesOf(lines, "reg")).toEqual(["parameter"]);
    expect(classesOf(lines, "v.B16")).toEqual(["parameter"]);
    expect(classesOf(lines, "__VA_ARGS__")).toEqual(["parameter"]);
    expect(classesOf(lines, "/* the register */")).toEqual(["comment"]);
  });

  it("keeps a `.macro` or `.endm` in a `#define` body out of GNU macro nesting", () => {
    const source = [
      "#define BEGIN() .macro inner",
      "#define FINISH() .endm",
      ".macro m",
      "  nop",
      ".endm",
      "  .type f, @function",
      "f:",
      "  ret",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["variable", "#define BEGIN", 0, 0, 0],
      ["variable", "#define FINISH", 0, 1, 1],
      ["variable", ".macro m", 0, 2, 4],
      ["function", "f:", 0, 6, 7],
    ]);
  });

  it("lists nothing for a macro call inside a `#define`, and leaves the open function open", () => {
    const source = [
      "#define ADDR(name) TEXT name,$0",
      "TEXT ·x(SB),$0",
      "#define INNER(n) ADDR(n)",
      "  RET",
      ".macro m",
      "ADDR(·inMacro(SB))",
      ".endm",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["variable", "#define ADDR", 0, 0, 0],
      ["function", "TEXT ·x", 0, 1, 3],
      ["variable", "#define INNER", 1, 2, 2],
      ["variable", ".macro m", 0, 4, 6],
    ]);
  });

  it("spans each entry's whole statement", () => {
    const source = [
      "GLOBL ·table(SB), RODATA, $8",
      "#define F(name) TEXT name,$0; RET;",
      "TEXT ·f(SB),$0",
      "  RET;",
      "F(·g(SB));",
    ].join("\n");
    const entries = assemblyLanguage.parseDocument(source).flatStructure.map(
      (node) => source.slice(node.startOffset, node.endOffset),
    );

    expect(entries).toEqual([
      "GLOBL ·table(SB), RODATA, $8",
      "#define F(name) TEXT name,$0; RET;",
      "TEXT ·f(SB),$0\n  RET;",
      "F(·g(SB));",
    ]);
  });

  it("colors a Go result named like a register as a parameter", () => {
    const lines = assemblyLanguage.highlightLines(
      "  MOVQ AX, r1+32(FP)\n  MOVQ DX, sp+40(FP)",
    );

    expect(classesOf(lines, "r1")).toEqual(["parameter"]);
    expect(classesOf(lines, "sp")).toEqual(["parameter"]);
    expect(classesOf(lines, "DX")).toEqual(["typeKeyword"]);
  });

  it("lists nothing a GNU macro's body declares but the `#define`s the preprocessor reads first", () => {
    const source = [
      ".macro outer a",
      "#define INNER 1",
      ".macro inner",
      ".macro \\a",
      ".endm",
      ".endm",
      "inner_label:",
      ".endm",
      "after:",
      "  ret",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["variable", ".macro outer", 0, 0, 7],
      ["variable", "#define INNER", 0, 1, 1],
      ["statement", "after:", 0, 8, 9],
    ]);
  });

  it("starts a statement on each continued line of a `#define` body, as the Go assembler reads it", () => {
    const source = [
      "#define ADDR_OF_FUNC(name, symbol) \\",
      "  TEXT name,$0-8 \\",
      "  MOVQ $symbol, AX \\",
      "  RET",
      "#define EXC(symbol, addr) \\",
      "  ADDR_OF_FUNC(addr, symbol) \\",
      "tail: \\",
      "  TEXT symbol,NOSPLIT,$0 \\",
      "  RET",
      "#define LIST(a, \\",
      "  b) MOVQ a, b",
      "#define KERNEL_ENTRY_FROM_EL0 \\",
      "  SUB $16, RSP, RSP; \\",
      "  MRS TPIDR_EL1, R18",
      "#define CPU_ERROR_CODE CPU_ARCH_STATE+0",
      "EXC(·f(SB), ·addrOfF(SB))",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "MOVQ")).toEqual(["keyword"]);
    expect(classesOf(lines, "RET")).toEqual(["keyword"]);
    expect(classesOf(lines, "tail")).toEqual(["functionName"]);
    expect(classesOf(lines, "SUB")).toEqual(["keyword"]);
    expect(classesOf(lines, "TPIDR_EL1")).toEqual(["typeKeyword"]);
    // A parameter list continues across a `\\`.
    expect(classesOf(lines, "b")).toEqual(["parameter"]);
    // An object-like macro's body is an operand on its `#define` line.
    expect(classesOf(lines, "CPU_ARCH_STATE")).toEqual(["identifier"]);
    expect(classesOf(lines, "\\")).toEqual(["punctuation"]);
    expect(functions(source)).toEqual(["EXC ·addrOfF", "EXC ·f"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("joins a continued line outside a `#define` to the statement before it", () => {
    const source = [
      "#if defined(A) && \\",
      "    defined(B)",
      "  MOVQ AX, \\ /* the source */",
      "    BX",
      "#define Z(a) \\",
      "  MOVQ $1, CX \\ /* a comment */ // and another",
      "  RET",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "defined")).toEqual(["identifier"]);
    expect(classesOf(lines, "BX")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "RET")).toEqual(["keyword"]);
    expect(outline(source)).toEqual([["variable", "#define Z", 0, 4, 6]]);
  });

  it("ends a macro call in a `#define` body at its line, as the Go assembler does", () => {
    const source = [
      "#define T(n) TEXT n,$0",
      "#define SPLIT(n) \\",
      "  T( \\",
      "  n)",
      "#define WHOLE(n) \\",
      "  T(n) \\",
      "  RET",
      "SPLIT(·split(SB))",
      "WHOLE(·whole(SB))",
    ].join("\n");

    expect(functions(source)).toEqual(["WHOLE ·whole"]);
  });

  it("keeps Go's `<>` on a symbol, and the GNU assembler's `<>` as an operator", () => {
    const source = [
      "DEBUG_CALL_FN(debugCall32<> , 32)",
      "  MOVW R1@>3, R2",
      "GLOBL ·erfrodata<> + 0(SB), RODATA, $456",
      ".if count<>0",
    ].join("\n");
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "debugCall32<>")).toEqual(["identifier"]);
    expect(classesOf(lines, "·erfrodata<>")).toEqual(["binding"]);
    expect(classesOf(lines, "count")).toEqual(["identifier"]);
    expect(classesOf(lines, "<>")).toEqual(["operator"]);
    expect(classesOf(lines, "@>")).toEqual(["operator"]);
  });

  it("colors `# x` in a function-like `#define` body as an operator and an operand", () => {
    const lines = assemblyLanguage.highlightLines("#define S(x) MOVQ # x, AX");

    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "x")).toEqual(["parameter"]);
    expect(classesOf(lines, "AX")).toEqual(["typeKeyword"]);
  });

  it("reconstructs source whose lines end in a carriage return and a line feed", () => {
    const source = GO.replaceAll("\n", "\r\n");
    const document = assemblyLanguage.parseDocument(source);

    expect(verbatim(document.lines)).toBe(source);
    expect(classesOf(document.lines, "MOVQ")).toEqual(["keyword"]);
    expect(document.flatStructure.map((node) => node.label)).toEqual(
      outline(GO).map(([, label]) => label),
    );
  });

  it("leaves characters that start no token uncolored", () => {
    const source = "\tMOVQ `AX, BX \\";
    const lines = assemblyLanguage.highlightLines(source);

    expect(classesOf(lines, "`")).toEqual(["plain"]);
    expect(classesOf(lines, "\\")).toEqual(["plain"]);
    expect(classesOf(lines, "AX")).toEqual(["typeKeyword"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("lists Go functions with their labels, symbols, and macros", () => {
    expect(outline(GO)).toEqual([
      ["variable", "#define FRAME_SIZE", 0, 2, 2],
      ["function", "TEXT ·muldiv64", 0, 5, 13],
      ["statement", "overflow:", 1, 11, 13],
      ["variable", "GLOBL ·table", 0, 16, 16],
      ["function", "TEXT runtime∕internal·spin", 0, 18, 20],
    ]);
  });

  it("lists GNU labels typed as functions or objects, with the labels inside", () => {
    expect(outline(GNU)).toEqual([
      ["function", "rseq_loop:", 0, 7, 14],
      ["statement", "begin:", 1, 11, 14],
      ["variable", "table:", 0, 18, 19],
      ["statement", "orphan:", 0, 20, 21],
    ]);
  });

  it("lists each macro once, and nothing its body declares", () => {
    expect(outline(MACROS)).toEqual([
      ["variable", "#define REGISTERS_SAVE", 0, 0, 2],
      ["variable", "#define CPU_ERROR_CODE", 0, 3, 3],
      ["variable", "#define ADDR_OF_FUNC", 0, 4, 7],
      ["variable", "#define SPACED", 0, 8, 8],
      ["function", "TEXT ·entry", 0, 12, 14],
    ]);
  });

  it("indexes declared names for definition peeks", () => {
    const definitions = assemblyLanguage.parseDocument(GO).definitions;

    expect(definitions.get("·muldiv64")?.map((d) => d.startLine)).toEqual([5]);
    expect(definitions.get("overflow")?.map((d) => d.startLine)).toEqual([11]);
    expect(definitions.has("·table")).toBe(true);
    expect(definitions.has("NOSPLIT")).toBe(false);
  });

  it("recolors the lines after an edit that opens a block comment", () => {
    const highlighter = assemblyLanguage.createHighlighter(GO);
    const edited = GO.replace("\tCMPQ CX, DX", "\t/* CMPQ CX, DX");
    const lines = highlighter.update(edited);

    expect(verbatim(lines)).toBe(edited);
    expect(lines.at(-1)?.spans.map((span) => span.cls)).toEqual(["comment"]);
    expect(classesOf(highlighter.update(GO), "RET")).toEqual(["keyword"]);
  });
});
