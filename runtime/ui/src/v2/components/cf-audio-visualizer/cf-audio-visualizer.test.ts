// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { sampleBarLevels } from "./cf-audio-visualizer.ts";
import { CFAudioVisualizer } from "./index.ts";

/** What the stand-in Web Audio objects were asked to do. */
interface AudioRecord {
  /** The contexts made, in order. */
  readonly contexts: { state: string }[];
  /** The analyser of the latest source, with the settings it was given. */
  analyser?: { fftSize: number; smoothingTimeConstant: number };
  /** The stream of each source made, and whether it is still connected. */
  readonly sources: { stream: unknown; connected: boolean }[];
  /** The frequency bins the analysers report, from 0 to 255 each. */
  bins: number[];
}

/**
 * Puts a stand-in `AudioContext` on the global object, which Deno and
 * happy-dom lack, and returns what it records.
 */
function installAudio(): AudioRecord {
  const record: AudioRecord = { contexts: [], sources: [], bins: [] };
  class StandInAudioContext {
    state = "running";
    constructor() {
      record.contexts.push(this);
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        smoothingTimeConstant: 0,
        get frequencyBinCount() {
          return record.bins.length;
        },
        getByteFrequencyData: (data: Uint8Array) => data.set(record.bins),
      };
    }
    createMediaStreamSource(stream: unknown) {
      const source = { stream, connected: false };
      record.sources.push(source);
      return {
        connect: (analyser: AudioRecord["analyser"]) => {
          record.analyser = analyser;
          source.connected = true;
        },
        disconnect: () => {
          source.connected = false;
        },
      };
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    writable: true,
    value: StandInAudioContext,
  });
  return record;
}

/** The height of each bar `element` draws. */
const barHeights = (element: CFAudioVisualizer): number[] =>
  [...element.shadowRoot!.querySelectorAll("rect")].map((rect) =>
    Number(rect.getAttribute("height"))
  );

/** A stand-in for the microphone stream the analyser reads. */
const STREAM = {} as MediaStream;

describe("cf-audio-visualizer", () => {
  describe("sampleBarLevels()", () => {
    it("sets each level from bins at even steps after the two lowest", () => {
      const frequencies = new Uint8Array(
        [255, 255, 0, 51, 102, 153, 204, 255, 0, 0],
      );
      const levels = [9, 9, 9, 9];

      sampleBarLevels(frequencies, levels);

      // Eight bins after the skipped two, over four bars: every second bin.
      expect(levels).toEqual([0, 0.4, 0.8, 0]);
    });

    it("sets every level from the first unskipped bin when there are more bars than bins", () => {
      const levels = [9, 9, 9];

      sampleBarLevels(new Uint8Array([0, 0, 51, 255]), levels);

      expect(levels).toEqual([0.2, 0.2, 0.2]);
    });

    it("sets every level from the last bin when no bin is left after the skipped ones", () => {
      const levels = [9, 9];

      sampleBarLevels(new Uint8Array([0, 102]), levels);

      expect(levels).toEqual([0.4, 0.4]);
    });
  });

  describe("CFAudioVisualizer", () => {
    /** Animation frames requested and not yet run or cancelled. */
    let frames: Map<number, FrameRequestCallback>;
    let requestFrame: Stub;
    let cancelFrame: Stub;
    let audio: AudioRecord;

    /** Runs the pending animation frames. */
    const runFrames = () => {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(0);
    };

    beforeEach(() => {
      frames = new Map();
      let lastId = 0;
      requestFrame = stub(globalThis, "requestAnimationFrame", (frame) => {
        frames.set(++lastId, frame);
        return lastId;
      });
      cancelFrame = stub(globalThis, "cancelAnimationFrame", (id) => {
        frames.delete(id);
      });
      audio = installAudio();
    });

    afterEach(() => {
      requestFrame.restore();
      cancelFrame.restore();
      Reflect.deleteProperty(globalThis, "AudioContext");
      document.body.replaceChildren();
    });

    it("registers the custom element", () => {
      expect(customElements.get("cf-audio-visualizer")).toBe(
        CFAudioVisualizer,
      );
    });

    it("draws its bars at a resting height before it visualizes anything", async () => {
      const element = await mount(new CFAudioVisualizer());

      expect(barHeights(element)).toEqual(Array(8).fill(4));
      const svg = element.shadowRoot!.querySelector("svg")!;
      expect(svg.getAttribute("height")).toBe("40px");
      expect(svg.getAttribute("viewBox")).toBe("0 0 100 40");
    });

    it("draws its bars evenly across its width, in its color", async () => {
      const element = new CFAudioVisualizer();
      element.bars = 4;
      element.color = "#5865F2";
      await mount(element);

      const rects = [...element.shadowRoot!.querySelectorAll("rect")];
      expect(rects.map((rect) => rect.getAttribute("x"))).toEqual([
        "0%",
        "25%",
        "50%",
        "75%",
      ]);
      expect(rects.map((rect) => rect.getAttribute("width"))).toEqual(
        Array(4).fill("17.5%"),
      );
      expect(rects.map((rect) => rect.getAttribute("fill"))).toEqual(
        Array(4).fill("#5865F2"),
      );
    });

    it("draws each bar at its stream's level, and at least 2 high", async () => {
      const element = new CFAudioVisualizer();
      element.bars = 3;
      element.height = 100;
      await mount(element);
      audio.bins = [0, 0, 255, 0, 51, 0, 0, 0];

      element.startVisualization(STREAM);
      await element.updateComplete;

      expect(audio.sources).toEqual([{ stream: STREAM, connected: true }]);
      expect(audio.analyser).toMatchObject({
        fftSize: 256,
        smoothingTimeConstant: 0.8,
      });
      expect(barHeights(element)).toEqual([100, 20, 2]);
      const ys = [...element.shadowRoot!.querySelectorAll("rect")].map((
        rect,
      ) => rect.getAttribute("y"));
      expect(ys).toEqual(["0", "80", "98"]);
    });

    it("redraws its bars on each animation frame", async () => {
      const element = new CFAudioVisualizer();
      element.bars = 2;
      element.height = 100;
      await mount(element);
      audio.bins = [0, 0, 255, 255, 255, 255];
      element.startVisualization(STREAM);
      await element.updateComplete;
      expect(barHeights(element)).toEqual([100, 100]);

      audio.bins.fill(51);
      runFrames();
      await element.updateComplete;

      expect(barHeights(element)).toEqual([20, 20]);
      expect(frames.size).toBe(1);
    });

    it("returns its bars to rest and disconnects its stream when it stops", async () => {
      const element = await mount(new CFAudioVisualizer());
      audio.bins = Array(16).fill(255);
      element.startVisualization(STREAM);

      element.stopVisualization();
      await element.updateComplete;

      expect(audio.sources[0].connected).toBe(false);
      expect(frames.size).toBe(0);
      expect(barHeights(element)).toEqual(Array(8).fill(4));
    });

    it("draws nothing more for a frame that comes due after it stops", async () => {
      const element = await mount(new CFAudioVisualizer());
      audio.bins = Array(16).fill(255);
      element.startVisualization(STREAM);
      const [late] = frames.values();

      element.stopVisualization();
      late(0);
      await element.updateComplete;

      expect(barHeights(element)).toEqual(Array(8).fill(4));
      expect(frames.size).toBe(0);
    });

    it("replaces the stream it visualizes, reusing its audio context", async () => {
      const element = await mount(new CFAudioVisualizer());
      audio.bins = Array(16).fill(0);
      const other = {} as MediaStream;

      element.startVisualization(STREAM);
      element.startVisualization(other);

      expect(audio.contexts).toHaveLength(1);
      expect(audio.sources).toEqual([
        { stream: STREAM, connected: false },
        { stream: other, connected: true },
      ]);
      expect(frames.size).toBe(1);
    });

    it("closes its audio context when it is removed, and makes a new one when it starts again", async () => {
      const element = await mount(new CFAudioVisualizer());
      audio.bins = Array(16).fill(0);
      element.startVisualization(STREAM);

      element.remove();

      expect(audio.contexts.map((context) => context.state)).toEqual([
        "closed",
      ]);
      expect(audio.sources[0].connected).toBe(false);
      expect(frames.size).toBe(0);

      document.body.append(element);
      element.startVisualization(STREAM);
      expect(audio.contexts.map((context) => context.state)).toEqual([
        "closed",
        "running",
      ]);
    });

    it("closes nothing when it is removed without having started", async () => {
      const element = await mount(new CFAudioVisualizer());

      element.remove();

      expect(audio.contexts).toEqual([]);
    });
  });
});
