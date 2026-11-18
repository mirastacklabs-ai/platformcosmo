# Data-center specs (spec revision 1.1)

Vendor-neutral, parametric components: racks in U (1U = 44.45 mm), a 600 mm floor tile grid, generic shapes with
text labels. Needs the data-center pack (bundled with the CLI). Full example: `pcosmo examples show dc-hall`.

## racks[]

`id` (required), `label`, `u` (`42 | 45 | 48`), `pos`, `state`, `pdu` (`none | single | dual`),
`rearDoorHeatExchanger` (bool), `slots[]`.

Slot: `at` (the U position, 1..48), `type` (required), `id` (defaults to `u<at>`), `size` (rack units, defaults to the
device height), `label`, `state`. Slots must not overlap and must fit the rack.

Slot types: `server-1u`, `server-2u`, `server-4u`, `blade-chassis`, `gpu-node`, `switch-tor`, `switch-leaf`,
`switch-spine`, `patch-panel`, `storage-shelf`, `storage-flash`, `storage-jbod`, `pdu-1u`, `ups-2u`, `blank`.

## equipment[]

Floor equipment: `id`, `type` (`ups`, `busway`, `pdu-floor`, `crah`, `in-row-cooler`, `cdu`, `tape-library`), `label`, `pos`, `state`.

## rows[], aisles[]

- Row: `id`, `members` (rack and equipment ids, in order), `label`. Facing is derived from the aisle a row bounds; leave `facing` out unless the row has no aisle.
- Aisle: `id`, `kind` (`cold | hot`), `rows` (one or two row ids bounding it), `contained` (bool), `label`.

## cables[]

`from`, `to` (endpoints: object id or `rackId/slotId`), `id`, `kind` (`power | network | fiber | management`), `label`.
Routing and colors are automatic.

## facility

`raisedFloor`, `perforatedTiles` (bool), `cableTrays` (`none | overhead | underfloor`).

## Flows and steps

- Flow kinds `airflow` (cold aisle to hot aisle) and `power` (utility to UPS to PDU to server) work on cables,
  endpoints and equipment.
- Zoom story: use steps with `focus`: hall, then a row id, then a rack id, then `rack/slot`.
- The hall group is `dc_hall`. Slot ids in SVG ids replace `/` with `.`, but in the spec always write `rack/slot`.
