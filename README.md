# PlatformCosmo

A Claude Code plugin and CLI that turns a prompt into an animated 2.5D isometric SVG
diagram for cloud, platform engineering, AI and data-center architectures. Claude writes
a JSON spec; a deterministic engine does all layout and drawing. The SVG animates with
no JavaScript and works in `<img>`, inline and `<object>`.

**Status: pre-release (v1 feature-complete, not yet published to npm).**

## Quick start

You need [Claude Code](https://code.claude.com) and Node.js >= 22.12 on your `PATH`
(the plugin ships a self-contained `pcosmo` CLI; nothing else is installed).

1. Add the marketplace and install the plugin (inside Claude Code):

   ```
   /plugin marketplace add mirastacklabs-ai/platformcosmo
   /plugin install platformcosmo@platformcosmo
   ```

   Or from a shell:

   ```sh
   claude plugin marketplace add mirastacklabs-ai/platformcosmo
   claude plugin install platformcosmo@platformcosmo
   ```

2. Ask for your first diagram:

   ```
   /platformcosmo:diagram A load balancer sending user traffic round-robin to three app servers backed by a database, with health checks and a failover step when one server goes down
   ```

   Or attach a screenshot, exported diagram or whiteboard photo and ask Claude to draw it as a PlatformCosmo diagram.

   Claude writes a `<name>.cosmo.json` spec in your working directory, validates it,
   builds it, and reports the output paths: `<name>.svg` (animated, looping), plus any
   extras you ask for (`--static`, `--steps`, `--png`, `--theme dark`).

3. Re-export, including GIF, MP4 (needs ffmpeg) and the interactive Play/Step SVG:

   ```
   /platformcosmo:export <name>.cosmo.json --gif --interactive --theme blueprint
   ```

4. Optional: add icons. Bundled: PlatformCosmo, Lucide, Kubernetes and a permissive
   subset of Simple Icons (276 icons). Add more on your own machine:

   ```
   /platformcosmo:icons add aws
   /platformcosmo:icons add https://github.com/feathericons/feather/tree/main/icons
   ```

   The second adds a pack named `feather`; then ask for, say, "the Feather users icon for
   the users node" and Claude uses `feather:users`.

   Provider packs (AWS, Azure, Google Cloud) are downloaded from the official source on
   your machine and never redistributed. Azure requires accepting its terms.

The CLI is also on the Bash `PATH` while the plugin is enabled: `pcosmo --help`.

## Gallery and docs

Rendered examples live in [`examples/gallery/`](examples/gallery); specs are in
[`examples/`](examples). The docs site sources are in [`docs/`](docs)
(`scripts/pc run docs:build`).

## Development

Everything runs in containers; nothing is installed on the host:

```sh
scripts/pc install
scripts/pc run ci
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/PLAN.md](docs/PLAN.md) and
[DECISIONS.md](DECISIONS.md).

## License

Apache-2.0, Copyright 2026 MiraStack Labs. See [LICENSE](LICENSE), [NOTICE](NOTICE),
[LICENSES/](LICENSES) and [plugin/THIRD_PARTY_NOTICES.md](plugin/THIRD_PARTY_NOTICES.md).

## Trademarks

AWS, Azure, Google Cloud, Kubernetes and other product names, logos and marks belong to
their respective owners. PlatformCosmo is not affiliated with or endorsed by them. Provider
icon packs are not redistributed; users fetch them from the official source.
