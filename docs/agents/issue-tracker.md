# Issue Tracker Configuration

Issues for this project are tracked in **GitHub Issues** at [github.com/profitmarkhk/MindbodyMCP](https://github.com/profitmarkhk/MindbodyMCP).

## Creating Issues

Skills like `to-issues`, `to-prd`, and `qa` create issues using the GitHub CLI (`gh`):

```bash
gh issue create --title "..." --body "..." --label label1,label2
```

## Triage Workflow

The `triage` skill reads incoming issues and applies labels to move them through states. See `docs/agents/triage-labels.md` for label mappings.

## Reading Issues

Skills read issues from GitHub using the `gh` CLI:

```bash
gh issue list --search "is:open"
gh issue view <number>
```

Ensure the `gh` CLI is authenticated:

```bash
gh auth login
```
