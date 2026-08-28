import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphQueueHost } from "../extensions/quick-review/graph-host.ts";
import type {
  GraphComment,
  GraphDelta,
  GraphNode,
  ReviewerCommentMessage,
} from "../extensions/quick-review/graph-contract.ts";

const node: GraphNode = {
  id: "core",
  parentId: null,
  kind: "component",
  title: "Core",
  summary: "Owns the lifecycle.",
  confidence: "confirmed",
  overlay: "context",
  expandable: true,
  evidence: [
    {
      file: "src/core.ts",
      lines: "1-10",
      revision: "a".repeat(40),
      confidence: "confirmed",
    },
  ],
};

const delta: GraphDelta = {
  version: 1,
  revision: "a".repeat(40),
  parentId: "core",
  nodes: [{ ...node, id: "core.flow", parentId: "core", expandable: false }],
  edges: [],
};

test("graph host queues enhancement and comment responses", async () => {
  let id = 0;
  const host = createGraphQueueHost({
    id: () => String(++id).padStart(24, "0"),
  });
  const expanding = host.expand({ node, knownIds: ["core"] });
  const expansion = await host.next();
  assert.equal(expansion?.kind, "expansion");
  assert.equal(
    host.submitExpansion(
      expansion!.kind === "expansion" ? expansion!.requestId : "",
      delta,
    ),
    true,
  );
  assert.deepEqual(await expanding, delta);

  const comment: GraphComment = {
    id: "b".repeat(24),
    nodeId: "core",
    file: "src/core.ts",
    lines: "3",
    messages: [
      {
        id: "c".repeat(24),
        author: "reviewer",
        body: "Why?",
        delivery: "active",
      },
    ],
  };
  const responding = host.comment({
    node,
    comment,
    message: comment.messages[0] as ReviewerCommentMessage,
    signal: new AbortController().signal,
  });
  const event = await host.next();
  assert.equal(event?.kind, "comment");
  assert.equal(
    host.respondToComment(
      event!.kind === "comment" ? event!.requestId : "",
      "Because.",
    ),
    true,
  );
  assert.equal(await responding, "Because.");
});

test("a cancelled graph wait leaves its event queued", async () => {
  const host = createGraphQueueHost({ id: () => "a".repeat(24) });
  const controller = new AbortController();
  controller.abort();
  const comment: GraphComment = {
    id: "b".repeat(24),
    nodeId: "core",
    file: "src/core.ts",
    lines: "3",
    messages: [
      {
        id: "c".repeat(24),
        author: "reviewer",
        body: "Still there?",
        delivery: "active",
      },
    ],
  };
  const responding = host.comment({
    node,
    comment,
    message: comment.messages[0] as ReviewerCommentMessage,
    signal: new AbortController().signal,
  });
  assert.equal(await host.next({ signal: controller.signal }), undefined);
  const event = await host.next();
  assert.equal(event?.kind, "comment");
  host.fail("closed");
  await assert.rejects(responding, /closed/);
});
