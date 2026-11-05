import {
  BuiltInLLMContent,
  Default,
  generateText,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

type LLMTestInput = {
  title: string | Default<"LLM Test">;
};

type LLMTestResult = {
  question: string;
  response?: BuiltInLLMContent;
};

const askQuestion = handler<
  { detail: { message: string } },
  { question: Writable<string> }
>((event, { question }) => {
  const userQuestion = event.detail?.message?.trim();
  if (userQuestion) {
    question.set(userQuestion);
  }
});

export default pattern<LLMTestInput>(({ title }) => {
  const question = new Writable("");

  const llmResponse = generateText({
    system:
      "You are a helpful assistant. Answer questions clearly and concisely.",
    prompt: question,
  });

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h2>{title}</h2>

        <div>
          <cf-message-input
            name="Ask"
            placeholder="Ask the LLM a question..."
            appearance="rounded"
            oncf-send={askQuestion({ question })}
          />
        </div>

        {question.get()
          ? (
            <div>
              <h3>Your Question:</h3>
              <blockquote>
                {question.get()}
              </blockquote>
            </div>
          )
          : null}

        {llmResponse.pending
          ? (
            <div>
              <cf-loader show-elapsed /> Thinking...
            </div>
          )
          : llmResponse.result
          ? (
            <div>
              <h3>LLM Response:</h3>
              <pre>
                {llmResponse.result}
              </pre>
            </div>
          )
          : null}
      </div>
    ),
    question,
    response: llmResponse.result,
  };
});
