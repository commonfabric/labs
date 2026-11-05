import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveSandboxRuntimeSelection } from "../src/sandbox/runtime-selection.ts";

const never = (): Promise<boolean> => Promise.resolve(false);
const always = (): Promise<boolean> => Promise.resolve(true);

// FreeBSD, which has no default, so that no case here turns on the machine the
// suite runs on; and an entrypoint that takes the selection flags.
const FREEBSD = { platform: "freebsd", flags: true } as const;
const NAMED_RUNSC = { runtime: "runsc", source: "environment" } as const;

Deno.test("a run that names `docker`, or no runtime where there is no default, is refused before any file is looked at", async () => {
  // Loom's dispatch lanes export the network mode and the runsc companions on
  // every run; none of them makes a runtime of a name that is not one.
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
  await assertRejects(
    () =>
      resolveSandboxRuntimeSelection(env, {}, {
        ...FREEBSD,
        pathExists: counting,
      }),
    Error,
    "No sandbox runtime is named, and `freebsd` has no default",
  );
  await assertRejects(
    () =>
      resolveSandboxRuntimeSelection(
        { ...env, CF_HARNESS_SANDBOX_RUNTIME: "docker" },
        {},
        { ...FREEBSD, pathExists: counting },
      ),
    Error,
    "`CF_HARNESS_SANDBOX_RUNTIME=docker` names the Docker driver, which " +
      "this cf-harness no longer has",
  );
  await assertRejects(
    () =>
      resolveSandboxRuntimeSelection(env, { sandboxRuntime: "docker" }, {
        ...FREEBSD,
        pathExists: counting,
      }),
    Error,
    "`--sandbox-runtime docker` names the Docker driver",
  );
  // And it touches no file system to decide that.
  assertEquals(stats, 0);
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
    { ...FREEBSD, pathExists: always },
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
      { ...FREEBSD, pathExists: always },
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
    { ...FREEBSD, pathExists: always },
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
    assertEquals(await resolveSandboxRuntimeSelection(env, {}, FREEBSD), {
      sandboxRuntimeKind: "runsc",
      sandboxRuntimeChoice: NAMED_RUNSC,
    });
    // A directory at that path is not a policy.
    await Deno.mkdir(policy, { recursive: true });
    assertEquals(
      await resolveSandboxRuntimeSelection(env, {}, {
        ...FREEBSD,
        homeDir: home,
      }),
      { sandboxRuntimeKind: "runsc", sandboxRuntimeChoice: NAMED_RUNSC },
    );
    await Deno.remove(policy);
    await Deno.writeTextFile(policy, "{}");
    assertEquals(
      await resolveSandboxRuntimeSelection(env, {}, {
        ...FREEBSD,
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
      { ...FREEBSD, cwd: "/work/dir", pathExists: never },
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
        FREEBSD,
      ),
    Error,
    "CF_HARNESS_DOCKER_NETWORK_MODE must be one of none, bridge, or host",
  );
});
