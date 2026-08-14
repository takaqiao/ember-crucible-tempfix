// Find docs in a pack whose JSON contains a given key with a non-empty value.
import { ClassicLevel } from "classic-level";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const packDir = get("--pack");
const key = get("--key");
const label = get("--label", packDir);

const db = new ClassicLevel(packDir, { keyEncoding: "utf8", valueEncoding: "json" });
await db.open();
for await (const [k, doc] of db.iterator()) {
  if (!doc || typeof doc !== "object") continue;
  const found = [];
  const walk = (o, p) => {
    if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${p}[${i}]`));
    else if (o && typeof o === "object") {
      for (const [kk, v] of Object.entries(o)) {
        if (kk === key && v !== null && v !== "" && v !== undefined) found.push([`${p}.${kk}`, JSON.stringify(v).slice(0, 200)]);
        walk(v, `${p}.${kk}`);
      }
    }
  };
  walk(doc, "");
  for (const [p, v] of found) console.log(`${label} | ${k} | ${doc.name} | ${p} = ${v}`);
}
await db.close();
