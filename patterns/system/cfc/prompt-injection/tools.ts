import { type BuiltInLLMTool, type Stream, type Writable } from "commonfabric";
import type { JSONSchema } from "commonfabric";
import { EMPTY_TOOL_INPUT_SCHEMA } from "./schemas.ts";

export type TextOrLink = string | { "@link": string };

export type SendMailArgs = {
  recipient: string;
  subject: string;
  body: TextOrLink;
};

export type SendMailResult = {
  ok: true;
  route: string;
  recipient: string;
  subject: string;
  loggedAt: string;
};

export type ReadResourceResult<Body = unknown> = {
  title: string;
  source: string;
  body: Body;
};

export type PromptInjectionTool = BuiltInLLMTool & {
  inputSchema?: JSONSchema;
};

export const readResourceTool = <Body>(
  handler: Stream<{ result: Writable<ReadResourceResult<Body>> }>,
): PromptInjectionTool => ({
  description:
    "Read a resource. No input. Returns { title, source, body }. If your observation ceiling is too low, body may be returned as an opaque link instead of raw text.",
  inputSchema: EMPTY_TOOL_INPUT_SCHEMA,
  handler,
});

export const sendMailTool = (
  handler: Stream<SendMailArgs & { result: Writable<SendMailResult> }>,
  inputSchema: JSONSchema,
): PromptInjectionTool => ({
  description:
    'Send an email. Input: { recipient, subject, body }. body may be raw text or an opaque text link object like { "@link": "/of:.../summary" }; pass opaque summary links through unchanged instead of reading them. This is the externally visible action in the demo.',
  inputSchema,
  handler,
});
