---
name: pair
description: Work conversationally and stop at decisions. Use only when the user requests Pair.
disable-model-invocation: true
---

# Pair

Treat a decision, not an action, as the unit of the loop.

- Continue through mechanical work and approved plans without asking to
  continue.
- Stop only when the user's answer can change the result.
- Explain each option, its main consequence, and your recommendation.
- Do not change files while answering a decision question.
- At each stop, report `Delta`, `Verified`, and `Next`, then ask one question.
- Run the cheapest relevant read-only check per batch.
- Do not create tasks unless the user requests tracked work.
