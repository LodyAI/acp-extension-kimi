# Kimi ACP server

The ACP/Klient boundary translates native Kimi capabilities to standard ACP and
shared Lody extension contracts. Core defines the boolean `plan_mode` option;
`permission_mode` independently selects Default, Auto, or YOLO. Plan switches
preserve permission state. Restored sessions read both states from the runtime.
Legacy `mode` requests remain readable but Plan is not advertised as a permission.

Build the runtime with the matching `acp-extension-core` package before updating
Lody's checksummed managed-runtime manifest.
