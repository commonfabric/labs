import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import {
  join as joinSandboxPath,
  normalize as normalizeSandboxPath,
} from "@std/path/posix";
import {
  HARNESS_SKILL_ACTIVATIONS_TYPE,
  HARNESS_SKILL_REGISTRY_TYPE,
  type HarnessSkillAcquisition,
  type HarnessSkillActivation,
  type HarnessSkillActivations,
  type HarnessSkillActivationSource,
  type HarnessSkillDiagnostic,
  type HarnessSkillFrontmatterValue,
  type HarnessSkillRecord,
  type HarnessSkillRegistry,
  type HarnessSkillResourceContentKind,
  type HarnessSkillResourceKind,
  type HarnessSkillResourceRecord,
  type HarnessSkillScriptMetadata,
  type HarnessSkillScriptRuntime,
} from "../contracts/skill.ts";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_SCAN_DEPTH = 6;
const MAX_SKILL_SCAN_DIRECTORIES = 2000;
const MAX_SKILL_RESOURCE_SCAN_DEPTH = 8;
const MAX_SKILL_RESOURCE_SCAN_DIRECTORIES = 1000;
const MAX_SKILL_RESOURCE_FILES = 2000;
const TEXT_DETECTION_SAMPLE_BYTES = 8192;
const EXCLUDED_SKILL_DIRS = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  "node_modules",
]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface DiscoverHarnessSkillsOptions {
  skillsRoot: string;
  sandboxSkillsRoot?: string;
  generatedAt?: string;
}

export interface LoadHarnessSkillContextOptions {
  registry: HarnessSkillRegistry;
  skillNames: readonly string[];
  source: HarnessSkillActivationSource;
  runId: string;
  activatedAt?: string;
}

export interface HarnessSkillContextLoadResult {
  contextText: string;
  activations: HarnessSkillActivations;
}

export interface LoadHarnessSkillContextFromTextOptions {
  /** The skill text a handle resolved to. */
  text: string;

  /** The parent-held token the text was materialized through. */
  handleToken: string;

  /**
   * Where the handle's value was fetched from, when the token's entry carries
   * that record. Omitted for a handle the harness did not acquire.
   */
  acquisition?: HarnessSkillAcquisition;

  runId: string;
  activatedAt?: string;
}

export interface HarnessSkillTextContextLoadResult {
  contextText: string;
  activation: HarnessSkillActivation;
}

interface ParsedSkillFile {
  frontmatter: Record<string, HarnessSkillFrontmatterValue>;
  body: string;
}

const createDiagnostic = (
  diagnostic: HarnessSkillDiagnostic,
): HarnessSkillDiagnostic => diagnostic;

const normalizeSandboxRoot = (path: string): string => {
  const normalized = normalizeSandboxPath(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const isPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const hostPathToSandboxPath = (
  hostRoot: string,
  sandboxRoot: string,
  hostPath: string,
): string => {
  const relativePath = relative(hostRoot, hostPath);
  return relativePath.length === 0
    ? normalizeSandboxRoot(sandboxRoot)
    : normalizeSandboxPath(joinSandboxPath(sandboxRoot, relativePath));
};

const escapeContextAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const formatSkillResourceIndex = (
  skill: HarnessSkillRecord,
): string[] => {
  if (skill.resources.length === 0) {
    return ["Indexed skill resources: none."];
  }
  const lines = [
    "Indexed skill resources available through read_skill_resource:",
  ];
  for (const resource of skill.resources) {
    lines.push(
      `- ${resource.path} (${resource.kind}, ${resource.contentKind}, ${resource.sizeBytes} bytes, ${resource.digest})`,
    );
  }
  lines.push(
    `Use read_skill_resource with skill="${skill.name}" and path set to one of the listed resource paths when a supporting skill resource is relevant.`,
    "Repo docs or packages referenced by this skill are not skill resources; use read_file or another allowed workspace tool for repo paths.",
  );
  return lines;
};

const parseScalarFrontmatterValue = (
  rawValue: string,
): HarnessSkillFrontmatterValue => {
  const value = rawValue.trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter((item) => item.length > 0);
  }
  return value.replace(/^['"]|['"]$/g, "");
};

export const parseHarnessSkillFile = (content: string): ParsedSkillFile => {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const frontmatterEnd = content.indexOf("\n---", 3);
  if (frontmatterEnd < 0) {
    return { frontmatter: {}, body: content };
  }
  const rawFrontmatter = content.slice(3, frontmatterEnd);
  const bodyStart = content.indexOf("\n", frontmatterEnd + 1);
  const body = bodyStart < 0 ? "" : content.slice(bodyStart + 1);
  const frontmatter: Record<string, HarnessSkillFrontmatterValue> = {};
  let currentKey: string | undefined;
  for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    if (/^\s/.test(rawLine) && currentKey !== undefined) {
      const existing = frontmatter[currentKey];
      if (typeof existing === "string") {
        frontmatter[currentKey] = `${existing} ${rawLine.trim()}`;
      }
      continue;
    }
    const separator = rawLine.indexOf(":");
    if (separator < 0) {
      currentKey = undefined;
      continue;
    }
    currentKey = rawLine.slice(0, separator).trim();
    frontmatter[currentKey] = parseScalarFrontmatterValue(
      rawLine.slice(separator + 1),
    );
  }
  return { frontmatter, body };
};

const firstBodyParagraph = (body: string): string | undefined => {
  for (const line of body.trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  return undefined;
};

const sha256BytesDigest = async (content: Uint8Array): Promise<string> => {
  const buffer = new ArrayBuffer(content.byteLength);
  new Uint8Array(buffer).set(content);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    buffer,
  );
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

const sha256Digest = async (content: string): Promise<string> =>
  await sha256BytesDigest(new TextEncoder().encode(content));

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
};

const collectSkillFiles = async (
  skillsRoot: string,
  resolvedSkillsRoot: string,
): Promise<{ skillFiles: string[]; diagnostics: HarnessSkillDiagnostic[] }> => {
  const skillFiles: string[] = [];
  const diagnostics: HarnessSkillDiagnostic[] = [];
  let directoriesVisited = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    let resolvedDir: string;
    try {
      resolvedDir = await Deno.realPath(dir);
    } catch {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unresolvable-skill-scan-path",
        detail: `Could not resolve skill scan path: ${dir}`,
        path: dir,
      }));
      return;
    }
    if (!isPathWithinRoot(resolvedSkillsRoot, resolvedDir)) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "skill-scan-outside-root",
        detail:
          `Skipped skill scan path because it resolves outside the configured skills root.`,
        path: dir,
      }));
      return;
    }
    directoriesVisited += 1;
    if (directoriesVisited > MAX_SKILL_SCAN_DIRECTORIES) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "scan-limit-exceeded",
        detail:
          `Stopped scanning skills after ${MAX_SKILL_SCAN_DIRECTORIES} directories.`,
        path: dir,
      }));
      return;
    }
    if (depth > MAX_SKILL_SCAN_DEPTH) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "max-depth-exceeded",
        detail:
          `Skipped skill scan path beyond max depth ${MAX_SKILL_SCAN_DEPTH}.`,
        path: dir,
      }));
      return;
    }
    if (await pathExists(join(dir, SKILL_FILE_NAME))) {
      skillFiles.push(join(dir, SKILL_FILE_NAME));
      return;
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch (error) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unreadable-directory",
        detail: error instanceof Error ? error.message : String(error),
        path: dir,
      }));
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (EXCLUDED_SKILL_DIRS.has(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(entryPath);
      } catch {
        continue;
      }
      if (stat.isDirectory) {
        await visit(entryPath, depth + 1);
      }
    }
  };
  await visit(skillsRoot, 0);
  return { skillFiles, diagnostics };
};

const normalizeSkillResourcePath = (path: string): string =>
  path.replaceAll("\\", "/");

const classifySkillResourceKind = (
  relativePath: string,
): HarnessSkillResourceKind => {
  const [firstSegment] = normalizeSkillResourcePath(relativePath).split("/");
  switch (firstSegment) {
    case "references":
      return "reference";
    case "assets":
      return "asset";
    case "templates":
      return "template";
    case "scripts":
      return "script";
    default:
      return "other";
  }
};

const guessSkillResourceContentKind = (
  content: Uint8Array,
): HarnessSkillResourceContentKind => {
  const sample = content.slice(0, TEXT_DETECTION_SAMPLE_BYTES);
  if (sample.includes(0)) {
    return "binary";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return "text";
  } catch {
    return "binary";
  }
};

const scriptRuntimeFromShebang = (
  shebang: string | undefined,
): HarnessSkillScriptRuntime => {
  if (shebang === undefined) {
    return "unknown";
  }
  const commandBasename = (word: string): string =>
    basename(word).toLowerCase();
  const words = shebang.replace(/^#!/, "").trim().split(/\s+/).filter((word) =>
    word.length > 0
  );
  const commandWords = words.length >= 3 &&
      commandBasename(words[0] ?? "") === "env" &&
      words[1] === "-S"
    ? words.slice(2)
    : words.length >= 2 &&
        commandBasename(words[0] ?? "") === "env" &&
        commandBasename(words[1] ?? "") === "deno"
    ? words.slice(1)
    : words;
  const denoIndex = commandWords.findIndex((word) =>
    commandBasename(word) === "deno"
  );
  return denoIndex >= 0 && commandWords[denoIndex + 1] === "run"
    ? "deno"
    : "shebang";
};

const scriptRuntimeFromPath = (
  path: string,
  shebang: string | undefined,
): HarnessSkillScriptRuntime => {
  const shebangRuntime = scriptRuntimeFromShebang(shebang);
  if (shebangRuntime !== "unknown") {
    return shebangRuntime;
  }
  return /\.(?:ts|tsx|js|mjs)$/i.test(path) ? "deno" : "unknown";
};

const extractShebang = (
  content: Uint8Array,
  contentKind: HarnessSkillResourceContentKind,
): string | undefined => {
  if (contentKind !== "text") {
    return undefined;
  }
  const text = new TextDecoder().decode(content.slice(0, 512));
  if (!text.startsWith("#!")) {
    return undefined;
  }
  return text.split(/\r?\n/, 1)[0]?.trimEnd();
};

/**
 * The script metadata a resource carries, derived from its bytes and its name.
 *
 * Shared with the acquired-skill path, which has a file and no registry scan:
 * what decides a script's runtime is its shebang and its extension, and that
 * decision has to be the same one wherever the file came from.
 */
export const harnessSkillScriptMetadata = (
  options: {
    path: string;
    executable: boolean;
    content: Uint8Array;
    contentKind: HarnessSkillResourceContentKind;
  },
): HarnessSkillScriptMetadata => {
  const shebang = extractShebang(options.content, options.contentKind);
  return {
    executable: options.executable,
    ...(shebang !== undefined ? { shebang } : {}),
    runtime: scriptRuntimeFromPath(options.path, shebang),
  };
};

const scriptMetadataForResource = (
  options: {
    path: string;
    stat: Deno.FileInfo;
    content: Uint8Array;
    contentKind: HarnessSkillResourceContentKind;
  },
): HarnessSkillScriptMetadata =>
  harnessSkillScriptMetadata({
    path: options.path,
    executable: ((options.stat.mode ?? 0) & 0o111) !== 0,
    content: options.content,
    contentKind: options.contentKind,
  });

const collectSkillResources = async (
  options: {
    skillsRoot: string;
    resolvedSkillsRoot: string;
    sandboxSkillsRoot: string;
    skillDir: string;
    resolvedSkillDir: string;
  },
): Promise<{
  resources: HarnessSkillResourceRecord[];
  diagnostics: HarnessSkillDiagnostic[];
}> => {
  const resources: HarnessSkillResourceRecord[] = [];
  const diagnostics: HarnessSkillDiagnostic[] = [];
  const visitedDirectories = new Set<string>();
  let directoriesVisited = 0;
  let filesVisited = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    let resolvedDir: string;
    try {
      resolvedDir = await Deno.realPath(dir);
    } catch {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unresolvable-skill-resource-scan-path",
        detail: `Could not resolve skill resource scan path: ${dir}`,
        path: dir,
      }));
      return;
    }
    if (
      !isPathWithinRoot(options.resolvedSkillDir, resolvedDir) ||
      !isPathWithinRoot(options.resolvedSkillsRoot, resolvedDir)
    ) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "skill-resource-scan-outside-root",
        detail:
          `Skipped skill resource scan path because it resolves outside the skill directory or configured skills root.`,
        path: dir,
      }));
      return;
    }
    if (visitedDirectories.has(resolvedDir)) {
      return;
    }
    visitedDirectories.add(resolvedDir);
    directoriesVisited += 1;
    if (directoriesVisited > MAX_SKILL_RESOURCE_SCAN_DIRECTORIES) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "resource-scan-limit-exceeded",
        detail:
          `Stopped scanning skill resources after ${MAX_SKILL_RESOURCE_SCAN_DIRECTORIES} directories.`,
        path: dir,
      }));
      return;
    }
    if (depth > MAX_SKILL_RESOURCE_SCAN_DEPTH) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "resource-max-depth-exceeded",
        detail:
          `Skipped skill resource scan path beyond max depth ${MAX_SKILL_RESOURCE_SCAN_DEPTH}.`,
        path: dir,
      }));
      return;
    }

    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch (error) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unreadable-skill-resource-directory",
        detail: error instanceof Error ? error.message : String(error),
        path: dir,
      }));
      return;
    }

    entries.sort((a, b) => {
      if (depth === 0) {
        const aIsSkill = a.name === SKILL_FILE_NAME;
        const bIsSkill = b.name === SKILL_FILE_NAME;
        if (aIsSkill !== bIsSkill) return aIsSkill ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (EXCLUDED_SKILL_DIRS.has(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(entryPath);
      } catch {
        diagnostics.push(createDiagnostic({
          severity: "warning",
          code: "unstatable-skill-resource",
          detail: `Could not stat skill resource path: ${entryPath}`,
          path: entryPath,
        }));
        continue;
      }
      if (stat.isDirectory) {
        await visit(entryPath, depth + 1);
        continue;
      }
      if (!stat.isFile) {
        continue;
      }
      filesVisited += 1;
      if (filesVisited > MAX_SKILL_RESOURCE_FILES) {
        diagnostics.push(createDiagnostic({
          severity: "warning",
          code: "resource-file-limit-exceeded",
          detail:
            `Stopped indexing skill resources after ${MAX_SKILL_RESOURCE_FILES} files.`,
          path: entryPath,
        }));
        return;
      }

      let resolvedResourcePath: string;
      try {
        resolvedResourcePath = await Deno.realPath(entryPath);
      } catch {
        diagnostics.push(createDiagnostic({
          severity: "warning",
          code: "unresolvable-skill-resource",
          detail: `Could not resolve skill resource path: ${entryPath}`,
          path: entryPath,
        }));
        continue;
      }
      if (
        !isPathWithinRoot(options.resolvedSkillDir, resolvedResourcePath) ||
        !isPathWithinRoot(options.resolvedSkillsRoot, resolvedResourcePath)
      ) {
        diagnostics.push(createDiagnostic({
          severity: "warning",
          code: "skill-resource-outside-root",
          detail:
            `Skipped skill resource because its resolved path is outside the skill directory or configured skills root.`,
          path: entryPath,
        }));
        continue;
      }

      let content: Uint8Array;
      try {
        content = await Deno.readFile(entryPath);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: "warning",
          code: "unreadable-skill-resource",
          detail: error instanceof Error ? error.message : String(error),
          path: entryPath,
        }));
        continue;
      }

      const resourcePath = normalizeSkillResourcePath(
        relative(options.skillDir, entryPath),
      );
      const kind = classifySkillResourceKind(resourcePath);
      const contentKind = guessSkillResourceContentKind(content);
      resources.push({
        path: resourcePath,
        kind,
        resourcePath: entryPath,
        sandboxResourcePath: hostPathToSandboxPath(
          options.skillsRoot,
          options.sandboxSkillsRoot,
          entryPath,
        ),
        sizeBytes: stat.size,
        digest: await sha256BytesDigest(content),
        contentKind,
        ...(kind === "script"
          ? {
            script: scriptMetadataForResource({
              path: resourcePath,
              stat,
              content,
              contentKind,
            }),
          }
          : {}),
        diagnostics: [],
      });
    }
  };

  await visit(options.skillDir, 0);
  resources.sort((a, b) => a.path.localeCompare(b.path));
  return { resources, diagnostics };
};

export const discoverHarnessSkills = async (
  options: DiscoverHarnessSkillsOptions,
): Promise<HarnessSkillRegistry> => {
  const skillsRoot = resolve(options.skillsRoot);
  const resolvedSkillsRoot = await Deno.realPath(skillsRoot);
  const sandboxSkillsRoot = normalizeSandboxRoot(
    options.sandboxSkillsRoot ?? skillsRoot,
  );
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const diagnostics: HarnessSkillDiagnostic[] = [];
  const rootInfo = await Deno.stat(skillsRoot);
  if (!rootInfo.isDirectory) {
    throw new Error(`skills root must be a directory: ${skillsRoot}`);
  }
  const { skillFiles, diagnostics: scanDiagnostics } = await collectSkillFiles(
    skillsRoot,
    resolvedSkillsRoot,
  );
  diagnostics.push(...scanDiagnostics);
  const skills: HarnessSkillRecord[] = [];
  const seenNames = new Set<string>();
  for (const skillPath of skillFiles.sort()) {
    const skillDir = dirname(skillPath);
    let resolvedSkillPath: string;
    try {
      resolvedSkillPath = await Deno.realPath(skillPath);
    } catch {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unresolvable-skill-path",
        detail: `Could not resolve skill path: ${skillPath}`,
        path: skillPath,
      }));
      continue;
    }
    if (!isPathWithinRoot(resolvedSkillsRoot, resolvedSkillPath)) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "skill-outside-root",
        detail:
          `Skipped skill because its resolved SKILL.md is outside the configured skills root.`,
        path: skillPath,
      }));
      continue;
    }
    const resolvedSkillDir = dirname(resolvedSkillPath);
    let content: string;
    try {
      content = await Deno.readTextFile(skillPath);
    } catch (error) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unreadable-skill",
        detail: error instanceof Error ? error.message : String(error),
        path: skillPath,
      }));
      continue;
    }
    const parsed = parseHarnessSkillFile(content);
    const recordDiagnostics: HarnessSkillDiagnostic[] = [];
    const rawName = parsed.frontmatter.name;
    const name = typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : basename(skillDir);
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      recordDiagnostics.push(createDiagnostic({
        severity: "warning",
        code: "missing-name",
        detail: `Skill is missing frontmatter name; using directory name.`,
        path: skillPath,
      }));
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      recordDiagnostics.push(createDiagnostic({
        severity: "warning",
        code: "invalid-name",
        detail:
          `Skill name should be lowercase alphanumeric with single hyphen separators: ${name}`,
        path: skillPath,
      }));
    }
    if (basename(skillDir) !== name) {
      recordDiagnostics.push(createDiagnostic({
        severity: "warning",
        code: "name-directory-mismatch",
        detail: `Skill name "${name}" does not match directory "${
          basename(skillDir)
        }".`,
        path: skillPath,
      }));
    }
    const rawDescription = parsed.frontmatter.description;
    const description = typeof rawDescription === "string" &&
        rawDescription.trim().length > 0
      ? rawDescription.trim()
      : firstBodyParagraph(parsed.body);
    if (description === undefined || description.length === 0) {
      diagnostics.push(createDiagnostic({
        severity: "error",
        code: "missing-description",
        detail: `Skipped skill because it is missing a description.`,
        path: skillPath,
      }));
      continue;
    }
    if (seenNames.has(name)) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "duplicate-skill-name",
        detail:
          `Skipped duplicate skill "${name}"; the first discovered skill wins.`,
        path: skillPath,
      }));
      continue;
    }
    seenNames.add(name);
    const { resources, diagnostics: resourceDiagnostics } =
      await collectSkillResources({
        skillsRoot,
        resolvedSkillsRoot,
        sandboxSkillsRoot,
        skillDir,
        resolvedSkillDir,
      });
    recordDiagnostics.push(...resourceDiagnostics);
    skills.push({
      name,
      description,
      skillPath,
      skillDir,
      sandboxSkillPath: hostPathToSandboxPath(
        skillsRoot,
        sandboxSkillsRoot,
        skillPath,
      ),
      sandboxSkillDir: hostPathToSandboxPath(
        skillsRoot,
        sandboxSkillsRoot,
        skillDir,
      ),
      digest: await sha256Digest(content),
      resources,
      frontmatter: parsed.frontmatter,
      diagnostics: recordDiagnostics,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return {
    type: HARNESS_SKILL_REGISTRY_TYPE,
    version: 1,
    skillsRoot,
    sandboxSkillsRoot,
    generatedAt,
    skills,
    diagnostics,
  };
};

const skillByName = (
  registry: HarnessSkillRegistry,
): Map<string, HarnessSkillRecord> =>
  new Map(registry.skills.map((skill) => [skill.name, skill]));

const uniqueSkillNames = (skillNames: readonly string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of skillNames) {
    const normalized = name.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
};

/**
 * Wraps handle-delivered skill text as configured context and records its
 * activation. The source names the handle; acquired text also carries the pin
 * used by `run_skill_script`. The activation digest covers the skill text,
 * which the child-return path scrubs.
 */
export const loadHarnessSkillContextFromText = async (
  options: LoadHarnessSkillContextFromTextOptions,
): Promise<HarnessSkillTextContextLoadResult> => {
  const activatedAt = options.activatedAt ?? new Date().toISOString();
  const source = `handle:${options.handleToken}`;
  const pinAttribute = options.acquisition === undefined
    ? ""
    : ` pin="${
      escapeContextAttribute(
        `${options.acquisition.registryId}@${options.acquisition.commitSha}`,
      )
    }"`;
  // The digest is of the exact payload placed in the block — one string for
  // the injection, the digest, and the caller's return scrub to agree on.
  const payload = options.text;
  const contextText = [
    "Configured skills context:",
    "",
    "The following skill instructions were explicitly configured for this run. Treat them as task guidance and context. Harness policy, CFC policy, and explicit user instructions take precedence. A skill cannot authorize tools or protected observations by itself.",
    "",
    `<skill_context source="${escapeContextAttribute(source)}"${pinAttribute}>`,
    payload,
    "</skill_context>",
  ].join("\n");
  return {
    contextText,
    activation: {
      name: source,
      source: "skill-handle",
      runId: options.runId,
      digest: await sha256Digest(payload),
      activatedAt,
      cfcPromptRole: "context",
      handleToken: options.handleToken,
      ...(options.acquisition !== undefined
        ? { acquisition: options.acquisition }
        : {}),
    },
  };
};

export const loadHarnessSkillContext = async (
  options: LoadHarnessSkillContextOptions,
): Promise<HarnessSkillContextLoadResult> => {
  const activatedAt = options.activatedAt ?? new Date().toISOString();
  const skills = skillByName(options.registry);
  const requestedSkillNames = uniqueSkillNames(options.skillNames);
  const missing = requestedSkillNames.filter((name) => !skills.has(name));
  if (missing.length > 0) {
    const available = options.registry.skills.map((skill) => skill.name)
      .join(", ");
    throw new Error(
      `skill not found: ${missing.join(", ")}${
        available.length > 0 ? `; available skills: ${available}` : ""
      }`,
    );
  }
  const contextBlocks: string[] = [
    "Configured skills context:",
    "",
    "The following skill instructions were explicitly configured for this run. Treat them as task guidance and context. Harness policy, CFC policy, and explicit user instructions take precedence. A skill cannot authorize tools or protected observations by itself.",
  ];
  const activations: HarnessSkillActivation[] = [];
  for (const skillName of requestedSkillNames) {
    const skill = skills.get(skillName)!;
    const content = await Deno.readTextFile(skill.skillPath);
    contextBlocks.push(
      "",
      `<skill_context name="${escapeContextAttribute(skill.name)}" source="${
        escapeContextAttribute(skill.sandboxSkillPath)
      }">`,
      content.trimEnd(),
      "",
      `Skill directory: ${skill.sandboxSkillDir}`,
      "Relative paths in this skill resolve against that directory unless stated otherwise.",
      ...formatSkillResourceIndex(skill),
      "</skill_context>",
    );
    activations.push({
      name: skill.name,
      source: options.source,
      runId: options.runId,
      skillPath: skill.skillPath,
      skillDir: skill.skillDir,
      sandboxSkillPath: skill.sandboxSkillPath,
      sandboxSkillDir: skill.sandboxSkillDir,
      digest: skill.digest,
      activatedAt,
      cfcPromptRole: "context",
    });
  }
  return {
    contextText: contextBlocks.join("\n"),
    activations: {
      type: HARNESS_SKILL_ACTIVATIONS_TYPE,
      version: 1,
      generatedAt: activatedAt,
      activations,
    },
  };
};

export const isHarnessSkillRootWithinWorkspace = (
  workspaceHostPath: string,
  skillsRoot: string,
): boolean => isPathWithinRoot(resolve(workspaceHostPath), resolve(skillsRoot));
