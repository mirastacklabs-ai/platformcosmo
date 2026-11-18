import { expect, test } from "vitest";
import schema from "../../../schema/v1.json" with { type: "json" };
import { themeNames } from "../src/index.js";

test("theme names match the schema canvas.theme enum", () => {
  expect([...themeNames]).toEqual(schema.properties.canvas.properties.theme.enum);
});
