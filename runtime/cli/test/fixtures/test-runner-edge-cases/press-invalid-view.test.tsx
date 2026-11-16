/**
 * Fixture: a press step whose view has the shape of a view node but is not
 * one, which the renderer reports rather than draws, so the step fails before
 * it looks for the control.
 */

import { pattern, TESTS } from "commonfabric";

export default pattern(() => ({
  [TESTS]: [{ press: { type: "not-a-vnode", name: "div" }, control: "Remove" }],
}));
