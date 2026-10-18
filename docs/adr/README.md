# Architecture decision records

One file per decision. They record *why* something is the way it is, so that a
later reader does not have to reverse-engineer the reasoning from the diff.

## Naming

```
docs/adr/0001-short-kebab-case-title.md
```

A zero-padded four-digit number, then a kebab-case title. Numbers start at `0001`
and are never reused, never renumbered, and never reordered. An ADR that is
later replaced keeps its number and gains a status; the replacement gets the
next number.

## Required sections

Every ADR has these headings, in this order, even when a section is short:

| Section | What belongs in it |
|---|---|
| **Status** | `Accepted`, or `Superseded by NNNN`, or `Amended by NNNN`. One line. |
| **Context** | The situation that forced a choice. Facts and evidence, not argument. |
| **Decision** | What we do, stated plainly in the active voice. |
| **Consequences** | What this costs us and what it buys. Include what a reader must remember to work here. |
| **When this changes** | The condition under which the decision stops being right, and what would replace it. |

Add a section only when the decision has something of that kind to say — the
deviations table in [`0001-write-to-observed-sandbox-behaviour.md`](0001-write-to-observed-sandbox-behaviour.md)
is an example of a section that only that decision needed.

## Editing

An accepted ADR is not rewritten. If the decision changes, write the next ADR
and mark the old one `Superseded by`. If only part of a decision changes, mark
it `Amended by` and say in the new ADR which part. Keeping the old text is the
point: an ADR that has been edited into agreement with the present is no
evidence of anything.

## Prose

Plain sentences, active voice, no hedging. Tables over prose for anything that
is a list of facts. Link out for evidence rather than pasting it — a probe's
capture belongs in
[`docs/mindbody-spec-discrepancies.md`](../mindbody-spec-discrepancies.md),
which is the working record for code-versus-spec-versus-sandbox findings.

The closest existing template for tone is
[`docs/migrations/BUN_DECISION.md`](../migrations/BUN_DECISION.md): decisive,
concrete, and willing to say what the decision costs.
