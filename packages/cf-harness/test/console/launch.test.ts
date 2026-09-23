import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE } from "../../src/config.ts";

import {
  type ConsoleLaunchIo,
  type ConsoleLaunchRecords,
  consoleLaunchReport,
  DEPLOYMENT_PATTERN_INDEX_URL,
  DEPLOYMENT_SKILLS_REGISTRY_URL,
  launchConsole,
  LAUNCHER_OWNED_VARIABLES,
  launchFailureMessage,
  prepareConsoleLaunch,
  readDockerRuntimes,
  readOptionalFile,
  readToolshedStoreDir,
  resolveConsoleLaunchPlan,
  WEAVER_PAIRING_PORT,
} from "../../console/launch.ts";
import type { ConsoleObservedLaunchHealth } from "../../console/health.ts";

const PIECES_JSON = JSON.stringify({
  defaults: {
    identity: "/keys/instance.key",
    local_space: "ben-loom-dev-6",
    server_urls: { toolshed: "http://localhost:8001" },
  },
});

const DOCKER_RUNTIMES = {
  "runsc-cfc": {
    path: "/host_mnt/store/runsc-cfc/runsc",
    runtimeArgs: [
      "--cfc",
      "--cfc-result-dir=/host_mnt/store/runsc-cfc/sidecars/results",
      "--cfc-invocation-context-dir=/host_mnt/store/runsc-cfc/sidecars/ctx",
    ],
  },
};

const HANDLES_JSON_PATH = "/loom/instances/loom/sqlite-injection/handles.json";

const RECORDS: ConsoleLaunchRecords = {
  instance: {
    id: "loom",
    piecesJson: PIECES_JSON,
    piecesJsonPath: "/loom/instances/loom/pieces.json",
    toolshedStoreDir:
      "file:///loom/instances/loom/toolshed-store/68239506e79d/",
    handlesJsonPath: HANDLES_JSON_PATH,
  },
  dockerRuntimes: DOCKER_RUNTIMES,
};

const OWNER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const MAIL_REF = `/of:fid1:${"C".repeat(43)}`;

/** A `pieces.json` that also declares one labeled connector source. */
const PIECES_JSON_WITH_CONNECTOR = JSON.stringify({
  defaults: JSON.parse(PIECES_JSON).defaults,
  pieces: [{
    name: "cf-gmail-messages--gmail-work",
    sqlite_sources: [{
      connection_id: "gmail-work",
      tables: {
        messages: {
          properties: {
            subject: {
              type: "string",
              ifc: {
                confidentiality: [OWNER, {
                  type: "https://commonfabric.org/cfc/atom/Resource",
                  class: "email",
                  subject: OWNER,
                }],
              },
            },
          },
        },
      },
    }],
  }],
});

/** The receipt loom's daemon writes for that one injected handle. */
const HANDLES_JSON = JSON.stringify({
  schema_version: 1,
  space: OWNER,
  handles: [{
    connection_id: "gmail-work",
    piece: "cf-gmail-messages--gmail-work",
    handle_ref: MAIL_REF,
  }],
});

const WITH_CONNECTOR: ConsoleLaunchRecords = {
  ...RECORDS,
  instance: {
    ...RECORDS.instance!,
    piecesJson: PIECES_JSON_WITH_CONNECTOR,
    handlesJson: HANDLES_JSON,
  },
};

const OPTIONS = {
  patternIndexUrl: "https://index.example",
  skillsRegistryUrl: "https://skills.example",
};

/** The same fabric, named on the command line rather than read off loom. */
const NAMED_FABRIC = {
  ...OPTIONS,
  identity: "/keys/dev.key",
  space: "cf-harness-dev",
  toolshedUrl: "http://localhost:8000",
  store: "/checkout/packages/toolshed/cache/memory",
};

const NO_INSTANCE: ConsoleLaunchRecords = { dockerRuntimes: DOCKER_RUNTIMES };

const withPieces = (
  defaults: Record<string, unknown>,
): ConsoleLaunchRecords => ({
  ...RECORDS,
  instance: { ...RECORDS.instance!, piecesJson: JSON.stringify({ defaults }) },
});

/** An executable that prints what the test wants the machine to say. */
const fakeBinary = async (body: string): Promise<string> => {
  const path = await Deno.makeTempFile({ prefix: "cf-launch-bin-" });
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
  return path;
};

describe("launch", () => {
  describe("resolveConsoleLaunchPlan()", () => {
    it("retains every grant and refusal with its deciding records and a distinct remedy", () => {
      const pieces = JSON.parse(PIECES_JSON_WITH_CONNECTOR);
      const original = pieces.pieces[0];
      pieces.pieces.push({
        ...original,
        name: "duplicate",
        sqlite_sources: [{
          ...original.sqlite_sources[0],
          connection_id: "gmail-other",
        }],
      }, {
        name: "unlabeled",
        sqlite_sources: [{ connection_id: "no-class", tables: {} }],
      });
      const handles = JSON.parse(HANDLES_JSON);
      const invalidRef = "private-malformed-reference";
      handles.handles.push(
        {
          connection_id: "gmail-other",
          piece: "duplicate",
          handle_ref: MAIL_REF,
        },
        { connection_id: "no-class", piece: "unlabeled", handle_ref: MAIL_REF },
        { connection_id: "broken", piece: "broken", handle_ref: invalidRef },
      );
      const plan = resolveConsoleLaunchPlan({
        ...WITH_CONNECTOR,
        instance: {
          ...WITH_CONNECTOR.instance!,
          piecesJson: JSON.stringify(pieces),
          handlesJson: JSON.stringify(handles),
        },
      }, OPTIONS);
      expect(plan.health.resolved).toBe(plan.resolved);
      expect(
        plan.health.connectors.map(({ label, value, state }) => ({
          label,
          value,
          state,
        })),
      ).toEqual([
        {
          label: "Connector Inventory",
          value: "2 granted; 2 not granted",
          state: "ok",
        },
        {
          label: "gmail-work",
          value: "granted: gmail-work (email)",
          state: "ok",
        },
        {
          label: "gmail-other",
          value: "granted: gmail-other (email)",
          state: "ok",
        },
        { label: "no-class", value: "not granted", state: "degraded" },
        { label: "broken", value: "not granted", state: "unknown" },
      ]);
      expect(
        plan.health.connectors.every((row) =>
          row.detail?.includes(HANDLES_JSON_PATH) &&
          row.detail?.includes(RECORDS.instance!.piecesJsonPath)
        ),
      ).toBe(true);
      expect(plan.health.connectors[2]).toMatchObject({
        source: "loom connector receipt + pieces.json (duplicate)",
        state: "ok",
        value: "granted: gmail-other (email)",
      });
      expect(plan.health.connectors[3]).toMatchObject({
        reason: "its declared table contract carries no CFC class",
        remedy:
          "Declare the per-column ifc.confidentiality Resource class in this connector's sqlite_sources, then restart the console.",
      });
      expect(JSON.stringify(plan.health.connectors)).not.toContain(MAIL_REF);
      expect(plan.health.connectors[4]).toMatchObject({
        state: "unknown",
        reason: "its `handle_ref` does not parse",
      });
      expect(JSON.stringify(plan.health.connectors)).not.toContain(invalidRef);
    });

    it("returns the identity, space and toolshed the instance records", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe(
        "/keys/instance.key",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("ben-loom-dev-6");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8001",
      );
    });

    it("returns the store as a path rather than the `file://` URL loom printed", () => {
      // The space store reader walks `MEMORY_DIR` as a directory. Handed a
      // `file://` URL it walks nothing, falls through to its other candidate
      // roots, and reads another store's cells as this space's.

      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.MEMORY_DIR).toBe(
        "/loom/instances/loom/toolshed-store/68239506e79d/",
      );
    });

    it("returns a store loom printed as a plain path unchanged", () => {
      const plan = resolveConsoleLaunchPlan(
        {
          ...RECORDS,
          instance: {
            ...RECORDS.instance!,
            toolshedStoreDir: "/loom/store/memory/",
          },
        },
        OPTIONS,
      );

      expect(plan.environment.MEMORY_DIR).toBe("/loom/store/memory/");
    });

    it("returns the sidecar directories the registered runtime names, as host paths", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/runsc-cfc/sidecars/results",
      );
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR).toBe(
        "/store/runsc-cfc/sidecars/ctx",
      );
    });

    it("returns the Weaver pairing port and a console directory naming it", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe(
        String(WEAVER_PAIRING_PORT),
      );
      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        `.cf-harness-console-loom-${WEAVER_PAIRING_PORT}`,
      );
    });

    it("returns the port the instance records, as loom's proxy resolves it", () => {
      // The daemon's proxy target and the console's bind port read the same
      // inputs in the same order, so one record moves both.

      const plan = resolveConsoleLaunchPlan(
        withPieces({
          identity: "/keys/instance.key",
          local_space: "ben-loom-dev-6",
          server_urls: { toolshed: "http://localhost:8001" },
          harness_console_port: 8136,
        }),
        OPTIONS,
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe("8136");
      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        ".cf-harness-console-loom-8136",
      );
    });

    it("returns a named port over the one the instance records", () => {
      const plan = resolveConsoleLaunchPlan(
        withPieces({
          identity: "/keys/instance.key",
          local_space: "s",
          server_urls: { toolshed: "http://localhost:8001" },
          harness_console_port: 8136,
        }),
        { ...OPTIONS, port: 8140 },
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe("8140");
    });

    it("returns the pairing port for a recorded value that is not a port", () => {
      const plan = resolveConsoleLaunchPlan(
        withPieces({
          identity: "/keys/instance.key",
          local_space: "s",
          server_urls: { toolshed: "http://localhost:8001" },
          harness_console_port: "not a port",
        }),
        OPTIONS,
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe(
        String(WEAVER_PAIRING_PORT),
      );
    });

    it("returns a distinct console directory for each port", () => {
      const first = resolveConsoleLaunchPlan(RECORDS, {
        ...OPTIONS,
        port: 8136,
      });
      const second = resolveConsoleLaunchPlan(RECORDS, {
        ...OPTIONS,
        port: 8137,
      });

      expect(first.environment.CF_HARNESS_CONSOLE_DIR).not.toBe(
        second.environment.CF_HARNESS_CONSOLE_DIR,
      );
    });

    it("returns the enforcing posture with flow labels persisted", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_FABRIC_CFC_POSTURE).toBe(
        "max-enforcement",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_FLOW_LABELS).toBe(
        "persist",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE).toBe(
        DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
      );
    });

    it("returns a named value over the record that would decide it", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {
        ...OPTIONS,
        consoleDir: "/consoles/branch",
        cfcResultDir: "/elsewhere/results",
        posture: "none",
      });

      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe("/consoles/branch");
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/elsewhere/results",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_POSTURE).toBe("none");
    });

    it("leaves the index and the registry out of the environment when waived", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {
        noPatternIndex: true,
        noSkillsRegistry: true,
      });

      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBeUndefined();
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBeUndefined();
    });

    it("throws naming `--fabric-identity` when nothing records one", () => {
      expect(() =>
        resolveConsoleLaunchPlan(
          withPieces({
            local_space: "s",
            server_urls: { toolshed: "http://localhost:8001" },
          }),
          OPTIONS,
        )
      ).toThrow("`--fabric-identity`");
    });

    it("throws naming `--fabric-space` when nothing records one", () => {
      expect(() =>
        resolveConsoleLaunchPlan(
          withPieces({
            identity: "/keys/instance.key",
            server_urls: { toolshed: "http://localhost:8001" },
          }),
          OPTIONS,
        )
      ).toThrow("`--fabric-space`");
    });

    it("throws naming `--fabric-api-url` when nothing records one", () => {
      expect(() =>
        resolveConsoleLaunchPlan(
          withPieces({ identity: "/keys/instance.key", local_space: "s" }),
          OPTIONS,
        )
      ).toThrow("`--fabric-api-url`");
    });

    it("throws naming the file when `pieces.json` does not parse", () => {
      expect(() =>
        resolveConsoleLaunchPlan({
          ...RECORDS,
          instance: { ...RECORDS.instance!, piecesJson: "{" },
        }, OPTIONS)
      ).toThrow("/loom/instances/loom/pieces.json` is not valid JSON");
    });

    it("throws naming the file when `pieces.json` is not an object", () => {
      expect(() =>
        resolveConsoleLaunchPlan({
          ...RECORDS,
          instance: { ...RECORDS.instance!, piecesJson: "[1]" },
        }, OPTIONS)
      ).toThrow("does not hold a JSON object");
    });

    it("throws naming `--store` when loom printed none", () => {
      expect(() =>
        resolveConsoleLaunchPlan({
          ...RECORDS,
          instance: { ...RECORDS.instance!, toolshedStoreDir: "" },
        }, OPTIONS)
      ).toThrow("`--store`");
    });

    it("throws naming `--cfc-result-dir` when no runtime registration names it", () => {
      const { dockerRuntimes: _omitted, ...withoutDocker } = RECORDS;

      expect(() => resolveConsoleLaunchPlan(withoutDocker, OPTIONS)).toThrow(
        "`--cfc-result-dir`",
      );
    });

    it("throws carrying the reason the runtime table could not be read", () => {
      const { dockerRuntimes: _omitted, ...withoutDocker } = RECORDS;

      expect(() =>
        resolveConsoleLaunchPlan({
          ...withoutDocker,
          dockerRuntimesUnreadable:
            "`docker info` exited 1: daemon is not running",
        }, OPTIONS)
      ).toThrow("daemon is not running");
    });

    it("returns the sidecar directories a separate-token registration names", () => {
      const plan = resolveConsoleLaunchPlan({
        ...RECORDS,
        dockerRuntimes: {
          "runsc-cfc": {
            runtimeArgs: [
              "-cfc-result-dir",
              "/store/results",
              "--cfc-invocation-context-dir",
              "/store/ctx",
            ],
          },
        },
      }, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/results",
      );
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR)
        .toBe("/store/ctx");
    });

    it("returns the last directory a registration names for a flag twice", () => {
      const plan = resolveConsoleLaunchPlan({
        ...RECORDS,
        dockerRuntimes: {
          "runsc-cfc": {
            runtimeArgs: [
              "--cfc-result-dir=/store/first",
              "--cfc-invocation-context-dir=/store/ctx",
              "--cfc-result-dir=/store/last",
            ],
          },
        },
      }, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/last",
      );
    });

    it("throws naming `--cfc-invocation-context-dir` when the registration omits it", () => {
      const records: ConsoleLaunchRecords = {
        ...RECORDS,
        dockerRuntimes: {
          "runsc-cfc": { runtimeArgs: ["--cfc-result-dir=/store/results"] },
        },
      };

      expect(() => resolveConsoleLaunchPlan(records, OPTIONS)).toThrow(
        "`--cfc-invocation-context-dir`",
      );
    });

    it("does not run skill scripts unless a launch says so", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {});

      expect(plan.environment.CF_HARNESS_ALLOW_SKILL_SCRIPTS).toBeUndefined();
      expect(
        consoleLaunchReport(plan).find((line) =>
          line.includes("skill scripts")
        ),
      ).toContain("not run");
    });

    it("runs skill scripts when a launch names the switch", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {
        allowSkillScripts: true,
      });

      expect(plan.environment.CF_HARNESS_ALLOW_SKILL_SCRIPTS).toBe("1");
      const reported = consoleLaunchReport(plan).find((line) =>
        line.includes("skill scripts")
      );
      expect(reported).toContain("run in the sandbox");
      expect(reported).toContain("named on the command line");
    });

    it("runs skill scripts when the variable carries the switch", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {
        inheritedAllowSkillScripts: true,
      });

      expect(plan.environment.CF_HARNESS_ALLOW_SKILL_SCRIPTS).toBe("1");
      expect(
        consoleLaunchReport(plan).find((line) =>
          line.includes("skill scripts")
        ),
      ).toContain("inherited");
    });

    it("names the skill-script variable among the ones the launcher owns", () => {
      expect(LAUNCHER_OWNED_VARIABLES).toContain(
        "CF_HARNESS_ALLOW_SKILL_SCRIPTS",
      );
    });

    it("throws when an index is both named and waived", () => {
      expect(() =>
        resolveConsoleLaunchPlan(RECORDS, { ...OPTIONS, noPatternIndex: true })
      ).toThrow("contradict each other");
    });

    it("throws when a skills registry is both named and waived", () => {
      expect(() =>
        resolveConsoleLaunchPlan(RECORDS, {
          ...OPTIONS,
          noSkillsRegistry: true,
        })
      ).toThrow("contradict each other");
    });

    it("returns only variables `LAUNCHER_OWNED_VARIABLES` names", () => {
      // The launcher clears every owned variable before applying the resolved
      // ones, so a key it can set that is missing from that list would survive
      // from the operator's shell and contradict the printed report.

      const plans = [
        resolveConsoleLaunchPlan(RECORDS, {}),
        resolveConsoleLaunchPlan(RECORDS, {
          noPatternIndex: true,
          noSkillsRegistry: true,
        }),
        resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC),
      ];

      for (const plan of plans) {
        for (const key of Object.keys(plan.environment)) {
          expect(LAUNCHER_OWNED_VARIABLES).toContain(key);
        }
      }
    });

    it("returns the deployment's index and registry when neither is named", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {});

      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBe(
        DEPLOYMENT_PATTERN_INDEX_URL,
      );
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBe(
        DEPLOYMENT_SKILLS_REGISTRY_URL,
      );
    });

    it("returns the deployment default beside the source that says so", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {});
      const index = plan.resolved.find((entry) => entry.name === "index");

      expect(index?.source).toBe("labs deployment default");
    });
  });

  // ----------------------------------------------------------------------
  // The connector handles the instance has injected
  //
  // Grants rather than per-task input cells: every session this console runs
  // holds them, so the launcher resolves them beside the fabric's other facts
  // and passes them to the server it starts.
  // ----------------------------------------------------------------------

  describe("resolveConsoleLaunchPlan() with connector handles", () => {
    it("passes one grant per injected handle to the console", () => {
      const plan = resolveConsoleLaunchPlan(WITH_CONNECTOR, OPTIONS);

      expect(JSON.parse(plan.environment.CF_HARNESS_CONNECTOR_GRANTS!))
        .toEqual([{
          name: "gmail-work",
          cfcClasses: ["email"],
          ref: MAIL_REF,
          source: {
            connection: "gmail-work",
            piece: "cf-gmail-messages--gmail-work",
          },
        }]);
    });

    it("reports each grant against the two records that decided it", () => {
      const plan = resolveConsoleLaunchPlan(WITH_CONNECTOR, OPTIONS);
      const grant = plan.resolved.find((entry) =>
        entry.name === "grant gmail-work (email)"
      );

      expect(grant?.value).toBe(MAIL_REF);
      expect(grant?.source).toContain(HANDLES_JSON_PATH);
      expect(grant?.source).toContain("cf-gmail-messages--gmail-work");
    });

    it("sets no grants variable for an instance whose daemon has injected none", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_CONNECTOR_GRANTS).toBeUndefined();
      expect(plan.resolved.some((entry) => entry.name.startsWith("grant ")))
        .toBe(false);
    });

    it("sets no grants variable for a fabric with no instance behind it", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC);

      expect(plan.environment.CF_HARNESS_CONNECTOR_GRANTS).toBeUndefined();
    });

    it("reports a handle it could not name rather than passing it as a grant", () => {
      const unlabeled: ConsoleLaunchRecords = {
        ...WITH_CONNECTOR,
        instance: {
          ...WITH_CONNECTOR.instance!,
          piecesJson: JSON.stringify({
            defaults: JSON.parse(PIECES_JSON).defaults,
            pieces: [{
              name: "cf-gmail-messages--gmail-work",
              sqlite_sources: [{
                connection_id: "gmail-work",
                tables: {
                  messages: { properties: { subject: { type: "string" } } },
                },
              }],
            }],
          }),
        },
      };
      const plan = resolveConsoleLaunchPlan(unlabeled, OPTIONS);
      const reported = plan.resolved.find((entry) =>
        entry.name === "grant gmail-work"
      );

      expect(plan.environment.CF_HARNESS_CONNECTOR_GRANTS).toBeUndefined();
      expect(reported?.value).toContain("no CFC class");
    });

    it("refuses to start when the receipt does not parse", () => {
      const broken: ConsoleLaunchRecords = {
        ...WITH_CONNECTOR,
        instance: { ...WITH_CONNECTOR.instance!, handlesJson: "{" },
      };

      expect(() => resolveConsoleLaunchPlan(broken, OPTIONS)).toThrow(
        HANDLES_JSON_PATH,
      );
    });

    it("names the grants variable among the ones the launcher owns", () => {
      expect(LAUNCHER_OWNED_VARIABLES).toContain("CF_HARNESS_CONNECTOR_GRANTS");
    });
  });

  // ----------------------------------------------------------------------
  // A fabric with no loom instance behind it
  //
  // The plain labs checkout, where nothing records the identity, the space,
  // the toolshed or the store, and the caller names all four.
  // ----------------------------------------------------------------------

  describe("resolveConsoleLaunchPlan() without an instance", () => {
    it("returns every value the caller named", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC);

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe("/keys/dev.key");
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("cf-harness-dev");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8000",
      );
      expect(plan.environment.MEMORY_DIR).toBe(
        "/checkout/packages/toolshed/cache/memory",
      );
    });

    it("returns a console directory naming the port alone", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, {
        ...NAMED_FABRIC,
        port: 8140,
      });

      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        ".cf-harness-console-8140",
      );
    });

    it("reports no instance among the resolved values", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC);

      expect(plan.resolved.some((entry) => entry.name === "instance")).toBe(
        false,
      );
    });

    it("throws naming `--fabric-identity` when the caller names none", () => {
      const { identity: _omitted, ...withoutIdentity } = NAMED_FABRIC;

      expect(() => resolveConsoleLaunchPlan(NO_INSTANCE, withoutIdentity))
        .toThrow("`--fabric-identity`");
    });

    it("throws naming `--store` when the caller names none", () => {
      const { store: _omitted, ...withoutStore } = NAMED_FABRIC;

      expect(() => resolveConsoleLaunchPlan(NO_INSTANCE, withoutStore))
        .toThrow("`--store`");
    });

    it("names no `pieces.json` in an error when no instance was read", () => {
      // The error text is what an operator acts on, and a plain labs checkout
      // has no loom instance to edit.

      const { space: _omitted, ...withoutSpace } = NAMED_FABRIC;

      expect(() => resolveConsoleLaunchPlan(NO_INSTANCE, withoutSpace))
        .toThrow(/^(?!.*pieces\.json).*$/s);
    });

    it("throws for a space named by DID, which composes no piece URL", () => {
      expect(() =>
        resolveConsoleLaunchPlan(NO_INSTANCE, {
          ...NAMED_FABRIC,
          space: "did:key:z6Mk",
        })
      ).toThrow("rather than a DID");
    });
  });

  // ----------------------------------------------------------------------
  // Reading the machine
  //
  // `prepareConsoleLaunch` turns argv and the environment into a plan. Its
  // three readings of the machine are handed in, so what these exercise is
  // the argument and environment plumbing between them and the resolver.
  // ----------------------------------------------------------------------

  describe("prepareConsoleLaunch()", () => {
    const io = (
      overrides: Partial<ConsoleLaunchIo> = {},
    ): ConsoleLaunchIo => ({
      readTextFile: () => Promise.resolve(PIECES_JSON),
      readToolshedStoreDir: () =>
        Promise.resolve("file:///store/68239506e79d/memory/"),
      readDockerRuntimes: () => Promise.resolve({ runtimes: DOCKER_RUNTIMES }),
      ...overrides,
    });

    const NAMED_ARGS = [
      "--fabric-identity",
      "/keys/dev.key",
      "--fabric-space",
      "cf-harness-dev",
      "--fabric-api-url",
      "http://localhost:8000",
      "--store",
      "/checkout/cache/memory",
    ];

    it("returns a plan built from the flags it was given", async () => {
      const { plan } = await prepareConsoleLaunch(NAMED_ARGS, {}, io());

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe("/keys/dev.key");
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("cf-harness-dev");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8000",
      );
      expect(plan.environment.MEMORY_DIR).toBe("/checkout/cache/memory");
    });

    it("returns the arguments after `--` for the console, and no others", async () => {
      const { consoleArgs } = await prepareConsoleLaunch(
        [...NAMED_ARGS, "--port", "8140", "--", "--host-mount", "name=c"],
        {},
        io(),
      );

      expect(consoleArgs).toEqual(["--host-mount", "name=c"]);
    });

    it("reads the identity and space off an instance when one is named", async () => {
      const { plan } = await prepareConsoleLaunch(
        ["--instance", "loom", "--fabric-api-url", "http://localhost:8001"],
        { HOME: "/home/dev" },
        io(),
      );

      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("ben-loom-dev-6");
      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe(
        "/keys/instance.key",
      );
    });

    it("returns the store as a path when loom printed a `file://` URL", async () => {
      const { plan } = await prepareConsoleLaunch(
        ["--instance", "loom"],
        { HOME: "/home/dev" },
        io(),
      );

      expect(plan.environment.MEMORY_DIR).toBe("/store/68239506e79d/memory/");
    });

    it("does not read an instance for an inherited `LOOM_INSTANCE_ID` alone", async () => {
      // The console comes along because someone asked for it. An ambient
      // variable is a fact about the process tree, not a request.

      await expect(
        prepareConsoleLaunch([], { LOOM_INSTANCE_ID: "loom" }, io()),
      ).rejects.toThrow("`--fabric-identity`");
    });

    it("throws naming the instance whose `pieces.json` is not there", async () => {
      await expect(
        prepareConsoleLaunch(
          ["--instance", "ghost"],
          { HOME: "/home/dev" },
          io({ readTextFile: () => Promise.resolve(undefined) }),
        ),
      ).rejects.toThrow("loom instance `ghost` has no");
    });

    it("carries the reason `docker info` could not be read into the error", async () => {
      await expect(
        prepareConsoleLaunch(
          NAMED_ARGS,
          {},
          io({
            readDockerRuntimes: () =>
              Promise.resolve({ unreadable: "daemon is not running" }),
          }),
        ),
      ).rejects.toThrow("daemon is not running");
    });

    it("ranks an instance's record above what the shell exported", async () => {
      // An exported variable is a fact about the shell; an instance that wrote
      // down its own store has said something more specific. Ranking them the
      // other way reads a store the instance does not use, and reports it as
      // though someone chose it.

      const { plan } = await prepareConsoleLaunch(
        ["--instance", "loom"],
        {
          HOME: "/home/dev",
          MEMORY_DIR: "/somewhere/else/",
          CF_IDENTITY: "/keys/ambient.key",
          CF_SPACE: "ambient-space",
          CF_HARNESS_FABRIC_API_URL: "http://localhost:9999",
        },
        io(),
      );

      expect(plan.environment.MEMORY_DIR).toBe("/store/68239506e79d/memory/");
      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe(
        "/keys/instance.key",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("ben-loom-dev-6");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8001",
      );
    });

    it("returns the port the shell exported when no instance records one", async () => {
      // The precedence loom's proxy resolves its target with, so the console
      // binds the port the proxy is looking for.

      const { plan } = await prepareConsoleLaunch(
        ["--instance", "loom"],
        { HOME: "/home/dev", CF_HARNESS_CONSOLE_PORT: "8140" },
        io(),
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe("8140");
    });

    it("returns a recorded port over the one the shell exported", async () => {
      const { plan } = await prepareConsoleLaunch(
        ["--instance", "loom"],
        { HOME: "/home/dev", CF_HARNESS_CONSOLE_PORT: "8140" },
        io({
          readTextFile: () =>
            Promise.resolve(JSON.stringify({
              defaults: {
                identity: "/keys/instance.key",
                local_space: "ben-loom-dev-6",
                server_urls: { toolshed: "http://localhost:8001" },
                harness_console_port: 8136,
              },
            })),
        }),
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe("8136");
    });

    it("reads the console's own environment names before the `cf` CLI's", async () => {
      const { plan } = await prepareConsoleLaunch(
        ["--fabric-api-url", "http://localhost:8000", "--store", "/s"],
        {
          CF_HARNESS_FABRIC_IDENTITY: "/keys/console.key",
          CF_IDENTITY: "/keys/cf.key",
          CF_HARNESS_FABRIC_SPACE: "console-space",
          CF_SPACE: "cf-space",
        },
        io(),
      );

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe(
        "/keys/console.key",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("console-space");
    });

    it("falls back to the `cf` CLI's names when the console's are unset", async () => {
      const { plan } = await prepareConsoleLaunch(
        ["--fabric-api-url", "http://localhost:8000", "--store", "/s"],
        { CF_IDENTITY: "/keys/cf.key", CF_SPACE: "cf-space" },
        io(),
      );

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe("/keys/cf.key");
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("cf-space");
    });

    it("reads the toolshed URL and store from the environment the console names", async () => {
      const { plan } = await prepareConsoleLaunch(
        ["--fabric-identity", "/k", "--fabric-space", "s"],
        {
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8300",
          MEMORY_DIR: "file:///env/store/",
        },
        io(),
      );

      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8300",
      );
      expect(plan.environment.MEMORY_DIR).toBe("/env/store/");
    });

    it("returns every posture and registry flag it was given", async () => {
      const { plan } = await prepareConsoleLaunch(
        [
          ...NAMED_ARGS,
          "--console-dir",
          "/consoles/one",
          "--pattern-index-url",
          "https://index.example",
          "--skills-registry-url",
          "https://skills.example",
          "--cfc-result-dir",
          "/r",
          "--cfc-invocation-context-dir",
          "/c",
          "--fabric-cfc-posture",
          "none",
          "--fabric-cfc-flow-labels",
          "observe",
          "--fabric-cfc-enforcement-mode",
          "observe",
        ],
        {},
        io(),
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe("/consoles/one");
      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBe(
        "https://index.example",
      );
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBe(
        "https://skills.example",
      );
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe("/r");
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR)
        .toBe("/c");
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_POSTURE).toBe("none");
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_FLOW_LABELS).toBe(
        "observe",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE).toBe(
        "observe",
      );
    });

    it("reads the switch from the flag and from the variable", async () => {
      const named = await prepareConsoleLaunch(
        [...NAMED_ARGS, "--allow-skill-scripts"],
        {},
        io(),
      );
      expect(named.plan.environment.CF_HARNESS_ALLOW_SKILL_SCRIPTS).toBe("1");

      const inherited = await prepareConsoleLaunch(
        NAMED_ARGS,
        { CF_HARNESS_ALLOW_SKILL_SCRIPTS: "1" },
        io(),
      );
      expect(inherited.plan.environment.CF_HARNESS_ALLOW_SKILL_SCRIPTS).toBe(
        "1",
      );

      const neither = await prepareConsoleLaunch(NAMED_ARGS, {}, io());
      expect(neither.plan.environment.CF_HARNESS_ALLOW_SKILL_SCRIPTS)
        .toBeUndefined();
    });

    it("refuses the skill-script switch passed through to the console", async () => {
      // Every spelling that would enable it on the server: a boolean flag
      // still parses `=true` and `=1`, so the bare token is not the whole of
      // what has to be caught.
      for (
        const argument of [
          "--allow-skill-scripts",
          "--allow-skill-scripts=true",
          "--allow-skill-scripts=1",
        ]
      ) {
        await expect(
          prepareConsoleLaunch([...NAMED_ARGS, "--", argument], {}, io()),
        ).rejects.toThrow("cannot be passed through");
      }
    });

    it("passes other console flags through unchanged", async () => {
      const { consoleArgs } = await prepareConsoleLaunch(
        [...NAMED_ARGS, "--", "--host-mount", "name=c"],
        {},
        io(),
      );

      expect(consoleArgs).toEqual(["--host-mount", "name=c"]);
    });

    it("leaves the registries out when both are waived", async () => {
      const { plan } = await prepareConsoleLaunch(
        [...NAMED_ARGS, "--no-pattern-index", "--no-skills-registry"],
        {},
        io(),
      );

      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBeUndefined();
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBeUndefined();
    });

    it("reads the machine itself when no readings are handed in", async () => {
      // The default wiring: `docker info` is asked for real, and the launch
      // still fails at the first value nothing supplies, whether or not this
      // machine has Docker.

      await expect(prepareConsoleLaunch([], {})).rejects.toThrow(
        "`--fabric-identity`",
      );
    });

    it("throws naming `--port` for a port that is not a positive integer", async () => {
      await expect(
        prepareConsoleLaunch([...NAMED_ARGS, "--port", "nope"], {}, io()),
      ).rejects.toThrow("--port must be a positive integer");
    });

    it("throws for a flag whose value was eaten by looking like a flag", async () => {
      // `--port -1` leaves the value empty, because `-1` parses as a flag of
      // its own. Falling through to the default would ignore a port someone
      // typed.

      await expect(
        prepareConsoleLaunch([...NAMED_ARGS, "--port", "-1"], {}, io()),
      ).rejects.toThrow("`--port` was given no value");
    });

    it("returns the port for the `=` spelling a negative value needs", async () => {
      await expect(
        prepareConsoleLaunch([...NAMED_ARGS, "--port=-1"], {}, io()),
      ).rejects.toThrow("--port must be a positive integer");
    });

    it("throws naming an instance directory it cannot locate", async () => {
      await expect(
        prepareConsoleLaunch(["--instance", "loom"], {}, io()),
      ).rejects.toThrow("`XDG_DATA_HOME`");
    });

    it("reads both of an instance's records under `XDG_DATA_HOME` when it is set", async () => {
      const read: string[] = [];
      await prepareConsoleLaunch(
        ["--instance", "loom"],
        { XDG_DATA_HOME: "/data", HOME: "/home/dev" },
        io({
          readTextFile: (path) => {
            read.push(path);
            return Promise.resolve(PIECES_JSON);
          },
        }),
      );

      expect(read).toEqual([
        "/data/loom/instances/loom/pieces.json",
        "/data/loom/instances/loom/sqlite-injection/handles.json",
      ]);
    });
  });

  // ----------------------------------------------------------------------
  // The three readings themselves
  //
  // Driven against real files and real child processes, because what they are
  // for is the machine answering — a fake would only restate the code.
  // ----------------------------------------------------------------------

  describe("readOptionalFile()", () => {
    it("returns the file's text", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-launch-read-" });
      try {
        await Deno.writeTextFile(`${dir}/pieces.json`, "{}");

        expect(await readOptionalFile(`${dir}/pieces.json`)).toBe("{}");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns `undefined` for a file that is not there", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-launch-read-" });
      try {
        expect(await readOptionalFile(`${dir}/absent.json`)).toBeUndefined();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws for a path that cannot be read for another reason", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-launch-read-" });
      try {
        // A directory is not a missing file, so it must not read as absent.
        await expect(readOptionalFile(dir)).rejects.toThrow();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("readToolshedStoreDir()", () => {
    it("returns what the command printed, trimmed", async () => {
      const bin = await fakeBinary("printf 'file:///store/memory/\n'");
      try {
        expect(await readToolshedStoreDir(bin, "loom")).toBe(
          "file:///store/memory/",
        );
      } finally {
        await Deno.remove(bin);
      }
    });

    it("throws carrying the command's own diagnostic when it fails", async () => {
      const bin = await fakeBinary("echo 'no such instance' >&2; exit 3");
      try {
        await expect(readToolshedStoreDir(bin, "ghost")).rejects.toThrow(
          "no such instance",
        );
      } finally {
        await Deno.remove(bin);
      }
    });

    it("throws naming `--loom-bin` when the command cannot be run", async () => {
      await expect(
        readToolshedStoreDir("/nonexistent/loom", "loom"),
      ).rejects.toThrow("`--loom-bin`");
    });
  });

  describe("readDockerRuntimes()", () => {
    it("returns the runtime table the command printed", async () => {
      const bin = await fakeBinary(
        `printf '${JSON.stringify(DOCKER_RUNTIMES)}'`,
      );
      try {
        const read = await readDockerRuntimes(bin);

        expect(read.runtimes).toEqual(DOCKER_RUNTIMES);
        expect(read.unreadable).toBeUndefined();
      } finally {
        await Deno.remove(bin);
      }
    });

    it("returns the exit status and stderr when the command fails", async () => {
      const bin = await fakeBinary("echo 'daemon not running' >&2; exit 1");
      try {
        const read = await readDockerRuntimes(bin);

        expect(read.runtimes).toBeUndefined();
        expect(read.unreadable).toContain("exited 1");
        expect(read.unreadable).toContain("daemon not running");
      } finally {
        await Deno.remove(bin);
      }
    });

    it("returns a reason when the table does not parse", async () => {
      const bin = await fakeBinary("printf 'not json'");
      try {
        const read = await readDockerRuntimes(bin);

        expect(read.runtimes).toBeUndefined();
        expect(read.unreadable).toContain("does not parse");
      } finally {
        await Deno.remove(bin);
      }
    });

    it("returns a reason when the command cannot be run at all", async () => {
      const read = await readDockerRuntimes("/nonexistent/docker");

      expect(read.runtimes).toBeUndefined();
      expect(read.unreadable).toContain("could not be run");
    });
  });

  describe("launchConsole()", () => {
    const io: ConsoleLaunchIo = {
      readTextFile: () => Promise.resolve(PIECES_JSON),
      readToolshedStoreDir: () =>
        Promise.resolve("file:///store/68239506e79d/memory/"),
      readDockerRuntimes: () => Promise.resolve({ runtimes: DOCKER_RUNTIMES }),
    };
    const ARGS = [
      "--fabric-identity",
      "/keys/dev.key",
      "--fabric-space",
      "cf-harness-dev",
      "--fabric-api-url",
      "http://localhost:8000",
      "--store",
      "/checkout/cache/memory",
      "--console-dir",
      "/consoles/launched",
    ];

    /** Restores whatever the process held for the keys a launch decides. */
    const withEnvironmentRestored = async (
      body: () => Promise<void>,
    ): Promise<void> => {
      const before = new Map(
        LAUNCHER_OWNED_VARIABLES.map((
          name,
        ) => [name, Deno.env.get(name)] as const),
      );
      try {
        await body();
      } finally {
        for (const [name, value] of before) {
          if (value === undefined) {
            Deno.env.delete(name);
          } else {
            Deno.env.set(name, value);
          }
        }
      }
    };

    it("serves under the environment it resolved", async () => {
      await withEnvironmentRestored(async () => {
        let served: string[] | undefined;
        await launchConsole(
          [...ARGS, "--", "--host-mount", "name=corpus"],
          {},
          (consoleArgs) => {
            served = consoleArgs;
            return Promise.resolve();
          },
          io,
        );

        expect(served).toEqual(["--host-mount", "name=corpus"]);
        expect(Deno.env.get("CF_HARNESS_FABRIC_SPACE")).toBe("cf-harness-dev");
        expect(Deno.env.get("CF_HARNESS_CONSOLE_DIR")).toBe(
          "/consoles/launched",
        );
        expect(Deno.env.get("MEMORY_DIR")).toBe("/checkout/cache/memory");
      });
    });

    it("carries its observed decision report into serving", async () => {
      await withEnvironmentRestored(async () => {
        let observed: ConsoleObservedLaunchHealth | undefined;
        await launchConsole(ARGS, {}, (_args, health) => {
          observed = health;
          return Promise.resolve();
        }, io);
        expect(observed?.resolved).toContainEqual({
          name: "space",
          value: "cf-harness-dev",
          source: "named on the command line",
        });
        expect(Number.isFinite(Date.parse(observed?.checkedAt ?? ""))).toBe(
          true,
        );
      });
    });

    it("clears an owned variable the resolved environment does not set", async () => {
      await withEnvironmentRestored(async () => {
        Deno.env.set("CF_HARNESS_PATTERN_INDEX_URL", "https://inherited.test");

        await launchConsole(
          [...ARGS, "--no-pattern-index"],
          {},
          () => Promise.resolve(),
          io,
        );

        expect(Deno.env.get("CF_HARNESS_PATTERN_INDEX_URL")).toBeUndefined();
      });
    });

    it("does not serve when the configuration cannot be resolved", async () => {
      await withEnvironmentRestored(async () => {
        let served = false;

        await expect(
          launchConsole([], {}, () => {
            served = true;
            return Promise.resolve();
          }, io),
        ).rejects.toThrow("`--fabric-identity`");
        expect(served).toBe(false);
      });
    });
  });

  describe("the module run as a program", () => {
    it("prints the launch's own message and exits 1 when it cannot start", async () => {
      // The `import.meta.main` block, which an import never runs. With no
      // fabric named it fails at the first value it cannot resolve, which is
      // what an operator who forgot one sees.
      const launcher = new URL("../../console/launch.ts", import.meta.url);
      const run = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", launcher.pathname],
        env: {
          CF_IDENTITY: "",
          CF_SPACE: "",
          CF_HARNESS_FABRIC_IDENTITY: "",
          CF_HARNESS_FABRIC_SPACE: "",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();

      expect(run.code).toBe(1);
      const said = new TextDecoder().decode(run.stderr);
      expect(said).toContain("`--fabric-identity`");
      // The message is the whole of what they need; the stack is noise.
      expect(said).not.toContain("launch.ts:");
    });
  });

  describe("launchFailureMessage()", () => {
    it("returns the error's message", () => {
      expect(launchFailureMessage(new Error("no space named"))).toBe(
        "no space named",
      );
    });

    it("returns the string form of something thrown that is not an error", () => {
      expect(launchFailureMessage("plain")).toBe("plain");
    });
  });

  describe("consoleLaunchReport()", () => {
    it("returns a line for every resolved value, each naming its source", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);
      const lines = consoleLaunchReport(plan);

      for (const entry of plan.resolved) {
        expect(
          lines.some((line) =>
            line.includes(entry.value) && line.includes(entry.source)
          ),
        ).toBe(true);
      }
    });

    it("returns the space and store an operator checks the console against", () => {
      const lines = consoleLaunchReport(
        resolveConsoleLaunchPlan(RECORDS, OPTIONS),
      )
        .join("\n");

      expect(lines).toContain("ben-loom-dev-6");
      expect(lines).toContain(
        "/loom/instances/loom/toolshed-store/68239506e79d/",
      );
    });
  });
});
