# T6c binder agreement

Binder A: coder-mimo (fresh OpenCode session). Binder B: four one-shot `opencode run -m deepseek/deepseek-v4-pro` processes.
Both bound from the tool manifests and the binding prompt only (no runs, labels or outcomes).

| manifest | effect set equal | read/write impact equal | every parameter class equal |
|---|---|---|---|
| agentdyn | 79/100 (79.0%) | 92/100 (92.0%) | 57/100 (57.0%) |
| agentdojo | 63/74 (85.1%) | 74/74 (100.0%) | 66/74 (89.2%) |
| train | 279/395 (70.6%) | 325/395 (82.3%) | 389/395 (98.5%) |
| silex | 11/11 (100.0%) | 11/11 (100.0%) | 8/11 (72.7%) |
| all | 432/580 (74.5%) | 502/580 (86.6%) | 520/580 (89.7%) |

Disputed tools (effect set or any parameter class differs): 192; of these, impact differs for 78.

Resolved binding: 580 tools; 192 by written planner resolution (resolutions.json).
