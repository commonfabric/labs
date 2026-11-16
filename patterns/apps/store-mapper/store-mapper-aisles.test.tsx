/**
 * Test Pattern: Store Mapper aisles tab
 *
 * Works the aisles tab the way a person does, through the controls it
 * renders: adding aisles from the message input, which the tab sorts and
 * checks for gaps, removing one, and uploading and hiding aisle-sign photos.
 * `ExtractedAisleResults` is rendered with extraction results the test
 * supplies, since no model runs in a pattern test to produce them, and its
 * Merge, Add and Add All buttons are pressed.
 *
 * Run: deno task cf test --root patterns patterns/apps/store-mapper/store-mapper-aisles.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElement,
  fireEvent,
  hasText,
  innermostNode,
  inOrder,
  rowWith,
  textContent,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import { AislesTab, ExtractedAisleResults } from "./store-mapper.tsx";

interface Aisle {
  name: string;
  description: string;
}

interface UploadedImage {
  id: string;
  name: string;
  url?: string;
}

/** Sends `message` from the aisle input, as pressing send does. */
const sendAisle = (ui: unknown, message: string): void =>
  fireEvent(findElement(ui, "cf-message-input"), "oncf-send", {
    detail: { message },
  });

/** Whether the card for the uploaded photo named `name` shows `status`: the
 * innermost node holding both is a single photo's card, not the list. */
const photoCardShows = (ui: unknown, name: string, status: string): boolean => {
  const card = innermostNode(
    ui,
    (node) => hasText(node, `📷 ${name}`) && hasText(node, status),
  );
  return card !== undefined && textContent(card).split("📷").length === 2;
};

/** Reports photos from the image input, as choosing files does. */
const upload = (
  ui: unknown,
  detail: { images?: UploadedImage[]; files?: UploadedImage[] },
): void =>
  fireEvent(findElement(ui, "cf-image-input"), "oncf-change", { detail });

/** The description of the aisle named `name`. */
const descriptionOf = (
  aisles: readonly Aisle[],
  name: string,
): string | undefined => aisles.find((a) => a.name === name)?.description;

export default pattern(() => {
  // ==========================================================================
  // Aisles tab
  // ==========================================================================

  const aisles = new Writable<Aisle[]>([]);
  const uploadedPhotos = new Writable<UploadedImage[]>([]);
  const hiddenPhotos = new Writable<string[]>([]);
  const aislesTab = AislesTab({
    aisles,
    uploadedPhotos,
    hiddenPhotoIds: hiddenPhotos,
  });
  const action_add_aisles = action(() => {
    for (const name of ["3", " 1 ", "5B", "5A", "1", "  "]) {
      sendAisle(aislesTab[UI], name);
    }
  });
  const action_add_lowercase_5b = action(() => sendAisle(aislesTab[UI], "5b"));
  const action_remove_aisle_5b = action(() =>
    clickInRow(aislesTab[UI], "Aisle 5B", "×")
  );
  const action_upload_nothing = action(() => upload(aislesTab[UI], {}));
  const action_upload_sign = action(() =>
    upload(aislesTab[UI], {
      images: [{
        id: "photo-1",
        name: "aisle-sign.jpg",
        url: "https://example.test/aisle-sign.jpg",
      }],
    })
  );
  const action_upload_endcap = action(() =>
    upload(aislesTab[UI], { files: [{ id: "photo-2", name: "endcap.jpg" }] })
  );
  const action_hide_sign_photo = action(() =>
    clickInRow(aislesTab[UI], "aisle-sign.jpg", "×")
  );

  // ==========================================================================
  // Aisles given as the list's initial value
  // ==========================================================================

  const seededAisles = new Writable<Aisle[]>([
    { name: "2", description: "" },
    { name: "1", description: "" },
    { name: "5a", description: "" },
    { name: "5A", description: "" },
  ]);
  const seededTab = AislesTab({
    aisles: seededAisles,
    uploadedPhotos: new Writable<UploadedImage[]>([]),
    hiddenPhotoIds: new Writable<string[]>([]),
  });
  const action_describe_aisle_1 = action(() =>
    typeInto(
      rowWith(seededTab[UI], "Aisle 1", "×"),
      "Description (e.g., Bread & Cereal)",
      "Milk",
    )
  );
  const action_remove_seeded_aisle_5_upper = action(() =>
    clickInRow(seededTab[UI], "Aisle 5A", "×")
  );
  const action_remove_seeded_aisle_2 = action(() =>
    clickInRow(seededTab[UI], "Aisle 2", "×")
  );

  // ==========================================================================
  // Extraction results, rendered from results the test supplies
  // ==========================================================================

  const resultAisles = new Writable<Aisle[]>([
    { name: "3", description: "- Pasta" },
  ]);
  const hiddenPhotoIds = new Writable<string[]>([]);
  const results = ExtractedAisleResults({
    extracted: [
      { name: "3", products: ["Soup"] },
      { name: "7", products: ["Rice", "Beans"] },
      { name: "8", products: null },
    ],
    aisles: resultAisles,
    hiddenPhotoIds,
    photoId: "photo-1",
  });
  const noResults = ExtractedAisleResults({
    extracted: [],
    aisles: resultAisles,
    hiddenPhotoIds,
    photoId: "photo-2",
  });
  const action_merge_into_3 = action(() =>
    clickInRow(results[UI], "Aisle 3", "Merge")
  );
  const action_add_8 = action(() => clickInRow(results[UI], "Aisle 8", "Add"));
  const action_add_all = action(() =>
    clickButton(results[UI], "+ Add All 1 New Aisles")
  );

  return {
    [TESTS]: [
      // === Aisles tab: added from the input, sorted, gap-checked ===
      {
        assertion: assert(() =>
          hasText(aislesTab[UI], "No aisles yet. Add one below!")
        ),
      },
      { action: action_add_aisles },
      {
        assertion: assert(() =>
          aisles.get().map((a) => a.name).sort().join(",") === "1,3,5A,5B"
        ),
      },
      {
        assertion: assert(() =>
          inOrder(textContent(aislesTab[UI]), [
            "Aisle 1",
            "Aisle 3",
            "Aisle 5A",
            "Aisle 5B",
          ]) &&
          hasText(aislesTab[UI], "Missing aisle(s) detected: 2, 4") &&
          !hasText(aislesTab[UI], "No aisles yet")
        ),
      },
      // A name differing only in case names the same aisle.
      { action: action_add_lowercase_5b },
      {
        assertion: assert(() =>
          aisles.get().map((a) => a.name).sort().join(",") === "1,3,5A,5B"
        ),
      },
      { action: action_remove_aisle_5b },
      {
        assertion: assert(() =>
          aisles.get().map((a) => a.name).sort().join(",") === "1,3,5A" &&
          !hasText(aislesTab[UI], "Aisle 5B")
        ),
      },

      // === Aisles tab: photo uploads ===
      { action: action_upload_nothing },
      { assertion: assert(() => uploadedPhotos.get().length === 0) },
      { action: action_upload_sign },
      { action: action_upload_endcap },
      {
        assertion: assert(() =>
          uploadedPhotos.get().map((p) => p.name).join(",") ===
            "aisle-sign.jpg,endcap.jpg"
        ),
      },
      // The sign photo's extraction request fails, since a pattern test has
      // no model endpoint; the end-cap photo has no image, so nothing is
      // asked of a model and its card reports no aisles.
      {
        assertion: assert(() =>
          photoCardShows(
            aislesTab[UI],
            "aisle-sign.jpg",
            "Error analyzing photo",
          ) &&
          photoCardShows(
            aislesTab[UI],
            "endcap.jpg",
            "No aisles detected in photo",
          ) &&
          !hasText(aislesTab[UI], "Analyzing photo...")
        ),
      },
      { action: action_hide_sign_photo },
      {
        assertion: assert(() =>
          hiddenPhotos.get().join(",") === "photo-1" &&
          !hasText(aislesTab[UI], "aisle-sign.jpg") &&
          hasText(aislesTab[UI], "📷 endcap.jpg")
        ),
      },

      // === Aisles given as the list's initial value ===
      {
        assertion: assert(() =>
          inOrder(textContent(seededTab[UI]), ["Aisle 1", "Aisle 2"])
        ),
      },
      { action: action_describe_aisle_1 },
      {
        assertion: assert(() =>
          descriptionOf(seededAisles.get(), "1") === "Milk"
        ),
      },
      { action: action_remove_seeded_aisle_2 },
      {
        assertion: assert(() =>
          seededAisles.get().map((a) => a.name).join(",") === "1,5a,5A" &&
          !hasText(seededTab[UI], "Aisle 2")
        ),
      },

      // A list may hold names differing only in case; × removes that row's own.
      { action: action_remove_seeded_aisle_5_upper },
      {
        assertion: assert(() =>
          seededAisles.get().map((a) => a.name).join(",") === "1,5a"
        ),
      },

      // === Extraction results ===
      {
        assertion: assert(() =>
          hasText(noResults[UI], "No aisles detected in photo")
        ),
      },
      {
        assertion: assert(() =>
          hasText(results[UI], "+ Add All 2 New Aisles") &&
          hasText(rowWith(results[UI], "Aisle 3", "Merge"), "(exists)") &&
          hasText(rowWith(results[UI], "Aisle 7", "Add"), "Rice, Beans") &&
          hasText(rowWith(results[UI], "Aisle 8", "Add"), "(no products)")
        ),
      },
      { action: action_merge_into_3 },
      {
        assertion: assert(() =>
          descriptionOf(resultAisles.get(), "3") === "- Pasta\n- Soup"
        ),
      },
      { action: action_add_8 },
      {
        assertion: assert(() =>
          descriptionOf(resultAisles.get(), "8") === "" &&
          hasText(results[UI], "+ Add All 1 New Aisles") &&
          hasText(rowWith(results[UI], "Aisle 8", "Merge"), "(exists)")
        ),
      },
      { action: action_add_all },
      {
        assertion: assert(() =>
          resultAisles.get().map((a) => a.name).join(",") === "3,8,7" &&
          descriptionOf(resultAisles.get(), "7") === "- Rice\n- Beans" &&
          hiddenPhotoIds.get().join(",") === "photo-1" &&
          !hasText(results[UI], "+ Add All")
        ),
      },
    ],
    // Allows every console warning, since the runner has no narrower setting.
    // The one this test causes is the llm builtin's warning that the sign
    // photo's extraction request failed ("Invalid URL"), as a pattern test
    // has no model endpoint.
    allowConsoleWarnings: true,
  };
});
