import { expect, test } from "vitest";
import { iconPack } from "../src/index.js";

test("icons-base stub exports an empty pack", () => {
  expect(iconPack.name).toBe("icons-base");
  expect(iconPack.icons).toEqual([]);
});
