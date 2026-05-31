# Triage Labels

The `triage` skill uses these labels to categorize and route issues:

| Label | Meaning | Assigned by |
|-------|---------|-------------|
| `needs-triage` | Maintainer needs to evaluate | `triage` skill or manual |
| `needs-info` | Waiting on reporter feedback | `triage` skill |
| `ready-for-agent` | Fully specified, AFK-ready | `triage` skill or maintainer |
| `ready-for-human` | Needs human implementation | Maintainer |
| `wontfix` | Will not be actioned | Maintainer |

## Creating Labels in GitHub

If these labels don't exist yet, create them:

```bash
gh label create needs-triage --description "Needs maintainer review"
gh label create needs-info --description "Waiting on reporter"
gh label create ready-for-agent --description "Ready for agent to pick up"
gh label create ready-for-human --description "Needs human implementation"
gh label create wontfix --description "Will not be fixed"
```
