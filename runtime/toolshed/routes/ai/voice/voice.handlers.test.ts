import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { TranscriptionClient } from "./voice.handlers.ts";
import { createVoiceRouter } from "./voice.index.ts";
import { createTestApp } from "@/lib/create-app.ts";

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7]);
const AUDIO_URL = "https://fal.example/audio.wav";
const CHUNKS = [
  { timestamp: [0, 1.5], text: "hello" },
  { timestamp: [1.5, 3], text: "world" },
];

type Transcription = Awaited<ReturnType<TranscriptionClient["subscribe"]>>;

describe("voice.handlers", () => {
  let tempDir: string;
  let cacheDir: string;
  let uploads: Blob[];
  let subscribeInputs: unknown[];
  let transcribe: () => Promise<Transcription>;

  function transcribeRequest(
    query = "",
    init: {
      contentType?: string;
      body?: Uint8Array<ArrayBuffer>;
      origin?: string;
    } = {},
  ) {
    const app = createTestApp(createVoiceRouter({
      client: {
        storage: {
          upload(file) {
            uploads.push(file);
            return Promise.resolve(AUDIO_URL);
          },
        },
        subscribe(_endpointId, options) {
          subscribeInputs.push(options.input);
          return transcribe();
        },
      },
      cacheDir,
    }));
    return app.request(`/api/ai/voice/transcribe${query}`, {
      method: "POST",
      headers: {
        ...(init.contentType === undefined
          ? {}
          : { "Content-Type": init.contentType }),
        ...(init.origin === undefined ? {} : { Origin: init.origin }),
      },
      body: init.body ?? AUDIO,
    });
  }

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    cacheDir = `${tempDir}/ai-voice`;
    uploads = [];
    subscribeInputs = [];
    transcribe = () =>
      Promise.resolve({ data: { text: "hello world", chunks: CHUNKS } });
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("returns the CORS origin header on the transcription response", async () => {
    const response = await transcribeRequest("", {
      contentType: "audio/mpeg",
      origin: "https://app.example.com",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("uploads the audio, transcribes it, and returns the text with its chunks", async () => {
    const response = await transcribeRequest("", { contentType: "audio/mpeg" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "full",
      transcription: "hello world",
      chunks: CHUNKS,
    });
    expect(uploads.length).toBe(1);
    expect(uploads[0].type).toBe("audio/mpeg");
    expect(new Uint8Array(await uploads[0].arrayBuffer())).toEqual(AUDIO);
    expect(subscribeInputs).toEqual([{ audio_url: AUDIO_URL }]);
  });

  it("treats a request without a content type as WAV audio", async () => {
    const response = await transcribeRequest("", {});
    await response.json();

    expect(response.status).toBe(200);
    expect(uploads[0].type).toBe("audio/wav");
  });

  it("returns only the transcription or only the chunks when asked", async () => {
    const text = await transcribeRequest("?response_type=text", {
      contentType: "audio/wav",
    });
    expect(await text.json()).toEqual({
      response_type: "text",
      transcription: "hello world",
    });

    const chunks = await transcribeRequest("?response_type=chunks", {
      contentType: "audio/wav",
    });
    expect(await chunks.json()).toEqual({
      response_type: "chunks",
      chunks: CHUNKS,
    });
  });

  it("serves the same audio from the cache without transcribing again", async () => {
    await (await transcribeRequest("", { contentType: "audio/wav" })).json();
    const cached = await transcribeRequest("?response_type=text", {
      contentType: "audio/wav",
    });

    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({
      response_type: "text",
      transcription: "hello world",
    });
    expect(subscribeInputs.length).toBe(1);
    expect(uploads.length).toBe(1);
  });

  it("transcribes different audio again", async () => {
    await (await transcribeRequest("", { contentType: "audio/wav" })).json();
    const other = await transcribeRequest("", {
      contentType: "audio/wav",
      body: new Uint8Array([1, 2, 3]),
    });
    await other.json();

    expect(subscribeInputs.length).toBe(2);
  });

  it("transcribes again when the cached file is not valid JSON", async () => {
    await (await transcribeRequest("", { contentType: "audio/wav" })).json();
    for (const entry of Deno.readDirSync(cacheDir)) {
      Deno.writeTextFileSync(`${cacheDir}/${entry.name}`, "{not json");
    }
    const response = await transcribeRequest("", { contentType: "audio/wav" });

    expect(response.status).toBe(200);
    expect((await response.json()).transcription).toBe("hello world");
    expect(subscribeInputs.length).toBe(2);
  });

  it("returns an empty chunk list when the model returns none", async () => {
    transcribe = () => Promise.resolve({ data: { text: "hi" } });
    const response = await transcribeRequest("", { contentType: "audio/wav" });

    expect(await response.json()).toEqual({
      response_type: "full",
      transcription: "hi",
      chunks: [],
    });
  });

  it("returns 400 without uploading for an unsupported content type", async () => {
    const response = await transcribeRequest("", { contentType: "audio/ogg" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Unsupported content type",
    });
    expect(uploads).toEqual([]);
  });

  it("returns 400 without uploading for an empty body", async () => {
    const response = await transcribeRequest("", {
      contentType: "audio/wav",
      body: new Uint8Array(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No audio data provided" });
    expect(uploads).toEqual([]);
  });

  it("returns 422 without uploading for an unknown response type", async () => {
    const response = await transcribeRequest("?response_type=words", {
      contentType: "audio/wav",
    });
    await response.json();

    expect(response.status).toBe(422);
    expect(uploads).toEqual([]);
  });

  it("returns 400 and caches nothing when the model returns no text", async () => {
    for (const data of [undefined, {}, { text: "" }]) {
      transcribe = () => Promise.resolve({ data });
      const response = await transcribeRequest("", {
        contentType: "audio/wav",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Failed to transcribe audio",
      });
    }
    await expect(Deno.stat(cacheDir)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("returns 400 and caches nothing when a chunk's timestamp is not a pair of numbers", async () => {
    for (const timestamp of [[0], [0, "1.5"], [0, 1.5, 3]]) {
      transcribe = () =>
        Promise.resolve({
          data: { text: "hello", chunks: [{ timestamp, text: "hello" }] },
        });
      const response = await transcribeRequest("", {
        contentType: "audio/wav",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Failed to transcribe audio",
      });
    }
    await expect(Deno.stat(cacheDir)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("returns 500 when the model call throws", async () => {
    transcribe = () => Promise.reject(new Error("upstream down"));
    const response = await transcribeRequest("", { contentType: "audio/wav" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to transcribe audio",
    });
  });
});
