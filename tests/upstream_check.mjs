/**
 * 跟版体检：把补丁的**上游判据**拿到当前安装的 crucible / ember 上试一遍。
 *
 * 与 `tempfix_harness.mjs` 的分工：
 *   harness    —— 离线、对着**桩件**验补丁逻辑。不装 Foundry 也能跑，但它不知道上游长什么样。
 *   **本脚本** —— 对着**真正安装的上游代码**验判据是否还命中。上游一发版就该跑它。
 *
 * 回答一个问题：**哪些补丁因为上游改了实现而停止工作了，其中哪些是意料之外的。**
 *
 * 失配分两种，混在一起看会出人命：
 *   已登记版本上限 → 预期内的退休，好事
 *   **没登记上限** → 补丁静默停止工作，而缺陷可能还在 ⚠⚠
 *
 * ── 判定强度（重要，别越级解读）─────────────────────────────
 * 运行时的原型判据读的是 `String(proto[guard.method])` —— **某个类的某个方法体**。
 * 所以本脚本也把搜索收进那个方法体，两个方向的结论都成立。
 *
 * 但动作补丁的 `__guard` 读的是 `String(action.hooks[k])`，钩子源码在 compendium 里，
 * 静态取不到。那类判据只能全库搜，而全库搜的推断是**单向**的：
 *   全库搜不到 ⇒ 方法里必然也没有 → 结论可靠
 *   全库搜得到 ⇒ 方法里未必有     → **推不出任何东西**
 * 所以动作补丁只报「失配」，不报「仍命中」——后者是噪音，不是证据。
 *
 * 用法：node tests/upstream_check.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DATA = "C:/Users/Taka/AppData/Local/FoundryVTT/Data";
const CRU = `${DATA}/systems/crucible`;

const read = p => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ver = p => { try { return JSON.parse(read(p)).version ?? "?"; } catch { return "(未安装)"; } };

// 运行时 String(fn) 读到的是**打包产物**，所以判定必须拿它，哪怕人读代码时源码树更好用。
const BUNDLES = [
  { name: "crucible", src: read(`${CRU}/crucible-compiled.mjs`) },
  { name: "ember", src: read(`${DATA}/modules/ember/scripts/ember.mjs`) }
].filter(b => b.src);
const GLOBAL = BUNDLES.map(b => b.src).join("\n");

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 从 `open`（必须指向一个 `{`）起做括号配对，跳过字符串与注释。返回闭合括号的下标。 */
function balanced(src, open) {
  let depth = 0;
  for ( let i = open; i < src.length; i++ ) {
    const c = src[i], n = src[i + 1];
    if ( c === "/" && n === "/" ) { i = src.indexOf("\n", i); if ( i < 0 ) return -1; continue; }
    if ( c === "/" && n === "*" ) { i = src.indexOf("*/", i + 2); if ( i < 0 ) return -1; i++; continue; }
    if ( c === '"' || c === "'" || c === "`" ) {
      for ( i++; i < src.length; i++ ) {
        if ( src[i] === "\\" ) { i++; continue; }
        if ( src[i] === c ) break;
      }
      continue;
    }
    if ( c === "{" ) depth++;
    else if ( c === "}" ) { depth--; if ( !depth ) return i; }
  }
  return -1;
}

/**
 * 取出「某个类的某个方法」的源码。方法可能定义在父类上（判据读的就是继承来的那个），
 * 所以找不到就顺着 `extends` 往上走。
 * @returns {{status: string, body?: string, owner?: string, bundle?: string}}
 */
function classMethodSource(className, method, seen = new Set()) {
  if ( seen.has(className) || (seen.size > 4) ) return { status: "继承链过深" };
  seen.add(className);

  for ( const b of BUNDLES ) {
    const decl = new RegExp(`\\bclass\\s+${esc(className)}\\b([^{]*)`).exec(b.src);
    if ( !decl ) continue;
    const open = b.src.indexOf("{", decl.index + decl[0].length - decl[1].length - 1);
    const close = balanced(b.src, open);
    if ( close < 0 ) return { status: "类体括号配不上" };
    const body = b.src.slice(open, close);

    const md = new RegExp(
      `(?:^|\\n)[ \\t]*(?:static\\s+|async\\s+|get\\s+|set\\s+|\\*\\s*)*${esc(method)}\\s*\\(`);
    const mm = md.exec(body);
    if ( mm ) {
      const p = body.indexOf("(", mm.index + mm[0].length - 1);
      const argEnd = (() => { // 参数表也要配对，默认值里可能有括号
        let d = 0;
        for ( let i = p; i < body.length; i++ ) {
          if ( body[i] === "(" ) d++;
          else if ( body[i] === ")" ) { d--; if ( !d ) return i; }
        }
        return -1;
      })();
      const bo = body.indexOf("{", argEnd);
      const bc = balanced(body, bo);
      if ( bc < 0 ) return { status: "方法体括号配不上" };
      return { status: "找到", body: body.slice(bo, bc), owner: className, bundle: b.name };
    }

    // 本类没有 → 往父类找
    const ext = /extends\s+([A-Za-z_$][\w$]*)/.exec(decl[1]);
    if ( ext ) return classMethodSource(ext[1], method, seen);
    return { status: `${className} 里没有 ${method}()，也没有父类` };
  }
  return { status: `包里找不到 class ${className}（可能是 Foundry 核心类或已被重命名）` };
}

// ── 收集判据 ────────────────────────────────────────────────
const tf = read(`${REPO}/scripts/tempfix.mjs`);
if ( !tf ) { console.error("读不到 scripts/tempfix.mjs"); process.exit(1); }

const ceilings = new Set();
{
  const m = tf.match(/const VERSION_CEILINGS = \{([\s\S]*?)\n\};/);
  if ( m ) for ( const k of m[1].matchAll(/^\s*(\w+):\s*\{/gm) ) ceilings.add(k[1]);
}

const strong = [];   // 原型补丁：方法体内判定，双向可信
const weak = [];     // 动作补丁：全库判定，只有「失配」可信

for ( const m of tf.matchAll(
  /label:\s*"([^"]+)"\s*,\s*setting:\s*"(\w+)"[\s\S]{0,600}?guard:\s*\{\s*method:\s*"(\w+)"\s*,\s*includes:\s*(["'])((?:(?!\4).)*)\4/g) ) {
  const cls = m[1].split("#")[0];
  strong.push({ label: m[1], setting: m[2], cls, guardMethod: m[3], needle: m[5] });
}

for ( const m of tf.matchAll(/ACTION_PATCHES\.(\w+)\s*=\s*\{[\s\S]{0,500}?__guard:\s*\[([^\]]*)\]/g) ) {
  for ( const s of m[2].matchAll(/"([^"]*)"|([A-Z_][A-Z0-9_]*)/g) ) {
    const lit = s[1] ?? null;
    if ( lit === null ) continue;   // 常量引用（如 ABYSS_MARK_ID_BAD）另行处理
    weak.push({ label: `ACTION_PATCHES.${m[1]}`, setting: null, needle: lit });
  }
}
// __guard 里写常量名的，取常量的字面值
for ( const m of tf.matchAll(/ACTION_PATCHES\.(\w+)\s*=\s*\{[\s\S]{0,500}?__guard:\s*\[\s*([A-Z_][A-Z0-9_]*)\s*\]/g) ) {
  const v = new RegExp(`const ${m[2]}\\s*=\\s*"([^"]*)"`).exec(tf);
  if ( v ) weak.push({ label: `ACTION_PATCHES.${m[1]}`, setting: null, needle: v[1], via: m[2] });
}

/**
 * 取出「某个对象字面量成员的某个方法」的源码。ember 的天赋钩子是这种形状：
 *   emberAbyssAttune: { finalizeAction(item, action) { … } }
 * `HOOK_OVERRIDES` 的 guard 读的正是 `String(hooks[type][id][hook])`，所以同样能收窄判定。
 */
function objectMemberSource(objKey, member) {
  for ( const b of BUNDLES ) {
    // 两种注册写法都要认：对象字面量 `id: {…}`，以及赋值 `HOOKS$1.id = {…}`
    const decl = new RegExp(`\\b${esc(objKey)}\\s*[:=]\\s*\\{`).exec(b.src);
    if ( !decl ) continue;
    const open = b.src.indexOf("{", decl.index);
    const close = balanced(b.src, open);
    if ( close < 0 ) return { status: "对象体括号配不上" };
    const body = b.src.slice(open, close);
    const md = new RegExp(`(?:^|\\n|,)\\s*(?:async\\s+)?${esc(member)}\\s*[(:]`);
    const mm = md.exec(body);
    if ( !mm ) return { status: `${objKey} 里没有 ${member}` };
    const bo = body.indexOf("{", body.indexOf("(", mm.index));
    const bc = balanced(body, bo);
    if ( bc < 0 ) return { status: "方法体括号配不上" };
    return { status: "找到", body: body.slice(bo, bc), owner: objKey, bundle: b.name };
  }
  return { status: `包里找不到 ${objKey}` };
}

// 钩子覆盖：guard 比对的是钩子函数源码，能收窄到成员方法体内 → 与原型补丁同级可信
const hookProbes = [];
for ( const m of tf.matchAll(
  /HOOK_OVERRIDES\.push\(\{\s*type:\s*"(\w+)",\s*id:\s*"(\w+)",\s*hook:\s*"(\w+)",\s*guard:\s*([A-Z_][A-Z0-9_]*|"[^"]*")[\s\S]{0,200}?setting:\s*"(\w+)"/g) ) {
  let needle = m[4];
  if ( needle.startsWith('"') ) needle = needle.slice(1, -1);
  else {
    const v = new RegExp(`const ${needle}\\s*=\\s*"([^"]*)"`).exec(tf);
    if ( !v ) continue;
    needle = v[1];
  }
  hookProbes.push({ label: `HOOK_OVERRIDES ${m[1]}.${m[2]}.${m[3]}`, setting: m[5],
    objKey: m[2], member: m[3], needle });
}

// ── 判定 ────────────────────────────────────────────────────
console.log(`跟版体检 —— crucible ${ver(`${CRU}/system.json`)} / ember ${ver(`${DATA}/modules/ember/module.json`)}`);
console.log(`原型判据 ${strong.length} 条 + 钩子覆盖判据 ${hookProbes.length} 条（均为方法体内判定）`
  + ` / 动作判据 ${weak.length} 条（全库判定，仅失配可信）\n`);

const silent = [], retired = [], stillNeeded = [], undecidable = [], fine = [];

for ( const p of strong ) {
  const r = classMethodSource(p.cls, p.guardMethod);
  if ( r.status !== "找到" ) { undecidable.push({ ...p, why: r.status }); continue; }
  const hit = r.body.includes(p.needle);
  const hasCeiling = ceilings.has(p.setting);
  if ( !hit && !hasCeiling ) silent.push({ ...p, r });
  else if ( !hit ) retired.push({ ...p, r });
  else if ( hasCeiling ) stillNeeded.push({ ...p, r });
  else fine.push({ ...p, r });
}
for ( const p of hookProbes ) {
  const r = objectMemberSource(p.objKey, p.member);
  if ( r.status !== "找到" ) { undecidable.push({ ...p, why: r.status }); continue; }
  const hit = r.body.includes(p.needle);
  const hasCeiling = ceilings.has(p.setting);
  if ( !hit && !hasCeiling ) silent.push({ ...p, r });
  else if ( !hit ) retired.push({ ...p, r });
  else if ( hasCeiling ) stillNeeded.push({ ...p, r, guardMethod: p.member });
  else fine.push({ ...p, r });
}
for ( const p of weak ) {
  if ( !GLOBAL.includes(p.needle) ) silent.push({ ...p, weak: true });
  else fine.push({ ...p, weak: true });
}

const show = p => `   ${p.label}${p.setting ? `  (${p.setting})` : ""}`
  + (p.r?.owner && (p.r.owner !== p.cls) ? `\n      ↳ 判据实际读的是继承自 ${p.r.owner} 的实现` : "");

if ( silent.length ) {
  console.log(`⚠⚠ 判据失配、且没登记版本上限 —— 这些补丁已静默停止工作：${silent.length} 条`);
  for ( const p of silent ) {
    console.log(show(p));
    console.log(`      特征串：${p.needle}${p.via ? `  (常量 ${p.via})` : ""}`);
  }
  console.log(`   → 必须人工判断：上游是**修好了**（该加 fixedIn/fixedInEmber），`);
  console.log(`     还是只**改了写法**（缺陷还在，该更新特征串）。两者后果相反。\n`);
}
if (retired.length) {
  console.log(`✅ 判据失配、已登记版本上限 —— 预期内的退休：${retired.length} 条`);
  for ( const p of retired ) console.log(show(p));
  console.log();
}
if ( stillNeeded.length ) {
  console.log(`⚠ 登记了版本上限、但判据在目标方法里**仍然命中**：${stillNeeded.length} 条`);
  console.log(`   上限按版本号退休，与特征串是两条独立的轴，命中不等于有 bug。`);
  console.log(`   但这说明上游那段实现**没动过** —— 回头确认「上游已修」当初判对了没。`);
  for ( const p of stillNeeded ) {
    console.log(show(p));
    console.log(`      仍在 ${p.r.bundle} 的 ${p.r.owner}#${p.guardMethod}() 里：${p.needle}`);
  }
  console.log();
}
if ( undecidable.length ) {
  console.log(`⚠ 无法判定：${undecidable.length} 条`);
  for ( const p of undecidable ) console.log(`${show(p)}\n      ${p.why}`);
  console.log();
}
console.log(`✅ 判据仍在岗：${fine.length} 条`);
// 特征串太泛 = guard 轴形同虚设：修好前后它都在，只有版本上限在兜底。
const generic = [];
for ( const p of strong ) {
  const n = GLOBAL.split(p.needle).length - 1;
  if ( n > 8 ) generic.push({ ...p, n });
}
if ( generic.length ) {
  console.log(`
⚠ 特征串太泛，guard 轴形同虚设：${generic.length} 条`);
  console.log(`   这些串在上游“修好前”和“修好后”都存在，所以它们从来不会触发自动退让。`);
  console.log(`   只剩 VERSION_CEILINGS 一根独苗兜底 —— 与“两条独立的轴互相交叉验证”的设计主张不符。`);
  for ( const p of generic ) console.log(`   ${p.label}
      “${p.needle}” 全库出现 ${p.n} 次`);
}


// ── 覆盖率自述：本工具查不到的补丁，必须明说，否则「全绿」是假象 ──────────
const field = (b, k) => {
  const i = b.indexOf(k + ': "');
  if ( i < 0 ) return null;
  const st = i + k.length + 3;
  return b.slice(st, b.indexOf('"', st));
};
const blocks = tf.split("PROTOTYPE_PATCHES.push({").slice(1)
  .map(b => b.slice(0, b.indexOf("wrap:") + 1 || 1200));
const unguarded = blocks.filter(b => !b.includes("guard: {"))
  .map(b => ({ label: field(b, "label"), setting: field(b, "setting") }));

console.log(`
—— 覆盖率 ——`);
console.log(`原型补丁共 ${blocks.length} 条，其中 ${blocks.length - unguarded.length} 条有 guard，本工具逐条查过。`);
if ( unguarded.length ) {
  console.log(`剩下 ${unguarded.length} 条没有 guard，**本工具不覆盖**：`);
  for ( const u of unguarded ) {
    const axis = ceilings.has(u.setting) ? "靠 VERSION_CEILINGS 退休" : "靠数据形状自动空转（见补丁文档）";
    console.log(`   ${u.label}  (${u.setting}) —— ${axis}`);
  }
}
console.log(`动作补丁的 __guard 只做了全库判定，仅「失配」结论可信（理由见文件头）。`);

process.exit(silent.length ? 1 : 0);
