/**
 * Multi-user: the participants draw on one list of entries, each answered by
 * the entry its request fits.
 */
import {
  assert,
  generateText,
  multiUserTest,
  pattern,
  TESTS,
} from "commonfabric";

export const llmMocks = [
  { when: { lastMessageContains: "alice" }, text: "Hello, alice." },
  { when: { lastMessageContains: "bob" }, text: "Hello, bob." },
];

export const alice = pattern(() => {
  const reply = generateText({ prompt: "I am alice" });
  return {
    [TESTS]: [{ assertion: assert(() => reply.result === "Hello, alice.") }],
  };
});

export const bob = pattern(() => {
  const reply = generateText({ prompt: "I am bob" });
  return {
    [TESTS]: [{ assertion: assert(() => reply.result === "Hello, bob.") }],
  };
});

export default multiUserTest({ participants: { alice, bob } });
