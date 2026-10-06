import { assertEquals } from "@std/assert";
import type {
  AsyncResult,
  AvailableResult,
  CompileAndRunFunction,
  CompileResult,
  FetchBinaryFunction,
  FetchBinaryResult,
  FetchJsonFunction,
  FetchJsonUncheckedFunction,
  FetchProgramFunction,
  FetchTextFunction,
  GenerateObjectFunction,
  GenerateObjectStreamFunction,
  GenerateTextFunction,
  GenerateTextStreamFunction,
  HasError,
  HasErrorFunction,
  HasSchemaMismatch,
  HasSchemaMismatchFunction,
  IsPending,
  IsPendingFunction,
  IsSyncing,
  LLMDialogFunction,
  Module,
  ObserveAvailabilityFunction,
  PartialResultOfFunction,
  ResultOfFunction,
  SqliteDb,
  SqliteQueryFunction,
  SqliteQueryResult,
  StreamDataFunction,
  UnavailableFor,
  UnavailableInputPolicy,
  UnavailableInputPolicyEntry,
  UnavailableVariant,
  WishState,
} from "@commonfabric/api";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

interface Repo {
  owner: string;
  name: string;
}

function guardNarrowingTypecheck(
  value: Repo,
  isPending: IsPendingFunction,
  hasError: HasErrorFunction,
): string | boolean | undefined {
  if (hasError(value)) {
    const narrowed: HasError = value;
    return narrowed.errorMessage;
  }
  if (isPending(value)) {
    const narrowed: IsPending = value;
    return narrowed.reason === "pending";
  }
  return value.name;
}

function asyncResultNarrowingTypecheck(
  request: AsyncResult<Repo>,
  hasError: HasErrorFunction,
  resultOf: ResultOfFunction,
): string {
  if (hasError(request)) {
    return request.errorMessage;
  }

  const result = resultOf(request);
  const resultIsUsable: Equal<typeof result, Repo> = true;
  void resultIsUsable;
  return result.name;
}

function observationTypecheck(
  value: Repo,
  observe: ObserveAvailabilityFunction,
): void {
  const errorOnly = observe(value, "error");
  const errorOnlyIsExact: Equal<typeof errorOnly, Repo | HasError> = true;

  const selected = observe(value, "pending", "syncing");
  const selectedIsExact: Equal<
    typeof selected,
    Repo | IsPending | IsSyncing
  > = true;

  const all = observe(value);
  const allIsExact: Equal<typeof all, Repo | UnavailableVariant> = true;

  const extracted: Equal<
    UnavailableFor<"error" | "schemaMismatch">,
    HasError | HasSchemaMismatch
  > = true;

  void errorOnlyIsExact;
  void selectedIsExact;
  void allIsExact;
  void extracted;
}

function exhaustiveObservationTypecheck(
  value: Repo,
  observe: ObserveAvailabilityFunction,
  isPending: IsPendingFunction,
  hasError: HasErrorFunction,
  isSyncing: (value: unknown) => value is IsSyncing,
  hasSchemaMismatch: HasSchemaMismatchFunction,
  resultOf: ResultOfFunction,
): string {
  const observed = observe(value);
  if (isPending(observed)) return "pending";
  if (hasError(observed)) return observed.errorMessage;
  if (isSyncing(observed)) return "syncing";
  if (hasSchemaMismatch(observed)) return "schema mismatch";

  const usable: Repo = observed;
  return resultOf(observed).name ?? usable.name;
}

function modulePolicyTypecheck(): void {
  const policy = [{
    path: ["repo", "owner"],
    reasons: ["error", "pending"],
  }] as const satisfies UnavailableInputPolicy;

  const module: Module = {
    type: "javascript-availability",
    unavailableInputPolicy: policy,
  };

  const fieldIsExact: Equal<
    NonNullable<Module["unavailableInputPolicy"]>,
    UnavailableInputPolicy
  > = true;
  const pathIsReadonly: Equal<
    UnavailableInputPolicyEntry["path"],
    readonly string[]
  > = true;
  const reasonsAreExact: Equal<
    UnavailableInputPolicyEntry["reasons"],
    readonly (
      | "pending"
      | "error"
      | "syncing"
      | "schemaMismatch"
    )[]
  > = true;

  void module;
  void fieldIsExact;
  void pathIsReadonly;
  void reasonsAreExact;
}

function directAsyncBuiltinTypecheck(
  fetchBinary: FetchBinaryFunction,
  fetchText: FetchTextFunction,
  fetchJson: FetchJsonFunction,
  fetchJsonUnchecked: FetchJsonUncheckedFunction,
  fetchProgram: FetchProgramFunction,
  generateText: GenerateTextFunction,
  generateObject: GenerateObjectFunction,
  generateTextStream: GenerateTextStreamFunction,
  generateObjectStream: GenerateObjectStreamFunction,
  streamData: StreamDataFunction,
  partialResultOf: PartialResultOfFunction,
  resultOf: ResultOfFunction,
): void {
  const binary = fetchBinary({ url: "/binary" });
  const text = fetchText({ url: "/text" });
  const json = fetchJson<Repo>({ url: "/repo" });
  const unchecked = fetchJsonUnchecked({ url: "/unchecked" });
  const program = fetchProgram({ url: "/pattern.tsx" });
  const generatedText = generateText({ prompt: "hello" });
  const generatedObject = generateObject<Repo>({ prompt: "repo" });
  const streamedData = streamData<Repo>({ url: "/events" });

  const binaryIsAsync: Equal<
    typeof binary,
    AsyncResult<FetchBinaryResult>
  > = true;
  const textIsAsync: Equal<typeof text, AsyncResult<string>> = true;
  const jsonIsAsync: Equal<typeof json, AsyncResult<Repo>> = true;
  const uncheckedIsAsync: Equal<typeof unchecked, AsyncResult<any>> = true;
  const programIsAsync: Equal<
    typeof program,
    AsyncResult<{
      files: Array<{ name: string; contents: string }>;
      main: string;
    }>
  > = true;
  const generatedTextIsAsync: Equal<
    typeof generatedText,
    AsyncResult<string>
  > = true;
  const generatedObjectIsAsync: Equal<
    typeof generatedObject,
    AsyncResult<Repo>
  > = true;
  const streamedDataIsAsync: AsyncResult<Repo> = streamedData;

  const availableBinary = resultOf(binary);
  const availableText = resultOf(text);
  const availableJson = resultOf(json);
  const availableProgram = resultOf(program);
  const availableGeneratedText = resultOf(generatedText);
  const availableGeneratedObject = resultOf(generatedObject);
  const availableStreamedData = resultOf(streamedData);
  const partialStreamedData = partialResultOf(streamedData);

  const binaryIsDirect: Equal<typeof availableBinary, FetchBinaryResult> = true;
  const textIsDirect: Equal<typeof availableText, string> = true;
  const jsonIsDirect: Equal<typeof availableJson, Repo> = true;
  const programIsDirect: Equal<
    typeof availableProgram,
    { files: Array<{ name: string; contents: string }>; main: string }
  > = true;
  const generatedTextIsDirect: Equal<
    typeof availableGeneratedText,
    string
  > = true;
  const generatedObjectIsDirect: Equal<
    typeof availableGeneratedObject,
    Repo
  > = true;
  const streamedDataIsDirect: Equal<typeof availableStreamedData, Repo> = true;
  const streamedDataPartialIsExact: Equal<
    typeof partialStreamedData,
    Repo
  > = true;

  const availableAliasIsExact: Equal<
    AvailableResult<Repo | UnavailableVariant>,
    Repo
  > = true;

  const textStream = generateTextStream({ prompt: "hello" });
  const objectStream = generateObjectStream<Repo>({ prompt: "repo" });
  const textStreamIsDirect: AsyncResult<string> = textStream;
  const objectStreamIsDirect: AsyncResult<Repo> = objectStream;
  const availableStreamText = resultOf(textStream);
  const availableStreamObject = resultOf(objectStream);
  const partialText = partialResultOf(textStream);
  const partialObjectText = partialResultOf(objectStream);
  const textStreamResultIsExact: Equal<
    typeof availableStreamText,
    string
  > = true;
  const objectStreamResultIsExact: Equal<
    typeof availableStreamObject,
    Repo
  > = true;
  const textPartialIsExact: Equal<
    typeof partialText,
    string
  > = true;
  const objectPartialIsExact: Equal<
    typeof partialObjectText,
    string
  > = true;
  const streamHasNoPublicStateWrapper: Equal<
    "result" extends keyof typeof textStream ? true : false,
    false
  > = true;

  void binaryIsAsync;
  void textIsAsync;
  void jsonIsAsync;
  void uncheckedIsAsync;
  void programIsAsync;
  void generatedTextIsAsync;
  void generatedObjectIsAsync;
  void streamedDataIsAsync;
  void binaryIsDirect;
  void textIsDirect;
  void jsonIsDirect;
  void programIsDirect;
  void generatedTextIsDirect;
  void generatedObjectIsDirect;
  void streamedDataIsDirect;
  void streamedDataPartialIsExact;
  void availableAliasIsExact;
  void textStreamIsDirect;
  void objectStreamIsDirect;
  void textStreamResultIsExact;
  void objectStreamResultIsExact;
  void textPartialIsExact;
  void objectPartialIsExact;
  void streamHasNoPublicStateWrapper;
}

function compileResultTypecheck(
  compileAndRun: CompileAndRunFunction,
  hasError: HasErrorFunction,
  resultOf: ResultOfFunction,
): void {
  const request = compileAndRun<{ query: string }, Repo>({
    files: [{ name: "/main.tsx", contents: "export default 1" }],
    main: "/main.tsx",
    input: { query: "fabric" },
  });
  const requestIsDirect: Equal<typeof request, CompileResult<Repo>> = true;
  const result = resultOf(request);
  const resultIsExact: Equal<typeof result, Repo> = true;
  const hasNoStateWrapper: Equal<
    "result" extends keyof typeof request ? true : false,
    false
  > = true;

  if (hasError(request)) {
    const message = request.errorMessage;
    const messageIsTyped: Equal<typeof message, string> = true;
    void messageIsTyped;
  }

  void requestIsDirect;
  void resultIsExact;
  void hasNoStateWrapper;
}

function sqliteResultTypecheck(
  sqliteQuery: SqliteQueryFunction,
  db: SqliteDb,
  resultOf: ResultOfFunction,
): void {
  type Row = { id: number; title: string };
  type Expected = SqliteQueryResult<Row> | UnavailableVariant;

  const freeRequest = sqliteQuery<Row>({
    db,
    sql: "SELECT id, title FROM notes",
    readClearance: true,
  });
  const methodRequest = db.query<Row>(
    "SELECT id, title FROM notes",
    { readClearance: true },
  );
  const freeIsDirect: Equal<typeof freeRequest, Expected> = true;
  const methodIsDirect: Equal<typeof methodRequest, Expected> = true;
  const freeResult = resultOf(freeRequest);
  const methodResult = resultOf(methodRequest);
  const freeResultIsExact: Equal<
    typeof freeResult,
    SqliteQueryResult<Row>
  > = true;
  const methodResultIsExact: Equal<
    typeof methodResult,
    SqliteQueryResult<Row>
  > = true;
  const hasNoStateWrapper: Equal<
    "result" extends keyof typeof freeRequest ? true : false,
    false
  > = true;

  void freeIsDirect;
  void methodIsDirect;
  void freeResultIsExact;
  void methodResultIsExact;
  void hasNoStateWrapper;
}

function wishResultTypecheck(
  state: WishState<Repo>,
  resultOf: ResultOfFunction,
): void {
  const resultIsAsync: Equal<typeof state.result, AsyncResult<Repo>> = true;
  const usable = resultOf(state.result);
  const usableIsExact: Equal<typeof usable, Repo> = true;
  const hasNoDuplicateError: Equal<
    "error" extends keyof WishState<Repo> ? true : false,
    false
  > = true;

  void resultIsAsync;
  void usableIsExact;
  void hasNoDuplicateError;
}

function llmDialogResultTypecheck(
  llmDialog: LLMDialogFunction,
  resultOf: ResultOfFunction,
): void {
  const plain = llmDialog({ messages: [] });
  const plainHasNoResult: Equal<
    "result" extends keyof typeof plain ? true : false,
    false
  > = true;

  const dialog = llmDialog<Repo>({ messages: [] });
  const resultIsAsync: Equal<
    typeof dialog.result,
    AsyncResult<Repo>
  > = true;
  const result = resultOf(dialog.result);
  const resultIsExact: Equal<typeof result, Repo> = true;

  void plainHasNoResult;
  void resultIsAsync;
  void resultIsExact;
}

Deno.test("data-unavailability helper declarations preserve narrowing types", () => {
  assertEquals(typeof guardNarrowingTypecheck, "function");
  assertEquals(typeof asyncResultNarrowingTypecheck, "function");
  assertEquals(typeof observationTypecheck, "function");
  assertEquals(typeof exhaustiveObservationTypecheck, "function");
  assertEquals(typeof modulePolicyTypecheck, "function");
  assertEquals(typeof directAsyncBuiltinTypecheck, "function");
  assertEquals(typeof compileResultTypecheck, "function");
  assertEquals(typeof sqliteResultTypecheck, "function");
  assertEquals(typeof wishResultTypecheck, "function");
  assertEquals(typeof llmDialogResultTypecheck, "function");
});
