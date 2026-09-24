# Kimi ACP server

The ACP/Klient boundary translates native Kimi capabilities to standard ACP and
shared Lody extension contracts. Core defines the boolean `plan_mode` option;
`permission_mode` independently selects Default, Auto, or YOLO. Plan switches
preserve permission state. Restored sessions read both states from the runtime.
Legacy `mode` requests remain readable but Plan is not advertised as a permission.

Plan submissions emit ACP `plan_update` Markdown when the client advertises
the experimental `plan` capability. Each submission has a tool-call-scoped plan
ID; TodoList continues to emit the stable `plan` checklist update. ExitPlanMode uses
`switch_mode` so clients can render their dedicated plan/approval cards. Approval
content remains available to older clients. Leaving Plan does not remove a
submitted document from the conversation. This projects live submissions; native
context-only session replay does not reconstruct historical review documents.

When the client provides ACP file access, the filesystem adapter translates
resource-not-found (`-32002`) into native `ENOENT`. Plan status can then read a
new plan whose file has not been created yet as empty content, just as it does
with local file access. Other read errors still propagate. Protocol tests cover
repeated Plan switches with client file access and unchanged YOLO permissions.

Build the runtime with the matching `acp-extension-core` package before updating
Lody's checksummed managed-runtime manifest.

## Session titles

With a configured managed Kimi OAuth provider, initialize advertises Core 0.1.7's
`_meta.lody.sessionTitle: { version: 1 }`. Accepted prompts request the engine's
native title service without delaying the turn. The service deduplicates requests
and preserves generated/custom titles; failure leaves the current title intact.
ACP title updates carry `titleSource`: generated, explicit (custom), fallback
(replaceable preview), or unset. API-key-only configurations do not advertise
title generation, so clients can retain their own generator.
