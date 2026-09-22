const { existsSync } = require("node:fs");
const { join } = require("node:path");

const built = join(__dirname, "..", "dist", "postinstall.js");
if (!existsSync(built)) {
  console.warn("pickcheck: package is not built; skipping binary download");
} else {
  import(built).then((module) => module.postinstall()).catch((error) => {
    console.warn(`pickcheck: binary download skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}
