---
name: icons
description: Manage PlatformCosmo icon packs (list, search, add, remove), including AWS, Azure, GCP and CNCF icons and custom SVG packs. Run only on explicit request because adding a pack downloads files.
argument-hint: [add <aws|azure|gcp|cncf|url|./folder> | list | search <term> | remove <pack>]
disable-model-invocation: true
allowed-tools: Bash(pcosmo icons list*) Bash(pcosmo icons search *) Bash(pcosmo icons add *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs icons list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs icons search *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs icons add *)
---

# PlatformCosmo icons

Request: $ARGUMENTS

Turn the request into exactly **one** `pcosmo icons` subcommand from the table below, run it, and report the result.
With no request, run `pcosmo icons list`. Every command carries `--packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`: that
directory (`${CLAUDE_PLUGIN_DATA}/icons`, which survives plugin updates) is where user packs and
`platformcosmo-icons.lock.json` live. Bash commands do not see `CLAUDE_PLUGIN_DATA`, so always pass the flag.

## Mapping the request to one command

Never paste the raw request into a command line. Pick the row, then fill only the slots shown, using values you
validated (below).

| The user means                           | Command                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| list what is installed                   | `pcosmo icons list --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`                                           |
| find an icon                             | `pcosmo icons search <term> --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`                                  |
| AWS, Azure, GCP or CNCF icons            | `pcosmo icons add aws\|azure\|gcp\|cncf --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`                      |
| a zip of icons at an https URL           | `pcosmo icons add <url> --packs-dir ...`                                                                |
| a single SVG at an https URL             | `pcosmo icons add <url> --packs-dir ...`                                                                |
| an https page listing SVG files          | `pcosmo icons add <url> --packs-dir ...`                                                                |
| a local folder of SVGs plus `icons.json` | `pcosmo icons add ./dir --packs-dir ...`                                                                |
| remove a pack                            | `pcosmo icons remove <pack-id> --packs-dir ...` (needs the user's confirmation; it is not pre-approved) |

- Add `--id <kebab-case-id>` to any `add` when the user names the icon set (for example "add these as acme").
  The id matches `^[a-z][a-z0-9-]{0,31}$`; otherwise leave it out.
- `<url>` must start with `https://` and contain no spaces or shell characters; `<term>` and `<pack-id>` are single
  plain words (letters, digits, `-`, `_`, `.`, spaces inside quotes for a search phrase). If the request is unclear,
  ambiguous or does not fit one row, **ask the user** instead of guessing. Do not combine several commands.
- `list`, `search` and `add` are pre-approved; `remove` is not and will prompt.

## Rules

1. **Network:** only `add` with a provider id or URL touches the network, and only because the user asked. The CLI
   allows https to public addresses only, with size and time limits. If it refuses a URL, report the reason; do not
   try to work around it (no `curl`, no other hosts).
2. **Terms:** provider packs come with the provider's terms. `add` prints them. Show the full text to the user.
   Azure (and any pack that prints terms) installs only with `--accept-terms`. The gate for that flag is a **fresh
   user message agreeing to the terms you showed**: add the flag only after such a message. Never add it on the first
   run, never infer agreement from the original request, and never pass it on the user's behalf.
3. **No redistribution:** provider packs live in `${CLAUDE_PLUGIN_DATA}/icons` on the user's machine. Never copy them
   into a repository or commit them. Rendered diagrams that use the icons are fine to share.
4. **Integrity:** user packs are verified against a lockfile on every use. If `list` reports an integrity mismatch,
   tell the user and suggest removing the pack and adding it again.
5. After adding a pack, read the pack id that `add` printed (`installed <id> ...` and the example ref) and use refs of
   the form `<id>:<icon>`. Show 3 to 5 example refs from `pcosmo icons search <term> --pack <id> --packs-dir ...` so the
   user can use them as `icon: "<id>:<name>"` on a node.
6. **Pack ids:** without `--id`, a URL source gets the repository or file name as its id (for example
   `https://github.com/feathericons/feather/tree/main/icons` becomes `feather`). When the user names the set ("the
   Feather icon set"), pass `--id feather` so the id matches what they will ask for. An id that is already
   installed is an error: pick another `--id` instead of replacing it.
7. **Failures** are plain text on stderr with exit code 1 (never JSON, even with `--json`, which only changes the
   output of a successful `add`). Report the message to the user as it is.

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
