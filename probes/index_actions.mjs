// Flatten every embedded action found in dumped pack JSON files into one JSONL index.
//   node index_actions.mjs --dir <dumpDir> --out <file.jsonl>
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = get("--dir");
const out = get("--out");

const rows = [];
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
  const pack = file.replace(/\.json$/, "");
  const docs = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const collect = (owner, ownerPath, ownerType) => {
    const acts = owner?.system?.actions;
    if (!Array.isArray(acts)) return;
    for (const a of acts) {
      rows.push({
        pack, owner: ownerPath, ownerId: owner._id, ownerType,
        id: a.id, name: a.name,
        tags: a.tags ?? null,
        cost: a.cost ?? null,
        range: a.range ?? null,
        target: a.target ?? null,
        hooks: a.actionHooks ?? null,
        effects: (a.effects ?? []).map(e => ({ name: e.name, statuses: e.statuses, duration: e.duration, changes: e.changes })),
        description: a.description ?? null
      });
    }
  };
  for (const doc of docs) {
    collect(doc, doc.name, doc.type);
    for (const it of doc.items ?? []) collect(it, `${doc.name} > ${it.name}`, it.type);
  }
}
fs.writeFileSync(out, rows.map(r => JSON.stringify(r)).join("\n"), "utf8");
console.log(`${rows.length} actions -> ${out}`);
