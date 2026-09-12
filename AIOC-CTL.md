# aioc-ctl — a guide for agents

This file is written for AI agents (Claude Code, Codex, Pi) that run inside [Aioc](README.md) and want to work with the **other** sessions in the same window: read what they show, hand them a task, wait for the result, answer a question they ask.

You are inside Aioc when the environment variable `AIOC_SESSION` is set (it holds your own session ID). Then `aioc-ctl` is on your `PATH`. Outside Aioc it works too, as long as the Aioc daemon runs on this machine: `node <aioc>/cli/aioc-ctl.js …`.

## Ground rules

- **Only touch sessions the user pointed you to.** Everything you send is visible to the user: the event feed shows `Prompt von <your session>: …` and `Tasten von <your session>: …`.
- **Never answer another agent's permission prompt or question on your own authority.** Approving a dialog runs whatever that agent asked for. Read the dialog, tell the user what it asks, and send keys only once the user has said how to answer.
- **Do not send prompts or keys to `self`.** Your own terminal is busy with your current turn. Use `self` only to read your own terminal (`aioc-ctl read self`).
- **The token is full access to the machine.** The API answers on `127.0.0.1` only and needs the token from `daemon.json`. Never copy it into files, prompts or output.

## Commands

| Command | What it does |
| --- | --- |
| `aioc-ctl list [--json]` | All sessions: ID, status, agent, name, working folder with git state, detail. Your own session is marked `*`. |
| `aioc-ctl read <s> [--lines N \| --all]` | Terminal content as plain text — last 60 lines by default, `--all` the whole scrollback (up to 8000 lines). |
| `aioc-ctl read <s> --answer` | The agent's last final answer (Claude Code and Codex only). |
| `aioc-ctl prompt <s> <text…> [--no-enter] [--wait [--timeout S]]` | Type the text and submit it; `-` as the only text reads it from stdin. |
| `aioc-ctl key <s> <key…>` | Send keys, e.g. `down enter`, `esc`, `ctrl+c`. |
| `aioc-ctl wait <s> [--until a,b] [--timeout S]` | Block until the session reaches one of the states. |

`--json` works on every command and gives English field names; the plain output (table headings, status lines) is German.

### Addressing a session

`<s>` is matched in this order: exact ID, exact name (case-insensitive), start of an ID, part of a name. If a step matches more than one session, the command fails and lists the candidates. Names change — the user renames sessions, agents run `/rename` — so in anything longer than a one-off, take the ID from `aioc-ctl list` and use that.

### Statuses

| Status | Meaning |
| --- | --- |
| `starting` | Process launched, agent not ready yet. **Codex stays here until its first prompt** — you can prompt it anyway. |
| `running` | Working on a turn. For PowerShell: output is flowing. |
| `waiting` | Stopped with a question, permission prompt or approval overlay. Needs an answer. |
| `done` | Turn finished. `detail` holds the first line of the answer. |
| `idle` | Ready, nothing to do. For PowerShell: 3 seconds without output. |
| `exited` | Process ended — also sessions listed as *vor Neustart* after a reboot. They cannot receive input; the user restores them in the window. |

`list --json` adds: `running` (process alive), `unread`, `seq` (counts status changes), `agentSessionId`, `cwd` (start folder), `workCwd` and `workGit` (where the agent actually works now, reported by its hooks), `git` (state of the start folder: `branch`, `changed`, `untracked`, `conflicts`, `ahead`, `behind`, `root`).

### `read`

Plain text without colors; lines the terminal wrapped are joined again, trailing empty lines are dropped. In a full-screen TUI you get the visible screen. Exited sessions can be read too (from the saved scrollback).

`--answer` returns the final message the agent reported in its `Stop` hook — complete, not cut to the terminal width. It exists for **Claude Code and Codex** only, and is cleared as soon as a new prompt is submitted. For Pi and PowerShell, read the terminal instead.

### `prompt`

The text is sent as a bracketed paste and Enter follows separately, so a multi-line text stays **one** prompt. `--no-enter` only types it. A session that is not running fails with an error.

With `--wait`, `prompt` blocks until the session stops working (`waiting`, `done`, `idle` or `exited`) and prints `<name>: <status> · <detail>`. If the status is `done` and the agent is Claude Code or Codex, the full answer follows after an empty line. `--json` returns the session fields plus `answer` and `timedOut`.

`--wait` never picks up the *previous* turn's `done`: it only accepts a status change after the prompt, and only once the agent has actually started working. If nothing starts within 15 seconds (say the text landed in a shell that prints nothing), the next status change counts.

### `key`

Key names: `enter` `esc` `tab` `shift+tab` `space` `backspace` `delete` `up` `down` `left` `right` `home` `end` `pgup` `pgdn` `ctrl+<letter>`, or any single character. Keys go out one by one, 60 ms apart, so `esc` followed by another key is not read as Alt+key. Arrow keys follow the terminal's cursor mode automatically.

### `wait`

Default states: `waiting,done,idle,exited`. If the session is already in one of them, `wait` returns at once — so `aioc-ctl wait <s>` right after a plain `prompt` (without `--wait`) still waits for the new turn, because the prompt marks the session as busy until it starts working.

There is no need to loop yourself: the CLI keeps asking the daemon in chunks of up to four minutes until the state is reached or `--timeout` runs out.

### Exit codes

`0` ok · `1` error (unknown or ambiguous session, session not running, daemon not reachable) · `2` wrong usage · `124` timeout — the output then starts with `Zeitlimit erreicht –` and shows the current status.

## Patterns

**Hand a task to another session and collect the answer** (PowerShell):

```powershell
@'
Run the failing tests in tests/api and name the root cause in two sentences. Do not change any code.
'@ | aioc-ctl prompt tests - --wait --timeout 540
```

Look at the first line: `…: done` → the answer follows. `…: waiting` → the agent asks something (next pattern). Exit code `124` → still working; call `aioc-ctl wait tests --timeout 540` again, then `aioc-ctl read tests --answer`.

**The other session asks a question:**

```powershell
aioc-ctl read tests --lines 40      # show the dialog
# tell the user what it asks and wait for their decision, then e.g.:
aioc-ctl key tests down enter
aioc-ctl wait tests --timeout 540
aioc-ctl read tests --answer
```

**Several sessions in parallel** (bash):

```bash
aioc-ctl prompt frontend - < task-frontend.md
aioc-ctl prompt backend  - < task-backend.md
aioc-ctl wait frontend --timeout 540; aioc-ctl wait backend --timeout 540
aioc-ctl read frontend --answer
aioc-ctl read backend --answer
```

**Filter sessions** (PowerShell):

```powershell
aioc-ctl list --json | ConvertFrom-Json | Where-Object status -eq 'waiting' | Select-Object id, name, detail
```

## Pitfalls

- **Your own tool timeout.** If your shell tool kills commands after a few minutes, keep `--timeout` below that limit and call `wait` again on exit code `124` — a killed `aioc-ctl` does not stop the other agent, but you lose the answer output.
- **Git Bash rewrites leading slashes.** In Git Bash an argument starting with `/` — `/review`, `/rename Foo` — arrives as `C:/Program Files/Git/review`. Send slash commands through stdin (`echo '/review' | aioc-ctl prompt s -`) or prefix the call with `MSYS_NO_PATHCONV=1`.
- **Quoting.** Text with quotes, `$`, backticks or line breaks belongs on stdin: a PowerShell here-string `@'…'@` or a bash heredoc `<<'EOF'`.
- **Prompting a busy agent.** Aioc types immediately; the agent treats it like input typed during its turn (usually queued as the next message), and `--wait` may then return when the *current* turn ends. Unless you mean to interject, `aioc-ctl wait <s>` first.
- **PowerShell sessions** have no hooks. `idle` only means three seconds without output, so a long, quiet command looks finished — check the output with `read --lines` and look for the prompt line. There is no `--answer`.
- **Pi** has no `--answer` either; read the terminal.

## The HTTP API underneath

`aioc-ctl` is a thin client. The same calls work directly — loopback only, header `Authorization: Bearer <token>`, port and token from `%USERPROFILE%\.aioc\daemon.json` (or `AIOC_HOME`):

| Call | Parameters |
| --- | --- |
| `GET /api/sessions` | — |
| `GET /api/read` | `session`, `lines` (`0` = all, default 60) or `answer=1` |
| `POST /api/prompt` | JSON `{ session, text, enter, from }` → session fields plus `seq` |
| `POST /api/keys` | JSON `{ session, keys: [...], from }` → session fields plus `seq` |
| `GET /api/wait` | `session`, `until` (comma-separated), `after` (the `seq` from prompt/keys), `timeout` in ms (at most 240000 per request) → session fields plus `timedOut` |
