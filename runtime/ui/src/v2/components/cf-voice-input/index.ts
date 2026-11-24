import { CFVoiceInput } from "./cf-voice-input.ts";

if (!customElements.get("cf-voice-input")) {
  customElements.define("cf-voice-input", CFVoiceInput);
}

export type { CFVoiceInput as CFVoiceInputElement } from "./cf-voice-input.ts";

export { CFVoiceInput };
export type {
  TranscriptionChunk,
  TranscriptionData,
} from "./cf-voice-input.ts";
