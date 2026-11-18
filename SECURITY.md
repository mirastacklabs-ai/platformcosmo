# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: the **Security** tab of
[mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo)
-> **Report a vulnerability**. Do not open public issues for security problems.

## Supported versions

PlatformCosmo is pre-alpha. Only the latest published release (and `main`)
receives security fixes.

## Network policy

`@platformcosmo/core` and the `pcosmo` CLI make no network requests at runtime.
The only planned exception is `pcosmo icons add`, which downloads icon packs
only when the user explicitly runs it. Generated SVGs contain no external
references, and all labels are escaped.
