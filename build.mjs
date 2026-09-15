// Copies the game into public/ as the site's index page.
// src/index.html is the source of truth for the deployed site.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

mkdirSync("public", { recursive: true });
if (!existsSync("src/index.html")) {
  console.error("src/index.html is missing - copy Driver.html there first");
  process.exit(1);
}
copyFileSync("src/index.html", "public/index.html");
console.log("built public/index.html");
