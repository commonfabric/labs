export enum ConsoleMethod {
  Assert = "assert",
  Clear = "clear",
  Count = "count",
  CountReset = "countReset",
  Debug = "debug",
  Dir = "dir",
  DirXml = "dirxml",
  Error = "error",
  Group = "group",
  GroupCollapsed = "groupCollapsed",
  GroupEnd = "groupEnd",
  Info = "info",
  Log = "log",
  Table = "table",
  Time = "time",
  TimeEnd = "timeEnd",
  TimeLog = "timeLog",
  TimeStamp = "timeStamp",
  Trace = "trace",
  Warn = "warn",
}

export class ConsoleEvent extends Event {
  readonly method: ConsoleMethod;
  readonly args: any[];
  constructor(method: ConsoleMethod, args: any[]) {
    super("console");
    this.method = method;
    this.args = args;
  }
}

export class Console {
  #emitter?: EventTarget;
  constructor(emitter?: EventTarget) {
    this.#emitter = emitter;
  }
  #impl(method: ConsoleMethod, ...args: any[]) {
    this.#emitter?.dispatchEvent(new ConsoleEvent(method, args));
  }
  assert(...args: any[]) {
    return this.#impl(ConsoleMethod.Assert, ...args);
  }
  clear(...args: any[]) {
    return this.#impl(ConsoleMethod.Clear, ...args);
  }
  count(...args: any[]) {
    return this.#impl(ConsoleMethod.Count, ...args);
  }
  countReset(...args: any[]) {
    return this.#impl(ConsoleMethod.CountReset, ...args);
  }
  debug(...args: any[]) {
    return this.#impl(ConsoleMethod.Debug, ...args);
  }
  dir(...args: any[]) {
    return this.#impl(ConsoleMethod.Dir, ...args);
  }
  dirxml(...args: any[]) {
    return this.#impl(ConsoleMethod.DirXml, ...args);
  }
  error(...args: any[]) {
    return this.#impl(ConsoleMethod.Error, ...args);
  }
  group(...args: any[]) {
    return this.#impl(ConsoleMethod.Group, ...args);
  }
  groupCollapsed(...args: any[]) {
    return this.#impl(ConsoleMethod.GroupCollapsed, ...args);
  }
  groupEnd(...args: any[]) {
    return this.#impl(ConsoleMethod.GroupEnd, ...args);
  }
  info(...args: any[]) {
    return this.#impl(ConsoleMethod.Info, ...args);
  }
  log(...args: any[]) {
    return this.#impl(ConsoleMethod.Log, ...args);
  }
  table(...args: any[]) {
    return this.#impl(ConsoleMethod.Table, ...args);
  }
  time(...args: any[]) {
    return this.#impl(ConsoleMethod.Time, ...args);
  }
  timeEnd(...args: any[]) {
    return this.#impl(ConsoleMethod.TimeEnd, ...args);
  }
  timeLog(...args: any[]) {
    return this.#impl(ConsoleMethod.TimeLog, ...args);
  }
  timeStamp(...args: any[]) {
    return this.#impl(ConsoleMethod.TimeStamp, ...args);
  }
  trace(...args: any[]) {
    return this.#impl(ConsoleMethod.Trace, ...args);
  }
  warn(...args: any[]) {
    return this.#impl(ConsoleMethod.Warn, ...args);
  }
}
