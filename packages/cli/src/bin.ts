#!/usr/bin/env node
import { run } from "./index.js";

const r = run(process.argv.slice(2));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
