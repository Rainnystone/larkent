# Recreate a missing managed default workspace

When the profile already has `workspaces.default` in config, the bridge does not create that directory on start or on run. A missing managed default is rejected as `path-inaccessible`. Document comments already mkdir a managed fallback; IM does not.

Instance: 2026-11-13 15:47 (Asia/Shanghai), profile `devin`, after the 2026-11-11 home rebuild. Directory was created by hand at 15:54; this ticket is the product follow-up. Do not implement until a docs/code draft PR is opened.
