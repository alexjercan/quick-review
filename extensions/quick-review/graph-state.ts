/** Durable state and atomic expansion transitions for project graphs. */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { bounded, LIMITS, RECORD_ID } from "./contract.ts";
import {
  GRAPH_LIMITS,
  GRAPH_STATE_VERSION,
  mergeGraph,
  parseGraphDelta,
  type GraphComment,
  type GraphDelta,
  type GraphState,
  type ProjectGraph,
} from "./graph-contract.ts";

export function initialGraphState(graph: ProjectGraph): GraphState {
  return {
    version: GRAPH_STATE_VERSION,
    identity: graph.identity,
    revision: graph.revision,
    baseRevision: graph.baseRevision,
    deltas: [],
    viewed: Object.fromEntries(graph.nodes.map((node) => [node.id, false])),
    questions: [],
    comments: [],
    outcome: "open",
  };
}

function exactKeys(value: unknown, names: string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...names].sort().join("\0")
  );
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

export function validateGraphState(
  graph: ProjectGraph,
  value: unknown,
): GraphState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("graph state is not an object");
  const state = value as GraphState;
  const expected = [
    "version",
    "identity",
    "revision",
    "baseRevision",
    "deltas",
    "viewed",
    "questions",
    "comments",
    "outcome",
  ];
  if (
    Object.keys(state).sort().join("\0") !== expected.sort().join("\0") ||
    state.version !== GRAPH_STATE_VERSION ||
    state.identity !== graph.identity ||
    state.revision !== graph.revision ||
    state.baseRevision !== graph.baseRevision ||
    !["open", "approved", "changes-requested"].includes(state.outcome) ||
    !Array.isArray(state.deltas) ||
    !state.viewed ||
    typeof state.viewed !== "object" ||
    !Array.isArray(state.questions) ||
    !Array.isArray(state.comments)
  )
    throw new Error("graph state does not match the artifact");

  const deltas = state.deltas.map((delta) =>
    parseGraphDelta(JSON.stringify(delta), graph.revision),
  );
  const merged = mergeGraph(graph, deltas);
  const ids = merged.nodes.map((node) => node.id).sort();
  if (
    Object.keys(state.viewed).sort().join("\0") !== ids.join("\0") ||
    Object.values(state.viewed).some((item) => typeof item !== "boolean")
  )
    throw new Error("graph viewed state is invalid");
  if (
    state.questions.length > LIMITS.questions ||
    state.questions.some(
      (item) =>
        !exactKeys(item, ["nodeId", "question", "answer"]) ||
        !ids.includes(item.nodeId) ||
        !validText(item.question, LIMITS.comment) ||
        !validText(item.answer, LIMITS.answer),
    )
  )
    throw new Error("graph questions are invalid");
  if (
    state.comments.length > GRAPH_LIMITS.nodes ||
    new Set(state.comments.map((item) => item?.id)).size !==
      state.comments.length ||
    state.comments.some(
      (item) =>
        !exactKeys(item, ["id", "nodeId", "file", "lines", "body"]) ||
        !RECORD_ID.test(item.id) ||
        !ids.includes(item.nodeId) ||
        typeof item.file !== "string" ||
        typeof item.lines !== "string" ||
        !validText(item.body, LIMITS.comment),
    )
  )
    throw new Error("graph comments are invalid");
  return { ...state, deltas };
}

export function applyGraphDelta(
  graph: ProjectGraph,
  state: GraphState,
  delta: GraphDelta,
): void {
  if (state.outcome !== "open") throw new Error("this graph review is closed");
  if (delta.revision !== graph.revision)
    throw new Error("graph expansion revision does not match");
  if (state.deltas.some((item) => item.parentId === delta.parentId))
    throw new Error("that graph node is already enhanced");
  const next = [...state.deltas, delta];
  const merged = mergeGraph(graph, next);
  const existingEdges = new Set(graph.edges.map((edge) => edge.id));
  for (const current of state.deltas)
    for (const edge of current.edges) existingEdges.add(edge.id);
  if (delta.edges.some((edge) => existingEdges.has(edge.id)))
    throw new Error("graph expansion edge id already exists");
  state.deltas = next;
  for (const node of merged.nodes)
    if (!(node.id in state.viewed)) state.viewed[node.id] = false;
}

export function setGraphViewed(
  state: GraphState,
  nodeId: string,
  viewed: boolean,
): void {
  if (!(nodeId in state.viewed)) throw new Error("unknown graph node");
  state.viewed[nodeId] = viewed;
}

export function addGraphComment(
  graph: ProjectGraph,
  state: GraphState,
  nodeId: string,
  body: string,
): GraphComment {
  const { nodes } = mergeGraph(graph, state.deltas);
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("unknown graph node");
  if (!body.trim()) throw new Error("a comment needs text");
  if (state.comments.length >= GRAPH_LIMITS.nodes)
    throw new Error("graph comments exceed the review limit");
  const evidence = node.evidence[0];
  const comment: GraphComment = {
    id: randomBytes(12).toString("hex"),
    nodeId,
    file: node.file ?? evidence?.file ?? "",
    lines: node.lines ?? evidence?.lines ?? "",
    body: bounded(body.trim(), LIMITS.comment),
  };
  state.comments.push(comment);
  return comment;
}

export function recordGraphQuestion(
  state: GraphState,
  nodeId: string,
  question: string,
  answer: string,
): void {
  if (!(nodeId in state.viewed)) throw new Error("unknown graph node");
  if (state.questions.length >= LIMITS.questions)
    throw new Error("graph questions exceed the review limit");
  state.questions.push({
    nodeId,
    question: bounded(question.trim(), LIMITS.comment),
    answer: bounded(answer.trim(), LIMITS.answer),
  });
}

export function graphApprovable(
  graph: ProjectGraph,
  state: GraphState,
): boolean {
  const { nodes } = mergeGraph(graph, state.deltas);
  const claims = nodes.filter(
    (node) =>
      node.parentId === null ||
      !node.expandable ||
      state.deltas.some((delta) => delta.parentId === node.id),
  );
  return claims.every((node) => state.viewed[node.id]);
}

export function saveGraphState(path: string, state: GraphState): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("graph state is not a regular file");
    const encoded = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > GRAPH_LIMITS.state)
      throw new Error("graph state exceeds its bounded limit");
    writeFileSync(descriptor, encoded, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function loadGraphState(path: string, graph: ProjectGraph): GraphState {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > GRAPH_LIMITS.state)
      throw new Error("graph state file is invalid");
    return validateGraphState(
      graph,
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
    );
  } finally {
    closeSync(descriptor);
  }
}
