// The visual surface — a self-contained, interactive HTML explorer over the
// JSON the other commands emit. No server, no build step, no external resources:
// one file a teammate opens in a browser.
//
// Two ways to navigate, both feeding one detail pane:
//   - Tree view  — from pieces down (pattern · input · owned cells/streams),
//     children named by their role.
//   - Graph view — re-rootable from ANY node; click to select / re-root.
// The detail pane shows EVERY salient field for the selected entity: value
// (links clickable), schema, CFC (information-flow) labels, version history,
// resolved lineage (clickable), outgoing links, and module source. Entity ids
// are click-to-copy, and each piece/entity has a deep link into the live shell.

import { DID_PREFIX } from "@commonfabric/identity/did";

import type { SpaceDb } from "./db.ts";
import { type SpaceSummary, summarizeSpace } from "./queries.ts";
import { buildSpaceGraph, type SpaceGraph } from "./graph.ts";
import { spaceTimeline, type SpaceTimelineEntry } from "./timetravel.ts";
import { buildAllDetails, type EntityDetail } from "./detail.ts";
import type { ScanExtent } from "./model.ts";
import { visibleRevisionRows } from "./reconstruct.ts";
import {
  listScopes,
  type Participant,
  type Scope,
  type ScopeOverlay,
  scopeOverlay,
  spaceParticipants,
} from "./scopes.ts";
import {
  contendedEntities,
  type ContendedEntity,
  entityConflicts,
} from "./conflicts.ts";

export interface InspectorBundle {
  space: string;
  generatedAt: string;

  /** Base origin of the live shell, for deep links (`<base>/<space>/<id>`). */
  liveBase: string;

  summary: SpaceSummary;
  details: EntityDetail[];

  /** How far the entity scan behind `details` and `graph` reached. */
  extent: ScanExtent;

  graph: SpaceGraph;
  timeline: SpaceTimelineEntry[];

  /** Per-identity scopes present (space / user:<DID> / session:<DID>:*). */
  scopes: Scope[];

  /** Per-entity scope overlays — only for cells with non-space/multi-scope state. */
  overlays: ScopeOverlay[];

  /** Identities that touched this space (committers + per-user/session owners). */
  participants: Participant[];

  /** Contested entities (≥2 writer sessions); multi-user ones carry stale reads. */
  conflicts: ContendedEntity[];
}

/** Assemble everything the explorer needs from one space DB. */
export function buildInspectorBundle(
  space: SpaceDb,
  opts: {
    branch?: string;
    scope?: string;
    generatedAt?: string;
    liveBase?: string;
    limit?: number;
  } = {},
): InspectorBundle {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit;
  const did = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");

  // Entities that carry per-user/session state (in a non-space scope, or in
  // more than one scope) get a full scope overlay so the explorer can show the
  // per-identity divergence the space-scope view hides. Discovered over the
  // same branch-visible domain the tree and the scope list use — a child branch
  // inherits its parent's per-user state, and a page that named a user scope
  // while finding no cells in it would report the divergence as absent. Records
  // rather than readable entities, so an entity deleted in one scope and live
  // in another still reaches the overlay that exists to show that.
  const scoped = new Map<string, Set<string>>();
  for (const row of visibleRevisionRows(space, { branch })) {
    const scopes = scoped.get(row.id) ?? new Set<string>();
    scopes.add(row.scope);
    scoped.set(row.id, scopes);
  }
  const overlayIds = [...scoped.entries()]
    .filter(([, scopes]) =>
      scopes.size > 1 || [...scopes].some((scope) => scope !== "space")
    )
    .map(([id]) => id);
  const overlays = overlayIds.map((id) => scopeOverlay(space, id, { branch }));

  const listing = buildAllDetails(space, { branch, scope, limit });
  return {
    space: did,
    generatedAt: opts.generatedAt ?? "",
    liveBase: opts.liveBase ?? "",
    summary: summarizeSpace(space),
    details: listing.details,
    extent: listing.extent,
    graph: buildSpaceGraph(space, { branch, scope, limit }),
    timeline: spaceTimeline(space, { branch, scope }),
    scopes: listScopes(space, { branch }),
    overlays,
    participants: spaceParticipants(space, { branch }),
    conflicts: buildConflicts(space, branch, scope),
  };
}

/** Contested entities; attach stale-read analysis to the multi-user ones. */
function buildConflicts(
  space: SpaceDb,
  branch: string,
  scope: string,
): ContendedEntity[] {
  const STALE_READ_ANALYSIS_CAP = 60;
  const contended = contendedEntities(space, { branch, scope, limit: 300 });
  let analyzed = 0;
  for (const c of contended) {
    if (c.multiUser && analyzed < STALE_READ_ANALYSIS_CAP) {
      analyzed++;
      c.staleReads = entityConflicts(space, c.id, { branch, scope }).staleReads;
      c.staleReadsAnalyzed = true;
    }
    // Beyond the cap, leave staleReadsAnalyzed falsy so the UI shows "not
    // analyzed" rather than rendering an unanalyzed multi-user cell as clean.
  }
  return contended;
}

/** Embed JSON safely inside an HTML <script> block. */
function safeJson(data: unknown): string {
  // Escape `<` (blocks `</script>` breakout) and the U+2028/U+2029 line
  // terminators, which are legal in JSON strings but break a `<script>` body.
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(
      /[\u2028\u2029]/g,
      (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"),
    );
}

/**
 * Escape a string for safe interpolation into the document SHELL (title/header).
 * The bundle JSON is rendered through {@link safeJson} and all values render via
 * `textContent` in the app, but the static chrome interpolates DB/path-derived
 * strings (the space DID, op names) directly — escape them so a hostile DB or
 * file path can't inject markup into the generated standalone HTML.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root {
  --bg:#fff; --fg:#1f2937; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb;
  --accent:#2563eb; --hover:#eef2ff;
  --piece:#f59e0b; --module:#3b82f6; --stream:#ec4899; --schema:#8b5cf6;
  --owned-cell:#10b981; --free-cell:#9ca3af; --unknown:#d1d5db;
  --deleted:#71717a;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0b0f17; --fg:#e5e7eb; --muted:#9ca3af; --line:#1f2937;
    --card:#111827; --accent:#60a5fa; --hover:#1e293b; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
a { color:var(--accent); }
header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex;
  gap:16px; align-items:baseline; flex-wrap:wrap; }
header h1 { margin:0; font-size:15px; }
header .stats { color:var(--muted); font-size:12px; }
header .live { margin-left:auto; display:flex; gap:6px; align-items:center; font-size:12px; }
nav { display:flex; gap:2px; padding:0 16px; border-bottom:1px solid var(--line); }
nav button { border:0; background:none; color:var(--muted); padding:8px 14px;
  cursor:pointer; font:inherit; border-bottom:2px solid transparent; }
nav button.active { color:var(--fg); border-bottom-color:var(--accent); }
.tabwrap { display:none; } .tabwrap.active { display:block; }
.explore { display:grid; grid-template-columns:minmax(280px,360px) 1fr; height:calc(100vh - 92px); }
.navi { border-right:1px solid var(--line); overflow:auto; padding:8px; }
.navi .modebar { display:flex; gap:4px; margin-bottom:8px; }
.navi .modebar button { flex:1; padding:5px; border:1px solid var(--line);
  background:var(--card); color:var(--fg); border-radius:6px; cursor:pointer; font:inherit; }
.navi .modebar button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
.detail { overflow:auto; padding:14px 18px; }
input,select { background:var(--card); color:var(--fg); border:1px solid var(--line);
  border-radius:6px; padding:5px 8px; font:inherit; }
.kind { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; color:#fff; }
.kind.unknown { color:#111; }
.tree ul { list-style:none; margin:0; padding-left:14px; }
.tree li { padding:1px 0; }
.tree .row { cursor:pointer; padding:2px 4px; border-radius:4px; white-space:nowrap; }
.tree .row:hover { background:var(--hover); }
.tree .row.sel { background:var(--accent); color:#fff; }
.tree .tw { display:inline-block; width:12px; color:var(--muted); }
.tree .row.sel .tw { color:#fff; }
.muted { color:var(--muted); }
.copy { cursor:pointer; border:1px solid var(--line); border-radius:4px; padding:0 5px;
  background:var(--card); color:var(--muted); font-size:11px; }
.copy:hover { color:var(--fg); }
.dh { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:4px; }
.dh h2 { margin:0; font-size:16px; }
.idline { color:var(--muted); font-size:12px; display:flex; gap:6px; align-items:center;
  flex-wrap:wrap; margin-bottom:12px; word-break:break-all; }
.sec { border:1px solid var(--line); border-radius:8px; margin-bottom:10px; background:var(--card); }
.sec > summary { cursor:pointer; padding:8px 12px; font-weight:600; user-select:none; }
.sec > .body { padding:0 12px 12px; }
.kv { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; font-size:12px; }
.kv .k { color:var(--muted); }
.chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--line);
  border-radius:5px; padding:0 6px; margin:1px; cursor:pointer; background:var(--bg);
  max-width:100%; }
.chip:hover { border-color:var(--accent); }
.chip.ext { cursor:default; border-style:dashed; }
.chip .ck { font-size:10px; padding:0 3px; border-radius:3px; color:#fff; }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px;
  overflow:auto; font-size:12px; margin:6px 0; max-height:420px; }
table { border-collapse:collapse; width:100%; font-size:12px; }
th,td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); }
svg { max-width:100%; border:1px solid var(--line); border-radius:8px; background:var(--card); }
.legend { font-size:11px; color:var(--muted); margin:6px 0; display:flex; gap:12px; flex-wrap:wrap; }
.flash { position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
  background:var(--accent); color:#fff; padding:6px 12px; border-radius:6px; opacity:0;
  transition:opacity .15s; pointer-events:none; }
.flash.on { opacity:1; }
.jlink { color:var(--accent); cursor:pointer; text-decoration:underline; }
.jstream { color:var(--stream); }
.scopevar { border-left:2px solid var(--accent); padding-left:8px; margin:6px 0; }
`;

const APP = String.raw`
const B = JSON.parse(document.getElementById("bundle").textContent);
const KC = { piece:"var(--piece)", module:"var(--module)", stream:"var(--stream)",
  schema:"var(--schema)", "owned-cell":"var(--owned-cell)", "free-cell":"var(--free-cell)", unknown:"var(--unknown)", deleted:"var(--deleted)" };
const EC = { pattern:"#2563eb", argument:"#16a34a", owns:"#6b7280", link:"#9ca3af" };
const byId = new Map(B.details.map(d => [d.id, d]));
const overlayById = new Map((B.overlays||[]).map(o => [o.id, o]));
const conflictById = new Map((B.conflicts||[]).map(c => [c.id, c]));
// Per-user/session-only cells aren't in the space-scope details; synthesize
// lightweight, selectable entries so they're visible + their overlay shows.
for (const o of (B.overlays||[])) {
  if (byId.has(o.id)) continue;
  const v = o.variants[0] || {};
  byId.set(o.id, { id:o.id, kind:"free-cell", label:"⚑ "+(v.summary||"scoped cell"),
    role:(v.kind||"")+" cell", regime:"n/a", owned:false, paths:["value"],
    valueShape:"", value:v.value, valuePreview:v.summary, schemaKeys:null,
    revisions:v.revisions||0, headSeq:null, firstSeq:null, versions:[],
    lineage:{}, outLinks:[], synthetic:true });
}
const $ = (s,r=document) => r.querySelector(s);
const $$ = (s,r=document) => [...r.querySelectorAll(s)];
function el(t, props={}, kids=[]) {
  const n = document.createElement(t);
  for (const [k,v] of Object.entries(props)) {
    if (v==null) continue;
    if (k==="class") n.className=v; else if (k==="text") n.textContent=v;
    else if (k==="html") n.innerHTML=v; else if (k[0]==="o"&&k[1]==="n") n[k]=v;
    else n.setAttribute(k,v);
  }
  for (const c of [].concat(kids)) if (c!=null && c!=="") n.append(c);
  return n;
}
// This page ships as one standalone file with no imports, so the DID rule is
// restated here against the prefix the build injects.
const DID_PREFIX = ${JSON.stringify(DID_PREFIX)};
const didTail = d => { d = d || "";
  if (!d.startsWith(DID_PREFIX)) return d;
  const rest = d.slice(DID_PREFIX.length), colon = rest.indexOf(":");
  return colon === -1 || colon === rest.length-1 ? d : rest.slice(colon+1); };
const shortDid = d => { d=didTail(d); return d.length>14?d.slice(0,8)+"…"+d.slice(-4):d; };
const shortId = id => { const b = id.replace(/^of:/,"");
  return b.length>22 ? b.slice(0,12)+"…"+b.slice(-6) : b; };
function flash(msg){ const f=$("#flash"); f.textContent=msg; f.classList.add("on");
  setTimeout(()=>f.classList.remove("on"),900); }
function copyBtn(text, label){ return el("button",{class:"copy",title:"copy "+text,
  onclick:e=>{e.stopPropagation(); navigator.clipboard?.writeText(text); flash("copied "+(label||"id"));}}, label||"copy"); }
function kindChip(kind){ return el("span",{class:"kind "+kind,style:"background:"+(KC[kind]||"#999"),text:kind}); }

//
// live shell link
//

let LIVE = localStorage.getItem("si-live") || B.liveBase || "";
function liveUrl(id){ if(!LIVE) return null;
  // The shell navigates by the bare id form (fid1:…); the stored "of:" prefix
  // makes it parse the segment as raw base64 and throw. Strip it.
  const base = LIVE.replace(/\/+$/,""); return base+"/"+B.space+"/"+id.replace(/^of:/,""); }
function liveAnchor(id){ const u = liveUrl(id); return u
  ? el("a",{href:u,target:"_blank",rel:"noopener",text:"open in app ↗",title:u})
  : el("span",{class:"muted",text:"(set app URL ↗ to enable live links)"}); }

//
// selection + history
//

let cur = null; const hist = [];
function select(id, push=true){
  if(!byId.has(id)) return;
  if(push && cur && cur!==id) hist.push(cur);
  cur = id;
  renderDetail(id);
  $$(".tree .row").forEach(r => r.classList.toggle("sel", r.dataset.id===id));
  const sel = $(".tree .row.sel"); if(sel) sel.scrollIntoView({block:"nearest"});
  const gsel = $("#graph-root"); if(gsel && gsel.value!==id && byId.get(id)) { /* keep */ }
}
function back(){ const id = hist.pop(); if(id){ cur=null; select(id,false); } }

//
// value renderer (links become clickable chips)
//

function valueDom(v, depth=0){
  if(v===null) return el("span",{class:"muted",text:"null"});
  if(typeof v!=="object") return el("span",{text: typeof v==="string" ? JSON.stringify(v) : String(v)});
  if(v.$link){ return linkInline(v.$link); }
  if(v.$ref){ return el("span",{class:"jlink",text:"#"+shortId(v.$ref),onclick:()=>select(v.$ref)}); }
  if(typeof v==="string") return el("span",{text:JSON.stringify(v)});
  if(Array.isArray(v)){
    if(!v.length) return el("span",{text:"[]"});
    if(depth>4) return el("span",{class:"muted",text:"[…"+v.length+"]"});
    const ul = el("ul",{style:"margin:0;padding-left:16px;list-style:none"});
    v.slice(0,200).forEach(x => ul.append(el("li",{},valueDom(x,depth+1))));
    if(v.length>200) ul.append(el("li",{class:"muted",text:"… "+(v.length-200)+" more"}));
    return ul;
  }
  if(v==="$stream"||v===null) return el("span",{class:"jstream",text:"⊙ stream"});
  const keys = Object.keys(v);
  if(!keys.length) return el("span",{text:"{}"});
  if(depth>4) return el("span",{class:"muted",text:"{"+keys.join(", ")+"}"});
  const ul = el("ul",{style:"margin:0;padding-left:16px;list-style:none"});
  for(const k of keys){
    ul.append(el("li",{},[el("span",{class:"muted",text:k+": "}), valueDom(v[k],depth+1)]));
  }
  return ul;
}
function linkInline(link){
  const d = link.id && byId.get(link.id);
  const label = d ? d.label : (link.id ? shortId(link.id) : "link");
  const span = el("span",{class: d?"jlink":"", text:"🔗 "+label + (link.path&&link.path.length?"/"+link.path.join("/"):"")});
  if(d) span.onclick = ()=>select(link.id);
  else if(link.space) span.title = link.id+" @"+link.space;
  return span;
}
function linkChip(ref){
  const ext = ref.external || !byId.has(ref.id);
  const c = el("span",{class:"chip"+(ext?" ext":""), title:ref.id+(ref.space?" @"+ref.space:"")},[
    ref.kind ? el("span",{class:"ck",style:"background:"+(KC[ref.kind]||"#999"),text:ref.kind.replace("-cell","")}) : "",
    el("span",{text: ref.label || shortId(ref.id)}),
    ref.at ? el("span",{class:"muted",text:"@"+ref.at}) : "",
    ext && ref.space ? el("span",{class:"muted",text:"⇗"+shortId(ref.space)}) : "",
  ]);
  if(!ext) c.onclick = ()=>select(ref.id);
  return c;
}

//
// detail pane
//

function section(title, openByDefault, bodyNodes){
  const d = el("details",{class:"sec"}); if(openByDefault) d.setAttribute("open","");
  d.append(el("summary",{text:title}));
  d.append(el("div",{class:"body"}, bodyNodes));
  return d;
}
function renderDetail(id){
  const d = byId.get(id); const host = $("#detail"); host.innerHTML="";
  if(!d){ host.append(el("p",{class:"muted",text:"select an entity"})); return; }
  // header
  host.append(el("div",{class:"dh"},[
    hist.length ? el("button",{class:"copy",onclick:back,text:"← back"}) : "",
    kindChip(d.kind),
    el("h2",{text:d.label}),
    el("span",{class:"muted",text:d.role}),
  ]));
  host.append(el("div",{class:"idline"},[
    el("span",{text:d.id}), copyBtn(d.id,"id"), el("span",{text:"·"}), liveAnchor(d.id),
  ]));

  // identity
  const idkv = el("div",{class:"kv"});
  const addkv=(k,v)=>{ idkv.append(el("span",{class:"k",text:k})); idkv.append(v.nodeType?v:el("span",{text:String(v)})); };
  addkv("kind", d.kind+(d.regime!=="n/a"?" ("+d.regime+")":""));
  addkv("owned", d.owned ? "yes — "+(d.contextName?("as "+d.contextName):"owned by a piece") : "no (free)");
  addkv("paths", d.paths.join(", "));
  addkv("version", "rev "+d.revisions+(d.headSeq!=null?" · head seq "+d.headSeq:"")+(d.firstSeq!=null?" · born seq "+d.firstSeq:""));
  host.append(section("Identity", true, idkv));

  // lineage
  const L=d.lineage; const lin=[];
  if(L.pattern){ lin.push(el("div",{},[el("span",{class:"k muted",text:"pattern  "}),
    linkChip(L.pattern), el("span",{class:"muted",text:" "+(L.pattern.filename||"")+(L.pattern.symbol?" · "+L.pattern.symbol:"")+(L.pattern.codeLines?" · "+L.pattern.codeLines+" lines":"")})])); }
  if(L.argument){ lin.push(el("div",{},[el("span",{class:"k muted",text:"input    "}), linkChip(L.argument)])); }
  if(L.result){ lin.push(el("div",{},[el("span",{class:"k muted",text:"result   "}), linkChip(L.result)])); }
  if(L.owner){ lin.push(el("div",{},[el("span",{class:"k muted",text:"owner    "}), linkChip(L.owner)])); }
  if(L.internal&&L.internal.length){ const wrap=el("div",{},[el("span",{class:"k muted",text:"owns ("+L.internal.length+")  "})]);
    L.internal.forEach(r=>wrap.append(linkChip(r))); lin.push(wrap); }
  if(lin.length) host.append(section("Lineage", true, lin));

  // value
  host.append(section("Value  ("+d.valueShape+")", d.kind!=="module", [valueDom(d.value)]));

  // scopes (per-identity overlay) — what each identity sees for this cell
  const ov = overlayById.get(id);
  if (ov && ov.variants.length) {
    const body=[];
    body.push(el("div",{class:"muted",text:
      ov.overridden ? (ov.divergent ? ov.variants.length+" scopes · DIVERGENT — identities see different values"
        : ov.variants.length+" scopes · identical") : "single scope"}));
    for (const v of ov.variants) {
      const who = v.kind==="space" ? "space (shared)"
        : v.kind==="user" ? "user "+shortDid(v.principal||"?")
        : v.kind==="session" ? "session "+shortDid(v.principal||"?")+"/"+(v.sessionId||"").slice(0,8)
        : v.scope;
      body.push(el("div",{class:"scopevar"},[
        el("div",{class:"k",style:"color:var(--accent)",text:who+"  ·  "+v.revisions+" rev"}),
        valueDom(v.value),
      ]));
    }
    host.append(section("Scopes — view as identity"+(ov.divergent?" ⚑":""), true, body));
  }

  // contention / conflicts — who fought over this cell
  const cf = conflictById.get(id);
  if (cf){
    const body=[];
    body.push(el("div",{class:"muted",text:
      cf.writes+" writes by "+cf.principals+" identit"+(cf.principals===1?"y":"ies")+" / "+cf.sessions+" sessions"
      +(cf.multiUser?" · MULTI-USER":" · single-user (multi-session)")+(cf.interleaved?" · interleaved":"")}));
    for(const w of cf.writers){
      body.push(el("div",{class:"scopevar",style:"border-color:var(--stream)"},[
        el("span",{class:"k",text:"seq "+w.seq+"  "+w.op+"  "}),
        el("span",{class: w.principal&&byId.get(w.principal)?"":"muted",text:fmtSession(w.session)}),
        el("span",{class:"muted",text:"  "+w.createdAt}),
      ]));
    }
    if(cf.staleReads&&cf.staleReads.length){
      body.push(el("div",{style:"margin-top:6px;color:var(--stream)",text:"⚠ ANOMALOUS stale reads — the engine rejects these before commit; a hit means an invariant violation, not normal history:"}));
      for(const sr of cf.staleReads){
        body.push(el("div",{class:"muted",style:"font-size:12px",text:
          "commit #"+sr.readerCommitSeq+" by "+fmtSession(sr.readerSession)+" read @"+sr.readAtSeq
          +" but missed "+(sr.missedWriteOp||"write")+" @"+sr.missedWriteSeq+" by "+fmtSession(sr.missedWriteSession)
          +(sr.readerAlsoWrote?" — then wrote":"")}));
      }
    } else if(cf.multiUser && !cf.staleReadsAnalyzed){
      // Distinguish "analysis skipped (cap)" from "analyzed → clean".
      body.push(el("div",{class:"muted",style:"margin-top:6px;font-size:12px",text:"stale-read analysis skipped (per-bundle cap) — run 'cf inspect conflicts <space> "+shortId(cf.id)+"' for this cell"}));
    }
    const cfTag = (cf.staleReads&&cf.staleReads.length)?" · ⚠ anomaly":((cf.multiUser&&!cf.staleReadsAnalyzed)?" · ? not analyzed":"");
    host.append(section("Contention"+(cf.multiUser?" ⚔ MULTI-USER":"")+cfTag, cf.multiUser, body));
  }

  // schema (a stream's payload schema is resolved from its owner piece)
  if(d.schema!==undefined){
    const title=(d.streamPayload?"Stream payload schema":"Schema")
      +(d.schemaKeys&&d.schemaKeys.length?"  {"+d.schemaKeys.join(", ")+"}":"")
      +(d.schemaSource?"  ·  "+d.schemaSource:"");
    host.append(section(title, d.streamPayload||d.kind!=="module",
      [el("pre",{text:JSON.stringify(d.schema,null,2)})]));
  }
  // ifc (schema-as-value)
  if(d.ifc!==undefined){
    host.append(section("IFC (information-flow on this schema)", true,
      [el("pre",{text:JSON.stringify(d.ifc,null,2)})]));
  }
  // cfc
  if(d.cfc){
    const body=[];
    if(d.cfc.schemaHash) body.push(el("div",{class:"muted",text:"schemaHash: "+d.cfc.schemaHash}));
    if(d.cfc.entries.length){
      const tb=el("tbody");
      d.cfc.entries.forEach(e=>tb.append(el("tr",{},[
        el("td",{text:e.path||"(root)"}),
        el("td",{text:e.unresolved?"(label document not read)":(e.confidentiality.join(", ")||"—")}),
        el("td",{text:e.unresolved?"(label document not read)":(e.integrity.join(", ")||"—")}),
        el("td",{class:"muted",text:e.origin||""}),
      ])));
      body.push(el("table",{},[el("thead",{},el("tr",{},[
        el("th",{text:"path"}),el("th",{text:"confidentiality"}),el("th",{text:"integrity"}),el("th",{text:"origin"})])),tb]));
    }
    host.append(section("CFC (information-flow labels)", true, body));
  }
  // outgoing links
  if(d.outLinks.length){
    const wrap=el("div",{}); d.outLinks.forEach(r=>wrap.append(linkChip(r)));
    host.append(section("Links out ("+d.outLinks.length+")", false, wrap));
  }
  // module source
  if(d.code){
    host.append(section("Source ("+d.code.split("\n").length+" lines)", false,
      [el("pre",{text:d.code})]));
  }
  // version log
  const vt=el("tbody");
  d.versions.slice(-60).reverse().forEach(v=>vt.append(el("tr",{},[
    el("td",{text:"#"+v.seq}), el("td",{text:v.op}),
    el("td",{class:"muted",text:fmtSession(v.session)}), el("td",{class:"muted",text:v.createdAt})])));
  host.append(section("Version history ("+d.versions.length+" writes)", false,
    [el("table",{},[el("thead",{},el("tr",{},[el("th",{text:"seq"}),el("th",{text:"op"}),el("th",{text:"who"}),el("th",{text:"when"})])),vt])]));
}
// Mirrors parseScope in scopes.ts: split before decoding, and the principal
// has to come out a DID.
function fmtSession(s){
  const parts = (s||"").split(":"), decode = p => { try { return decodeURIComponent(p); } catch { return p; } };
  if (parts[0]==="session" && parts.length>=3) {
    const [principal, session] = parts.length===3
      ? [decode(parts[1]), decode(parts[2])]
      : [parts.slice(1,4).join(":"), parts.slice(4).join(":")];
    if (principal.startsWith(DID_PREFIX)) {
      const t = didTail(principal);
      return (t.length>12?t.slice(0,6)+"…"+t.slice(-4):t)+"/"+session.slice(0,6);
    }
  }
  try { s = decodeURIComponent(s); } catch {}
  return s.slice(0,18); }

//
// tree view
//

function treeRow(d, childInfo){
  const ov = overlayById.get(d.id);
  const cf = conflictById.get(d.id);
  const mark = (ov ? (ov.divergent ? " ⚑" : " ◐") : "") + (cf && cf.multiUser ? " ⚔" : "");
  const r = el("div",{class:"row","data-id":d.id, onclick:()=>select(d.id),
    title: ov ? (ov.divergent?"per-identity divergence":"per-identity scope") : ""},[
    el("span",{class:"tw",text:childInfo?"▸":"·"}),
    el("span",{class:"dot",style:"background:"+(KC[d.kind]||"#999")}),
    el("span",{text:" "+d.label}),
    mark ? el("span",{style:"color:var(--stream)",text:mark}) : "",
    childInfo ? el("span",{class:"muted",text:" "+childInfo}) : "",
  ]);
  return r;
}
function renderTree(){
  const host=$("#tree"); host.innerHTML="";
  const pieces = B.details.filter(d=>d.kind==="piece");
  const ul = el("ul",{});
  for(const p of pieces){
    const li = el("li",{});
    const kids = el("ul",{style:"display:none"});
    const childIds = [];
    if(p.lineage.pattern) childIds.push(["pattern",p.lineage.pattern.id]);
    if(p.lineage.argument) childIds.push(["input",p.lineage.argument.id]);
    (p.lineage.internal||[]).forEach(r=>childIds.push(["owns",r.id]));
    const row = treeRow(p, childIds.length?("("+childIds.length+")"):"");
    row.querySelector(".tw").onclick=(e)=>{ e.stopPropagation();
      kids.style.display = kids.style.display==="none"?"block":"none";
      row.querySelector(".tw").textContent = kids.style.display==="none"?"▸":"▾"; };
    for(const [role,cid] of childIds){
      const cd = byId.get(cid); if(!cd) continue;
      const cr = treeRow(cd, ""); cr.querySelector(".tw").textContent="";
      cr.prepend(el("span",{class:"muted",text:role+" "}));
      kids.append(el("li",{},cr));
    }
    li.append(row, kids);
    ul.append(li);
  }
  // entities with no piece-root (free cells, orphan modules) under a folder
  const owned = new Set();
  for(const p of pieces){ if(p.lineage.pattern)owned.add(p.lineage.pattern.id);
    if(p.lineage.argument)owned.add(p.lineage.argument.id);
    (p.lineage.internal||[]).forEach(r=>owned.add(r.id)); owned.add(p.id); }
  const rest = B.details.filter(d=>!owned.has(d.id));
  if(rest.length){
    const li=el("li",{}); const kids=el("ul",{style:"display:none"});
    const row=treeRow({kind:"unknown",label:"other entities",id:"__rest"}, "("+rest.length+")");
    row.dataset.id=""; row.onclick=null;
    row.querySelector(".tw").textContent="▸";
    row.onclick=()=>{ kids.style.display=kids.style.display==="none"?"block":"none";
      row.querySelector(".tw").textContent=kids.style.display==="none"?"▸":"▾"; };
    rest.forEach(d=>{ const cr=treeRow(d,""); cr.querySelector(".tw").textContent=""; kids.append(el("li",{},cr)); });
    li.append(row,kids); ul.append(li);
  }
  host.append(ul);
}

//
// graph view
//

function neighborhood(rootId, depth){
  const adj=new Map();
  for(const e of B.graph.edges){ (adj.get(e.from)??adj.set(e.from,[]).get(e.from)).push(e.to);
    (adj.get(e.to)??adj.set(e.to,[]).get(e.to)).push(e.from); }
  const dist=new Map([[rootId,0]]); let fr=[rootId];
  for(let i=0;i<depth;i++){ const nx=[]; for(const n of fr) for(const m of (adj.get(n)||[]))
    if(!dist.has(m)){dist.set(m,i+1);nx.push(m);} fr=nx; }
  return { nodes:B.graph.nodes.filter(n=>dist.has(n.id)),
    edges:B.graph.edges.filter(e=>dist.has(e.from)&&dist.has(e.to)), dist };
}
function layoutGraph(rootId){
  const depth=+$("#g-depth").value; const {nodes,edges,dist}=neighborhood(rootId,depth);
  const ns="http://www.w3.org/2000/svg";
  const byLayer=new Map(); for(const n of nodes){const d=dist.get(n.id);(byLayer.get(d)??byLayer.set(d,[]).get(d)).push(n);}
  const colW=240,padX=20,padY=24;
  const H=Math.max(...[...byLayer.values()].map(a=>a.length),1)*52+padY*2, W=byLayer.size*colW+padX*2;
  const pos=new Map();
  for(const [d,arr] of byLayer) arr.forEach((n,i)=>pos.set(n.id,{x:padX+d*colW+60,y:padY+(i+0.5)*(H-2*padY)/arr.length}));
  const mk=(t,a,k=[])=>{const e=document.createElementNS(ns,t);for(const[k2,v]of Object.entries(a))e.setAttribute(k2,v);for(const c of [].concat(k))e.append(c);return e;};
  const svg=mk("svg",{viewBox:"0 0 "+W+" "+H,width:W});
  for(const e of edges){const a=pos.get(e.from),b=pos.get(e.to);if(!a||!b)continue;
    svg.append(mk("line",{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:EC[e.kind]||"#999",
      "stroke-width":e.kind==="pattern"?"2":"1","stroke-dasharray":e.kind==="link"?"4 3":""}));}
  for(const n of nodes){const p=pos.get(n.id);const root=n.id===rootId;
    const g=mk("g",{style:"cursor:pointer"});
    g.append(mk("circle",{cx:p.x,cy:p.y,r:root?"8":"6",fill:KC[n.kind]||"#999",
      stroke:root?"var(--fg)":"none","stroke-width":"2"}));
    const lab=(n.label.length>22?n.label.slice(0,21)+"…":n.label);
    g.append(mk("text",{x:p.x+11,y:p.y+4,"font-size":"10",fill:"var(--fg)"},document.createTextNode(lab)));
    g.onclick=()=>{ select(n.id); if(byId.has(n.id)){ $("#g-root").value=n.id; } };
    g.ondblclick=()=>{ $("#g-root").value=n.id; layoutGraph(n.id); };
    svg.append(g);}
  const c=$("#g-canvas"); c.innerHTML=""; c.append(svg);
}
function renderGraph(){
  const sel=$("#g-root"); if(sel.options.length===0){
    B.graph.nodes.filter(n=>n.present!==false).forEach(n=>sel.append(el("option",{value:n.id,text:n.kind+": "+n.label})));
  }
  if(cur && byId.has(cur)) sel.value=cur;
  if(sel.value) layoutGraph(sel.value);
}

//
// timeline
//

function renderTimeline(){
  const t=B.timeline; const host=$("#tl"); host.innerHTML="";
  if(!t.length){host.append(el("p",{class:"muted",text:"(no commits)"}));return;}
  const W=820,H=150,pad=24,maxc=Math.max(...t.map(e=>e.cumulativeEntities),1);
  const x=i=>pad+(W-2*pad)*(t.length<2?0:i/(t.length-1)), y=v=>H-pad-(H-2*pad)*(v/maxc);
  let p=""; t.forEach((e,i)=>p+=(i?" L":"M")+x(i).toFixed(1)+" "+y(e.cumulativeEntities).toFixed(1));
  const ns="http://www.w3.org/2000/svg",mk=(t2,a)=>{const n=document.createElementNS(ns,t2);for(const[k,v]of Object.entries(a))n.setAttribute(k,v);return n;};
  const svg=mk("svg",{viewBox:"0 0 "+W+" "+H,width:W});
  svg.append(mk("path",{d:p,fill:"none",stroke:"var(--accent)","stroke-width":"2"}));
  t.forEach((e,i)=>{if(e.created>0)svg.append(mk("circle",{cx:x(i),cy:y(e.cumulativeEntities),r:"2.5",fill:"var(--accent)"}));});
  host.append(svg, el("p",{class:"muted",text:t.length+" commits · "+maxc+" entities at head"}));
  const tb=el("tbody");
  t.slice(-50).reverse().forEach(e=>tb.append(el("tr",{},[
    el("td",{text:"#"+e.commitSeq}),el("td",{text:"+"+e.created}),el("td",{text:String(e.touched)}),
    el("td",{text:"Σ"+e.cumulativeEntities}),el("td",{class:"muted",text:fmtSession(e.session)}),el("td",{class:"muted",text:e.createdAt})])));
  host.append(el("table",{},[el("thead",{},el("tr",{},[el("th",{text:"commit"}),el("th",{text:"new"}),
    el("th",{text:"touched"}),el("th",{text:"total"}),el("th",{text:"who"}),el("th",{text:"when"})])),tb]));
}

//
// wiring
//

for(const b of $$("nav button")) b.onclick=()=>{
  $$("nav button").forEach(x=>x.classList.toggle("active",x===b));
  $$(".tabwrap").forEach(s=>s.classList.toggle("active",s.id===b.dataset.tab));
  if(b.dataset.tab==="explore"){ if($("#mode-graph").classList.contains("active")) renderGraph(); }
  if(b.dataset.tab==="timeline") renderTimeline();
};
$("#mode-tree").onclick=()=>{ $("#mode-tree").classList.add("active"); $("#mode-graph").classList.remove("active");
  $("#tree").style.display="block"; $("#gpane").style.display="none"; };
$("#mode-graph").onclick=()=>{ $("#mode-graph").classList.add("active"); $("#mode-tree").classList.remove("active");
  $("#tree").style.display="none"; $("#gpane").style.display="block"; renderGraph(); };
$("#g-root").onchange=e=>{ select(e.target.value); layoutGraph(e.target.value); };
$("#g-depth").onchange=()=>{ if($("#g-root").value) layoutGraph($("#g-root").value); };
const liveInput=$("#live-input"); liveInput.value=LIVE;
liveInput.onchange=()=>{ LIVE=liveInput.value.trim(); localStorage.setItem("si-live",LIVE);
  if(cur) renderDetail(cur); flash(LIVE?"live links on":"live links off"); };
$("#copy-space").onclick=()=>{ navigator.clipboard?.writeText(B.space); flash("copied space DID"); };

//
// identities (users of this space)
//

function renderIdentities(){
  const host=$("#idlist"); const ps=B.participants||[];
  $("#idpanel>summary").textContent="Identities ("+ps.length+")";
  if(!ps.length){ host.append(el("div",{class:"muted",text:"(no identifiable users — bare sessions)"})); return; }
  for(const p of ps){
    const cells=(B.overlays||[]).filter(o=>o.variants.some(v=>v.principal===p.did));
    host.append(el("div",{style:"margin:5px 0"},[
      el("div",{},[
        el("span",{text:(p.isOwner?"★ ":"· ")+shortDid(p.did)}), copyBtn(p.did,"DID"),
        el("span",{class:"muted",text:" commits="+p.commits+" sessions="+p.sessions+(p.userEntities?" user-cells="+p.userEntities:"")+(p.isOwner?" (owner home)":"")}),
      ]),
      ...(cells.length?[el("div",{style:"padding-left:14px"},
        cells.slice(0,25).map(o=>{ const d=byId.get(o.id);
          return el("div",{class:"jlink",style:"font-size:12px",text:"• "+(d?d.label:shortId(o.id)),onclick:()=>select(o.id)}); }))]:[]),
    ]));
  }
  host.append(el("div",{class:"muted",style:"margin-top:6px",text:"cross-space (home + profiles): cf inspect identity <DID>"}));
}
//
// conflicts (contested cells)
//

function renderConflicts(){
  const host=$("#cflist"); const cs=B.conflicts||[];
  const mu=cs.filter(c=>c.multiUser).length;
  $("#cfpanel>summary").textContent="Conflicts ("+cs.length+(mu?", "+mu+" ⚔":"")+")";
  if(!cs.length){ host.append(el("div",{class:"muted",text:"(no contested cells)"})); return; }
  for(const c of cs.slice(0,150)){
    const d=byId.get(c.id);
    const stale=(c.staleReads&&c.staleReads.length)?" · "+c.staleReads.length+" stale":"";
    host.append(el("div",{class:"row",onclick:()=>select(c.id),style:"white-space:normal"},[
      el("span",{text:(c.multiUser?"⚔ ":"· ")}),
      el("span",{class:"jlink",text:d?d.label:shortId(c.id)}),
      el("span",{class:"muted",text:"  "+c.principals+"u/"+c.sessions+"s · "+c.writes+"w"+(c.multiUser?" MULTI-USER":"")+stale}),
    ]));
  }
  host.append(el("div",{class:"muted",style:"margin-top:6px",text:"⚔ = ≥2 identities (real contention); stale = lost-update risk"}));
}
renderIdentities();
renderConflicts();
renderTree();
const firstPiece=B.details.find(d=>d.kind==="piece")||B.details[0];
if(firstPiece) select(firstPiece.id);
`;

/** Render the self-contained HTML explorer for a bundle. */
export function renderInspectorHtml(bundle: InspectorBundle): string {
  const s = bundle.summary;
  const opsLine = Object.entries(s.ops).map(([k, v]) => `${k}=${v}`).join(" ");
  const identities = bundle.scopes.filter((x) => x.kind !== "space");
  const idLine = identities.length
    ? `${identities.length} identity scope(s) · ${bundle.overlays.length} per-user/session cell(s)` +
      ` · ${bundle.overlays.filter((o) => o.divergent).length} divergent ⚑`
    : "single-scope (no per-user/session state)";
  // Distinct other spaces this space links to (cross-space surface).
  const linkedSpaces = new Set(
    bundle.graph.edges.filter((e) => e.external && e.to).map((e) =>
      bundle.graph.nodes.find((n) => n.id === e.to)?.space
    ).filter(Boolean),
  );
  const xLine = linkedSpaces.size
    ? ` · links to ${linkedSpaces.size} other space(s)`
    : "";
  const multiUser = bundle.conflicts.filter((c) => c.multiUser).length;
  const cfLine = bundle.conflicts.length
    ? ` · ${bundle.conflicts.length} contested${
      multiUser ? `, ${multiUser} multi-user ⚔` : ""
    }`
    : "";
  // The header's entity count is the whole space, while the tree and graph hold
  // only what the scan reached. Say so, or the two read as one number.
  //
  // Both kinds of shortfall have to appear ON THE PAGE. A capped or partial
  // explorer is a FILE — opened days later, shared with someone who never ran
  // the command — so the notice `cf` wrote to stderr at generation time is not
  // there to be read, and this banner is the only thing that survives.
  const warnings: string[] = [];
  if (bundle.extent.truncated) {
    warnings.push(
      `⚠ capped at ${bundle.extent.limit} of ${bundle.extent.total} entities · rebuild with a higher --limit for the rest`,
    );
  }
  if (bundle.extent.unreadable > 0) {
    // Named apart from the cap: a higher limit does not recover an entity whose
    // stored payload will not decode.
    warnings.push(
      `⚠ ${bundle.extent.unreadable} of ${bundle.extent.total} entities could not be reconstructed and are missing below · a higher --limit will not recover them`,
    );
  }
  const capLine = warnings
    .map((text) =>
      `<span class="stats" style="color:var(--piece)">${
        escapeHtml(text)
      }</span>`
    )
    .join("\n  ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>state-inspector · ${escapeHtml(bundle.space)}</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>state-inspector</h1>
  <span class="stats">${
    escapeHtml(bundle.space.slice(0, 24))
  }… <button class="copy" id="copy-space">copy DID</button></span>
  <span class="stats">${s.entities} entities · ${s.commits} commits · ${s.sessions} sessions · ops ${
    escapeHtml(opsLine)
  }${bundle.generatedAt ? ` · ${bundle.generatedAt.slice(0, 10)}` : ""}</span>
  <span class="stats" style="color:var(--stream)">${idLine}${xLine}${cfLine}</span>
  ${capLine}
  <span class="live">app URL <input id="live-input" placeholder="https://host (for live links)" size="22"></span>
</header>
<nav>
  <button class="active" data-tab="explore">Explore</button>
  <button data-tab="timeline">Timeline</button>
</nav>
<div id="explore" class="tabwrap active">
  <div class="explore">
    <div class="navi">
      <details id="idpanel" class="sec" style="margin-bottom:8px"><summary>Identities</summary>
        <div class="body" id="idlist"></div></details>
      <details id="cfpanel" class="sec" style="margin-bottom:8px"><summary>Conflicts</summary>
        <div class="body" id="cflist"></div></details>
      <div class="modebar">
        <button id="mode-tree" class="active">Tree</button>
        <button id="mode-graph">Graph</button>
      </div>
      <div id="tree" class="tree"></div>
      <div id="gpane" style="display:none">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
          <label class="muted">root</label>
          <select id="g-root" style="max-width:180px"></select>
          <label class="muted">depth</label>
          <select id="g-depth"><option>1</option><option selected>2</option><option>3</option></select>
        </div>
        <div class="legend">
          <span style="color:#2563eb">●pattern</span><span style="color:#16a34a">●argument</span>
          <span style="color:#6b7280">●owns</span><span style="color:#9ca3af">●link</span>
          <span class="muted">click=open · dbl-click=re-root</span>
        </div>
        <div id="g-canvas"></div>
      </div>
    </div>
    <div id="detail" class="detail"></div>
  </div>
</div>
<div id="timeline" class="tabwrap"><div id="tl" style="padding:14px 18px"></div></div>
<div id="flash" class="flash"></div>
<script id="bundle" type="application/json">${safeJson(bundle)}</script>
<script>${APP}</script>
</body></html>`;
}
