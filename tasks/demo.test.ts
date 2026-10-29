import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  defaultDependencies,
  type DemoDependencies,
  main,
  parseDemoArgs,
  resolveDemoTest,
  runDemo,
  writeGallery,
} from "./demo.ts";

Deno.test("parseDemoArgs accepts deterministic demo options", () => {
  assertEquals(
    parseDemoArgs([
      "patterns",
      "lunch-poll-vote",
      "--keep-frames",
      "--output=tmp/lunch.mp4",
      "--viewport=960x720",
      "--port-offset=500",
    ]),
    {
      packageName: "patterns",
      filters: ["lunch-poll-vote"],
      keepFrames: true,
      outputPath: "tmp/lunch.mp4",
      viewport: "960x720",
      portOffset: 500,
    },
  );
});

Deno.test("parseDemoArgs rejects non-browser packages", () => {
  assertThrows(
    () => parseDemoArgs(["runner", "counter"]),
    Error,
    "unsupported browser-test package",
  );
});

Deno.test("parseDemoArgs accepts multiple test filters", () => {
  assertEquals(parseDemoArgs(["patterns", "one-demo", "two-demo"]), {
    packageName: "patterns",
    filters: ["one-demo", "two-demo"],
    keepFrames: false,
    outputPath: undefined,
    viewport: undefined,
    portOffset: undefined,
  });
});

Deno.test("parseDemoArgs rejects invalid and incomplete options", () => {
  assertThrows(
    () => parseDemoArgs(["patterns", "demo", "--port-offset=-1"]),
    Error,
    "invalid --port-offset",
  );
  assertThrows(
    () => parseDemoArgs(["patterns", "demo", "--unknown"]),
    Error,
    "unknown option",
  );
  assertThrows(
    () => parseDemoArgs(["patterns"]),
    Error,
    "usage:",
  );
});

Deno.test("default demo dependencies provide time, preflight, and subprocess", async () => {
  assertEquals(defaultDependencies.now() instanceof Date, true);
  const previousFfmpeg = Deno.env.get("FFMPEG");
  const root = await Deno.makeTempDir();
  try {
    const ffmpeg = `${root}/fake ffmpeg`;
    await Deno.writeTextFile(
      ffmpeg,
      '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "-version" ]\n',
    );
    await Deno.chmod(ffmpeg, 0o755);
    Deno.env.set("FFMPEG", ffmpeg);
    await defaultDependencies.preflight();
    await Deno.writeTextFile(ffmpeg, "#!/bin/sh\nexit 1\n");
    await assertRejects(
      () => defaultDependencies.preflight(),
      Error,
      "ffmpeg preflight failed",
    );
    const status = await defaultDependencies.runIntegration(
      ["eval", "Deno.exit(0)"],
      root,
      {},
    );
    assertEquals(status.success, true);
  } finally {
    if (previousFfmpeg === undefined) Deno.env.delete("FFMPEG");
    else Deno.env.set("FFMPEG", previousFfmpeg);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("demo main handles help, errors, and an injected successful run", async () => {
  assertEquals(await main(["--help"]), 0);
  assertEquals(await main(["--unknown"]), 1);
  assertEquals(
    await main(["shell", "worker-runtime"], (options) => {
      assertEquals(options.packageName, "shell");
      assertEquals(options.filters, ["worker-runtime"]);
      return Promise.resolve(0);
    }),
    0,
  );
  assertEquals(
    await main(["shell", "worker-runtime"], () => Promise.reject("failed")),
    1,
  );
});

Deno.test("demo CLI help exits successfully", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "demo.ts", "--help"],
    cwd: import.meta.dirname,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(output.success, true);
  assertEquals(
    new TextDecoder().decode(output.stdout).includes("Usage:"),
    true,
  );
});

Deno.test("resolveDemoTest requires exactly one file", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/patterns/integration`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/demo.test.ts`, "");
    await Deno.writeTextFile(`${dir}/one-demo.test.ts`, "");
    await Deno.writeTextFile(`${dir}/two-demo.test.ts`, "");
    const base = parseDemoArgs(["patterns", "one-demo"]);
    assertEquals(
      await resolveDemoTest(root, base.packageName, base.filters[0]),
      "one-demo.test.ts",
    );
    assertEquals(
      await resolveDemoTest(root, base.packageName, "demo.test.ts"),
      "demo.test.ts",
    );
    await assertRejects(
      () => resolveDemoTest(root, base.packageName, "emo"),
      Error,
      "ambiguous",
    );
    await assertRejects(
      () => resolveDemoTest(root, base.packageName, "missing"),
      Error,
      "no patterns integration test",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runDemo names and copies a successful video", async () => {
  await withDemoFixture(async (root) => {
    let preflighted = false;
    const dependencies = demoDependencies({
      preflight: () => {
        preflighted = true;
        return Promise.resolve();
      },
      runIntegration: async (args, cwd, env) => {
        assertEquals(args, [
          "task",
          "integration",
          "--port-offset=500",
          "patterns",
          "one-demo",
        ]);
        assertEquals(cwd, root);
        assertEquals(env.CF_DEMO_NAME, "one-demo");
        assertEquals(env.CF_DEMO_KEEP_FRAMES, "1");
        assertEquals(env.CF_DEMO_VIEWPORT, "960x720");
        await Deno.writeTextFile(
          `${env.CF_DEMO_OUTPUT_DIR}/one-demo.mp4`,
          "video bytes",
        );
        return { success: true, code: 0 };
      },
    });
    const result = await runDemo(
      {
        packageName: "patterns",
        filters: ["one-demo"],
        keepFrames: true,
        outputPath: "copied/one-demo.mp4",
        viewport: "960x720",
        portOffset: 500,
      },
      root,
      dependencies,
    );

    assertEquals(result, 0);
    assertEquals(preflighted, true);
    assertEquals(
      await Deno.readTextFile(`${root}/copied/one-demo.mp4`),
      "video bytes",
    );
  });
});

Deno.test("runDemo preserves a failing integration status and manifest", async () => {
  await withDemoFixture(async (root) => {
    const result = await runDemo(
      {
        packageName: "patterns",
        filters: ["one-demo"],
        keepFrames: false,
      },
      root,
      demoDependencies({
        runIntegration: async (_args, _cwd, env) => {
          await Deno.writeTextFile(
            `${env.CF_DEMO_OUTPUT_DIR}/manifest.json`,
            JSON.stringify({ status: "passed" }),
          );
          return { success: false, code: 7 };
        },
      }),
    );

    assertEquals(result, 7);
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${demoRunDir(root)}/manifest.json`,
      ),
    );
    assertEquals(manifest.status, "test-failed");
    assertEquals(manifest.error, "integration test exited with code 7");
  });
});

Deno.test("runDemo rejects a successful test without a video", async () => {
  await withDemoFixture(async (root) => {
    await assertRejects(
      () =>
        runDemo(
          {
            packageName: "patterns",
            filters: ["one-demo"],
            keepFrames: false,
          },
          root,
          demoDependencies(),
        ),
      Error,
      "did not produce one-demo.mp4",
    );
  });
});

Deno.test("runDemo retains a named video in its artifact directory", async () => {
  await withDemoFixture(async (root) => {
    const result = await runDemo(
      {
        packageName: "patterns",
        filters: ["one-demo"],
        keepFrames: false,
      },
      root,
      demoDependencies({
        runIntegration: async (_args, _cwd, env) => {
          await Deno.writeTextFile(
            `${env.CF_DEMO_OUTPUT_DIR}/one-demo.mp4`,
            "video bytes",
          );
          return { success: true, code: 0 };
        },
      }),
    );
    assertEquals(result, 0);
    assertEquals(
      await Deno.readTextFile(`${demoRunDir(root)}/one-demo.mp4`),
      "video bytes",
    );
  });
});

Deno.test("runDemo preserves a setup failure without a manifest", async () => {
  await withDemoFixture(async (root) => {
    assertEquals(
      await runDemo(
        {
          packageName: "patterns",
          filters: ["one-demo"],
          keepFrames: false,
        },
        root,
        demoDependencies({
          runIntegration: () => Promise.resolve({ success: false, code: 4 }),
        }),
      ),
      4,
    );
  });
});

Deno.test("runDemo records multiple tests and writes portable galleries", async () => {
  await withDemoFixture(async (root) => {
    const calls: string[] = [];
    const result = await runDemo(
      {
        packageName: "patterns",
        filters: ["one-demo", "two-demo"],
        keepFrames: false,
        outputPath: "copied-gallery",
      },
      root,
      demoDependencies({
        runIntegration: async (args, _cwd, env) => {
          const name = env.CF_DEMO_NAME;
          calls.push(name);
          assertEquals(args.at(-1), name);
          await Deno.writeTextFile(
            `${env.CF_DEMO_OUTPUT_DIR}/${name}.mp4`,
            `${name} video`,
          );
          return { success: true, code: 0 };
        },
      }),
    );

    assertEquals(result, 0);
    assertEquals(calls, ["one-demo", "two-demo"]);
    const gallery = await Deno.readTextFile(
      `${demoGalleryDir(root)}/index.html`,
    );
    assertEquals(gallery.includes('src="one-demo/one-demo.mp4"'), true);
    assertEquals(gallery.includes('src="two-demo/two-demo.mp4"'), true);
    assertEquals(
      await Deno.readTextFile(`${root}/copied-gallery/one-demo.mp4`),
      "one-demo video",
    );
    const copiedGallery = await Deno.readTextFile(
      `${root}/copied-gallery/index.html`,
    );
    assertEquals(copiedGallery.includes('src="one-demo.mp4"'), true);
    assertEquals(copiedGallery.includes('src="two-demo.mp4"'), true);
  }, true);
});

Deno.test("runDemo rejects duplicate tests and an MP4 batch output", async () => {
  await withDemoFixture(async (root) => {
    await assertRejects(
      () =>
        runDemo(
          {
            packageName: "patterns",
            filters: ["one-demo", "one-demo.test"],
            keepFrames: false,
          },
          root,
          demoDependencies(),
        ),
      Error,
      "distinct test files",
    );
    await assertRejects(
      () =>
        runDemo(
          {
            packageName: "patterns",
            filters: ["one-demo", "two-demo"],
            keepFrames: false,
            outputPath: "all.mp4",
          },
          root,
          demoDependencies(),
        ),
      Error,
      "must be a directory",
    );
  }, true);
});

Deno.test("writeGallery escapes viewer-facing labels and paths", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeGallery(root, [{ title: "one < two", src: 'demo&".mp4' }]);
    const gallery = await Deno.readTextFile(`${root}/index.html`);
    assertEquals(gallery.includes("one &lt; two"), true);
    assertEquals(gallery.includes('src="demo&amp;&quot;.mp4"'), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const FIXED_NOW = new Date("2026-07-14T00:00:00.000Z");

function demoDependencies(
  overrides: Partial<DemoDependencies> = {},
): DemoDependencies {
  return {
    now: () => FIXED_NOW,
    preflight: () => Promise.resolve(),
    runIntegration: () => Promise.resolve({ success: true, code: 0 }),
    ...overrides,
  };
}

function demoRunDir(root: string): string {
  return `${root}/tmp/demos/patterns-one-demo-2026-07-14T00-00-00-000Z`;
}

function demoGalleryDir(root: string): string {
  return `${root}/tmp/demos/patterns-gallery-2026-07-14T00-00-00-000Z`;
}

async function withDemoFixture(
  fn: (root: string) => Promise<void>,
  includeSecond = false,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/patterns/integration`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/one-demo.test.ts`, "");
    if (includeSecond) {
      await Deno.writeTextFile(`${dir}/two-demo.test.ts`, "");
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
