import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphQueueHost } from "../extensions/quick-review/graph-host.ts";
import type {
  GraphDelta,
  GraphNode,
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

test("graph host queues enhancement and question responses", async () => {
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

  const asking = host.ask({ node, question: "Why?" });
  const question = await host.next();
  assert.equal(question?.kind, "question");
  assert.equal(
    host.answer(
      question!.kind === "question" ? question!.requestId : "",
      "Because.",
    ),
    true,
  );
  assert.equal(await asking, "Because.");
});

test("a cancelled graph wait leaves its event queued", async () => {
  const host = createGraphQueueHost({ id: () => "a".repeat(24) });
  const controller = new AbortController();
  controller.abort();
  const asking = host.ask({ node, question: "Still there?" });
  assert.equal(await host.next({ signal: controller.signal }), undefined);
  const event = await host.next();
  assert.equal(event?.kind, "question");
  host.fail("closed");
  await assert.rejects(asking, /closed/);
});
