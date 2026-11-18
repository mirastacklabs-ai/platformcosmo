# Icons

Every node type has a default glyph. The `icon` field overrides it with a pack icon:

```json
{ "id": "db", "type": "sql", "icon": "aws:rds", "label": "Orders DB" }
```

## Bundled packs

Original PlatformCosmo glyphs (Apache-2.0), Lucide, Kubernetes icons and a filtered set of Simple Icons. Only icons
under permissive, redistributable licenses are bundled, and each one records its license.

## Provider packs

AWS, Azure and GCP architecture icons, and CNCF artwork, are not redistributed. `pcosmo icons add aws` downloads
them from the official source to your machine and shows the provider's terms first:

```sh
pcosmo icons add aws
pcosmo icons add azure --accept-terms   # Azure requires accepting its terms
pcosmo icons add gcp
pcosmo icons search "load balancer"
```

Provider terms allow using these icons in architecture diagrams, training and documentation; see each provider's terms. The packs themselves stay in your user directory
(`~/.platformcosmo/icons`) and should not be committed or redistributed.

## Custom packs

A folder of SVGs plus an `icons.json` manifest:

```sh
pcosmo icons add ./my-icons
pcosmo icons add https://example.com/icons.zip
```

```json
{
  "manifestVersion": 1,
  "pack": {
    "id": "acme",
    "name": "Acme",
    "version": "1.0.0",
    "license": "MIT",
    "source": "https://example.com",
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

## Safety

- Downloads use https only, public addresses only (loopback, private, link-local, carrier-grade NAT, multicast and
  cloud-metadata addresses are refused on every redirect hop), at most 5 redirects, with size and time limits.
- Every SVG is sanitized: scripts, event handlers, `foreignObject` and external references are removed.
- Each installed pack is recorded in `platformcosmo-icons.lock.json` with an integrity hash. A pack whose files
  changed on disk is not loaded; remove and add it again.

`add` is the only command that uses the network.

## Trademarks

AWS, Azure, Google Cloud, Kubernetes and the brands in Simple Icons are trademarks of their owners; use does not imply endorsement.
