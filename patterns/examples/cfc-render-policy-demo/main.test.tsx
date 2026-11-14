import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findElementByText,
  findNodeById,
  hasExactText,
  hasText,
  propValue,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import RenderPolicyDemo from "./main.tsx";

// The surface and actions the demo's trusted controls declare.
const TRUSTED_HEALTH_DISCLOSURE_SURFACE = "TrustedHealthDisclosureSurface";
const TRUSTED_REVEAL_HEALTH_DATA_ACTION = "TrustedRevealHealthData";
const TRUSTED_CONCEAL_HEALTH_DATA_ACTION = "TrustedConcealHealthData";

const HEALTH_TEXT =
  "Sensitive health data: migraine treatment plan includes medication review.";

const boundaryList = (
  root: unknown,
  id: string,
  list: "max" | "declassify",
): unknown =>
  propValue(
    findElement(findNodeById(root, id), "cf-cfc-render-boundary"),
    list === "max" ? "maxConfidentiality" : "declassifyConfidentiality",
  );

const display = (root: unknown, id: string): unknown =>
  styleOf(findNodeById(root, id), "display");

// A view read does not descend into an array prop's elements, so the label
// lists a boundary carries are compared by length.
const listLength = (value: unknown) =>
  Array.isArray(value) ? value.length : undefined;

export default pattern(() => {
  const demo = RenderPolicyDemo({});

  const assert_names_itself = assert(() =>
    demo[NAME] === "CFC render policy demo"
  );

  // The direct attempt renders the labeled cell behind a default-low boundary
  // that declassifies nothing; only the trusted surface's boundary
  // declassifies a label, and both bind the same labeled health text.
  const assert_only_trusted_surface_declassifies = assert(() =>
    listLength(boundaryList(demo[UI], "raw-health-attempt", "max")) === 0 &&
    boundaryList(demo[UI], "raw-health-attempt", "declassify") === undefined &&
    hasText(findNodeById(demo[UI], "raw-health-direct"), HEALTH_TEXT) &&
    listLength(boundaryList(demo[UI], "trusted-health-surface", "max")) ===
      0 &&
    listLength(
        boundaryList(demo[UI], "trusted-health-surface", "declassify"),
      ) === 1 &&
    hasText(findNodeById(demo[UI], "trusted-health-visible"), HEALTH_TEXT)
  );

  const assert_starts_concealed = assert(() =>
    demo.revealSensitive === false &&
    hasExactText(findNodeById(demo[UI], "reveal-state"), "Reveal disabled") &&
    findElementByText(demo[UI], "cf-button", "Show sensitive health data") !==
      undefined &&
    display(demo[UI], "trusted-health-blocked") === "block" &&
    display(demo[UI], "trusted-health-visible") === "none"
  );

  const assert_revealed = assert(() =>
    demo.revealSensitive === true &&
    hasExactText(findNodeById(demo[UI], "reveal-state"), "Reveal enabled") &&
    findElementByText(demo[UI], "cf-button", "Hide sensitive health data") !==
      undefined &&
    display(demo[UI], "trusted-health-blocked") === "none" &&
    display(demo[UI], "trusted-health-visible") === "block"
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_only_trusted_surface_declassifies },
      { assertion: assert_starts_concealed },
      {
        action: demo.reveal,
        trustedUi: {
          surface: TRUSTED_HEALTH_DISCLOSURE_SURFACE,
          action: TRUSTED_REVEAL_HEALTH_DATA_ACTION,
        },
      },
      { assertion: assert_revealed },
      {
        action: demo.conceal,
        trustedUi: {
          surface: TRUSTED_HEALTH_DISCLOSURE_SURFACE,
          action: TRUSTED_CONCEAL_HEALTH_DATA_ACTION,
        },
      },
      { assertion: assert_starts_concealed },
    ],
    demo,
  };
});
