/**
 * 数据轴体检：把补丁依赖的**内容事实**拿到当前安装的 compendium 里重算一遍。
 *
 * 三条轴各有各的体检：
 *   `upstream_check.mjs` —— 代码轴（`__guard` 特征串是否还命中上游实现）
 *   **本脚本**           —— 数据轴（pack 里的标签 / change key / 时长单位是否还是坏的）
 *   `tempfix_harness.mjs`—— 补丁逻辑本身（对着桩件，不看上游）
 *
 * 为什么值得有：数据轴的补丁靠「形状匹配」自动空转，没有 guard 也没有版本上限，
 * 上游把数据修好了不会有任何信号。这个脚本就是那个信号。
 *
 * ⚠ **两个数不是一回事，本脚本一律分开报**：
 *     「不同动作 id 数」—— 有多少种动作中招
 *     「副本总数」      —— 同一个动作在多少份文档里各存了一份（冒险包会整包复制角色）
 *   把这两个数混起来，就会得到本项目历史上出现过两次的错误结论
 *   （N10 影响面先报 19、改成 38、又改回 19）。要引用就写清楚引的是哪一个。
 *
 * 需要 Foundry **没在跑**（LevelDB 单写锁）。用法：node tests/data_check.mjs
 */
import { ClassicLevel } from "classic-level";
import fs from "node:fs";

const DATA = "C:/Users/Taka/AppData/Local/FoundryVTT/Data";
const ROOTS = [["crucible", `${DATA}/systems/crucible/packs`], ["ember", `${DATA}/modules/ember/packs`]];
const ver = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")).version ?? "?"; } catch { return "(未装)"; } };

/* ── 遍历：把每个 pack 里的每份文档喂给访问者 ────────────────────────────── */
const locked = [];
async function eachDoc(visit) {
  for ( const [tag, root] of ROOTS ) {
    if ( !fs.existsSync(root) ) continue;
    for ( const p of fs.readdirSync(root) ) {
      const dir = `${root}/${p}`;
      if ( !fs.statSync(dir).isDirectory() ) continue;
      let db;
      try {
        db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
        await db.open();
      } catch (e) { locked.push(`${tag}/${p} (${e.code ?? e.message})`); continue; }
      try { for await ( const [, doc] of db.iterator() ) visit(doc, `${tag}/${p}`); }
      finally { await db.close(); }
    }
  }
}

/** 递归找出文档里所有「动作」条目（带 id + tags/effects 的对象） */
function* actions(node) {
  if ( Array.isArray(node) ) { for ( const v of node ) yield* actions(v); return; }
  if ( !node || (typeof node !== "object") ) return;
  if ( (typeof node.id === "string") && Array.isArray(node.tags) && Array.isArray(node.effects) ) yield node;
  for ( const v of Object.values(node) ) yield* actions(v);
}
/** 递归找出所有 ActiveEffect 文档（带 _id + duration + system.changes） */
function* effectDocs(node) {
  if ( Array.isArray(node) ) { for ( const v of node ) yield* effectDocs(v); return; }
  if ( !node || (typeof node !== "object") ) return;
  if ( (typeof node._id === "string") && node.duration && node.system && Array.isArray(node.system.changes) ) yield node;
  for ( const v of Object.values(node) ) yield* effectDocs(v);
}

/* ── 采集 ───────────────────────────────────────────────────────────────── */
const seen = { noxiousSpray: [], selfDestruct: [], devourThoughts: [] };
const turnsActions = [];      // 动作自带效果里 units:"turns"
const turnsEffectDocs = [];   // 独立/内嵌的 ActiveEffect 文档
const acidWards = [];
const mentions = {};          // 只是「提到」过这个 id 的文档（@UUID 引用、物品授予表），不是副本

await eachDoc((doc, pack) => {
  const blob = JSON.stringify(doc);
  for ( const id of Object.keys(seen) ) if ( blob.includes(id) ) (mentions[id] ??= []).push(pack);
  for ( const a of actions(doc) ) {
    if ( a.id in seen ) seen[a.id].push({ pack, tags: a.tags });
    if ( a.effects.some(e => e?.duration?.units === "turns") )
      turnsActions.push({ pack, id: a.id, doc: doc.name ?? "?" });
  }
  for ( const e of effectDocs(doc) ) {
    if ( e.duration?.units === "turns" )
      turnsEffectDocs.push({ pack, id: e._id, name: e.name ?? "?", transfer: !!e.transfer });
    for ( const c of e.system.changes )
      if ( /^system\.resistances\.[a-zA-Z]+$/.test(c?.key ?? "") )
        acidWards.push({ pack, id: e._id, name: e.name ?? "?", key: c.key });
  }
});

/* ── 断言 ───────────────────────────────────────────────────────────────── */
console.log(`数据轴体检 —— crucible ${ver(`${DATA}/systems/crucible/system.json`)}`
  + ` / ember ${ver(`${DATA}/modules/ember/module.json`)}`);
if ( locked.length ) {
  console.log(`\n⚠ ${locked.length} 个 pack 打不开（Foundry 在跑？LevelDB 是单写锁）：`);
  console.log(`   ${locked.slice(0, 6).join("、")}${locked.length > 6 ? " …" : ""}`);
  console.log(`   关掉 Foundry 再跑，否则下面的数**不完整**。`);
}
console.log();

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  for ( const d of [].concat(detail) ) console.log(`      ${d}`);
  if ( !ok ) bad++;
};

// D-1：上游已修，补丁应当自动空转。这条曾两次差点被误判成「可以退休 patchDamageTypes」——
// 真相是三个格子里只有这一个修好了，另两个还坏着。所以它单独成条，且必须全副本都带 poison。
const noxBad = seen.noxiousSpray.filter(x => !x.tags.includes("poison"));
check(`D-1 noxiousSpray 全部副本都带 poison 标签（上游已修，补丁空转）`,
  seen.noxiousSpray.length > 0 && !noxBad.length,
  [`副本 ${seen.noxiousSpray.length} 份：${seen.noxiousSpray.map(x => x.pack).join("、")}`,
   ...(noxBad.length ? [`⚠ 仍缺 poison 的：${noxBad.map(x => x.pack).join("、")}`] : [])]);

// D-2 / D-3：仍坏，补丁仍需在岗。哪天变成 ✅→❌ 翻转，说明上游修了，该考虑退休。
const sdBad = seen.selfDestruct.filter(x => x.tags.includes("piercing"));
check(`D-2 selfDestruct 仍带 piercing 标签（缺陷仍在，补丁仍需在岗）`,
  sdBad.length === seen.selfDestruct.length && sdBad.length > 0,
  [`副本 ${seen.selfDestruct.length} 份，其中 ${sdBad.length} 份仍带 piercing`,
   ...seen.selfDestruct.map(x => `${x.pack}: [${x.tags.join(", ")}]`)]);

const dtBad = seen.devourThoughts.filter(x => !x.tags.includes("psychic"));
check(`D-3 devourThoughts 仍缺 psychic 标签（缺陷仍在，补丁仍需在岗）`,
  dtBad.length === seen.devourThoughts.length && dtBad.length > 0,
  [`副本 ${seen.devourThoughts.length} 份，其中 ${dtBad.length} 份仍缺 psychic`,
   ...seen.devourThoughts.map(x => `${x.pack}: [${x.tags.join(", ")}]`)]);

// E1：ward 的 change key 落在 SchemaField 上（少了 .bonus）
check(`E1 抗性 change key 仍落在 SchemaField 上（缺陷仍在）`, acidWards.length > 0,
  acidWards.length ? acidWards.map(w => `${w.pack} «${w.name}» ${w.key}`)
    : ["未找到任何 `system.resistances.<type>` 形状的 change —— 上游可能已全部补上 .bonus"]);

// 副本 ≠ 提及。冒险包正文里的 @UUID、敌人的物品授予表都会提到同一个 id，
// 但它们指向的是同一份文档，不是另一份要单独修的副本。
// 这一栏的存在是为了让「子串搜到 4 个 pack、结构化只数出 3 份」不必每次重查一遍 ——
// 差额如果不能全部解释成引用，那就是结构化判据漏掉了某种形状的副本，是**真警报**。
console.log(`\n🔎 副本数 vs 提及数（差额应当全是引用）`);
for ( const id of Object.keys(seen) ) {
  const copies = new Set(seen[id].map(x => x.pack));
  const refOnly = [...new Set(mentions[id] ?? [])].filter(p => !copies.has(p));
  console.log(`      ${id}：真副本 ${seen[id].length} 份`
    + `，另有 ${refOnly.length} 个 pack 只是引用它${refOnly.length ? `（${refOnly.join("、")}）` : ""}`);
}

// N10 / N12：影响面。**两个数分开报**，理由见文件头。
const ids = new Set(turnsActions.map(x => x.id));
const byPack = turnsActions.reduce((a, x) => (a[x.pack] = (a[x.pack] ?? 0) + 1, a), {});
console.log(`\n📊 N10 影响面（动作自带效果 units:"turns"）`);
console.log(`      不同动作 id 数：${ids.size}`);
console.log(`      副本总数      ：${turnsActions.length}`);
console.log(`      按 pack       ：${Object.entries(byPack).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`      id 清单       ：${[...ids].sort().join(", ")}`);

// 「crucible 占几个 / ember 占几个」曾经算错过：两边有**共有 id**，
// 按「各自独有」加和 ≠ 总数，按「各自出现过」加和 > 总数。所以三个数一起报。
const side = s => new Set(turnsActions.filter(x => x.pack.startsWith(s)).map(x => x.id));
const cru = side("crucible"), emb = side("ember");
const both = [...cru].filter(x => emb.has(x));
console.log(`      crucible 侧出现 ${cru.size} 个，ember 侧出现 ${emb.size} 个，`
  + `其中两边都有 ${both.length} 个${both.length ? `（${both.join("、")}）` : ""}`);
console.log(`      → 引用时务必写清口径：${cru.size} + ${emb.size} - ${both.length} = ${ids.size}`);
console.log(`      crucible 侧：${[...cru].sort().join(", ")}`);
console.log(`      ember 侧    ：${[...emb].sort().join(", ")}`);

const transferable = turnsEffectDocs.filter(x => x.transfer);
console.log(`\n📊 N12 影响面（ActiveEffect 文档 units:"turns"）`);
console.log(`      文档数：${turnsEffectDocs.length}，其中 transfer:true 的 ${transferable.length} 条`);
for ( const t of transferable ) console.log(`      ${t.pack} «${t.name}» ${t.id}`);

console.log(`\n${bad ? `❌ ${bad} 条事实与记录不符 —— 上游动过数据，先弄清是修好了还是改了写法。`
  : "✅ 数据轴的事实与记录一致。"}`);
process.exit(bad ? 1 : 0);
