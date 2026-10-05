import { parseArgs } from "@std/cli/parse-args";
import {
  fromFileUrl,
  join as joinFileSystemPath,
  relative as relativeFileSystemPath,
} from "@std/path";
import {
  basename as graphPathBasename,
  dirname as graphPathDirname,
  extname as graphPathExtension,
  join as joinGraphPath,
  normalize as normalizeGraphPath,
} from "@std/path/posix";

import { Parser as HtmlParser } from "htmlparser2";
import { marked, type Token } from "marked";

interface MarkdownFile {
  readonly name: string;
  readonly fileSystemPath: string;
  readonly graphPath: string;
}

interface DirectoryTree {
  readonly name: string;
  readonly graphPath: string;
  readonly files: readonly MarkdownFile[];
  readonly directories: readonly DirectoryTree[];
  readonly directoryPaths: readonly string[];
  readonly otherFilePaths: readonly string[];
}

interface DirectedEdge {
  readonly source: string;
  readonly target: string;
}

interface RenderedEdge extends DirectedEdge {
  readonly bidirectional: boolean;
}

interface DocsGraph {
  readonly directoryTree: DirectoryTree;
  readonly files: readonly MarkdownFile[];
  readonly includeHistory: boolean;
  readonly directedEdges: readonly DirectedEdge[];
  readonly renderedEdges: readonly RenderedEdge[];
  readonly incoming: ReadonlySet<string>;
}

type OutputFormat = "dot" | "json" | "html" | "orphan";

interface CommandLineOptions {
  readonly format: OutputFormat;
  readonly includeHistory: boolean;
  readonly outputPath?: string;
}

const directoryBorderColor = "#20b2aa";
const directoryBackgroundColor = `${directoryBorderColor}1a`;
const historyGraphPath = "docs/history";

const compareCodePoints = (left: string, right: string): number => {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  const sharedLength = Math.min(leftCharacters.length, rightCharacters.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCharacters[index].codePointAt(0)! -
      rightCharacters[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftCharacters.length - rightCharacters.length;
};

// Graph paths sort by punctuation, digits, then case-insensitive ASCII letters.
// Lowercase precedes uppercase when the primary paths match.
const graphPathPrimaryWeight = (character: string): number => {
  if (character === "_") return 0;
  if (character === "-") return 1;
  if (character === ".") return 2;
  if (character === "/") return 3;
  if (character >= "0" && character <= "9") {
    return 10 + character.codePointAt(0)! - "0".codePointAt(0)!;
  }

  const isAsciiLetter = (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z");
  if (isAsciiLetter) {
    const lowercase = character.toLowerCase();
    return 30 + lowercase.codePointAt(0)! - "a".codePointAt(0)!;
  }
  return 1_000 + character.codePointAt(0)!;
};

const compareGraphPaths = (left: string, right: string): number => {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  const sharedLength = Math.min(leftCharacters.length, rightCharacters.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const weightDifference = graphPathPrimaryWeight(leftCharacters[index]) -
      graphPathPrimaryWeight(rightCharacters[index]);
    if (weightDifference !== 0) return weightDifference;
  }
  if (leftCharacters.length !== rightCharacters.length) {
    return leftCharacters.length - rightCharacters.length;
  }

  for (let index = 0; index < leftCharacters.length; index += 1) {
    if (leftCharacters[index] === rightCharacters[index]) continue;
    const leftIsLowercaseAscii = leftCharacters[index] >= "a" &&
      leftCharacters[index] <= "z";
    const rightIsLowercaseAscii = rightCharacters[index] >= "a" &&
      rightCharacters[index] <= "z";
    if (leftIsLowercaseAscii !== rightIsLowercaseAscii) {
      return leftIsLowercaseAscii ? -1 : 1;
    }
    return compareCodePoints(leftCharacters[index], rightCharacters[index]);
  }
  return 0;
};

const readDirectoryTree = async (
  fileSystemPath: string,
  graphPath: string,
  excludedDirectoryPaths: ReadonlySet<string>,
): Promise<DirectoryTree> => {
  const entries = [...await Array.fromAsync(Deno.readDir(fileSystemPath))]
    .sort((left, right) => compareCodePoints(left.name, right.name));
  const files = entries
    .filter((entry) => entry.isFile && entry.name.endsWith(".md"))
    .map((entry) => ({
      name: entry.name,
      fileSystemPath: joinFileSystemPath(fileSystemPath, entry.name),
      graphPath: `${graphPath}/${entry.name}`,
    }));
  const directories: DirectoryTree[] = [];
  const directoryPaths = [graphPath];
  const otherFilePaths = entries
    .filter((entry) =>
      !entry.isDirectory && !(entry.isFile && entry.name.endsWith(".md"))
    )
    .map((entry) => `${graphPath}/${entry.name}`);

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const childGraphPath = `${graphPath}/${entry.name}`;
    if (excludedDirectoryPaths.has(childGraphPath)) continue;
    const child = await readDirectoryTree(
      joinFileSystemPath(fileSystemPath, entry.name),
      childGraphPath,
      excludedDirectoryPaths,
    );
    for (const directoryPath of child.directoryPaths) {
      directoryPaths.push(directoryPath);
    }
    for (const otherFilePath of child.otherFilePaths) {
      otherFilePaths.push(otherFilePath);
    }
    if (child.files.length > 0 || child.directories.length > 0) {
      directories.push(child);
    }
  }

  return {
    name: graphPathBasename(graphPath),
    graphPath,
    files,
    directories,
    directoryPaths,
    otherFilePaths,
  };
};

const flattenFiles = (directory: DirectoryTree): MarkdownFile[] => [
  ...directory.files,
  ...directory.directories.flatMap(flattenFiles),
];

const graphString = (value: string) =>
  `"${
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
  }"`;

const htmlText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const scriptJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("Value cannot be represented as JSON");
  }
  return json
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
};

const resolveLink = (
  source: string,
  href: string,
  filePaths: ReadonlySet<string>,
  directoryPaths: ReadonlySet<string>,
  otherFilePaths: ReadonlySet<string>,
): string | undefined => {
  let destination = href.trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  if (
    destination === "" ||
    destination.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(destination) ||
    destination.startsWith("//")
  ) {
    return undefined;
  }

  destination = destination.split("#", 1)[0].split("?", 1)[0];
  if (destination === "") return undefined;
  try {
    destination = decodeURIComponent(destination);
  } catch {
    return undefined;
  }
  const terminalSegment = destination.split("/").at(-1);
  const usesDirectorySyntax = destination.endsWith("/") ||
    terminalSegment === "." ||
    terminalSegment === "..";

  const normalized = destination.startsWith("/")
    ? normalizeGraphPath(destination.slice(1))
    : normalizeGraphPath(
      joinGraphPath(graphPathDirname(source), destination),
    );
  const resolved = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  if (directoryPaths.has(resolved)) {
    const readmePath = `${resolved}/README.md`;
    return filePaths.has(readmePath) ? readmePath : undefined;
  }
  if (otherFilePaths.has(resolved) || usesDirectorySyntax) {
    return undefined;
  }
  const candidates = graphPathExtension(resolved) === ""
    ? [resolved, `${resolved}.md`]
    : [resolved];
  return candidates.find((candidate) => filePaths.has(candidate));
};

const collectDirectedEdges = async (
  files: readonly MarkdownFile[],
  directoryPaths: ReadonlySet<string>,
  otherFilePaths: ReadonlySet<string>,
): Promise<DirectedEdge[]> => {
  const filePaths = new Set(files.map(({ graphPath }) => graphPath));
  const directedKeys = new Set<string>();

  for (const file of files) {
    const markdown = await Deno.readTextFile(file.fileSystemPath);
    const tokens = marked.lexer(markdown);
    const recordTarget = (href: string) => {
      const target = resolveLink(
        file.graphPath,
        href,
        filePaths,
        directoryPaths,
        otherFilePaths,
      );
      if (target !== undefined) {
        directedKeys.add(`${file.graphPath}\0${target}`);
      }
    };

    marked.walkTokens(tokens, (token: Token) => {
      if (token.type === "link") {
        recordTarget(token.href);
      } else if (token.type === "html") {
        const parser = new HtmlParser({
          onopentag(name, attributes) {
            if (name === "a" && attributes.href !== undefined) {
              recordTarget(attributes.href);
            }
          },
        });
        parser.end(token.raw);
      }
    });
  }

  return [...directedKeys]
    .map((key) => {
      const [source, target] = key.split("\0");
      return { source, target };
    })
    .sort((left, right) =>
      compareGraphPaths(left.source, right.source) ||
      compareGraphPaths(left.target, right.target)
    );
};

const collapseEdges = (
  directedEdges: readonly DirectedEdge[],
): RenderedEdge[] => {
  const directedKeys = new Set(
    directedEdges.map(({ source, target }) => `${source}\0${target}`),
  );
  const emittedPairs = new Set<string>();
  const output: RenderedEdge[] = [];

  for (const edge of directedEdges) {
    const reverseKey = `${edge.target}\0${edge.source}`;
    if (edge.source === edge.target || !directedKeys.has(reverseKey)) {
      output.push({ ...edge, bidirectional: false });
      continue;
    }

    const pairKey = [edge.source, edge.target]
      .sort(compareCodePoints)
      .join("\0");
    if (emittedPairs.has(pairKey)) continue;
    emittedPairs.add(pairKey);
    output.push({ ...edge, bidirectional: true });
  }

  return output;
};

const nodeLine = (
  file: MarkdownFile,
  incoming: ReadonlySet<string>,
  indent: string,
): string => {
  if (file.name === "README.md") {
    const readmeLabel = `${
      htmlText(graphPathBasename(graphPathDirname(file.graphPath)))
    }<BR/>${htmlText(file.name)}`;
    if (file.graphPath === "docs/README.md") {
      return `${indent}${
        graphString(file.graphPath)
      } [fillcolor="lime", style="filled", label=<<B>${readmeLabel}</B>>];`;
    }
    return `${indent}${
      graphString(file.graphPath)
    } [fillcolor="yellow", style="filled", label=<${readmeLabel}>];`;
  }
  if (!incoming.has(file.graphPath)) {
    return `${indent}${
      graphString(file.graphPath)
    } [fillcolor="lightcoral", style="filled", label=${
      graphString(file.name)
    }];`;
  }
  return `${indent}${graphString(file.graphPath)} [label=${
    graphString(file.name)
  }];`;
};

const renderDirectory = (
  directory: DirectoryTree,
  incoming: ReadonlySet<string>,
  depth: number,
): string[] => {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  const lines = [
    `${indent}subgraph ${graphString(`cluster_${directory.graphPath}`)} {`,
    `${childIndent}graph [label=<<B>${
      htmlText(directory.name)
    }</B>>, style="rounded,filled", color=${
      graphString(directoryBorderColor)
    }, fillcolor=${graphString(directoryBackgroundColor)}];`,
  ];

  for (const file of directory.files) {
    lines.push(nodeLine(file, incoming, childIndent));
  }
  for (const child of directory.directories) {
    for (const line of renderDirectory(child, incoming, depth + 1)) {
      lines.push(line);
    }
  }
  lines.push(`${indent}}`);
  return lines;
};

const buildDocsGraph = async (
  docsFileSystemPath: string,
  includeHistory: boolean,
): Promise<DocsGraph> => {
  const excludedDirectoryPaths = includeHistory
    ? new Set<string>()
    : new Set([historyGraphPath]);
  const docsTree = await readDirectoryTree(
    docsFileSystemPath,
    "docs",
    excludedDirectoryPaths,
  );
  const docsFiles = flattenFiles(docsTree);
  const directoryPaths = new Set(docsTree.directoryPaths);
  const otherFilePaths = new Set(docsTree.otherFilePaths);
  const directedEdges = await collectDirectedEdges(
    docsFiles,
    directoryPaths,
    otherFilePaths,
  );
  const renderedEdges = collapseEdges(directedEdges);
  const incoming = new Set(directedEdges.map(({ target }) => target));

  return {
    directoryTree: docsTree,
    files: docsFiles,
    includeHistory,
    directedEdges,
    renderedEdges,
    incoming,
  };
};

const renderDocsDot = (
  graph: DocsGraph,
  edgeIdPrefix?: string,
): string => {
  const outputLines = [
    "// Every scanned Markdown file under docs is a node.",
    graph.includeHistory
      ? "// docs/history is included by --history."
      : "// docs/history is excluded by default; pass --history to include it.",
    "// Every link whose resolved destination is one of those files is an edge.",
    "strict digraph docs {",
    '  graph [layout="osage", pack=48, packmode="array_i2", splines="line", fontsize=18, labeljust="l", labelloc="t"];',
    "",
    "  // Links to scanned directories resolve to their README.md file.",
    "  // Repeated links from one file to the same target appear as one edge.",
    "  // Opposite-direction links between the same two files share one bidirectional edge.",
    "  // Non-README files with no incoming links use a light red fill.",
    "  // Nested README.md nodes use a yellow fill. The root README uses lime and its label is bold.",
    "  // README labels show their directory's final component above README.md.",
    "  // Other node labels show only the file name, without its directory path.",
    "  // Each docs subdirectory has a light teal border and a 10%-opaque matching background, extra internal spacing, and a larger, bold label at its upper left; files directly under docs remain unclustered.",
  ];

  for (const file of graph.directoryTree.files) {
    outputLines.push(nodeLine(file, graph.incoming, "  "));
  }
  outputLines.push("");

  for (const directory of graph.directoryTree.directories) {
    for (const line of renderDirectory(directory, graph.incoming, 1)) {
      outputLines.push(line);
    }
    outputLines.push("");
  }

  for (const [index, edge] of graph.renderedEdges.entries()) {
    const attributeValues = edge.bidirectional
      ? ['dir="both"', 'class="bidirectional"']
      : [];
    if (edgeIdPrefix !== undefined) {
      attributeValues.push(`id=${graphString(`${edgeIdPrefix}${index}`)}`);
    }
    const attributes = attributeValues.length === 0
      ? ""
      : ` [${attributeValues.join(", ")}]`;
    outputLines.push(
      `  ${graphString(edge.source)} -> ${
        graphString(edge.target)
      }${attributes};`,
    );
  }
  outputLines.push("}");
  return `${outputLines.join("\n")}\n`;
};

const renderDocsJson = (graph: DocsGraph): string =>
  `${
    JSON.stringify(
      {
        nodes: graph.files.map(({ graphPath }) => graphPath),
        edges: graph.directedEdges.map(({ source, target }) => ({
          source,
          target,
        })),
      },
      null,
      2,
    )
  }\n`;

const renderOrphans = (graph: DocsGraph, currentDirectory: string): string => {
  const paths = graph.files
    .filter(({ graphPath }) => !graph.incoming.has(graphPath))
    .map(({ fileSystemPath }) =>
      relativeFileSystemPath(currentDirectory, fileSystemPath)
    )
    .sort(compareCodePoints);
  return paths.length === 0 ? "" : `${paths.join("\n")}\n`;
};

const renderDocsHtml = async (
  graph: DocsGraph,
  dot: string,
): Promise<string> => {
  // The graph renderer is needed only for HTML output.
  // deno-lint-ignore cf-imports/no-inline-module-import
  const { instance } = await import("@viz-js/viz");
  const viz = await instance();
  const edgeIdPrefix = "docs-edge-";
  const svgDocument = viz.renderString(renderDocsDot(graph, edgeIdPrefix), {
    engine: "osage",
    format: "svg",
  });
  const svgStart = svgDocument.indexOf("<svg");
  const svgEnd = svgDocument.lastIndexOf("</svg>");
  if (svgStart === -1 || svgEnd === -1) {
    throw new Error("Viz.js did not return an SVG document");
  }
  const svg = svgDocument
    .slice(svgStart, svgEnd + "</svg>".length)
    .replace(
      "<svg ",
      `<svg id="docs-link-graph" class="docs-link-graph" role="img" aria-label="Directed graph of ${graph.files.length} Markdown files and ${graph.directedEdges.length} hyperlinks" `,
    );

  return `<!doctype html>
<!-- Generated with @viz-js/viz 3.26.0. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'"
  >
  <title>Docs Link Graph</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: light-dark(rgb(255 255 255), rgb(24 24 24));
      --foreground: light-dark(rgb(26 28 31), rgb(245 245 245));
      --muted: light-dark(rgb(100 105 112), rgb(170 174 181));
      --surface: light-dark(rgb(247 248 250), rgb(38 39 43));
      --border: light-dark(rgb(213 216 221), rgb(72 75 82));
      --accent: light-dark(rgb(0 102 204), rgb(100 181 255));
      --directory-border: ${directoryBorderColor};
      --edge: light-dark(rgb(74 80 88), rgb(176 181 190));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
    }

    body {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      color: var(--foreground);
      background: var(--background);
    }

    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .heading {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      margin-right: auto;
      white-space: nowrap;
    }

    h1 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
    }

    .counts,
    #detail {
      color: var(--muted);
      font-size: 0.8125rem;
    }

    label {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8125rem;
    }

    select,
    button {
      min-height: 2rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--foreground);
      background: var(--background);
      font: inherit;
    }

    select {
      width: min(28rem, 46vw);
      padding: 0 0.5rem;
    }

    button {
      min-width: 2rem;
      padding: 0 0.55rem;
      cursor: pointer;
    }

    button:hover,
    button:focus-visible,
    select:focus-visible {
      border-color: var(--accent);
      outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
      outline-offset: 1px;
    }

    .controls {
      display: flex;
      gap: 0.25rem;
    }

    #detail {
      min-height: 2rem;
      padding: 0.45rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }

    #canvas {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }

    #canvas.is-dragging {
      cursor: grabbing;
    }

    .docs-link-graph {
      display: block;
      width: 100%;
      height: 100%;
    }

    .docs-link-graph > .graph > polygon {
      fill: transparent;
    }

    .docs-link-graph .node ellipse,
    .docs-link-graph .node polygon,
    .docs-link-graph .node path {
      stroke: var(--edge);
    }

    .docs-link-graph .cluster path,
    .docs-link-graph .cluster polygon {
      stroke: var(--directory-border);
    }

    .docs-link-graph .cluster text,
    .docs-link-graph .node text {
      fill: var(--foreground);
    }

    .docs-link-graph .node.is-readme text,
    .docs-link-graph .node.is-root-readme text,
    .docs-link-graph .node.is-no-incoming text {
      fill: rgb(20 20 20);
    }

    .docs-link-graph .edge path {
      stroke: var(--edge);
    }

    .docs-link-graph .edge polygon {
      fill: var(--edge);
      stroke: var(--edge);
    }

    .docs-link-graph .node {
      cursor: pointer;
      transition: opacity 120ms ease;
    }

    .docs-link-graph .edge {
      transition: opacity 120ms ease;
    }

    .docs-link-graph .node:hover ellipse,
    .docs-link-graph .node:hover polygon,
    .docs-link-graph .node:hover path,
    .docs-link-graph .node:focus-visible ellipse,
    .docs-link-graph .node:focus-visible polygon,
    .docs-link-graph .node:focus-visible path {
      stroke: var(--accent);
      stroke-width: 3px;
    }

    .docs-link-graph .node:focus-visible {
      outline: none;
    }

    .docs-link-graph .node.is-selected ellipse,
    .docs-link-graph .node.is-selected polygon,
    .docs-link-graph .node.is-selected path {
      stroke: var(--accent);
      stroke-width: 5px;
    }

    .docs-link-graph .node.is-neighbor ellipse,
    .docs-link-graph .node.is-neighbor polygon,
    .docs-link-graph .node.is-neighbor path {
      stroke: var(--accent);
      stroke-width: 3px;
    }

    .docs-link-graph .edge.is-incident path {
      stroke: var(--accent);
      stroke-width: 3px;
    }

    .docs-link-graph .edge.is-incident polygon {
      fill: var(--accent);
      stroke: var(--accent);
    }

    #canvas.has-selection .node:not(.is-selected):not(.is-neighbor) {
      opacity: 0.24;
    }

    #canvas.has-selection .edge:not(.is-incident) {
      opacity: 0.08;
    }

    @media (max-width: 700px) {
      .heading {
        width: 100%;
      }

      label {
        flex: 1 1 100%;
      }

      select {
        width: 100%;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .docs-link-graph .node,
      .docs-link-graph .edge {
        transition: none;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="heading">
      <h1>Docs link graph</h1>
      <span class="counts">${graph.files.length} files · ${graph.directedEdges.length} links</span>
    </div>
    <label for="file-picker">
      File
      <select id="file-picker">
        <option value="">Select a file</option>
      </select>
    </label>
    <div class="controls" aria-label="Graph controls">
      <button id="pan-left" type="button" aria-label="Pan left">←</button>
      <button id="pan-right" type="button" aria-label="Pan right">→</button>
      <button id="pan-up" type="button" aria-label="Pan up">↑</button>
      <button id="pan-down" type="button" aria-label="Pan down">↓</button>
      <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
      <button id="zoom-out" type="button" aria-label="Zoom out">−</button>
      <button id="fit-graph" type="button">Fit</button>
      <button id="download-dot" type="button">DOT</button>
    </div>
  </header>
  <div id="detail" role="status">Select a file to inspect its incoming and outgoing links.</div>
  <main id="canvas">
    ${svg}
  </main>
  <textarea id="docs-dot-source" hidden>${htmlText(dot)}</textarea>
  <script>
    (() => {
      "use strict";

      const canvas = document.getElementById("canvas");
      const svg = document.getElementById("docs-link-graph");
      const filePicker = document.getElementById("file-picker");
      const detail = document.getElementById("detail");
      const dotSource = document.getElementById("docs-dot-source");
      const initialBox = svg.viewBox.baseVal;
      const initialView = {
        x: initialBox.x,
        y: initialBox.y,
        width: initialBox.width,
        height: initialBox.height,
      };
      let view = { ...initialView };

      const setView = (next) => {
        view = next;
        svg.setAttribute(
          "viewBox",
          [view.x, view.y, view.width, view.height].join(" "),
        );
      };

      const panView = (horizontal, vertical) => {
        setView({
          ...view,
          x: view.x + view.width * horizontal,
          y: view.y + view.height * vertical,
        });
      };

      const zoomView = (factor, anchorX, anchorY) => {
        const x = anchorX === undefined ? view.x + view.width / 2 : anchorX;
        const y = anchorY === undefined ? view.y + view.height / 2 : anchorY;
        setView({
          x: x - (x - view.x) * factor,
          y: y - (y - view.y) * factor,
          width: view.width * factor,
          height: view.height * factor,
        });
      };

      const graphPoint = (clientX, clientY) => {
        const transform = svg.getScreenCTM();
        if (transform === null) {
          return {
            x: view.x + view.width / 2,
            y: view.y + view.height / 2,
          };
        }
        return new DOMPoint(clientX, clientY).matrixTransform(
          transform.inverse(),
        );
      };

      const nodes = [...svg.querySelectorAll(".node")];
      const edges = [...svg.querySelectorAll(".edge")];
      const nodesByName = new Map();
      const edgeMetadata = new Map(${
    scriptJson(
      graph.renderedEdges.map((edge, index) => [
        `${edgeIdPrefix}${index}`,
        edge,
      ]),
    )
  });

      for (const node of nodes) {
        const name = node.querySelector(":scope > title")?.textContent ?? "";
        nodesByName.set(name, node);
        node.setAttribute("role", "button");
        node.setAttribute("tabindex", "0");
        node.setAttribute("aria-label", name);
        if (name.endsWith("/README.md")) node.classList.add("is-readme");
        if (name === "docs/README.md") node.classList.add("is-root-readme");
      }

      const edgeRecords = edges.map((edge) => {
        const metadata = edgeMetadata.get(edge.id);
        return {
          edge,
          source: metadata?.source ?? "",
          target: metadata?.target ?? "",
          bidirectional: metadata?.bidirectional ?? false,
        };
      });

      const incomingNames = new Set(
        edgeRecords.flatMap(({ source, target, bidirectional }) =>
          bidirectional ? [source, target] : [target]
        ).filter(Boolean),
      );
      for (const [name, node] of nodesByName) {
        if (name !== "" && !incomingNames.has(name)) {
          node.classList.add("is-no-incoming");
        }
      }

      const options = document.createDocumentFragment();
      for (const name of [...nodesByName.keys()].filter(Boolean).sort()) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        options.append(option);
      }
      filePicker.append(options);

      const clearSelection = () => {
        canvas.classList.remove("has-selection");
        for (const node of nodes) {
          node.classList.remove("is-selected", "is-neighbor");
        }
        for (const { edge } of edgeRecords) {
          edge.classList.remove("is-incident");
        }
        filePicker.value = "";
        detail.textContent =
          "Select a file to inspect its incoming and outgoing links.";
      };

      const selectNode = (node) => {
        const name =
          node.querySelector(":scope > title")?.textContent ?? "";
        clearSelection();
        canvas.classList.add("has-selection");
        node.classList.add("is-selected");

        let outgoing = 0;
        let incoming = 0;
        for (const record of edgeRecords) {
          if (record.source === name) {
            outgoing += 1;
            if (record.bidirectional) incoming += 1;
            record.edge.classList.add("is-incident");
            nodesByName.get(record.target)?.classList.add("is-neighbor");
          }
          if (record.target === name) {
            incoming += 1;
            if (record.bidirectional) outgoing += 1;
            record.edge.classList.add("is-incident");
            nodesByName.get(record.source)?.classList.add("is-neighbor");
          }
        }

        filePicker.value = name;
        detail.textContent =
          name + " · " + outgoing + " outgoing · " + incoming + " incoming";
      };

      filePicker.addEventListener("change", () => {
        const node = nodesByName.get(filePicker.value);
        if (node === undefined) clearSelection();
        else selectNode(node);
      });

      for (const node of nodes) {
        node.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectNode(node);
          }
        });
      }

      document.getElementById("pan-left").addEventListener(
        "click",
        () => panView(-0.15, 0),
      );
      document.getElementById("pan-right").addEventListener(
        "click",
        () => panView(0.15, 0),
      );
      document.getElementById("pan-up").addEventListener(
        "click",
        () => panView(0, -0.15),
      );
      document.getElementById("pan-down").addEventListener(
        "click",
        () => panView(0, 0.15),
      );
      document.getElementById("zoom-in").addEventListener(
        "click",
        () => zoomView(0.8),
      );
      document.getElementById("zoom-out").addEventListener(
        "click",
        () => zoomView(1.25),
      );
      document.getElementById("fit-graph").addEventListener(
        "click",
        () => setView({ ...initialView }),
      );
      document.getElementById("download-dot").addEventListener("click", () => {
        const blob = new Blob([dotSource.value], {
          type: "text/vnd.graphviz;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "docs.dot";
        link.click();
        URL.revokeObjectURL(url);
      });

      let drag;
      let suppressClick = false;
      let pressedNode;
      let acceptedClickPointerId;

      canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary || drag !== undefined) {
          event.preventDefault();
          return;
        }
        acceptedClickPointerId = event.pointerId;
        const transform = svg.getScreenCTM();
        if (transform === null) {
          acceptedClickPointerId = undefined;
          return;
        }
        const inverseTransform = transform.inverse();
        const graphPosition = new DOMPoint(
          event.clientX,
          event.clientY,
        ).matrixTransform(inverseTransform);
        pressedNode = event.target instanceof Element
          ? event.target.closest(".node")
          : undefined;
        canvas.setPointerCapture(event.pointerId);
        drag = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          graphX: graphPosition.x,
          graphY: graphPosition.y,
          inverseTransform,
          view: { ...view },
        };
        suppressClick = false;
      });

      canvas.addEventListener("pointermove", (event) => {
        if (drag === undefined || drag.pointerId !== event.pointerId) return;
        const pointerTravel = Math.hypot(
          event.clientX - drag.clientX,
          event.clientY - drag.clientY,
        );
        if (!suppressClick && pointerTravel <= 3) return;
        if (!suppressClick) {
          suppressClick = true;
          canvas.classList.add("is-dragging");
        }
        const graphPosition = new DOMPoint(
          event.clientX,
          event.clientY,
        ).matrixTransform(drag.inverseTransform);
        const horizontal = graphPosition.x - drag.graphX;
        const vertical = graphPosition.y - drag.graphY;
        setView({
          ...drag.view,
          x: drag.view.x - horizontal,
          y: drag.view.y - vertical,
        });
      });

      const endDrag = (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        drag = undefined;
        canvas.classList.remove("is-dragging");
      };
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        acceptedClickPointerId = undefined;
        pressedNode = undefined;
        suppressClick = false;
        endDrag(event);
      });

      canvas.addEventListener("click", (event) => {
        if (
          "pointerType" in event &&
          event.pointerType !== "" &&
          event.pointerId !== acceptedClickPointerId
        ) return;
        acceptedClickPointerId = undefined;
        if (suppressClick) {
          suppressClick = false;
          pressedNode = undefined;
          return;
        }
        const target = event.target instanceof Element
          ? event.target.closest(".node") ?? pressedNode ?? null
          : pressedNode ?? null;
        pressedNode = undefined;
        if (target === null) clearSelection();
        else selectNode(target);
      });

      canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        const anchor = graphPoint(event.clientX, event.clientY);
        const factor = Math.exp(
          Math.max(-0.5, Math.min(0.5, event.deltaY * 0.0015)),
        );
        zoomView(factor, anchor.x, anchor.y);
      }, { passive: false });

      canvas.addEventListener("dblclick", (event) => {
        event.preventDefault();
        setView({ ...initialView });
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") clearSelection();
      });
    })();
  </script>
</body>
</html>
`;
};

const usage = `Usage:
  deno run --allow-read [--allow-write=<path>] scripts/docs-links.ts \\
    (--dot | --json | --html | --orphan) [--history] [--out <path>]

Output formats:
  --dot      Graphviz DOT with the documentation graph styling
  --json     JSON nodes and directed edges without presentation attributes
  --html     Self-contained interactive HTML viewer with the DOT source inlined
  --orphan   Paths, relative to the current directory, with no inbound links

Options:
  --history     Include docs/history in the scan
  --out <path>  Write to this path instead of standard output; requires
                matching Deno --allow-write permission
  --help        Show this help`;

const usageError = (message: string): never => {
  console.error(`Error: ${message}\n\n${usage}`);
  Deno.exit(2);
};

const parseCommandLine = (
  arguments_: readonly string[],
): CommandLineOptions | undefined => {
  const parsed = parseArgs([...arguments_], {
    boolean: ["dot", "json", "html", "orphan", "history", "help"],
    string: ["out"],
    alias: { h: "help", o: "out" },
  });
  const knownKeys = new Set([
    "_",
    "--",
    "dot",
    "json",
    "html",
    "orphan",
    "history",
    "help",
    "h",
    "out",
    "o",
  ]);
  const unknown = Object.keys(parsed).find((key) => !knownKeys.has(key));
  if (unknown !== undefined) usageError(`unknown option --${unknown}`);
  if (parsed._.length > 0) {
    usageError(`unexpected argument ${String(parsed._[0])}`);
  }
  if (parsed.help) {
    console.log(usage);
    return undefined;
  }

  const formats = (["dot", "json", "html", "orphan"] as const)
    .filter((format) => parsed[format]);
  if (formats.length !== 1) {
    usageError("choose exactly one output format");
  }
  if (parsed.out === "") usageError("--out requires a path");
  return {
    format: formats[0],
    includeHistory: parsed.history,
    outputPath: parsed.out,
  };
};

const writeOutput = async (
  output: string,
  outputPath: string | undefined,
): Promise<void> => {
  if (outputPath !== undefined) {
    await Deno.writeTextFile(outputPath, output);
  } else {
    const bytes = new TextEncoder().encode(output);
    for (let written = 0; written < bytes.length;) {
      written += await Deno.stdout.write(bytes.subarray(written));
    }
  }
};

if (import.meta.main) {
  const options = parseCommandLine(Deno.args);
  if (options !== undefined) {
    const repositoryRoot = fromFileUrl(new URL("../", import.meta.url));
    const docsDirectory = joinFileSystemPath(repositoryRoot, "docs");
    const graph = await buildDocsGraph(
      docsDirectory,
      options.includeHistory,
    );
    const dot = renderDocsDot(graph);
    const output = options.format === "dot"
      ? dot
      : options.format === "json"
      ? renderDocsJson(graph)
      : options.format === "html"
      ? await renderDocsHtml(graph, dot)
      : renderOrphans(graph, Deno.cwd());
    await writeOutput(output, options.outputPath);
  }
}
