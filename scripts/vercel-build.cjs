#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("child_process");

if (!process.env.DATABASE_URL_UNPOOLED && process.env.DATABASE_URL) {
  process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (result.status) process.exit(result.status);
}

// Schema changes are applied with `npm run db:deploy` (prisma migrate deploy), never from this build.
run("npx", ["prisma", "generate"]);
run("npx", ["next", "build"]);
