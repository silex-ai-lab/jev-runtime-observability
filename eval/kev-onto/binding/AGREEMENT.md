# T6c binder agreement

Binder A: coder-mimo (fresh OpenCode sessions). Binder B: one-shot `opencode run -m deepseek/deepseek-v4-pro` processes.
The 25 τ-bench tools were re-bound by both binders at CG1 with source descriptions and family-scoped ids.
Both bound from the tool manifests and the binding prompt only (no runs, labels or outcomes).

| manifest | effect set equal | read/write impact equal | every parameter class equal |
|---|---|---|---|
| agentdyn | 79/100 (79.0%) | 92/100 (92.0%) | 57/100 (57.0%) |
| agentdojo | 63/74 (85.1%) | 74/74 (100.0%) | 66/74 (89.2%) |
| train | 289/406 (71.2%) | 337/406 (83.0%) | 395/406 (97.3%) |
| silex | 11/11 (100.0%) | 11/11 (100.0%) | 8/11 (72.7%) |
| all | 442/591 (74.8%) | 514/591 (87.0%) | 526/591 (89.0%) |

Disputed tools (effect set or any parameter class differs): 197; of these, impact differs for 77.

Resolved binding: 591 tools; 197 by written planner resolution (resolutions.json).
