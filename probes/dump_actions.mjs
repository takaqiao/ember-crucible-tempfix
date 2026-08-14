// List every embedded action in a pack with cost/range/tags, to compare authoring conventions.
import { ClassicLevel } from "classic-level";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const packDir = get("--pack");

const db = new ClassicLevel(packDir, { keyEncoding: "utf8", valueEncoding: "json" });
await db.open();
for await (const [key, doc] of db.iterator()) {
  if (!doc || typeof doc !== "object") continue;
  const collect = (owner, ownerName) => {
    const acts = owner?.system?.actions;
    if (!Array.isArray(acts)) return;
    for (const a of acts) {
      const r = a.range || {};
      console.log([
        ownerName,
        a.id,
        a.name,
        `cost=${JSON.stringify(a.cost)}`,
        `range=${JSON.stringify(r)}`,
        `target=${JSON.stringify(a.target)}`,
        `tags=${(a.tags || []).join(",")}`,
        `hooks=${(a.actionHooks || []).map(h => h.hook || h).join(",")}`
      ].join(" | "));
    }
  };
  collect(doc, doc.name);
  for (const it of doc.items || []) collect(it, `${doc.name} > ${it.name}`);
}
await db.close();
