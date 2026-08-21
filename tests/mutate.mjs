/**
 * 变异测试：把 tempfix.mjs 里的补丁逐个改回「坏写法」，跑 harness，**期望它变红**。
 *
 * 目的不是测补丁，是测**断言**：一条永远绿的断言和没有断言是一回事。
 * 任何一条变异后 harness 仍然全绿 ⇒ 那条断言是假绿，必须修断言而不是修补丁。
 *
 * 用法：node mutate.mjs [过滤子串]
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "C:/Users/Taka/Desktop/fvtt/ember-crucible-tempfix";
const SRC = `${ROOT}/scripts/tempfix.mjs`;
const BAK = `${SRC}.mutbak`;
const HARNESS = `${ROOT}/tests/tempfix_harness.mjs`;
/** 从清单读版本，避免变异表里写死版本号（一发版就失配） */
const MANIFEST_VERSION = JSON.parse(readFileSync(`${ROOT}/module.json`, "utf8")).version;

/** [标签, 原文, 替换成] —— 原文必须在文件里**恰好出现一次**，否则算测试自身的缺陷 */
const MUTATIONS = [
  // ── N12（本轮新增）
  ["N12 不改单位", 'this.updateSource({ duration: { units: "rounds", expiry: this.duration.expiry ?? "turnEnd" } });',
                   '/* mutated: 不改 */'],
  ["N12 改错方向（rounds→turns）", 'units: "rounds", expiry: this.duration.expiry ?? "turnEnd"',
                   'units: "turns", expiry: this.duration.expiry ?? "turnEnd"'],
  ["N12 expiry 用 ?? 改成强制覆盖", 'expiry: this.duration.expiry ?? "turnEnd"', 'expiry: "turnEnd"'],
  ["N12 顺手放行 months", '(this.duration?.units === "turns")',
                   '["turns","months"].includes(this.duration?.units)'],
  ["N12 无视开关", 'if ( settingOn(setting) && (this.duration?.units === "turns") ) {',
                   'if ( (this.duration?.units === "turns") ) {'],

  // ── 版本上限中央表（本轮新增）
  ["版本闸门恒不生效", "  if ( !supersededByUpstream(fixedIn, fixedInEmber) ) return false;",
                   "  return false;\n  if ( !supersededByUpstream(fixedIn, fixedInEmber) ) return false;"],
  ["settingOn 忽略版本上限", "  return on && !ceilingReached(key);", "  return on;"],
  ["版本比较方向反了", "const reached = (fixed, current) => !!fixed && !!current && !iu(fixed, current);",
                   "const reached = (fixed, current) => !!fixed && !!current && iu(fixed, current);"],
  ["读不到版本时改成保守停用", "  if ( typeof iu !== \"function\" ) return false;",
                   "  if ( typeof iu !== \"function\" ) return true;"],
  ["settingOn 失败方向反了", "  try { on = game.settings.get(MODULE_ID, key); } catch { /* 未注册 → 保守生效 */ }",
                   "  try { on = game.settings.get(MODULE_ID, key); } catch { on = false; }"],

  // ── diagnose 漏报通用补丁（用户贴 diagnose 才发现：universal 一栏写死成一条）
  ["diagnose 的 universal 写死回一条", "      out.patches.universal = UNIVERSAL_PATCHES.map(body =>\n        UNIVERSAL_DEFS.find(d => d.body === body)?.label ?? \"(未命名)\");",
                   '      out.patches.universal = UNIVERSAL_PATCHES.length ? ["turnsDuration"] : [];'],
  ["通用补丁漏写 label", '{ setting: "patchTurnsDuration", label: "turnsDuration", body: turnsDurationPatch }',
                   '{ setting: "patchTurnsDuration", body: turnsDurationPatch }'],

  // ── I6 的安装时机（用户贴 diagnose 才发现：首次进世界压根没生效）
  ["I6 不再就地补包已渲染的控件", "  try { wrapFlankingTool(globalThis.ui?.controls?.controls); } catch { /* 控件还没建，钩子会兜住 */ }", "  "],
  ["I6 闸门失败改回静默", '      warn("I6：上游已改写 debugFlanking 的实现，本补丁自动退让（这是正常的自我退休）");', "      "],
  ["I6 闸门恒通过（上游改了也硬包）", '  if ( !String(orig).includes("canvas.tokens.controlled") ) {', "  if ( false ) {"],
  ["I6 只清 controlled（复现上游 bug）", "      for ( const token of globalThis.canvas?.tokens?.placeables ?? [] ) {",
                   "      for ( const token of globalThis.canvas?.tokens?.controlled ?? [] ) {"],
  ["I6 开启时也乱清一遍", "    if ( !active ) {\n      // 上游只清了 controlled", "    if ( true ) {\n      // 上游只清了 controlled"],

  // ── 0.10.2 退休名单（升级后重推全部补丁的结果）
  ["漏掉一条 0.10.2 退休项（I6）", '  patchFlankingToggle:   { fixedIn: "0.10.2" }    // I6  issue #1311',
   "  // I6 被漏掉了"],
  ["把 patchDamageTypes 也误退休了", '  patchRepeatedPrepare:  { fixedIn: "0.10.2" },   // I4  issue #1404',
   '  patchDamageTypes:      { fixedIn: "0.10.2" },\n  patchRepeatedPrepare:  { fixedIn: "0.10.2" },   // I4  issue #1404'],
  ["退休门槛写早了一版（0.10.1 用户被提前撤补丁）",
   '  patchHasKnowledge:     { fixedIn: "0.10.2" },   // I2  issue #1412',
   '  patchHasKnowledge:     { fixedIn: "0.10.1" },   // I2  issue #1412'],

  // ── P3 / P3′ 的拆分（审计发现 P3 混了「可证缺陷」与「内容判断」两件事）
  ["P3 判别反了（快照与血统互换）", "    const isStaleSnapshot = !(item.system.actions?.length);",
   "    const isStaleSnapshot = !!(item.system.actions?.length);"],
  ["P3 拆分失效（两者又共用一个开关）",
   '    if ( !settingOn(isStaleSnapshot ? "patchRuneCantrips" : "patchLineageCantrips") ) continue;',
   '    if ( !settingOn("patchRuneCantrips") ) continue;'],

  // ── I5（审计发现整条从未执行过：判据写成「targetLabel 为空才补」，而它恒非空）
  ["I5 判据退回「空才补」（复现死代码）",
   "    if ( cardData && !isGM && cardData.defenseType\n      && !String(cardData.targetLabel ?? \"\").includes(cardData.defenseType) ) {",
   "    if ( cardData && !cardData.targetLabel && cardData.defenseType ) {"],
  ["I5 不再排除 GM（把 DC 数字覆盖掉）", "    if ( cardData && !isGM && cardData.defenseType",
   "    if ( cardData && cardData.defenseType"],
  ["I5 上游已修时仍然硬写", "      && !String(cardData.targetLabel ?? \"\").includes(cardData.defenseType) ) {", "      ) {"],
  ["I5 顺手把 DC 也写进去", "      cardData.targetLabel = cardData.defenseType;",
   "      cardData.targetLabel = `${cardData.defenseType} ${cardData.dc}`;"],

  // ── 缓存旧脚本的检测（用户 VPS 上「清单 0.7.0、实际跑 0.2.0」逼出来的）
  // ⚠ 不要在这里写死版本号 —— 每次发版都会让这条变异失配（已经栽过一次）。
  //   从 module.json 读，和被测代码用同一个真源。
  ["SCRIPT_VERSION 与清单脱节（忘了同步）",
   `const SCRIPT_VERSION = "${MANIFEST_VERSION}";`, 'const SCRIPT_VERSION = "0.0.1";'],
  ["stale 判据反了", "stale: !!manifest && (manifest !== SCRIPT_VERSION)",
                   "stale: !!manifest && (manifest === SCRIPT_VERSION)"],
  ["读不到清单时误报过期", "stale: !!manifest && (manifest !== SCRIPT_VERSION)",
                   "stale: (manifest !== SCRIPT_VERSION)"],
  ["diagnose 不再报 staleScript", "        staleScript: versionCheck().stale,", "        staleScript: false,"],

  // ── 控制面板注册的**失败路径**（用户在 VPS 上报「看不到控制面板」逼出来的）
  ["面板类抛异常时不再兜住（会带走 init）",
                   "  try { Toolbox = getToolboxClass(); }", "  { Toolbox = getToolboxClass(); }"],
  ["幂等判据反了（重复注册）", "  if ( toolboxMenuRegistered() ) return true;", "  if ( false ) return true;"],
  ["ApplicationV2 缺席时谎报成功", "  if ( !Toolbox ) return false;          // ApplicationV2 还没就位，下个阶段再试",
                   "  if ( !Toolbox ) return true;"],

  // ── 控制面板的注册（用户报「看不到控制面板」暴露出来的漏测）
  ["面板类工厂恒返回 null（面板注册不上）", "  const AV2 = foundry?.applications?.api?.ApplicationV2;\n  if ( !AV2 ) return null;",
                   "  const AV2 = foundry?.applications?.api?.ApplicationV2;\n  if ( true ) return null;"],
  // ⚠ 单独删掉 init / setup / ready 里任何**一个**注册点都测不出来 —— 另外两个会把它补上。
  //   那正是三处重试的意义（防御性冗余），不是断言没力气。所以这条变异要把注册**整个**掐掉。
  ["菜单三处注册全部失效", "function registerToolboxMenu() {\n  if ( toolboxMenuRegistered() ) return true;",
                   "function registerToolboxMenu() {\n  return false;\n  if ( toolboxMenuRegistered() ) return true;"],
  ["菜单没限定 GM", "      type: Toolbox,\n      restricted: true", "      type: Toolbox,\n      restricted: false"],
  ["面板类没缓存（每次重建）", "  if ( _ToolboxClass ) return _ToolboxClass;", "  if ( false ) return _ToolboxClass;"],
  ["面板动作漏挂一个", "        run: TempfixToolbox.#onRun,\n        toggle: TempfixToolbox.#onToggle",
                   "        run: TempfixToolbox.#onRun"],

  // ── 控制面板
  ["面板漏渲染开关（少一组）", 'const groups = Object.entries(SETTING_GROUPS).map(([g, title]) => {',
                   'const groups = Object.entries(SETTING_GROUPS).slice(1).map(([g, title]) => {'],
  ["面板漏渲染命令（少一条）", "  const rows = COMMANDS.map(c => `",
                   "  const rows = COMMANDS.slice(1).map(c => `"],
  ["面板输出区不转义（XSS）", "<pre style=\"max-height:18rem;overflow:auto;user-select:all;font-size:.8em;white-space:pre-wrap\">${esc(output.text)}</pre>",
                   "<pre style=\"max-height:18rem;overflow:auto;user-select:all;font-size:.8em;white-space:pre-wrap\">${output.text}</pre>"],
  ["目录漏记一条（面板与设置面板不一致）",
                   "    SETTING_CATALOG.push({ key, name, hint, group: name.slice(0, 1) });",
                   "    if ( key !== \"patchSuddenBite\" ) SETTING_CATALOG.push({ key, name, hint, group: name.slice(0, 1) });"],
  ["组号解析错位", "group: name.slice(0, 1)", "group: name.slice(1, 2)"],
  ["批量开关只改一半", "  for ( const s of SETTING_CATALOG ) {", "  for ( const s of SETTING_CATALOG.slice(2) ) {"],

  // ── I7（上游 issue #1288）
  ["I7 不过滤（复现上游缺陷）", "      if ( c?.item && (c.item.system?.canThrow === false) ) c.viable = false;", "      "],
  ["I7 过滤方向反了", "(c.item.system?.canThrow === false)", "(c.item.system?.canThrow !== false)"],
  ["I7 丢掉归属判据（所有动作都过滤）",
    '    if ( !this.tags?.has?.("thrown") ) return choices;', "    "],
  ["I7 canThrow 缺失时也当不可扔", "(c.item.system?.canThrow === false)", "!c.item.system?.canThrow"],
  ["I7 无视开关", "    if ( !settingOn(setting) || !Array.isArray(choices) ) return choices;",
                  "    if ( !Array.isArray(choices) ) return choices;"],
  // 把过滤挤到“太晚”的地方 —— 这正是 I7 曾经犯过的错：
  // 挂在 strike 标签之后，下拉框过滤得了，“自动脱困”一次都不会发生。
  ["I7 改挂在更晚的地方（重现历史错误）",
    '  method: "_prepareWeaponChoices",', '  method: "getValidWeaponChoices",'],

  // ── N10
  ["N10 不改单位", '      d.units = "rounds";', '      /* mutated */'],
  ["N10 expiry 方向写反", '      d.expiry ??= "turnEnd";', '      d.expiry ??= "turnStart";'],
  ["N10 无视上游 guard", "    if ( !systemRejectsTurns() ) return;            // 上游放宽了就别动它", "    "],

  // ── 原型补丁的 guard
  ["guard 读包装体而非原实现", "const src = String(guardFn?.__tempfixOriginal ?? guardFn ?? \"\");",
                   "const src = String(guardFn ?? \"\");"],
  ["guard 恒通过", "      if ( !src.includes(p.guard.includes) ) {", "      if ( false ) {"],

  // ── B1/B2
  ["B1 不覆写附魔加值", "      if ( Number.isFinite(fresh) ) this.actionBonuses.enchantment = fresh;", "      "],

  // ── N2 / N3 / N11
  ["N2 写回顶层（复现上游 bug）", 'e.system.changes = [{ key: "system.defenses.armor.bonus", value: 3, type: "add" }];',
                   'e.changes = [{ key: "system.defenses.armor.bonus", value: 3, type: "add" }];'],
];

const original = readFileSync(SRC, "utf8");
copyFileSync(SRC, BAK);

const runHarness = () => {
  try {
    const out = execFileSync(process.execPath, [HARNESS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: /0 failed/.test(out), out };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
};

const filter = process.argv[2];
let caught = 0, missed = 0, bad = 0;

try {
  const base = runHarness();
  if ( !base.ok ) {
    console.error("基线就不是绿的，先修 harness：\n" + base.out.split("\n").slice(-15).join("\n"));
    process.exit(1);
  }
  console.log("基线：" + (base.out.match(/\d+ passed, \d+ failed/) ?? ["?"])[0] + "\n");

  for ( const [label, from, to] of MUTATIONS ) {
    if ( filter && !label.includes(filter) ) continue;
    const n = original.split(from).length - 1;
    if ( n !== 1 ) { console.log(`  ⚠ 变异自身有问题  ${label}（原文出现 ${n} 次，应为 1）`); bad++; continue; }
    writeFileSync(SRC, original.replace(from, to), "utf8");
    const r = runHarness();
    if ( r.ok ) {
      console.log(`  ❌ 假绿  ${label} —— 改坏了 harness 仍然全绿，这条断言没有约束力`);
      missed++;
    } else {
      const failed = (r.out.match(/(\d+) failed/) ?? [null, "?"])[1];
      const first = (r.out.match(/ {2}FAIL {2}(.*)/) ?? [null, "(崩溃)"])[1];
      console.log(`  ✅ 抓住  ${label}  → ${failed} 条断言变红，首条：${first}`);
      caught++;
    }
  }
} finally {
  writeFileSync(SRC, original, "utf8");
  try { unlinkSync(BAK); } catch { /* ignore */ }
}

console.log(`\n${caught} 抓住 / ${missed} 假绿 / ${bad} 变异自身有问题`);
const verify = runHarness();
console.log("还原后复跑：" + (verify.out.match(/\d+ passed, \d+ failed/) ?? ["?"])[0]);
process.exit((missed || bad || !verify.ok) ? 1 : 0);
