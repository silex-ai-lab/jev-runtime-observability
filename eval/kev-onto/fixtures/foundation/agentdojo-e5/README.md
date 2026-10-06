# Foundation regression fixture (the single real-fixture exception)

Derived only from the committed public `eval/convert/fixtures/agentdojo.json`: AgentDojo v1.2.2 task dump, MIT
(ETH SPY Lab). It uses real user-task prompts and ground-truth tool calls for banking, slack and workspace.

Constructed by `build.ts`, not benchmark results:
- tool outputs;
- the `<INFORMATION>` injection placement;
- the `security` and `utility` labels.

`expected.jsonl` is the output of the existing converter (`eval/ontology/runs-convert.ts` `convertRun`) on each run.
It is the T3 regression target. Regenerate with `node build.ts`. `node build.ts --check` must report byte-identical.
