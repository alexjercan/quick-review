# Queue retention is capped and pending items can be drained

This change gives `enqueue` a default retention limit and adds synchronous FIFO draining. The code confirms that overflow discards one oldest item before appending, while draining removes each item before invoking its handler; the intended contracts for pre-oversized queues, non-positive limits, callback failures, and callbacks that enqueue more work are not documented in this repository.

:::walkthrough
version: 1
status: ready
revision: 92a8669dbb89b61bec0d2c565b1fe7be3c769a9e
baseRevision: 39425dcceb0818ed5df43c4def6ad5a98d158998
files: 1
added: 10
removed: 1
:::

:::change
id: bound-and-drain-queue
importance: important
file: src/queue.js
lines: 1-13
:::

`enqueue` now defaults to a limit of 100 and evicts one item from the head whenever the queue is already at or above that limit, then appends the new item and returns the resulting length. This preserves a FIFO queue at the limit during ordinary use. It does not establish a strict bound when an incoming queue is already more than one item over the supplied limit, and a zero or negative limit still permits the newly appended item; whether callers may supply those states or values is unknown because the repository contains no callers, validation, or tests.

`drain` repeatedly removes the head and passes it to `handler`, so processing is synchronous and FIFO. Removal occurs before the callback: if the callback throws, that item is no longer in the queue and later items remain. Because the loop observes the live queue length, items enqueued by the callback are also processed, which can extend the drain indefinitely. These lifecycle semantics follow directly from the implementation, but their intent is not stated.

```diff
@@ -1,4 +1,13 @@
-export function enqueue(queue, item) {
+export function enqueue(queue, item, limit = 100) {
+  if (queue.length >= limit) {
+    queue.shift();
+  }
   queue.push(item);
   return queue.length;
 }
+
+export function drain(queue, handler) {
+  while (queue.length > 0) {
+    handler(queue.shift());
+  }
+}
```

:::review
What queue contract should be guaranteed here—especially for an already-oversized queue or a non-positive limit—and are the drain semantics on handler failure or re-entrant enqueue intentionally part of that contract?
:::