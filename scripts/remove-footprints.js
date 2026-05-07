import fs from "fs";

const toDelete = "node_modules/lucide-react/dist/esm/icons/footprints.js";
const toStrip  = [
  "node_modules/lucide-react/dist/esm/lucide-react.js",
  "node_modules/lucide-react/dist/esm/icons/index.js",
];

if (fs.existsSync(toDelete)) {
  fs.unlinkSync(toDelete);
  console.log("[postinstall] removed footprints.js");
}

for (const file of toStrip) {
  if (!fs.existsSync(file)) continue;
  const original = fs.readFileSync(file, "utf8");
  const stripped = original.split("\n").filter(l => !/footprints/i.test(l)).join("\n");
  if (stripped !== original) {
    fs.writeFileSync(file, stripped, "utf8");
    console.log(`[postinstall] stripped footprints export from ${file}`);
  }
}
