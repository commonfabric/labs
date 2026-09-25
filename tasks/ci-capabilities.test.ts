import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { BUILD_HOST_VARIABLES } from "./build-binaries.ts";
import {
  BINARY_CACHE_DIR,
  CACHE_DIR,
  cachedBinaries,
  CAPABILITIES,
  type Capability,
  type CapabilityId,
  COMPILE_CACHE_FILE,
  type ExecOptions,
  openCapabilities,
  pidOfBackgroundLaunch,
  resolveCapabilities,
  takeGithubToken,
} from "./ci-capabilities.ts";
import {
  serverExecutionCiLane,
  type ServerExecutionCiRole,
} from "./server-execution-ci.ts";

/** A capability exporting `env`, built on `needs`. */
function stub(
  id: CapabilityId,
  env: Record<string, string>,
  needs?: readonly CapabilityId[],
): Capability {
  return {
    id,
    description: `a capability exporting ${Object.keys(env).join(", ")}`,
    ...(needs === undefined ? {} : { needs }),
    open: () => Promise.resolve({ env, close: () => Promise.resolve() }),
  };
}

/**
 * Runs `body` with each named variable set as given, `undefined` meaning
 * unset, and puts back what the environment held before. Every name a
 * case depends on is named here rather than left to the ambient
 * environment, since a token a developer exported is exactly what these
 * read. The names are written out rather than taken from the source,
 * because what a lane is handed a token in has to be what a workflow
 * writes.
 */
function withEnv(
  values: Record<string, string | undefined>,
  body: () => void,
): void {
  const before = new Map(
    Object.keys(values).map((name) => [name, Deno.env.get(name)]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

describe("ci capabilities", () => {
  it("opens what a capability is built on before the capability", () => {
    const order = resolveCapabilities(["toolshed"]);
    expect(order.indexOf("deno")).toBeLessThan(order.indexOf("toolshed"));
  });

  it("opens each capability once however many suites asked for it", () => {
    const order = resolveCapabilities(["toolshed", "cf", "toolshed", "deno"]);
    expect(order.length).toBe(new Set(order).size);
    expect(order.filter((id) => id === "deno").length).toBe(1);
  });

  it("comes to the same order whatever order the requests arrived in", () => {
    const one = resolveCapabilities(["browser", "cf", "jq", "toolshed"]);
    const other = resolveCapabilities(["toolshed", "jq", "cf", "browser"]);
    expect(one).toEqual(other);
  });

  it("refuses a capability nothing declares", () => {
    expect(() => resolveCapabilities(["invented" as CapabilityId])).toThrow(
      "no such capability",
    );
  });

  it("declares only capabilities that are built on declared ones", () => {
    for (const capability of CAPABILITIES.values()) {
      for (const need of capability.needs ?? []) {
        expect(
          [capability.id, CAPABILITIES.has(need)],
        ).toEqual([capability.id, true]);
      }
    }
  });

  it("holds one capability for every name a suite may ask for", () => {
    // The registry is keyed by each entry's own identifier, so comparing
    // the two says nothing. What can go wrong is a name added to the
    // type and not to the registry, or the other way round, and a suite
    // asking for one that is not there fails the lane before it starts.
    expect([...CAPABILITIES.keys()].toSorted()).toEqual([
      "browser",
      "cf",
      "compile-cache",
      "deno",
      "fuse",
      "git-history",
      "github-api",
      "jq",
      "local-dev-servers",
      "toolshed",
      "toolshed-baked",
      "toolshed-baked-opposite",
    ]);
  });

  it("hands the token to the suites that asked and to no others", async () => {
    const opened = await openCapabilities(["github-api", "jq"], {
      root: Deno.cwd(),
      dryRun: false,
      workDir: "/nonexistent",
      exec: () => Promise.resolve(""),
      githubToken: "a-token",
    });
    // Under both names, because the two consumers read different ones:
    // `gh` reads `GH_TOKEN`, and `check-action-pins` reads
    // `GITHUB_TOKEN` first.
    expect(opened.envFor(["github-api"])).toEqual({
      GITHUB_TOKEN: "a-token",
      GH_TOKEN: "a-token",
    });
    expect(opened.envFor(["jq"])).toEqual({});
    await opened.close();
  });

  it("exports nothing where the lane was handed no token", async () => {
    const opened = await openCapabilities(["github-api"], {
      root: Deno.cwd(),
      dryRun: false,
      workDir: "/nonexistent",
      exec: () => Promise.resolve(""),
    });
    expect(opened.envFor(["github-api"])).toEqual({});
    await opened.close();
  });

  it("takes the token out of this process under either name", () => {
    // A token under a name this left behind would be inherited by every
    // child of the lane, and `check-action-pins` would pass on it, so
    // nothing downstream would report the hole.
    withEnv({ GITHUB_TOKEN: "a-token", GH_TOKEN: "another-token" }, () => {
      expect(takeGithubToken()).toBe("a-token");
      expect(Deno.env.get("GITHUB_TOKEN")).toBeUndefined();
      expect(Deno.env.get("GH_TOKEN")).toBeUndefined();
      expect(takeGithubToken()).toBeUndefined();
    });
  });

  it("takes a token handed under the second name alone", () => {
    withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: "a-token" }, () => {
      expect(takeGithubToken()).toBe("a-token");
      expect(Deno.env.get("GH_TOKEN")).toBeUndefined();
    });
  });

  it("reads an empty token as no token", () => {
    // An unset Actions variable interpolates as an empty string.
    withEnv({ GITHUB_TOKEN: "", GH_TOKEN: "" }, () => {
      expect(takeGithubToken()).toBeUndefined();
      expect(Deno.env.get("GITHUB_TOKEN")).toBeUndefined();
      expect(Deno.env.get("GH_TOKEN")).toBeUndefined();
    });
  });

  it("exports the environment a dry run's batches would see", async () => {
    const opened = await openCapabilities(["toolshed"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    });
    expect(opened.envFor(["toolshed"]).API_URL).toBe("http://localhost:8000");
    expect(opened.timings.map((timing) => timing.capability)).toEqual([
      "deno",
      "toolshed",
    ]);
    await opened.close();
  });

  it("closes what it opened when a later capability fails", async () => {
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    registry.set("cf", {
      id: "cf",
      description: "a capability that closes when told",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => {
            closed.push("cf");
            return Promise.resolve();
          },
        }),
    });
    registry.set("jq", {
      id: "jq",
      description: "a capability that cannot open",
      // Ordered after `cf` by the alphabetical walk, so `cf` is already
      // open when this one fails.
      open: () => Promise.reject(new Error("no jq here")),
    });
    await expect(
      openCapabilities(["cf", "jq"], {
        root: Deno.cwd(),
        dryRun: true,
        workDir: "/nonexistent",
      }, registry),
    ).rejects.toThrow("no jq here");
    expect(closed).toEqual(["cf"]);
  });

  it("keeps what it caches where the workflow's one cache step looks", () => {
    // The lane's own working directory is made fresh every run, so
    // anything kept there would be rebuilt every time however well the
    // cache step worked. The workflow carries one fixed step over one
    // directory, so everything a lane wants restored sits inside it.
    expect(CACHE_DIR).toBe(".ci-cache");
    for (const kept of [BINARY_CACHE_DIR, COMPILE_CACHE_FILE]) {
      expect([kept, kept.startsWith(`${CACHE_DIR}/`)]).toEqual([kept, true]);
    }
  });

  it("says what every capability would export without opening one", async () => {
    // A dry run is the plan a lane prints when it has no machine to run
    // on, so every capability has to answer without touching anything.
    const opened = await openCapabilities([...CAPABILITIES.keys()], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    });
    expect(opened.timings.length).toBe(CAPABILITIES.size);
    // The two servers export the addresses their suites reach them at,
    // and the command line exports the path it is found on.
    const every = opened.envFor([...CAPABILITIES.keys()]);
    expect(every.API_URL).toBeDefined();
    expect(every.TOOLSHED_PORT).toBeDefined();
    expect(every.CF_LABS_ROOT).toBe(Deno.cwd());
    expect(every.PATH?.startsWith(`${Deno.cwd()}/bin`)).toBe(true);
    expect(every.CF_COMPILE_CACHE_FILE).toBe(
      `${Deno.cwd()}/${COMPILE_CACHE_FILE}`,
    );
    await opened.close();
  });

  it("gives a suite the addresses its own server is listening on", async () => {
    // Both Toolshed capabilities export the address theirs is listening
    // on, and a lane may hold the default and opposite server-execution
    // arms at once.
    const registry = new Map<CapabilityId, Capability>([
      ["toolshed", stub("toolshed", { API_URL: "http://default.test" })],
      [
        "toolshed-baked-opposite",
        stub("toolshed-baked-opposite", { API_URL: "http://opposite.test" }),
      ],
    ]);
    const opened = await openCapabilities(
      ["toolshed", "toolshed-baked-opposite"],
      { root: Deno.cwd(), dryRun: true, workDir: "/nonexistent" },
      registry,
    );
    try {
      expect(opened.envFor(["toolshed"]).API_URL).toBe("http://default.test");
      expect(opened.envFor(["toolshed-baked-opposite"]).API_URL)
        .toBe("http://opposite.test");
    } finally {
      await opened.close();
    }
  });

  it("gives a suite what the capabilities under its own export too", async () => {
    // A suite names one capability, and the batch runs with what
    // everything under that one exports as well.
    const registry = new Map<CapabilityId, Capability>([
      ["deno", stub("deno", { UNDERNEATH: "yes" })],
      ["cf", stub("cf", { NAMED: "yes" }, ["deno"])],
    ]);
    const opened = await openCapabilities(["cf"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    }, registry);
    try {
      expect(opened.envFor(["cf"])).toEqual({
        UNDERNEATH: "yes",
        NAMED: "yes",
      });
    } finally {
      await opened.close();
    }
  });

  it("closes what it opened, in the reverse of the opening order", async () => {
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    for (const id of ["deno", "jq", "cf"] as const) {
      registry.set(id, {
        // The real one's dependencies are kept, because what is being
        // checked is the order those put the openings in.
        ...CAPABILITIES.get(id)!,
        description: "a capability that says when it closes",
        open: () =>
          Promise.resolve({
            env: {},
            close: () => {
              closed.push(id);
              return Promise.resolve();
            },
          }),
      });
    }
    const opened = await openCapabilities(["cf", "jq"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    }, registry);
    await opened.close();
    // Opened deno, cf, jq; closed in reverse.
    expect(closed).toEqual(["jq", "cf", "deno"]);
  });

  it("keeps going when one capability cannot be closed", async () => {
    // A capability that throws on the way out must not strand the ones
    // after it: the lane is finishing either way.
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    registry.set("deno", {
      ...CAPABILITIES.get("deno")!,
      description: "a capability that closes when told",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => {
            closed.push("deno");
            return Promise.resolve();
          },
        }),
    });
    registry.set("jq", {
      ...CAPABILITIES.get("jq")!,
      // Built on the one above, so that one is still open behind it when
      // this one refuses to close.
      needs: ["deno"],
      description: "a capability that cannot be closed",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => Promise.reject(new Error("stuck")),
        }),
    });
    const opened = await openCapabilities(["jq"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    }, registry);
    await opened.close();
    expect(closed).toEqual(["deno"]);
  });

  it("runs a real command, and carries its output into the failure", async () => {
    // The default runner, which is what a lane uses. Setup that
    // half-worked is worse than setup that did not, so a command that
    // fails throws with what it said rather than being read as success.
    const repo = await Deno.makeTempDir({ prefix: "capability-git-" });
    await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
    const opened = await openCapabilities(["git-history"], {
      root: repo,
      dryRun: false,
      workDir: repo,
    });
    await opened.close();

    // The same runner against a repository that is not one.
    const empty = await Deno.makeTempDir({ prefix: "capability-nogit-" });
    await expect(
      openCapabilities(["git-history"], {
        root: empty,
        dryRun: false,
        workDir: empty,
      }),
    ).rejects.toThrow("git rev-parse");
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(empty, { recursive: true });
  });

  it("reads the process a background launch detached", () => {
    expect(
      pidOfBackgroundLaunch(
        "Toolshed is listening; the server is running in the background " +
          "(pid 4213). Logs: /tmp/toolshed.log",
      ),
    ).toBe(4213);
    expect(pidOfBackgroundLaunch("no process here")).toBeUndefined();
  });
});

describe("opening a capability on a machine that answers", () => {
  /** What a capability asked the machine, and what it was told. */
  function machine(answers: Record<string, string> = {}) {
    const asked: string[] = [];
    const given: Array<ExecOptions | undefined> = [];
    const exec = (
      command: string,
      args: readonly string[],
      options?: ExecOptions,
    ): Promise<string> => {
      const line = [command, ...args].join(" ");
      asked.push(line);
      given.push(options);
      for (const [match, answer] of Object.entries(answers)) {
        if (line.includes(match)) {
          return answer.startsWith("!")
            ? Promise.reject(new Error(answer.slice(1)))
            : Promise.resolve(answer);
        }
      }
      return Promise.resolve("");
    };
    return { asked, given, exec };
  }

  /** The message `work` rejects with; fails the test if it resolves. */
  async function rejectionMessage(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected the call to throw, and it returned instead.");
  }

  /** What the machine was given for the call naming `match`. */
  function optionsOf(m: ReturnType<typeof machine>, match: string) {
    return m.given[m.asked.findIndex((line) => line.includes(match))];
  }

  /**
   * The environment the command naming `match` would see: what it was given,
   * on top of this process's environment unless it was told to inherit none.
   */
  function envOf(m: ReturnType<typeof machine>, match: string) {
    const options = optionsOf(m, match);
    return options?.clearEnv
      ? options.env
      : { ...Deno.env.toObject(), ...options?.env };
  }

  /** A server answering what one on `role` answers. */
  function serving(role: ServerExecutionCiRole): typeof fetch {
    const lane = serverExecutionCiLane(role);
    const bodies: Record<string, unknown> = {
      "/api/meta": {
        experimental: { serverExecution: lane.enabled },
        shellServerExecutionDefine: lane.experimentalValue ?? null,
      },
      "/api/health/stats": { servingLoop: lane.enabled ? 1 : null },
    };
    return (input) =>
      Promise.resolve(
        Response.json(bodies[new URL(String(input)).pathname] ?? {}),
      );
  }

  async function open(
    id: CapabilityId,
    m: ReturnType<typeof machine>,
    role: ServerExecutionCiRole = "default",
  ) {
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      const opened = await openCapabilities([id], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving(role),
      }, CAPABILITIES);
      await opened.close();
      return { opened, root };
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }

  it("names the log its server writes, so a failed lane can print it", async () => {
    const m = machine({ toolshed: "listening (pid 999999). Logs: x\n" });
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      const opened = await openCapabilities(["toolshed"], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving("default"),
      }, CAPABILITIES);
      await opened.close();

      // The one the launch was told to write, and the one the lane would
      // have nothing of once its work directory goes.
      const told = m.asked.find((line) => line.includes("--log-file="))!;
      const wanted = /--log-file=(\S+)/.exec(told)![1];
      expect(opened.logs).toEqual([{ capability: "toolshed", path: wanted }]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  });

  it("carries the server's log in a posture failure, which opens nothing", async () => {
    // The capability never opens, so nothing downstream is holding the
    // path: the log leaves in the throw or it goes with the work directory
    // unread. The probe is what fails, the server having started.
    const m = machine({ toolshed: "listening (pid 999999). Logs: x\n" });
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      const refused = await rejectionMessage(
        openCapabilities(["toolshed"], {
          root,
          dryRun: false,
          workDir: root,
          exec: async (command, args, options) => {
            const line = [command, ...args].join(" ");
            const wrote = /--log-file=(\S+)/.exec(line);
            // What the server would have written before the posture went
            // wrong, at the path the launch was told to write it to.
            if (wrote) {
              await Deno.writeTextFile(wrote[1], "a line the log holds\n");
            }
            return await m.exec(command, args, options);
          },
          // A server on the arm this lane did not ask for.
          fetch: serving("opposite"),
        }, CAPABILITIES),
      );
      expect(refused).toContain("toolshed log:");
      expect(refused).toContain("a line the log holds");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  });

  it("installs the FUSE packages only where one is missing", async () => {
    // Every probe answering means the packages are already there, and
    // an install that runs anyway costs the lane fifteen seconds it did
    // not need to spend.
    const present = machine();
    await open("fuse", present);
    expect(present.asked.some((line) => line.includes("apt-get install")))
      .toBe(false);
    expect(present.asked.some((line) => line.includes("chmod 666 /dev/fuse")))
      .toBe(true);

    // The runner image carries the FUSE runtime and not its development
    // files, so `fusermount3` answers while the library the mount opens
    // is absent. What the probe asks has to be the library.
    const library = machine({
      "pkg-config --exists fuse3": "!no such package",
    });
    await open("fuse", library);
    expect(library.asked.some((line) => line.includes("libfuse3-dev")))
      .toBe(true);

    // The unmount runs `fusermount3`, which the development files do not
    // carry, so the runtime package gets a probe of its own.
    const runtime = machine({ "command -v fusermount3": "!not found" });
    await open("fuse", runtime);
    expect(runtime.asked.some((line) => line.includes("apt-get install")))
      .toBe(true);

    const missing = machine({ "command -v gcc": "!not found" });
    await open("fuse", missing);
    expect(missing.asked.some((line) => line.includes("apt-get update")))
      .toBe(true);
    expect(
      missing.asked.some((line) => line.includes("libfuse3-dev")),
    ).toBe(true);
  });

  it("unshallows a checkout only where it is shallow", async () => {
    const shallow = machine({ "is-shallow-repository": "true\n" });
    await open("git-history", shallow);
    expect(shallow.asked.some((line) => line.includes("fetch --unshallow")))
      .toBe(true);

    const whole = machine({ "is-shallow-repository": "false\n" });
    await open("git-history", whole);
    expect(whole.asked.some((line) => line.includes("fetch --unshallow")))
      .toBe(false);
  });

  it("relaxes the namespace only on an image that restricts it", async () => {
    // A capability that insisted on the knob would fail every lane on a
    // machine that never restricted the namespace in the first place,
    // and one that never looked would leave the browser unable to start
    // where it did.
    const restricted = machine();
    await open("browser", restricted);
    expect(restricted.asked.some((line) => line.includes("sudo tee")))
      .toBe(true);

    const unrestricted = machine({
      "test -e /proc/sys/kernel/apparmor": "!no such file",
    });
    await open("browser", unrestricted);
    expect(unrestricted.asked.some((line) => line.includes("sudo tee")))
      .toBe(false);
  });

  it("starts a server on a port of its own and kills what it started", async () => {
    const m = machine({ "index.ts": "listening (pid 999999). Logs: x\n" });
    const { opened } = await open("toolshed", m);
    const served = opened.envFor(["toolshed"]);
    const port = Number(served.TOOLSHED_PORT);
    expect(Number.isInteger(port) && port > 0).toBe(true);
    // No trailing slash: the shell suites compose a path onto this, and
    // the Deno suites add a slash of their own when they need one.
    expect(served.API_URL).toBe(`http://localhost:${port}`);
    expect(m.asked.some((line) => line.includes(`--port=${port}`))).toBe(true);
    expect(m.asked.some((line) => line.includes("--background"))).toBe(true);
    // Closing is what `open` already did; killing a process this test
    // invented would be worse than not checking, and what matters is
    // that it does not throw.
  });

  it("holds a server it started to the arm it started it for", async () => {
    // A server on the other arm answers every request the suites make
    // and passes, so the run reports that the arm it named works when
    // nothing exercised it.
    const answers = { "index.ts": "listening (pid 999999). Logs: x\n" };
    await open("toolshed", machine(answers), "default");

    const wrong = machine(answers);
    await expect(open("toolshed", wrong, "opposite")).rejects.toThrow(
      "default lane publishes serverExecution",
    );
  });

  it("gives a server the define its own role names", async () => {
    // A lane holding both arms carries one value in its ambient
    // environment, and the shell bakes in whatever the build saw. The
    // define a server builds and runs under is the one its role names:
    // the value for the opposite arm, and none at all for the default.
    const named = serverExecutionCiLane("opposite").experimentalValue;
    const before = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
    Deno.env.set(
      "EXPERIMENTAL_SERVER_EXECUTION",
      named === "true" ? "false" : "true",
    );
    try {
      const source = machine({
        "index.ts": "listening (pid 999999). Logs: x\n",
      });
      await open("toolshed", source);
      expect(envOf(source, "index.ts")?.EXPERIMENTAL_SERVER_EXECUTION)
        .toBeUndefined();

      const baked = await openBaked(
        "toolshed-baked",
        "toolshed-baked-default",
        "default",
      );
      expect(envOf(baked, "build-binaries")?.EXPERIMENTAL_SERVER_EXECUTION)
        .toBeUndefined();
      expect(
        envOf(baked, "toolshed-baked-default")?.EXPERIMENTAL_SERVER_EXECUTION,
      ).toBeUndefined();

      const opposite = await openBaked(
        "toolshed-baked-opposite",
        "toolshed-baked-opposite",
        "opposite",
      );
      expect(envOf(opposite, "build-binaries")?.EXPERIMENTAL_SERVER_EXECUTION)
        .toBe(named);
      expect(
        envOf(opposite, "toolshed-baked-opposite")
          ?.EXPERIMENTAL_SERVER_EXECUTION,
      ).toBe(named);
    } finally {
      if (before === undefined) {
        Deno.env.delete("EXPERIMENTAL_SERVER_EXECUTION");
      } else {
        Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", before);
      }
    }
  });

  it("builds a cached binary from the host variables and the ones it names", async () => {
    // The shell bakes in what its build reads, so a variable the lane's own
    // environment carries would otherwise reach a binary the cache key does
    // not describe: a commit that is wrong at every later commit the binary
    // serves, or a flag no posture check looks at.
    const stray = {
      COMMIT_SHA: "0123abc",
      EXPERIMENTAL_MODERN_CELL_REP: "true",
    };
    const before = new Map(
      Object.keys(stray).map((name) => [name, Deno.env.get(name)]),
    );
    for (const [name, value] of Object.entries(stray)) {
      Deno.env.set(name, value);
    }
    try {
      const m = await openBaked(
        "toolshed-baked-opposite",
        "toolshed-baked-opposite",
        "opposite",
      );
      const host: Record<string, string> = {};
      for (const name of BUILD_HOST_VARIABLES) {
        const value = Deno.env.get(name);
        if (value !== undefined) host[name] = value;
      }
      expect(host.PATH).toBeDefined();
      const options = optionsOf(m, "build-binaries");
      expect(options?.clearEnv).toBe(true);
      expect(options?.env).toEqual({
        ...host,
        ...cachedBinaries()["toolshed-baked-opposite"].bakes,
      });
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  });

  it("refuses a launch that names no process to kill later", async () => {
    // A server nobody can kill outlives the lane and holds its port
    // against the next one.
    const m = machine({ "index.ts": "started somehow\n" });
    await expect(open("toolshed", m)).rejects.toThrow("named no process");
  });

  /** Opens a baked capability against a root that has no binary yet. */
  async function openBaked(
    id: CapabilityId,
    binaryName: string,
    role: ServerExecutionCiRole,
  ) {
    const m = machine({ [binaryName]: "listening (pid 999999). Logs: x\n" });
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      // What a build leaves behind, so the copy into the cache has
      // something to copy.
      await Deno.mkdir(`${root}/dist`, { recursive: true });
      await Deno.writeTextFile(`${root}/dist/toolshed`, "");
      const opened = await openCapabilities([id], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving(role),
      }, CAPABILITIES);
      await opened.close();
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
    return m;
  }

  it("builds the server-execution binary only when none was restored", async () => {
    const binaryName = "toolshed-baked-opposite";
    const answers = {
      [binaryName]: "listening (pid 999999). Logs: x\n",
    };
    const openOpposite = async (restored: boolean) => {
      const m = machine(answers);
      const root = await Deno.makeTempDir({ prefix: "capability-" });
      // What a build leaves behind, so the copy into the cache has
      // something to copy.
      await Deno.mkdir(`${root}/dist`, { recursive: true });
      await Deno.writeTextFile(`${root}/dist/toolshed`, "");
      if (restored) {
        await Deno.mkdir(`${root}/${BINARY_CACHE_DIR}`, { recursive: true });
        await Deno.writeTextFile(
          `${root}/${BINARY_CACHE_DIR}/${binaryName}`,
          "",
        );
      }
      const opened = await openCapabilities(["toolshed-baked-opposite"], {
        root,
        dryRun: false,
        workDir: root,
        exec: m.exec,
        fetch: serving("opposite"),
      }, CAPABILITIES);
      await opened.close();
      await Deno.remove(root, { recursive: true });
      return m.asked.some((line) => line.includes("build-binaries toolshed"));
    };
    // A cache miss builds; a restore does not, which is the difference
    // between forty seconds and seventeen on every lane that needs it.
    expect(await openOpposite(false)).toBe(true);
    expect(await openOpposite(true)).toBe(false);
  });

  it("reports a cached binary it cannot look for rather than building one", async () => {
    // Only a binary that is not there is a cache miss. A cache directory
    // that is a file is a broken checkout, and building over it would hide
    // that.
    const m = machine();
    const root = await Deno.makeTempDir({ prefix: "capability-" });
    try {
      await Deno.writeTextFile(`${root}/${CACHE_DIR}`, "");
      await expect(
        openCapabilities(["toolshed-baked-opposite"], {
          root,
          dryRun: false,
          workDir: root,
          exec: m.exec,
        }, CAPABILITIES),
      ).rejects.toThrow(Deno.errors.NotADirectory);
      expect(m.asked.some((line) => line.includes("build-binaries")))
        .toBe(false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("the binaries a lane caches", () => {
  it("bakes no commit into any of them", () => {
    // A cached binary serves every commit whose sources match, so a commit
    // baked into it would be wrong at all but one of them.
    for (const [on, off] of [[true, false], [false, true]]) {
      for (const { bakes } of Object.values(cachedBinaries(on))) {
        expect(bakes.COMMIT_SHA).toBeUndefined();
      }
      expect(cachedBinaries(on)["toolshed-baked-opposite"].bakes)
        .toEqual({ EXPERIMENTAL_SERVER_EXECUTION: `${off}` });
    }
  });
});

describe("a registry that cannot be opened in any order", () => {
  it("refuses a capability built on itself", () => {
    // A cycle has no order to open in, and the walk would otherwise
    // recur until the stack ran out rather than saying what is wrong.
    const registry = new Map(CAPABILITIES);
    registry.set("jq", {
      ...CAPABILITIES.get("jq")!,
      needs: ["cf"],
    });
    registry.set("cf", {
      ...CAPABILITIES.get("cf")!,
      needs: ["jq"],
    });
    expect(() => resolveCapabilities(["jq"], registry)).toThrow(
      "built on itself",
    );
  });
});

describe("the compile cache a lane hands the pattern suites", () => {
  it("makes the directory the workflow's cache step restores into", async () => {
    // The compiler is pointed at a file, and it cannot write one into a
    // directory that is not there — so a cache that was never restored
    // has to become an empty one rather than a failure.
    const root = await Deno.makeTempDir({ prefix: "compile-cache-" });
    try {
      const opened = await openCapabilities(["compile-cache"], {
        root,
        dryRun: false,
        workDir: root,
      });
      expect(opened.envFor(["compile-cache"]).CF_COMPILE_CACHE_FILE).toBe(
        `${root}/${COMPILE_CACHE_FILE}`,
      );
      expect((await Deno.stat(`${root}/${CACHE_DIR}/compile`)).isDirectory)
        .toBe(true);
      await opened.close();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
