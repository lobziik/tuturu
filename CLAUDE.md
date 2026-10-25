@AGENTS.md

## Claude Code notes

- `AGENTS.md` above is the project guide. This file only adds Claude Code specifics.
- Skill: `webrtc-e2ee-debug` (`.claude/skills/`) for calls that connect but carry no media,
  E2EE counter anomalies, iOS-only failures, SFU/TURN connectivity.
- Run commands from `app/`. Before tests on a fresh checkout: `bun run build`.
  Write long test output to a file and grep it instead of reading the stream.
- PR review: `git fetch origin pull/<N>/head:pr-<N>`; between review rounds diff
  `git diff <old-sha>..<new-sha>` and track which earlier findings were addressed.
  Separate blockers from structural notes, cite exact `file:line`.
- Verify against the code before asserting behaviour; design notes in a local `ai/` folder may
  be out of date.
- Don't push, tag, or open PRs unless asked.
