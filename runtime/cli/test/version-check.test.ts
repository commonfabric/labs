import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import {
  addProcessUnloadListener,
  processExitCode,
  resetDeferredSkewNoteForTest,
  SKIP_VERSION_CHECK_ENV,
  startVersionCheck,
  suppressDeferredSkewNote,
  versionMismatchWarning,
} from "../lib/version-check.ts";
import type { ShaRelation } from "../lib/build-info.ts";

const API = "http://localhost:8000";

Deno.test("versionMismatchWarning", async (t) => {
  await t.step("null when either side is unknown", () => {
    assertEquals(versionMismatchWarning(null, "abc", API), null);
    assertEquals(versionMismatchWarning("abc", null, API), null);
    assertEquals(versionMismatchWarning(null, null, API), null);
  });

  await t.step("null when both sides match", () => {
    assertEquals(versionMismatchWarning("abc123", "abc123", API), null);
  });

  await t.step(
    "undirected mismatch names both commits, the host, and the override",
    () => {
      const warning = versionMismatchWarning("aaa111", "bbb222", API);
      assert(warning !== null);
      assertStringIncludes(warning, "aaa111");
      assertStringIncludes(warning, "bbb222");
      assertStringIncludes(warning, "http://localhost:8000");
      assertStringIncludes(warning, SKIP_VERSION_CHECK_ENV);
      assertStringIncludes(warning, "different versions");
    },
  );

  await t.step("cli-ahead reads as context for a failure", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "cli-ahead",
      serverBehindBy: 7,
    });
    assert(warning !== null);
    expect(warning).toContain("Version context:");
    assertStringIncludes(warning, "newer than the server");
    assertStringIncludes(warning, "7 commit(s) behind");
    expect(warning).toContain(
      "Commit distance alone does not establish incompatibility",
    );
    expect(warning).toContain("explain this failure.");
    expect(warning).toContain(
      "If this is a local server you control, restarting it from this cf's",
    );
    expect(warning).toContain("checkout aligns the versions.");
    expect(warning).not.toMatch(/possible cause|redeploy|Restart/);
    assert(!warning.includes("OUTDATED"));
  });

  await t.step("cli-ahead tolerates an uncountable distance", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "cli-ahead",
      serverBehindBy: null,
    });
    assert(warning !== null);
    assertStringIncludes(warning, "is behind");
  });

  await t.step("cli-behind is the loud case", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "cli-behind",
    });
    assert(warning !== null);
    assertStringIncludes(warning, "OUTDATED");
    assertStringIncludes(warning, "likely fail");
    assertStringIncludes(warning, SKIP_VERSION_CHECK_ENV);
  });

  await t.step("diverged names the divergence", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "diverged",
    });
    assert(warning !== null);
    assertStringIncludes(warning, "diverged");
  });

  await t.step("reduces the api url to its origin", () => {
    const warning = versionMismatchWarning(
      "aaa111",
      "bbb222",
      "http://localhost:8000/some/path",
    );
    assert(warning !== null);
    assertStringIncludes(warning, "http://localhost:8000");
    assert(!warning.includes("/some/path"));
  });
});

/** Deps whose every effect records itself, so skipping is observable. The
 * unload hook and exit code are captured rather than real, so a test ends the
 * process without ending the process. */
function recordingDeps(
  envValue: string | undefined,
  options: {
    checkoutDir?: string | null;
    relation?: ShaRelation;
  } = {},
) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const unloadHandlers: Array<() => void> = [];
  const exit = { code: 0 };
  return {
    calls,
    warnings,
    unloadHandlers,
    exit,
    deps: {
      env: (key: string) =>
        key === SKIP_VERSION_CHECK_ENV ? envValue : undefined,
      resolveCliVersion: () => {
        calls.push("resolveCliVersion");
        return Promise.resolve({
          sha: "aaa111",
          checkoutDir: options.checkoutDir ?? null,
        });
      },
      relate: (_dir: string, _cli: string, _server: string) => {
        calls.push("relate");
        return Promise.resolve<ShaRelation>(
          options.relation ?? { kind: "unknown" },
        );
      },
      warn: (message: string) => {
        calls.push("warn");
        warnings.push(message);
      },
      addUnloadListener: (handler: () => void) => {
        calls.push("addUnloadListener");
        unloadHandlers.push(handler);
      },
      exitCode: () => exit.code,
    },
  };
}

Deno.test("startVersionCheck", async (t) => {
  await t.step(
    "skip env set: resolves nothing and warns nothing, even on mismatch",
    async () => {
      const { calls, deps } = recordingDeps("1");
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, []);
    },
  );

  await t.step(
    "any non-empty value skips, including '0' and 'false'",
    async () => {
      for (const value of ["0", "false"]) {
        const { calls, deps } = recordingDeps(value);
        await startVersionCheck(deps).finish("bbb222", API);
        assertEquals(calls, []);
      }
    },
  );

  await t.step("empty/unset does not skip: resolves and warns", async () => {
    for (const value of [undefined, ""]) {
      const { calls, deps } = recordingDeps(value);
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "warn"]);
    }
  });

  await t.step("matching commits resolve but do not warn", async () => {
    const { calls, deps } = recordingDeps(undefined);
    await startVersionCheck(deps).finish("aaa111", API);
    assertEquals(calls, ["resolveCliVersion"]);
  });

  await t.step(
    "a checkout orders the mismatch and grades the warning",
    async () => {
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: "/some/checkout/runtime/cli/lib",
        relation: { kind: "cli-behind" },
      });
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "relate", "warn"]);
      assertStringIncludes(warnings[0]!, "OUTDATED");
    },
  );

  await t.step(
    "no checkout (compiled binary): no ordering attempted, undirected warning",
    async () => {
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: null,
        relation: { kind: "cli-behind" }, // must not be consulted
      });
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "warn"]);
      assertStringIncludes(warnings[0]!, "different versions");
    },
  );

  await t.step("a rejecting resolver is swallowed, not thrown", async () => {
    const { calls, deps } = recordingDeps(undefined);
    deps.resolveCliVersion = () => Promise.reject(new Error("git exploded"));
    await startVersionCheck(deps).finish("bbb222", API);
    assertEquals(calls, []);
  });

  await t.step(
    "a rejecting relate degrades to the undirected warning",
    async () => {
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: "/some/checkout/runtime/cli/lib",
      });
      deps.relate = () => Promise.reject(new Error("git exploded"));
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "warn"]);
      assertStringIncludes(warnings[0]!, "different versions");
    },
  );

  await t.step(
    "cli-ahead holds its note: finish() warns nothing and arms the hook",
    async () => {
      resetDeferredSkewNoteForTest();
      const { calls, unloadHandlers, deps } = recordingDeps(undefined, {
        checkoutDir: "/some/checkout/runtime/cli/lib",
        relation: { kind: "cli-ahead", serverBehindBy: 7 },
      });
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "relate", "addUnloadListener"]);
      assertEquals(unloadHandlers.length, 1);
    },
  );

  await t.step("the held note prints on a failure exit", async () => {
    resetDeferredSkewNoteForTest();
    const { warnings, unloadHandlers, exit, deps } = recordingDeps(undefined, {
      checkoutDir: "/some/checkout/runtime/cli/lib",
      relation: { kind: "cli-ahead", serverBehindBy: 7 },
    });
    await startVersionCheck(deps).finish("bbb222", API);
    exit.code = 1;
    unloadHandlers[0]!();
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "newer than the server");
  });

  await t.step("the held note stays silent on a success exit", async () => {
    resetDeferredSkewNoteForTest();
    const { warnings, unloadHandlers, exit, deps } = recordingDeps(undefined, {
      checkoutDir: "/some/checkout/runtime/cli/lib",
      relation: { kind: "cli-ahead", serverBehindBy: 7 },
    });
    await startVersionCheck(deps).finish("bbb222", API);
    exit.code = 0;
    unloadHandlers[0]!();
    assertEquals(warnings, []);
  });

  await t.step(
    "suppresses explained failures and can arm a later note",
    async () => {
      resetDeferredSkewNoteForTest();
      const { warnings, unloadHandlers, exit, deps } = recordingDeps(
        undefined,
        {
          checkoutDir: "/some/checkout/runtime/cli/lib",
          relation: { kind: "cli-ahead", serverBehindBy: 7 },
        },
      );
      const check = startVersionCheck(deps);
      await check.finish("bbb222", API);
      suppressDeferredSkewNote();
      exit.code = 1;
      unloadHandlers[0]!();
      expect(warnings).toEqual([]);

      await check.finish("bbb222", API);
      expect(unloadHandlers).toHaveLength(1);
      unloadHandlers[0]!();
      expect(warnings).toHaveLength(1);
    },
  );

  await t.step(
    "a second finish re-arms the note without a second hook",
    async () => {
      resetDeferredSkewNoteForTest();
      const { warnings, unloadHandlers, exit, deps } = recordingDeps(
        undefined,
        {
          checkoutDir: "/some/checkout/runtime/cli/lib",
          relation: { kind: "cli-ahead", serverBehindBy: 7 },
        },
      );
      await startVersionCheck(deps).finish("bbb222", API);
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(unloadHandlers.length, 1);
      exit.code = 1;
      unloadHandlers[0]!();
      assertEquals(warnings.length, 1);
    },
  );

  await t.step(
    "the production seams read a real code and register a real hook",
    () => {
      // The deferral's default deps, exercised directly: the exit-code read
      // returns the live process value, and the registration accepts a
      // handler that will fire at this test process's own (clean) unload.
      assertEquals(typeof processExitCode(), "number");
      addProcessUnloadListener(() => {});
    },
  );

  await t.step(
    "cli-behind still warns at finish(), before any exit",
    async () => {
      resetDeferredSkewNoteForTest();
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: "/some/checkout/runtime/cli/lib",
        relation: { kind: "cli-behind" },
      });
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "relate", "warn"]);
      assertStringIncludes(warnings[0]!, "OUTDATED");
    },
  );
});
