// Dump raw docs from a Foundry LevelDB pack, filtered by name regex.
import { ClassicLevel } from "classic-level";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const packDir = get("--pack");
const nameRe = new RegExp(get("--name", "."), "i");
const full = args.includes("--full");

const db = new ClassicLevel(packDir, { keyEncoding: "utf8", valueEncoding: "json" });
await db.open();
for await (const [key, value] of db.iterator()) {
  if (!value || typeof value !== "object") continue;
  const n = value.name || "";
  if (!nameRe.test(n)) continue;
  console.log("### KEY:", key, "| name:", n, "| type:", value.type);
  console.log(JSON.stringify(value, null, full ? 1 : 0).slice(0, full ? 200000 : 4000));
  console.log("");
}
await db.close();
