#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const processGroupFile = process.env.MCP_FIXTURE_PROCESS_GROUP_FILE;
const grandchildFile = process.env.MCP_FIXTURE_GRANDCHILD_FILE;
if (!processGroupFile || !grandchildFile) process.exit(64);

const grandchild = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(processGroupFile, String(process.pid));
writeFileSync(grandchildFile, String(grandchild.pid));
setInterval(() => {}, 1_000);
