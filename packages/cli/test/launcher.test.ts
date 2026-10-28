import { assertEquals, assertThrows } from "@std/assert";
import {
  buildCfLauncherCommand,
  defaultLabsRootFromModulePath,
  fileUrlToPath,
  formatCfLauncherError,
  formatCfLauncherUsage,
  parseCfLauncherArgs,
} from "../launcher.ts";

const launcherPath = fileUrlToPath(
  new URL("../launcher.ts", import.meta.url).href,
);

Deno.test("defaultLabsRootFromModulePath resolves from packages/cli", () => {
  assertEquals(
    defaultLabsRootFromModulePath("/workspace/labs/packages/cli/launcher.ts"),
    "/workspace/labs",
  );
});

Deno.test("defaultLabsRootFromModulePath preserves UNC roots", () => {
  assertEquals(
    defaultLabsRootFromModulePath(
      "//server/share/labs/packages/cli/launcher.ts",
    ),
    "//server/share/labs",
  );
  assertEquals(
    defaultLabsRootFromModulePath(
      "//server/share/packages/cli/launcher.ts",
    ),
    "//server/share",
  );
});

Deno.test("fileUrlToPath converts drive and UNC file URLs", () => {
  assertEquals(
    fileUrlToPath("file:///C:/workspace/labs/packages/cli/launcher.ts"),
    "C:/workspace/labs/packages/cli/launcher.ts",
  );
  assertEquals(
    fileUrlToPath("file://server/share/labs/packages/cli/launcher.ts"),
    "//server/share/labs/packages/cli/launcher.ts",
  );
});

Deno.test("parseCfLauncherArgs defaults to the launcher labs checkout", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["--", "--help"],
    cwd: "/workspace/labs",
    initCwd: "/workspace/pattern-factory",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals(parsed, {
    denoPath: "/usr/local/bin/deno",
    labsRoot: "/workspace/labs",
    configPath: "/workspace/labs/deno.jsonc",
    cliEntrypoint: "/workspace/labs/packages/cli/mod.ts",
    cwd: "/workspace/pattern-factory",
    cfArgs: ["--help"],
  });
});

Deno.test("parseCfLauncherArgs lets explicit --cwd override INIT_CWD", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["--cwd", "/workspace/explicit", "--", "check", "pattern.tsx"],
    cwd: "/workspace/labs",
    initCwd: "/workspace/stale-task-cwd",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected help result");
  }
  assertEquals(parsed.cwd, "/workspace/explicit");
  assertEquals(parsed.cfArgs, ["check", "pattern.tsx"]);
});

Deno.test("parseCfLauncherArgs supports explicit consumer config", () => {
  const parsed = parseCfLauncherArgs({
    argv: [
      "--labs-root",
      "vendor/labs",
      "--config",
      "deno.json",
      "--cwd",
      ".",
      "--",
      "piece",
      "apply",
      "--config",
      "piece-config.json",
    ],
    cwd: "/workspace/loom",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/loom/vendor/labs/packages/cli/launcher.ts",
  });

  assertEquals(parsed, {
    denoPath: "/usr/local/bin/deno",
    labsRoot: "/workspace/loom/vendor/labs",
    configPath: "/workspace/loom/deno.json",
    cliEntrypoint: "/workspace/loom/vendor/labs/packages/cli/mod.ts",
    cwd: "/workspace/loom",
    cfArgs: ["piece", "apply", "--config", "piece-config.json"],
  });
});

Deno.test("parseCfLauncherArgs preserves explicit UNC share roots", () => {
  const parsed = parseCfLauncherArgs({
    argv: [
      "--labs-root",
      "//server/share",
      "--config",
      "//server/share/deno.json",
      "--cwd",
      "//server/share",
      "--",
      "check",
      "pattern.tsx",
    ],
    cwd: "/workspace/labs",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals(parsed, {
    denoPath: "/usr/local/bin/deno",
    labsRoot: "//server/share",
    configPath: "//server/share/deno.json",
    cliEntrypoint: "//server/share/packages/cli/mod.ts",
    cwd: "//server/share",
    cfArgs: ["check", "pattern.tsx"],
  });
});

Deno.test("parseCfLauncherArgs forwards cf args after separator", () => {
  const parsed = parseCfLauncherArgs({
    argv: [
      "--labs-root",
      "../..",
      "--config",
      "../../deno.json",
      "--cli-entrypoint",
      "./mod.ts",
      "--",
      "--config",
      "piece-config.json",
    ],
    cwd: "/workspace/labs/packages/cli",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected help result");
  }
  assertEquals(parsed.configPath, "/workspace/labs/deno.json");
  assertEquals(parsed.cfArgs, ["--config", "piece-config.json"]);
});

Deno.test("parseCfLauncherArgs treats the first non-launcher arg as cf args", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["check", "pattern.tsx", "--no-run"],
    cwd: "/workspace/labs",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected help result");
  }
  assertEquals(parsed.cfArgs, ["check", "pattern.tsx", "--no-run"]);
});

Deno.test("parseCfLauncherArgs reports launcher help for launcher-specific flag", () => {
  assertEquals(
    parseCfLauncherArgs({
      argv: ["--launcher-help"],
      cwd: "/workspace/labs",
      denoPath: "/usr/local/bin/deno",
      modulePath: "/workspace/labs/packages/cli/launcher.ts",
    }),
    { help: true },
  );
  assertEquals(formatCfLauncherUsage().includes("--labs-root"), true);
});

Deno.test("parseCfLauncherArgs passes cf help through to the child CLI", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["--help"],
    cwd: "/workspace/labs",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected launcher help result");
  }
  assertEquals(parsed.cfArgs, ["--help"]);
});

Deno.test("parseCfLauncherArgs rejects missing option values", () => {
  assertThrows(
    () =>
      parseCfLauncherArgs({
        argv: ["--config"],
        cwd: "/workspace/labs",
        denoPath: "/usr/local/bin/deno",
        modulePath: "/workspace/labs/packages/cli/launcher.ts",
      }),
    Error,
    "--config requires a value",
  );
});

Deno.test("formatCfLauncherError adds cf passthrough hint for launcher options", () => {
  assertEquals(
    formatCfLauncherError(new Error("--config requires a value")),
    "cf launcher: --config requires a value; use -- to pass --config to cf",
  );
});

Deno.test("launcher main renders launcher-scoped diagnostics without a stack", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-run",
      "--allow-env",
      "--allow-read",
      launcherPath,
      "--config",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();
  assertEquals(output.code, 1);
  assertEquals(new TextDecoder().decode(output.stdout), "");
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(
    stderr,
    "cf launcher: --config requires a value; use -- to pass --config to cf\n",
  );
});

Deno.test("launcher runs an outside-Labs consumer config and inherits env", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const expectedCwd = (await Deno.realPath(tempDir)).replaceAll("\\", "/");
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({
        imports: {
          "consumer-alias": "./consumer-alias.ts",
        },
      }),
    );
    await Deno.writeTextFile(
      `${tempDir}/consumer-alias.ts`,
      `export const value = "consumer-config";\n`,
    );
    await Deno.writeTextFile(
      `${tempDir}/child.ts`,
      `
import { value } from "consumer-alias";

console.log(JSON.stringify({
  args: Deno.args,
  cwd: Deno.cwd().replaceAll("\\\\", "/"),
  configValue: value,
  cfApiUrl: Deno.env.get("CF_API_URL"),
  cfCliName: Deno.env.get("CF_CLI_NAME"),
  initCwd: Deno.env.get("INIT_CWD"),
  readsInterfaceNetworks: Deno.networkInterfaces().length > 0,
}));
`,
    );

    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-run",
        "--allow-env",
        "--allow-read",
        launcherPath,
        "--deno",
        Deno.execPath(),
        "--labs-root",
        ".",
        "--config",
        "deno.json",
        "--cli-entrypoint",
        "child.ts",
        "--cwd",
        ".",
        "--",
        "check",
        "pattern.tsx",
      ],
      cwd: tempDir,
      env: {
        CF_API_URL: "http://example.invalid",
        INIT_CWD: "/stale/init/cwd",
      },
      stdout: "piped",
      stderr: "piped",
    });

    const output = await command.output();
    assertEquals(new TextDecoder().decode(output.stderr), "");
    assertEquals(output.code, 0);
    assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
      args: ["check", "pattern.tsx"],
      cwd: expectedCwd,
      configValue: "consumer-config",
      cfApiUrl: "http://example.invalid",
      cfCliName: "cf",
      initCwd: "/stale/init/cwd",
      readsInterfaceNetworks: true,
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildCfLauncherCommand builds the child deno invocation", () => {
  assertEquals(
    buildCfLauncherCommand({
      denoPath: "/usr/local/bin/deno",
      labsRoot: "/workspace/labs",
      configPath: "/workspace/labs/deno.json",
      cliEntrypoint: "/workspace/labs/packages/cli/mod.ts",
      cwd: "/workspace/pattern-factory",
      cfArgs: ["check", "pattern.tsx", "--no-run"],
    }),
    {
      command: "/usr/local/bin/deno",
      args: [
        "run",
        "--quiet",
        "--config",
        "/workspace/labs/deno.json",
        "--allow-net",
        "--allow-ffi",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-sys=networkInterfaces,uid",
        "/workspace/labs/packages/cli/mod.ts",
        "check",
        "pattern.tsx",
        "--no-run",
      ],
      cwd: "/workspace/pattern-factory",
      env: {
        CF_CLI_NAME: "cf",
      },
    },
  );
});
