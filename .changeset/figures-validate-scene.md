---
"@platformcosmo/core": patch
"platformcosmo": patch
---

Figures in validate and the scene (assemblies track A2-F): image ids and references, figure parts and stages (selectors, timing, implode as the exact time reverse, step windows and compression), explode/implode actions on figures, `SceneFlatBoard`s with credits, and a did-you-mean on every figure diagnostic. Schema errors for oneOf values (assembly actions, programs, part images) now report the branch the data's own key, `kind` or type names, instead of "Not a valid ...". Figures still validate as `assembly/unsupported` until the figure renderer lands.
