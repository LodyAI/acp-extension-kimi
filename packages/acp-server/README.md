# Kimi ACP server

The ACP/Klient boundary translates native Kimi capabilities to standard ACP and
shared Lody extension contracts. Core defines the boolean `plan_mode` option;
`permission_mode` independently selects Default, Auto, or YOLO. Plan switches
preserve permission state. Restored sessions read both states from the runtime.
Legacy `mode` requests remain readable but Plan is not advertised as a permission.

When the client provides ACP file access, the filesystem adapter translates
resource-not-found (`-32002`) into native `ENOENT`. Plan status can then read a
new plan whose file has not been created yet as empty content, just as it does
with local file access. Other read errors still propagate. Protocol tests cover
repeated Plan switches with client file access and unchanged YOLO permissions.

Build the runtime with the matching `acp-extension-core` package before updating
Lody's checksummed managed-runtime manifest.
