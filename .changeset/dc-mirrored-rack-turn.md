---
"@platformcosmo/dc-pack": patch
"platformcosmo": patch
---

Racks in mirrored rows (a row facing the other way, such as row B of the data-center hall) are now drawn as the half turn they are, instead of only reflecting y: the rear posts swap sides, the PDU stands behind the rear door's stile instead of showing through it, and the rear-door heat exchanger hangs between the posts. This is a visual change for specs with mirrored rows (the `dc-hall` and `hall-to-heatsink` examples; their gallery renders and visual goldens are regenerated); racks in unmirrored rows are byte-identical.
