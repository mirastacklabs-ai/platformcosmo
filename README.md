# PlatformCosmo

A Claude Code plugin and CLI that turns a prompt into an animated 2.5D isometric SVG
diagram for cloud, platform engineering, AI and data-center architectures. Claude writes
a JSON spec; a deterministic engine does all layout and drawing.

**Status: pre-alpha (M0, setup).** Nothing is usable yet. See [docs/PLAN.md](docs/PLAN.md).

## Development

Everything runs in containers, nothing is installed on the host:

```sh
scripts/pc install
scripts/pc run ci
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0, Copyright 2026 MiraStack Labs. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Trademarks

AWS, Azure, Google Cloud and other product names and marks belong to their respective
owners. PlatformCosmo is not affiliated with or endorsed by them. Provider icon packs are
not redistributed; users fetch them from the official source.

## Claude Code plugin (not functional until M4)

```
/plugin marketplace add mirastacklabs-ai/platformcosmo
/plugin install platformcosmo@platformcosmo
```

Shell equivalents:

```sh
claude plugin marketplace add mirastacklabs-ai/platformcosmo
claude plugin install platformcosmo@platformcosmo
```

On recent Claude Code versions a one-step form also works:
`/plugin install platformcosmo --marketplace mirastacklabs-ai/platformcosmo`.
