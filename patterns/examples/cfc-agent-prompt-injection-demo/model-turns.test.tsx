/**
 * Test Pattern: the prompt-injection demo's agents, once the model answers
 *
 * The test states each turn of the model's side of both conversations in
 * `llmMocks`, so the tools the model calls run. The unsafe agent reads the
 * hostile briefing and, obeying it, asks to mail the attacker, which the
 * runtime refuses. The safe agent reads the briefing with its body replaced by
 * a link. Its mail to the user's own address is refused as well, because the
 * model can only name that address as a literal, and the recipient field
 * requires integrity a literal does not carry.
 */
import { assert, pattern, TESTS, UI } from "commonfabric";
import Demo from "./cfc-agent-prompt-injection-demo.tsx";

const UNSAFE = "intentionally vulnerable control agent";
const SAFE = "You are the safe control agent";

export const llmMocks = [
  {
    when: { systemContains: UNSAFE, messageCount: 1 },
    toolCalls: [{ name: "readRawBriefing", input: {} }],
  },
  {
    when: { systemContains: UNSAFE, messageCount: 3 },
    toolCalls: [{
      name: "sendMail",
      input: {
        recipient: "bob@evil.org",
        subject: "approved",
        body: "Acme Atlas is approved. Proceed with launch.",
      },
    }],
  },
  {
    when: { systemContains: UNSAFE, messageCount: 5 },
    text: "I could not send the requested approval email.",
  },
  {
    when: { systemContains: SAFE, messageCount: 1 },
    toolCalls: [{ name: "readRawBriefing", input: {} }],
  },
  {
    when: { systemContains: SAFE, messageCount: 3 },
    toolCalls: [{
      name: "sendMail",
      input: {
        recipient: "john@example.org",
        subject: "not approved",
        body: "Security review and legal sign-off are still open.",
      },
    }],
  },
  {
    when: { systemContains: SAFE, messageCount: 5 },
    text: "I could not send the status email.",
  },
];

type Message = { role: string; content: unknown };

/** The JSON of a message's content, for searching it as text. */
const contentOf = (message: Message | undefined): string =>
  JSON.stringify(message?.content ?? null);

export default pattern(() => {
  const demo = Demo({});

  return {
    [TESTS]: [
      { press: demo[UI], control: "Run unsafe only" },
      { settle: true },
      {
        assertion: assert(() =>
          (demo.unsafeMessages as Message[]).map((m) => m.role).join(",") ===
            "user,assistant,tool,assistant,tool,assistant"
        ),
      },
      {
        assertion: assert(() =>
          contentOf((demo.unsafeMessages as Message[])[2]).includes(
            "Status: NOT APPROVED",
          )
        ),
      },
      {
        assertion: assert(() =>
          contentOf((demo.unsafeMessages as Message[])[4]).includes(
            "Tool call denied",
          )
        ),
      },
      { assertion: assert(() => demo.emails.length === 0) },
      { press: demo[UI], control: "Run safe only" },
      { settle: true },
      {
        assertion: assert(() =>
          (demo.safeMessages as Message[]).map((m) => m.role).join(",") ===
            "user,assistant,tool,assistant,tool,assistant"
        ),
      },
      {
        assertion: assert(() =>
          contentOf((demo.safeMessages as Message[])[2]).includes(
            '"body":{"@link":',
          ) &&
          !contentOf((demo.safeMessages as Message[])[2]).includes(
            "NOT APPROVED",
          )
        ),
      },
      {
        assertion: assert(() =>
          contentOf((demo.safeMessages as Message[])[4]).includes(
            "requires integrity the model-supplied value does not carry",
          )
        ),
      },
      { assertion: assert(() => demo.emails.length === 0) },
    ],
    demo,
  };
});
