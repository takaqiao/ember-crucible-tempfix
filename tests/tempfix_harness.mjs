/**
 * 临时修补模块的离线冒烟测试：用最小 Foundry / Crucible 桩件跑一遍
 * init → setup → ready，然后断言每个补丁的可观察行为。
 *
 * 不需要 Foundry，直接 `node tempfix_harness.mjs`。
 *
 * ⚠ 桩件复刻的是**读出来的**系统语义，不是系统本身。每次给桩件加东西，
 *   都要在注释里写清对应的 crucible-compiled.mjs 行号，否则下一个人无法判断桩件对不对。
 *   历史教训：旧桩件 `game.messages` 恒空 + 默认档不是 auto，
 *   让 `ev.roll` / `ev.rollIndex` 这个 100% 失效的硬 bug 一路绿灯通过。
 */

const MODULE = new URL("../scripts/tempfix.mjs", import.meta.url).href;

/* ---------- 最小 Foundry 桩件 ---------- */

const hookRegistry = {};
globalThis.Hooks = {
  once(name, fn) { (hookRegistry[name] ??= []).push(fn); },
  on(name, fn) { (hookRegistry[name] ??= []).push(fn); }
};
const fire = async (name, ...args) => {
  for (const fn of hookRegistry[name] ?? []) await fn(...args);
};

/** 桩件里 settings 要保存 onChange 并在 set 时调用 —— 否则「开关」那两条断言恒真。 */
const settings = new Map();
const settingDefs = new Map();
const setSetting = (key, value) => {
  settings.set(key, value);
  const cfg = settingDefs.get(key);
  if (cfg?.onChange) cfg.onChange(value);
};

const UUID_REGISTRY = new Map();
globalThis.fromUuidSync = uuid => UUID_REGISTRY.get(uuid) ?? null;

globalThis.game = {
  ready: false,
  system: { id: "crucible" },
  i18n: { format: (k, d) => `${k}:${JSON.stringify(d)}` },
  settings: {
    register(mod, key, cfg) { const k = `${mod}.${key}`; settingDefs.set(k, cfg); settings.set(k, cfg.default); },
    get(mod, key) {
      const k = `${mod}.${key}`;
      if (!settings.has(k)) throw new Error(`not registered ${k}`);
      return settings.get(k);
    }
  },
  messages: { contents: [] },
  actors: [],
  scenes: [],
  packs: { get: () => ({ async getDocument(id) { return PACK[id] ?? null; } }) },
  user: { character: null }
};

let renderCount = 0;
globalThis.ui = {
  actors: { render() {} },
  // V1 窗口表（crucible 里其实一个都没有，保留是为了断言两个循环都跑到）
  windows: { 0: { actor: {}, render() { renderCount++; } } }
};

const setProperty = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {});
  cur[parts.at(-1)] = value;
};
globalThis.foundry = {
  utils: { deepClone: o => JSON.parse(JSON.stringify(o)), setProperty },
  // T1：crucible 的角色卡全是 ApplicationV2，只活在这里
  applications: { instances: new Map([["a", { document: { documentName: "Actor" }, render() { renderCount++; } }]]) }
};
globalThis.canvas = { tokens: { controlled: [] } };
globalThis.performance = globalThis.performance ?? { now: () => 0 };
globalThis._del = Symbol("delete");

/* ---------- Crucible 桩件 ---------- */

const SLOTS = { EITHER: 0, MAINHAND: 1, OFFHAND: 2, TWOHAND: 3 };
const TARGET_SCOPES = { NONE: 0, SELF: 1, ALLIES: 2, ENEMIES: 3, ALL: 4 };
globalThis.SYSTEM = { WEAPON: { SLOTS }, ACTION: { TARGET_SCOPES } };

/**
 * `CrucibleActionTags`：真实实现（:18426）对**未注册**的标签会 console.warn 并静默拒绝。
 * 桩件必须照做，否则将来补丁里拼错一个标签名不会有任何人发现。
 */
let rejectedTags = 0;
class TagSet extends Set {
  constructor(v) { super((v ?? []).filter(t => t in TAGS)); this.sorted = [...this]; }
  add(v) {
    if (!(v in TAGS)) { rejectedTags++; return this; }
    super.add(v); this.sorted = [...this]; return this;
  }
  delete(v) { const r = super.delete(v); this.sorted = [...this]; return r; }
  *tags() { for (const t of this.sorted) yield TAGS[t]; }
}

/** 标签注册表。`??=` 与裸 `=` 的差异是真实系统里决定「谁赢」的机制（见 tempfix 顶部前提 ③）。 */
const TAGS = {
  // generic.prepare :4316 —— 注意是 ??=
  generic: { tag: "generic", prepare() { this.usage.hasDice = true; this.usage.defenseType ??= "physical"; this.usage.resource ??= "health"; } },
  // willpower.prepare :4534 —— 裸 =，所以压得过 generic
  willpower: { tag: "willpower", prepare() { this.usage.defenseType = "willpower"; } },
  fortitude: { tag: "fortitude", prepare() { this.usage.defenseType = "fortitude"; } },
  reflex: { tag: "reflex", prepare() { this.usage.defenseType = "reflex"; } },
  // harmless.postActivate :4453 —— 只动带伤害的骰子
  harmless: { tag: "harmless", postActivate() { this.zeroed = true; } },
  weakened: { tag: "weakened", prepare() { this.usage.bonuses.damageBonus -= 6; } },
  reaction: { tag: "reaction" },
  movement: { tag: "movement" },
  composed: { tag: "composed", initialize() { this.composedRan = true; } },
  corruption: { tag: "corruption" },
  void: { tag: "void", prepare() { this.usage.damageType = "void"; } },
  presence: { tag: "presence" },
  morale: { tag: "morale", prepare() { this.usage.resource = "morale"; } },
  spell: { tag: "spell" }
};

/**
 * ember 在代码里注册的动作钩子（`crucible.api.hooks.action[id]`，见 tempfix 顶部前提 ①）。
 * 构造 CrucibleAction 时会像真实系统那样（:19023）冻结成 `this.hooks` 快照。
 */
let emberCanUseCalls = 0;
const HOOKS_ACTION = {
  mayisRestorativeRedirection: Object.freeze({
    canUse() {
      emberCanUseCalls++;
      if (this.actor?._noResistedSpell) throw new Error("Restorative Redirection can only be used after resisting an incoming Spell.");
      // ember.mjs:125221 —— 读的是法术动作上不存在的字段，恒为 "health"
      this.usage.resource = this.actor?._lastAction?.damage?.resource ?? "health";
    },
    initialize() { this.usage.bonuses.ability = this.actor.getAbilityBonus(["wisdom", "presence", "intellect"], { type: "best" }); },
    postActivate() { this.emberPostActivateRan = true; }
  }),
  bewilderingGaze: Object.freeze({
    postActivate() { this.emberPostActivateRan = true; }   // ember 用它施加 confused，绝不能被顶掉
  }),
  sentinelKick: Object.freeze({
    postActivate() { this.emberPostActivateRan = true; }   // 15 尺击退
  }),
  abyssMarkUnmaking: Object.freeze({
    canUse() { this.emberCanUseRan = true; },
    preActivate() { throw new Error("ember 的坏实现不应该被调用到"); }
  })
};

/**
 * 复刻核心 `ActiveEffect.#migrateDuration`（foundry.mjs:15931）：
 * 按 seconds → turns → rounds 顺序找第一个**数字**属性，补出 `{value, units}` 后 break。
 * `CrucibleAction.migrateData`（:21573）对每条 effect 都会调一次，所以活对象上看到的是迁移后的形态。
 */
const migrateDuration = d => {
  if (!d || typeof d !== "object") return d;
  for (const unit of ["seconds", "turns", "rounds"]) {
    if (Object.hasOwn(d, unit) && (typeof d[unit] === "number")) {
      if (!Object.hasOwn(d, "value")) d.value = d[unit];
      if (!Object.hasOwn(d, "units")) d.units = unit;
      break;
    }
  }
  return d;
};

/**
 * 复刻 `CrucibleActiveEffect._preCreate`（crucible-compiled.mjs:39581）里那道硬拦截：
 * units 是 months / turns 时 `return false` —— **效果压根不会被创建**。
 * @returns {boolean} 这个效果会不会被系统拒绝
 */
const preCreateWouldReject = effect => ["months", "turns"].includes(effect?.duration?.units);

class CrucibleAction {
  constructor(src, ctx = {}) {
    this.id = src.id;
    this.name = src.name;
    this.range = { ...(src.range ?? {}) };
    this.target = { type: "single", scope: TARGET_SCOPES.ALL, self: false, ...(src.target ?? {}) };
    this.tags = new TagSet(src.tags ?? []);
    this.usage = { hasDice: false, restoration: false, resource: null, defenseType: null, bonuses: { ability: 0, damageBonus: 0 } };
    this.effects = foundry.utils.deepClone(src.effects ?? []);
    for (const e of this.effects) if (e.duration) migrateDuration(e.duration);   // :21573
    this.hooks = HOOKS_ACTION[src.id] ?? Object.freeze({});   // :19023
    this.actor = ctx.actor ?? null;
    this.item = ctx.item ?? null;
    this.parent = ctx.parent ?? null;
    this.targets = new Map();
    this.selfUpdateEvent = { actorUpdates: {} };
    this.events = [];
  }
  recordEvent(e) { this.events.push(e); }
  *_tests() { yield* this.tags.tags(); yield this.hooks; }
  _call(hookName, ...args) {
    for (const t of this._tests()) {
      const fn = t?.[hookName];
      if (fn instanceof Function) fn.call(this, ...args);
    }
  }
  // 真实顺序：initialize(:20302) → prepare(:20320) → canUse(:20429) → preActivate(:20504)
  prepare() { this._call("initialize"); this._call("prepare"); }
  canUse() { this._call("canUse"); }
  preActivate() { this._call("preActivate"); }
}

const cantrip = (id, name) => ({
  toObject: () => ({ system: { actions: [{ id, name, range: { maximum: 1 }, tags: ["generic"] }] } })
});
const PACK = {
  runeStorm0000000: cantrip("energize", "聚能 Energize"),
  runeFlame0000000: cantrip("enkindle", "点燃 Enkindle"),
  runeIllusion0000: cantrip("seeming", "幻形 Seeming"),
  runeIllumination: cantrip("reveal", "显真 Reveal"),
  runeFrost0000000: cantrip("condense", "凝霜 Condense"),
  runeEarth0000000: cantrip("mould", "塑土 Mould"),
  runeDeath0000000: cantrip("ennervate", "衰朽 Ennervate")
};

/** 徒手武器：`_getUnarmedWeapon`（:41624）产的是纯内存实例，没有 _id。 */
let updateSourceCalls = 0;
const makeWeapon = ({ id = null, slot = SLOTS.EITHER, name = "拳头" } = {}) => {
  const source = { slot };
  return {
    id, name,
    system: {
      _source: source,
      get slot() { return source.slot; },
      updateSource(changes) { updateSourceCalls++; Object.assign(source, changes); }
    },
    toObject: () => ({ system: { ...source } })
  };
};

class CrucibleActor {
  constructor(name, items = [], weapons = {}) {
    this.name = name;
    this.uuid = `Actor.${name}`;
    this.level = 4;
    this.flags = { ember: {} };
    this.itemList = items;
    this.system = {
      actions: {},
      training: {},
      abilities: { presence: { value: 5 } },
      resources: { health: { value: 10 }, morale: { value: 10 }, wounds: { value: 0, max: 20 } }
    };
    this.equipment = { weapons };
    this.lastConfirmedAction = null;
    UUID_REGISTRY.set(this.uuid, this);
  }
  get items() { return this.itemList; }
  callActorHooks() {}
  getAbilityBonus(list, opts) { return opts?.type === "best" ? 7 : 3; }
  /** 真实系统在 prepareBaseData 的 #clear()（:41158）里把 actions **原地清空**再重填 */
  prepareData() {
    for (const k of Object.keys(this.system.actions)) delete this.system.actions[k];
    this.callActorHooks("prepareGrimoire", {});
    this.callActorHooks("prepareActions", this.system.actions);
  }
}
/**
 * `CrucibleActiveEffect._preCreate`（:39581）的桩件 —— N10 的 guard 会读它的**源码**
 * 来判断上游是否仍然拒绝 turns。所以这里必须是一个源码里真的含 "turns" 字面量的函数。
 */
class CrucibleActiveEffect {
  _preCreate() {
    if ( ["months", "turns"].includes(this.duration.units) ) return false;
  }
}

globalThis.CONFIG = {
  Actor: { documentClass: CrucibleActor },
  ActiveEffect: { documentClass: CrucibleActiveEffect }
};
globalThis.crucible = {
  api: {
    models: { CrucibleAction },
    // 外层 freeze、子表可写 —— ember 正是靠这一点注册进来的（:14044 / ember.mjs:126744）
    hooks: Object.freeze({
      action: HOOKS_ACTION,
      talent: {
        emberAbyssAttune: {
          finalizeAction: function embersFinalize() { /* 含坏 id 字面量 abyssMarkUnmak0 */ }
        }
      }
    })
  }
};

/* ---------- 跑生命周期 ---------- */

await import(MODULE);
await fire("init");
await fire("setup");
game.ready = true;
await fire("ready");

/* ---------- 断言 ---------- */

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${extra}`); }
};
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };

console.log("\nP1 副手打击");
{
  const mh = { id: "w1", name: "剑", system: { slot: SLOTS.MAINHAND }, toObject: () => ({ system: { slot: SLOTS.EITHER } }) };
  const oh = { id: "w2", name: "匕首", system: { slot: SLOTS.OFFHAND } };
  const actor = new CrucibleActor("A", [mh, oh], { mainhand: mh, offhand: oh });
  actor.itemList = { get: id => [mh, oh].find(i => i.id === id) ?? null, [Symbol.iterator]: function* () { yield mh; yield oh; } };

  actor.lastConfirmedAction = { events: [{ type: "strike", weapon: { _id: "w1", system: { slot: SLOTS.EITHER } } }] };
  const a = new CrucibleAction({ id: "offhandStrike", name: "副手打击" }, { actor });
  check("存盘 slot=EITHER 但武器正握在主手 → 放行", throws(() => a.canUse()) === null);

  actor.lastConfirmedAction = { events: [{ type: "strike", weapon: { _id: "w2", system: { slot: SLOTS.OFFHAND } } }] };
  check("上一击是副手武器 → 仍然拦住", throws(() => a.canUse()) !== null);

  actor.lastConfirmedAction = { events: [{ type: "move" }] };
  check("上一个动作不含 strike → 仍然拦住", throws(() => a.canUse()) !== null);

  actor.lastConfirmedAction = null;
  const e = throws(() => a.canUse());
  check("没有已确认动作 → 拦住且不抛 TypeError", e !== null && !(e instanceof TypeError), e?.name);
}

console.log("\nP1 的上游 guard（上游改好后必须自动退让）");
{
  const mh = { id: "w1", system: { slot: SLOTS.MAINHAND } };
  const actor = new CrucibleActor("P1guard", [mh], { mainhand: mh, offhand: mh });
  actor.itemList = { get: () => mh, [Symbol.iterator]: function* () { yield mh; } };
  actor.lastConfirmedAction = { events: [{ type: "move" }] };   // 会让我们的 canUse 拦住

  // 上游原实现还在（含两个特征串）→ 补丁照常顶掉它
  HOOKS_ACTION.offhandStrike = Object.freeze({
    canUse() { this.upstreamRan = true; /* MustFollowMainhandStrike + SLOTS.MAINHAND */ }
  });
  const a = new CrucibleAction({ id: "offhandStrike" }, { actor });
  check("特征串齐全 → 补丁生效（仍然拦住）", throws(() => a.canUse()) !== null);
  check("上游实现被顶掉了", !a.upstreamRan);

  // 模拟上游重写：特征串消失 → 补丁必须整键退让，改由上游自己把关
  HOOKS_ACTION.offhandStrike = Object.freeze({ canUse() { this.upstreamRan = true; } });
  const b = new CrucibleAction({ id: "offhandStrike" }, { actor });
  b.canUse();
  check("上游改写后补丁退让、不再拦截", b.upstreamRan === true);

  delete HOOKS_ACTION.offhandStrike;
}

console.log("\nN8 徒手 / 临时武器的手位");
{
  updateSourceCalls = 0;
  const fist1 = makeWeapon({ name: "左拳" });
  const fist2 = makeWeapon({ name: "右拳" });
  const actor = new CrucibleActor("N8", [], { mainhand: fist1, offhand: fist2 });
  actor.prepareData();
  check("主手徒手 → _source.slot = MAINHAND", fist1.system._source.slot === SLOTS.MAINHAND, String(fist1.system._source.slot));
  check("副手徒手 → _source.slot = OFFHAND", fist2.system._source.slot === SLOTS.OFFHAND, String(fist2.system._source.slot));

  // 修完之后，**原版**判据（只看快照 slot）就能通过了
  const snapshot = { _id: fist1.id, system: { ...fist1.system._source } };
  check("修完后原版判据也能通过", snapshot.system.slot === SLOTS.MAINHAND);

  const before = updateSourceCalls;
  actor.prepareData();
  check("幂等：已经修过就不再写", updateSourceCalls === before, `${before} → ${updateSourceCalls}`);

  updateSourceCalls = 0;
  const real = makeWeapon({ id: "realWeapon", slot: SLOTS.EITHER, name: "真剑" });
  const actor2 = new CrucibleActor("N8b", [], { mainhand: real });
  actor2.prepareData();
  check("有 _id 的真武器一律不碰", updateSourceCalls === 0 && real.system._source.slot === SLOTS.EITHER);
}

console.log("\nP2 撕咬范围");
{
  const actor = new CrucibleActor("B");
  const a = new CrucibleAction({ id: "suddenBite", range: { minimum: 2, maximum: 2 }, target: { type: "single" } }, { actor });
  a.prepare();
  check("single 目标 → min=null / max=1", a.range.minimum === null && a.range.maximum === 1, JSON.stringify(a.range));

  const cone = new CrucibleAction({ id: "suddenBite", range: { minimum: 2, maximum: 2 }, target: { type: "cone" } }, { actor });
  cone.prepare();
  check("上游若改成 cone → 不动它", cone.range.minimum === 2 && cone.range.maximum === 2);
}

console.log("\nP4 疗愈导流（重写后）");
{
  const actor = new CrucibleActor("C");
  // 桩一条「被抵抗的士气法术」聊天卡。序列化后骰子下标的键名是 rollIndex（:18296），不是 roll
  game.messages.contents = [{
    flags: { crucible: { action: { name: "幻梦", tags: ["spell"] }, events: [{ type: "spell", target: "Actor.C", rollIndex: 0 }] } },
    rolls: [{ data: { damage: { resource: "morale" } } }]
  }];
  setSetting("ember-crucible-tempfix.redirectResource", "auto");

  emberCanUseCalls = 0;
  const a = new CrucibleAction({ id: "mayisRestorativeRedirection", tags: ["reaction", "harmless", "weakened"] }, { actor });
  a.prepare();
  a.canUse();
  check("auto 档从 rollIndex 推断出 morale", a.usage.resource === "morale", a.usage.resource);
  check("ember 自己的 canUse 被复用（没有被顶掉）", emberCanUseCalls === 1, String(emberCanUseCalls));
  check("不再加 generic", !a.tags.has("generic"));
  check("不再删 harmless", a.tags.has("harmless"));
  check("不再强开掷骰", a.usage.hasDice === false && a.usage.restoration === false);
  check("weakened 的 -6 仍在", a.usage.bonuses.damageBonus === -6, String(a.usage.bonuses.damageBonus));
  check("ability 仍走 ember 的 type:'best'", a.usage.bonuses.ability === 7, String(a.usage.bonuses.ability));

  // 反向：ember 的 canUse 抛错时补丁不能吞
  const blocked = new CrucibleActor("C2");
  blocked._noResistedSpell = true;
  const b = new CrucibleAction({ id: "mayisRestorativeRedirection", tags: ["reaction"] }, { actor: blocked });
  b.prepare();
  check("ember 拒绝时补丁不吞异常", throws(() => b.canUse()) !== null);

  // 反向：固定档不去翻聊天记录
  setSetting("ember-crucible-tempfix.redirectResource", "health");
  const c = new CrucibleAction({ id: "mayisRestorativeRedirection", tags: ["reaction"] }, { actor });
  c.prepare(); c.canUse();
  check("固定档 health → 不受聊天记录影响", c.usage.resource === "health", c.usage.resource);
  setSetting("ember-crucible-tempfix.redirectResource", "auto");

  // 反向：ember 没注册钩子时不接管、不抛错
  const orphan = new CrucibleAction({ id: "mayisRestorativeRedirection", tags: [] }, { actor });
  orphan.hooks = Object.freeze({});
  check("ember 未注册钩子 → 不抛错", throws(() => orphan.canUse()) === null);
}

console.log("\nN1 湮灭之印的效果 ID");
{
  const actor = new CrucibleActor("N1");
  const victim = new CrucibleActor("Victim");
  const prior = new CrucibleActor("Prior");
  prior.effects = new Map([["abyssMarkUnmak0", {}]]);
  prior.effects.has = prior.effects.has.bind(prior.effects);
  actor.flags.ember.abyssMarkTarget = prior.uuid;

  const a = new CrucibleAction({ id: "abyssMarkUnmaking", effects: [{ name: "湮灭之印" }] }, { actor });
  a.targets.set("t", { actor: victim });
  a.preActivate();
  check("效果 ID 是合法的 16 字符", /^[a-zA-Z0-9]{16}$/.test(a.effects[0]._id), a.effects[0]._id);
  check("记下了新的标记目标", a.selfUpdateEvent.actorUpdates.flags?.ember?.abyssMarkTarget === victim.uuid);
  check("旧目标身上的**旧 id** 标记也会被清掉", a.events.some(e => e.effects?.[0]?._id === "abyssMarkUnmak0" && e.effects[0]._action === "delete"));

  const noTarget = new CrucibleAction({ id: "abyssMarkUnmaking", effects: [{ name: "x" }] }, { actor });
  check("没有目标时不抛错", throws(() => noTarget.preActivate()) === null);

  const cfg = crucible.api.hooks.talent.emberAbyssAttune;
  check("天赋侧 finalizeAction 已被覆盖", cfg.finalizeAction.__tempfixOverride === true);
  check("覆盖前留了原实现的引用", typeof cfg.finalizeAction.__tempfixOriginal === "function");
}

console.log("\nN2 效果 changes 的层级");
{
  const actor = new CrucibleActor("N2");
  const a = new CrucibleAction({ id: "sentinelShielding", effects: [{ name: "守护", system: {} }] }, { actor });
  a.preActivate();
  check("写进了 effect.system.changes", a.effects[0].system.changes?.[0]?.key === "system.defenses.armor.bonus");
  check("type = add", a.effects[0].system.changes[0].type === "add");
  check("没有写回顶层", a.effects[0].changes === undefined);

  const t = new CrucibleAction({ id: "tyraphicTransformation", effects: [{ name: "变身", system: {} }] }, { actor });
  t.preActivate();
  check("辐能抗性 = 2 × 等级(4) = 8", t.effects[0].system.changes[0].value === 8, String(t.effects[0].system.changes[0].value));
  check("辐能伤害 = ceil(存在5 / 2) = 3", t.effects[0].system.changes[1].value === 3, String(t.effects[0].system.changes[1].value));

  const empty = new CrucibleAction({ id: "sentinelShielding", effects: [] }, { actor });
  check("effects 为空 → 不抛错", throws(() => empty.preActivate()) === null);
  const noSystem = new CrucibleAction({ id: "sentinelShielding", effects: [{ name: "x" }] }, { actor });
  check("上游改了 schema（无 system）→ 静默跳过", throws(() => noSystem.preActivate()) === null);
}

console.log("\nN3 排斥踢的踉跄时长");
{
  const actor = new CrucibleActor("N3");
  const a = new CrucibleAction({ id: "sentinelKick", effects: [{ statuses: ["staggered"], duration: { value: 1, units: "", expiry: null } }] }, { actor });
  a.preActivate();
  const d = a.effects[0].duration;
  check("补上 units=rounds", d.units === "rounds", JSON.stringify(d));
  check("补上 expiry=turnStart", d.expiry === "turnStart");
  check("ember 的击退 postActivate 仍在", a.hooks.postActivate === HOOKS_ACTION.sentinelKick.postActivate);

  const fixed = new CrucibleAction({ id: "sentinelKick", effects: [{ duration: { value: 1, units: "rounds", expiry: "turnEnd" } }] }, { actor });
  fixed.preActivate();
  check("上游修好了 → 原样不动", fixed.effects[0].duration.expiry === "turnEnd");

  const perm = new CrucibleAction({ id: "sentinelKick", effects: [{ duration: { value: null, units: "" } }] }, { actor });
  perm.preActivate();
  check("合法的「无时限」写法 → 不动", perm.effects[0].duration.units === "");
}

console.log("\nN4 余烬之火的作用域");
{
  const actor = new CrucibleActor("N4");
  const a = new CrucibleAction({ id: "heartSparkOfEmber", target: { type: "single", scope: TARGET_SCOPES.ENEMIES } }, { actor });
  a.prepare();
  check("ENEMIES → ALL", a.target.scope === TARGET_SCOPES.ALL, String(a.target.scope));
  a.prepare();
  check("幂等：再跑一次仍是 ALL", a.target.scope === TARGET_SCOPES.ALL);

  const hallow = new CrucibleAction({ id: "heartHallow", target: { type: "single", scope: TARGET_SCOPES.ENEMIES } }, { actor });
  hallow.prepare();
  check("同天赋的 heartHallow（减益）不受影响", hallow.target.scope === TARGET_SCOPES.ENEMIES);
}

console.log("\nN5 迷乱凝视的防御标签");
{
  const actor = new CrucibleActor("N5");
  const a = new CrucibleAction({ id: "bewilderingGaze", tags: ["generic", "void", "presence", "morale"] }, { actor });
  a.prepare();
  check("补上了 willpower", a.tags.has("willpower"));
  check("defenseType = willpower（裸 = 压过 generic 的 ??=）", a.usage.defenseType === "willpower", a.usage.defenseType);
  check("ember 的 postActivate 没被顶掉", a.hooks.postActivate === HOOKS_ACTION.bewilderingGaze.postActivate);

  const already = new CrucibleAction({ id: "bewilderingGaze", tags: ["generic", "fortitude"] }, { actor });
  already.prepare();
  check("已有其它防御标签 → 不再加 willpower", !already.tags.has("willpower") && already.usage.defenseType === "fortitude");

  const notGeneric = new CrucibleAction({ id: "bewilderingGaze", tags: ["reaction"] }, { actor });
  notGeneric.prepare();
  check("归属判据：没有 generic 就不插手", !notGeneric.tags.has("willpower"));
}

console.log("\nN6 反重力石的目标类型");
{
  const actor = new CrucibleActor("N6");
  const a = new CrucibleAction({ id: "antigravityStone", tags: ["movement"], target: { type: "single", self: false } }, { actor });
  a.prepare();
  check("single → self", a.target.type === "self", a.target.type);
  check("movement 标签仍在（位移规划不能丢）", a.tags.has("movement"));

  const fixed = new CrucibleAction({ id: "antigravityStone", tags: ["movement"], target: { type: "single", self: true } }, { actor });
  fixed.prepare();
  check("上游改成 self:true → 不动", fixed.target.type === "single");
}

console.log("\nN7 暗焰头冠的 composed 标签");
{
  const actor = new CrucibleActor("N7");
  const a = new CrucibleAction({ id: "darkflameCirclet", tags: ["composed", "corruption"] }, { actor });
  a.prepare();
  check("移除了 composed", !a.tags.has("composed"));
  check("corruption 保留", a.tags.has("corruption"));
  check("幂等：再跑一次不抛错", throws(() => a.prepare()) === null);

  const spell = new CrucibleAction({ id: "someSpell", tags: ["composed"] }, { actor });
  spell.prepare();
  check("只按 id 命中：别的 composed 动作不被碰", spell.tags.has("composed"));
}

console.log("\nP3 / N9 符文小戏法与训练等级");
{
  const talent = (id, rune, training = { type: "", rank: null }, actions = []) =>
    ({ id, type: "talent", name: id, system: { rune, training, actions } });

  const zeph = talent("emberZephLineage", "storm", { type: "storm", rank: 1 });
  const actor = new CrucibleActor("D", [zeph]);
  actor.prepareData();
  check("注入了 energize", !!actor.system.actions.energize, Object.keys(actor.system.actions).join(","));
  check("带上了合集里的中文名", actor.system.actions.energize?.name === "聚能 Energize");
  check("T2：不传 parent（否则配置卡一改就报错）", !actor.system.actions.energize.parent);
  check("T2：item 关联仍在", actor.system.actions.energize.item === zeph);

  const before = Object.keys(actor.system.actions).length;
  actor.prepareData();
  check("重复准备不会重复注入", Object.keys(actor.system.actions).length === before);

  // N9：按 rune 查表，所以小写 id 的旧快照同样命中，并补上训练等级
  const stale = talent("runeflame0000000", "flame");
  const summon = new CrucibleActor("Summon", [stale]);
  summon.prepareData();
  check("旧快照（小写 id）也被命中 → enkindle", !!summon.system.actions.enkindle);
  check("补上了训练等级 flame = 1", summon.system.training.flame === 1, JSON.stringify(summon.system.training));

  const frost = new CrucibleActor("Frost", [talent("runefrost0000000", "frost")]);
  frost.prepareData();
  check("新增的 frost → condense", !!frost.system.actions.condense);

  const trained = new CrucibleActor("Trained", [talent("x", "illumination", { type: "illumination", rank: 2 })]);
  trained.system.training.illumination = 2;
  trained.prepareData();
  check("上游已填训练等级 → 整条跳过", trained.system.training.illumination === 2);

  // 旧快照（training.type 为空，会走到赋值那一行）但角色已从别处拿到更高等级 —— 不能被压回 1
  const higher = new CrucibleActor("Higher", [talent("runeStorm0000000", "storm")]);
  higher.system.training.storm = 3;
  higher.prepareData();
  check("旧快照 + 已有更高等级 → 取 max 不降级", higher.system.training.storm === 3, String(higher.system.training.storm));

  const own = new CrucibleActor("Own", [talent("runeStorm0000000", "storm", { type: "storm", rank: 1 }, [{ id: "energize" }])]);
  own.prepareData();
  check("条目自己就带该动作 → 不重复注入", !own.system.actions.energize);

  const healer = new CrucibleActor("Healer", [talent("healer0000000000", "life")]);
  healer.prepareData();
  check("life（Healer）不在表里 → 不注入、不改训练", !healer.system.actions.fontOfLife && healer.system.training.life === undefined);
}

console.log("\nN10 units:\"turns\" 的效果永远不会被创建");
{
  const actor = new CrucibleActor("N10");

  // 迁移链：数据里的 {turns:6} → 活对象上的 {value:6, units:"turns"} → 被 _preCreate 拒绝
  const raw = new CrucibleAction({ id: "tyraphicTransformation", effects: [{ name: "变身", system: {}, duration: { turns: 6 } }] }, { actor });
  check("迁移把 {turns:6} 变成 {value:6, units:'turns'}", raw.effects[0].duration.value === 6 && raw.effects[0].duration.units === "turns",
    JSON.stringify(raw.effects[0].duration));

  raw.preActivate();
  check("units 由 turns 改成 rounds", raw.effects[0].duration.units === "rounds", raw.effects[0].duration.units);
  check("value 保持不变", raw.effects[0].duration.value === 6, String(raw.effects[0].duration.value));
  check("补上 expiry=turnEnd（依据上游 PR #695 的 49/49 映射）", raw.effects[0].duration.expiry === "turnEnd", raw.effects[0].duration.expiry);
  check("修完之后系统不再拒绝创建", preCreateWouldReject(raw.effects[0]) === false);

  // {turns:1, rounds:null} 这种混写（ember 敌手侧的写法）同样要救回来
  const mixed = new CrucibleAction({ id: "abyssalWhispers", effects: [{ name: "低语", duration: { turns: 3, rounds: null } }] }, { actor });
  mixed.preActivate();
  check("{turns:N, rounds:null} 混写同样被修好", mixed.effects[0].duration.units === "rounds" && mixed.effects[0].duration.value === 3,
    JSON.stringify(mixed.effects[0].duration));

  // 多条 effects 全都要处理
  const multi = new CrucibleAction({ id: "someAction", effects: [{ duration: { turns: 1 } }, { duration: { turns: 2 } }] }, { actor });
  multi.preActivate();
  check("多条 effects 全部处理", multi.effects.every(e => e.duration.units === "rounds"));

  // 反向：本来就合法的不动
  const fine = new CrucibleAction({ id: "someAction", effects: [{ duration: { value: 1, units: "rounds", expiry: "turnEnd" } }] }, { actor });
  fine.preActivate();
  check("已经合法的 rounds → 原样不动", fine.effects[0].duration.expiry === "turnEnd" && fine.effects[0].duration.value === 1);

  // 反向：没有 effects / 没有 duration 不抛错
  check("没有 effects 不抛错", throws(() => new CrucibleAction({ id: "someAction" }, { actor }).preActivate()) === null);
  check("effect 没有 duration 不抛错", throws(() => new CrucibleAction({ id: "someAction", effects: [{ name: "x" }] }, { actor }).preActivate()) === null);

  // **最关键的反向断言**：通用补丁是额外 yield 一格，不能把按 id 的补丁或 ember 的钩子顶掉
  const kick = new CrucibleAction({ id: "sentinelKick", effects: [{ duration: { value: 1, units: "", expiry: null } }] }, { actor });
  kick.preActivate();
  check("不影响 N3：sentinelKick 仍被补成 rounds", kick.effects[0].duration.units === "rounds");
  check("不影响 ember：sentinelKick 的 postActivate 仍在", kick.hooks.postActivate === HOOKS_ACTION.sentinelKick.postActivate);

  const abyss = new CrucibleActor("N10b");
  const victim = new CrucibleActor("N10victim");
  const mark = new CrucibleAction({ id: "abyssMarkUnmaking", effects: [{ name: "印记", duration: { turns: 3 } }] }, { actor: abyss });
  mark.targets.set("t", { actor: victim });
  mark.preActivate();
  check("不影响 N1：效果 ID 仍被改成 16 字符", /^[a-zA-Z0-9]{16}$/.test(mark.effects[0]._id), mark.effects[0]._id);
  check("同时 duration 也被修好", mark.effects[0].duration.units === "rounds");

  // N2 不再空转：changes 与 duration 两件事都做到了，效果才真的会被创建
  const shield = new CrucibleAction({ id: "sentinelShielding", effects: [{ name: "守护", system: {}, duration: { turns: 1, rounds: null } }] }, { actor });
  shield.preActivate();
  check("N2 不再空转：changes 写对了层级", shield.effects[0].system.changes?.[0]?.key === "system.defenses.armor.bonus");
  check("N2 不再空转：效果这次真的会被创建", preCreateWouldReject(shield.effects[0]) === false);
}

console.log("\nN10 的上游 guard（上游放宽后必须自动停用）");
{
  const actor = new CrucibleActor("N10guard");
  const realPreCreate = CONFIG.ActiveEffect.documentClass.prototype._preCreate;
  // 模拟上游放宽：_preCreate 源码里不再有 "turns" 字面量
  CONFIG.ActiveEffect.documentClass.prototype._preCreate = function () { return undefined; };
  globalThis.emberCrucibleTempFix.resetTurnsGuard();

  const a = new CrucibleAction({ id: "tyraphicTransformation", effects: [{ duration: { turns: 6 } }] }, { actor });
  a.preActivate();
  check("上游放宽后不再改写时长（不擅自改数值语义）", a.effects[0].duration.units === "turns", a.effects[0].duration.units);

  CONFIG.ActiveEffect.documentClass.prototype._preCreate = realPreCreate;
  globalThis.emberCrucibleTempFix.resetTurnsGuard();
  const b = new CrucibleAction({ id: "tyraphicTransformation", effects: [{ duration: { turns: 6 } }] }, { actor });
  b.preActivate();
  check("拦截还在时照常改写", b.effects[0].duration.units === "rounds");
}

console.log("\nT1 角色卡刷新");
{
  renderCount = 0;
  globalThis.emberCrucibleTempFix.reprepareActors();
  check("V1 与 V2 两个循环都跑到了", renderCount === 2, String(renderCount));
}

console.log("\n开关");
{
  check("默认全开", !!ACTIONS().suddenBite && !!ACTIONS().sentinelKick);
  setSetting("ember-crucible-tempfix.patchSuddenBite", false);
  check("关掉 patchSuddenBite → 从表里摘掉", ACTIONS().suddenBite === undefined);
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("开回来 → 又出现", !!ACTIONS().suddenBite);

  setSetting("ember-crucible-tempfix.patchEffectChanges", false);
  check("一个开关管两个动作", ACTIONS().sentinelShielding === undefined && ACTIONS().tyraphicTransformation === undefined);
  setSetting("ember-crucible-tempfix.patchEffectChanges", true);

  check("关掉后动作行为回到上游原样", (() => {
    setSetting("ember-crucible-tempfix.patchSuddenBite", false);
    const a = new CrucibleAction({ id: "suddenBite", range: { minimum: 2, maximum: 2 }, target: { type: "single" } }, {});
    a.prepare();
    const untouched = (a.range.minimum === 2) && (a.range.maximum === 2);
    setSetting("ember-crucible-tempfix.patchSuddenBite", true);
    return untouched;
  })());

  check("通用补丁默认在册", globalThis.emberCrucibleTempFix.UNIVERSAL_PATCHES.length === 1);
  check("关掉 N10 → 时长不再被改写", (() => {
    setSetting("ember-crucible-tempfix.patchTurnsDuration", false);
    const a = new CrucibleAction({ id: "tyraphicTransformation", effects: [{ system: {}, duration: { turns: 6 } }] }, {});
    a.preActivate();
    const untouched = a.effects[0].duration.units === "turns";
    setSetting("ember-crucible-tempfix.patchTurnsDuration", true);
    return untouched;
  })());

  check("桩件会拒绝未注册的标签", rejectedTags === 0, `拒绝了 ${rejectedTags} 个 —— 说明补丁里有拼错的标签名`);
  check("暴露了 diagnose", typeof globalThis.emberCrucibleTempFix.diagnose === "function");
}

function ACTIONS() { return globalThis.emberCrucibleTempFix.ACTION_PATCHES; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
