// Copies the game into public/ as the site's index page, and makes sure the
// online server sits where Netlify looks for functions.
//
// In this folder the files live at src/index.html and
// netlify/functions/player.mjs. GitHub's upload page flattens folders, so a
// repository filled through it ends up with index.html and player.mjs at the
// top level instead. Both layouts build the same site. If both copies of a file
// exist, the build stops rather than guess which one is current.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

function locate(what, nested, flat) {
  const hasNested = existsSync(nested), hasFlat = existsSync(flat);
  if (hasNested && hasFlat) {
    console.error(`Found both ${nested} and ${flat}. Delete the one you are not using, then deploy again.`);
    process.exit(1);
  }
  if (!hasNested && !hasFlat) {
    console.error(`No ${what} found. Expected ${nested}, or ${flat} at the top level.`);
    process.exit(1);
  }
  return hasNested ? nested : flat;
}

const page = locate("game", "src/index.html", "index.html");
mkdirSync("public", { recursive: true });
copyFileSync(page, "public/index.html");
console.log(`built public/index.html from ${page}`);

const server = locate("online server", "netlify/functions/player.mjs", "player.mjs");
if (server === "player.mjs") {
  mkdirSync("netlify/functions", { recursive: true });
  copyFileSync("player.mjs", "netlify/functions/player.mjs");
  console.log("put player.mjs in netlify/functions");
}
