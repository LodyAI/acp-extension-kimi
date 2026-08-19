# acp-server Agent Guide

Package-local rules for `packages/acp-server`.

- Keep Lody integration at this ACP/Klient edge. Agent core services remain
  provider-neutral and must not import Lody contracts.
- Advertise the versioned `lody.ai/kimi` capability before using any Lody extension.
  Custom JSON-RPC method names begin with `_`; standard ACP remains the fallback.
- Usage notifications may contain token counters, quota windows, and wallet totals,
  but never credentials, authorization output, or unbounded task output.
- Scope token totals to the current ACP activation. Establish a baseline on resume so
  historical Kimi usage is not billed again, while retaining per-model/subagent totals.
- Subagent mutation requests require a live ACP session and use the engine task registry
  as the authoritative source for list, cancellation, lifecycle, and bounded output.
- `session/update` covers EVERY turn of the session's main agent, including turns the
  engine opens on its own (a finished detached subagent's notification, a cron fire).
  The prompt driver decides when `session/prompt` answers, never who may speak: gating
  content on the driver's turn silently drops the agent's reply to background work.
- A prompt stays in flight while subagent tasks it started are still running, and across
  the gap until the wake turn reporting a terminated one arrives. That is what reports
  the conversation as still working; only cancel, an auth failure, or a drained agent
  settles it early.
- ACP `title` is human-facing, so the canonical tool name travels in a provider-neutral
  `_meta.toolName`. Clients that treat specific tools specially (scheduling cards read
  the cron expression out of `rawInput`) must be able to identify the tool without
  parsing prose.
- Fork positions are engine positions. The engine addresses `fork({ turnIndex })` by
  counting user-visible turns in the durable records, so the `_meta.lody.turnId` this
  server publishes IS that index, anchored per activation from `session.forkTurns()` and
  advanced only by turns the engine would count — a wake or cron turn must never consume
  one. Never derive a position from rendered history: compaction drops messages from
  context while the records defining these positions stay. A turn that cannot be matched
  to a record position is published without one; forking the wrong turn is worse than
  not offering the branch.
