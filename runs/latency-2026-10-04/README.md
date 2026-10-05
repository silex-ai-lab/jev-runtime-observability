# Judge latency: Kev-0.8B fine-tuned (local) vs gpt-4o-mini (OpenAI API), 2026-10-04

The same 708 held-out items from `eval/splits/items.jsonl` (calibration, dev and test splits) and the same judgment
questions, one call per item, two workers. The time is the judge's HTTP round trip on a monotonic clock, from sending the
request to reading the full body. Host: Apple M4 Pro. Kev ran locally (MLX, bf16); gpt-4o-mini was called over the
public internet. Failed calls: 0 and 0.

| judge | p50 | p95 | within the 400 ms gate judge budget |
|---|---|---|---|
| Kev-0.8B fine-tuned (`runs/ft-kev-0.8b-2026-09-28/model`) | 151.6 ms | 346.8 ms | 99.0 % |
| gpt-4o-mini (`gpt-4o-mini-2024-07-18`) | 669.9 ms | 990.2 ms | 0.3 % |

OpenAI's reported server processing time (`openai-processing-ms`) alone was p50 568 ms and p95 800 ms. This compares speed
only. The gpt-4o-mini answers are recorded but not scored here, and gpt-4o was not measured.

```bash
KEV_RUN=$PWD/runs/ft-kev-0.8b-2026-09-28/model KEV_PORT=8011 bash scripts/kev-serve.sh &
node eval/run/run.ts --judge http://127.0.0.1:8011 --label kev-0.8b-ft --out runs/latency-2026-10-04
OPENAI_API_KEY=… node eval/run/run-openai.ts --model gpt-4o-mini --label gpt-4o-mini --out runs/latency-2026-10-04
node eval/run/latency-json.ts --out ../silex-mockup/data/judge-latency.json \
  kev-0.8b-ft=runs/latency-2026-10-04/predictions-kev-0.8b-ft.jsonl gpt-4o-mini=runs/latency-2026-10-04/predictions-gpt-4o-mini.jsonl
```

The output feeds the "How fast is the judge?" card in silex-mockup's Runtime Observation view.
