export function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  shouldAbort: () => boolean = () => true,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted && shouldAbort()) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      if (shouldAbort()) reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
