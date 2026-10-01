import { basename, join } from "@std/path";

import { maxOf, minOf } from "@commonfabric/utils/math";

import type { Page } from "../page.ts";
import type { PresentationConfig, PresentationParticipant } from "./config.ts";
import { presentationConfig } from "./config.ts";
import {
  composeParticipants,
  encodeParticipant,
  findFfmpeg,
} from "./encode.ts";
import {
  installPresentationInteractions,
  presentationInteractions,
} from "./interactions.ts";
import type {
  DemoManifest,
  DemoParticipantManifest,
  DemoStep,
} from "./manifest.ts";
import { writeManifest } from "./manifest.ts";
import { FrameRecorder } from "./recorder.ts";

const COLORS = ["#7c3aed", "#0891b2", "#dc2626", "#16a34a"];

type ParticipantState = {
  page: Page;
  manifest: DemoParticipantManifest;
  recorder: FrameRecorder;
  started: boolean;
  stopped: boolean;
  removeAfterNavigationHook: () => void;
};

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
  "participant";

export class PresentationSession {
  readonly #config: Extract<PresentationConfig, { enabled: true }>;
  readonly #origin = performance.now();
  readonly #participants: ParticipantState[] = [];
  readonly #byPage = new WeakMap<Page, ParticipantState>();
  readonly #steps: DemoStep[] = [];
  readonly #manifest: DemoManifest;
  #manifestWriteTail: Promise<void> = Promise.resolve();
  #finalized = false;

  constructor(config: Extract<PresentationConfig, { enabled: true }>) {
    this.#config = config;
    this.#manifest = {
      version: 1,
      runId: basename(config.outputDir),
      status: "recording",
      startedAt: new Date().toISOString(),
      viewport: config.viewport,
      participants: [],
      steps: this.#steps,
    };
  }

  enabled(): true {
    return true;
  }

  async register(
    page: Page,
    requested: PresentationParticipant = {},
  ): Promise<void> {
    if (this.#byPage.has(page)) return;
    const index = this.#participants.length;
    const label = requested.label ?? `Participant ${index + 1}`;
    const baseId = requested.id ?? slug(label);
    let id = baseId;
    let suffix = 2;
    while (this.#participants.some((item) => item.manifest.id === id)) {
      id = `${baseId}-${suffix++}`;
    }
    const color = requested.color ?? COLORS[index % COLORS.length];
    const participantDir = join(this.#config.outputDir, "participants", id);
    await page.setViewportSize(this.#config.viewport);
    installPresentationInteractions(page, this.#config, { label, color });
    const removeAfterNavigationHook = page.addAfterNavigationHook(
      () => this.start(page),
    );
    const recorder = new FrameRecorder(page, {
      participantDir,
      id,
      label,
      color,
      quality: this.#config.jpegQuality,
      viewport: this.#config.viewport,
      finalHoldMs: this.#config.postResultHoldMs,
      clock: { now: () => this.now() },
    });
    const state: ParticipantState = {
      page,
      recorder,
      started: false,
      stopped: false,
      manifest: recorder.manifest(),
      removeAfterNavigationHook,
    };
    this.#participants.push(state);
    this.#byPage.set(page, state);
    this.#syncManifest();
  }

  async start(page: Page): Promise<void> {
    const state = this.#byPage.get(page);
    if (!state || state.started || state.stopped) return;
    await presentationInteractions(page)?.prepareDocument();
    await state.recorder.start();
    state.started = true;
    state.manifest = state.recorder.manifest();
    this.#syncManifest();
  }

  async close(page: Page): Promise<void> {
    const state = this.#byPage.get(page);
    if (!state || state.stopped) return;
    state.stopped = true;
    try {
      if (state.started) {
        await presentationInteractions(page)?.hold(
          this.#config.postResultHoldMs,
        );
        state.manifest = await state.recorder.stop();
      }
    } catch (cause) {
      state.manifest = state.recorder.manifest();
      state.manifest.error = cause instanceof Error
        ? cause.message
        : String(cause);
      this.#manifest.status = "capture-failed";
      this.#manifest.error ??= state.manifest.error;
    } finally {
      state.removeAfterNavigationHook();
      presentationInteractions(page)?.uninstall();
      this.#syncManifest();
    }
    if (this.#participants.every((participant) => participant.stopped)) {
      await this.finalize();
    }
  }

  async step<T>(
    label: string,
    action: () => Promise<T>,
    participantId?: string,
  ): Promise<T> {
    const step: DemoStep = {
      label,
      participantId,
      startedAtMs: this.now(),
    };
    this.#steps.push(step);
    await Promise.all(
      this.#participants
        .filter((participant) => participant.started && !participant.stopped)
        .map((participant) =>
          presentationInteractions(participant.page)?.showCaption(label)
        ),
    );
    try {
      return await action();
    } catch (cause) {
      step.failed = true;
      this.#manifest.status = "test-failed";
      this.#manifest.error ??= cause instanceof Error
        ? cause.message
        : String(cause);
      throw cause;
    } finally {
      step.endedAtMs = this.now();
      await Promise.all(
        this.#participants
          .filter((participant) => participant.started && !participant.stopped)
          .map(async (participant) => {
            const presentation = presentationInteractions(participant.page);
            await presentation?.hold(this.#config.postResultHoldMs);
            await presentation?.clearCaption();
          }),
      );
      await this.writeManifest();
    }
  }

  now(): number {
    return performance.now() - this.#origin;
  }

  async finalize(): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    await Deno.mkdir(this.#config.outputDir, { recursive: true });
    const usable = this.#participants.filter((participant) =>
      participant.manifest.frames.length > 0 && !participant.manifest.error
    );
    if (usable.length === 0) {
      this.#manifest.status = "capture-failed";
      this.#manifest.error ??= "no participant produced a usable recording";
      await this.writeManifest();
      throw new Error(this.#manifest.error);
    }
    try {
      this.#normalizeTimelines(usable);
      const { command } = await findFfmpeg();
      const streams: string[] = [];
      for (const participant of usable) {
        const participantDir = join(
          this.#config.outputDir,
          "participants",
          participant.manifest.id,
        );
        const streamPath = join(participantDir, "stream.mp4");
        await encodeParticipant({
          ffmpeg: command,
          participantDir,
          frames: participant.manifest.frames,
          outputPath: streamPath,
        });
        participant.manifest.streamPath = streamPath;
        streams.push(streamPath);
      }
      const outputPath = join(
        this.#config.outputDir,
        this.#config.videoFileName,
      );
      await composeParticipants({ ffmpeg: command, streams, outputPath });
      this.#manifest.outputPath = outputPath;
      if (this.#manifest.status === "recording") {
        this.#manifest.status = "passed";
      }
      this.#syncManifest();
      await this.writeManifest();
      if (!this.#config.keepFrames && this.#manifest.status === "passed") {
        for (const participant of usable) {
          const framesDir = join(
            this.#config.outputDir,
            "participants",
            participant.manifest.id,
            "frames",
          );
          await Deno.remove(framesDir, { recursive: true }).catch(() => {});
        }
      }
      console.log(`Demo video: ${outputPath}`);
    } catch (cause) {
      this.#manifest.status = "encode-failed";
      this.#manifest.error = cause instanceof Error
        ? cause.message
        : String(cause);
      await this.writeManifest();
      throw cause;
    }
  }

  async writeManifest(): Promise<void> {
    const write = this.#manifestWriteTail.then(async () => {
      await Deno.mkdir(this.#config.outputDir, { recursive: true });
      this.#syncManifest();
      await writeManifest(
        join(this.#config.outputDir, "manifest.json"),
        this.#manifest,
      );
    });
    this.#manifestWriteTail = write.catch(() => {});
    await write;
  }

  #syncManifest(): void {
    this.#manifest.participants = this.#participants.map((participant) =>
      participant.manifest
    );
  }

  #normalizeTimelines(participants: ParticipantState[]): void {
    const start = minOf(
      participants.map((participant) =>
        participant.manifest.captureStartedAtMs
      ),
    );
    const end = maxOf(
      participants.map((participant) =>
        participant.manifest.captureEndedAtMs ??
          participant.manifest.captureStartedAtMs
      ),
    );
    for (const participant of participants) {
      const frames = participant.manifest.frames;
      frames[0].durationSeconds += Math.max(
        0,
        (participant.manifest.captureStartedAtMs - start) / 1000,
      );
      frames.at(-1)!.durationSeconds += Math.max(
        0,
        (end - (participant.manifest.captureEndedAtMs ?? end)) / 1000,
      );
    }
  }
}

let singleton: PresentationSession | undefined;

export function getPresentationSession(): PresentationSession | undefined {
  if (!presentationConfig.enabled) return undefined;
  return singleton ??= new PresentationSession(presentationConfig);
}

export function resetPresentationSessionForTest(): void {
  singleton = undefined;
}
