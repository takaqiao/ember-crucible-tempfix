// Dump every document of one or more LevelDB packs into a single JSON array file,
// so that later analysis can run offline (LevelDB only allows one writer/reader lock).
//   node dump_all.mjs --out <dir> --pack <packDir> [--pack <packDir> ...]
import { ClassicLevel } from "classic-level";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outDir = args[args.indexOf("--out") + 1];
const packs = args.reduce((acc, a, i) => (a === "--pack" ? [...acc, args[i + 1]] : acc), []);
fs.mkdirSync(outDir, { recursive: true });

for (const packDir of packs) {
  const db = new ClassicLevel(packDir, { keyEncoding: "utf8", valueEncoding: "json" });
  await db.open();
  const docs = [];
  for await (const [key, doc] of db.iterator()) docs.push({ _key: key, ...doc });
  await db.close();
  const label = `${path.basename(path.dirname(path.dirname(packDir)))}.${path.basename(packDir)}`;
  const outFile = path.join(outDir, `${label}.json`);
  fs.writeFileSync(outFile, JSON.stringify(docs, null, 1), "utf8");
  console.log(`${label}: ${docs.length} docs -> ${outFile}`);
}
