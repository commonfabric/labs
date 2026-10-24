/**
 * Executes workflow shell steps with local command doubles and checks the
 * trust boundaries around the cross-repository Rapids deployment protocol.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { parse } from "@std/yaml";

import { z } from "zod";

import { commandWords } from "./ci-workflow.ts";

const stepSchema = z.object({
  id: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  shell: z.string().optional(),
  if: z.string().optional(),
  "continue-on-error": z.unknown().optional(),
  "working-directory": z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  with: z.record(z.string(), z.unknown()).default({}),
});

const jobSchema = z.object({
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  environment: z.string().optional(),
  "timeout-minutes": z.number().optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).default({}),
  steps: z.array(stepSchema),
});

const workflowSchema = z.object({
  name: z.string(),
  "run-name": z.string().optional(),
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()).optional(),
  concurrency: z.unknown().optional(),
  jobs: z.record(z.string(), jobSchema),
});

/** Fields of a workflow step that these protocol checks consume. */
type Step = z.infer<typeof stepSchema>;

/** Reads the committed workflow and validates the fields these tests consume. */
async function workflow(name: string) {
  return workflowSchema.parse(parse(
    await Deno.readTextFile(
      new URL(`../.github/workflows/${name}`, import.meta.url),
    ),
  ));
}

/** Returns the single step satisfying a protocol role, failing if ambiguous. */
function oneStep(steps: Step[], matches: (step: Step) => boolean): Step {
  const found = steps.filter(matches);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Runs the workflow's own shell with command doubles, recording their calls. */
async function runStep(
  step: Step,
  env: Record<string, string>,
  commands: Record<string, string>,
) {
  const dir = await Deno.makeTempDir({ prefix: "rapids-workflow-" });
  try {
    for (const [name, body] of Object.entries(commands)) {
      await Deno.writeTextFile(`${dir}/${name}`, `#!/bin/bash\n${body}\n`, {
        mode: 0o755,
      });
    }
    const run = z.string().parse(step.run);
    expect(step.shell).toBeUndefined();
    // Values must enter the shell through its environment, not source expansion.
    expect(run).not.toContain("${{");
    await Deno.writeTextFile(`${dir}/calls`, "");
    const result = await new Deno.Command("bash", {
      args: ["-e", "-c", run],
      cwd: dir,
      env: {
        PATH: `${dir}:${Deno.env.get("PATH")}`,
        CALLS: `${dir}/calls`,
        RUNNER_TEMP: dir,
        ...env,
      },
    }).output();
    return {
      code: result.code,
      calls: (await Deno.readTextFile(`${dir}/calls`)).trim(),
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const infraSha = "1234567890abcdef1234567890abcdef12345678";
const readerToken = "${{ steps.reader.outputs.token }}";

describe("rapids-workflows", () => {
  it("validates an exact production source before environment approval and rechecks the demo window", async () => {
    const production = await workflow("deploy-production.yml");
    expect(production.name).toBe("Manual Production Deployment");
    expect(production.permissions).toEqual({ contents: "read" });
    expect(production.concurrency).toEqual({
      group: "estuary-production-deployment",
      "cancel-in-progress": false,
    });
    const validate = production.jobs.validate;
    const deploy = production.jobs["deploy-estuary"];
    expect(deploy.needs).toBe("validate");
    expect(deploy.environment).toBe("estuary");
    const window = validate.steps[0];
    expect(deploy.steps[0]).toEqual(window);
    const deployment = oneStep(
      deploy.steps,
      (step) => step.id === "deployment",
    );
    expect(deploy.steps[deploy.steps.indexOf(deployment) - 1]).toEqual(window);
    expect(deployment.if).toBe("${{ !inputs.verify_only }}");
    const deno = oneStep(
      deploy.steps,
      (step) => step.uses === "./.github/actions/deno-setup",
    );
    expect(deno.if).toBe("${{ !inputs.verify_only }}");
    for (
      const [NOW, allowed] of [
        ["2026-10-19T22:15:15Z", false],
        ["2026-10-19T22:15:16Z", true],
        ["2026-10-22T22:15:15Z", true],
        ["2026-10-22T22:15:16Z", false],
      ] as const
    ) {
      expect(
        (await runStep(window, {
          SOURCE_BRANCH: "alex-daily",
          WORKFLOW_REF: "refs/heads/main",
          NOW,
        }, {
          date: 'printf "%s\\n" "$NOW"',
        })).code === 0,
      ).toBe(allowed);
    }
    expect(
      (await runStep(window, {
        SOURCE_BRANCH: "main",
        WORKFLOW_REF: "refs/heads/main",
      }, {})).code,
    ).toBe(0);
    for (
      const [SOURCE_BRANCH, WORKFLOW_REF] of [["rw_demo", "refs/heads/main"], [
        "alex-daily",
        "refs/heads/alex-daily",
      ], ["main", "refs/pull/1/merge"]]
    ) {
      expect((await runStep(window, { SOURCE_BRANCH, WORKFLOW_REF }, {})).code)
        .not.toBe(0);
    }
    const guard = oneStep(validate.steps, (step) => step.id === "resolve");
    for (const source of ["main", "alex-daily"]) {
      for (
        const status of ["ahead", "identical", "behind", "diverged", "", "null"]
      ) {
        const result = await runStep(guard, {
          DEPLOY_SHA: infraSha,
          SOURCE_BRANCH: source,
          GITHUB_REPOSITORY: "commonfabric/labs",
          GITHUB_OUTPUT: "/dev/stdout",
          STATUS: status,
        }, { gh: 'printf "%s\\n" "$@" > "$CALLS"\nprintf "%s\\n" "$STATUS"' });
        expect(result.code === 0).toBe(["ahead", "identical"].includes(status));
        expect(result.calls).toContain(`compare/${infraSha}...${source}`);
      }
    }
    for (
      const DEPLOY_SHA of [
        "",
        "main",
        infraSha.slice(1),
        infraSha.toUpperCase(),
        `${infraSha}\n`,
        "$(exit 0)",
      ]
    ) {
      const result = await runStep(guard, { DEPLOY_SHA }, {
        gh: 'echo called > "$CALLS"',
      });
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe("");
    }
    expect(
      (await runStep(guard, {
        DEPLOY_SHA: infraSha,
        SOURCE_BRANCH: "alex-daily",
        GITHUB_REPOSITORY: "commonfabric/labs",
      }, { gh: "exit 42" })).code,
    ).not.toBe(0);
  });

  it("collects all 21 workers and HTTPS and uploads only a complete bound Estuary receipt", async () => {
    const { steps } =
      (await workflow("deploy-production.yml")).jobs["deploy-estuary"];
    const remote = oneStep(steps, (step) => step.id === "evidence");
    expect(remote.with.capture_stdout).toBe(true);
    expect(remote.with.envs).toBe("DEPLOY_SHA");
    const script = z.string().parse(remote.with.script);
    expect(script).toContain("deploy@estuary.saga-castor.ts.net python3 -");
    const python = script.split("<<'PY'\n")[1].split("\nPY")[0];
    const collect = (fault: string) =>
      runStep(
        {
          ...remote,
          run: `python3 - <<'PY'\n${
            `import io, json, sys, urllib.request\nsys.argv = ["verify", "${infraSha}"]\n` +
            `class Response(io.StringIO):\n` +
            `    status = 200\n` +
            `    def __init__(self, url):\n` +
            `        self.url = url\n` +
            `        super().__init__(json.dumps({"gitSha": "wrong" if "${fault}" == "sha" and ":8013/" in url else sys.argv[1]}))\n` +
            `        if "${fault}" == "https" and url.startswith("https:"): self.status = 503\n` +
            `    def geturl(self): return "https://wrong.invalid" if "${fault}" == "redirect" else self.url\n` +
            `urllib.request.urlopen = Response\n`
          }${python}\nPY`,
        },
        {},
        {},
      );
    const collected = await collect("");
    expect(collected.code).toBe(0);
    for (const fault of ["sha", "https", "redirect"]) {
      expect((await collect(fault)).code).not.toBe(0);
    }
    const save = oneStep(
      steps,
      (step) => step.run?.includes("base64.b64decode") ?? false,
    );
    const run = {
      ...save,
      run: `${save.run}\ncat "$RUNNER_TEMP/receipt.json"`,
    };
    const env = {
      REMOTE_OUTPUT: collected.stdout,
      DEPLOY_SHA: infraSha,
      SOURCE_BRANCH: "alex-daily",
      VERIFY_ONLY: "true",
      GITHUB_REPOSITORY: "commonfabric/labs",
      GITHUB_SHA: infraSha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    };
    const saved = await runStep(run, env, {});
    expect(saved.code).toBe(0);
    const receipt = JSON.parse(saved.stdout);
    expect(receipt.workers).toHaveLength(21);
    expect(receipt).toMatchObject({
      repository: "commonfabric/labs",
      workflow_sha: infraSha,
      run_id: "123",
      run_attempt: "2",
      source_branch: "alex-daily",
      verify_only: true,
    });
    for (
      const REMOTE_OUTPUT of [
        "",
        collected.stdout.repeat(2),
        "ESTUARY_RECEIPT:bad-base64",
      ]
    ) {
      expect((await runStep(run, { ...env, REMOTE_OUTPUT }, {})).code).not.toBe(
        0,
      );
    }
    for (
      const workers of [receipt.workers.slice(1), [
        ...receipt.workers.slice(1),
        receipt.workers[1],
      ]]
    ) {
      const REMOTE_OUTPUT = "ESTUARY_RECEIPT:" +
        btoa(JSON.stringify({ ...receipt, workers }));
      expect((await runStep(run, { ...env, REMOTE_OUTPUT }, {})).code).not.toBe(
        0,
      );
    }
    const upload = oneStep(
      steps,
      (step) => step.uses?.startsWith("actions/upload-artifact@") ?? false,
    );
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(save));
    expect(upload.if).toBeUndefined();
    expect(upload.with.name).toBe(
      "estuary-deployment-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });

  it("publishes Labs binaries from CI without independently deploying a server", async () => {
    const ci = await workflow("deno.yml");
    expect(ci.jobs["attest-binaries"]).toBeDefined();
    expect(ci.jobs["deploy-shell-staging"]).toBeDefined();
    expect(ci.jobs["deploy-rapids"]).toBeUndefined();
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps) {
        expect(step.uses ?? "").not.toContain("ssh-action@");
        expect(`${step.run ?? ""} ${step.with.script ?? ""}`)
          .not.toMatch(/\/opt\/cf\/deploy/);
      }
    }
  });

  it("accepts only an infra revision on main and serializes deployments", async () => {
    const release = await workflow("rapids-release.yml");
    expect(release.name).toBe("Deploy Rapids release");
    expect(release["run-name"]).toBe("Deploy Rapids ${{ inputs.infra_sha }}");
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    const dispatch = z.object({
      inputs: z.record(
        z.string(),
        z.object({
          type: z.string(),
          required: z.boolean(),
        }),
      ),
    }).parse(release.on.workflow_dispatch);
    expect(dispatch.inputs).toEqual({
      infra_sha: { type: "string", required: true },
    });
    expect(release.concurrency).toEqual({
      group: "rapids-release-deploy",
      "cancel-in-progress": false,
    });
    expect(release.permissions).toEqual({ contents: "read" });
    expect(Object.keys(release.jobs)).toEqual(["deploy"]);
    const job = release.jobs.deploy;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("toolshed");
    expect(job["timeout-minutes"]).toBe(60);
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job.env).toEqual({
      INFRA_SHA: "${{ inputs.infra_sha }}",
      PYTHONDONTWRITEBYTECODE: "1",
    });
  });

  it("fails malformed revisions before creating credentials or reading checkout code", async () => {
    const { steps } = (await workflow("rapids-release.yml")).jobs.deploy;
    const guard = oneStep(steps, (step) => step.id === "validate-input");
    const reader = oneStep(steps, (step) => step.id === "reader");
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(reader));
    expect((await runStep(guard, { INFRA_SHA: infraSha }, {})).code).toBe(0);
    for (
      const sha of [
        "",
        "main",
        infraSha.slice(1),
        `${infraSha}0`,
        infraSha.toUpperCase(),
        `${infraSha}\n`,
        `${infraSha}^`,
        "$(exit 0)",
        `${infraSha}; true`,
      ]
    ) {
      expect((await runStep(guard, { INFRA_SHA: sha }, {})).code).not.toBe(0);
    }
  });

  it("executes infra code only after GitHub confirms the exact commit is on main", async () => {
    const { steps } = (await workflow("rapids-release.yml")).jobs.deploy;
    const guard = oneStep(steps, (step) => step.id === "validate-ancestry");
    const checkout = oneStep(
      steps,
      (step) => step.uses?.startsWith("actions/checkout@") ?? false,
    );
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(checkout));
    expect(guard.env.GH_TOKEN).toBe(readerToken);
    expect(checkout.with).toEqual({
      repository: "commonfabric/infra",
      ref: "${{ inputs.infra_sha }}",
      token: readerToken,
      path: "infra",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    const check = (status: string, code = "0") =>
      runStep(guard, {
        INFRA_SHA: infraSha,
        STATUS: status,
        GH_EXIT: code,
      }, {
        gh:
          'printf "%s\\n" "$@" > "$CALLS"\nprintf "%s\\n" "$STATUS"\nexit "$GH_EXIT"',
      });
    for (const status of ["ahead", "identical"]) {
      const result = await check(status);
      expect(result.code).toBe(0);
      expect(result.calls.split("\n")).toEqual([
        "api",
        `repos/commonfabric/infra/compare/${infraSha}...main`,
        "--jq",
        ".status",
      ]);
    }
    for (const status of ["behind", "diverged", "", "null", "unknown"]) {
      expect((await check(status)).code).not.toBe(0);
    }
    expect((await check("ahead", "42")).code).not.toBe(0);
  });

  it("uses a read-only evidence token and the existing bastion credentials", async () => {
    const { steps } = (await workflow("rapids-release.yml")).jobs.deploy;
    const reader = oneStep(steps, (step) => step.id === "reader");
    expect(reader.uses).toBe(
      "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
    );
    expect(reader.with).toEqual({
      "app-id": "${{ vars.RAPIDS_APP_ID }}",
      "private-key": "${{ secrets.RAPIDS_APP_PRIVATE_KEY }}",
      owner: "commonfabric",
      repositories: "infra,loom,labs,commonfabric-weaver,gvisor",
      "permission-contents": "read",
      "permission-actions": "read",
    });
    const deploy = oneStep(steps, (step) => step.id === "deploy");
    expect(deploy.uses).toBe(
      "appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2",
    );
    expect(deploy.env).toEqual({ GH_TOKEN: readerToken });
    expect(deploy.with.host).toBe("${{ secrets.BASTION_HOST }}");
    expect(deploy.with.key).toBe("${{ secrets.BASTION_SSH_PRIVATE_KEY }}");
    expect(deploy.with.username).toBe("bastion");
    expect(deploy.with.command_timeout).toBe("45m");
    expect(commandWords(z.string().parse(deploy.with.script))).toEqual([
      "/opt/cf/deploy-rapids.sh",
      '"$INFRA_SHA"',
    ]);
    expect(z.string().parse(deploy.with.envs).split(",")).toEqual([
      "GH_TOKEN",
      "INFRA_SHA",
      "GITHUB_SHA",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ]);
    expect(deploy.with.capture_stdout).toBe(true);
  });

  it("authenticates manifest reads after trusted checkout and confines the access token to candidate validation", async () => {
    const { steps } = (await workflow("rapids-release.yml")).jobs.deploy;
    const checkout = oneStep(
      steps,
      (step) => step.uses?.startsWith("actions/checkout@") ?? false,
    );
    const auth = oneStep(
      steps,
      (step) => step.uses?.startsWith("google-github-actions/auth@") ?? false,
    );
    const validate = oneStep(
      steps,
      (step) => step.run?.includes("--validate-only") ?? false,
    );
    expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(auth));
    expect(steps.indexOf(auth)).toBeLessThan(steps.indexOf(validate));
    expect(auth.with).toEqual({
      workload_identity_provider:
        "${{ vars.RAPIDS_ARTIFACT_WORKLOAD_IDENTITY_PROVIDER }}",
      service_account: "${{ vars.RAPIDS_ARTIFACT_SERVICE_ACCOUNT }}",
      token_format: "access_token",
      create_credentials_file: false,
    });
    const token = `\${{ steps.${auth.id}.outputs.access_token }}`;
    expect(auth.id).toBeDefined();
    expect(validate.env.RAPIDS_ARTIFACT_ACCESS_TOKEN).toBe(token);
    for (const step of steps.filter((step) => step !== validate)) {
      expect(step.env.RAPIDS_ARTIFACT_ACCESS_TOKEN).toBeUndefined();
      expect(JSON.stringify(step)).not.toContain(token);
    }
  });

  it("uploads proof only after candidate validation, deployment, and receipt validation succeed", async () => {
    const { steps } = (await workflow("rapids-release.yml")).jobs.deploy;
    const checkout = oneStep(
      steps,
      (step) => step.uses?.startsWith("actions/checkout@") ?? false,
    );
    const validate = oneStep(
      steps,
      (step) => step.run?.includes("--validate-only") ?? false,
    );
    const deploy = oneStep(steps, (step) => step.id === "deploy");
    const receipt = oneStep(
      steps,
      (step) => step.run?.includes("--save-receipt") ?? false,
    );
    const upload = oneStep(
      steps,
      (step) => step.uses?.startsWith("actions/upload-artifact@") ?? false,
    );
    const order = [checkout, validate, deploy, receipt, upload].map((step) =>
      steps.indexOf(step)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Default success gating stops at every failed boundary, including upload.
    for (const step of steps) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(receipt.env.RAPIDS_REMOTE_OUTPUT).toBe(
      "${{ steps.deploy.outputs.stdout }}",
    );
    for (
      const [step, args] of [
        [validate, ["--validate-only"]],
        [receipt, ["--save-receipt", "/runner-temp/receipt.json"]],
      ] as const
    ) {
      expect(step["working-directory"]).toBe(checkout.with.path);
      expect(step.env.GH_TOKEN).toBe(readerToken);
      for (const code of ["0", "42"]) {
        const result = await runStep(step, {
          INFRA_SHA: infraSha,
          RUNNER_TEMP: "/runner-temp",
          VALIDATION_EXIT: code,
        }, {
          python3: 'printf "%s\\n" "$@" > "$CALLS"\nexit "$VALIDATION_EXIT"',
        });
        expect(result.calls.split("\n")).toEqual([
          "releases/rapids_deploy.py",
          infraSha,
          ...args,
        ]);
        expect(result.code).toBe(Number(code));
      }
    }
    expect(upload.with).toEqual({
      name: "rapids-deployment-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/receipt.json",
      "if-no-files-found": "error",
      "retention-days": 90,
    });
  });

  it("notifies infra of every main deployment outcome and Loom only of green main CI", async () => {
    const notify = await workflow("notify-rapids.yml");
    expect(notify.permissions).toEqual({});
    expect(notify.on).toEqual({
      workflow_run: {
        workflows: [
          "CI",
          "Deploy Rapids release",
          "Manual Production Deployment",
        ],
        types: ["completed"],
        branches: ["main"],
      },
    });
    const green = {
      name: "CI",
      path: ".github/workflows/deno.yml",
      event: "push",
      conclusion: "success",
      head_branch: "main",
      head_repository: { full_name: "commonfabric/labs" },
    };
    for (const target of ["infra", "loom"]) {
      const job = notify.jobs[`notify-${target}`];
      // These guards use the shared boolean/property subset of Actions and JS.
      const accepts = new Function(
        "github",
        `return (${z.string().parse(job.if)});`,
      );
      const allowed = (run: typeof green) =>
        accepts({
          repository: "commonfabric/labs",
          event: { workflow_run: run },
        });
      expect(allowed(green)).toBe(true);
      const deployed = {
        ...green,
        name: `Deploy Rapids ${infraSha}`,
        path: ".github/workflows/rapids-release.yml",
        event: "workflow_dispatch",
      };
      for (const conclusion of ["failure", "cancelled", "skipped"]) {
        expect(allowed({ ...green, conclusion })).toBe(false);
      }
      for (const conclusion of ["success", "failure", "cancelled", "skipped"]) {
        expect(allowed({
          ...deployed,
          conclusion,
        })).toBe(target === "infra");
      }
      for (
        const changes of [
          { head_branch: "feature" },
          { head_repository: { full_name: "contributor/labs" } },
          { event: "pull_request" },
          { path: ".github/workflows/test-order-tomorrow.yml" },
        ]
      ) {
        expect(allowed({ ...green, ...changes })).toBe(false);
        expect(allowed({ ...deployed, ...changes })).toBe(false);
      }
      const token = oneStep(
        job.steps,
        (step) =>
          step.uses?.startsWith("actions/create-github-app-token@") ?? false,
      );
      expect(token.with.repositories).toBe(target);
      expect(token.with["permission-actions"]).toBe("write");
      expect(token.with["permission-contents"]).toBe("read");
      expect(job.steps.some((step) => step.uses?.includes("checkout@")))
        .toBe(false);
    }
  });

  it("wakes Estuary for production workflow completions inside the authorization window", async () => {
    const job = (await workflow("notify-rapids.yml")).jobs["notify-infra"];
    const accepts = new Function("github", `return (${job.if});`);
    const run = {
      path: ".github/workflows/deploy-production.yml",
      event: "workflow_dispatch",
      conclusion: "success",
      head_branch: "main",
      head_repository: { full_name: "commonfabric/labs" },
      display_title: "Manual Production Deployment",
    };
    const allowed = (changes: Partial<typeof run> = {}) =>
      accepts({
        repository: "commonfabric/labs",
        event: { workflow_run: { ...run, ...changes } },
      });
    expect(allowed()).toBe(true);
    expect(
      allowed({
        display_title: `Estuary ${infraSha} from alex-daily (verify=true)`,
      }),
    ).toBe(true);
    for (const conclusion of ["success", "failure", "cancelled", "skipped"]) {
      expect(allowed({ conclusion })).toBe(true);
    }
    expect(
      allowed({
        display_title: `Estuary ${infraSha} from main (verify=false)`,
      }),
    ).toBe(true);
    for (
      const changes of [
        { head_branch: "alex-daily" },
        { event: "pull_request" },
        { head_repository: { full_name: "contributor/labs" } },
        { path: ".github/workflows/other.yml" },
      ]
    ) expect(allowed(changes)).toBe(false);
    const send = oneStep(
      job.steps,
      (step) => step.run?.includes("gh api") ?? false,
    );
    for (
      const [NOW, enabled] of [
        ["2026-10-19T22:15:15Z", false],
        ["2026-10-19T22:15:16Z", true],
        ["2026-10-22T22:15:15Z", true],
        ["2026-10-22T22:15:16Z", false],
      ] as const
    ) {
      const result = await runStep(send, { WORKFLOW_PATH: run.path, NOW }, {
        gh: 'printf "%s\\n" "$@" > "$CALLS"',
        date: 'printf "%s\\n" "$NOW"',
      });
      expect(result.code).toBe(0);
      expect(result.calls.split("\n")).toEqual(
        enabled
          ? [
            "api",
            "--method",
            "POST",
            "repos/commonfabric/infra/actions/workflows/rapids.yml/dispatches",
            "-f",
            "ref=main",
            "-f",
            "inputs[channel]=estuary",
          ]
          : [""],
      );
    }
    expect(
      (await runStep(send, {
        WORKFLOW_PATH: run.path,
        NOW: "2026-10-20T00:00:00Z",
      }, {
        gh: "exit 42",
        date: 'printf "%s\\n" "$NOW"',
      })).code,
    ).toBe(42);
  });

  it("sends paired producer hints for CI and an empty-input reconciliation for deployment", async () => {
    const notify = await workflow("notify-rapids.yml");
    for (const target of ["infra", "loom"]) {
      const job = notify.jobs[`notify-${target}`];
      const send = oneStep(
        job.steps,
        (step) => step.run?.includes("gh api") ?? false,
      );
      expect(send.env.GH_TOKEN).toBe("${{ steps.token.outputs.token }}");
      expect(send.env.PRODUCER_RUN).toBe("${{ github.event.workflow_run.id }}");
      if (target === "infra") {
        expect(send.env.WORKFLOW_PATH).toBe(
          "${{ github.event.workflow_run.path }}",
        );
      }
      for (
        const path of target === "infra"
          ? [
            ".github/workflows/deno.yml",
            ".github/workflows/rapids-release.yml",
          ]
          : [".github/workflows/deno.yml"]
      ) {
        const result = await runStep(send, {
          WORKFLOW_PATH: path,
          PRODUCER_RUN: "2468",
        }, {
          gh:
            'printf "%s\\n" "$@" > "$CALLS"\nif [[ "$*" == *"--input -"* ]]; then cat >> "$CALLS"; fi',
        });
        expect(result.code).toBe(0);
        const endpoint = target === "infra"
          ? "rapids.yml"
          : "rapids-dependencies.yml";
        const request = [
          "api",
          "--method",
          "POST",
          `repos/commonfabric/${target}/actions/workflows/${endpoint}/dispatches`,
        ];
        expect(result.calls.split("\n")).toEqual(
          path === ".github/workflows/deno.yml"
            ? [
              ...request,
              "-f",
              "ref=main",
              "-f",
              "inputs[producer]=commonfabric/labs",
              "-f",
              "inputs[run_id]=2468",
            ]
            : [...request, "--input", "-", '{"ref":"main","inputs":{}}'],
        );
      }
    }
  });
});
