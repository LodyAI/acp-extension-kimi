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
