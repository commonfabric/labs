import { assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findNodeByProp,
  readValue,
} from "../test/vnode-helpers.ts";
import GeneratedArt, {
  deriveGeneratedArtFetchState,
  generatedImageUrlFor,
  safeImageUrl,
} from "./generated-art.tsx";

const STORED_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";

// 1×1 transparent PNG served by the mocked generation endpoint; the expected
// `imageDataUrl` is its exact data URL (bytes → base64 identity round-trip).
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const EXPECTED_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body: TINY_PNG_BASE64,
  },
];

export default pattern(() => {
  const art = GeneratedArt({
    prompt: "Sushi Place",
    sourceUrl: STORED_IMAGE,
    shouldGenerate: false,
  });

  // The gate: a non-generating instance (a non-host viewer) with nothing
  // stored renders only the fallback — no stored <img>, no generated overlay.
  const gated = GeneratedArt({
    prompt: "Sushi Place",
    shouldGenerate: false,
  });

  // The prompt guard (CT-1820 adjacent): a transiently-empty prompt must not
  // build a generation request even when generation is allowed; only the
  // fallback renders.
  const empty = GeneratedArt({
    prompt: "",
    shouldGenerate: true,
  });

  // The generation path (mocked endpoint): a generation-allowed instance
  // with nothing stored fetches and exposes its fetch-derived outputs.
  const generating = GeneratedArt({
    prompt: "Sushi Place",
    shouldGenerate: true,
  });

  // The static instances assert via the rendered UI; the generating instance
  // ALSO asserts direct reads of fetch-derived outputs (`fetchState`,
  // `imageDataUrl`) — parent-readable since the CT-1836 traversal fix (the
  // CT-1811-family gap that once forced a notify-stream seam here).
  const assert_stored_image_renders_directly = assert(() =>
    findNodeByProp(art[UI], "src", STORED_IMAGE) !== undefined
  );

  const assert_gated_instance_shows_fallback_only = assert(() =>
    findElement(gated[UI], "img") === undefined &&
    findElement(gated[UI], "cf-image") === undefined
  );

  const assert_empty_prompt_shows_fallback_only = assert(() =>
    findElement(empty[UI], "img") === undefined &&
    findElement(empty[UI], "cf-image") === undefined
  );

  const assert_generation_outputs_materialize = assert(() =>
    readValue(generating.fetchState) === "generated" &&
    readValue(generating.imageDataUrl) === EXPECTED_DATA_URL
  );

  const assert_generated_overlay_renders = assert(() =>
    findElement(generating[UI], "cf-image") !== undefined
  );

  const assert_safe_image_url_accepts_web_urls = assert(() =>
    safeImageUrl(" https://example.com/art.png ") ===
      "https://example.com/art.png" &&
    safeImageUrl("http://example.com/art.png") ===
      "http://example.com/art.png"
  );

  const assert_safe_image_url_rejects_unsafe_or_invalid_urls = assert(() =>
    safeImageUrl("javascript:alert(1)") === "" &&
    safeImageUrl("not a URL") === ""
  );

  const assert_generated_url_encodes_title_and_size = assert(() => {
    const url = generatedImageUrlFor("Tacos & Tea");
    return url.includes("Tacos%20%26%20Tea") &&
      url.endsWith("&width=128&height=128");
  });

  const assert_fetch_state_lifecycle = assert(() =>
    deriveGeneratedArtFetchState("", undefined, true, false, false, false) ===
      "" &&
    deriveGeneratedArtFetchState(
        "Sushi",
        STORED_IMAGE,
        true,
        false,
        false,
        false,
      ) === "stored" &&
    deriveGeneratedArtFetchState(
        "Sushi",
        undefined,
        false,
        false,
        false,
        false,
      ) === "" &&
    deriveGeneratedArtFetchState(
        "Sushi",
        undefined,
        true,
        true,
        false,
        false,
      ) === "generated" &&
    deriveGeneratedArtFetchState(
        "Sushi",
        undefined,
        true,
        false,
        true,
        false,
      ) === "pending" &&
    deriveGeneratedArtFetchState(
        "Sushi",
        undefined,
        true,
        false,
        false,
        true,
      ) === "error" &&
    deriveGeneratedArtFetchState(
        "Sushi",
        undefined,
        true,
        false,
        false,
        false,
      ) === "requested"
  );

  return {
    [TESTS]: [
      { assertion: assert_safe_image_url_accepts_web_urls },
      { assertion: assert_safe_image_url_rejects_unsafe_or_invalid_urls },
      { assertion: assert_generated_url_encodes_title_and_size },
      { assertion: assert_fetch_state_lifecycle },
      { assertion: assert_stored_image_renders_directly },
      { assertion: assert_gated_instance_shows_fallback_only },
      { assertion: assert_empty_prompt_shows_fallback_only },
      // The first of these reads the generating instance's mocked fetch,
      // which starts it; the harness waits for the response before it
      // reads again.
      { assertion: assert_generation_outputs_materialize },
      { assertion: assert_generated_overlay_renders },
    ],
  };
});
