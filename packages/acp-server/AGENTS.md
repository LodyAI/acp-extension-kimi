# acp-server Agent Guide

Package-local rules for `packages/acp-server`.

- Keep Lody integration at this ACP/Klient edge. Agent core services remain
  provider-neutral and must not import Lody contracts.
- Translate ACP resource-not-found file reads to native `ENOENT` at the filesystem
  edge. Preserve other errors; never infer missing files from error-message text.
- Import shared Lody contracts from `acp-extension-core`, advertise each supported
  feature under `_meta.lody`, and use `_lody/...` only where ACP has no standard method.
- Usage notifications may contain token counters, quota windows, and wallet totals,
  but never credentials, authorization output, or unbounded task output.
- Scope token totals to the current ACP activation. Establish a baseline on resume so
  historical Kimi usage is not billed again, while retaining per-model/subagent totals.
  Tag every update with the activation's random `_meta.lody.usageScopeId`; a new
  activation counts from zero and must never reuse an earlier scope.
- Usage delta is already included in activation totals. Serialize accounting emissions
  and advance the delta baseline only after successful notification delivery.
- Subagent mutation requests require a live ACP session and use the engine task registry
  as the authoritative source for list, cancellation, lifecycle, and bounded output.
- Negotiated Core run events observe registry-owned child streams at this edge.
  Mark missing replay coverage incomplete; attribute child permissions explicitly.
  Do not equate run IDs with legacy task IDs or count progress as billed usage.
- `session/update` covers EVERY turn of the session's main agent, including turns the
  engine opens on its own (a finished detached subagent's notification, a cron fire).
  The prompt driver decides when `session/prompt` answers, never who may speak: gating
  content on the driver's turn silently drops the agent's reply to background work.
- A prompt stays in flight while subagent tasks it started are still running, and across
  the gap until the wake turn reporting a terminated one arrives. That is what reports
  the conversation as still working; only cancel, an auth failure, or a drained agent
  settles it early.
- ACP `title` is human-facing, so the canonical tool name travels in
  `_meta.lody.toolName`. Clients that treat specific tools specially (scheduling cards read
  the cron expression out of `rawInput`) must be able to identify the tool without
  parsing prose.
- The ACP-backed process service forwards every executable/argument pair through
  `terminal/*`; Glob and Grep need non-shell `rg` processes. Only a recognized Bash
  tool invocation emits the terminal-created event used to attach a terminal tool card.
- Fork positions are persistent engine turn IDs. Publish the native ID on visible
  user turns, preserving gaps for background turns and cancelled reservations.
  Replayed prompts resolve IDs through durable prompt IDs and the same engine
  records used by `fork({ turnIndex })`; steered messages share their owning turn.
  Legacy context-only records retain their old positions only when unambiguous.
  Omit a position when it cannot be resolved safely.

- Declare Core `sessionTitle` only for a configured native OAuth title provider.
  Accepted prompt launches trigger native generation without blocking the turn;
  metadata updates retain generated/custom/replaceable provenance as Core
  generated/explicit/fallback title sources. Never force generation over a user name.

- Standard ACP `systemPrompt` customizes the session's main-agent profile at this edge. Validate before activation, rebuild each customization from the catalog profile, preserve tools and permissions, and reject changes while the session is busy.

- Core archive and restore target the stored native ID through the engine lifecycle service. Reject sessions still attached to this connection and publish list changes before acknowledging success.

- ACP new, cold load/resume and fork hold the native main loop through activation. Bind the ACP environment before restored work can execute, and release the existing quiescence hold only after output subscriptions and usage baselines are ready. Native restoration outside ACP retains local execution.
