# Exact-match vs ESR — 2026-10-18

Gold: 100 queries · EM = entity + normalized $filter · 14 repetition(s) across 6 model(s). Values are % (mean ± sample sd when n > 1).

## Exact match by type

| Model | kind | n | T1 | T2 | T3 | T4 | T5 | **EM** | ESR | ESR FP rate |
|---|---|---|---|---|---|---|---|---|---|---|
| Qwen2.5-Coder-1.5B | on-device | 3 | 90 ± 0 | 96.7 ± 2.9 | 95 ± 0 | 100 ± 0 | 100 ± 0 | **96.3 ± 0.6** | 93.7 ± 0.6 | 1.4 ± 1.2 |
| Llama-3.2-3B | on-device | 3 | 95 ± 0 | 95 ± 0 | 78.3 ± 2.9 | 90 ± 0 | 100 ± 0 | **91.7 ± 0.6** | 89 ± 0 | 1.5 ± 0.6 |
| Gemma-2-2B | on-device | 1 | 95 | 90 | 80 | 85 | 95 | **89** | 86 | 1.2 |
| Phi-3.5-mini | on-device | 1 | 90 | 95 | 85 | 90 | 75 | **87** | 90 | 5.6 |
| Qwen2.5-0.5B | on-device | 3 | 91.7 ± 2.9 | 90 ± 0 | 48.3 ± 2.9 | 86.7 ± 2.9 | 95 ± 0 | **82.3 ± 0.6** | 80.3 ± 0.6 | 8.3 ± 0.7 |
| Claude Haiku 5.5 (cloud) | cloud baseline | 3 | 100 ± 0 | 100 ± 0 | 96.7 ± 2.9 | 100 ± 0 | 100 ± 0 | **99.3 ± 0.6** | 95 ± 0 | 0 ± 0 |

## ESR by type (same runs)

| Model | T1 | T2 | T3 | T4 | T5 | ESR |
|---|---|---|---|---|---|---|
| Qwen2.5-Coder-1.5B | 93.3 ± 2.9 | 100 ± 0 | 80 ± 0 | 100 ± 0 | 95 ± 0 | 93.7 ± 0.6 |
| Llama-3.2-3B | 95 ± 0 | 95 ± 0 | 65 ± 0 | 95 ± 0 | 95 ± 0 | 89 ± 0 |
| Gemma-2-2B | 95 | 90 | 65 | 90 | 90 | 86 |
| Phi-3.5-mini | 90 | 100 | 80 | 100 | 80 | 90 |
| Qwen2.5-0.5B | 81.7 ± 2.9 | 90 ± 0 | 48.3 ± 2.9 | 91.7 ± 2.9 | 90 ± 0 | 80.3 ± 0.6 |
| Claude Haiku 5.5 (cloud) | 100 ± 0 | 100 ± 0 | 80 ± 0 | 100 ± 0 | 95 ± 0 | 95 ± 0 |

## Timing

| Model | median ms (mean ± sd over runs) | max ms | stalls (>100 s, all runs) | size | GPU |
|---|---|---|---|---|---|
| Qwen2.5-Coder-1.5B | 7218 ± 404.3 | 9212 | 0 | ~900 MB | apple apple apple |
| Llama-3.2-3B | 12396.7 ± 231.7 | 15922 | 0 | ~2.0 GB | apple apple apple |
| Gemma-2-2B | 11702 | 14406 | 0 | ~1.5 GB | apple apple apple |
| Phi-3.5-mini | 20582 | 30123 | 0 | ~2.2 GB | apple apple apple |
| Qwen2.5-0.5B | 2082 ± 19.7 | 9826 | 0 | ~300 MB | apple apple apple |
| Claude Haiku 5.5 (cloud) | 1301.3 ± 5.7 | 6138 | 0 | cloud | apple apple apple |

## Per-repetition detail

| Model | file | rep | EM | ESR | FP | median ms |
|---|---|---|---|---|---|---|
| Claude Haiku 5.5 (cloud) | floria_benchmark_Claude_Haiku_5_5__cloud__2026-10-18.json | 1 | 99/100 (99%) | 95/100 (95%) | 0 (0%) | 1303 |
| Claude Haiku 5.5 (cloud) | floria_benchmark_Claude_Haiku_5_5__cloud__2026-10-18.json | 2 | 100/100 (100%) | 95/100 (95%) | 0 (0%) | 1295 |
| Claude Haiku 5.5 (cloud) | floria_benchmark_Claude_Haiku_5_5__cloud__2026-10-18.json | 3 | 99/100 (99%) | 95/100 (95%) | 0 (0%) | 1306 |
| Gemma-2-2B | floria_benchmark_Gemma_2_2B_2026-10-18.json | 1 | 89/100 (89%) | 86/100 (86%) | 1 (1.2%) | 11702 |
| Llama-3.2-3B | floria_benchmark_Llama_3_2_3B_2026-10-17.json | 1 | 92/100 (92%) | 89/100 (89%) | 1 (1.1%) | 12271 |
| Llama-3.2-3B | floria_benchmark_Llama_3_2_3B_2026-10-17.json | 2 | 92/100 (92%) | 89/100 (89%) | 1 (1.1%) | 12255 |
| Llama-3.2-3B | floria_benchmark_Llama_3_2_3B_2026-10-17.json | 3 | 91/100 (91%) | 89/100 (89%) | 2 (2.2%) | 12664 |
| Phi-3.5-mini | floria_benchmark_Phi_3_5_mini_2026-10-18.json | 1 | 87/100 (87%) | 90/100 (90%) | 5 (5.6%) | 20582 |
| Qwen2.5-0.5B | floria_benchmark_Qwen2_5_0_5B_2026-10-17.json | 1 | 82/100 (82%) | 81/100 (81%) | 7 (8.6%) | 2066 |
| Qwen2.5-0.5B | floria_benchmark_Qwen2_5_0_5B_2026-10-17.json | 2 | 83/100 (83%) | 80/100 (80%) | 6 (7.5%) | 2104 |
| Qwen2.5-0.5B | floria_benchmark_Qwen2_5_0_5B_2026-10-17.json | 3 | 82/100 (82%) | 80/100 (80%) | 7 (8.8%) | 2076 |
| Qwen2.5-Coder-1.5B | floria_benchmark_Qwen2_5_Coder_1_5B_2026-10-17.json | 1 | 96/100 (96%) | 94/100 (94%) | 2 (2.1%) | 6796 |
| Qwen2.5-Coder-1.5B | floria_benchmark_Qwen2_5_Coder_1_5B_2026-10-17.json | 2 | 96/100 (96%) | 94/100 (94%) | 2 (2.1%) | 7256 |
| Qwen2.5-Coder-1.5B | floria_benchmark_Qwen2_5_Coder_1_5B_2026-10-17.json | 3 | 97/100 (97%) | 93/100 (93%) | 0 (0%) | 7602 |

## LaTeX rows for Table I (Model & T1..T5 EM & ESR & EM & ESR FP rate), mean ± sd when n > 1

```latex
Qwen2.5-Coder-1.5B & 90\% $\pm$ 0 & 96.7\% $\pm$ 2.9 & 95\% $\pm$ 0 & 100\% $\pm$ 0 & 100\% $\pm$ 0 & 93.7\% $\pm$ 0.6 & 96.3\% $\pm$ 0.6 & 1.4\% $\pm$ 1.2 \\
Llama-3.2-3B & 95\% $\pm$ 0 & 95\% $\pm$ 0 & 78.3\% $\pm$ 2.9 & 90\% $\pm$ 0 & 100\% $\pm$ 0 & 89\% $\pm$ 0 & 91.7\% $\pm$ 0.6 & 1.5\% $\pm$ 0.6 \\
Gemma-2-2B & 95\% & 90\% & 80\% & 85\% & 95\% & 86\% & 89\% & 1.2\% \\
Phi-3.5-mini & 90\% & 95\% & 85\% & 90\% & 75\% & 90\% & 87\% & 5.6\% \\
Qwen2.5-0.5B & 91.7\% $\pm$ 2.9 & 90\% $\pm$ 0 & 48.3\% $\pm$ 2.9 & 86.7\% $\pm$ 2.9 & 95\% $\pm$ 0 & 80.3\% $\pm$ 0.6 & 82.3\% $\pm$ 0.6 & 8.3\% $\pm$ 0.7 \\
Claude Haiku 5.5 (cloud) & 100\% $\pm$ 0 & 100\% $\pm$ 0 & 96.7\% $\pm$ 2.9 & 100\% $\pm$ 0 & 100\% $\pm$ 0 & 95\% $\pm$ 0 & 99.3\% $\pm$ 0.6 & 0\% $\pm$ 0 \\
```

Mismatches: 115 (see mismatches.json)
