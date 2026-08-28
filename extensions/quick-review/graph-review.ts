/** Lifecycle for one exact-revision progressive project graph. */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { committedError, LIMITS } from "./contract.ts";
import type { GraphPlan } from "./analysis.ts";
import { verifyAnalysis } from "./analysis.ts";
import {
  GRAPH_COMPLETION_VERSION,
  type GraphCompletionEvent,
  type GraphDelta,
  type GraphNode,
  type GraphState,
  type ProjectGraph,
} from "./graph-contract.ts";
import { mergeGraph } from "./graph-contract.ts";
import { startGraphServer, type GraphServer } from "./graph-server.ts";
import { initialGraphState, saveGraphState } from "./graph-state.ts";
import * as git from "./git.ts";

export interface GraphHost {
  ask(request: { node: GraphNode; question: string }): Promise<string>;
  expand(request: { node: GraphNode; knownIds: string[] }): Promise<GraphDelta>;
  complete(event: GraphCompletionEvent, warning?: string): Promise<void> | void;
}

export interface OpenGraphReview {
  graph: ProjectGraph;
  state: GraphState;
  plan: GraphPlan;
  server: GraphServer;
  url: string;
}

function writeNew(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function completion(
  plan: GraphPlan,
  graph: ProjectGraph,
  state: GraphState,
  outcome: "approved" | "changes-requested",
  overallComment: string,
  completedAt: string,
): GraphCompletionEvent {
  return {
    version: GRAPH_COMPLETION_VERSION,
    outcome,
    scope: plan.scope,
    ...plan.inputs,
    identity: graph.identity,
    nodes: mergeGraph(graph, state.deltas).nodes.length,
    comments: state.comments.map(({ id: _id, ...comment }) => comment),
    overallComment: overallComment.trim(),
    questions: [...state.questions],
    artifact: plan.artifactPath,
    state: plan.statePath,
    completedAt,
  };
}

export function invalidateGraph(plan: GraphPlan): string[] {
  const failures: string[] = [];
  for (const path of [
    plan.artifactPath,
    plan.statePath,
    plan.patchPath,
    plan.inventoryPath,
  ]) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      failures.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

export function discardGraphPlan(plan: GraphPlan, force = false): void {
  if (existsSync(plan.completionPath)) return;
  if (!force && existsSync(plan.artifactPath)) return;
  rmSync(plan.directory, { recursive: true, force: true });
}

async function exactCode(
  plan: GraphPlan,
  node: GraphNode,
  signal: AbortSignal,
): Promise<string> {
  const evidence = node.file
    ? { file: node.file, lines: node.lines! }
    : node.evidence[0];
  if (!evidence)
    return "No exact code location is attached to this architecture node.";
  const content = await git.showFile(
    plan.inputs.repository,
    plan.inputs.revision,
    evidence.file,
    signal,
  );
  if (content === undefined)
    return `File is absent at exact target revision ${plan.inputs.revision}.`;
  const [startText, endText] = evidence.lines.split("-");
  const start = Number(startText);
  const end = Number(endText ?? startText);
  const lines = content
    .split("\n")
    .slice(Math.max(0, start - 1), Math.min(end, start - 1 + 400));
  return `${evidence.file}:${evidence.lines} at ${plan.inputs.revision}\n${"-".repeat(60)}\n${lines.join("\n")}`;
}

export async function openGraphReview(
  plan: GraphPlan,
  graph: ProjectGraph,
  host: GraphHost,
  options: { signal?: AbortSignal; now?: () => string } = {},
): Promise<OpenGraphReview> {
  const state = initialGraphState(graph);
  const now = options.now ?? (() => new Date().toISOString());
  try {
    if (options.signal?.aborted)
      throw new Error("the review was closed while it was opening");
    writeNew(plan.artifactPath, graph.source);
    saveGraphState(plan.statePath, state);
    if (options.signal?.aborted)
      throw new Error("the review was closed while it was opening");
  } catch (error) {
    discardGraphPlan(plan, true);
    throw error;
  }

  const finalize = async (
    outcome: "approved" | "changes-requested",
    comment: string,
  ): Promise<string | undefined> => {
    const event = completion(plan, graph, state, outcome, comment, now());
    try {
      writeFileSync(
        plan.completionPath,
        `${JSON.stringify(event, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw committedError();
      throw error;
    }
    let warning: string | undefined;
    if (outcome === "changes-requested") {
      const failures = invalidateGraph(plan);
      if (failures.length) {
        warning =
          "Warning: the project graph could not be fully removed; see cleanup-error.txt.";
        try {
          writeFileSync(
            join(plan.directory, "cleanup-error.txt"),
            `${failures.join("\n")}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        } catch {}
      }
    }
    try {
      await host.complete(event, warning);
    } catch {}
    return warning;
  };

  let server: GraphServer;
  try {
    server = await startGraphServer(graph, state, {
      verify: (signal) => verifyAnalysis(plan, signal),
      persist: (next) => saveGraphState(plan.statePath, next),
      expand: ({ id }) =>
        host.expand({
          node: mergeGraph(graph, state.deltas).nodes.find(
            (node) => node.id === id,
          )!,
          knownIds: mergeGraph(graph, state.deltas).nodes.map(
            (node) => node.id,
          ),
        }),
      ask: (node, question) => host.ask({ node, question }),
      code: (node, signal) => exactCode(plan, node, signal),
      approve: (comment) => finalize("approved", comment),
      requestChanges: (comment) => finalize("changes-requested", comment),
    });
  } catch (error) {
    discardGraphPlan(plan, true);
    throw error;
  }
  if (options.signal?.aborted) {
    await server.close().catch(() => undefined);
    discardGraphPlan(plan, true);
    throw new Error("the review was closed while it was opening");
  }
  // The persisted patch is still bounded before it can ever be read by a page action.
  if (
    existsSync(plan.patchPath) &&
    Buffer.byteLength(readFileSync(plan.patchPath, "utf8"), "utf8") >
      LIMITS.patch
  ) {
    await server.close();
    discardGraphPlan(plan, true);
    throw new Error("the exact patch exceeds the review limit");
  }
  return { graph, state, plan, server, url: server.url };
}
