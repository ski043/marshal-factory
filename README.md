# marshal-factory

A software factory on top of Claude Code, PStack and T3 Code, with a browser panel for supervising it.

Linear issues are picked up by a T3 scheduled task. Each issue gets its own T3 thread, which runs PStack on a `factory/<issue>` worktree branch. Claude Code hooks and a small `factory_report` MCP server stream every run's stage, subagents, models and cost to Neon Postgres. The panel shows that live through Neon Realtime.

```
T3 scheduled task (poller) ──► t3_thread_launch per issue, branch factory/LIN-123
                                   │
            T3 thread (Claude Code + PStack + factory playbook)
              ├─ hooks ──────────────┐  session, subagents, models, tokens
              └─ factory_report MCP ─┤  stage, status, summary
                                     ▼
                     Neon (Function /ingest + Postgres + Realtime)
                                     ▼
                Next.js + shadcn panel
          board · run timeline · agent tree · inbox · metrics · Open in T3
```

## Build order

1. Neon backend: append-only `events` with `runs` and `agents` projections, and an ingest Function. `issues` and `gates` follow in later phases.
2. Claude Code hooks that post session and subagent events, verified against a normal T3 thread.
3. `factory_report` MCP server and a factory playbook extending PStack's feature and bug-fix playbooks.
4. Panel UI: board, run view, agent tree, inbox.
5. Linear poller as a T3 scheduled task.

## Research

Background reports from the initial investigation live in [`docs/research/`](docs/research/).
