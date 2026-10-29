import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../../src/contracts/prompt-slot.ts";
import type { PromptSlotBinding } from "../../src/contracts/prompt-slot.ts";

/**
 * A prompt slot bound as a direct command, named after the test that owns it.
 * A tool call made under this binding is authorized at every enforcement rung.
 *
 * This module imports only the prompt-slot contract, so a test that needs a
 * binding does not pull in a runtime, an identity or a storage manager.
 */
export const directPromptSlotBindingFor = (
  subject: string,
): PromptSlotBinding => ({
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject,
  eventId: `event-${subject}`,
});
