---
name: icons
description: Manage PlatformCosmo icon packs (list, search, add, remove), including AWS, Azure, GCP and CNCF icons and custom SVG packs. Run only on explicit request because adding a pack downloads files.
argument-hint: [add <aws|azure|gcp|cncf|url|./folder> | list | search <term> | remove <pack>]
disable-model-invocation: true
allowed-tools: Bash(pcosmo icons *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs icons *)
---

# PlatformCosmo icons

Run `pcosmo icons $ARGUMENTS` (with no arguments, run `pcosmo icons list`) and report the result.

## Subcommands

| Command                                  | Does                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `pcosmo icons list`                      | Installed packs: bundled and user                             |
| `pcosmo icons search <term>`             | Fuzzy search; prints `pack:name` refs usable as a node `icon` |
| `pcosmo icons add aws`                   | Download the AWS architecture icons from AWS to this machine  |
| `pcosmo icons add azure --accept-terms`  | Same for Azure; the terms must be accepted                    |
| `pcosmo icons add gcp` / `cncf`          | Google Cloud / CNCF artwork                                   |
| `pcosmo icons add ./my-icons`            | A folder of SVGs plus an `icons.json` manifest                |
| `pcosmo icons add https://host/pack.zip` | A zip or SVG from an https URL                                |
| `pcosmo icons remove <pack>`             | Remove a user pack (bundled packs cannot be removed)          |

## Rules

1. **Network:** only `add` with a provider id or URL touches the network, and only because the user asked.
   The CLI allows https to public addresses only, with size and time limits. If it refuses a URL, report the
   reason; do not try to work around it (no `curl`, no other hosts).
2. **Terms:** provider packs come with the provider's terms. `add` prints them. Show the text to the user. For
   Azure, run with `--accept-terms` only after the user has agreed. Never pass `--accept-terms` on their behalf.
3. **No redistribution:** provider packs live in the user's own pack directory (`~/.platformcosmo/icons`, or the
   plugin data directory when the plugin provides one). Never copy them into a repository or commit them.
   Rendered diagrams that use the icons are fine to share.
4. **Integrity:** user packs are verified against a lockfile on every use. If `list` reports an integrity mismatch,
   tell the user and suggest `pcosmo icons remove <pack>` followed by adding it again.
5. After adding a pack, show 3 to 5 example refs from `pcosmo icons search <term>` so the user can use them in
   `icon: "pack:name"` on a node.

## Custom pack format

A folder with SVG files and `icons.json`:

```json
{
  "manifestVersion": 1,
  "pack": {
    "id": "acme",
    "name": "Acme icons",
    "version": "1.0.0",
    "license": "MIT",
    "source": "https://example.com/acme-icons",
    "redistributable": true
  },
  "icons": [
    {
      "id": "gateway",
      "aliases": [],
      "category": "network",
      "file": "svg/gateway.svg",
      "monochrome": false
    }
  ]
}
```

Pack ids are lowercase kebab-case (up to 32 characters). `file` paths are relative, use forward slashes and stay
inside the folder. Every SVG is sanitized on use (scripts, event handlers and external references are removed).
