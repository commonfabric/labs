/**
 * Test: lunch-poll generated-art wiring — host-gated generation + explicit
 * keep-action persistence (the post-CT-1836 structure: the card reads the
 * GeneratedArt sub-pattern's fetch-derived outputs directly; nothing sends
 * from inside a computed).
 *
 * Single-identity caveat (as main.test.tsx): this runtime's one identity IS
 * the host after joining, so the host path runs end-to-end: join → add an
 * option → the host-gated GeneratedArt fetches the mocked /api/ai/img
 * generation (visible as the cf-image overlay) → the host keeps it — the
 * card's keep button sends { optionId, imageUrl } into `setOptionImage`; this
 * test drives that same stream directly with the imageUrl the button would
 * read — → the option carries `imageUrl` and the stored <img> renders. Every
 * other viewer renders that same stored value by construction (sourceUrl
 * short-circuits generation); the gate itself (shouldGenerate) is covered at
 * the sub-pattern level in generated-art.test.tsx.
 */

import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElement,
  findNodeByProp,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import CozyPoll, { type LunchProfile } from "./main.tsx";

// 1×1 transparent PNG, the mocked generation response body. The persisted
// value is its exact data URL: FetchBinary bytes → base64 re-encode is an
// identity round-trip on the same bytes, so the card's keep button and this
// test send the same string. (Both plain literals: SES-mode module scope
// rejects computed top-level values like template joins.)
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
  // Identity is a profile cell; claim the host's through the test seam.
  const host = Writable.of<LunchProfile>({ name: "Host" });
  const poll = CozyPoll({});

  const action_become_host = action(() => {
    poll.overrideViewer.send({ profile: host, name: "Host" });
  });

  const action_join_as_host = action(() => {
    poll.joinAs.send({});
  });

  const action_add_sushi = action(() => {
    poll.addOption.send({ title: "Sushi Palace" });
  });

  const assert_option_added = assert(() =>
    poll.options.length === 1 && poll.options[0]?.title === "Sushi Palace"
  );

  // Post-settle the host's client has generated: the cf-image overlay
  // (generated, not yet stored) is in the rendered tree — the fetch-derived
  // read chain through both sub-pattern boundaries works. (Until CT-1836's
  // traversal fix this file carried a canary pinning the opposite.)
  const assert_generated_overlay_renders = assert(() =>
    findElement(poll[UI], "cf-image") !== undefined
  );

  // The host keeps the art: the same payload the card's keep button sends
  // (the button reads `art.imageDataUrl`, which equals EXPECTED_DATA_URL for
  // the mocked bytes — the identity round-trip noted above).
  const action_keep_art = action(() => {
    const optionId = readValue(poll.options[0]?.id);
    poll.setOptionImage.send({
      optionId: typeof optionId === "string" ? optionId : "",
      imageUrl: EXPECTED_DATA_URL,
    });
  });

  const assert_image_persisted = assert(() =>
    readValue(poll.options[0]?.imageUrl) === EXPECTED_DATA_URL
  );

  const assert_stored_img_renders = assert(() =>
    findNodeByProp(poll[UI], "src", EXPECTED_DATA_URL) !== undefined
  );

  return {
    [TESTS]: [
      { action: action_become_host },
      { action: action_join_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      // Drives the mocked generation fetch to completion.
      { settle: true },
      { assertion: assert_generated_overlay_renders },
      { action: action_keep_art },
      { assertion: assert_image_persisted },
      // One more settle beat: the persisted URL flows back into the card as
      // `sourceUrl` and the stored-<img> branch re-renders.
      { settle: true },
      { assertion: assert_stored_img_renders },
    ],
    poll,
  };
});
