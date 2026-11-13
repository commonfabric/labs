// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import { defaultTheme } from "../theme-context.ts";
import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { StandInAudioContext } from "../../test-utils/audio-context.ts";
import { CFVoiceInput, type TranscriptionData } from "./index.ts";

/** A microphone track, which records whether it was stopped. */
class StandInTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

/** The stream `getUserMedia()` hands over: one microphone track. */
class StandInStream {
  readonly track = new StandInTrack();
  getTracks() {
    return [this.track];
  }
}

/**
 * Stands in for `MediaRecorder`: it records nothing itself, so a test hands
 * it chunks with `record()`, and it reports stopping in a later task, calling
 * whatever `onstop` holds by then, as a browser's recorder does. The task is a
 * timer, so a test runs it by advancing its fake time.
 */
class StandInRecorder {
  static supported = new Set<string>();
  static made: StandInRecorder[] = [];

  static isTypeSupported(type: string) {
    return StandInRecorder.supported.has(type);
  }

  state: "inactive" | "recording" = "inactive";
  timeslice?: number;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType: string;

  constructor(
    readonly stream: StandInStream,
    readonly options: { mimeType?: string },
  ) {
    this.mimeType = options.mimeType ?? "";
    StandInRecorder.made.push(this);
  }

  start(timeslice: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  stop() {
    if (this.state === "inactive") {
      throw new DOMException(
        "The recorder is not recording",
        "InvalidStateError",
      );
    }
    this.state = "inactive";
    setTimeout(() => this.onstop?.());
  }

  record(...chunks: string[]) {
    for (const chunk of chunks) {
      this.ondataavailable?.({ data: new Blob([chunk]) });
    }
  }
}

/** What a request to the transcription endpoint carried. */
interface TranscriptionRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly contentType: string | null;
  readonly body: Blob;
}

/** How the stand-in microphone and transcription endpoint answer. */
const world: {
  microphoneRequests: MediaStreamConstraints[];
  microphone: () => Promise<StandInStream>;
  requests: TranscriptionRequest[];
  respond: () => Promise<Response>;
} = {
  microphoneRequests: [],
  microphone: () => Promise.resolve(new StandInStream()),
  requests: [],
  respond: () => Promise.resolve(Response.json({ text: "" })),
};

let time: FakeTime;
let fetchStub: { restore(): void };

/** A voice input mounted with `properties`, and every event it fires. */
async function voiceInputWith(properties: Partial<CFVoiceInput> = {}) {
  const element = Object.assign(new CFVoiceInput(), properties);
  const events: { type: string; detail: unknown }[] = [];
  for (
    const type of [
      "cf-recording-start",
      "cf-recording-stop",
      "cf-transcription-start",
      "cf-transcription-complete",
      "cf-transcription-error",
      "cf-error",
      "cf-change",
    ]
  ) {
    element.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) {
        events.push({ type, detail: event.detail });
      }
    });
  }
  return { element: await mount(element), events };
}

/** Resolves with the detail of the next `type` event `element` fires. */
function next(element: HTMLElement, type: string): Promise<unknown> {
  return new Promise((resolve) => {
    element.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) resolve(event.detail);
    }, { once: true });
  });
}

/** The `key` member of an event's `detail`. */
function member(detail: unknown, key: string): unknown {
  if (typeof detail !== "object" || detail === null) {
    throw new Error(`Expected an object holding \`${key}\`: ${detail}`);
  }
  return Reflect.get(detail, key);
}

/** The audio a `cf-recording-stop` event's `detail` carries. */
function audioIn(detail: unknown): Blob {
  const audio = member(detail, "audioData");
  if (!(audio instanceof Blob)) throw new Error("Expected recorded audio");
  return audio;
}

const button = (element: CFVoiceInput) =>
  element.shadowRoot!.querySelector("button")!;

const shown = (element: CFVoiceInput, selector: string) =>
  element.shadowRoot!.querySelector(selector)?.textContent?.trim();

/** The recorder made most recently. */
const recorder = () => StandInRecorder.made[StandInRecorder.made.length - 1];

/** Clicks a toggle-mode input and resolves once it is recording. */
async function startByClick(element: CFVoiceInput) {
  const started = next(element, "cf-recording-start");
  button(element).click();
  await started;
  await element.updateComplete;
}

/**
 * Clicks a recording toggle-mode input and resolves once it has finished
 * processing what it recorded: transcribed it, or failed to.
 */
async function stopByClick(element: CFVoiceInput) {
  const finished = Promise.race([
    next(element, "cf-transcription-complete"),
    next(element, "cf-transcription-error"),
  ]);
  button(element).click();
  time.tick(0);
  await finished;
  // Only microtasks remain between the event and the return to idle.
  await time.runMicrotasks();
  await element.updateComplete;
}

function pointer(element: CFVoiceInput, type: string, pointerId = 1) {
  button(element).dispatchEvent(
    new PointerEvent(type, { pointerId, bubbles: true }),
  );
}

describe("CFVoiceInput", () => {
  beforeEach(() => {
    time = new FakeTime();
    world.microphoneRequests = [];
    world.microphone = () => Promise.resolve(new StandInStream());
    world.requests = [];
    world.respond = () => Promise.resolve(Response.json({ text: "" }));
    StandInRecorder.supported = new Set(["audio/webm;codecs=opus"]);
    StandInRecorder.made = [];
    StandInAudioContext.reset();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: (constraints: MediaStreamConstraints) => {
          world.microphoneRequests.push(constraints);
          return world.microphone();
        },
      },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: StandInRecorder,
    });
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: StandInAudioContext,
    });
    fetchStub = stub(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        world.requests.push({
          url: String(input),
          method: init?.method,
          contentType: new Headers(init?.headers).get("Content-Type"),
          body: body instanceof Blob ? body : new Blob(),
        });
        return await world.respond();
      },
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    fetchStub.restore();
    Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(globalThis, "MediaRecorder");
    Reflect.deleteProperty(globalThis, "AudioContext");
    time.restore();
  });

  it("is registered as `cf-voice-input`", () => {
    expect(customElements.get("cf-voice-input")).toBe(CFVoiceInput);
  });

  describe("render()", () => {
    it("shows an idle hold-to-record microphone button", async () => {
      const { element } = await voiceInputWith();
      expect(button(element).getAttribute("aria-label")).toBe(
        "Start recording",
      );
      expect(button(element).title).toBe("Hold to record");
      expect(button(element).textContent?.trim()).toBe("🎤");
      expect(button(element).disabled).toBe(false);
      expect(button(element).classList.contains("recording")).toBe(false);
      expect(shown(element, ".recording-status")).toBeUndefined();
      expect(shown(element, ".processing")).toBeUndefined();
      expect(shown(element, ".error")).toBeUndefined();
    });

    it("titles a toggle-mode button for clicking", async () => {
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      expect(button(element).title).toBe("Click to toggle recording");
    });

    it("disables the button of a disabled input", async () => {
      const { element } = await voiceInputWith({ disabled: true });
      expect(button(element).disabled).toBe(true);
    });
  });

  describe("recording in toggle mode", () => {
    it("asks for one echo-cancelled, noise-suppressed microphone channel and records it in 250 ms slices", async () => {
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
      });
      await startByClick(element);

      expect(world.microphoneRequests).toEqual([{
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      }]);
      expect(recorder().stream).toBeInstanceOf(StandInStream);
      expect(recorder().options).toEqual({
        mimeType: "audio/webm;codecs=opus",
      });
      expect(recorder().timeslice).toBe(250);
      expect(events).toEqual([{
        type: "cf-recording-start",
        detail: { timestamp: Date.now() },
      }]);
    });

    it("shows a stop button, the recording status, and a waveform of the microphone", async () => {
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);

      expect(button(element).getAttribute("aria-label")).toBe("Stop recording");
      expect(button(element).textContent?.trim()).toBe("⏹️");
      expect(button(element).classList.contains("recording")).toBe(true);
      expect(shown(element, ".recording-status")).toContain("Recording");
      expect(shown(element, ".timer")).toBe("0:00");
      expect(element.shadowRoot!.querySelector("cf-audio-visualizer"))
        .not.toBeNull();
      expect(StandInAudioContext.sources.map((s) => s.stream)).toEqual([
        recorder().stream,
      ]);
    });

    it("shows no waveform where `showWaveform` is off", async () => {
      const { element } = await voiceInputWith({
        recordingMode: "toggle",
        showWaveform: false,
      });
      await startByClick(element);

      expect(shown(element, ".recording-status")).toContain("Recording");
      expect(element.shadowRoot!.querySelector("cf-audio-visualizer"))
        .toBeNull();
      expect(StandInAudioContext.sources).toEqual([]);
    });

    it("shows the time recorded in minutes and seconds", async () => {
      const { element } = await voiceInputWith({
        recordingMode: "toggle",
        maxDuration: 120,
      });
      await startByClick(element);

      time.tick(1250);
      await element.updateComplete;
      expect(shown(element, ".timer")).toBe("0:01");
      time.tick(64_000);
      await element.updateComplete;
      expect(shown(element, ".timer")).toBe("1:05");
    });

    it("asks for the microphone once however often the button is clicked while it is being asked for", async () => {
      using warn = stub(console, "warn");
      const answer = Promise.withResolvers<StandInStream>();
      world.microphone = () => answer.promise;
      const { element } = await voiceInputWith({ recordingMode: "toggle" });

      button(element).click();
      button(element).click();
      expect(world.microphoneRequests.length).toBe(1);
      expect(warn.calls.length).toBe(1);
      expect(warn.calls[0].args).toContain("requesting");

      const started = next(element, "cf-recording-start");
      answer.resolve(new StandInStream());
      await started;
      expect(StandInRecorder.made.length).toBe(1);
    });

    it("does not record from a disabled input", async () => {
      const { element } = await voiceInputWith({
        recordingMode: "toggle",
        disabled: true,
      });
      button(element).click();
      expect(world.microphoneRequests).toEqual([]);
    });

    it("releases the microphone, stops the waveform, and fires `cf-recording-stop` with the recorded audio and its duration once stopped", async () => {
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
        autoTranscribe: false,
      });
      await startByClick(element);
      const { stream } = recorder();
      recorder().record("ab", "", "cd");
      time.tick(1500);

      const stopped = next(element, "cf-recording-stop");
      button(element).click();
      expect(stream.track.stopped).toBe(true);
      expect(recorder().state).toBe("inactive");
      expect(StandInAudioContext.sources[0].disconnected).toBe(true);
      time.tick(0);
      const detail = await stopped;

      expect(detail).toEqual({
        duration: 1.5,
        audioData: expect.any(Blob),
      });
      const audio = audioIn(detail);
      expect(audio.type).toBe("audio/webm;codecs=opus");
      expect(await audio.text()).toBe("abcd");
      expect(events.map((e) => e.type)).toEqual([
        "cf-recording-start",
        "cf-recording-stop",
      ]);
      expect(world.requests).toEqual([]);

      await time.runMicrotasks();
      await element.updateComplete;
      expect(button(element).getAttribute("aria-label")).toBe(
        "Start recording",
      );
      expect(button(element).disabled).toBe(false);
    });

    it("stops by itself once the maximum duration has passed", async () => {
      const { element } = await voiceInputWith({
        recordingMode: "toggle",
        autoTranscribe: false,
        maxDuration: 2,
      });
      await startByClick(element);
      const stopped = next(element, "cf-recording-stop");

      time.tick(1999);
      expect(recorder().state).toBe("recording");
      time.tick(1);
      expect(recorder().state).toBe("inactive");
      expect(await stopped).toMatchObject({ duration: 2 });
    });

    it("releases the microphone, stops the waveform, and lets the next recording run its full length when the recorder stops by itself", async () => {
      const { element } = await voiceInputWith({
        recordingMode: "toggle",
        autoTranscribe: false,
        maxDuration: 2,
      });
      await startByClick(element);
      const first = recorder();
      const stopped = next(element, "cf-recording-stop");
      // As a recorder does when its microphone is unplugged.
      first.stop();
      time.tick(0);
      await stopped;
      expect(first.stream.track.stopped).toBe(true);
      expect(StandInAudioContext.sources[0].disconnected).toBe(true);
      await time.runMicrotasks();
      await element.updateComplete;

      time.tick(1000);
      await startByClick(element);
      time.tick(1999);
      expect(recorder()).not.toBe(first);
      expect(recorder().state).toBe("recording");
      time.tick(1);
      expect(recorder().state).toBe("inactive");
    });
  });

  describe("the recorded format", () => {
    it("falls back to plain WebM where Opus is not supported", async () => {
      StandInRecorder.supported = new Set(["audio/webm", "audio/mp4"]);
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);
      expect(recorder().options).toEqual({ mimeType: "audio/webm" });
    });

    it("falls back to MP4 where WebM is not supported", async () => {
      StandInRecorder.supported = new Set(["audio/mp4"]);
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);
      expect(recorder().options).toEqual({ mimeType: "audio/mp4" });
    });

    it("leaves the format to the browser, and labels the audio WebM, where none is supported", async () => {
      StandInRecorder.supported = new Set();
      const { element } = await voiceInputWith({
        recordingMode: "toggle",
        autoTranscribe: false,
      });
      await startByClick(element);
      expect(recorder().options).toEqual({});

      const stopped = next(element, "cf-recording-stop");
      button(element).click();
      time.tick(0);
      expect(audioIn(await stopped).type).toBe("audio/webm");
    });
  });

  describe("recording in hold mode", () => {
    it("records while the pointer is held on the button", async () => {
      const { element, events } = await voiceInputWith({
        autoTranscribe: false,
      });
      const started = next(element, "cf-recording-start");
      pointer(element, "pointerdown");
      expect(button(element).hasPointerCapture(1)).toBe(true);
      await started;

      const stopped = next(element, "cf-recording-stop");
      pointer(element, "pointerup");
      expect(button(element).hasPointerCapture(1)).toBe(false);
      time.tick(0);
      await stopped;
      expect(events.map((e) => e.type)).toEqual([
        "cf-recording-start",
        "cf-recording-stop",
      ]);
    });

    it("follows only the first pointer held on the button", async () => {
      const { element } = await voiceInputWith({ autoTranscribe: false });
      const started = next(element, "cf-recording-start");
      pointer(element, "pointerdown", 1);
      pointer(element, "pointerdown", 2);
      await started;
      expect(world.microphoneRequests.length).toBe(1);

      pointer(element, "pointerup", 2);
      pointer(element, "pointercancel", 2);
      expect(recorder().state).toBe("recording");

      const stopped = next(element, "cf-recording-stop");
      pointer(element, "pointerup", 1);
      time.tick(0);
      await stopped;
    });

    it("stops recording when the held pointer is cancelled", async () => {
      const { element } = await voiceInputWith({ autoTranscribe: false });
      const started = next(element, "cf-recording-start");
      pointer(element, "pointerdown");
      await started;

      const stopped = next(element, "cf-recording-stop");
      pointer(element, "pointercancel");
      expect(recorder().state).toBe("inactive");
      time.tick(0);
      await stopped;
    });

    for (const release of ["pointerup", "pointercancel"]) {
      it(`records nothing, and releases the microphone, after a \`${release}\` before the microphone is granted`, async () => {
        const answer = Promise.withResolvers<StandInStream>();
        world.microphone = () => answer.promise;
        const { element, events } = await voiceInputWith({
          autoTranscribe: false,
        });
        pointer(element, "pointerdown");
        pointer(element, release);
        const stream = new StandInStream();
        answer.resolve(stream);
        await time.runMicrotasks();
        await element.updateComplete;

        expect(stream.track.stopped).toBe(true);
        expect(StandInRecorder.made).toEqual([]);
        expect(events).toEqual([]);
        expect(button(element).getAttribute("aria-label")).toBe(
          "Start recording",
        );

        world.microphone = () => Promise.resolve(new StandInStream());
        const started = next(element, "cf-recording-start");
        pointer(element, "pointerdown");
        await started;
        expect(recorder().state).toBe("recording");
      });
    }

    it("shows no error where the microphone refuses a hold already released", async () => {
      const answer = Promise.withResolvers<StandInStream>();
      world.microphone = () => answer.promise;
      const { element, events } = await voiceInputWith();
      pointer(element, "pointerdown");
      pointer(element, "pointerup");
      answer.reject(new DOMException("denied", "NotAllowedError"));
      await time.runMicrotasks();
      await element.updateComplete;

      expect(events).toEqual([]);
      expect(shown(element, ".error")).toBeUndefined();
    });

    it("records a second hold, showing no error, where the microphone refuses the first after its release", async () => {
      const answers = [
        Promise.withResolvers<StandInStream>(),
        Promise.withResolvers<StandInStream>(),
      ];
      world.microphone = () =>
        answers[world.microphoneRequests.length - 1].promise;
      const { element, events } = await voiceInputWith({
        autoTranscribe: false,
      });
      pointer(element, "pointerdown");
      pointer(element, "pointerup");
      pointer(element, "pointerdown");
      answers[0].reject(new DOMException("denied", "NotAllowedError"));
      await time.runMicrotasks();
      await element.updateComplete;
      expect(events).toEqual([]);
      expect(shown(element, ".error")).toBeUndefined();

      const started = next(element, "cf-recording-start");
      answers[1].resolve(new StandInStream());
      await started;
      expect(recorder().state).toBe("recording");
    });

    it("does not record on a click", async () => {
      const { element } = await voiceInputWith();
      button(element).click();
      expect(world.microphoneRequests).toEqual([]);
    });

    it("does not record from a held pointer on a disabled or toggle-mode input", async () => {
      const disabled = await voiceInputWith({ disabled: true });
      pointer(disabled.element, "pointerdown");
      pointer(disabled.element, "pointerup");
      const toggle = await voiceInputWith({ recordingMode: "toggle" });
      pointer(toggle.element, "pointerdown");
      pointer(toggle.element, "pointercancel");
      expect(world.microphoneRequests).toEqual([]);
    });

    it("does not stop a toggle-mode recording when the pointer is released", async () => {
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);
      pointer(element, "pointerdown");
      pointer(element, "pointerup");
      pointer(element, "pointerdown", 2);
      pointer(element, "pointercancel", 2);
      expect(recorder().state).toBe("recording");
    });
  });

  describe("a microphone that cannot be used", () => {
    for (
      const [name, message] of [
        ["NotAllowedError", "Microphone permission denied"],
        ["NotFoundError", "No microphone found"],
        ["AbortError", "Failed to access microphone: device busy"],
      ]
    ) {
      it(`shows and fires \`cf-error\` with "${message}" for a \`${name}\``, async () => {
        const error = new DOMException("device busy", name);
        world.microphone = () => Promise.reject(error);
        const { element, events } = await voiceInputWith({
          recordingMode: "toggle",
        });
        const failed = next(element, "cf-error");
        button(element).click();
        expect(await failed).toEqual({ error, message });
        await element.updateComplete;

        expect(shown(element, ".error")).toBe(message);
        expect(events.map((e) => e.type)).toEqual(["cf-error"]);
        expect(StandInRecorder.made).toEqual([]);
        expect(button(element).getAttribute("aria-label")).toBe(
          "Start recording",
        );
      });
    }

    it("releases the microphone where no recorder can be made for it", async () => {
      const stream = new StandInStream();
      world.microphone = () => Promise.resolve(stream);
      const error = new DOMException("no recorder", "NotSupportedError");
      Object.defineProperty(globalThis, "MediaRecorder", {
        configurable: true,
        value: Object.assign(function () {
          throw error;
        }, { isTypeSupported: () => false }),
      });
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      const failed = next(element, "cf-error");
      button(element).click();
      expect(await failed).toEqual({
        error,
        message: "Failed to access microphone: no recorder",
      });
      expect(stream.track.stopped).toBe(true);
    });

    it("clears the error once a later recording starts", async () => {
      world.microphone = () =>
        Promise.reject(new DOMException("no", "NotFoundError"));
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      const failed = next(element, "cf-error");
      button(element).click();
      await failed;

      world.microphone = () => Promise.resolve(new StandInStream());
      await startByClick(element);
      expect(shown(element, ".error")).toBeUndefined();
    });
  });

  describe("transcription", () => {
    it("posts the recording, converted to WAV, and fires `cf-transcription-complete` with the text and chunks returned", async () => {
      const chunks = [{ timestamp: [0, 1], text: "hello" }];
      world.respond = () =>
        Promise.resolve(Response.json({ transcription: "hello", chunks }));
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
      });
      await startByClick(element);
      recorder().record("abcd");
      time.tick(2000);
      await stopByClick(element);

      expect(world.requests.length).toBe(1);
      const [request] = world.requests;
      expect(request.url).toBe("/api/ai/voice/transcribe");
      expect(request.method).toBe("POST");
      expect(request.contentType).toBe("audio/wav");
      expect(request.body.type).toBe("audio/wav");
      // A 44-byte header and four 16-bit samples, one per byte recorded.
      expect(request.body.size).toBe(44 + 4 * 2);

      const id = member(events[2].detail, "id");
      expect(id).toMatch(/^voice-\d+-[a-z0-9]+$/);
      expect(events.map((e) => e.type)).toEqual([
        "cf-recording-start",
        "cf-recording-stop",
        "cf-transcription-start",
        "cf-transcription-complete",
      ]);
      expect(events[3].detail).toEqual({
        transcription: {
          id,
          text: "hello",
          chunks,
          duration: 2,
          timestamp: Date.now(),
        },
      });
      expect(shown(element, ".error")).toBeUndefined();
      expect(button(element).disabled).toBe(false);
    });

    it("posts the recording as recorded where it does not convert to WAV", async () => {
      using warn = stub(console, "warn");
      const failure = new Error("Unable to decode audio data");
      StandInAudioContext.decode = () => {
        throw failure;
      };
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);
      recorder().record("abcd");
      await stopByClick(element);

      expect(world.requests[0].contentType).toBe("audio/webm;codecs=opus");
      expect(await world.requests[0].body.text()).toBe("abcd");
      expect(warn.calls.length).toBe(1);
      expect(warn.calls[0].args).toContain(failure);
    });

    it("shows the transcribing status, with the button disabled, until the response arrives", async () => {
      const response = Promise.withResolvers<Response>();
      world.respond = () => response.promise;
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);
      const requested = next(element, "cf-transcription-start");
      const completed = next(element, "cf-transcription-complete");
      button(element).click();
      time.tick(0);
      await requested;
      await element.updateComplete;

      expect(shown(element, ".processing")).toBe("⏳ Transcribing...");
      expect(shown(element, ".recording-status")).toBeUndefined();
      expect(button(element).disabled).toBe(true);

      response.resolve(Response.json({ text: "done" }));
      expect(await completed).toMatchObject({
        transcription: { text: "done" },
      });
      await time.runMicrotasks();
      await element.updateComplete;
      expect(shown(element, ".processing")).toBeUndefined();
      expect(button(element).disabled).toBe(false);
    });

    it("returns empty text where the response has none", async () => {
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      const completed = next(element, "cf-transcription-complete");
      await startByClick(element);
      await stopByClick(element);
      expect(await completed).toMatchObject({
        transcription: { text: "" },
      });
    });

    it("shows and fires `cf-transcription-error` where the endpoint answers with a failure", async () => {
      world.respond = () =>
        Promise.resolve(
          new Response("nope", { status: 503, statusText: "Unavailable" }),
        );
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
      });
      await startByClick(element);
      await stopByClick(element);

      const failure = events.find((e) => e.type === "cf-transcription-error");
      expect(member(failure?.detail, "message")).toBe(
        "Transcription failed: Unavailable",
      );
      expect(member(failure?.detail, "error")).toBeInstanceOf(Error);
      expect(shown(element, ".error")).toBe(
        "Transcription failed: Transcription failed: Unavailable",
      );
      expect(events.some((e) => e.type === "cf-transcription-complete"))
        .toBe(false);
      expect(button(element).disabled).toBe(false);
    });

    it("does not transcribe where `autoTranscribe` is off", async () => {
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
        autoTranscribe: false,
      });
      await startByClick(element);
      const stopped = next(element, "cf-recording-stop");
      button(element).click();
      time.tick(0);
      await stopped;
      await time.runMicrotasks();
      expect(world.requests).toEqual([]);
      expect(events.some((e) => e.type === "cf-transcription-start")).toBe(
        false,
      );
    });
  });

  describe("the transcription value", () => {
    const earlier: TranscriptionData = {
      id: "voice-earlier",
      text: "earlier",
      duration: 1,
      timestamp: 1,
    };

    async function transcribe(element: CFVoiceInput) {
      world.respond = () => Promise.resolve(Response.json({ text: "new" }));
      await startByClick(element);
      await stopByClick(element);
    }

    describe("stored", () => {
      it("is written to a bound cell, and fires `cf-change` with it", async () => {
        const cell = createMockCellHandle<TranscriptionData | null>(null);
        const { element, events } = await voiceInputWith({
          recordingMode: "toggle",
          transcription: cell,
        });
        await transcribe(element);

        expect(cell.get()).toMatchObject({ text: "new" });
        expect(writesSent(cell).map((w) => w.value)).toEqual([cell.get()]);
        expect(events.findLast((e) => e.type === "cf-change")?.detail).toEqual({
          transcription: cell.get(),
        });
      });

      it("replaces a plain transcription value, and fires `cf-change` with the new one", async () => {
        const { element, events } = await voiceInputWith({
          recordingMode: "toggle",
          transcription: earlier,
        });
        await transcribe(element);

        const change = events.findLast((e) => e.type === "cf-change");
        expect(member(change?.detail, "transcription")).toMatchObject({
          text: "new",
        });
        expect(earlier.text).toBe("earlier");
      });

      it("is kept nowhere, and fires no `cf-change`, where nothing is bound", async () => {
        const { element, events } = await voiceInputWith({
          recordingMode: "toggle",
        });
        await transcribe(element);
        expect(events.some((e) => e.type === "cf-transcription-complete"))
          .toBe(true);
        expect(events.some((e) => e.type === "cf-change")).toBe(false);
      });

      it("is written to the cell bound most recently", async () => {
        const first = createMockCellHandle<TranscriptionData | null>(null);
        const second = createMockCellHandle<TranscriptionData | null>(null, {
          id: "of:second-cell",
        });
        const { element } = await voiceInputWith({
          recordingMode: "toggle",
          transcription: first,
        });
        element.transcription = second;
        await element.updateComplete;
        await transcribe(element);

        expect(writesSent(first)).toEqual([]);
        expect(second.get()).toMatchObject({ text: "new" });
      });
    });

    it("fires `cf-change` with a transcription the bound cell receives from elsewhere", async () => {
      const cell = createMockCellHandle<TranscriptionData | null>(null);
      const { events } = await voiceInputWith({ transcription: cell });
      events.length = 0;
      pushUpdate(cell, earlier);
      expect(events).toEqual([{
        type: "cf-change",
        detail: { transcription: earlier },
      }]);
    });
  });

  describe("removed while recording", () => {
    it("releases the microphone and stops the recorder without reporting a recording", async () => {
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
      });
      await startByClick(element);
      const { stream } = recorder();
      element.remove();
      await time.runMicrotasks();

      expect(stream.track.stopped).toBe(true);
      expect(recorder().state).toBe("inactive");
      expect(StandInAudioContext.sources[0].disconnected).toBe(true);
      expect(events.map((e) => e.type)).toEqual(["cf-recording-start"]);

      // Its timers are gone with it.
      time.tick(120_000);
      expect(events.map((e) => e.type)).toEqual(["cf-recording-start"]);
    });

    it("fires no `cf-recording-start`, and leaves no timer to stop a later recording, where removed while it draws the recording", async () => {
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
        autoTranscribe: false,
        maxDuration: 2,
      });
      Object.defineProperty(globalThis, "MediaRecorder", {
        configurable: true,
        // A recorder whose element is removed once it has started, before
        // the recording is drawn.
        value: class extends StandInRecorder {
          constructor(stream: StandInStream, options: { mimeType?: string }) {
            super(stream, options);
            queueMicrotask(() => element.remove());
          }
        },
      });
      button(element).click();
      await time.runMicrotasks();
      expect(recorder().state).toBe("inactive");
      expect(recorder().stream.track.stopped).toBe(true);
      expect(events).toEqual([]);

      Object.defineProperty(globalThis, "MediaRecorder", {
        configurable: true,
        value: StandInRecorder,
      });
      time.tick(1000);
      await mount(element);
      await startByClick(element);
      time.tick(1999);
      expect(recorder().state).toBe("recording");
      time.tick(1);
      expect(recorder().state).toBe("inactive");
    });

    it("releases a microphone granted after it was removed, and records nothing", async () => {
      const answer = Promise.withResolvers<StandInStream>();
      world.microphone = () => answer.promise;
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
      });
      button(element).click();
      element.remove();
      const stream = new StandInStream();
      answer.resolve(stream);
      await time.runMicrotasks();

      expect(stream.track.stopped).toBe(true);
      expect(StandInRecorder.made).toEqual([]);
      expect(events).toEqual([]);
    });

    it("stops nothing again, and fires nothing, where removed after its recording finished", async () => {
      const { element, events } = await voiceInputWith({
        recordingMode: "toggle",
      });
      await startByClick(element);
      const { stream } = recorder();
      await stopByClick(element);
      events.length = 0;
      element.remove();
      await time.runMicrotasks();

      expect(recorder().state).toBe("inactive");
      expect(stream.track.stopped).toBe(true);
      expect(events).toEqual([]);
    });

    it("leaves a recording started after it was added again running when the transcription from before its removal arrives", async () => {
      const first = Promise.withResolvers<Response>();
      const responses = [first.promise];
      world.respond = () =>
        responses.shift() ?? Promise.resolve(Response.json({ text: "" }));
      const { element } = await voiceInputWith({ recordingMode: "toggle" });
      await startByClick(element);
      const requested = next(element, "cf-transcription-start");
      button(element).click();
      time.tick(0);
      await requested;
      element.remove();
      await mount(element);
      await startByClick(element);
      const { stream } = recorder();

      const completed = next(element, "cf-transcription-complete");
      first.resolve(Response.json({ text: "before" }));
      await completed;
      await time.runMicrotasks();
      await element.updateComplete;
      expect(shown(element, ".recording-status")).toContain("Recording");
      expect(button(element).getAttribute("aria-label")).toBe(
        "Stop recording",
      );

      await stopByClick(element);
      expect(stream.track.stopped).toBe(true);
      expect(StandInRecorder.made.length).toBe(2);
      expect(world.microphoneRequests.length).toBe(2);
      expect(shown(element, ".recording-status")).toBeUndefined();
    });
  });

  describe("theme", () => {
    it("writes a theme given to it onto its style", async () => {
      const { element } = await voiceInputWith({
        theme: { ...defaultTheme, fontFamily: "serif" },
      });
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "serif",
      );
    });
  });
});
