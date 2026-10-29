import { assertEquals } from "@std/assert";
import { parseDocument } from "./view-helpers.ts";
import type { Line } from "../lib/view/model.ts";
import {
  _internal as wrapInternal,
  buildWrapPlan,
  fitWrapChrome,
  wrappedRowAt,
  wrappedRowForPosition,
} from "../lib/view/wrap.ts";

Deno.test("wrap layout: retains room for source text and a marker", () => {
  assertEquals(fitWrapChrome(8, 4, 1), {
    gutterWidth: 4,
    guideWidth: 1,
  });
  assertEquals(fitWrapChrome(6, 4, 1), {
    gutterWidth: 0,
    guideWidth: 1,
  });
  assertEquals(fitWrapChrome(5, 4, 0), {
    gutterWidth: 0,
    guideWidth: 0,
  });
  assertEquals(fitWrapChrome(2, 0, 1), {
    gutterWidth: 0,
    guideWidth: 0,
  });
});

Deno.test("wrap plan: splits long lines and keeps empty lines", () => {
  const doc = parseDocument("abcdefgh\n\nij");
  const plan = buildWrapPlan(doc.lines, "pictures", 4);

  assertEquals(
    Array.from({ length: plan.rowCount }, (_, row) => wrappedRowAt(plan, row)),
    [
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 6,
        sourceWidth: 3,
        sourceEnd: 3,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 0,
      },
      {
        row: 1,
        line: 0,
        offset: 3,
        lastOffset: 6,
        sourceWidth: 3,
        sourceEnd: 6,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 0,
      },
      {
        row: 2,
        line: 0,
        offset: 6,
        lastOffset: 6,
        sourceWidth: 4,
        sourceEnd: 8,
        prefixWidth: 0,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
      {
        row: 3,
        line: 1,
        offset: 0,
        lastOffset: 0,
        sourceWidth: 4,
        sourceEnd: 0,
        prefixWidth: 0,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
      {
        row: 4,
        line: 2,
        offset: 0,
        lastOffset: 0,
        sourceWidth: 4,
        sourceEnd: 2,
        prefixWidth: 0,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
    ],
  );
  assertEquals(plan.rowWidth, 4);
  assertEquals(plan.rowStride, 3);
  assertEquals(plan.firstRow, [0, 3, 4]);
  assertEquals(plan.lastRow, [2, 3, 4]);
});

Deno.test("word wrap plan: breaks at words and repeats the line prefix", () => {
  const doc = parseDocument("  #  foo bar");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    11,
    new Map(),
    "word",
  );

  assertEquals(
    Array.from({ length: plan.rowCount }, (_, row) => wrappedRowAt(plan, row)),
    [
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 9,
        sourceWidth: 10,
        sourceEnd: 9,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 0,
      },
      {
        row: 1,
        line: 0,
        offset: 9,
        lastOffset: 9,
        sourceWidth: 6,
        sourceEnd: 12,
        prefixWidth: 5,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
    ],
  );
  assertEquals(wrappedRowForPosition(plan, 0, 8)?.row, 0);
  assertEquals(wrappedRowForPosition(plan, 0, 9)?.row, 1);
});

Deno.test("word wrap plan: tabs and ASCII symbols belong to the prefix", () => {
  const doc = parseDocument("\t+  alpha beta");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    10,
    new Map(),
    "word",
  );

  assertEquals(wrappedRowAt(plan, 1)?.prefixWidth, 4);
  assertEquals(wrappedRowAt(plan, 1)?.offset, 9);
});

Deno.test("word wrap plan: punctuation can touch the first word", () => {
  const doc = parseDocument("#abcdefgh");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    4,
    new Map(),
    "word",
  );

  assertEquals(
    Array.from(plan.wordRows?.[0]?.offsets ?? []),
    [0, 3, 5],
  );
  assertEquals(wrappedRowAt(plan, 1)?.prefixWidth, 1);
});

Deno.test("word wrap plan: punctuation-only text breaks at whitespace", () => {
  const punctuation = buildWrapPlan(
    parseDocument("### ###").lines,
    "pictures",
    6,
    new Map(),
    "word",
  );
  assertEquals(
    Array.from(punctuation.wordRows?.[0]?.offsets ?? []),
    [0, 4],
  );

  const leadingSpace = buildWrapPlan(
    parseDocument(" ###").lines,
    "pictures",
    3,
    new Map(),
    "word",
  );
  assertEquals(
    Array.from(leadingSpace.wordRows?.[0]?.offsets ?? []),
    [0, 1],
  );
});

Deno.test("word wrap plan: every separator cell belongs to a row", () => {
  const doc = parseDocument("foo     bar");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    4,
    new Map(),
    "word",
  );

  assertEquals(
    Array.from(plan.wordRows?.[0]?.offsets ?? []),
    [0, 3, 6, 8],
  );
  assertEquals(
    Array.from({ length: plan.rowCount }, (_, row) => {
      const wrapped = wrappedRowAt(plan, row)!;
      return [wrapped.offset, wrapped.sourceEnd];
    }),
    [[0, 3], [3, 6], [6, 8], [8, 11]],
  );
  assertEquals(
    Array.from(
      { length: 11 },
      (_, col) => wrappedRowForPosition(plan, 0, col)?.row,
    ),
    [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 3],
  );
});

Deno.test("word wrap plan: a diff annotation only narrows its own row", () => {
  const doc = parseDocument("--- alpha beta gamma");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    8,
    new Map([[0, { firstWidth: 3, continuationWidth: 1 }]]),
    "word",
  );

  assertEquals(wrappedRowAt(plan, 0)?.prefixWidth, 0);
  assertEquals(wrappedRowAt(plan, 1)?.prefixWidth, 4);
  assertEquals(wrappedRowAt(plan, 1)?.suffixWidth, 1);
});

Deno.test("word wrap plan: a final row drops a prefix that hides source", () => {
  const doc = parseDocument("--- ab");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    6,
    new Map([[0, { firstWidth: 1, continuationWidth: 1 }]]),
    "word",
  );

  assertEquals(plan.rowCount, 2);
  assertEquals(wrappedRowAt(plan, 1)?.prefixWidth, 0);
  assertEquals(wrappedRowAt(plan, 1)?.sourceEnd, 6);
});

Deno.test("word wrap plan: non-breaking spaces stay inside words", () => {
  for (const separator of ["\u00a0", "\u2007", "\u202f", "\ufeff"]) {
    const doc = parseDocument(`foo${separator}bar`);
    const plan = buildWrapPlan(
      doc.lines,
      "pictures",
      4,
      new Map(),
      "word",
    );

    assertEquals(plan.wordRows?.[0], null);
    assertEquals(wrappedRowAt(plan, 0)?.sourceEnd, 3);
    assertEquals(wrappedRowAt(plan, 1)?.offset, 3);
  }
});

Deno.test("word wrap plan: Unicode whitespace provides a word boundary", () => {
  const doc = parseDocument("a\u0085bcdef");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    5,
    new Map(),
    "word",
  );

  assertEquals(
    Array.from(plan.wordRows?.[0]?.offsets ?? []),
    [0, 2],
  );
});

Deno.test("word wrap plan: hidden control runs retain every boundary", () => {
  for (const controls of ["\t\0", "\0\t"]) {
    const doc = parseDocument(`a${controls}bcdef`);
    const plan = buildWrapPlan(
      doc.lines,
      "hidden",
      5,
      new Map(),
      "word",
    );

    assertEquals(
      Array.from(plan.wordRows?.[0]?.offsets ?? []),
      [0, 2],
    );
  }
});

Deno.test("word wrap plan: ANSI prefixes use their visible cells", () => {
  const doc = parseDocument("\x1b[31m# alpha beta");
  const plan = buildWrapPlan(
    doc.lines,
    "ansi",
    8,
    new Map(),
    "word",
  );

  assertEquals(wrappedRowAt(plan, 1)?.prefixWidth, 2);
});

Deno.test("word wrap plan: large lines without a usable break stay fixed", () => {
  for (
    const text of [
      "a".repeat(100_000),
      `${"a".repeat(100_000)} `,
      " ".repeat(100_000),
      ` ${"a".repeat(100_000)}`,
    ]
  ) {
    const doc = parseDocument(text);
    const plan = buildWrapPlan(
      doc.lines,
      "pictures",
      1,
      new Map(),
      "word",
    );

    assertEquals(plan.wordRows?.[0], null);
    assertEquals(plan.rowCount, text.length);
    assertEquals(wrappedRowAt(plan, text.length - 1)?.offset, text.length - 1);
  }
});

Deno.test("word wrap plan: hidden ANSI prefixes keep fixed-width rows", () => {
  const doc = parseDocument(`\x1b[31m${"a".repeat(100_000)}`);
  const plan = buildWrapPlan(
    doc.lines,
    "ansi",
    1,
    new Map(),
    "word",
  );

  assertEquals(plan.wordRows?.[0], null);
  assertEquals(plan.rowCount, 100_000);
});

Deno.test("word wrap plan: long internal whitespace makes linear progress", () => {
  const text = `a${" ".repeat(100_000)}b`;
  const doc = parseDocument(text);
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    2,
    new Map(),
    "word",
  );

  assertEquals(plan.rowCount, text.length - 1);
  assertEquals(plan.wordRows?.[0], null);
  assertEquals(wrappedRowAt(plan, plan.rowCount - 1)?.sourceEnd, text.length);
});

Deno.test("word wrap plan: fixed rows do not materialize display cells", () => {
  const text = `a${" ".repeat(1_000_000)}b`;
  const line: Line = {
    text,
    get spans(): Line["spans"] {
      throw new Error("fixed wrapping must not expand display cells");
    },
  };
  const plan = buildWrapPlan(
    [line],
    "pictures",
    2,
    new Map(),
    "word",
  );

  assertEquals(plan.rowCount, text.length - 1);
  assertEquals(plan.wordRows?.[0], null);
});

Deno.test("word wrap plan: narrow rows fall back to forward hard wrapping", () => {
  const doc = parseDocument("  #  abcdefgh");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    6,
    new Map(),
    "word",
  );

  assertEquals(plan.rowCount, 3);
  assertEquals(wrappedRowAt(plan, 1)?.prefixWidth, 0);
  assertEquals(wrappedRowAt(plan, 1)?.offset, 5);
  assertEquals(wrappedRowAt(plan, 2)?.offset, 10);
  assertEquals(wrappedRowAt(plan, 2)?.sourceEnd, 13);
});

Deno.test("word wrap internals: fixed offsets use the compact layout", () => {
  const line = parseDocument("abcdefgh").lines[0];

  assertEquals(
    wrapInternal.buildWordWrapLine(line, "pictures", 4, 0, 0, 0),
    null,
  );
  assertEquals(
    wrapInternal.hasFixedWrapOffsets([0], 8, 4, 0, 0, 0),
    false,
  );
});

Deno.test("wrap plan: exact-width lines do not add an empty row", () => {
  const doc = parseDocument("abcd");
  const plan = buildWrapPlan(doc.lines, "pictures", 4);
  assertEquals(plan.rowCount, 1);
  assertEquals(wrappedRowAt(plan, 0), {
    row: 0,
    line: 0,
    offset: 0,
    lastOffset: 0,
    sourceWidth: 4,
    sourceEnd: 4,
    prefixWidth: 0,
    continues: false,
    wrapMarker: false,
    suffixWidth: 0,
  });
});

Deno.test("wrap plan: a non-positive width behaves as one column", () => {
  const doc = parseDocument("ab");
  const plan = buildWrapPlan(doc.lines, "pictures", 0);
  assertEquals(plan.rowCount, 2);
  assertEquals(plan.rowWidth, 1);
  assertEquals(plan.rowStride, 1);
  assertEquals(wrappedRowAt(plan, 0), {
    row: 0,
    line: 0,
    offset: 0,
    lastOffset: 1,
    sourceWidth: 1,
    sourceEnd: 1,
    prefixWidth: 0,
    continues: true,
    wrapMarker: false,
    suffixWidth: 0,
  });
  assertEquals(wrappedRowAt(plan, 1), {
    row: 1,
    line: 0,
    offset: 1,
    lastOffset: 1,
    sourceWidth: 1,
    sourceEnd: 2,
    prefixWidth: 0,
    continues: false,
    wrapMarker: false,
    suffixWidth: 0,
  });
});

Deno.test("wrap plan: a triangle reserves only its annotated line", () => {
  const doc = parseDocument("abcdefghij\n1234567");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    7,
    new Map([[0, { firstWidth: 1, continuationWidth: 1 }]]),
  );

  assertEquals(plan.firstRow, [0, 2]);
  assertEquals(plan.lastRow, [1, 2]);
  assertEquals(wrappedRowAt(plan, 0), {
    row: 0,
    line: 0,
    offset: 0,
    lastOffset: 5,
    sourceWidth: 5,
    sourceEnd: 5,
    prefixWidth: 0,
    continues: true,
    wrapMarker: true,
    suffixWidth: 1,
  });
  assertEquals(wrappedRowAt(plan, 1), {
    row: 1,
    line: 0,
    offset: 5,
    lastOffset: 5,
    sourceWidth: 6,
    sourceEnd: 10,
    prefixWidth: 0,
    continues: false,
    wrapMarker: false,
    suffixWidth: 1,
  });
  assertEquals(wrappedRowAt(plan, 2)?.sourceWidth, 7);
});

Deno.test("wrap plan: the first continuation can hold a wider label", () => {
  const doc = parseDocument("abcdefghij");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    7,
    new Map([[
      0,
      {
        firstWidth: 1,
        firstContinuationWidth: 3,
        continuationWidth: 1,
      },
    ]]),
  );

  assertEquals(plan.rowCount, 3);
  assertEquals(
    Array.from({ length: 3 }, (_, row) => wrappedRowAt(plan, row)),
    [
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 8,
        sourceWidth: 5,
        sourceEnd: 5,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 1,
      },
      {
        row: 1,
        line: 0,
        offset: 5,
        lastOffset: 8,
        sourceWidth: 3,
        sourceEnd: 8,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 3,
      },
      {
        row: 2,
        line: 0,
        offset: 8,
        lastOffset: 8,
        sourceWidth: 6,
        sourceEnd: 10,
        prefixWidth: 0,
        continues: false,
        wrapMarker: false,
        suffixWidth: 1,
      },
    ],
  );
  assertEquals(wrappedRowForPosition(plan, 0, 4)?.row, 0);
  assertEquals(wrappedRowForPosition(plan, 0, 5)?.row, 1);
  assertEquals(wrappedRowForPosition(plan, 0, 8)?.row, 2);
});

Deno.test("wrap plan: a metadata label connects through continuation rows", () => {
  const doc = parseDocument("abcdefghij");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    7,
    new Map([[0, { firstWidth: 3, continuationWidth: 1 }]]),
  );

  assertEquals(plan.rowCount, 3);
  assertEquals(
    Array.from({ length: 3 }, (_, row) => wrappedRowAt(plan, row)),
    [
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 8,
        sourceWidth: 3,
        sourceEnd: 3,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 3,
      },
      {
        row: 1,
        line: 0,
        offset: 3,
        lastOffset: 8,
        sourceWidth: 5,
        sourceEnd: 8,
        prefixWidth: 0,
        continues: true,
        wrapMarker: true,
        suffixWidth: 1,
      },
      {
        row: 2,
        line: 0,
        offset: 8,
        lastOffset: 8,
        sourceWidth: 6,
        sourceEnd: 10,
        prefixWidth: 0,
        continues: false,
        wrapMarker: false,
        suffixWidth: 1,
      },
    ],
  );
  assertEquals(wrappedRowForPosition(plan, 0, 2)?.row, 0);
  assertEquals(wrappedRowForPosition(plan, 0, 3)?.row, 1);
  assertEquals(wrappedRowForPosition(plan, 0, 8)?.row, 2);
  assertEquals(wrappedRowForPosition(plan, 0, 100)?.row, 2);
});

Deno.test("wrap plan: uses the active non-printable display mode", () => {
  const doc = parseDocument("a\x1b[31mb");
  assertEquals(buildWrapPlan(doc.lines, "pictures", 3).rowCount, 3);
  assertEquals(buildWrapPlan(doc.lines, "hidden", 3).rowCount, 1);
});

Deno.test("wrap plan: rejects rows outside its layout", () => {
  const plan = buildWrapPlan([], "pictures", 4);
  assertEquals(plan.rowCount, 0);
  assertEquals(wrappedRowAt(plan, -1), undefined);
  assertEquals(wrappedRowAt(plan, 0), undefined);
});
