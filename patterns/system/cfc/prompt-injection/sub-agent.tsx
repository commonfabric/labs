import {
  type BuiltInLLMContent,
  type BuiltInLLMMessage,
  type BuiltInLLMTool,
  generateObject,
  type JSONValue,
  lift,
  pattern,
} from "commonfabric";
import type { JSONSchema } from "commonfabric";
import {
  parseResultSchemaInput,
  type ResultSchemaInput,
} from "./result-schema.ts";

type SubAgentInput = {
  prompt: BuiltInLLMContent;
  messages?: BuiltInLLMMessage[];
  context?: Record<string, any>;
  resultSchema: ResultSchemaInput;
  system?: string;
  tools?: Record<string, BuiltInLLMTool>;
  model?: string;
  maxTokens?: number;
  observationMaxConfidentiality?: readonly JSONValue[];
  schemaSanitizePromptInjection?: boolean;
};

const parseResultSchema = lift<
  { resultSchema: ResultSchemaInput },
  JSONSchema
>(({ resultSchema }) => parseResultSchemaInput(resultSchema));

const appendTaskToSystem = lift<
  { system?: string; prompt: BuiltInLLMContent },
  string
>(({ system, prompt }) => {
  const promptText = typeof prompt === "string"
    ? prompt
    : JSON.stringify(prompt);
  return `${system ?? ""}\n\nSub-agent task:\n${promptText}`.trim();
});

export const subAgentPattern = pattern<SubAgentInput, any>((
  {
    prompt,
    messages,
    context,
    resultSchema,
    system,
    tools,
    model,
    maxTokens,
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
  },
) => {
  const parsedResultSchema = parseResultSchema({ resultSchema });
  const requestSystem = appendTaskToSystem({ system, prompt });

  const response = generateObject({
    prompt,
    messages,
    context,
    system: requestSystem,
    tools,
    model,
    maxTokens,
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
    schema: parsedResultSchema,
  } as any);

  return response.error ? { error: response.error } : response.result;
});
