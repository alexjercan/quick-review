---
name: tatr
description: Create, inspect, and update Quick Review tasks for requested tracked work and follow-ups.
---

# Tatr

Keep one task for one user request and its follow-up work. Store decisions and
verification evidence under `tasks/<YYYYMMDD-HHMMSS>/`.

```bash
tatr new "Title" -p 0 -t tag -s IN_PROGRESS
tatr ls
tatr edit <id> -t tag -s CLOSED
```

Valid statuses are `OPEN`, `IN_PROGRESS`, and `CLOSED`. Reopen the same task for
follow-up work. Use `-r ROOT` only when operating on another repository.
