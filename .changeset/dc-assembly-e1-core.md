---
"@platformcosmo/core": patch
---

The A2-3 program planner now also resolves a rack in assembly mode (`source: "dc"`): rack and slot owners, the pack's built-in `drawers` and slot `internals` bodies through a `synthetic` option, and a cover given `drawer` leaves along its own outward normal. `AssemblyPrograms` and `reassignSplit` are exported (internal API) for the DC pack. Spec assemblies are unchanged.
