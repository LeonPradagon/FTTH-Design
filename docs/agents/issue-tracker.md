# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply/remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. For ambiguous references such as `#42`, try `gh pr view 42`, then fall back to `gh issue view 42`.

## Skill operations

When a skill says “publish to the issue tracker,” create a GitHub issue.

When a skill says “fetch the relevant ticket,” run:

```shell
gh issue view <number> --comments
```

## Wayfinding operations

- A map is one issue labelled `wayfinder:map`.
- Child tickets use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`.
- Prefer GitHub sub-issues and native issue dependencies when available.
- Fall back to task lists and `Blocked by: #<number>` lines when those features are unavailable.
- Claim work with `gh issue edit <number> --add-assignee @me`.
- Resolve work by commenting with the result and closing the issue.
