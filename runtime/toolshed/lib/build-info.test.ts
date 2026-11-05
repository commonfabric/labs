import { assertEquals } from "@std/assert";
import env from "@/env.ts";
import {
  normalize,
  readBuildInfoFrom,
  readShellServerExecutionDefineFrom,
  resolveGitShaFrom,
} from "@/lib/build-info.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

Deno.test("normalize", async (t) => {
  await t.step("returns null for null/undefined", () => {
    assertEquals(normalize(null), null);
    assertEquals(normalize(undefined), null);
  });
  await t.step("returns null for empty/whitespace", () => {
    assertEquals(normalize(""), null);
    assertEquals(normalize("   "), null);
    assertEquals(normalize("\t\n  "), null);
  });
  await t.step("trims and returns valid strings", () => {
    assertEquals(normalize("abc"), "abc");
    assertEquals(normalize("  abc  "), "abc");
    assertEquals(normalize("\tabc\n"), "abc");
  });
});

Deno.test("resolveGitShaFrom", async (t) => {
  await t.step("explicit override wins over baked value", () => {
    assertEquals(
      resolveGitShaFrom("override-sha", "baked-sha", "source-run-sha"),
      "override-sha",
    );
  });
  await t.step("trims the explicit override before precedence check", () => {
    assertEquals(
      resolveGitShaFrom(
        "  override-sha  ",
        "baked-sha",
        "source-run-sha",
      ),
      "override-sha",
    );
  });
  await t.step("falls through to baked when env is unset/empty", () => {
    for (const explicit of [undefined, null, "", "   "]) {
      assertEquals(
        resolveGitShaFrom(explicit, "baked-sha", "source-run-sha"),
        "baked-sha",
      );
    }
  });
  await t.step(
    "uses COMMIT_SHA when explicit and baked values are absent",
    () => {
      assertEquals(
        resolveGitShaFrom(undefined, null, "  source-run-sha  "),
        "source-run-sha",
      );
    },
  );
  await t.step("returns null when all values are unset", () => {
    assertEquals(resolveGitShaFrom(undefined, null, undefined), null);
    assertEquals(resolveGitShaFrom("", null, ""), null);
    assertEquals(resolveGitShaFrom("   ", null, "   "), null);
  });
});

Deno.test("readBuildInfoFrom", async (t) => {
  const tempDir = await Deno.makeTempDir({ prefix: "build-info-test-" });
  const pathFor = (name: string) => `${tempDir}/${name}`;

  try {
    await t.step("returns nulls when file is missing", () => {
      assertEquals(readBuildInfoFrom(pathFor("nonexistent")), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("returns nulls for empty file", async () => {
      const path = pathFor("empty");
      await Deno.writeTextFile(path, "");
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("returns nulls for whitespace-only file", async () => {
      const path = pathFor("whitespace");
      await Deno.writeTextFile(path, "   \n   ");
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("returns nulls for malformed JSON", async () => {
      const path = pathFor("malformed");
      await Deno.writeTextFile(path, "{not json");
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("returns nulls for JSON null", async () => {
      const path = pathFor("null-literal");
      await Deno.writeTextFile(path, "null");
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("returns nulls for non-object JSON (string)", async () => {
      const path = pathFor("string-literal");
      await Deno.writeTextFile(path, '"abc"');
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("parses valid JSON and trims fields", async () => {
      const path = pathFor("valid");
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          commitSha: "  abc123  ",
          builtAt: "2026-05-07T00:00:00Z",
        }),
      );
      assertEquals(readBuildInfoFrom(path), {
        commitSha: "abc123",
        builtAt: "2026-05-07T00:00:00Z",
      });
    });

    await t.step("normalizes empty string fields to null", async () => {
      const path = pathFor("empty-fields");
      await Deno.writeTextFile(
        path,
        JSON.stringify({ commitSha: "", builtAt: "  " }),
      );
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("handles missing fields", async () => {
      const path = pathFor("missing");
      await Deno.writeTextFile(path, "{}");
      assertEquals(readBuildInfoFrom(path), {
        commitSha: null,
        builtAt: null,
      });
    });

    await t.step("ignores extra fields", async () => {
      const path = pathFor("extras");
      await Deno.writeTextFile(
        path,
        JSON.stringify({ commitSha: "abc", builtAt: "now", extra: "x" }),
      );
      assertEquals(readBuildInfoFrom(path), {
        commitSha: "abc",
        builtAt: "now",
      });
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readShellServerExecutionDefineFrom", async (t) => {
  // The shell's baked server-execution posture rides the same COMPILED marker
  // (tasks/build-binaries.ts writes it from the build environment — the value
  // runtime/shell/felt.config.ts bakes as the shell's define). CI's
  // server-execution lanes read it back through /api/meta to verify the posture
  // the binary actually carries; a missing/unset value reads null.

  const tempDir = await Deno.makeTempDir({ prefix: "build-info-sx-test-" });
  const pathFor = (name: string) => `${tempDir}/${name}`;
  try {
    await t.step(
      "null when the marker is missing, malformed, or non-object",
      async () => {
        assertEquals(readShellServerExecutionDefineFrom(pathFor("nope")), null);
        await Deno.writeTextFile(pathFor("bad"), "{not json");
        assertEquals(readShellServerExecutionDefineFrom(pathFor("bad")), null);
        await Deno.writeTextFile(pathFor("str"), '"abc"');
        assertEquals(readShellServerExecutionDefineFrom(pathFor("str")), null);
      },
    );
    await t.step(
      "null when the field is absent, null, or blank (define unset — the shell follows the first-party default)",
      async () => {
        await Deno.writeTextFile(
          pathFor("absent"),
          JSON.stringify({ commitSha: "abc", builtAt: "now" }),
        );
        assertEquals(
          readShellServerExecutionDefineFrom(pathFor("absent")),
          null,
        );
        await Deno.writeTextFile(
          pathFor("nullish"),
          JSON.stringify({ shellServerExecutionDefine: null }),
        );
        assertEquals(
          readShellServerExecutionDefineFrom(pathFor("nullish")),
          null,
        );
        await Deno.writeTextFile(
          pathFor("blank"),
          JSON.stringify({ shellServerExecutionDefine: "  " }),
        );
        assertEquals(
          readShellServerExecutionDefineFrom(pathFor("blank")),
          null,
        );
      },
    );
    await t.step(
      'returns the raw baked define, trimmed ("true" for an ON-built shell, "false" for OFF-built)',
      async () => {
        await Deno.writeTextFile(
          pathFor("on"),
          JSON.stringify({
            commitSha: "abc",
            builtAt: "now",
            shellServerExecutionDefine: " true ",
          }),
        );
        assertEquals(readShellServerExecutionDefineFrom(pathFor("on")), "true");
        await Deno.writeTextFile(
          pathFor("off"),
          JSON.stringify({ shellServerExecutionDefine: "false" }),
        );
        assertEquals(
          readShellServerExecutionDefineFrom(pathFor("off")),
          "false",
        );
      },
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
