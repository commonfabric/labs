/**
 * Test Pattern: Image Analysis
 *
 * Drives the image input the way an upload and a removal do, and checks which
 * of the event's image lists the chat keeps. The model call is not reached
 * here: the test leaves the question empty and its images carry neither data
 * nor a URL, so the chat has nothing to send. `content-parts.test.ts` covers
 * the prompt the chat would build.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import ImageAnalysis from "./image-analysis.tsx";
import {
  findElement,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";

const image = (id: string) => ({
  id,
  name: `${id}.png`,
  url: "",
  data: "",
  timestamp: 0,
  size: 1,
  type: "image/png",
});

export default pattern(() => {
  const chat = ImageAnalysis({});

  const assert_named = assert(() => chat[NAME] === "Image Chat");
  const assert_view_offers_upload = assert(() =>
    hasText(chat[UI], "Upload Images") && hasText(chat[UI], "Your Question")
  );
  const assert_starts_without_images = assert(() =>
    chat.images.get().length === 0
  );
  const assert_nothing_pending = assert(() =>
    chat.pending !== true && chat.response === undefined
  );

  // An upload reports both the new images and every image now held; the
  // chat keeps the whole set.
  const action_upload = action(() => {
    fireEvent(findElement(chat[UI], "cf-image-input"), "oncf-change", {
      detail: { images: [image("b")], allImages: [image("a"), image("b")] },
    });
  });
  const assert_holds_all_images = assert(() =>
    chat.images.get().map((i) => i.id).join() === "a,b"
  );

  // An event naming only files falls back to the full file list.
  const action_remove_by_files = action(() => {
    fireEvent(findElement(chat[UI], "cf-image-input"), "oncf-remove", {
      detail: { files: [image("x")], allFiles: [image("a")] },
    });
  });
  const assert_holds_remaining_file = assert(() =>
    chat.images.get().map((i) => i.id).join() === "a"
  );

  // An event with only the changed images keeps those.
  const action_change_images_only = action(() => {
    fireEvent(findElement(chat[UI], "cf-image-input"), "oncf-change", {
      detail: { images: [image("c")] },
    });
  });
  const assert_holds_changed_image = assert(() =>
    chat.images.get().map((i) => i.id).join() === "c"
  );

  // An event with only the changed files keeps those.
  const action_change_files_only = action(() => {
    fireEvent(findElement(chat[UI], "cf-image-input"), "oncf-change", {
      detail: { files: [image("d")] },
    });
  });
  const assert_holds_changed_file = assert(() =>
    chat.images.get().map((i) => i.id).join() === "d"
  );

  // Removing the last image reports no lists at all.
  const action_remove_last = action(() => {
    fireEvent(findElement(chat[UI], "cf-image-input"), "oncf-remove", {});
  });

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_view_offers_upload },
      { assertion: assert_starts_without_images },
      { assertion: assert_nothing_pending },
      { action: action_upload },
      { assertion: assert_holds_all_images },
      { action: action_remove_by_files },
      { assertion: assert_holds_remaining_file },
      { action: action_change_images_only },
      { assertion: assert_holds_changed_image },
      { action: action_change_files_only },
      { assertion: assert_holds_changed_file },
      { action: action_remove_last },
      { assertion: assert_starts_without_images },
    ],
    chat,
  };
});
