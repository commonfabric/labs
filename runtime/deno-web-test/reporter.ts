import { Summary, TestResult, TestResultError } from "./interface.ts";

export class Reporter {
  static Styles = {
    deemphasize: `color: gray`,
    success: `color: green`,
    error: `color: red`,
    errorBold: `color: red; font-weight: bold`,
    errorHighlight: `background-color: red; font-weight: bold`,
  };
  constructor() {}

  onLoadError(fileName: string, e: TestResultError) {
    console.log(
      `%cerror%c: Could not load ${fileName}: ${e.name}: ${e.message}`,
      Reporter.Styles.errorBold,
      "",
    );
  }

  onRunStart() {}

  onRunEnd(summary: Summary) {
    const duration = summary.duration.toFixed(0);
    const failedCount = summary.failed.length;
    if (failedCount > 0) {
      console.log("%cERRORS", Reporter.Styles.errorHighlight);
      for (const failure of summary.failed) {
        // For compiler
        const { error } = failure;
        if (!error) continue;

        console.log(`${failure.name}`);
        console.log(
          `%cerror%c: ${error.name}: ${error.message}`,
          Reporter.Styles.error,
          "",
        );
        if (error.stack) {
          console.log(`${error.stack}`);
        }
      }
      console.log(
        `%cFAILED%c | ${summary.passed} passed | ${failedCount} failed %c(${duration}ms)`,
        Reporter.Styles.error,
        "",
        Reporter.Styles.deemphasize,
      );
      console.log(
        `%cerror%c: Test failed.`,
        Reporter.Styles.errorBold,
        "",
      );
    } else {
      console.log(
        `%cok%c | ${summary.passed} passed | ${failedCount} failed %c(${duration}ms)`,
        Reporter.Styles.success,
        "",
        Reporter.Styles.deemphasize,
      );
    }
  }

  onFileStart(fileName: string, testCount: number) {
    console.log(
      `%crunning ${testCount} tests from ${fileName}`,
      Reporter.Styles.deemphasize,
    );
  }

  onFileEnd(_fileName: string) {}

  onTestCompleted(result: TestResult) {
    if (result.error) {
      console.log(
        `${result.name} ... %cFAILED%c (${result.duration.toFixed(0)}ms)`,
        Reporter.Styles.error,
        "",
      );
    } else {
      console.log(
        `${result.name} ... %cok%c (${result.duration.toFixed(0)}ms)`,
        Reporter.Styles.success,
        "",
      );
    }
  }
}
