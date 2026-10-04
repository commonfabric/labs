/**
 * Reading the store. The bucket is publicly readable, so listing and
 * fetching need no credential at all; records are untrusted input, and
 * every line goes through the schema validators, with malformed lines
 * ignored. Objects are gzip-encoded with transcoding, so a plain fetch
 * receives NDJSON.
 */

import {
  parseContextLine,
  parseRecordLine,
  type RunContext,
  type TestRecord,
} from "./schema.ts";

const STORAGE = "https://storage.googleapis.com/storage/v1";

/** One object in a listing: its name and the bytes the store holds. */
export interface ListedObject {
  name: string;

  /** Stored size, which for a gzip-encoded object is the compressed size. */
  size: number;
}

/** One object in a listing: its name and when the store created it. */
export interface TimedObject {
  name: string;

  /**
   * The store's own creation time, which is the moment the object became
   * visible to a reader.
   */
  createdAt: string;
}

/** Every item under a prefix, in name order, paginating as needed. */
async function listItems(
  options: {
    bucket: string;
    prefix: string;
    matchGlob?: string;
    fetch?: typeof fetch;
  },
  fields: string,
): Promise<{ name: string; size?: string; timeCreated?: string }[]> {
  const doFetch = options.fetch ?? fetch;
  const items: { name: string; size?: string; timeCreated?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `${STORAGE}/b/${encodeURIComponent(options.bucket)}/o`,
    );
    url.searchParams.set("prefix", options.prefix);
    if (options.matchGlob !== undefined) {
      url.searchParams.set("matchGlob", options.matchGlob);
    }
    url.searchParams.set("fields", `items(${fields}),nextPageToken`);
    url.searchParams.set("maxResults", "1000");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const res = await doFetch(url);
    if (!res.ok) {
      throw new Error(
        `listing ${options.prefix} failed: HTTP ${res.status}`,
      );
    }
    const page = await res.json() as {
      items?: { name?: string; size?: string; timeCreated?: string }[];
      nextPageToken?: string;
    };
    for (const item of page.items ?? []) {
      if (typeof item.name !== "string") continue;
      items.push({
        name: item.name,
        ...(item.size === undefined ? {} : { size: item.size }),
        ...(item.timeCreated === undefined
          ? {}
          : { timeCreated: item.timeCreated }),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Lists every object under a prefix with the time the store created it.
 *
 * A writer names an object before it has finished building it, so the
 * timestamp a name carries is a moment at which the object was not yet
 * there to be read. The creation time is when it became visible, which is
 * the only one of the two that orders a listing the same way however long
 * after the write it is taken. A listing that names an object without
 * timing it has not answered the question asked, and standing in a value
 * would decide a resolution on a guess, so it throws instead.
 */
export async function listObjectTimes(options: {
  bucket: string;
  prefix: string;
  fetch?: typeof fetch;
}): Promise<TimedObject[]> {
  return (await listItems(options, "name,timeCreated")).map((item) => {
    const createdAt = item.timeCreated;
    // The listing is a parsed network response rather than a value this
    // process built, so the field can be absent, empty, or something that
    // is not a time at all. Each of those orders a resolution by a key
    // that means nothing, and an empty string sorts below every real
    // moment, so they are one rejection rather than three.
    if (
      typeof createdAt !== "string" ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      throw new Error(
        `listing ${options.prefix} gave no usable creation time for ` +
          `${item.name}`,
      );
    }
    return { name: item.name, createdAt };
  });
}

/**
 * Lists every object name under a prefix, or only those the glob
 * `matchGlob` matches where one is given. The store applies the glob, so a
 * reader looking for a few objects among a day's thousands fetches the
 * names of the few.
 */
export async function listObjects(options: {
  bucket: string;
  prefix: string;
  matchGlob?: string;
  fetch?: typeof fetch;
}): Promise<string[]> {
  return (await listItems(options, "name")).map((item) => item.name);
}

/**
 * Lists every object under a prefix with its stored size. The size lets a
 * consumer size up a prefix — how much a whole partition would come to,
 * how to divide it — without fetching anything. A listing that names an
 * object without sizing it has not answered the question asked, and
 * standing in a zero would read to such a consumer as an empty object, so
 * it throws instead.
 */
export async function listObjectSizes(options: {
  bucket: string;
  prefix: string;
  fetch?: typeof fetch;
}): Promise<ListedObject[]> {
  return (await listItems(options, "name,size")).map((item) => {
    const size = Number(item.size);
    if (!Number.isFinite(size)) {
      throw new Error(
        `listing ${options.prefix} gave no size for ${item.name}`,
      );
    }
    return { name: item.name, size };
  });
}

/** One report inside an object: a context line and the records under it. */
export interface StoredReportGroup {
  context: RunContext | undefined;
  records: TestRecord[];
}

/**
 * One uploaded object, validated line by line. A submission object holds
 * one report; a rollup concatenates a day of them, one context line ahead
 * of each report's records. `reports` keeps that per-report grouping —
 * which is what carries provenance such as the fork flag — while `context`
 * and `records` flatten the object for consumers reading single-report
 * submissions.
 */
export interface StoredReport {
  objectName: string;
  context: RunContext | undefined;
  records: TestRecord[];
  reports: StoredReportGroup[];
}

/**
 * Parses object text into report groups: every context line starts a
 * report, and record lines belong to the report whose context most
 * recently preceded them. Record lines ahead of any context form a group
 * with no context, and lines that parse as neither are dropped.
 */
export function parseReportGroups(text: string): StoredReportGroup[] {
  const groups: StoredReportGroup[] = [];
  let current: StoredReportGroup | undefined;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const context = parseContextLine(line);
    if (context !== undefined) {
      current = { context, records: [] };
      groups.push(current);
      continue;
    }
    const record = parseRecordLine(line);
    if (record !== undefined) {
      if (current === undefined) {
        current = { context: undefined, records: [] };
        groups.push(current);
      }
      current.records.push(record);
    }
  }
  return groups;
}

/** The read URL of one object; the whole dataset is readable by anyone. */
export function objectUrl(bucket: string, objectName: string): string {
  return `https://storage.googleapis.com/${encodeURIComponent(bucket)}/${
    objectName.split("/").map(encodeURIComponent).join("/")
  }`;
}

/** Fetches and validates one object. */
export async function readObject(options: {
  bucket: string;
  objectName: string;
  fetch?: typeof fetch;
}): Promise<StoredReport> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(objectUrl(options.bucket, options.objectName));
  if (!res.ok) {
    throw new Error(
      `reading ${options.objectName} failed: HTTP ${res.status}`,
    );
  }
  const reports = parseReportGroups(await res.text());
  return {
    objectName: options.objectName,
    context: reports[0]?.context,
    records: reports.flatMap((report) => report.records),
    reports,
  };
}
