export interface CellLink {
  id: string;
  space: string;
  path: Array<string | number>;
  scope?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const REVISION_SEQUENCE_PLACEHOLDER = "REVISION_SEQ";
const RAW_SCOPE_KEY_PLACEHOLDER = "RAW_SCOPE_KEY";
const USER_SCOPE_KEY_FORM = "user:${encodeURIComponent(PRINCIPAL_DID)}";
const SESSION_SCOPE_KEY_FORM =
  "session:${encodeURIComponent(PRINCIPAL_DID)}:${encodeURIComponent(SESSION_ID)}";

function usesDefaultSpaceScope(link: CellLink): boolean {
  return link.scope === undefined || link.scope === "space";
}

function inspectScopeArgument(
  link: CellLink,
  scopeKey = RAW_SCOPE_KEY_PLACEHOLDER,
): string {
  return usesDefaultSpaceScope(link) ? "" : ` --scope ${shellQuote(scopeKey)}`;
}

function inspectScopeKeyCommand(
  link: CellLink,
  scopeKey = RAW_SCOPE_KEY_PLACEHOLDER,
): string {
  if (usesDefaultSpaceScope(link)) return "";
  const declaredScope = link.scope ?? "space";
  const keyForm = declaredScope === "user"
    ? USER_SCOPE_KEY_FORM
    : declaredScope === "session"
    ? SESSION_SCOPE_KEY_FORM
    : "the exact variants[].scope value";
  return `# The link records the declared ${shellQuote(declaredScope)} scope.
# cf inspect --scope requires the exact stored scope key, not that name.
deno task cf inspect overlay ${shellQuote(link.space)} ${
    shellQuote(link.id)
  } --remote --json
# Treat every variants[] entry whose kind is ${shellQuote(declaredScope)} as a
# candidate. overlay shows each candidate's latest value, so do not select by
# that value alone. Repeat the history command below for every candidate after
# replacing ${scopeKey} with its scope field exactly. Search those full histories
# for the candidate and revision whose value at the link's path matches this
# page. The stored scope-key form is ${keyForm}.`;
}

function inspectCachedValueCommand(
  link: CellLink,
  sequence = REVISION_SEQUENCE_PLACEHOLDER,
  scopeKey = RAW_SCOPE_KEY_PLACEHOLDER,
): string {
  const path = link.path.length === 0
    ? ""
    : ` --path-json ${shellQuote(JSON.stringify(link.path.map(String)))}`;
  return `deno task cf inspect value-at ${shellQuote(link.space)} ${
    shellQuote(link.id)
  } --remote --full-depth --seq ${sequence}${path}${
    inspectScopeArgument(link, scopeKey)
  }`;
}

function forcePullCommand(space: string): string {
  return `deno task cf inspect pull ${shellQuote(space)} --remote --force`;
}

function inspectHistoryCommand(
  link: CellLink,
  scopeKey = RAW_SCOPE_KEY_PLACEHOLDER,
): string {
  return `deno task cf inspect history ${shellQuote(link.space)} ${
    shellQuote(link.id)
  } --remote --limit=-1 --json${inspectScopeArgument(link, scopeKey)}`;
}

export function inspectValueCommand(link: CellLink): string {
  return [
    forcePullCommand(link.space),
    inspectScopeKeyCommand(link),
    inspectHistoryCommand(link),
    "# Replace REVISION_SEQ below with the revision seq for the page snapshot.",
    "# Match candidates by the displayed IDs, timestamps, content hashes, and JSON.",
    inspectCachedValueCommand(link),
  ].filter((line) => line.length > 0).join("\n");
}

export function inspectMaterializedValueCommand(link: CellLink): string {
  return `${inspectValueCommand(link)}
# The page materializes stable child cells. value-at leaves them as $link
# objects. Recursively run the commands below for every $link in the selected
# value. A linked cell can have a different matching revision even in the same
# space. Select the revision whose rendered value matches the corresponding
# value on this raw-data page. Do not reuse root REVISION_SEQ without checking.
# Resolve relative links against the cell containing them. A missing id uses
# the containing entity. A missing space uses the containing space. A missing
# or "inherit" scope uses the containing declared scope. Omit --path-json when
# the resolved path is empty.
deno task cf inspect pull '<resolved $link.space>' --remote --force
# If the resolved declared scope is "user" or "session", run overlay and treat
# every variants[] entry with that kind as a candidate. overlay shows latest
# values only. Repeat the scoped history and value-at commands for every
# candidate. Select the LINK_SCOPE_KEY and LINK_REVISION_SEQ together by
# matching the value at the link's path to this raw page. A user key is
# ${USER_SCOPE_KEY_FORM}. A session key is ${SESSION_SCOPE_KEY_FORM}.
deno task cf inspect overlay '<resolved $link.space>' '<resolved $link.id>' \
  --remote --json
# For the default "space" scope, use these commands:
deno task cf inspect history '<resolved $link.space>' '<resolved $link.id>' \
  --remote --limit=-1 --json
deno task cf inspect value-at '<resolved $link.space>' '<resolved $link.id>' \
  --remote --full-depth --seq LINK_REVISION_SEQ \
  --path-json '<JSON array of resolved $link.path string segments>'
# For a "user" or "session" scope, use these commands instead:
deno task cf inspect history '<resolved $link.space>' '<resolved $link.id>' \
  --remote --limit=-1 --json --scope 'LINK_SCOPE_KEY'
deno task cf inspect value-at '<resolved $link.space>' '<resolved $link.id>' \
  --remote --full-depth --seq LINK_REVISION_SEQ \
  --path-json '<JSON array of resolved $link.path string segments>' \
  --scope 'LINK_SCOPE_KEY'`;
}

export function inspectLinkedValueCommand(
  link: CellLink,
  sequence: string,
  match: string,
): string {
  return [
    forcePullCommand(link.space),
    inspectScopeKeyCommand(link),
    inspectHistoryCommand(link),
    `# Replace ${sequence} with the revision seq whose value ${match}.`,
    inspectCachedValueCommand(link, sequence),
  ].filter((line) => line.length > 0).join("\n");
}

export const RAW_RETRIEVAL_SETUP =
  "Run the procedure from a Labs checkout. Set CF_API_URL to the Toolshed " +
  "server URL. Set CF_IDENTITY to the key file used to sign the request. " +
  "The Toolshed ENV must be development, test, or staging, and " +
  "MEMORY_DUMP_ENABLED must be true. The signing identity's DID must appear " +
  "in MEMORY_DUMP_DIDS or MEMORY_SERVICE_DIDS; ordinary Fabric read access " +
  "is not enough. The pull command downloads a current read-only SQLite " +
  "snapshot, including revision history, into the local inspection cache. " +
  "The history command lists every revision sequence and write time for the " +
  "source entity. Use the page's IDs, timestamps, hashes, rendered JSON, and " +
  "transformation description to select the matching revision. Replace each " +
  "sequence placeholder with the matching entity's revision number. A linked " +
  "entity can have a different matching revision, including in the same space. " +
  "Resolve a relative link's missing entity, space, or inherited scope against " +
  "the cell that contains it. A Fabric link records a declared scope. The cf " +
  "inspect --scope option instead requires the exact raw SQLite scope key. " +
  "For a user or session scope, the generated procedure uses inspect overlay " +
  "to enumerate every matching key in variants[].scope. It searches each " +
  "candidate's full history because overlay displays only its latest value. " +
  "The --seq flag " +
  "keeps the reconstruction stable after later publications. The value-at " +
  "command resolves the space through the same remote and reuses the cached " +
  "snapshot. The --path-json flag takes the link path as a JSON array of " +
  "string segments, so property names containing slashes or empty strings are " +
  "preserved. The --full-depth flag prevents nested provider data and child " +
  "links from being truncated.";
