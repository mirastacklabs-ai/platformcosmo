import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { validate } from "../src/index.js";

// Diagnostics of INVALID 1.1 specs must stay byte-identical: the oneOf discriminator (A2-F)
// applies only to the 1.2 unions (SpecAssemblyAction, SpecProgram, SpecPartImage). The fixture
// is the output of `main` before A2-F (metric value, flow, edge, legend maxItems, ...).
const base = {
  meta: { version: "1" },
  nodes: [
    { id: "a", type: "server" },
    { id: "b", type: "server" },
  ],
  edges: [{ id: "e", from: "a", to: "b" }],
};
const cases: Record<string, unknown> = {
  metric: { ...base, metrics: [{ id: "m", label: "M", value: "x".repeat(65) }] },
  metricType: { ...base, metrics: [{ id: "m", label: "M", value: true }] },
  flowMissingTo: { ...base, flows: [{ from: "a" }] },
  flowBoth: { ...base, flows: [{ edge: "e", from: "a" }] },
  flowEdges: { ...base, flows: [{ edges: "x" }] },
  flowEmpty: { ...base, flows: [{}] },
  flowKind: { ...base, flows: [{ from: "a", to: "b", kind: "nrmal" }] },
  legendMax: { ...base, legend: Array.from({ length: 51 }, () => ({ label: "l" })) },
  legendStr: { ...base, legend: "autoo" },
  legendItem: { ...base, legend: [{ label: "l", extra: 1 }] },
  stepFlow: { ...base, steps: [{ flows: [{ from: "a" }] }] },
};
const pinned = JSON.parse(
  readFileSync(new URL("./fixtures/oneof-1-1-main.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

test.each(Object.keys(cases))("1.1 oneOf diagnostics unchanged: %s", (name) => {
  const got = JSON.parse(JSON.stringify(validate(cases[name]).diagnostics)) as unknown;
  expect(got).toEqual(pinned[name]);
});
