# Lesson templates

Templates are small, ready-to-edit specs that teach one architecture idea in steps. Each caption explains what is
happening, so you can reuse them in tutorials, talks and onboarding docs.

```sh
pcosmo init --list
pcosmo init cache.cosmo.json --template lesson-cache-aside
pcosmo build cache.cosmo.json --steps --png    # one SVG per step for slides
```

| Template                   | Teaches                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `starter`                  | A minimal users, server, database spec to edit                |
| `lesson-request-lifecycle` | DNS, CDN, load balancer, app and database for one web request |
| `lesson-cache-aside`       | Cache miss, database read, cache fill, cache hit              |
| `lesson-circuit-breaker`   | Closed, open and half-open states with a fallback             |
| `lesson-rag-basics`        | Offline ingest and online retrieval for an LLM                |
| `lesson-blue-green`        | Deploy to the idle environment, switch traffic, roll back     |

## Writing your own

1. Copy a template and rename the nodes to your system.
2. Keep one idea per diagram and one sentence per step caption.
3. Use `set` for what changes (a node degrades, a pod becomes healthy) and `flows` for where traffic goes.
4. Export per-step SVGs with `--steps` for slides, or the animated SVG for the web.

Template contributions are welcome: add a `*.cosmo.json` to `examples/templates/`.
