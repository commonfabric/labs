/** Sends follow-up attachments through the API and real harness prompt loop. */
import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { HarnessUserTranscriptMessage } from "@commonfabric/cf-harness/contracts/transcript";
import type { HarnessModelTurnRequest } from "@commonfabric/cf-harness/model/client";
import { readHarnessRunArtifacts } from "@commonfabric/cf-harness/artifacts";
import {
  parseHandleRef,
  resolveHandleToken,
} from "@commonfabric/cf-harness/handle-table";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createLocalJobApi } from "../../src/local-jobs/api.ts";
import { LocalJobLane } from "../../src/local-jobs/lane.ts";
import type { LocalJobProfile } from "../../src/local-jobs/profiles.ts";
import {
  LOCAL_JOB_TERMINAL_STATES,
  type LocalJob,
  LocalJobStore,
} from "../../src/local-jobs/store.ts";
import { scriptedJob, toolReply } from "../fixtures/scripted-job.ts";

const png = { mediaType: "image/png", base64: "iVBORw0KGgo=" };
const gif = { mediaType: "image/gif", base64: "R0lGODlh" };

/** The model-visible user messages, excluding ephemeral host notices. */
const userMessagesOf = (request: HarnessModelTurnRequest) =>
  request.transcript.filter((entry): entry is HarnessUserTranscriptMessage =>
    entry.role === "user" && !entry.turnLocal
  );

/** Resolves on this job's terminal store event, including unexpected failures. */
const ended = (store: LocalJobStore, id: string) =>
  new Promise<LocalJob>((resolve) => {
    const check = () => {
      const job = store.get(id)!;
      if (LOCAL_JOB_TERMINAL_STATES.has(job.state)) {
        stop();
        resolve(job);
      }
    };
    const stop = store.subscribe((jobId) => {
      if (jobId === id) check();
    });
    check();
  });

describe("local-jobs/lane attachments", () => {
  let dir: string;
  let store: LocalJobStore;
  let lane: LocalJobLane;
  let runtime: Runtime | undefined;
  let storage: ReturnType<typeof StorageManager.emulate> | undefined;
  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    store = LocalJobStore.open(join(dir, "jobs.sqlite"));
  });
  afterEach(async () => {
    await lane?.stop();
    store.close();
    await runtime?.dispose();
    await storage?.close();
    runtime = undefined;
    storage = undefined;
    await Deno.remove(dir, { recursive: true });
  });

  const start = (
    script: ReturnType<typeof scriptedJob>,
    extra: Partial<LocalJobProfile> = {},
  ) => {
    const profiles = new Map<string, LocalJobProfile>([["chat", {
      tools: ["read_file", "write_file"],
      taskRole: "direct-command",
      retry: "never",
      maxModelTurns: 4,
      model: "scripted",
      ...extra,
    }]]);
    lane = new LocalJobLane({
      store,
      profiles,
      workRoot: join(dir, "runs"),
      maxConcurrent: 1,
      harnessDeps: script.deps,
    });
    const api = createLocalJobApi({
      store,
      profiles,
      token: "test",
      kick: () => lane.kick(),
      cancel: (id) => lane.cancel(id),
    });
    const call = (path: string, body?: unknown) =>
      api(
        new Request(`http://runner${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer test" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const enqueue = async (attachments: Record<string, unknown> = {}) => {
      const response = await call("/jobs", {
        caller: "test",
        profile: "chat",
        idempotencyKey: "first",
        task: "Answer the first message",
        ...attachments,
      });
      expect(response.status).toBe(201);
      return (await response.json()).job as LocalJob;
    };
    const message = (
      id: string,
      attachments: Record<string, unknown> = {},
      key = "follow",
    ) =>
      call(`/jobs/${id}/messages`, {
        caller: "test",
        idempotencyKey: key,
        message: "Answer this follow-up",
        ...attachments,
      });
    const finish = async (id: string) => {
      await ended(store, id);
      const job = (await (await call(`/jobs/${id}`)).json()).job as LocalJob;
      return job;
    };
    return { call, profiles, enqueue, message, finish };
  };
  const answers = () =>
    scriptedJob((_request, index) => ({
      role: "assistant",
      content: `Answer ${index + 1}`,
    }));

  const fabric = async (
    script: ReturnType<typeof scriptedJob>,
    foreign = false,
  ) => {
    const pkcs8 = await Identity.generatePkcs8();
    const signer = await Identity.fromPkcs8(pkcs8);
    const identityKeyPath = join(dir, "identity.key");
    await Deno.writeFile(identityKeyPath, pkcs8);
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcEnforcementMode: "disabled",
    });
    const pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: signer.did() }),
      runtime,
    );
    await pieces.synced();
    const otherSpace = foreign
      ? (await Identity.fromPassphrase("foreign attachment space")).did()
      : pieces.getSpace();
    const routes = foreign ? { [otherSpace]: "http://foreign.test/" } : {};
    const seenRoutes: unknown[] = [];
    const refs: string[] = [];
    for (const [index, name] of ["old", "new"].entries()) {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        index === 0 ? pieces.getSpace() : otherSpace,
        `attachment-${name}`,
        undefined,
        tx,
      );
      cell.set(`Cell ${index}`);
      expect((await tx.commit().settled).ok).toBeDefined();
      refs.push(
        createLLMFriendlyLink(
          cell.getAsNormalizedFullLink(),
          pieces.getSpace(),
        ),
      );
    }
    const factory = () => Promise.resolve({ pieces, foreignSpaces: routes });
    script.deps.fabricSessionFactory = factory;
    const createLoop = script.deps.createPromptLoop!;
    script.deps.createPromptLoop = (options) => {
      seenRoutes.push(options.fabricSession?.foreignSpaces);
      // The CLI admits fresh input context after making its loop wrapper.
      // Copy its engine into the scripted loop only once that context exists.
      let loop: ReturnType<typeof createLoop> | undefined;
      const get = () =>
        loop ??= createLoop({ ...options, fabricSessionFactory: factory });
      return {
        classifyTask: (task) => get().classifyTask!(task),
        runPrompt: (prompt) => get().runPrompt(prompt),
        runTranscript: (transcript) => get().runTranscript(transcript),
      };
    };
    return {
      profile: {
        fabric: {
          host: "http://toolshed.test",
          space: signer.did(),
          identityKeyPath,
        },
      },
      refs,
      routes,
      seenRoutes,
    };
  };

  it("puts a new image on the follow-up prompt and keeps prior image bytes unchanged", async () => {
    const script = answers();
    const { enqueue, message, finish } = start(script);
    const first = await finish((await enqueue({ imageAttachments: [png] })).id);
    const firstImage = userMessagesOf(script.requests[0]).find((entry) =>
      entry.imageAttachments?.length
    )!;
    const path = firstImage.imageAttachments![0].hostPath;
    const before = await Deno.readFile(path);
    const response = await message(first.id, { imageAttachments: [gif] });
    expect(response.status).toBe(201);
    const { job: accepted } = await response.json();
    expect(accepted.openedBy.imageAttachments).toEqual([gif]);
    const next = await finish(accepted.id);
    expect(next.state).toBe("completed");
    const prompt = userMessagesOf(script.requests[1]).at(-1)!;
    expect(prompt.imageAttachments).toHaveLength(1);
    expect(prompt.imageAttachments![0].mediaType).toBe("image/gif");
    expect(await Deno.readFile(path)).toEqual(before);
    const thirdResponse = await message(next.id, {}, "third");
    const third = await finish((await thirdResponse.json()).job.id);
    expect(third.state).toBe("completed");
    expect(
      userMessagesOf(script.requests[2]).at(-1)!.imageAttachments,
    ).toBeUndefined();
  });

  for (const foreign of [false, true]) {
    it(`adds a ${foreign ? "foreign" : "local"} input handle while retaining prior handles and routes`, async () => {
      const script = answers();
      const { profile, refs, routes, seenRoutes } = await fabric(
        script,
        foreign,
      );
      const { enqueue, message, finish } = start(script, profile);
      const first = await finish(
        (await enqueue({ inputs: { original: refs[0] } })).id,
      );
      expect(first.state).toBe("completed");
      const prior = await readHarnessRunArtifacts(
        first.report!.runRef as string,
      );
      const response = await message(first.id, {
        inputs: { additional: refs[1] },
        foreignSpaces: routes,
      });
      expect(response.status).toBe(201);
      const next = await finish((await response.json()).job.id);
      expect(next.state).toBe("completed");
      const recorded = await readHarnessRunArtifacts(
        next.report!.runRef as string,
      );
      const added = recorded.runState.inputCells!.find((cell) =>
        cell.name === "additional"
      );
      expect(added).toBeDefined();
      expect(
        parseHandleRef(
          resolveHandleToken(recorded.runState.handleTable!, added!.token)!.ref,
        ),
      ).toEqual(parseHandleRef(refs[1]));
      expect(
        recorded.runState.inputCells!.find((cell) => cell.name === "original")!
          .token,
      ).toBe(prior.runState.inputCells![0].token);
      expect(
        script.requests[1].transcript.map((entry) => entry.content).join("\n"),
      ).toContain(`${added!.token} — additional`);
      const thirdResponse = await message(next.id, {}, "third");
      const third = await finish((await thirdResponse.json()).job.id);
      expect(third.state).toBe("completed");
      expect(
        (await readHarnessRunArtifacts(third.report!.runRef as string)).runState
          .inputCells,
      ).toEqual(recorded.runState.inputCells);
      if (foreign) {
        expect(seenRoutes[1]).toMatchObject(routes);
        expect(seenRoutes[2]).toMatchObject(routes);
      }
    });
  }

  for (const foreign of [false, true]) {
    it(`fails a colliding ${foreign ? "foreign" : "local"} input before any follow-up model call with the builder reason`, async () => {
      const script = answers();
      const { profile, refs, routes } = await fabric(script, foreign);
      const { enqueue, message, finish, call } = start(script, profile);
      const first = await finish(
        (await enqueue({
          inputs: { original: refs[foreign ? 1 : 0] },
          foreignSpaces: routes,
        })).id,
      );
      expect(first.state).toBe("completed");
      const response = await message(first.id, {
        inputs: { original: refs[foreign ? 0 : 1] },
      });
      expect(response.status).toBe(201);
      const next = await finish((await response.json()).job.id);
      expect(next).toMatchObject({
        state: "failed",
        errorCode: "PROVIDER_FAILURE",
        errorDetail: "--input-cell name `original` is already held by this run",
      });
      expect(script.requests).toHaveLength(1);
      expect(await (await call(`/jobs/${next.id}/events`)).text()).toContain(
        next.errorDetail!,
      );
    });
  }

  for (const field of ["instructions", "imageAttachments", "inputs"] as const) {
    it(`refuses ${field} as follow_up_only while the current model call runs`, async () => {
      const held = Promise.withResolvers<void>();
      const script = scriptedJob((request) => {
        held.resolve();
        return new Promise<never>((_resolve, reject) => {
          request.signal!.addEventListener(
            "abort",
            () => reject(request.signal!.reason),
            { once: true },
          );
        });
      });
      const { enqueue, message } = start(script);
      const first = await enqueue();
      await held.promise;
      const payload = field === "instructions"
        ? "New instructions"
        : field === "imageAttachments"
        ? [png]
        : {};
      const response = await message(first.id, { [field]: payload });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "follow_up_only" });
      expect(script.requests).toHaveLength(1);
    });
  }

  it("keeps a post-cancel image waiting for its own follow-up", async () => {
    const held = Promise.withResolvers<void>();
    let release!: () => void;
    const script = scriptedJob((request, index) => {
      if (index === 0) {
        return toolReply("write_file", {
          path: "/workspace/checkpoint.txt",
          content: "saved",
        });
      }
      if (index === 1) {
        held.resolve();
        return new Promise<never>((_resolve, reject) => {
          release = () => reject(request.signal!.reason);
        });
      }
      return { role: "assistant", content: "Image received" };
    });
    const { enqueue, message, finish } = start(script);
    const first = await enqueue();
    await held.promise;
    lane.cancel(first.id);
    try {
      const response = await message(first.id, { imageAttachments: [gif] });
      expect(response.status).toBe(201);
      expect((await response.json()).message.delivery).toBe("pending");
    } finally {
      release();
    }
    const prior = await finish(first.id);
    expect(prior.state).toBe("cancelled");
    const next = await finish(prior.continuedBy!);
    expect(next).toMatchObject({
      state: "completed",
      result: "Image received",
    });
    const prompt = userMessagesOf(script.requests[2]).at(-1)!;
    expect(prompt.imageAttachments).toHaveLength(1);
    expect(prompt.imageAttachments![0].mediaType).toBe("image/gif");
  });

  it("keeps attachment replay fingerprints durable and rejects a different image", async () => {
    const script = answers();
    const { enqueue, message, finish } = start(script);
    const first = await finish((await enqueue()).id);
    const response = await message(first.id, { imageAttachments: [png] });
    expect(response.status).toBe(201);
    const next = await finish((await response.json()).job.id);
    expect(next.state).toBe("completed");
    const changed = await message(first.id, { imageAttachments: [gif] });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "idempotency_conflict",
    });
    await lane.stop();
    store.close();
    store = LocalJobStore.open(join(dir, "jobs.sqlite"));
    const reopened = start(script);
    reopened.profiles.clear();
    const replay = await reopened.message(first.id, {
      imageAttachments: [png],
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).message.imageAttachments).toEqual([png]);
  });

  it("validates and narrows follow-up attachments with the enqueue rules", async () => {
    const script = answers();
    const { enqueue, message, finish } = start(script);
    const first = await finish((await enqueue()).id);
    for (
      const payload of [{ imageAttachments: [{ ...png, base64: "bad" }] }, {
        inputs: { item: 42 },
      }, { foreignSpaces: { space: 42 } }]
    ) {
      const response = await message(
        first.id,
        payload,
        JSON.stringify(payload),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    const response = await message(first.id, {
      inputs: { item: "/of:fid1:" + "A".repeat(43) },
    }, "beyond");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "beyond_profile" });
    expect(script.requests).toHaveLength(1);
  });
});
