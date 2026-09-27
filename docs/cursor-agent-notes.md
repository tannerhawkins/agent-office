# Cursor CLI notes

These notes come from a spike run on 2026-09-26 against `cursor-agent` v2026.09.23 / v2026.09.26, driven in a PTY the same way the office drives workers. They record what the Cursor adapter (`src/server/cursor.ts` and `handleCursorHook` in `src/server/workers.ts`) depends on. If Cursor changes any of this, the adapter needs updating to match.

## Hooks
- **They load per process with `--plugin-dir <dir>`.** Cursor reads `<dir>/hooks/hooks.json` if there is also a `<dir>/.cursor-plugin/plugin.json` manifest (`{"name","description","version","author":{"name"}}`). A `hooks.json` at the plugin root is ignored. This means the office never has to edit `~/.cursor/hooks.json`.
- **Hooks also load from `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json`.** All sources run.
- **`command` runs through a shell**, so inline `cat > file; exit 0` works.
- **Hooks inherit the agent process's environment** (`AGENT_OFFICE_*` included). Cursor adds `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CURSOR_INVOKED_AS`, `CURSOR_USER_EMAIL` and `CLAUDE_PROJECT_DIR`.
- **Every payload has** `conversation_id`, `generation_id`, `session_id` (= conversation_id), `model`, `hook_event_name`, `workspace_roots` and `transcript_path`. `transcript_path` is `null` until the first tool call.

## Event order for one turn
`sessionStart` → `beforeSubmitPrompt{prompt}` → `preToolUse{tool_name:"Shell", tool_input:{command,cwd,timeout}}` → *(approval, if needed)* → `beforeShellExecution` → `afterShellExecution` → `postToolUse{tool_output}` → `stop{status}` → `afterAgentResponse{text}`

- **`sessionStart` fires on the first prompt, not at boot.** It does not fire when a chat is resumed. So boot can't be detected from a hook; it's detected from the screen (the prompt bar).
- **`stop` fires on every turn.**
  - `status: "completed"` includes **real per-turn token counts**: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. They are per turn, not cumulative. `input_tokens` appears to include `cache_read_tokens`.
  - Esc mid-turn gives `status: "aborted"` (followed by a second `stop` with `status: "error"`), with no token counts.
- **`afterAgentResponse` repeats the same token counts**, so only `stop` should be counted.

## Screen and terminal
- **Idle prompt bar:** `→ Plan, search, build anything` for a new chat, `→ Add a follow-up` once there is history.
- **Busy:** a spinner line (`Working` / `Running  N tokens`), plus `ctrl+c to stop` at the right of the prompt bar.
- **Approval prompt** (only when `approvalMode` isn't `unrestricted`):
  ```
  $ rm junk2.txt Waiting for approval...
   Run this command?
   Not in allowlist: rm
    → Run (once) (y)
      Add Shell(rm) to allowlist? (tab)
      Run Everything (shift+tab)
      Skip & tell the agent what to do instead (esc or n)
  ```
  `preToolUse` fires *before* the approval. Enter approves.
- **Workspace trust** (without `--trust`) shows `⚠ Workspace Trust Required` / `Do you trust the contents of this directory?`.
- **Logged out** shows `Press any key to log in...`, then `Signing in with the browser...`. `cursor-agent status` prints `✓ Logged in as …` or `Not logged in`.
- **No OSC 9;4 progress.** OSC 0 titles are `Cursor Agent` when idle and Cursor's own task title while working (e.g. `Shell Command Echo`). OSC 2 is `<dir> · <prompt> · <chat id>`.
- **Paste:** bracketed paste followed by `\r` is accepted as one multi-line prompt.

## Sessions
- **`cursor-agent create-chat`** prints a new chat ID in about 2s. Starting with `--resume <that id> -- "<prompt>"` delivers the prompt, and hooks report that ID as `conversation_id`. So the office knows the session ID before launch.
- **`--resume <unknown id>`** doesn't fail: it opens a fresh chat. There's nothing to detect.
- **User approval mode (`~/.cursor/cli-config.json` `approvalMode`) overrides CLI flags.** `unrestricted` means "Run Everything", which never prompts.

## Headless (`-p`)
`cursor-agent -p --trust --output-format json --model <m> '<prompt>'` prints one JSON line: `{type:"result", is_error, result:"<text>", session_id, usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}`. It takes about 11s and about 17k input tokens even for a tiny prompt, so it is too heavy to be the default task namer.

## Transcripts
They live at `~/.cursor/projects/<path-with-dashes>/agent-transcripts/<id>/<id>.jsonl`. Lines are `{role, message:{content:[text|tool_use]}}`, with no usage and no tool results. The office doesn't read them, because the `stop` hook already carries the tokens.
