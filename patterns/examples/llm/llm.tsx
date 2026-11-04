import {
  BuiltInLLMContent,
  Default,
  generateText,
  handler,
  isPending,
  NAME,
  pattern,
  resultOf,
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

  const responseRequest = generateText({
    system:
      "You are a helpful assistant. Answer questions clearly and concisely.",
    prompt: question,
  });
  const llmResponse = resultOf(responseRequest);

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

        {isPending(responseRequest)
          ? (
            <div>
              <cf-loader show-elapsed /> Thinking...
            </div>
          )
          : llmResponse
          ? (
            <div>
              <h3>LLM Response:</h3>
              <pre>
                {llmResponse}
              </pre>
            </div>
          )
          : null}
      </div>
    ),
    question,
    response: llmResponse,
  };
});
