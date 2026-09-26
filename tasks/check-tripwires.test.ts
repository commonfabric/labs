import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { checkTripwire, main, TRIPWIRES } from "./check-tripwires.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

//
// The manifest against the tree
//
// The check is only as good as its manifest: a typo'd path would make it pass
// vacuously while reporting "intact", which is the failure mode that matters
// most for a guard nobody looks at until the day it fires.
//

Deno.test("every tripwire's test file exists and carries its sentinel", async () => {
  assert(
    TRIPWIRES.length > 0,
    "manifest is empty — the check passes vacuously",
  );
  for (const tripwire of TRIPWIRES) {
    const source = await Deno.readTextFile(join(REPO_ROOT, tripwire.testFile));
    assertStringIncludes(
      source,
      tripwire.sentinel,
      `${tripwire.name}: test file does not carry its sentinel`,
    );
  }
});

Deno.test("every tripwire's weakness is currently present", async () => {
  for (const tripwire of TRIPWIRES) {
    assert(
      await tripwire.stillWeak(),
      `${tripwire.name}: the weakness is resolved — run ` +
        `\`deno task check-tripwires\` and follow the printed obligation`,
    );
  }
});

//
// The obligation text
//
// The obligation text IS the deliverable — it is the only thing the person who
// trips this will read. A tripwire whose instructions have gone stale is a
// reminder that fires and then wastes the moment it bought.
//

Deno.test("every obligation names concrete, runnable next steps", () => {
  for (const tripwire of TRIPWIRES) {
    const text = tripwire.obligation.join("\n");
    assertStringIncludes(text, "deno task", `${tripwire.name}: no command`);
    assert(
      tripwire.obligation.length >= 5,
      `${tripwire.name}: obligation is too thin to act on`,
    );
  }
});

//
// The real manifest
//

Deno.test("the real manifest passes end to end", async () => {
  assertEquals(await main(), 0);
});

//
// The evasion paths, and the cases that are not
//
// Each evasion is a way someone silences the reminder without meaning to, and
// a guard whose failure modes are only ever checked by hand is a guard that
// quietly stops working. Beside them sit the intact baseline, the legitimate
// resolved weakness, and the driver that reports them all.
//
// No case points at a real repository file: four write their own fixture, and
// two name a path the repository does not have. Self-reference bites here: a
// literal ".ignore(" anywhere in this file would make the healthy case trip the
// DISABLED branch.
//

const SENTINEL = "@tripwire:probe-sentinel";

const withFixture = async (
  contents: string,
  run: (relativePath: string) => Promise<void>,
): Promise<void> => {
  const relativePath =
    `tasks/check-tripwires.fixture.${crypto.randomUUID()}.txt`;
  await Deno.writeTextFile(join(REPO_ROOT, relativePath), contents);
  try {
    await run(relativePath);
  } finally {
    await Deno.remove(join(REPO_ROOT, relativePath));
  }
};

const fixture = (over: Partial<typeof TRIPWIRES[number]> = {}) => ({
  name: "probe",
  testFile: "tasks/does-not-matter.txt",
  sentinel: SENTINEL,
  stillWeak: () => Promise.resolve(true),
  obligation: ["  do the thing", "  deno task something"],
  ...over,
});

Deno.test("intact tripwire reports no failures", async () => {
  await withFixture(
    `${SENTINEL}\nDeno.test("x", () => {});\n`,
    async (path) => {
      assertEquals(
        await checkTripwire(fixture({ testFile: path }), REPO_ROOT),
        [],
      );
    },
  );
});

Deno.test("resolving the weakness reports the obligation", async () => {
  await withFixture(`${SENTINEL}\n`, async (path) => {
    const failures = await checkTripwire(
      fixture({ testFile: path, stillWeak: () => Promise.resolve(false) }),
      REPO_ROOT,
    );
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0], "deno task something");
  });
});

Deno.test("deleting the test file is caught", async () => {
  const failures = await checkTripwire(
    fixture({ testFile: "tasks/no-such-file.test.ts" }),
    REPO_ROOT,
  );
  assertEquals(failures.length, 1);
  assertStringIncludes(failures[0], "TRIPWIRE REMOVED");
});

Deno.test("stripping the sentinel (gutting) is caught", async () => {
  await withFixture("nothing identifying here\n", async (path) => {
    const failures = await checkTripwire(
      fixture({ testFile: path }),
      REPO_ROOT,
    );
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0], "TRIPWIRE GUTTED");
  });
});

Deno.test("a skipped tripwire is caught", async () => {
  // Assembled rather than written literally, so this file never contains the
  // marker it is testing for.
  const skipped = `${SENTINEL}\nDeno.test` + ".ignore" + '("x", () => {});\n';
  await withFixture(skipped, async (path) => {
    const failures = await checkTripwire(
      fixture({ testFile: path }),
      REPO_ROOT,
    );
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0], "TRIPWIRE DISABLED");
  });
});

Deno.test("main reports every failure and exits non-zero", async () => {
  const reported: string[] = [];
  const code = await main(
    [fixture({ stillWeak: () => Promise.resolve(false) })],
    (m) => reported.push(m),
  );
  assertEquals(code, 1);
  assertEquals(reported.length, 1);
  assertStringIncludes(reported[0], "deno task something");
});
