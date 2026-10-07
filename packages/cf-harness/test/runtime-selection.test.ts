import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveSandboxRuntimeSelection } from "../src/sandbox/runtime-selection.ts";

const never = (): Promise<boolean> => Promise.resolve(false);
const always = (): Promise<boolean> => Promise.resolve(true);

// Linux, whose default is Docker, so that no case here turns on the machine
// the suite runs on; and an entrypoint that takes the selection flags.
const LINUX = { platform: "linux", flags: true } as const;
const DEFAULTED_DOCKER = {
  runtime: "docker",
  source: "default",
  platform: "linux",
} as const;
const NAMED_RUNSC = { runtime: "runsc", source: "environment" } as const;

Deno.test("a run that names no runtime, or docker, gets no runsc companions", async () => {
  // The docker path must hand on exactly what it handed on before the runsc
  // runtime existed. Loom's dispatch lanes export the network mode on every
  // run, so a selection that echoed it back would change every docker run.
  const env = {
    HOME: "/home/u",
    CF_HARNESS_SANDBOX_ROOTFS: "/r",
    CF_HARNESS_RUNSC_CFC_POLICY: "/p",
    CF_HARNESS_RUNSC_BINARY: "/b",
    CF_HARNESS_DOCKER_NETWORK_MODE: "none",
  };
  let stats = 0;
  const counting = () => {
    stats += 1;
    return Promise.resolve(true);
  };
  assertEquals(
    await resolveSandboxRuntimeSelection(env, {}, {
      ...LINUX,
      pathExists: counting,
    }),
    { sandboxRuntimeChoice: DEFAULTED_DOCKER },
  );
  assertEquals(
    await resolveSandboxRuntimeSelection(
      { ...env, CF_HARNESS_SANDBOX_RUNTIME: "docker" },
      {},
      { ...LINUX, pathExists: counting },
    ),
    {
      sandboxRuntimeKind: "docker",
      sandboxRuntimeChoice: { runtime: "docker", source: "environment" },
    },
  );
  // And it touches no file system to decide that.
  assertEquals(stats, 0);
  // The docker path validates its own network mode where it builds its
  // sandbox; the selection does not pre-empt it.
  assertEquals(
    await resolveSandboxRuntimeSelection(
      {
        CF_HARNESS_DOCKER_NETWORK_MODE: "bridgeish",
      },
      {},
      LINUX,
    ),
    { sandboxRuntimeChoice: DEFAULTED_DOCKER },
  );
});

Deno.test("explicit rootfs and policy win over the environment and the default", async () => {
  const selected = await resolveSandboxRuntimeSelection(
    {
      HOME: "/home/u",
      CF_HARNESS_SANDBOX_RUNTIME: "docker",
      CF_HARNESS_SANDBOX_ROOTFS: "/env-rootfs",
      CF_HARNESS_RUNSC_CFC_POLICY: "/env-policy",
    },
    {
      sandboxRuntime: "runsc",
      sandboxRootfs: "/flag-rootfs",
      sandboxCfcPolicy: "/flag-policy",
    },
    // The default policy exists too, and still does not win.
    { ...LINUX, pathExists: always },
  );
  assertEquals(selected, {
    sandboxRuntimeKind: "runsc",
    sandboxRootfs: "/flag-rootfs",
    sandboxCfcPolicy: "/flag-policy",
    sandboxRuntimeChoice: { runtime: "runsc", source: "flag" },
  });
  // The environment's policy wins over the default when no flag names one.
  assertEquals(
    (await resolveSandboxRuntimeSelection(
      {
        HOME: "/home/u",
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
        CF_HARNESS_RUNSC_CFC_POLICY: "/env-policy",
      },
      {},
      { ...LINUX, pathExists: always },
    )).sandboxCfcPolicy,
    "/env-policy",
  );
});

Deno.test("an explicit empty policy means none: not the environment's, not the default", async () => {
  const selected = await resolveSandboxRuntimeSelection(
    {
      HOME: "/home/u",
      CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      CF_HARNESS_RUNSC_CFC_POLICY: "/env-policy",
    },
    { sandboxCfcPolicy: "" },
    { ...LINUX, pathExists: always },
  );
  assertEquals(selected, {
    sandboxRuntimeKind: "runsc",
    sandboxRuntimeChoice: NAMED_RUNSC,
  });
});

Deno.test("the default policy is looked up under the host home an entrypoint names", async () => {
  // The Loom local host clears HOME from the environment it hands on. The
  // default policy is a machine-level install, so it is found under the home
  // the host kept aside, and only when it is a regular file.
  const home = await Deno.makeTempDir();
  try {
    const dir = join(home, ".local", "share", "runsc-cfc");
    const policy = join(dir, "cfc-policy.json");
    const env = { CF_HARNESS_SANDBOX_RUNTIME: "runsc", HOME: undefined };
    assertEquals(await resolveSandboxRuntimeSelection(env, {}, LINUX), {
      sandboxRuntimeKind: "runsc",
      sandboxRuntimeChoice: NAMED_RUNSC,
    });
    // A directory at that path is not a policy.
    await Deno.mkdir(policy, { recursive: true });
    assertEquals(
      await resolveSandboxRuntimeSelection(env, {}, {
        ...LINUX,
        homeDir: home,
      }),
      { sandboxRuntimeKind: "runsc", sandboxRuntimeChoice: NAMED_RUNSC },
    );
    await Deno.remove(policy);
    await Deno.writeTextFile(policy, "{}");
    assertEquals(
      await resolveSandboxRuntimeSelection(env, {}, {
        ...LINUX,
        homeDir: home,
      }),
      {
        sandboxRuntimeKind: "runsc",
        sandboxCfcPolicy: policy,
        sandboxRuntimeChoice: NAMED_RUNSC,
      },
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("relative rootfs and policy paths resolve against the working directory", async () => {
  assertEquals(
    await resolveSandboxRuntimeSelection(
      { CF_HARNESS_SANDBOX_RUNTIME: "runsc", CF_HARNESS_SANDBOX_ROOTFS: "img" },
      { sandboxCfcPolicy: "policy.json" },
      { ...LINUX, cwd: "/work/dir", pathExists: never },
    ),
    {
      sandboxRuntimeKind: "runsc",
      sandboxRootfs: "/work/dir/img",
      sandboxCfcPolicy: "/work/dir/policy.json",
      sandboxRuntimeChoice: NAMED_RUNSC,
    },
  );
});

Deno.test("an invalid network mode is refused for the runsc runtime", async () => {
  await assertRejects(
    () =>
      resolveSandboxRuntimeSelection(
        {
          CF_HARNESS_SANDBOX_RUNTIME: "runsc",
          CF_HARNESS_DOCKER_NETWORK_MODE: "bridgeish",
        },
        {},
        LINUX,
      ),
    Error,
    "CF_HARNESS_DOCKER_NETWORK_MODE must be one of none, bridge, or host",
  );
});
