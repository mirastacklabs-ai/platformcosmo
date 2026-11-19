---
"platformcosmo": patch
"@platformcosmo/core": patch
---

Icon packs added from a URL take the repository name as their id and print it with an example ref; derived names are sanitised and provider ids reserved (#52). Did-you-mean suggestions are bounded, so a 1 MB unknown key no longer stalls validation (#55).
