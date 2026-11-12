import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  announceChange,
  type GuestPage,
  ManualFrames,
  MemoryCell,
  openGuestPage,
  patchProperty,
  taskTurn,
} from "../../tools/test-support/iframe-guest.ts";
import {
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type TapeAnnotation,
} from "./contract.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

const INPUT = {
  title: "Night survey",
  recordingLabel: "Pond, north bank",
  durationSeconds: 18,
};

const FROG: TapeAnnotation = {
  id: "frog",
  range: { startSeconds: 3, endSeconds: 6 },
  label: "Frog chorus",
  note: "Three short calls.",
  authorId: "field-guide",
  initialConfidence: 0.8,
};

const OWL: TapeAnnotation = {
  id: "owl",
  range: { startSeconds: 10, endSeconds: 12 },
  label: "Owl",
  note: "One hoot, far off.",
  authorId: "field-guide",
  initialConfidence: 0.5,
};

//
// Web Audio double
//

/** A buffer source the guest started, as the audio engine plays it. */
class BufferSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  started: { when: number; offset: number } | undefined;
  stopped = false;
  readonly #engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.#engine = engine;
  }

  connect(): void {}
  disconnect(): void {}

  start(when: number, offset: number): void {
    this.started = { when, offset };
    announceChange();
  }

  stop(): void {
    this.stopped = true;
    announceChange();
    if (this.#engine.stopFailure) throw this.#engine.stopFailure;
  }
}

/**
 * Stands in for the Web Audio engine the guest drives. A test moves the
 * engine's clock, ends what is playing, holds a decode back, and makes
 * decoding, resuming or stopping fail.
 */
class AudioEngine {
  currentTime = 0;
  readonly sources: BufferSource[] = [];
  readonly decoded: number[] = [];
  decodeFailure: Error | undefined;
  resumeFailure: Error | undefined;
  stopFailure: Error | undefined;
  heldDecode: Promise<void> | undefined;
  heldResume: Promise<void> | undefined;
  closed = false;
  tracksStopped = 0;
  readonly #streamCreated = Promise.withResolvers<void>();

  /** Resolves once the guest has created the stream its recording plays. */
  get streamCreated(): Promise<void> {
    return this.#streamCreated.promise;
  }

  /** The `AudioContext` class the guest constructs. */
  readonly AudioContext = ((engine: AudioEngine) =>
    class {
      get currentTime(): number {
        return engine.currentTime;
      }

      resume(): Promise<void> {
        if (engine.heldResume) return engine.heldResume;
        return engine.resumeFailure
          ? Promise.reject(engine.resumeFailure)
          : Promise.resolve();
      }

      close(): Promise<void> {
        engine.closed = true;
        return Promise.resolve();
      }

      /** Decodes the guest's WAV by reading its length from the header. */
      async decodeAudioData(
        bytes: ArrayBuffer,
      ): Promise<{ duration: number }> {
        await engine.heldDecode;
        if (engine.decodeFailure) throw engine.decodeFailure;
        const view = new DataView(bytes);
        const duration = view.getUint32(40, true) / view.getUint32(28, true);
        engine.decoded.push(duration);
        return { duration };
      }

      createMediaStreamDestination() {
        engine.#streamCreated.resolve();
        return {
          stream: Object.assign(new MediaStream(), {
            getTracks: () => [{ stop: () => engine.tracksStopped++ }],
          }),
        };
      }

      createBufferSource(): BufferSource {
        const source = new BufferSource(engine);
        engine.sources.push(source);
        return source;
      }
    })(this);

  /** The source playing now, if one is. */
  get playing(): BufferSource | undefined {
    return this.sources.findLast((source) =>
      source.started !== undefined && !source.stopped
    );
  }
}

//
// Text track double
//

/**
 * Gives the document's text tracks the cue list they lack, so the cues the
 * guest adds for its annotations can be read back.
 */
function keepTextTrackCues(): void {
  const cues = new WeakMap<object, VTTCue[]>();
  const listOf = (track: object) => {
    let list = cues.get(track);
    if (!list) cues.set(track, list = []);
    return list;
  };
  patchProperty(TextTrack.prototype, "cues", {
    get(this: object) {
      return listOf(this);
    },
  });
  patchProperty(TextTrack.prototype, "addCue", {
    value(this: object, cue: VTTCue) {
      listOf(this).push(cue);
    },
  });
  patchProperty(TextTrack.prototype, "removeCue", {
    value(this: object, cue: VTTCue) {
      const list = listOf(this);
      list.splice(list.indexOf(cue), 1);
    },
  });
}

//
// Tests
//

describe("iframe-shared-tape-lab/guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  function byTestId<T extends HTMLElement = HTMLInputElement>(id: string): T {
    const element = document.querySelector<T>(`[data-testid="${id}"]`);
    if (!element) throw new Error(`No element has the test id \`${id}\`.`);
    return element;
  }

  function status(): HTMLElement {
    return byTestId<HTMLElement>("tape-status");
  }

  function alertText(): string {
    return document.querySelector('[role="alert"]')?.textContent ?? "";
  }

  function recording(): HTMLAudioElement {
    return byTestId<HTMLAudioElement>("field-recording");
  }

  function timecode(): string {
    return document.querySelector(".timecode")?.textContent ?? "";
  }

  /**
   * Opens the tape. Unless `ready` is false, it announces the recording's
   * metadata once the guest has attached it, and resolves once the tape is
   * ready.
   */
  async function open(options: {
    input?: MemoryCell;
    state?: MemoryCell;
    output?: MemoryCell;
    engine?: AudioEngine;
    ready?: boolean;
  } = {}) {
    const input = options.input ?? new MemoryCell(INPUT, { readonly: true });
    const state = options.state ??
      new MemoryCell({ annotations: [FROG, OWL], assessments: [] });
    const output = options.output ??
      new MemoryCell(
        { selectedAnnotationId: null, lastAssessmentId: null },
        { identity: { id: "output", instanceId: "reviewer-1" } },
      );
    const engine = options.engine ?? new AudioEngine();
    const frames = new ManualFrames();
    const opened = page = await openGuestPage({
      guest: GUEST,
      html: HTML,
      resources: {
        input: input.resource(),
        state: state.resource(),
        output: output.resource(),
      },
      globals: {
        AudioContext: engine.AudioContext,
        requestAnimationFrame: frames.request,
        cancelAnimationFrame: frames.cancel,
      },
      setup: keepTextTrackCues,
    });
    if (options.ready !== false) {
      await engine.streamCreated;
      recording().dispatchEvent(new Event("loadedmetadata"));
      await opened.until(() => status().dataset.ready === "true");
    }
    return { page: opened, input, state, output, engine, frames };
  }

  describe("startup", () => {
    it("stores the default tape and selection on first use", async () => {
      const { state, output } = await open({
        state: new MemoryCell(),
        output: new MemoryCell(undefined, {
          identity: { id: "output", instanceId: "reviewer-1" },
        }),
      });

      expect(state.value).toEqual(DEFAULT_STATE);
      expect(output.value).toEqual(DEFAULT_OUTPUT);
    });

    it("shows the tape, its annotations and their confidence once ready", async () => {
      await open();

      expect(document.querySelector("h1")?.textContent).toBe("Night survey");
      expect(document.querySelector(".recording-label")?.textContent).toBe(
        "Pond, north bank",
      );
      expect(status().textContent).toBe("Shared tape ready");
      expect(document.querySelector(".annotation-count")?.textContent).toBe(
        "2 marked",
      );
      const frog = byTestId<HTMLElement>("annotation-frog");
      expect(frog.querySelector("h3")?.textContent).toBe("Frog chorus");
      expect(frog.querySelector("button")?.textContent).toBe("00:03.0–00:06.0");
      expect(frog.querySelector(".confidence-row span")?.textContent).toBe(
        "80% · 1 reading",
      );
      expect(byTestId("local-playhead").disabled).toBe(false);
      expect(byTestId("local-playhead").max).toBe("18");
      expect(byTestId<HTMLButtonElement>("add-at-playhead").disabled).toBe(
        false,
      );
    });

    it("waits for the recording's metadata before it is ready", async () => {
      const { engine } = await open({ ready: false });
      await engine.streamCreated;
      expect(status().dataset.ready).toBe("false");
      expect(recording().controls).toBe(false);

      recording().dispatchEvent(new Event("loadedmetadata"));
      await page!.until(() => status().dataset.ready === "true");

      expect(recording().controls).toBe(true);
    });

    it("reports a recording that does not load", async () => {
      const { page: opened, engine } = await open({ ready: false });
      await engine.streamCreated;

      recording().dispatchEvent(new Event("error"));
      await opened.until(() =>
        status().textContent === "Could not join the shared tape"
      );

      expect(alertText()).toContain("The recording did not load.");
      expect(byTestId<HTMLButtonElement>("add-at-playhead").disabled).toBe(
        true,
      );
    });

    it("reports a tape whose input never arrives", async () => {
      await open({
        input: new MemoryCell(undefined, { readonly: true }),
        ready: false,
      });
      await page!.until(() =>
        status().textContent === "Could not join the shared tape"
      );

      expect(alertText()).toContain("The tape input did not hydrate.");
    });

    it("reports a selection cell with no identity for this user", async () => {
      await open({
        output: new MemoryCell(DEFAULT_OUTPUT),
        ready: false,
      });
      await page!.until(() =>
        status().textContent === "Could not join the shared tape"
      );

      expect(alertText()).toContain(
        "The per-user output has no resolved identity.",
      );
    });

    it("reports a recording that cannot be decoded", async () => {
      const engine = new AudioEngine();
      engine.decodeFailure = new Error("Unsupported sample format.");
      await open({ engine, ready: false });
      await page!.until(() =>
        status().textContent === "Could not join the shared tape"
      );

      expect(alertText()).toContain("Unsupported sample format.");
    });

    it("stops the recording and closes the audio engine when unloaded", async () => {
      const { engine } = await open();
      const cues = recording().textTracks[0].cues;
      expect(cues).toHaveLength(2);

      await page!.close();
      page = undefined;

      expect(engine.closed).toBe(true);
      expect(engine.tracksStopped).toBe(1);
      expect(cues).toHaveLength(0);
    });

    it("gives the recording a cue for each annotation", async () => {
      const { state } = await open();
      const track = recording().textTracks[0];

      state.value = { annotations: [OWL], assessments: [] };
      await page!.until(() =>
        document.querySelector(".annotation-count")?.textContent === "1 marked"
      );

      expect([...track.cues!].map((cue) => [cue.id, cue.startTime])).toEqual([
        ["owl", 10],
      ]);
    });

    it("skips rendering while the shared state is unset, and renders it once it returns", async () => {
      const { state } = await open();

      state.value = undefined;
      state.value = { annotations: [OWL], assessments: [] };
      await page!.until(() =>
        document.querySelector(".annotation-count")?.textContent === "1 marked"
      );

      expect(document.querySelector('[data-testid="annotation-frog"]'))
        .toBeNull();
    });

    it("throws for a document with no #root element", async () => {
      await expect(openGuestPage({
        guest: GUEST,
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      })).rejects.toThrow("Shared Tape Lab needs a #root element.");
    });
  });

  describe("selecting and rating", () => {
    it("selects an annotation from its time range and seeks the playhead there", async () => {
      const { output } = await open();
      const range = byTestId<HTMLElement>("annotation-owl").querySelector(
        "button",
      )!;

      const write = output.nextWrite();
      range.click();
      await write;
      await page!.until(() =>
        byTestId<HTMLElement>("annotation-owl").dataset.selected === "true"
      );

      expect(output.value).toEqual({
        selectedAnnotationId: "owl",
        lastAssessmentId: null,
      });
      expect(timecode()).toBe("00:10.0");
      expect(byTestId<HTMLElement>("annotation-owl").dataset.active).toBe(
        "true",
      );
      expect(document.querySelector(".consensus-label")?.textContent).toBe(
        "Owl · community confidence",
      );
      expect(document.querySelector(".consensus-panel output")?.textContent)
        .toBe("50%");
    });

    it("adds this reviewer's reading at the confidence chosen", async () => {
      const { state, output } = await open();
      const card = byTestId<HTMLElement>("annotation-frog");
      const slider = card.querySelector<HTMLInputElement>(
        ".assessment-editor input",
      )!;

      slider.value = "40";
      slider.dispatchEvent(new Event("input"));
      const write = output.nextWrite();
      byTestId<HTMLButtonElement>("add-reading-frog").click();
      await write;
      await page!.until(() =>
        !byTestId<HTMLButtonElement>("add-reading-frog").disabled
      );

      expect(state.value).toMatchObject({
        assessments: [{
          annotationId: "frog",
          reviewerId: "reviewer-1",
          confidence: 0.4,
        }],
      });
      expect(output.value).toMatchObject({
        lastAssessmentId: expect.any(String),
      });
      expect(
        byTestId<HTMLElement>("annotation-frog").querySelector(
          ".confidence-row span",
        )?.textContent,
      ).toBe("60% · 2 readings");
    });

    it("shows why a reading could not be added, and lets it be tried again", async () => {
      const { state } = await open();
      state.failWrites(new Error("Readings are closed."));

      byTestId<HTMLButtonElement>("add-reading-frog").click();
      await page!.until(() => alertText() !== "");
      await page!.until(() =>
        !byTestId<HTMLButtonElement>("add-reading-frog").disabled
      );

      expect(alertText()).toContain("Readings are closed.");
    });

    it("shows why an annotation could not be selected", async () => {
      const { output } = await open();
      output.failWrites(new Error("Selection refused."));

      byTestId<HTMLElement>("annotation-frog").querySelector("button")!.click();
      await page!.until(() => alertText() !== "");

      expect(alertText()).toContain("Selection refused.");
    });
  });

  describe("annotating", () => {
    it("adds an annotation at the playhead and selects it", async () => {
      const { state, output } = await open();
      byTestId<HTMLElement>("annotation-owl").querySelector("button")!.click();
      await page!.until(() => timecode() === "00:10.0");

      byTestId<HTMLButtonElement>("add-at-playhead").click();
      const dialog = byTestId<HTMLDialogElement>("annotation-dialog");
      expect(dialog.open).toBe(true);
      expect(byTestId("annotation-start").value).toBe("10.0");
      expect(byTestId("annotation-end").value).toBe("11.5");
      byTestId("annotation-label").value = "  Heron  ";
      byTestId<HTMLTextAreaElement>("annotation-note").value = "Wading.";
      const confidence = byTestId("annotation-confidence");
      confidence.value = "90";
      confidence.dispatchEvent(new Event("input"));
      expect(confidence.nextElementSibling?.textContent).toBe("90%");
      byTestId<HTMLButtonElement>("save-annotation").click();
      await page!.until(() => !dialog.open);
      await page!.until(() =>
        document.querySelector(".annotation-count")?.textContent === "3 marked"
      );

      expect(state.value).toMatchObject({
        annotations: [FROG, OWL, {
          range: { startSeconds: 10, endSeconds: 11.5 },
          label: "Heron",
          note: "Wading.",
          authorId: "reviewer-1",
          initialConfidence: 0.9,
        }],
      });
      expect(output.value).toMatchObject({
        selectedAnnotationId: expect.any(String),
      });
    });

    it("refuses an annotation with no label, no note, or an impossible range", async () => {
      const { state } = await open();
      byTestId<HTMLButtonElement>("add-at-playhead").click();
      const save = byTestId<HTMLButtonElement>("save-annotation");

      const attempts: [string, string, string, string, string][] = [
        ["0", "1", "", "A note", "Give the annotation a label."],
        ["0", "1", "Label", "  ", "Add a listening note."],
        ["5", "4", "Label", "A note", "Choose a range within 0–18 seconds"],
        ["0", "19", "Label", "A note", "Choose a range within 0–18 seconds"],
        ["1e400", "1", "Label", "A note", "Start and end must be numbers."],
      ];
      for (const [start, end, label, note, message] of attempts) {
        byTestId("annotation-start").value = start;
        byTestId("annotation-end").value = end;
        byTestId("annotation-label").value = label;
        byTestId<HTMLTextAreaElement>("annotation-note").value = note;
        save.click();
        await page!.until(() => alertText().includes(message));
      }
      await page!.settled();

      expect(state.writes).toEqual([]);
      expect(byTestId<HTMLDialogElement>("annotation-dialog").open).toBe(true);
    });

    it("lets the editor be dismissed while nothing is saving", async () => {
      await open();
      byTestId<HTMLButtonElement>("add-at-playhead").click();

      const dismissal = new Event("cancel", { cancelable: true });
      byTestId<HTMLDialogElement>("annotation-dialog").dispatchEvent(
        dismissal,
      );

      expect(dismissal.defaultPrevented).toBe(false);
    });

    it("keeps the editor open against dismissal while it saves", async () => {
      await open();
      byTestId<HTMLButtonElement>("add-at-playhead").click();
      byTestId("annotation-label").value = "Heron";
      byTestId<HTMLTextAreaElement>("annotation-note").value = "Wading.";

      byTestId<HTMLButtonElement>("save-annotation").click();
      const dismissal = new Event("cancel", { cancelable: true });
      byTestId<HTMLDialogElement>("annotation-dialog").dispatchEvent(
        dismissal,
      );
      byTestId<HTMLButtonElement>("cancel-annotation").click();

      expect(dismissal.defaultPrevented).toBe(true);
      expect(byTestId<HTMLDialogElement>("annotation-dialog").open).toBe(true);
      await page!.until(() =>
        !byTestId<HTMLDialogElement>("annotation-dialog").open
      );
    });

    it("closes the editor on Cancel and stores nothing", async () => {
      const { state } = await open();
      byTestId<HTMLButtonElement>("add-at-playhead").click();

      byTestId<HTMLButtonElement>("cancel-annotation").click();
      await page!.settled();

      expect(byTestId<HTMLDialogElement>("annotation-dialog").open).toBe(
        false,
      );
      expect(state.writes).toEqual([]);
    });

    it("writes only the fields an edit changed", async () => {
      const { state, output } = await open();

      byTestId<HTMLButtonElement>("edit-owl").click();
      expect(byTestId("annotation-label").value).toBe("Owl");
      expect(byTestId("annotation-confidence").disabled).toBe(true);
      byTestId("annotation-label").value = "Tawny owl";
      const selected = output.nextWrite();
      byTestId<HTMLButtonElement>("save-annotation").click();
      await selected;
      await page!.settled();

      expect(state.writes.map((write) => write.path)).toEqual([
        ["annotations", 1, "label"],
      ]);
      expect(state.value).toMatchObject({
        annotations: [FROG, { ...OWL, label: "Tawny owl" }],
      });
      expect(output.value).toMatchObject({ selectedAnnotationId: "owl" });
    });

    it("refuses to save an edit to an annotation someone else removed", async () => {
      const { state } = await open();
      byTestId<HTMLButtonElement>("edit-owl").click();

      state.value = { annotations: [FROG], assessments: [] };
      byTestId<HTMLButtonElement>("save-annotation").click();
      await page!.until(() => alertText() !== "");
      await page!.settled();

      expect(alertText()).toContain("That annotation is no longer available.");
      expect(state.writes).toEqual([]);
    });
  });

  describe("playback", () => {
    it("plays from the playhead and follows the audio clock", async () => {
      const { engine, frames } = await open();

      recording().play();
      await page!.until(() => engine.playing !== undefined);
      expect(engine.playing?.started).toEqual({ when: 0, offset: 0 });
      engine.currentTime = 4;
      frames.run();

      expect(timecode()).toBe("00:04.0");
      expect(byTestId<HTMLElement>("annotation-frog").dataset.active).toBe(
        "true",
      );
      expect(byTestId<HTMLElement>("annotation-owl").dataset.active).toBe(
        "false",
      );
    });

    it("keeps its place when paused, and resumes from it", async () => {
      const { engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      engine.currentTime = 2;

      recording().pause();
      expect(engine.playing).toBeUndefined();
      expect(timecode()).toBe("00:02.0");
      recording().play();
      await page!.until(() => engine.playing !== undefined);

      expect(engine.playing?.started).toEqual({ when: 0, offset: 2 });
    });

    it("starts no second source for a play while it is playing", async () => {
      const { engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);

      recording().dispatchEvent(new Event("play"));
      await page!.settled();

      expect(engine.sources).toHaveLength(1);
    });

    it("starts nothing when paused before the audio engine resumes", async () => {
      const { engine } = await open();

      recording().play();
      recording().pause();
      await Promise.resolve();

      expect(engine.sources).toEqual([]);
    });

    it("starts one source for a play, a pause and a play before the engine resumes", async () => {
      const { engine } = await open();
      const held = Promise.withResolvers<void>();
      engine.heldResume = held.promise;

      recording().play();
      recording().pause();
      recording().play();
      held.resolve();
      await page!.until(() => engine.playing !== undefined);
      await page!.settled();

      expect(engine.sources).toHaveLength(1);
      expect(recording().paused).toBe(false);
    });

    it("shows why playback could not start, and pauses", async () => {
      const { engine } = await open();
      engine.resumeFailure = new Error("Audio output is blocked.");

      recording().play();
      await page!.until(() => alertText() !== "");

      expect(alertText()).toContain("Audio output is blocked.");
      expect(recording().paused).toBe(true);
    });

    it("pauses a source the engine reports as already stopped", async () => {
      const { engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      engine.currentTime = 3;
      engine.stopFailure = new DOMException("Stopped.", "InvalidStateError");

      recording().pause();

      expect(alertText()).toBe("");
      expect(timecode()).toBe("00:03.0");
    });

    it("shows why playback could not be paused", async () => {
      const { engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      engine.stopFailure = new Error("The output device went away.");

      recording().pause();

      expect(alertText()).toContain("The output device went away.");
    });

    it("stops at the end of the recording and starts over on the next play", async () => {
      const { engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      const source = engine.playing!;

      engine.currentTime = 18;
      source.onended?.();

      expect(recording().paused).toBe(true);
      expect(timecode()).toBe("00:18.0");
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      expect(engine.playing?.started?.offset).toBe(0);
    });

    it("seeks with the scrubber, restarting a playing source there", async () => {
      const { engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      const first = engine.playing!;

      const scrubber = byTestId("local-playhead");
      scrubber.value = "7";
      scrubber.dispatchEvent(new Event("input"));
      await page!.until(() => engine.playing !== first);

      expect(first.stopped).toBe(true);
      expect(engine.playing?.started?.offset).toBe(7);
    });

    it("seeks a paused recording without starting it", async () => {
      const { engine } = await open();

      const scrubber = byTestId("local-playhead");
      scrubber.value = "12.5";
      scrubber.dispatchEvent(new Event("input"));

      expect(timecode()).toBe("00:12.5");
      expect(engine.playing).toBeUndefined();
    });
  });

  describe("recording duration", () => {
    it("rebuilds the recording at a new duration, keeping the playhead", async () => {
      const { input, engine } = await open();
      const scrubber = byTestId("local-playhead");
      scrubber.value = "5";
      scrubber.dispatchEvent(new Event("input"));

      input.value = { ...INPUT, durationSeconds: 30 };
      await page!.until(() => scrubber.max === "30");
      await page!.until(() => status().dataset.ready === "true");

      expect(engine.decoded).toEqual([18, 30]);
      expect(timecode()).toBe("00:05.0");
      expect(status().textContent).toBe("Shared tape ready");
    });

    it("keeps playing from the same place in a longer recording", async () => {
      const { input, engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      const first = engine.playing!;
      engine.currentTime = 9;

      input.value = { ...INPUT, durationSeconds: 30 };
      await page!.until(() =>
        engine.playing !== undefined && engine.playing !== first
      );

      expect(first.stopped).toBe(true);
      expect(engine.playing?.started?.offset).toBe(9);
      expect(recording().paused).toBe(false);
    });

    it("stops at the end of a recording shortened past the playhead", async () => {
      const { input, engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      engine.currentTime = 9;

      input.value = { ...INPUT, durationSeconds: 6 };
      await page!.until(() =>
        byTestId("local-playhead").max === "6" &&
        status().dataset.ready === "true"
      );

      expect(recording().paused).toBe(true);
      expect(engine.playing).toBeUndefined();
      expect(timecode()).toBe("00:06.0");
      expect(byTestId("local-playhead").max).toBe("6");
    });

    it("builds only the latest of several durations requested while one builds", async () => {
      const { input, engine } = await open();
      const held = Promise.withResolvers<void>();
      engine.heldDecode = held.promise;

      input.value = { ...INPUT, durationSeconds: 20 };
      await page!.until(() => status().dataset.ready === "false");
      input.value = { ...INPUT, durationSeconds: 25 };
      input.value = { ...INPUT, title: "Longest", durationSeconds: 30 };
      await page!.until(() =>
        document.querySelector("h1")?.textContent === "Longest"
      );
      held.resolve();
      await page!.until(() => byTestId("local-playhead").max === "30");
      await page!.until(() => status().dataset.ready === "true");

      expect(engine.decoded).toEqual([18, 20, 30]);
    });

    it("rebuilds the recording even when stopping playback for it fails", async () => {
      const { input, engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      engine.stopFailure = new Error("The output device went away.");

      input.value = { ...INPUT, durationSeconds: 30 };
      await page!.until(() => byTestId("local-playhead").max === "30");
      await page!.until(() => status().dataset.ready === "true");

      expect(engine.decoded).toEqual([18, 30]);
      expect(alertText()).toBe("");
    });

    it("pauses playback when the recording cannot be rebuilt", async () => {
      const { input, engine } = await open();
      recording().play();
      await page!.until(() => engine.playing !== undefined);
      engine.decodeFailure = new Error("Out of memory.");

      input.value = { ...INPUT, durationSeconds: 90 };
      await page!.until(() =>
        status().textContent === "Recording duration update failed"
      );

      expect(recording().paused).toBe(true);
    });

    it("tries a duration that failed only once until the duration changes", async () => {
      const { input, engine } = await open();
      engine.decodeFailure = new Error("Out of memory.");
      input.value = { ...INPUT, durationSeconds: 90 };
      await page!.until(() =>
        status().textContent === "Recording duration update failed"
      );
      engine.decodeFailure = undefined;

      input.value = { ...INPUT, title: "Renamed", durationSeconds: 90 };
      await page!.until(() =>
        document.querySelector("h1")?.textContent === "Renamed"
      );

      expect(engine.decoded).toEqual([18]);
      expect(status().textContent).toBe("Recording duration update failed");
    });

    it("abandons a rebuild that finishes after the page hides", async () => {
      const { input, engine } = await open();
      const held = Promise.withResolvers<void>();
      engine.heldDecode = held.promise;
      input.value = { ...INPUT, durationSeconds: 30 };
      await page!.until(() => status().dataset.ready === "false");

      dispatchEvent(new Event("pagehide"));
      held.resolve();
      await taskTurn();

      expect(engine.closed).toBe(true);
      expect(engine.decoded).toEqual([18, 30]);
      expect(byTestId("local-playhead").max).toBe("18");
    });

    it("reports a duration it cannot build, and recovers when the duration changes back", async () => {
      const { input, engine } = await open();
      engine.decodeFailure = new Error("Out of memory.");

      input.value = { ...INPUT, durationSeconds: 90 };
      await page!.until(() =>
        status().textContent === "Recording duration update failed"
      );
      expect(alertText()).toBe(
        "Could not update the recording duration. Out of memory.",
      );
      expect(byTestId<HTMLButtonElement>("add-at-playhead").disabled).toBe(
        true,
      );

      engine.decodeFailure = undefined;
      input.value = INPUT;
      await page!.until(() => status().dataset.ready === "true");
      expect(alertText()).toBe("");
      expect(engine.decoded).toEqual([18]);
    });
  });
});
