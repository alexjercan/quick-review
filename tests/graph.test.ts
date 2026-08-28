import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planAnalysis,
  verifyAnalysis,
} from "../extensions/quick-review/analysis.ts";
import {
  assertGraphRange,
  parseGraphDelta,
  parseProjectGraph,
  type ProjectGraph,
} from "../extensions/quick-review/graph-contract.ts";
import {
  GRAPH_PAGE_JS,
  renderGraphPage,
} from "../extensions/quick-review/graph-page.ts";
import { startGraphServer } from "../extensions/quick-review/graph-server.ts";
import {
  applyGraphDelta,
  initialGraphState,
  validateGraphState,
} from "../extensions/quick-review/graph-state.ts";
import { commit, repository, write } from "./helpers.ts";

function source(
  revision: string,
  baseRevision: string,
  scope: "head" | "diff" = "diff",
): string {
  return JSON.stringify({
    version: 1,
    title: "Greeting architecture",
    summary: "A small greeting component.",
    scope,
    revision,
    baseRevision,
    roots: ["greeting"],
    nodes: [
      {
        id: "greeting",
        parentId: null,
        kind: "component",
        title: "Greeting",
        summary: "Formats the caller's greeting.",
        confidence: "confirmed",
        overlay: scope === "diff" ? "modified" : "unchanged",
        expandable: true,
        file: "src/app.js",
        lines: "1-3",
        language: "javascript",
        evidence: [
          {
            file: "src/app.js",
            lines: "1-3",
            revision,
            confidence: "confirmed",
          },
        ],
      },
    ],
    edges: [],
    guidance: [{ path: "AGENTS.md", kind: "context" }],
  });
}

function delta(revision: string): string {
  return JSON.stringify({
    version: 1,
    revision,
    parentId: "greeting",
    nodes: [
      {
        id: "greeting.format",
        parentId: "greeting",
        kind: "symbol",
        title: "greet",
        summary: "Interpolates the supplied name.",
        confidence: "confirmed",
        overlay: "modified",
        expandable: false,
        file: "src/app.js",
        lines: "1-3",
        language: "javascript",
        code: "export function greet(name) {\n  return `hi ${name}`;\n}",
        evidence: [
          {
            file: "src/app.js",
            lines: "1-3",
            revision,
            confidence: "confirmed",
          },
        ],
      },
    ],
    edges: [
      {
        id: "greeting-contains-format",
        source: "greeting",
        target: "greeting.format",
        kind: "contains",
        confidence: "confirmed",
      },
    ],
  });
}

test("project graph and direct-child deltas are bounded and exact", () => {
  const revision = "a".repeat(40);
  const base = "b".repeat(40);
  const graph = parseProjectGraph(source(revision, base));
  assert.equal(graph.nodes.length, 1);
  assertGraphRange(graph, "diff", revision, base);
  const expansion = parseGraphDelta(delta(revision), revision);
  const state = initialGraphState(graph);
  applyGraphDelta(graph, state, expansion);
  assert.equal(state.deltas.length, 1);
  assert.equal(state.viewed["greeting.format"], false);
  assert.deepEqual(validateGraphState(graph, state), state);
  assert.throws(
    () => applyGraphDelta(graph, state, expansion),
    /already enhanced/,
  );
});

test("project graph rejects foreign evidence, cycles, and unknown fields", () => {
  const revision = "a".repeat(40);
  const base = "b".repeat(40);
  const wrong = JSON.parse(source(revision, base));
  wrong.nodes[0].evidence[0].revision = "c".repeat(40);
  assert.throws(
    () => parseProjectGraph(JSON.stringify(wrong)),
    /exact revision/,
  );
  const extra = JSON.parse(source(revision, base));
  extra.nodes[0].surprise = true;
  assert.throws(
    () => parseProjectGraph(JSON.stringify(extra)),
    /unexpected fields/,
  );
  const emptyEvidence = JSON.parse(source(revision, base));
  emptyEvidence.nodes[0].evidence = [];
  assert.throws(
    () => parseProjectGraph(JSON.stringify(emptyEvidence)),
    /evidence is invalid/,
  );
  const cycle = JSON.parse(source(revision, base));
  cycle.roots = ["root"];
  cycle.nodes[0].parentId = "loop";
  cycle.nodes.push({
    ...cycle.nodes[0],
    id: "loop",
    parentId: "greeting",
    title: "Loop",
  });
  cycle.nodes.push({
    ...cycle.nodes[0],
    id: "root",
    parentId: null,
    title: "Root",
  });
  assert.throws(() => parseProjectGraph(JSON.stringify(cycle)), /cycle/);
});

test("graph page keeps hostile graph text inside encoded data", () => {
  const revision = "a".repeat(40);
  const value = JSON.parse(source(revision, "b".repeat(40)));
  value.title = '<img src=x onerror="alert(1)">';
  value.nodes[0].title = "</article><script>alert(1)</script>";
  const graph = parseProjectGraph(JSON.stringify(value));
  const page = renderGraphPage(graph, initialGraphState(graph));
  assert.doesNotMatch(page, /<img src=x|<script>alert/);
  assert.match(page, /&lt;img src=x/);
  assert.doesNotMatch(page, /data-ask/);
  assert.doesNotMatch(GRAPH_PAGE_JS, /Mark viewed|prompt\(/);
  assert.match(GRAPH_PAGE_JS, /inline-composer/);
  assert.match(GRAPH_PAGE_JS, /code-node/);
  assert.match(GRAPH_PAGE_JS, /e\.target\.closest\('\.node,button/);
  assert.match(GRAPH_PAGE_JS, /WORLD=100000/);
  assert.match(GRAPH_PAGE_JS, /function arrangeRoots/);
  assert.match(GRAPH_PAGE_JS, /function syncGrid/);
  assert.match(GRAPH_PAGE_JS, /e\.ctrlKey\|\|e\.metaKey/);
  assert.doesNotThrow(() => new Function(GRAPH_PAGE_JS));
});

test("HEAD and diff analysis plans bind committed objects", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "quick-review-graph-state-"),
  );
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const head = await planAnalysis({ cwd: fixture.path, scope: "head" });
    assert.equal(head.inputs.revision, fixture.head);
    assert.equal(head.inputs.baseRevision, fixture.head);
    assert.ok(head.inventory.files.some((item) => item.file === "src/app.js"));
    await verifyAnalysis(head);
    const diff = await planAnalysis({
      cwd: fixture.path,
      scope: "diff",
      baseRef: fixture.base,
    });
    assert.equal(diff.inputs.baseRevision, fixture.base);
    assert.equal(
      diff.inventory.files.find((item) => item.file === "src/app.js")?.overlay,
      "modified",
    );
    await verifyAnalysis(diff);
    write(fixture.path, "src/next.js", "export const next = true;\n");
    commit(fixture.path, "Move analyzed HEAD");
    await assert.rejects(verifyAnalysis(head), /analyzed HEAD changed/);
    await assert.rejects(verifyAnalysis(diff), /reviewed revision changed/);
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("graph server enhances, persists, asks, and commits", async () => {
  const revision = "a".repeat(40);
  const graph: ProjectGraph = parseProjectGraph(
    source(revision, "b".repeat(40)),
  );
  const state = initialGraphState(graph);
  let persisted = 0;
  let approved = false;
  const server = await startGraphServer(graph, state, {
    verify: async () => {},
    persist: () => void persisted++,
    expand: async () => parseGraphDelta(delta(revision), revision),
    ask: async () => "The caller supplies the name.",
    code: async () => "exact code",
    approve: async () => {
      approved = true;
      return undefined;
    },
    requestChanges: async () => undefined,
  });
  const act = async (body: object) => {
    const response = await fetch(new URL("action", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: (await response.json()) as any };
  };
  try {
    const page = await fetch(server.url);
    assert.match(await page.text(), /project decompiler/);
    const enhanced = await act({ action: "enhance", node: "greeting" });
    assert.equal(enhanced.status, 200);
    assert.equal(enhanced.payload.data.nodes.length, 2);
    const asked = await act({
      action: "ask",
      node: "greeting.format",
      comment: "Why?",
    });
    assert.equal(
      asked.payload.data.state.questions[0].answer,
      "The caller supplies the name.",
    );
    const result = await act({ action: "approve", comment: "Looks right." });
    assert.equal(result.status, 200);
    assert.equal(approved, true);
    assert.ok(persisted >= 3);
  } finally {
    await server.close();
  }
});
