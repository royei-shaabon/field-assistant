---
name: kb-add-symptom
description: Build one knowledge/symptoms/<id>.yaml file from the official owner's manual pages and the mechanic interview notes, following the schema, rewritten in short Hebrew with page numbers. Use when adding or rebuilding a real (non-SAMPLE) symptom.
---

# kb-add-symptom

Done when: `npm run kb:validate` passes with no new warnings, and the user approved the file.

## Before writing anything
1. `knowledge/device.yaml` has `verified: true`, with `model_code`, `year` and `manual_version` filled from the
   registration/VIN. If not, stop and ask. kb:validate refuses real symptoms until then.
2. The manual PDF is in `sources/` (git-ignored) and its model code matches `device.yaml`. Read the relevant
   pages yourself. Never work from memory, search snippets or third-party sites (ManualsLib, Scribd, forums).
3. Interview notes for this symptom are in `sources/interviews/` (see `docs/stage5/mechanic-interview.md`).
   No notes means no `tip` and no mechanic-only steps. Do not invent field knowledge.

## Sources
- Manual: one entry in `knowledge/sources.yaml`, e.g. `id: yamaha-<model_code>-owners-<year>`, `type: manual`,
  `title` as printed, `date`, `file: sources/<file>.pdf`.
- Mechanic: one entry per interview, `id: mechanic-<name>-<yyyy-mm-dd>`, `type: mechanic`, `title` = the name
  as they agreed to show it, `date` of the interview.

## Writing the file
- File name = `id`. Planned ids (docs/spec.md, 8 symptoms): `smart-key-not-detected`, `no-crank`,
  `crank-no-start`, `engine-light`, `abs-light`, `temp-light`, `stop-start-inactive`, `maintenance-indicator`.
- `title`: short Hebrew, the way a rider would describe it.
- `visual_cues`: what is visible on the dashboard or bike, from the manual and the photos. Never empty.
- Steps: one check per step, phrased as a yes/no question. `how` only if the manual or mechanic says how.
  Rewrite in your own short Hebrew. Never copy a paragraph. Every step has `source` with `page`.
- `on_pass` / `on_fail`: next step, `{ resolve: ... }` or `{ escalate: ... }`. Resolve text is also rewritten
  from the source. No loops, no orphans.
- `hazard: true` (and escalate on both outcomes) for anything touching brakes/ABS, the fuel system, the coolant
  cap on a hot engine, or work on a running engine. When in doubt, mark hazard and say so to the user.
- A mechanic tip goes in `tip: { author, text, source: { type: mechanic, ref } }` on the step it belongs to.
  A step that exists only because of the mechanic uses the mechanic as its `source`.
- Manual and mechanic disagree: keep both, manual as the step, mechanic as the tip, `conflict: true`.
- `escalate_after_steps`: number of steps on the longest path, unless the mechanic gave a lower limit.

## After writing
1. `npm run kb:validate`. Fix every error. Read every hazard-topic warning and either set `hazard: true` or
   explain to the user why not.
2. `npm test`.
3. Show the user a table: step id, check, source (page or mechanic), hazard. Wait for approval.
4. The SAMPLE symptom stays until all 8 real ones are in; removing it also means updating tests that use
   `sample-placeholder`.
