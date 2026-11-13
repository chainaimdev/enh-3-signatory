---
on: push tags v*

permissions:
  contents: read
  issues: read
  pull-requests: read

engine: copilot

max-ai-credits: 40
max-turns: 8

network:
  allowed:
    - defaults

safe-outputs:
  create-issue:
    title-prefix: "[release] "
    labels: [release-notes, automated]
    close-older-issues: true
---

# Tag Release Summary

A new version tag was pushed. Write a short release summary as a GitHub issue.

## Efficiency rules - follow these strictly

You have a small budget. Work from commit metadata only.

- Use the GitHub API to find the current tag, the previous tag, and the commits
  between them, including each commit message and its changed file paths.
- Do NOT read the contents of source files.
- Do NOT explore the repository tree or search the codebase.
- Do NOT read README.md or any other document.
- Make at most 10 tool calls in total. If you cannot finish, write the issue
  with what you have and say which part is incomplete.

Commit messages and changed file paths are enough to write a good summary.

## What to write

- **Version** - the new tag and the tag it is compared against.
- **What changed** - group the commits by area, based on their file paths.
- **How to get it** - end with the exact commands another developer runs:
  git fetch --tags, then git checkout <the new tag>.
- **Worth a look** - anything that looks risky, unfinished, or touches
  configuration, credentials or deployment. If none, say "Nothing flagged".

## Length

Keep it proportional. A config-only tag gets three or four lines. Do not pad.

## Rules

- Report only what the commit messages and file paths show. Do not speculate.
- Never include API keys, tokens or secret values in the issue body.
