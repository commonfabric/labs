import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { runHarnessJob } from "../../src/harness-job.ts";
import { createLocalJobApi } from "../../src/local-jobs/api.ts";
import { localJobSpecOf } from "../../src/local-jobs/lane.ts";
import {
  narrowLocalJobProfile,
  readLocalJobProfiles,
} from "../../src/local-jobs/profiles.ts";
import { LocalJobStore } from "../../src/local-jobs/store.ts";
import { answerReply, scriptedJob } from "../fixtures/scripted-job.ts";

describe("local-job host mounts", () => {
  let root: string;
  let hostPath: string;
  let store: LocalJobStore;

  beforeEach(async () => {
    root = await Deno.makeTempDir();
    hostPath = await Deno.realPath(root);
    store = LocalJobStore.open(":memory:");
  });

  afterEach(async () => {
    store.close();
    await Deno.remove(root, { recursive: true });
  });

  const mount = () => ({
    name: "documents",
    hostPath,
    sandboxPath: "/documents",
    mode: "writable" as const,
  });

  const profileFile = (hostMounts: unknown = [mount()]) => ({
    chat: {
      tools: [],
      taskRole: "direct-command",
      retry: "never",
      maxModelTurns: 4,
      model: "scripted",
      hostMounts,
    },
  });

  const read = async (hostMounts: unknown = [mount()]) => {
    const path = join(root, "profiles.json");
    await Deno.writeTextFile(path, JSON.stringify(profileFile(hostMounts)));
    return await readLocalJobProfiles(path);
  };

  const api = async (hostMounts: unknown = [mount()]) => {
    const profiles = await read(hostMounts);
    const handle = createLocalJobApi({
      store,
      profiles,
      token: "token",
      kick: () => {},
      cancel: (id) => store.requestCancel(id),
    });
    const post = (body: Record<string, unknown>) =>
      handle(
        new Request("http://localhost/jobs", {
          method: "POST",
          headers: { authorization: "Bearer token" },
          body: JSON.stringify({
            caller: "test",
            profile: "chat",
            idempotencyKey: "first",
            task: "Read the documents",
            resultSchema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
            ...body,
          }),
        }),
      );
    return { profiles, post };
  };

  it("retains and normalizes the host's mount grant when reading the file", async () => {
    const profiles = await read([{ ...mount(), sandboxPath: "/documents/./" }]);
    expect(profiles.get("chat")?.hostMounts).toEqual([mount()]);
  });

  it("resolves a relative host path from the profile file's directory", async () => {
    const profiles = await read([{ ...mount(), hostPath: "." }]);
    expect(profiles.get("chat")?.hostMounts).toEqual([mount()]);
  });

  it("selects only named mounts without changing the host's grant", async () => {
    const other = { ...mount(), name: "reference", sandboxPath: "/reference" };
    const profile = (await read([mount(), other])).get("chat")!;
    const narrowed = narrowLocalJobProfile(profile, {
      hostMounts: [{ name: "reference", mode: "readonly" }],
    });
    expect(narrowed).toMatchObject({
      profile: { hostMounts: [{ ...other, mode: "readonly" }] },
    });
    expect(profile.hostMounts).toEqual([mount(), other]);
  });

  it("refuses a host path whose resolved name cannot be passed to the CLI", async () => {
    const source = join(root, "with,comma");
    await Deno.mkdir(source);
    const link = join(root, "source");
    await Deno.symlink(source, link);
    await expect(read([{ ...mount(), hostPath: link }])).rejects.toThrow(
      "Local job profile `chat`:",
    );
  });

  for (
    const invalid of [
      { sandboxPath: "relative" },
      { sandboxPath: "/" },
      { name: "-documents" },
      { mode: "rw" },
      { hostPath: "/" },
      { hostPath: "/nonexistent/local-job-host-mount" },
      { hostPath: 42 },
      { name: "documents,mode=readonly" },
    ]
  ) {
    it(`refuses an invalid profile mount at startup: ${JSON.stringify(invalid)}`, async () => {
      await expect(read([{ ...mount(), ...invalid }])).rejects.toThrow(
        "Local job profile `chat`:",
      );
    });
  }

  it("refuses duplicate names and a mount list of the wrong shape", async () => {
    for (const invalid of [[mount(), mount()], {}, [null], ["documents"]]) {
      await expect(read(invalid)).rejects.toThrow("Local job profile `chat`:");
    }
  });

  for (
    const requested of [
      [{ name: "ungranted" }],
      [{ name: "documents", mode: "writable" }],
    ]
  ) {
    it(`returns 400 beyond_profile for ${JSON.stringify(requested)} under a readonly grant`, async () => {
      const { post } = await api([{ ...mount(), mode: "readonly" }]);
      const response = await post({ hostMounts: requested });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "beyond_profile" });
      expect(store.list(10)).toEqual([]);
    });
  }

  it("refuses malformed narrowing and caller-supplied mount paths", async () => {
    const { post } = await api();
    for (
      const invalid of [
        null,
        {},
        [null],
        [{ name: "documents", mode: "ro" }],
        [{ name: "documents", hostPath: "/another" }],
        [{ name: "documents", sandboxPath: "/another" }],
        [{ name: "documents" }, { name: "documents" }],
      ]
    ) {
      const response = await post({ hostMounts: invalid });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(store.list(10)).toEqual([]);
  });

  it("counts mount selection and mode in the idempotency fingerprint", async () => {
    const { post } = await api();
    const selection = [{ name: "documents" }];
    expect((await post({ hostMounts: selection })).status).toBe(201);
    expect((await post({ hostMounts: selection })).status).toBe(200);
    for (
      const changed of [undefined, [], [{
        name: "documents",
        mode: "readonly",
      }]]
    ) {
      const response = await post({ hostMounts: changed });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "idempotency_conflict",
      });
    }
  });

  for (
    const [label, selection, mode] of [
      ["inherits the grant", undefined, "writable"],
      ["retains a selected mount's mode", [{ name: "documents" }], "writable"],
      ["narrows writable to readonly", [{
        name: "documents",
        mode: "readonly",
      }], "readonly"],
      ["removes every mount", [], undefined],
    ] as const
  ) {
    it(`${label} through the harness CLI and re-applies it on a follow-up`, async () => {
      // The scripted fixture runs workspace I/O only; its runsc binary and
      // rootfs do not exist. Inspect the real harness's resolved bind mounts
      // before that fixture replaces the runtime.
      const { profiles, post } = await api();
      const response = await post({ hostMounts: selection });
      expect(response.status).toBe(201);
      const { job } = await response.json();
      expect(store.get(job.id)?.request.hostMounts).toEqual(selection);
      const narrowed = narrowLocalJobProfile(
        profiles.get("chat")!,
        job.request,
      );
      if ("refusal" in narrowed) throw new Error(narrowed.refusal);
      expect(narrowed.profile.hostMounts).toEqual(
        mode === undefined ? [] : [{ ...mount(), mode }],
      );
      const spec = await localJobSpecOf(
        store.get(job.id)!,
        narrowed.profile,
        {},
      );
      const script = scriptedJob(() => answerReply("done"));
      const createLoop = script.deps.createPromptLoop!;
      let calls = 0;
      script.deps.createPromptLoop = (options) => {
        const mounts = options.engine!.sandbox.describe().cfc?.mounts ?? [];
        expect(mounts.filter((m) => m.kind === "host-bind")).toEqual(
          mode === undefined ? [] : [{
            kind: "host-bind",
            name: "documents",
            hostPath,
            sandboxPath: "/documents",
            readOnly: mode === "readonly",
            mode,
          }],
        );
        calls++;
        return createLoop(options);
      };
      const first = await runHarnessJob(spec, {
        runRoot: join(root, "first"),
        signal: new AbortController().signal,
        harnessDeps: script.deps,
      });
      expect(first).toMatchObject({ outcome: "completed" });
      store.claimNext();
      store.finish(job.id, {
        state: "completed",
        report: { ...first.report },
        recordedRun: true,
      });
      const accepted = store.acceptMessage(job.id, {
        caller: "test",
        idempotencyKey: "next",
        message: "Continue reading",
      });
      if (!("job" in accepted)) throw new Error(accepted.error);
      expect(accepted.job.request.hostMounts).toEqual(selection);
      const nextProfile = narrowLocalJobProfile(
        profiles.get("chat")!,
        accepted.job.request,
      );
      if ("refusal" in nextProfile) throw new Error(nextProfile.refusal);
      const nextSpec = await localJobSpecOf(accepted.job, nextProfile.profile, {
        predecessorRunRef: first.report!.runRef!,
      });
      const next = await runHarnessJob(nextSpec, {
        runRoot: join(root, "next"),
        signal: new AbortController().signal,
        harnessDeps: script.deps,
      });
      expect(next.outcome).toBe("completed");
      expect(calls).toBe(2);
      for (const request of script.requests) {
        const system = request.transcript.find((m) =>
          m.role === "system"
        )!.content;
        if (mode === undefined) {
          expect(system).not.toContain("Additional host mounts");
        } else {
          expect(system).toContain(`/documents: ${mode} (documents)`);
        }
      }
    });
  }
});
