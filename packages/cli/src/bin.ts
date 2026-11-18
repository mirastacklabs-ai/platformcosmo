#!/usr/bin/env node
import { defaultDeps, run } from "./index.js";

const ac = new AbortController();
process.once("SIGINT", () => ac.abort());
process.once("SIGTERM", () => ac.abort());

const r = await run(process.argv.slice(2), {
  ...defaultDeps(),
  signal: ac.signal,
  io: {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
  },
});
process.exitCode = r.code;
