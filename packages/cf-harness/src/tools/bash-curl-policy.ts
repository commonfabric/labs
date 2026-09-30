export interface BashCurlPolicyResult {
  allowed: boolean;
  reason?: string;
}

export const BASH_COMMAND_DENIED_EXIT_CODE = 126;
export const BASH_COMMAND_DENIED_PREFIX = "bash command denied";

const CURL_COMMAND_NAME = "curl";
const SHELL_OPERATORS = new Set([
  "|",
  "||",
  "&",
  "&&",
  ";",
  "<",
  ">",
  ">>",
]);

const CURL_VALUE_FLAGS = new Set([
  "-A",
  "-b",
  "-c",
  "-d",
  "-e",
  "-F",
  "-H",
  "-m",
  "-o",
  "-u",
  "-w",
  "-X",
  "--connect-timeout",
  "--cookie",
  "--cookie-jar",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--form",
  "--header",
  "--max-time",
  "--output",
  "--referer",
  "--request",
  "--user",
  "--user-agent",
  "--write-out",
]);

const CURL_LOCAL_URL_FLAGS = new Set([
  "--url",
]);

const CURL_DISALLOWED_FLAGS = new Set([
  "--abstract-unix-socket",
  "--connect-to",
  "--dns-interface",
  "--dns-ipv4-addr",
  "--dns-ipv6-addr",
  "--dns-servers",
  "--interface",
  "--preproxy",
  "--proxy",
  "--proxy-header",
  "--proxy-user",
  "--resolve",
  "--unix-socket",
  "-x",
]);

const CURL_TEXT_SEARCH_COMMANDS = new Set([
  "grep",
  "rg",
]);

export const validateBashCurlCommand = (
  command: string,
): BashCurlPolicyResult => {
  if (!containsCurlWord(command)) {
    return { allowed: true };
  }

  const parsed = tokenizeShell(command);
  if (parsed.error !== undefined) {
    return { allowed: false, reason: parsed.error };
  }

  let commandStart = true;
  let commandName: string | undefined;
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index]!;
    if (SHELL_OPERATORS.has(token)) {
      commandStart = true;
      commandName = undefined;
      continue;
    }
    if (!commandStart) {
      if (
        containsCurlWord(token) &&
        !CURL_TEXT_SEARCH_COMMANDS.has(commandName ?? "")
      ) {
        return {
          allowed: false,
          reason: "curl commands must be direct shell commands",
        };
      }
      continue;
    }
    if (isShellAssignment(token)) {
      continue;
    }
    commandStart = false;
    commandName = shellBasename(token);
    if (commandName !== CURL_COMMAND_NAME) {
      continue;
    }
    const args: string[] = [];
    for (let cursor = index + 1; cursor < parsed.tokens.length; cursor += 1) {
      const arg = parsed.tokens[cursor]!;
      if (SHELL_OPERATORS.has(arg)) {
        break;
      }
      args.push(arg);
    }
    const curlResult = validateCurlArgs(args);
    if (!curlResult.allowed) {
      return curlResult;
    }
  }

  return { allowed: true };
};

const validateCurlArgs = (args: readonly string[]): BashCurlPolicyResult => {
  let allowFlags = true;
  let sawTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      allowFlags = false;
      continue;
    }
    if (allowFlags && arg.startsWith("-")) {
      const [flag, inlineValue] = splitLongFlagValue(arg);
      if (CURL_DISALLOWED_FLAGS.has(flag)) {
        return {
          allowed: false,
          reason: `curl flag ${flag} is not allowed from cf-harness bash`,
        };
      }
      if (CURL_LOCAL_URL_FLAGS.has(flag)) {
        const target = inlineValue ?? args[index + 1];
        if (target === undefined) {
          return {
            allowed: false,
            reason: `curl flag ${flag} requires a localhost URL`,
          };
        }
        const result = validateLocalhostCurlTarget(target);
        if (!result.allowed) {
          return result;
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        sawTarget = true;
        continue;
      }
      if (CURL_VALUE_FLAGS.has(flag)) {
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }
      continue;
    }

    const result = validateLocalhostCurlTarget(arg);
    if (!result.allowed) {
      return result;
    }
    sawTarget = true;
  }

  if (sawTarget || args.length === 0 || args.some(isCurlInfoFlag)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "curl commands must include a localhost URL target",
  };
};

const validateLocalhostCurlTarget = (target: string): BashCurlPolicyResult => {
  if (/[`$\\{}[\]]/.test(target)) {
    return {
      allowed: false,
      reason: "curl targets may not use shell expansion or URL glob syntax",
    };
  }
  const url = parseCurlTarget(target);
  if (url === undefined) {
    return {
      allowed: false,
      reason: `curl target ${target} must be an http(s) localhost URL`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason:
        `curl protocol ${url.protocol} is not allowed from cf-harness bash`,
    };
  }
  if (!isLoopbackHost(url.hostname)) {
    // Which host services answer on these names is the sandbox's business:
    // under Docker, `host.docker.internal` reaches any port of the host, and
    // under the direct driver on macOS only the ports the launch forwards
    // into the VM. So the reason states the rule and sends the model to no
    // host that may not answer.
    return {
      allowed: false,
      reason:
        `curl host ${url.hostname} is not allowed from cf-harness bash: curl may name only localhost, a 127.x or ::1 address, or host.docker.internal, and a service that does not answer at one of those is out of this sandbox's reach`,
    };
  }
  return { allowed: true };
};

const parseCurlTarget = (target: string): URL | undefined => {
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)
    ? target
    : `http://${target}`;
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
};

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "host.docker.internal" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){1,3}$/.test(normalized);
};

const isCurlInfoFlag = (arg: string): boolean =>
  arg === "--help" || arg === "--version" || arg === "-V";

const splitLongFlagValue = (arg: string): [string, string | undefined] => {
  if (!arg.startsWith("--")) {
    return [arg, undefined];
  }
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1
    ? [arg, undefined]
    : [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
};

const containsCurlWord = (command: string): boolean =>
  /(^|[^A-Za-z0-9_.-])curl([^A-Za-z0-9_.-]|$)/.test(command);

const shellBasename = (token: string): string =>
  token.split("/").pop() ?? token;

const isShellAssignment = (token: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token);

type ShellTokenizeResult =
  | { tokens: string[]; error?: undefined }
  | { tokens?: undefined; error: string };

const tokenizeShell = (command: string): ShellTokenizeResult => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    if (isShellOperatorStart(char)) {
      pushCurrent();
      const next = command[index + 1];
      if ((char === "|" || char === "&" || char === ">") && next === char) {
        tokens.push(`${char}${next}`);
        index += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }
    current += char;
  }
  if (quote !== undefined) {
    return { error: "unterminated quote in curl command" };
  }
  pushCurrent();
  return { tokens };

  function pushCurrent() {
    if (current !== "") {
      tokens.push(current);
      current = "";
    }
  }
};

const isShellOperatorStart = (char: string): boolean =>
  char === "|" ||
  char === "&" ||
  char === ";" ||
  char === "<" ||
  char === ">";
