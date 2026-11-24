import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import {
  type Language,
  languageForFile,
  prepareLanguages,
} from "../../../../../lib/view/languages/language.ts";
import {
  cFamilyHeaderLanguage,
  cLanguage,
  cppLanguage,
  cudaLanguage,
} from "../../../../../lib/view/languages/c-family/language.ts";
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

/** Each structure entry's kind, label, depth, and first line. */
function outline(language: Language, source: string) {
  return language.parseDocument(source).flatStructure.map((node) => [
    node.kind,
    node.label,
    node.depth,
    node.startLine,
  ]);
}

describe("cFamilyLanguage", () => {
  beforeAll(() =>
    prepareLanguages([
      cLanguage,
      cppLanguage,
      cudaLanguage,
      cFamilyHeaderLanguage,
    ])
  );

  describe("selection", () => {
    // The shared fixture corpus carries the representative filenames and
    // aliases; these cases are the ones it does not.

    it("selects each language in any case", () => {
      expect(languageForFile("Server.CPP").id).toBe("cpp");
      // Compilers read an uppercase `.C` as C++ and a lowercase one as C.
      expect(languageForFile("main.C").id).toBe("cpp");
      expect(languageForFile("main.c").id).toBe("c");
      expect(languageForFile("Util.HPP").id).toBe("cpp");
      expect(languageForFile("Kernel.CU").id).toBe("cuda");
      expect(languageForFile("UTIL.H").id).toBe("c-family-header");
    });

    it("leaves names that only start like a C-family extension alone", () => {
      const cFamily = [
        cLanguage,
        cppLanguage,
        cudaLanguage,
        cFamilyHeaderLanguage,
      ];
      for (const path of ["a.cs", "a.m", "a.mm", "a.hs", "a.cfg", "a.cjs"]) {
        expect(cFamily).not.toContain(languageForFile(path));
      }
    });
  });

  describe("C highlighting", () => {
    it("colors declarations, statements, and the preprocessor", () => {
      const lines = cLanguage.highlightLines([
        "/** Doc comment. */",
        "#include <stdio.h>",
        '#include "sysmsg.h"',
        "#define MAX_LEN 64",
        "#define SQUARE(x) ((x) * (x))",
        "typedef unsigned long size_type;",
        "struct point { int x; double y; };",
        'static const char *names[] = {"a", 0};',
        "int main(int argc, char **argv) {",
        "  struct point p = {.x = 1, .y = 2.5e3};",
        "  if (argc > 1 && argv[1][0] == 'h') goto done;",
        "  for (int i = 0; i < MAX_LEN; i++) p.x += sizeof(p);",
        '  printf("%d\\n", p.x ? SQUARE(p.x) : -1);',
        "done:",
        "  return true;  // trailing",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "/** Doc comment. */")).toEqual(["docComment"]);
      expect(classesOf(lines, "// trailing")).toEqual(["comment"]);
      expect(classesOf(lines, "#include")).toEqual(["keyword"]);
      expect(classesOf(lines, "<stdio.h>")).toEqual(["string"]);
      expect(classesOf(lines, '"sysmsg.h"')).toEqual(["string"]);
      expect(classesOf(lines, "MAX_LEN")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "SQUARE")).toEqual(["functionName", "callName"]);
      expect(classesOf(lines, "unsigned")).toEqual(["typeKeyword"]);
      expect(classesOf(lines, "long")).toEqual(["typeKeyword"]);
      expect(classesOf(lines, "size_type")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "point")).toEqual(["interfaceName", "typeName"]);
      expect(classesOf(lines, "typedef")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "struct")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "static")).toEqual(["keyword"]);
      expect(classesOf(lines, "const")).toEqual(["keyword"]);
      expect(classesOf(lines, "names")).toEqual(["binding"]);
      expect(classesOf(lines, "main")).toEqual(["functionName"]);
      for (const parameter of ["argc", "argv"]) {
        expect(classesOf(lines, parameter)).toEqual([
          "parameter",
          "identifier",
        ]);
      }
      expect(classesOf(lines, "p")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "x")).toContain("propertyName");
      expect(classesOf(lines, "done")).toEqual(["propertyName"]);
      for (const keyword of ["if", "goto", "for", "return"]) {
        expect(classesOf(lines, keyword)).toEqual(["controlKeyword"]);
      }
      expect(classesOf(lines, "sizeof")).toEqual(["keyword"]);
      expect(classesOf(lines, "printf")).toEqual(["callName"]);
      expect(classesOf(lines, '"%d\\n"')).toEqual(["string"]);
      expect(classesOf(lines, "'h'")).toEqual(["string"]);
      expect(classesOf(lines, "2.5e3")).toEqual(["number"]);
      expect(classesOf(lines, "true")).toEqual(["boolean"]);
      for (const operator of ["&&", "==", "<", "++", "+=", "?"]) {
        expect(classesOf(lines, operator)).toEqual(["operator"]);
      }
      // A colon is an operator in a conditional expression and punctuation
      // after a label.
      expect(classesOf(lines, ":")).toEqual(["operator", "punctuation"]);
      expect(classesOf(lines, "{")).toEqual(["bracket"]);
      expect(classesOf(lines, ";")).toEqual(["punctuation"]);
    });

    it("colors function-pointer parameters and every doc comment form", () => {
      const lines = cLanguage.highlightLines([
        "/// Summary.",
        "///",
        "//! Module note.",
        "/*! Block note. */",
        "// Plain note.",
        "void (*signal(int sig, void (*func)(int)))(int);",
        "void sort(void *base, int (*compare)(const void *, const void *));",
      ].join("\n"));

      for (const doc of ["/// Summary.", "///", "//! Module note."]) {
        expect(classesOf(lines, doc)).toEqual(["docComment"]);
      }
      expect(classesOf(lines, "/*! Block note. */")).toEqual(["docComment"]);
      expect(classesOf(lines, "// Plain note.")).toEqual(["comment"]);
      for (const parameter of ["sig", "func", "base", "compare"]) {
        expect(classesOf(lines, parameter)).toEqual(["parameter"]);
      }
      expect(classesOf(lines, "signal")).toEqual(["functionName"]);
    });

    it("reads C++'s keywords as the names C allows them to be", () => {
      const source = [
        "struct node *next(struct node *this) {",
        "  int template = 1;",
        "  return this->next;",
        "}",
      ].join("\n");

      const c = cLanguage.highlightLines(source);
      expect(classesOf(c, "template")).toEqual(["binding"]);
      expect(classesOf(c, "this")).toEqual(["parameter", "identifier"]);
      const header = cFamilyHeaderLanguage.highlightLines(source);
      expect(classesOf(header, "template")).toEqual(["storageKeyword"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'char *s = "open',
          "int f(int a, {",
          "/* open comment",
          "#if defined(X",
          "#define LONG(a) \\\n  (a)",
          "a = 1;\r\nb = 2;\r\n",
          "\ud800",
          "",
          " \t",
          'const char *k = "café ☕ 😀";',
        ]
      ) {
        for (const language of [cLanguage, cppLanguage]) {
          expect(verbatim(language.parseDocument(source).lines)).toBe(source);
        }
      }
    });
  });

  describe("C++ highlighting", () => {
    it("colors classes, namespaces, templates, and C++'s expressions", () => {
      const lines = cppLanguage.highlightLines([
        "namespace gvisor::testing {",
        "template <typename T>",
        "class PosixErrorOr final : public Base {",
        " public:",
        "  explicit PosixErrorOr(T value) noexcept;",
        "  ~PosixErrorOr() override = default;",
        "  bool operator==(const PosixErrorOr& other) const;",
        "};",
        "using Labels = std::vector<std::string>;",
        "int PosixErrorOr<T>::Size(int& count) {",
        "  auto [k, v] = Pair();",
        "  for (auto& item : items_) count += static_cast<int>(item.size());",
        '  auto json = R"({"a": 1})";',
        '  if (this == nullptr) throw std::runtime_error("x");',
        "  return Make<int>(count < 3 ? count : 3);",
        "}",
        "}  // namespace gvisor::testing",
      ].join("\n"));

      expect(classesOf(lines, "gvisor")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "std")).toEqual(["typeName"]);
      expect(classesOf(lines, "PosixErrorOr")).toContain("interfaceName");
      expect(classesOf(lines, "PosixErrorOr")).toContain("functionName");
      // A destructor's name and an operator's symbol keep their own classes.
      expect(classesOf(lines, "~")).toEqual(["operator"]);
      expect(classesOf(lines, "operator")).toEqual(["keyword"]);
      expect(classesOf(lines, "Size")).toEqual(["functionName"]);
      expect(classesOf(lines, "Labels")).toEqual(["interfaceName"]);
      for (const keyword of ["namespace", "template", "typename", "class"]) {
        expect(classesOf(lines, keyword)).toEqual(["storageKeyword"]);
      }
      expect(classesOf(lines, "using")).toEqual(["storageKeyword"]);
      for (const keyword of ["public", "final", "override", "explicit"]) {
        expect(classesOf(lines, keyword)).toEqual(["keyword"]);
      }
      expect(classesOf(lines, "noexcept")).toEqual(["keyword"]);
      expect(classesOf(lines, "static_cast")).toEqual(["keyword"]);
      expect(classesOf(lines, "this")).toEqual(["keyword"]);
      expect(classesOf(lines, "nullptr")).toEqual(["keyword"]);
      expect(classesOf(lines, "auto")).toEqual(["typeKeyword"]);
      expect(classesOf(lines, "throw")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "Make")).toEqual(["callName"]);
      expect(classesOf(lines, "size")).toEqual(["callName"]);
      expect(classesOf(lines, "count")).toEqual(["parameter", "identifier"]);
      for (const binding of ["k", "v", "item"]) {
        expect(classesOf(lines, binding)).toContain("binding");
      }
      expect(classesOf(lines, 'R"({"a": 1})"')).toEqual(["string"]);
      expect(classesOf(lines, "::")).toEqual(["punctuation"]);
      // A template's angle brackets are punctuation, and a comparison's are
      // operators.
      expect(classesOf(lines, "<")).toEqual(["punctuation", "operator"]);
      expect(classesOf(lines, "==")).toEqual(["operator"]);
    });

    it("colors references, variadic parameters, linkage, defaulted members, specializations, and names qualified twice", () => {
      const lines = cppLanguage.highlightLines([
        'extern "C" int open_fd(void);',
        "namespace net::inline v2 {}",
        "[[nodiscard]] int Size();",
        "template <typename... Args> void Log(Args&&... args);",
        "template <> void Hash<int>(int value) {}",
        "void Take(int*& out);",
        "struct Clock { Clock() = default; Clock(const Clock&) = delete; };",
        "void Outer::Inner::Run() {",
        "  const std::string& ref = Name();",
        "  auto&& fwd = Get();",
        "  std::this_thread::sleep_for(Delay());",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "extern")).toEqual(["keyword"]);
      expect(classesOf(lines, "inline")).toEqual(["keyword"]);
      expect(classesOf(lines, "nodiscard")).toEqual(["keyword"]);
      expect(classesOf(lines, "v2")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "args")).toEqual(["parameter"]);
      expect(classesOf(lines, "out")).toEqual(["parameter"]);
      expect(classesOf(lines, "Hash")).toEqual(["functionName"]);
      expect(classesOf(lines, "default")).toEqual(["keyword"]);
      expect(classesOf(lines, "delete")).toEqual(["keyword"]);
      expect(classesOf(lines, "Run")).toEqual(["functionName"]);
      expect(classesOf(lines, "ref")).toEqual(["binding"]);
      expect(classesOf(lines, "fwd")).toEqual(["binding"]);
      expect(classesOf(lines, "sleep_for")).toEqual(["callName"]);
      expect(classesOf(lines, "this_thread")).toEqual(["typeName"]);
    });

    it("colors CUDA's qualifiers as keywords and reads the declaration after them", () => {
      const lines = cudaLanguage.highlightLines([
        "__global__ void addKernel(int* data) {",
        "  __shared__ int cache[32];",
        "  data[threadIdx.x] += cache[0];",
        "}",
        "__device__ __forceinline__ int twice(int x) { return 2 * x; }",
        "struct V { __host__ __device__ float len() const; };",
        "void Run(int* data) {",
        "  addKernel<<<kNumBlocks, kNumThreads>>>(data);",
        "}",
      ].join("\n"));

      for (const qualifier of ["__global__", "__shared__", "__device__"]) {
        expect(classesOf(lines, qualifier)).toEqual(["keyword"]);
      }
      expect(classesOf(lines, "__forceinline__")).toEqual(["keyword"]);
      expect(classesOf(lines, "__host__")).toEqual(["keyword"]);
      expect(classesOf(lines, "void")).toEqual(["typeKeyword"]);
      // The grammar reads a kernel launch's `<<<` and `>>>` as shifts around a
      // template's arguments, so the launched kernel is a plain name there.
      expect(classesOf(lines, "addKernel")).toEqual([
        "functionName",
        "identifier",
      ]);
      expect(classesOf(lines, "twice")).toEqual(["functionName"]);
      expect(classesOf(lines, "len")).toEqual(["functionName"]);
      // A member's qualifiers declare nothing of their own.
      expect(
        outline(cudaLanguage, "struct V { __host__ __device__ float len(); };"),
      ).toEqual([["class", "struct V", 0, 0], ["method", "len()", 1, 0]]);
    });
  });

  describe("structure", () => {
    it("lists C's functions, declarations, types, and macros", () => {
      expect(outline(
        cLanguage,
        [
          "#define MAX_LEN 64",
          "#define SQUARE(x) ((x) * (x))",
          "typedef struct node {",
          "  struct node *next;",
          "  int (*visit)(struct node *);",
          "} node_t, *node_p;",
          "enum color { RED, GREEN };",
          "extern int verbose, quiet;",
          "int (*handler)(int);",
          "char *copy_name(const char *name);",
          "static int count;",
          "int main(void) {",
          "  int local = 0;",
          "  return local;",
          "}",
          "struct S { int a; } s1, s2;",
        ].join("\n"),
      )).toEqual([
        ["variable", "#define MAX_LEN", 0, 0],
        ["function", "#define SQUARE()", 0, 1],
        // A typedef's type and the names it declares are siblings.
        ["class", "struct node", 0, 2],
        ["variable", "next", 1, 3],
        ["variable", "visit", 1, 4],
        ["typeAlias", "typedef node_t", 0, 5],
        ["typeAlias", "typedef node_p", 0, 5],
        ["class", "enum color", 0, 6],
        // Each name a declaration declares is an entry.
        ["variable", "verbose", 0, 7],
        ["variable", "quiet", 0, 7],
        ["variable", "handler", 0, 8],
        ["function", "copy_name()", 0, 9],
        ["variable", "count", 0, 10],
        ["function", "main()", 0, 11],
        ["class", "struct S", 0, 15],
        ["variable", "a", 1, 15],
        ["variable", "s1", 0, 15],
        ["variable", "s2", 0, 15],
      ]);
    });

    it("lists C++'s namespaces, classes, members, and definitions", () => {
      const source = [
        "namespace gvisor {",
        "namespace {",
        "class FileDescriptor {",
        " public:",
        "  int get() const { return fd_; }",
        "  void reset();",
        " private:",
        "  int fd_;",
        "};",
        "}  // namespace",
        'extern "C" {',
        "int renameat2(int, const char*, int, const char*, unsigned);",
        "}",
        "#ifndef __Fuchsia__",
        "using Fd = FileDescriptor;",
        "#endif",
        "template <typename T>",
        "T Twice(T value) { return value + value; }",
        "void FileDescriptor::reset() { fd_ = -1; }",
        "}  // namespace gvisor",
      ].join("\n");
      const document = cppLanguage.parseDocument(source);

      expect(outline(cppLanguage, source)).toEqual([
        ["object", "namespace gvisor", 0, 0],
        ["object", "namespace", 1, 1],
        ["class", "class FileDescriptor", 2, 2],
        ["method", "get()", 3, 4],
        ["method", "reset()", 3, 5],
        ["variable", "fd_", 3, 7],
        ["function", "renameat2()", 1, 11],
        ["typeAlias", "using Fd", 1, 14],
        // A template's entry starts at its template header.
        ["function", "Twice()", 1, 16],
        ["method", "FileDescriptor::reset()", 1, 18],
      ]);
      // A qualified definition is indexed under its own name.
      expect(document.definitions.get("reset")?.length).toBe(2);
      expect(document.flatStructure.at(-1)!.nameOffset).toBe(
        source.indexOf("reset() {"),
      );
    });

    it("spans each of several declarators alone, even with a comment between them", () => {
      const source = [
        "int one, /* note */ two;",
        "int /* note */ only;",
      ].join("\n");

      expect(
        cppLanguage.parseDocument(source).flatStructure.map((node) => [
          node.label,
          node.startLine,
          node.startCol,
          node.endCol,
        ]),
      ).toEqual([
        ["one", 0, 4, 7],
        ["two", 0, 20, 23],
        // The only declarator of its declaration spans the declaration.
        ["only", 1, 0, 20],
      ]);
    });

    it("labels a conversion operator without the comments in its type or its parameters", () => {
      const source = [
        "class Handle {",
        "  operator int(/* none */) const;",
        "  operator /* raw */ bool() const;",
        "};",
      ].join("\n");

      expect(outline(cppLanguage, source)).toEqual([
        ["class", "class Handle", 0, 0],
        ["method", "operator int()", 1, 1],
        ["method", "operator bool()", 1, 2],
      ]);
    });

    it("lists a header's declarations in either dialect", () => {
      expect(outline(
        cFamilyHeaderLanguage,
        [
          "#ifndef UTIL_H_",
          "#define UTIL_H_",
          "struct stat;",
          "int stat_size(void);",
          "class Cleanup {",
          " public:",
          "  Cleanup();",
          "};",
          "#endif  // UTIL_H_",
        ].join("\n"),
      )).toEqual([
        ["variable", "#define UTIL_H_", 0, 1],
        ["function", "stat_size()", 0, 3],
        ["class", "class Cleanup", 0, 4],
        ["method", "Cleanup()", 1, 6],
      ]);
    });

    it("lists conversion operators, macro-defined tests, conditional members, and anonymous members", () => {
      const source = [
        "namespace a::b::c {",
        "enum class Color { kRed };",
        "struct Flags {",
        "  union { int bits; };",
        "  unsigned : 4;",
        "#ifdef DEBUG",
        "  Flags();",
        "#endif",
        "  explicit operator bool() const;",
        "  operator const char*() const;",
        "  operator std::function<void(int)>() const;",
        "  operator int*",
        "  friend bool operator==(Flags a, Flags b) { return true; }",
        "};",
        "Flags::operator bool() const { return true; }",
        "int (max)(int a, int b);",
        "TEST_F(FlagsTest, StartsEmpty) {}",
        "TEST_F(FlagsTest,",
        "       Sets) {}",
        "int (__cdecl entry)(int);",
        "}  // namespace a::b::c",
      ].join("\n");
      const document = cppLanguage.parseDocument(source);

      expect(outline(cppLanguage, source)).toEqual([
        ["object", "namespace a::b::c", 0, 0],
        ["class", "enum class Color", 1, 1],
        ["class", "struct Flags", 1, 2],
        ["variable", "bits", 2, 3],
        ["method", "Flags()", 2, 6],
        ["method", "operator bool()", 2, 8],
        ["method", "operator const char*()", 2, 9],
        ["method", "operator std::function<void(int)>()", 2, 10],
        // A conversion operator typed up to its type has no parameters yet.
        ["method", "operator int*()", 2, 11],
        ["function", "operator==()", 2, 12],
        ["method", "Flags::operator bool()", 1, 14],
        ["function", "max()", 1, 15],
        ["function", "TEST_F(FlagsTest, StartsEmpty)", 1, 16],
        ["function", "TEST_F(FlagsTest, Sets)", 1, 17],
        ["function", "entry()", 1, 19],
      ]);
      expect(document.definitions.get("c")?.length).toBe(1);
      expect(document.definitions.get("operator bool")?.length).toBe(2);
    });

    it("labels entries on one line without comments, from their outermost template header", () => {
      expect(outline(
        cppLanguage,
        [
          "template <class T>",
          "template <class U>",
          "void Foo<T,",
          "         U>::bar(U) {}",
          "int (/* note */ count)(int);",
          "struct S {",
          "  operator // half typed",
          "  int f();",
          "};",
        ].join("\n"),
      )).toEqual([
        ["method", "Foo<T, U>::bar()", 0, 0],
        ["function", "count()", 0, 4],
        ["class", "struct S", 0, 5],
        ["method", "operator int f()", 1, 6],
      ]);
    });

    it("lists a field's name but not the value it defaults to, and a nameless type's members under it", () => {
      const source = [
        "class S {",
        "  int size_ = kDefaultSize;",
        "  Mode mode_ = Mode::kFast;",
        "  struct { int a; } inner;",
        "};",
        "typedef struct { int x; int y; } point_t;",
      ].join("\n");

      expect(outline(cppLanguage, source)).toEqual([
        ["class", "class S", 0, 0],
        ["variable", "size_", 1, 1],
        ["variable", "mode_", 1, 2],
        ["class", "struct", 1, 3],
        ["variable", "a", 2, 3],
        ["variable", "inner", 1, 3],
        ["class", "struct", 0, 5],
        ["variable", "x", 1, 5],
        ["variable", "y", 1, 5],
        ["typeAlias", "typedef point_t", 0, 5],
      ]);
      expect(cppLanguage.parseDocument(source).definitions.has("kDefaultSize"))
        .toBe(false);
    });

    it("lists no entry for a name error recovery leaves empty", () => {
      for (
        const source of [
          "namespace a:: {",
          "enum : int { A };",
          "struct S { void (S::*pm)(); };",
          "auto [x, y] = Pair();",
        ]
      ) {
        const document = cppLanguage.parseDocument(source);
        for (const node of document.flatStructure) {
          expect(node.name ?? "named").not.toBe("");
          expect(node.name ?? "").not.toMatch(/[:\[]/);
        }
        expect(document.definitions.has("")).toBe(false);
      }
    });

    it("lists the declarations error recovery keeps inside an error", () => {
      expect(outline(cLanguage, "int ok(void);\n}}\nint after(void);\n"))
        .toEqual([
          ["function", "ok()", 0, 0],
          ["function", "after()", 0, 2],
        ]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "// café ☕ and an astral 😀",
        "#include <stdint.h>",
        "struct sysmsg { int state; };",
        "int handle(struct sysmsg *msg) {",
        "  if (msg->state == 0) return -1;",
        "  return 0;",
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ["return -1;", "goto fail;"],
        ["int handle", "static int handle"],
        ["  return 0;\n}", "  return 0;\nfail:\n  return 1;\n}"],
        ["struct sysmsg {", "struct sysmsg"],
        ["// café", "café"],
      ];
      for (const language of [cLanguage, cppLanguage]) {
        const highlighter = language.createHighlighter(source);
        let current = source;
        for (const [from, to] of edits) {
          expect(current).toContain(from);
          current = current.replace(from, to);
          const updated = highlighter.update(current);
          expect(verbatim(updated)).toBe(current);
          expect(updated.map((line) => line.spans)).toEqual(
            language.highlightLines(current).map((line) => line.spans),
          );
        }
      }
    });

    it("colors a diff of an unavailable file", () => {
      const diff = [
        "diff --git a/kernel.cu b/kernel.cu",
        "--- a/kernel.cu",
        "+++ b/kernel.cu",
        "@@ -1,3 +1,4 @@",
        " void Run(int* data) {",
        "   addKernel<<<kNumBlocks, kNumThreads>>>(data);",
        "+  CHECK_CUDA(cudaGetLastError());",
        " }",
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, "CHECK_CUDA")).toEqual(["callName"]);
      expect(classesOf(doc.lines, "Run")).toEqual(["functionName"]);
      expect(classesOf(doc.lines, "data")).toContain("parameter");
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
