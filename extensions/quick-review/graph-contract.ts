/** Versioned, bounded contract for progressive project graphs. */

import { createHash } from "node:crypto";
import { LINE_RANGE, SAFE_PATH, SHA } from "./contract.ts";

export const GRAPH_ARTIFACT_VERSION = 1;
export const GRAPH_STATE_VERSION = 2;
export const GRAPH_COMPLETION_VERSION = 2;

export const GRAPH_LIMITS = {
  artifact: 256 * 1024,
  delta: 64 * 1024,
  state: 512 * 1024,
  nodes: 160,
  deltaNodes: 32,
  edges: 320,
  deltaEdges: 64,
  roots: 16,
  depth: 6,
  evidence: 8,
  code: 16 * 1024,
  inventory: 128 * 1024,
  inventoryFiles: 600,
  title: 160,
  summary: 4096,
} as const;

export const GRAPH_NODE_ID = /^[a-z0-9]+(?:[-.:][a-z0-9]+)*$/;
const NODE_KINDS = [
  "project",
  "component",
  "module",
  "boundary",
  "data",
  "flow",
  "symbol",
  "code",
  "decompiler",
  "test",
] as const;
const CONFIDENCE = ["confirmed", "inferred"] as const;
const OVERLAYS = [
  "unchanged",
  "added",
  "modified",
  "deleted",
  "impacted",
  "context",
] as const;
const EDGE_KINDS = [
  "contains",
  "calls",
  "reads",
  "writes",
  "emits",
  "depends-on",
  "implements",
  "tests",
  "flows-to",
] as const;

export type GraphScope = "head" | "diff";
export type GraphConfidence = (typeof CONFIDENCE)[number];
export type GraphOverlay = (typeof OVERLAYS)[number];
export type GraphNodeKind = (typeof NODE_KINDS)[number];
export type GraphEdgeKind = (typeof EDGE_KINDS)[number];

export interface GraphEvidence {
  file: string;
  lines: string;
  revision: string;
  confidence: GraphConfidence;
}

export interface GraphNode {
  id: string;
  parentId: string | null;
  kind: GraphNodeKind;
  title: string;
  summary: string;
  confidence: GraphConfidence;
  overlay: GraphOverlay;
  expandable: boolean;
  file?: string;
  lines?: string;
  language?: string;
  code?: string;
  evidence: GraphEvidence[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  confidence: GraphConfidence;
  label?: string;
}

export interface GuidanceSource {
  path: string;
  kind: "context" | "skill" | "host";
}

export interface ProjectGraph {
  version: number;
  title: string;
  summary: string;
  scope: GraphScope;
  revision: string;
  baseRevision: string;
  roots: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  guidance: GuidanceSource[];
  identity: string;
  source: string;
}

export interface GraphDelta {
  version: number;
  revision: string;
  parentId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphQuestion {
  nodeId: string;
  question: string;
  answer: string;
}

export type GraphCommentDelivery =
  | "draft"
  | "queued"
  | "active"
  | "answered"
  | "failed"
  | "superseded";

export interface GraphComment {
  id: string;
  nodeId: string;
  file: string;
  lines: string;
  body: string;
  delivery: GraphCommentDelivery;
  response: string;
}

export interface GraphState {
  version: number;
  identity: string;
  revision: string;
  baseRevision: string;
  deltas: GraphDelta[];
  viewed: Record<string, boolean>;
  questions: GraphQuestion[];
  comments: GraphComment[];
  outcome: "open" | "approved" | "changes-requested" | "commented";
}

export interface GraphCompletionEvent {
  version: number;
  outcome: "approved" | "changes-requested" | "commented";
  scope: GraphScope;
  repository: string;
  baseRef: string;
  targetRef: string;
  baseRevision: string;
  revision: string;
  identity: string;
  nodes: number;
  comments: Array<Omit<GraphComment, "id">>;
  overallComment: string;
  questions: GraphQuestion[];
  artifact: string;
  state: string;
  completedAt: string;
}

export const GRAPH_COMPLETION_EVENT = "quick-review:graph-completed";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const present = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  if (
    required.some((key) => !(key in value)) ||
    present.some((key) => !allowed.includes(key))
  )
    throw new Error("graph record has unexpected fields");
}

function text(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new Error(`${label} is invalid`);
  return value as T;
}

function parseEvidence(
  value: unknown,
  expectedRevision: string,
): GraphEvidence {
  const item = record(value, "graph evidence");
  exact(item, ["file", "lines", "revision", "confidence"]);
  const file = text(item.file, 512, "evidence file");
  const lines = text(item.lines, 32, "evidence lines");
  const revision = text(item.revision, 40, "evidence revision");
  if (
    !SAFE_PATH.test(file) ||
    !LINE_RANGE.test(lines) ||
    revision !== expectedRevision
  )
    throw new Error("graph evidence does not identify the exact revision");
  return {
    file,
    lines,
    revision,
    confidence: choice(item.confidence, CONFIDENCE, "evidence confidence"),
  };
}

function parseNode(value: unknown, revision: string): GraphNode {
  const item = record(value, "graph node");
  exact(
    item,
    [
      "id",
      "parentId",
      "kind",
      "title",
      "summary",
      "confidence",
      "overlay",
      "expandable",
      "evidence",
    ],
    ["file", "lines", "language", "code"],
  );
  const id = text(item.id, 128, "node id");
  if (!GRAPH_NODE_ID.test(id)) throw new Error("graph node id is invalid");
  const parentId =
    item.parentId === null ? null : text(item.parentId, 128, "parent id");
  if (parentId !== null && !GRAPH_NODE_ID.test(parentId))
    throw new Error("graph parent id is invalid");
  if (typeof item.expandable !== "boolean")
    throw new Error("graph expandable flag is invalid");
  if (
    !Array.isArray(item.evidence) ||
    item.evidence.length < 1 ||
    item.evidence.length > GRAPH_LIMITS.evidence
  )
    throw new Error("graph node evidence is invalid");
  const file =
    item.file === undefined ? undefined : text(item.file, 512, "node file");
  const lines =
    item.lines === undefined ? undefined : text(item.lines, 32, "node lines");
  if (
    (file === undefined) !== (lines === undefined) ||
    (file && !SAFE_PATH.test(file)) ||
    (lines && !LINE_RANGE.test(lines))
  )
    throw new Error("graph node location is invalid");
  const code =
    item.code === undefined
      ? undefined
      : text(item.code, GRAPH_LIMITS.code, "node code");
  return {
    id,
    parentId,
    kind: choice(item.kind, NODE_KINDS, "node kind"),
    title: text(item.title, GRAPH_LIMITS.title, "node title"),
    summary: text(item.summary, GRAPH_LIMITS.summary, "node summary"),
    confidence: choice(item.confidence, CONFIDENCE, "node confidence"),
    overlay: choice(item.overlay, OVERLAYS, "node overlay"),
    expandable: item.expandable,
    ...(file ? { file, lines } : {}),
    ...(item.language === undefined
      ? {}
      : { language: text(item.language, 64, "node language") }),
    ...(code === undefined ? {} : { code }),
    evidence: item.evidence.map((entry) => parseEvidence(entry, revision)),
  };
}

function parseEdge(value: unknown): GraphEdge {
  const item = record(value, "graph edge");
  exact(item, ["id", "source", "target", "kind", "confidence"], ["label"]);
  const id = text(item.id, 128, "edge id");
  const source = text(item.source, 128, "edge source");
  const target = text(item.target, 128, "edge target");
  if (![id, source, target].every((entry) => GRAPH_NODE_ID.test(entry)))
    throw new Error("graph edge id is invalid");
  return {
    id,
    source,
    target,
    kind: choice(item.kind, EDGE_KINDS, "edge kind"),
    confidence: choice(item.confidence, CONFIDENCE, "edge confidence"),
    ...(item.label === undefined
      ? {}
      : { label: text(item.label, 160, "edge label") }),
  };
}

function validateTopology(
  nodes: GraphNode[],
  edges: GraphEdge[],
  roots: string[],
  known: Set<string> = new Set(),
): void {
  const ids = new Set(known);
  for (const node of nodes) {
    if (ids.has(node.id))
      throw new Error(`duplicate graph node id: ${node.id}`);
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id))
      throw new Error(`duplicate graph edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target))
      throw new Error("graph edge references an unknown node");
  }
  for (const node of nodes)
    if (node.parentId !== null && !ids.has(node.parentId))
      throw new Error("graph node references an unknown parent");
  if (roots.some((id) => !ids.has(id)))
    throw new Error("graph root references an unknown node");
}

export function parseProjectGraph(source: string): ProjectGraph {
  if (Buffer.byteLength(source, "utf8") > GRAPH_LIMITS.artifact)
    throw new Error("project graph exceeds 256 KiB");
  const value = record(JSON.parse(source) as unknown, "project graph");
  exact(value, [
    "version",
    "title",
    "summary",
    "scope",
    "revision",
    "baseRevision",
    "roots",
    "nodes",
    "edges",
    "guidance",
  ]);
  if (value.version !== GRAPH_ARTIFACT_VERSION)
    throw new Error(
      `unsupported project graph version: ${String(value.version)}`,
    );
  const revision = text(value.revision, 40, "graph revision");
  const baseRevision = text(value.baseRevision, 40, "graph base revision");
  if (!SHA.test(revision) || !SHA.test(baseRevision))
    throw new Error("graph revisions must be full SHAs");
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > GRAPH_LIMITS.nodes
  )
    throw new Error("graph node count is invalid");
  if (!Array.isArray(value.edges) || value.edges.length > GRAPH_LIMITS.edges)
    throw new Error("graph edge count is invalid");
  if (
    !Array.isArray(value.roots) ||
    value.roots.length < 1 ||
    value.roots.length > GRAPH_LIMITS.roots
  )
    throw new Error("graph roots are invalid");
  const roots = value.roots.map((item) => text(item, 128, "graph root"));
  const nodes = value.nodes.map((item) => parseNode(item, revision));
  const edges = value.edges.map(parseEdge);
  validateTopology(nodes, edges, roots);
  if (
    nodes.some((node) => roots.includes(node.id) !== (node.parentId === null))
  )
    throw new Error("graph roots and parent links disagree");
  for (const node of nodes)
    if (graphDepth(nodes, node) > GRAPH_LIMITS.depth)
      throw new Error("project graph exceeds maximum depth");
  if (!Array.isArray(value.guidance) || value.guidance.length > 32)
    throw new Error("graph guidance is invalid");
  const guidance = value.guidance.map((entry) => {
    const item = record(entry, "guidance source");
    exact(item, ["path", "kind"]);
    return {
      path: text(item.path, 1024, "guidance path"),
      kind: choice(
        item.kind,
        ["context", "skill", "host"] as const,
        "guidance kind",
      ),
    };
  });
  return {
    version: GRAPH_ARTIFACT_VERSION,
    title: text(value.title, GRAPH_LIMITS.title, "graph title"),
    summary: text(value.summary, GRAPH_LIMITS.summary, "graph summary"),
    scope: choice(value.scope, ["head", "diff"] as const, "graph scope"),
    revision,
    baseRevision,
    roots,
    nodes,
    edges,
    guidance,
    identity: createHash("sha256").update(source).digest("hex"),
    source,
  };
}

export function parseGraphDelta(source: string, revision: string): GraphDelta {
  if (Buffer.byteLength(source, "utf8") > GRAPH_LIMITS.delta)
    throw new Error("graph expansion exceeds 64 KiB");
  const value = record(JSON.parse(source) as unknown, "graph expansion");
  exact(value, ["version", "revision", "parentId", "nodes", "edges"]);
  if (value.version !== GRAPH_ARTIFACT_VERSION)
    throw new Error("unsupported graph expansion version");
  if (value.revision !== revision)
    throw new Error("graph expansion revision does not match");
  const parentId = text(value.parentId, 128, "expansion parent");
  if (!GRAPH_NODE_ID.test(parentId))
    throw new Error("expansion parent is invalid");
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > GRAPH_LIMITS.deltaNodes
  )
    throw new Error("graph expansion node count is invalid");
  if (
    !Array.isArray(value.edges) ||
    value.edges.length > GRAPH_LIMITS.deltaEdges
  )
    throw new Error("graph expansion edge count is invalid");
  return {
    version: GRAPH_ARTIFACT_VERSION,
    revision,
    parentId,
    nodes: value.nodes.map((item) => parseNode(item, revision)),
    edges: value.edges.map(parseEdge),
  };
}

export function assertGraphRange(
  graph: ProjectGraph,
  scope: GraphScope,
  revision: string,
  baseRevision: string,
): void {
  if (
    graph.scope !== scope ||
    graph.revision !== revision ||
    graph.baseRevision !== baseRevision
  )
    throw new Error("project graph does not match the planned exact scope");
}

export function graphDepth(nodes: GraphNode[], node: GraphNode): number {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  let depth = 0;
  let current = node;
  const seen = new Set<string>();
  while (current.parentId !== null) {
    if (seen.has(current.id)) throw new Error("graph parent cycle detected");
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) throw new Error("graph parent is missing");
    current = parent;
    depth += 1;
  }
  return depth;
}

export function mergeGraph(
  graph: ProjectGraph,
  deltas: GraphDelta[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const expanded = new Set<string>();
  for (const delta of deltas) {
    const parent = nodes.find((node) => node.id === delta.parentId);
    if (!parent || !parent.expandable || expanded.has(parent.id))
      throw new Error("graph expansion parent is not available");
    if (delta.nodes.some((node) => node.parentId !== parent.id))
      throw new Error("graph expansion may add only direct children");
    validateTopology(
      delta.nodes,
      delta.edges,
      [],
      new Set(nodes.map((node) => node.id)),
    );
    if (delta.edges.some((edge) => edgeIds.has(edge.id)))
      throw new Error("graph expansion edge id already exists");
    nodes.push(...delta.nodes);
    edges.push(...delta.edges);
    for (const edge of delta.edges) edgeIds.add(edge.id);
    if (nodes.length > GRAPH_LIMITS.nodes || edges.length > GRAPH_LIMITS.edges)
      throw new Error("expanded graph exceeds aggregate limits");
    for (const node of delta.nodes)
      if (graphDepth(nodes, node) > GRAPH_LIMITS.depth)
        throw new Error("expanded graph exceeds maximum depth");
    expanded.add(parent.id);
  }
  return { nodes, edges };
}
