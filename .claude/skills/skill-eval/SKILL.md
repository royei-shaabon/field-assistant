---
name: skill-eval
description: Run the identify and interpret product skills against the fixed fixtures with the real model and report accuracy against the acceptance thresholds in docs/spec.md. Use after changing skills/*/prompt.md, examples.yaml, schema.json, lib/skills/ or lib/llm.ts.
---

# skill-eval

1. Run `npm test` first. It checks the skill files and runner with a scripted model and needs no network.
2. Run `npm run skill-eval` (or `npm run skill-eval -- interpret` / `-- identify`). It calls the real model,
   so it needs Anthropic credentials (`ANTHROPIC_API_KEY` or an `ant auth login` profile) and costs money.
   Ask before running it repeatedly.
3. Report per set: status, correct/total, and the failed cases the script prints.

Thresholds (docs/spec.md, "קבלה"):
- `interpret`: at least 27 of 30 (`tests/fixtures/skills/interpret.yaml`).
- `identify-photos`: at least 18 of 20 self-taken photos (`tests/fixtures/photos/manifest.yaml`), each answered
  within 8 seconds. An unclear photo must come back `low`. Stays `PENDING` until 20 photos exist (stage 5);
  `--require-photos` turns pending into a failure.
- `identify-text`: at least 90% of `tests/fixtures/skills/identify-text.yaml`.

Rules when fixing a failing case:
- Do not add NMAX knowledge to `prompt.md` or `examples.yaml`. Knowledge lives only in `knowledge/`.
- Do not copy a fixture into `examples.yaml` (the interpret test checks for overlap).
- Do not change a fixture's expected answer to make the score pass. If the fixture is wrong, say so and ask.
