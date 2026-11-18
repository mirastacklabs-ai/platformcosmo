import { expect, test } from "vitest";
import schema from "../../../schema/v1.json" with { type: "json" };
import { equipmentTypes, slotTypes } from "../src/index.js";

test("DC types match the schema enums", () => {
  expect([...slotTypes]).toEqual(schema.$defs.dcSlotType.enum);
  expect([...equipmentTypes]).toEqual(schema.$defs.dcEquipmentType.enum);
});
