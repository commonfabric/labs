import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  currentProvenance,
  detectProvenance,
  type EnvReader,
  type HarnessProvenance,
  type PrincipalStore,
  provenanceHeaders,
  provenanceUserAgent,
  sanitize,
  setCurrentProvenance,
  withRunManifest,
} from "../src/provenance.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import { cfHarnessCliCommandName } from "../src/cli.ts";
import { runCfHarnessCli } from "./support/on-linux.ts";

function envFrom(values: Record<string, string>): EnvReader {
  return (name) => values[name];
}

/** A principal store held in memory, standing in for the file on disk. */
function memoryStore(initial?: string): PrincipalStore & { value?: string } {
  const store = {
    value: initial,
    read() {
      return store.value;
    },
    write(value: string) {
      store.value ??= value;
    },
  };
  return store;
}

/** A store on a read-only home: writes are accepted and nothing persists. */
function unwritableStore(): PrincipalStore {
  return { read: () => undefined, write: () => {} };
}

const BASE: HarnessProvenance = {
  invoker: "cli",
  session: "0123abcd-4567-89ef-0123-456789abcdef",
  principal: "a1b2c3d4",
};

describe("provenance", () => {
  describe("detectProvenance()", () => {
    describe("invoker", () => {
      it("returns `integration-test` when `CF_HARNESS_INTEGRATION` is set", () => {
        const env = envFrom({ CF_HARNESS_INTEGRATION: "1", ENV: "test" });
        expect(detectProvenance({ env }).invoker).toBe("integration-test");
      });

      it("returns `test` when `ENV` is `test`", () => {
        const env = envFrom({ ENV: "test" });
        expect(detectProvenance({ env }).invoker).toBe("test");
      });

      it("returns `ci` under GitHub Actions", () => {
        const env = envFrom({
          GITHUB_ACTIONS: "true",
          GITHUB_WORKFLOW: "deno",
          GITHUB_RUN_ID: "4321",
        });
        const provenance = detectProvenance({ env });
        expect(provenance.invoker).toBe("ci");
        expect(provenance.ci).toBe("github:deno:4321");
      });

      it("returns a `ci` value that keeps the run id when the workflow is long", () => {
        const env = envFrom({
          GITHUB_WORKFLOW: "Deno CI / integration tests (pattern coverage)",
          GITHUB_RUN_ID: "18234567890",
        });
        const ci = detectProvenance({ env }).ci ?? "";
        expect(ci.length).toBeLessThanOrEqual(48);
        expect(ci.endsWith(":18234567890")).toBe(true);
      });

      it("returns no `ci` value outside GitHub Actions", () => {
        expect(detectProvenance({ env: envFrom({ CI: "true" }) }).ci)
          .toBeUndefined();
      });

      it("returns `service` when `OTEL_SERVICE_NAME` is set", () => {
        const env = envFrom({ OTEL_SERVICE_NAME: "toolshed-local" });
        expect(detectProvenance({ env }).invoker).toBe("service");
      });

      it("returns `cli` for an environment carrying none of the markers", () => {
        const provenance = detectProvenance({ env: envFrom({}) });
        expect(provenance.invoker).toBe("cli");
        expect(provenance.ci).toBeUndefined();
      });

      it("returns the more specific marker when a service name is also set", () => {
        const cases: Array<[Record<string, string>, string]> = [
          [{ OTEL_SERVICE_NAME: "toolshed", ENV: "test" }, "test"],
          [{ OTEL_SERVICE_NAME: "toolshed", CI: "true" }, "ci"],
        ];
        for (const [values, expected] of cases) {
          expect(detectProvenance({ env: envFrom(values) }).invoker).toBe(
            expected,
          );
        }
      });
    });

    describe("agent", () => {
      it("returns `claude-code` when `CLAUDECODE` is set", () => {
        const env = envFrom({ CLAUDECODE: "1" });
        expect(detectProvenance({ env }).agent).toBe("claude-code");
      });

      it("returns `codex` when `CODEX_SANDBOX` is set", () => {
        const env = envFrom({ CODEX_SANDBOX: "seatbelt" });
        expect(detectProvenance({ env }).agent).toBe("codex");
      });

      it("returns undefined when neither marker is set", () => {
        const env = envFrom({ TERM: "xterm" });
        expect(detectProvenance({ env }).agent).toBeUndefined();
      });

      it("returns an agent alongside a service invoker", () => {
        const env = envFrom({ OTEL_SERVICE_NAME: "toolshed", CLAUDECODE: "1" });
        const provenance = detectProvenance({ env });
        expect(provenance.invoker).toBe("service");
        expect(provenance.agent).toBe("claude-code");
      });
    });

    describe("principal", () => {
      it("returns the same label on a second run", () => {
        const store = memoryStore();
        const env = envFrom({});
        const first = detectProvenance({ env, principalStore: store });
        const second = detectProvenance({ env, principalStore: store });
        expect(first.principal).toMatch(/^[0-9a-f]{8}$/);
        expect(second.principal).toBe(first.principal);
        expect(store.value).toBe(first.principal);
      });

      it("returns the stored label rather than replacing it", () => {
        const store = memoryStore("deadbeef");
        const provenance = detectProvenance({
          env: envFrom({}),
          principalStore: store,
        });
        expect(provenance.principal).toBe("deadbeef");
        expect(store.value).toBe("deadbeef");
      });

      it("returns different labels for identical environments", () => {
        const env = envFrom({ USER: "ada", HOSTNAME: "ada-laptop" });
        const first = detectProvenance({ env, principalStore: memoryStore() });
        const second = detectProvenance({ env, principalStore: memoryStore() });
        expect(second.principal).not.toBe(first.principal);
      });

      it("returns the winner's label when another process created one first", () => {
        // Both processes see no principal; the other one creates it in between.
        let reads = 0;
        const store: PrincipalStore = {
          read: () => (reads++ === 0 ? undefined : "bbbbbbbb"),
          write: () => {},
        };
        const provenance = detectProvenance({
          env: envFrom({}),
          principalStore: store,
        });
        expect(provenance.principal).toBe("bbbbbbbb");
      });

      it("returns an `unstable-` label when the store cannot keep one", () => {
        const provenance = detectProvenance({
          env: envFrom({}),
          principalStore: unwritableStore(),
        });
        expect(provenance.principal).toMatch(/^unstable-[0-9a-f]{8}$/);
      });

      it("returns a generated label when the declared one reduces to nothing", () => {
        const provenance = detectProvenance({
          env: envFrom({ CF_HARNESS_PRINCIPAL: "!!!" }),
          principalStore: memoryStore(),
        });
        expect(provenance.principal).toMatch(/^[0-9a-f]{8}$/);
      });

      it("returns `CF_HARNESS_PRINCIPAL` without storing it", () => {
        const store = memoryStore();
        const provenance = detectProvenance({
          env: envFrom({ CF_HARNESS_PRINCIPAL: "build-box" }),
          principalStore: store,
        });
        expect(provenance.principal).toBe("build-box");
        expect(store.value).toBeUndefined();
      });
    });

    describe("service", () => {
      it("returns the service's `OTEL_SERVICE_NAME`", () => {
        const env = envFrom({ OTEL_SERVICE_NAME: "toolshed-local" });
        expect(detectProvenance({ env }).service).toBe("toolshed-local");
      });

      it("returns undefined when no service name is set", () => {
        expect(detectProvenance({ env: envFrom({}) }).service).toBeUndefined();
      });
    });

    describe("harness home", () => {
      it("keeps no principal for a test run", async () => {
        const home = await Deno.makeTempDir();
        try {
          const env = envFrom({ CF_HARNESS_HOME: home, ENV: "test" });
          expect(detectProvenance({ env }).principal).toMatch(/^unstable-/);
          expect([...Deno.readDirSync(home)].length).toBe(0);
        } finally {
          await Deno.remove(home, { recursive: true });
        }
      });

      it("creates the home only the owner can read", async () => {
        const parent = await Deno.makeTempDir();
        const home = `${parent}/home`;
        try {
          detectProvenance({ env: envFrom({ CF_HARNESS_HOME: home }) });
          expect((Deno.statSync(home).mode ?? 0) & 0o077).toBe(0);
        } finally {
          await Deno.remove(parent, { recursive: true });
        }
      });

      it("keeps the generated principal under `CF_HARNESS_HOME`", async () => {
        const home = await Deno.makeTempDir();
        try {
          const env = envFrom({ CF_HARNESS_HOME: home });
          const first = detectProvenance({ env });
          expect(first.principal).toMatch(/^[0-9a-f]{8}$/);
          const stored = await Deno.readTextFile(`${home}/principal`);
          expect(stored.trim()).toBe(first.principal);
          // A later process reading the same home reports the same principal.
          expect(detectProvenance({ env }).principal).toBe(first.principal);
        } finally {
          await Deno.remove(home, { recursive: true });
        }
      });
    });

    describe("command", () => {
      it("returns the command it was given", () => {
        const provenance = detectProvenance({
          env: envFrom({}),
          command: "prompt",
        });
        expect(provenance.command).toBe("prompt");
      });
    });

    describe("session", () => {
      it("returns a different value for each call", () => {
        const env = envFrom({});
        const first = detectProvenance({ env });
        const second = detectProvenance({ env });
        expect(second.session).not.toBe(first.session);
      });
    });
  });

  describe("sanitize()", () => {
    it("returns a keyword unchanged", () => {
      expect(sanitize("run")).toBe("run");
    });

    it("returns unsafe runs collapsed to a single separator", () => {
      expect(sanitize("what is the patient's diagnosis?")).toBe(
        "what_is_the_patient_s_diagnosis",
      );
    });

    it("returns at most 48 characters", () => {
      expect(sanitize("x".repeat(500)).length).toBe(48);
    });

    it("returns a value free of line breaks", () => {
      expect(sanitize("a\nb\r\nc")).not.toMatch(/[\r\n]/);
    });
  });

  describe("provenanceHeaders()", () => {
    it("returns one header per populated field", () => {
      const headers = provenanceHeaders({
        ...BASE,
        command: "run",
        ci: "github:deno:1",
      });
      expect(headers).toEqual({
        "x-cf-harness-invoker": "cli",
        "x-cf-harness-session": "0123abcd-4567-89ef-0123-456789abcdef",
        "x-cf-harness-principal": "a1b2c3d4",
        "x-cf-harness-command": "run",
        "x-cf-harness-ci": "github:deno:1",
      });
    });

    it("omits a field whose value reduces to nothing", () => {
      const headers = provenanceHeaders({ ...BASE, service: "!!!" });
      expect(Object.keys(headers)).not.toContain("x-cf-harness-service");
    });

    it("omits the service header when no service name is set", () => {
      const headers = provenanceHeaders(detectProvenance({ env: envFrom({}) }));
      expect(Object.keys(headers)).not.toContain("x-cf-harness-service");
    });

    it("omits the agent header when no coding agent is present", () => {
      const env = envFrom({ TERM: "xterm" });
      const headers = provenanceHeaders(detectProvenance({ env }));
      expect(Object.keys(headers)).not.toContain("x-cf-harness-agent");
    });

    it("returns a command header with its unsafe runs collapsed", () => {
      const headers = provenanceHeaders({
        ...BASE,
        command: "summarize Jane Doe's medical history for me",
      });
      expect(headers["x-cf-harness-command"]).toBe(
        "summarize_Jane_Doe_s_medical_history_for_me",
      );
    });

    it("returns no value derived from where the checkout lives", () => {
      const env = envFrom({
        HOME: "/home/somebody/src",
        PWD: "/home/somebody/src/loom-worktrees/thing",
      });
      const values = Object.values(
        provenanceHeaders(detectProvenance({ env })),
      );
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value).not.toMatch(/home|somebody|src|loom|worktrees/);
      }
    });

    it("returns no value carrying a coding agent's marker contents", () => {
      const env = envFrom({ CODEX_SANDBOX: "seatbelt" });
      const values = Object.values(
        provenanceHeaders(detectProvenance({ env })),
      );
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value).not.toMatch(/seatbelt/);
      }
    });
  });

  describe("provenanceUserAgent()", () => {
    it("returns the fields joined behind the product name", () => {
      expect(provenanceUserAgent({ ...BASE, command: "run" })).toBe(
        "cf-harness (principal=a1b2c3d4; invoker=cli; session=0123abcd; command=run)",
      );
    });

    it("returns the agent when one is present", () => {
      const env = envFrom({ CLAUDECODE: "1" });
      expect(provenanceUserAgent(detectProvenance({ env }))).toMatch(
        /agent=claude-code/,
      );
    });

    it("omits the service when no service name is set", () => {
      const agent = provenanceUserAgent(detectProvenance({ env: envFrom({}) }));
      expect(agent).not.toMatch(/service=/);
    });

    it("returns the product it is given in place of the harness", () => {
      expect(provenanceUserAgent(BASE, "toolshed")).toBe(
        "toolshed (principal=a1b2c3d4; invoker=cli; session=0123abcd)",
      );
    });

    it("returns a bounded product for one that would break the header", () => {
      expect(provenanceUserAgent(BASE, "tool shed (x)")).toMatch(
        /^tool_shed_x \(/,
      );
    });
  });

  describe("withRunManifest()", () => {
    it("returns `loom` as the invoker for a Loom manifest", () => {
      const folded = withRunManifest(BASE, {
        source: "loom",
        dispatchClass: "background",
      });
      expect(folded.invoker).toBe("loom");
      expect(folded.dispatch).toBe("background");
    });

    it("returns the provenance unchanged without a manifest", () => {
      expect(withRunManifest(BASE, undefined)).toEqual(BASE);
    });

    it("returns no identifier beyond the dispatch class", () => {
      const folded = withRunManifest(BASE, {
        source: "loom",
        dispatchClass: "background",
        ...{ wishId: "wish-secret", instanceId: "instance-secret" },
      });
      const values = Object.values(provenanceHeaders(folded));
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value).not.toMatch(/secret/);
      }
    });
  });

  describe("cfHarnessCliCommandName()", () => {
    it("returns the subcommand when it is one of the known set", () => {
      expect(cfHarnessCliCommandName(["auth", "login"])).toBe("auth");
      expect(cfHarnessCliCommandName(["models", "openai-codex"])).toBe(
        "models",
      );
      expect(cfHarnessCliCommandName(["whoami"])).toBe("whoami");
    });

    it("returns the subcommand past a leading `--`", () => {
      expect(cfHarnessCliCommandName(["--", "whoami"])).toBe("whoami");
    });

    it("returns `prompt` for an empty command line", () => {
      expect(cfHarnessCliCommandName([])).toBe("prompt");
    });

    it("returns `prompt` for an argument outside the known set", () => {
      expect(
        cfHarnessCliCommandName(["summarize Jane Doe's medical history"]),
      ).toBe("prompt");
    });
  });

  describe("whoami", () => {
    afterEach(() => setCurrentProvenance(undefined));

    const io = (out: string[], errors: string[]) => ({
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => errors.push(text),
    });

    it("returns 0 and prints every field it was given", async () => {
      const out: string[] = [];
      const code = await runCfHarnessCli(["whoami"], {
        io: io(out, []),
        provenance: { ...BASE, service: "toolshed-local" },
      });
      expect(code).toBe(0);
      const text = out.join("");
      expect(text).toMatch(/principal\s+a1b2c3d4/);
      expect(text).toMatch(/invoker\s+cli/);
      expect(text).toMatch(/service\s+toolshed-local/);
      // The line a person reads to recognize their own principal.
      expect(text).toMatch(/a1b2c3d4 is yours/);
    });

    it("returns the provenance as JSON given `--json`", async () => {
      const out: string[] = [];
      const code = await runCfHarnessCli(["whoami", "--json"], {
        io: io(out, []),
        provenance: { ...BASE, command: "whoami" },
      });
      expect(code).toBe(0);
      expect(JSON.parse(out.join(""))).toEqual({
        principal: "a1b2c3d4",
        invoker: "cli",
        session: "0123abcd-4567-89ef-0123-456789abcdef",
        command: "whoami",
      });
    });

    it("returns the bounded value rather than the one it was given", async () => {
      const out: string[] = [];
      await runCfHarnessCli(["whoami", "--json"], {
        io: io(out, []),
        provenance: { ...BASE, service: "a name with spaces" },
      });
      expect(JSON.parse(out.join("")).service).toBe("a_name_with_spaces");
    });

    it("reports the supplied provenance as the one this process uses", async () => {
      await runCfHarnessCli(["whoami"], {
        io: io([], []),
        provenance: { ...BASE, principal: "cafebabe" },
      });
      // The gateway client reads this same value when it builds its headers.
      const provenance = currentProvenance();
      expect(provenance.principal).toBe("cafebabe");
      expect(provenanceHeaders(provenance)["x-cf-harness-principal"]).toBe(
        "cafebabe",
      );
    });

    it("reports usage for an argument it does not understand", async () => {
      const errors: string[] = [];
      await runCfHarnessCli(["whoami", "--nope"], {
        io: io([], errors),
        provenance: BASE,
      });
      expect(errors.join("")).toMatch(/usage: whoami \[--json\]/);
    });
  });

  describe("OpenAICompatibleGatewayClient", () => {
    it("sends the provenance on every request", async () => {
      const calls: RequestInit[] = [];
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        provenance: { ...BASE, command: "prompt" },
        fetchFn: (_input, init) => {
          calls.push(init ?? {});
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      });

      await client.listModels();
      await client.createChatCompletion({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "my private prompt text" }],
      });

      expect(calls.length).toBe(2);
      for (const init of calls) {
        const headers = new Headers(init.headers);
        expect(headers.get("x-cf-harness-invoker")).toBe("cli");
        expect(headers.get("x-cf-harness-principal")).toBe("a1b2c3d4");
        expect(headers.get("x-cf-harness-command")).toBe("prompt");
        expect(headers.get("user-agent")).toBe(
          "cf-harness (principal=a1b2c3d4; invoker=cli; session=0123abcd; command=prompt)",
        );
      }
    });

    it("sends no header carrying any word of the request body", async () => {
      const secret = "Jane Doe was admitted on Tuesday";
      let seen: RequestInit | undefined;
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        provenance: { ...BASE },
        fetchFn: (_input, init) => {
          seen = init;
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      });

      await client.createChatCompletion({
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: secret },
          { role: "user", content: secret },
        ],
      });

      expect(String(seen?.body)).toContain(secret);
      // Whole words: a short word occurring inside an unrelated header value
      // does not register.
      for (const [, value] of new Headers(seen?.headers)) {
        for (const word of ["Jane", "Doe", "admitted", "Tuesday"]) {
          expect(value).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
        }
      }
    });
  });
});
