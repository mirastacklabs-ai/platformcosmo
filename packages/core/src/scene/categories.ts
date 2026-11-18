import type { NodeCategory, PrimitiveKind } from "../contracts/index.js";
import type { SpecNodeType } from "../schema/types.gen.js";

interface TypeInfo {
  readonly category: NodeCategory;
  readonly primitive: PrimitiveKind;
}

/** Semantic node type → theme palette bucket and solid (PLAN §8, all 41 v1 types). */
export const NODE_TYPES: Readonly<Record<SpecNodeType, TypeInfo>> = {
  server: { category: "compute", primitive: "cube" },
  vm: { category: "compute", primitive: "cube" },
  container: { category: "compute", primitive: "cube" },
  pod: { category: "compute", primitive: "hex-prism" },
  function: { category: "compute", primitive: "hex-prism" },
  lb: { category: "network", primitive: "slab" },
  gateway: { category: "network", primitive: "slab" },
  cdn: { category: "network", primitive: "hex-prism" },
  dns: { category: "network", primitive: "hex-prism" },
  firewall: { category: "network", primitive: "slab" },
  vpc: { category: "network", primitive: "platform" },
  sql: { category: "data", primitive: "cylinder" },
  nosql: { category: "data", primitive: "cylinder" },
  cache: { category: "data", primitive: "cylinder" },
  "object-store": { category: "data", primitive: "cylinder" },
  warehouse: { category: "data", primitive: "cylinder" },
  queue: { category: "data", primitive: "slab" },
  stream: { category: "data", primitive: "slab" },
  users: { category: "client", primitive: "hex-prism" },
  client: { category: "client", primitive: "cube" },
  mobile: { category: "client", primitive: "cube" },
  metrics: { category: "observability", primitive: "cube" },
  logs: { category: "observability", primitive: "cube" },
  traces: { category: "observability", primitive: "cube" },
  repo: { category: "cicd", primitive: "cube" },
  pipeline: { category: "cicd", primitive: "slab" },
  registry: { category: "cicd", primitive: "cube" },
  iam: { category: "security", primitive: "hex-prism" },
  secrets: { category: "security", primitive: "cube" },
  waf: { category: "security", primitive: "slab" },
  llm: { category: "ai", primitive: "cube" },
  embedding: { category: "ai", primitive: "cube" },
  "vector-db": { category: "ai", primitive: "cylinder" },
  gpu: { category: "ai", primitive: "cube" },
  "inference-server": { category: "ai", primitive: "cube" },
  agent: { category: "ai", primitive: "hex-prism" },
  tool: { category: "ai", primitive: "cube" },
  rag: { category: "ai", primitive: "cube" },
  guardrail: { category: "ai", primitive: "slab" },
  "feature-store": { category: "ai", primitive: "cylinder" },
  "training-job": { category: "ai", primitive: "cube" },
};

/** Height multiplier relative to the size-based object height. */
export const PRIMITIVE_HEIGHT: Readonly<Record<PrimitiveKind, number>> = {
  cube: 1,
  "hex-prism": 1,
  cylinder: 1,
  slab: 0.5,
  platform: 0.25,
};
