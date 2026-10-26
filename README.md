# numfin-split-work

A Pi extension that turns your current session into a controller for small, persistent subagent tasks. Designed to save tokens: concise instructions, focused agent roles, short reports, and incremental requirements.

## Install

Requires Pi on `PATH` and configured access to your agents' models. Tested with Pi 1.4.0.

From a local checkout:

```sh
pi install /absolute/path/to/numfin-split-work
```

From GitHub:

```sh
pi install git:github.com/numfin/pi-split-work
```

Children explicitly load these packages (install/configure them in Pi before delegating):

```sh
pi install npm:@xynogen/pix-optimizer
pi install npm:pi-gpt-search
pi install npm:pi-openai-codex-compat
```

Restart Pi after installation. If you already installed `split-work` manually, move its folder out of `~/.pi/agent/extensions/` first to avoid loading two copies. Agent definitions and tracker data live in your projects, not that extension folder.

## Use it

Open Pi in your project. Create agents in plain language:

```text
/split-agent A coder for small backend changes using provider/model
/split-agent A reviewer that publishes findings in reviews
```

Replace `provider/model` with your configured model. You can specify a model preference, or provide a Markdown creation guide:

```text
/split-agent A frontend specialist --instructions ./agent-guide.md
```

Agent creation does **not** enable split mode. Discuss or plan work normally, then enable delegation in the same session:

```text
/split on
```

Now talk to the controller:

> Do A and B in parallel, review each, then do C.
>
> What is each agent doing? What is taking so long?
>
> Tell the agent working on A to skip the migration and focus on validation.

The controller delegates instead of implementing. It stays available while children work, wakes on completion/questions/failures, and routes the next step. Coding, review, and fixes share a task; accepted tasks archive individually and disappear from the footer.

Live steering reaches the same running session at its next safe boundary. It does **not** interrupt an active shell command. Status distinguishes queued, delivered, and unconfirmed steering; delivery is not proof that instructions were followed.

Restarted work appears paused. Enable split mode if necessary, then say **continue** to resume saved child sessions.

| Command | Purpose |
| --- | --- |
| `/split on` | Enable controller-only delegation |
| `/split off` | Restore normal tools; does not stop running children |
| `/split status` | Show mode and tracked task overview |
| `/split reset` | Confirm deletion of tracker/tasks/artifacts; keep agents and saved child sessions |
| `/split-agent <description>` | Ask this session to create a project-local agent |

### Optional LLM footer summaries

Disabled by default. Enable with an exact provider/model, period in seconds, and optional reasoning level (default `off`):

```text
/split summary on provider/model 30 off
/split summary status
/split summary off
/split summary on
```

The last command reuses saved settings; first enable requires model and period. Toggle or change settings without restarting. Reasoning levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; your model must support the chosen level.

Settings live in the project's `.pi/split-mode.json`; edits to `summary` also reload live:

```json
{
  "enabled": true,
  "summary": {
    "enabled": false,
    "provider": "provider",
    "model": "model",
    "intervalSeconds": 30,
    "reasoning": "off"
  }
}
```

The selected model receives compact snapshots of running agents' tool activity and public progress reports, **not private reasoning or full task context**. It does not interrupt or prompt subagents. One request batches changed activity (up to 40 agents); unchanged snapshots and idle periods cost no calls. Results replace footer labels with one sentence, at most 10 words, without renaming tasks. Original labels return when disabled. Invalid/failed responses keep the previous label.

## Agent definitions

Agents are always project-local: `.pi/my-agents/<name>.md`.

```md
---
description: Review small changes for bugs and missing tests.
model: provider/model
think: low
artifact: reviews
---
Review only the assigned scope. Report actionable findings with file paths.
Keep output minimal. Do not implement fixes.
```

`model` is an exact provider/model ID. `think` selects a thinking level supported by that model. Optional `artifact` names the folder where `split_artifact` publishes numbered notes, such as `reviews/0001.md`. Omit it for agents that only need to return a short overview.

## How it works

- Controller uses `split_work` to manage tasks, dispatch/resume/pause/steer children, inspect status, and archive accepted work.
- Children run as background Pi RPC processes, with a persistent session per agent/task pair. They share the project working directory.
- `.pi/tracker/<timestamp>-<task-name>-<suffix>/` holds immutable `instructions.md`, `acceptance.md`, append-only `requirements/0001.md`, optional artifact folders, and mutable `state.json`.
- Agents ask the extension for task context instead of reading tracker Markdown directly. Findings go through the controller; other agents do not automatically inherit artifacts.
- New requirements travel as deltas when steering. Agents must keep tasks, artifacts, and reports concise, and must not edit documentation.
- Footer shows active agent/task rows with working animation, elapsed minutes, paused/question states. Status exposes current tool activity and recent durations, not private reasoning.

## MVP limits

Use one controller per project. Parallel agents share files: avoid overlapping edits. Guards are not a shell sandbox; use trusted agents and review their changes. Children load split-work plus the three packages listed above; unrelated extensions and MCP servers stay disabled. Their model-specific settings and credentials still apply. Saved child sessions survive tracker reset.

## Development

```sh
npm test
pi --no-extensions --extension ./src/index.ts
```

Tests cover tracking, child packages/tools and guards, summary configuration, batching, cancellation, and output limits. The extension loads directly as TypeScript; no build step.
