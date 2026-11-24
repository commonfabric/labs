import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { Environment } from "@commonfabric/test-support/records";

import {
  type AgentHarness,
  exportFromAgentConfigs,
  installedHarnesses,
  reexportFromAgentConfigs,
  unexportFromAgentConfigs,
  writeConfig,
} from "./test-records-agent-config.ts";

/** A writer that declines, as it does when the file moved under it. */
const declines = () => Promise.resolve(false);

const VARIABLE = "CF_TEST_RECORDS_KEY_FILE";
const KEY = "/h/.config/commonfabric/test-records-key.json";

describe("test-records-agent-config", () => {
  let home: string;
  let harnesses: readonly AgentHarness[];
  let env: Environment;
  let config: string;

  beforeEach(async () => {
    home = await Deno.makeTempDir({ prefix: "test-records-agent-" });
    harnesses = [{
      name: "Test Harness",
      home: (root) => join(root, ".harness"),
      config: (root) => join(root, ".harness", "settings.json"),
    }];
    env = (name) => name === "HOME" ? home : undefined;
    config = join(home, ".harness", "settings.json");
  });

  afterEach(async () => {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  });

  /** A harness whose directory is there, as an installed one's is. */
  async function install(): Promise<void> {
    await Deno.mkdir(join(home, ".harness"), { recursive: true });
  }

  describe("installedHarnesses()", () => {
    it("returns the harnesses whose directory is there", async () => {
      await install();
      expect(await installedHarnesses(env, harnesses)).toEqual([
        { harness: harnesses[0]!, config },
      ]);
    });

    it("returns nothing for a harness that is not installed", async () => {
      expect(await installedHarnesses(env, harnesses)).toEqual([]);
      expect(await installedHarnesses(() => undefined, harnesses)).toEqual([]);
    });
  });

  describe("exportFromAgentConfigs()", () => {
    it("writes the variable into a configuration that has none", async () => {
      await install();
      await Deno.writeTextFile(config, '{\n  "theme": "auto"\n}\n');

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates).toEqual([
        { harness: "Test Harness", path: config, outcome: "added" },
      ]);
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        theme: "auto",
        env: { [VARIABLE]: KEY },
      });
    });

    it("keeps everything else in the env block", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { DEBUG: "true" } }),
      );

      await exportFromAgentConfigs(VARIABLE, KEY, env, harnesses);

      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        env: { DEBUG: "true", [VARIABLE]: KEY },
      });
    });

    it("creates the configuration when the harness has none yet", async () => {
      await install();

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates[0]?.outcome).toBe("added");
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        env: { [VARIABLE]: KEY },
      });
    });

    it("reports a value already there and writes nothing", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { [VARIABLE]: KEY } }),
      );
      const before = await Deno.readTextFile(config);

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates[0]?.outcome).toBe("present");
      expect(await Deno.readTextFile(config)).toBe(before);
    });

    it("reports another value as a conflict and writes nothing", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { [VARIABLE]: "/elsewhere.json" } }),
      );

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates).toEqual([{
        harness: "Test Harness",
        path: config,
        outcome: "conflict",
        existing: "/elsewhere.json",
      }]);
    });

    it("writes into a configuration file that is empty", async () => {
      await install();
      await Deno.writeTextFile(config, "");

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates[0]?.outcome).toBe("added");
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        env: { [VARIABLE]: KEY },
      });
    });

    it("leaves no temporary file beside the one it wrote", async () => {
      await install();

      await exportFromAgentConfigs(VARIABLE, KEY, env, harnesses);

      const names: string[] = [];
      for await (const entry of Deno.readDir(join(home, ".harness"))) {
        names.push(entry.name);
      }
      expect(names).toEqual(["settings.json"]);
    });

    it("refuses a configuration that does not parse", async () => {
      await install();
      await Deno.writeTextFile(config, "{ not json");

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates[0]?.outcome).toBe("unreadable");
      // The file a harness reads is left exactly as it was.
      expect(await Deno.readTextFile(config)).toBe("{ not json");
    });

    it("reports a value of any other type as a conflict", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { [VARIABLE]: null } }),
      );

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates).toEqual([{
        harness: "Test Harness",
        path: config,
        outcome: "conflict",
        existing: "null",
      }]);
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        env: { [VARIABLE]: null },
      });
    });

    it("keeps the permissions the configuration already had", async () => {
      await install();
      await Deno.writeTextFile(config, JSON.stringify({ theme: "auto" }));
      await Deno.chmod(config, 0o600);

      await exportFromAgentConfigs(VARIABLE, KEY, env, harnesses);

      expect((await Deno.stat(config)).mode! & 0o777).toBe(0o600);
    });

    it("stands down when the configuration changed under it", async () => {
      await install();
      await Deno.writeTextFile(config, JSON.stringify({ theme: "dark" }));

      // The text the configuration was read from no longer describes the
      // file, which is what a harness writing its own settings looks
      // like from here.
      const wrote = await writeConfig(config, { theme: "auto" }, "{}");

      expect(wrote).toBe(false);
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        theme: "dark",
      });
    });

    it("reports a write that stood down as changed", async () => {
      await install();
      await Deno.writeTextFile(config, JSON.stringify({ theme: "auto" }));

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
        declines,
      );

      expect(updates[0]?.outcome).toBe("changed");
    });

    it("refuses a configuration that cannot be read at all", async () => {
      await install();
      await Deno.mkdir(config);

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates[0]?.outcome).toBe("unreadable");
    });

    it("refuses a configuration whose env is not a block", async () => {
      await install();
      await Deno.writeTextFile(config, JSON.stringify({ env: "nonsense" }));

      const updates = await exportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(updates[0]?.outcome).toBe("unreadable");
    });

    it("leaves a harness that is not installed alone", async () => {
      expect(await exportFromAgentConfigs(VARIABLE, KEY, env, harnesses))
        .toEqual([]);
      await expect(Deno.stat(config)).rejects.toThrow();
    });
  });

  describe("unexportFromAgentConfigs()", () => {
    it("takes the variable out and the empty env block with it", async () => {
      await install();
      await Deno.writeTextFile(config, JSON.stringify({ theme: "auto" }));
      await exportFromAgentConfigs(VARIABLE, KEY, env, harnesses);

      const removals = await unexportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(removals).toEqual([
        { harness: "Test Harness", path: config, outcome: "removed" },
      ]);
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        theme: "auto",
      });
    });

    it("keeps the rest of the env block", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { DEBUG: "true", [VARIABLE]: KEY } }),
      );

      await unexportFromAgentConfigs(VARIABLE, KEY, env, harnesses);

      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        env: { DEBUG: "true" },
      });
    });

    it("keeps a value this tool did not write", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { [VARIABLE]: "/elsewhere.json" } }),
      );

      const removals = await unexportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(removals).toEqual([{
        harness: "Test Harness",
        path: config,
        outcome: "kept",
        existing: "/elsewhere.json",
      }]);
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        env: { [VARIABLE]: "/elsewhere.json" },
      });
    });

    it("reports a removal that stood down as changed", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { [VARIABLE]: KEY } }),
      );

      const removals = await unexportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
        declines,
      );

      expect(removals[0]?.outcome).toBe("changed");
    });

    it("returns nothing for a configuration that never carried it", async () => {
      await install();
      await Deno.writeTextFile(config, JSON.stringify({ theme: "auto" }));

      expect(await unexportFromAgentConfigs(VARIABLE, KEY, env, harnesses))
        .toEqual([]);
    });

    it("reports a configuration that does not parse", async () => {
      await install();
      await Deno.writeTextFile(config, "{ not json");

      const removals = await unexportFromAgentConfigs(
        VARIABLE,
        KEY,
        env,
        harnesses,
      );

      expect(removals[0]?.outcome).toBe("unreadable");
      expect(await Deno.readTextFile(config)).toBe("{ not json");
    });

    it("returns nothing when there is no configuration at all", async () => {
      await install();
      expect(await unexportFromAgentConfigs(VARIABLE, KEY, env, harnesses))
        .toEqual([]);
    });
  });

  describe("reexportFromAgentConfigs()", () => {
    const MOVED = "/h/.config/commonfabric/moved.json";

    it("points a configuration carrying the old value at the new", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ theme: "auto", env: { [VARIABLE]: KEY, A: "b" } }),
      );

      expect(
        await reexportFromAgentConfigs(VARIABLE, KEY, MOVED, env, harnesses),
      ).toEqual([{ harness: "Test Harness", path: config, outcome: "added" }]);
      expect(JSON.parse(await Deno.readTextFile(config))).toEqual({
        theme: "auto",
        env: { [VARIABLE]: MOVED, A: "b" },
      });
    });

    it("leaves any other value alone and reports a file it cannot read", async () => {
      await install();
      const text = JSON.stringify({ env: { [VARIABLE]: "/elsewhere.json" } });
      await Deno.writeTextFile(config, text);
      expect(
        await reexportFromAgentConfigs(VARIABLE, KEY, MOVED, env, harnesses),
      ).toEqual([]);
      expect(await Deno.readTextFile(config)).toBe(text);

      await Deno.writeTextFile(config, "{ not json");
      expect(
        await reexportFromAgentConfigs(VARIABLE, KEY, MOVED, env, harnesses),
      ).toEqual([
        { harness: "Test Harness", path: config, outcome: "unreadable" },
      ]);
      expect(await Deno.readTextFile(config)).toBe("{ not json");

      await Deno.writeTextFile(config, JSON.stringify({ env: [] }));
      expect(
        await reexportFromAgentConfigs(VARIABLE, KEY, MOVED, env, harnesses),
      ).toEqual([
        { harness: "Test Harness", path: config, outcome: "unreadable" },
      ]);
    });

    it("reports an update that stood down as changed", async () => {
      await install();
      await Deno.writeTextFile(
        config,
        JSON.stringify({ env: { [VARIABLE]: KEY } }),
      );

      expect(
        await reexportFromAgentConfigs(
          VARIABLE,
          KEY,
          MOVED,
          env,
          harnesses,
          declines,
        ),
      ).toEqual([
        { harness: "Test Harness", path: config, outcome: "changed" },
      ]);
    });
  });
});
