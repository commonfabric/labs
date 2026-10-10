// A `node --test` reporter that writes one JSON line per finished test (and
// per test file), for tallying a large suite by outcome and failure cause:
//
//   cfnode --test --test-reporter=./nodejs/tools/summary-reporter.mjs ...
//
// Each line is `{ kind, file, name, status, error }`, where `kind` is `test`
// (a test or step), `suite` (a `describe()` block), or `file` (a test file's
// own outcome, which is where a module that fails to load shows up), and
// `status` is `pass`, `fail`, `skip`, or `cancelled`. A file's `stderr` lines
// go out as `{ kind: "stderr", file, text }`.

/** The first line of an error's message, following `cause` chains. */
function errorSummary(error) {
  let e = error;
  while (e?.cause && (e.code === "ERR_TEST_FAILURE" || !e.message)) {
    e = e.cause;
  }
  const message = String(e?.message ?? e ?? "");
  const firstLine = message.split("\n").find((l) => l.trim() !== "") ?? "";
  return `${e?.name ?? "Error"}: ${firstLine}`.slice(0, 300);
}

export default async function* summaryReporter(source) {
  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:stderr") {
      yield JSON.stringify({
        kind: "stderr",
        file: data.file,
        text: data.message,
      }) +
        "\n";
      continue;
    }
    if (type !== "test:pass" && type !== "test:fail") continue;
    const details = data.details ?? {};
    const isFile = data.nesting === 0 &&
      (data.name === data.file || data.file?.endsWith(`/${data.name}`));
    const kind = isFile ? "file" : details.type === "suite" ? "suite" : "test";
    let status = type === "test:pass" ? "pass" : "fail";
    if (data.skip !== undefined || data.todo !== undefined) status = "skip";
    if (details.error?.failureType === "cancelledByParent") {
      status = "cancelled";
    }
    yield JSON.stringify({
      kind,
      file: data.file,
      name: data.name,
      status,
      error: status === "fail" ? errorSummary(details.error) : undefined,
    }) + "\n";
  }
}
