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

/** 真的 module.json 里的版本 —— 桩件与断言都用它，避免写死后随发版腐烂 */
const MANIFEST_VERSION = JSON.parse(
  (await import("node:fs")).readFileSync(
    new URL("../module.json", import.meta.url), "utf8")).version;

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
const getSetting = key => settings.get(key);
/** 与 tempfix.mjs 里的 esc() 同款，供面板断言比对 */
const esc = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const setSetting = (key, value) => {
  settings.set(key, value);
  const cfg = settingDefs.get(key);
  if (cfg?.onChange) cfg.onChange(value);
};

const UUID_REGISTRY = new Map();
globalThis.fromUuidSync = uuid => UUID_REGISTRY.get(uuid) ?? null;

const registeredMenus = [];
globalThis.game = {
  ready: false,
  version: "14.0.0",
  // ⚠ 版本**从真的 module.json 读**，不要写死。写死会随发版腐烂，
  //   而它恰恰是「缓存旧脚本」检测机制的对照物 —— 桩件一旦跟清单对不上，
  //   那条检测就会在离线测试里假红/假绿，机制本身反而没人守。
  modules: { get: id => ({ id, version: MANIFEST_VERSION, active: true }) },
  system: { id: "crucible", version: "0.10.1" },
  i18n: { format: (k, d) => `${k}:${JSON.stringify(d)}` },
  settings: {
    // ⚠ 真实 `ClientSettings` 有 `this.settings`（id → config 的 Map，register 往里写、
    //   `#assertSetting` 从里读）。桩件以前没有这一项，于是
    //   `game.settings.settings?.has?.(…) !== false` 求值成 `undefined !== false` —— **恒真**。
    //   那条盯着 redirectResource 注册的断言因此是同义反复：把注册整段删掉它照样绿。
    //   （与本文件里 `menus` 从数组改成 Map 是同一类坑，栽第二次了。）
    settings: settingDefs,
    register(mod, key, cfg) { const k = `${mod}.${key}`; settingDefs.set(k, cfg); settings.set(k, cfg.default); },
    // registerMenu 只在拿得到 ApplicationV2 时才被调用；桩件里记下来供断言核对。
    // ⚠ 真实 Foundry 是 `this.menus.set(\`${namespace}.${key}\`, data)`（foundry.mjs:203510），
    //   `menus` 是个 **Map** —— 代码里靠 `game.settings.menus.has(...)` 判断面板注册没有。
    //   桩件只记数组的话那条判据永远读不到东西，断言会假红（这次就是）。
    menus: new Map(),
    registerMenu(mod, key, data) {
      const k = `${mod}.${key}`;
      registeredMenus.push({ key: k, ...data });
      this.menus.set(k, { ...data, key: k, namespace: mod });
    },
    set(mod, key, value) { setSetting(`${mod}.${key}`, value); return Promise.resolve(value); },
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
  user: { character: null, isGM: false }
};

let renderCount = 0;
let warnCount = 0;
const _realWarn = console.warn;
console.warn = (...a) => { warnCount++; _realWarn(...a); };
let notifications = [];
globalThis.ui = {
  actors: { render() {} },
  // V1 窗口表（crucible 里其实一个都没有，保留是为了断言两个循环都跑到）
  windows: { 0: { actor: {}, render() { renderCount++; } } },
  notifications: {
    info: m => notifications.push(["info", m]),
    warn: m => notifications.push(["warn", m]),
    error: m => notifications.push(["error", m])
  }
};

const setProperty = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {});
  cur[parts.at(-1)] = value;
};
/** 复刻核心 `foundry.utils.isNewerVersion`（foundry.mjs:2491）：v1 是否比 v0 新；相等返回 false。 */
const isNewerVersion = (v1, v0) => {
  if ((v1 === null) || (v1 === undefined)) return false;
  if ((v0 === null) || (v0 === undefined)) return true;
  const a = String(v1).split("."), b = String(v0).split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number(a[i] ?? 0), y = Number(b[i] ?? 0);
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
};

globalThis.foundry = {
  utils: { deepClone: o => JSON.parse(JSON.stringify(o)), setProperty, isNewerVersion },
  // T1：crucible 的角色卡全是 ApplicationV2，只活在这里
  applications: {
    instances: new Map([["a", { document: { documentName: "Actor" }, render() { renderCount++; } }]]),
    /**
     * 控制面板要 `extends` 它。桩件必须**存在**，否则 `getToolboxClass()` 直接返回 null，
     * 整条面板类定义的路径一次都跑不到 —— 0.7.0 就是这么漏测的：
     * 面板 HTML 有断言，而「类能不能建起来、菜单有没有注册上」一条都没有。
     */
    api: {
      ApplicationV2: class ApplicationV2 {
        static DEFAULT_OPTIONS = { id: "app", classes: [], actions: {} };
        constructor(options = {}) { this.options = options; }
        render() { this.rendered = true; return this; }
      }
    }
  }
};
globalThis.canvas = { tokens: { controlled: [], placeables: [] } };
globalThis.performance = globalThis.performance ?? { now: () => 0 };
globalThis._del = Symbol("delete");

/* ---------- Crucible 桩件 ---------- */

const SLOTS = { EITHER: 0, MAINHAND: 1, OFFHAND: 2, TWOHAND: 3 };
const TARGET_SCOPES = { NONE: 0, SELF: 1, ALLIES: 2, ENEMIES: 3, ALL: 4 };
globalThis.SYSTEM = { WEAPON: { SLOTS }, ACTION: { TARGET_SCOPES },
  DAMAGE_TYPES: { acid: {id: "acid"}, corruption: {id: "corruption"}, fire: {id: "fire"} } };

/**
 * `CrucibleActionTags`：真实实现（:18426）对**未注册**的标签会 console.warn 并静默拒绝。
 * 桩件必须照做，否则将来补丁里拼错一个标签名不会有任何人发现。
 */
let rejectedTags = 0;
class TagSet extends Set {
  // 真实实现（models/action.mjs:422-487）构造时是**逐个 add**，不是 filter ——
  // 所以构造路径同样会走 propagate、同样会计入拒绝数。
  constructor(v) { super(); for ( const t of v ?? [] ) this.add(t); this.#sort(); }
  add(v) {
    if ( this.has(v) ) return this;
    if (!(v in TAGS)) { rejectedTags++; return this; }
    super.add(v);
    // **传播**：thrown → melee → strike，natural → melee → strike（const/action.mjs:904/805/931）。
    // 漏掉它，带 thrown 的动作在桩件里就没有 strike 标签，而 strike 才是真正挑武器的那个 ——
    // I7 的「自动脱困」假绿正是这么藏住的。
    for ( const p of TAGS[v].propagate ?? [] ) this.add(p);
    this.#sort();
    return this;
  }
  delete(v) { const r = super.delete(v); this.#sort(); return r; }
  /** 逐字照抄上游的比较器：绝大多数标签没有 priority ⇒ NaN ⇒ V8 保持插入序 */
  #sort() { this.sorted = Array.from(this).sort((a, b) => TAGS[a].priority - TAGS[b].priority); }
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
  spell: { tag: "spell" },
  // 伤害类型标签：initialize 里 ??= 先到先得（:4662）
  electricity: { tag: "electricity", initialize() { this.usage.damageType ??= "electricity"; } },
  piercing: { tag: "piercing", initialize() { this.usage.damageType ??= "piercing"; } },
  fire: { tag: "fire", initialize() { this.usage.damageType ??= "fire"; } },
  psychic: { tag: "psychic", initialize() { this.usage.damageType ??= "psychic"; } },
  natural: { tag: "natural", propagate: ["melee"], prepare() { this.usage.damageType ??= "bludgeoning"; } },
  /**
   * `strike`（const/action.mjs:680-707）—— **它才是挑武器的那个**，而且它是**标签**，
   * 所以排在 `this.hooks` 与本模块 UNIVERSAL_PATCHES **之前**（models/action.mjs:2296-2298
   * `yield* this.tags.tags(); yield this.hooks;`，通用补丁再由 tempfix 追加在最后）。
   *
   * ⚠ 此前桩件把这段逻辑提成一个真实世界**并不存在**的方法 `_resolveWeapon()`，
   * 并放在 `_call("prepare")` 之后 —— 于是 I7 的通用补丁在桩件里排在挑武器**之前**，
   * 在真实世界排在**之后**。两条「自动脱困」断言因此对着虚构一直是绿的。
   */
  strike: {
    tag: "strike",
    priority: Infinity,                   // 标签里的最后一个
    initialize() { this.usage.strikes = []; },
    prepare() {
      if ( this.usage.weaponChoices ) {
        const choices = this.getValidWeaponChoices();
        const locked = this.usage.weaponChoice ? choices.find(c => c.id === this.usage.weaponChoice)?.item : null;
        this.usage.weapon = locked ?? choices[0]?.item;
      }
      const strikes = this.usage.strikes ??= [];
      if ( !strikes.length && this.usage.weapon ) strikes.push(this.usage.weapon);
    }
  },
  melee: {
    tag: "melee",
    propagate: ["strike"], priority: 1,   // const/action.mjs:805-806
    // :4147-4154 —— 上游确立的写法：需求标签在 prepare 里把用不了的武器标成不可选
    prepare() {
      if ( this.tags.has("ranged") ) return;
      for ( const c of this.usage.weaponChoices ?? [] ) {
        if ( c.item.config.category.ranged ) c.viable = false;
      }
    }
  },
  /**
   * :4239-4263 —— **复刻缺陷本身**：`thrown.prepare` 只设 range，
   * 一个字都没过滤 weaponChoices，尽管它的 canUse/preActivate 都对 !canThrow 抛错。
   * I7 补的就是这里缺的那个循环。
   */
  thrown: {
    tag: "thrown",
    propagate: ["melee"],                 // const/action.mjs:904
    prepare() {
      this.range.maximum ??= 10;
      this.range.weapon = false;
    },
    canUse() {
      for ( const w of this.usage.strikes ?? [] ) {
        if ( !w.system.canThrow ) throw new Error("CannotThrow");
      }
    }
  },
  // :4432 —— 累加写法，这就是 #1404 会叠加的根源
  empowered: { tag: "empowered", prepare() { this.usage.bonuses.damageBonus += 6; } }
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
    // ember.mjs:125607 的坏实现。**源码里必须含 "abyssMarkUnmak0" 字面量** ——
    // 那正是 N1 两侧 guard 认的特征串；桩件缺了它，补丁会判定「上游已变」而退让。
    preActivate() {
      this.effects[0]._id = "abyssMarkUnmak0";
      throw new Error("ember 的坏实现不应该被调用到");
    }
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
    // :19107 的 Reset bonuses 块共六个字段
    this.usage = { hasDice: false, restoration: false, resource: null, defenseType: null,
      bonuses: { ability: 0, skill: 0, enchantment: 0, damageBonus: 0, multiplier: 1, criticalSuccessThreshold: 0 } };
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
  _configureUsage() {
    this.usage.hasDice = false;
    // :20286 原文——注意它只重置 cost，bonuses 一个都不碰
    // Reset cost fields to their source values so that repeated prepare() calls do not accumulate costs
  }
  /**
   * `_prepareWeaponChoices()`（:20134）的桩件。**每一条都以 `viable: true` 出厂** ——
   * 上游那段的注释写着「Requirement tags further restrict viability during action preparation」，
   * 也就是把过滤责任交给了各个需求标签。I7 修的正是 `thrown` 没尽这个责任。
   */
  _prepareWeaponChoices() {
    if ( !this.__weapons ) return null;
    return this.__weapons.map(w => ({ item: w, id: w.id, label: w.name, viable: true }));
  }
  /** :20167 —— 只留 viable 的那些 */
  getValidWeaponChoices() { return (this.usage.weaponChoices ?? []).filter(c => c.viable); }
  /**
   * `strike.prepare`(:4034-4044) 里挑武器那一段。`locked` 只在 **valid** 集合里找 ——
   * 这正是「非法选项从列表里消失后，卡住的选择会自动脱困」的机制所在。
   */
  /**
   * models/action.mjs:1187-1192。挑武器**不在这里** —— 它在 `strike` 标签的 prepare 里，
   * 因而发生在 `_call("prepare")` 的标签阶段，早于 hooks、更早于通用补丁。
   * （从前这里多一句 `this._resolveWeapon()`，那是个上游并不存在的方法，见 TAGS.strike 的注释。）
   */
  prepare() {
    this._configureUsage();
    this.usage.weaponChoices = this._prepareWeaponChoices();
    this._call("initialize");
    this._call("prepare");
  }
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
    this.type = "hero";
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
  /** :36914 —— 只读背景那一份，这就是 #1412 的 bug 本体 */
  hasKnowledge(knowledgeId) {
    if (this.type !== "hero") return false;
    return this.system.details.background.knowledge.has(knowledgeId);
  }
  /** :36937 —— const check 那一句就是 bug 本体，也是闸门认的特征串 */
  async rollSkill(skillId, {banes = 0, boons = 0, dc, messageMode, dialog, chatMessage = false} = {}) {
    if (dialog === true) dialog = {};
    const skills = dialog?.skills;
    if (skills) { skillId ??= Object.keys(skills)[0]; dc ??= skills[skillId].dc; }
    const check = this.getSkillCheck(skillId, {banes, boons, dc, passive: false});
    if (dialog) { const response = await check.dialog({}); if (response === null) return null; }
    await check.evaluate({});
    return check;
  }
  getSkillCheck(skillId) { return { data: {type: skillId, messageMode: null}, async dialog() { return this.__swapTo ?? this; }, async evaluate() { this.evaluated = true; }, async toMessage() {} }; }
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
  constructor(duration) { if ( duration ) this.duration = duration; }
  prepareBaseData() {}
  /** 复刻 `:39567` 的 `this.updateSource({...})`——`_preCreate` 里就是这样改自己的 */
  updateSource(changes) { for ( const [k, v] of Object.entries(changes) ) {
    if ( v && (typeof v === "object") && !Array.isArray(v) ) Object.assign(this[k] ??= {}, v);
    else this[k] = v;
  } }
  async _preCreate() {
    if ( ["months", "turns"].includes(this.duration.units) ) return false;
  }
}

/**
 * 武器/护甲数据模型的桩件，复刻 0.10.1 的**缺陷本身**（上游 bea623d8 修的就是这个）：
 * 附魔加值在 `prepareBaseData` 里就算死（:45092 / :44225），而**词缀**要到派生阶段才解析完，
 * 所以 base 阶段读到的 `config.enchantment` 是词缀生效之前的值。
 * 桩件用 `__affixEnchantment` 表示「词缀最终会推导出来的附魔加值」，
 * `config` 是个 getter：base 阶段（`__derived` 为假）返回 0，派生阶段才返回真值。
 */
class CruciblePhysicalStub {
  constructor() { this.__affixEnchantment = 0; this.__derived = false; }
  get config() { return { enchantment: { bonus: this.__derived ? this.__affixEnchantment : 0 } }; }
}
class CrucibleWeaponModel extends CruciblePhysicalStub {
  // :45092 —— 特征串必须与 guard 对得上
  prepareBaseData() {
    const { enchantment } = this.config;
    this.actionBonuses = { ability: 0, skill: -4, enchantment: enchantment.bonus };
  }
  prepareDerivedData() { this.__derived = true; }
}
class CrucibleArmorModel extends CruciblePhysicalStub {
  // :44225 —— 同上
  prepareBaseData() {
    const { enchantment } = this.config;
    this.armor = { base: 0 };
    this.dodge = { base: 10 + enchantment.bonus };   // category.dodge.base(this.armor.base) + enchantment.bonus
  }
  prepareDerivedData() { this.__derived = true; }
}

/**
 * 角色卡基类桩件：复刻 `#prepareBiography()`（:14663）**无条件**把 private 三件套
 * 塞进上下文这一点 —— 那句 `secrets: this.document.isOwner` 只管富文本里的 secret 块，
 * 管不到 private 字段本身，所以 limited/observer 的人照样读得到原文（issue #1406）。
 */
class CrucibleBaseActorSheetStub {
  constructor(document) { this.document = document; }
  async _prepareContext() {
    // ac1b5cfc 的坏循环：上界每 push 一件就缩一格
    const featuredEquipment = [];
    const natural = this.document?.equipment?.weapons?.natural ?? [];
    for ( let i = 0; i < 3 - featuredEquipment.length; i++ ) {
      const n = natural[i];
      if ( n ) featuredEquipment.push({ name: n.name, type: n.type, uuid: n.uuid, img: n.img, tags: [] });
    }
    const armor = this.document?.equipment?.armor;
    if ( armor ) featuredEquipment.push({ name: armor.name, type: "armor", uuid: armor.uuid, img: "", tags: [] });
    return {
      featuredEquipment,
      biography: {
        publicField: {}, publicSrc: "公开", publicHTML: "<p>公开</p>", publicClass: "public-biography",
        privateField: {}, privateSrc: "GM 私记", privateHTML: "<p>GM 私记</p>", privateClass: "private-biography"
      }
    };
  }
}

/**
 * AttackRoll 桩件，复刻 `:3311` 的关键两行：
 *   `cardData.defenseType` **人人都算**；
 *   `if ( game.user.isGM ) cardData.targetLabel = ...`  ← 只给 GM
 * 而模板渲染的是 `{{targetLabel}}`（standard-check-chat.hbs:13），所以非 GM 什么都看不到。
 */
/**
 * `AttackRoll#_prepareChatRenderContext` 的桩件。
 *
 * ⚠ 这个桩件曾经**只复刻了一半**，害得 I5 的 5 条断言对着虚构行为长期变绿，
 *   而真实的 I5 补丁**一次都没执行过**。教训：桩件只复刻「我以为的那一段」，
 *   等于把自己的错误理解写成测试基准。必须把**整条调用链**复刻出来。
 *
 * 真实链条（crucible-compiled.mjs，本次亲读）：
 *  ① 基类 `StandardCheck#prepareDiceResultContext`（:2202）
 *     :2205  const defenseType = _loc("DICE.DC");            // 字面量 "DC"
 *     :2208  if ( targetLabel === undefined ) {
 *     :2209    const skill = SYSTEM.SKILLS[this.data.type];  // 攻击骰的 type 不是技能 → undefined
 *     :2210    const label = skill?.label ?? defenseType;    // → "DC"
 *     :2211    const dcLabel = game.user.isGM ? String(dc) : "";
 *     :2212    targetLabel = dcLabel ? `${label} ${dcLabel}` : label;
 *     → **非 GM 拿到的是 "DC"，不是空值**。这正是原补丁判据失效的原因。
 *  ② `AttackRoll#_prepareChatRenderContext`（:3311）在 super 之后覆盖
 *     :3325  cardData.defenseType = defense.shortLabel ?? defense.label;   // 真实防御名
 *     :3328  if ( game.user.isGM ) cardData.targetLabel = `${defenseType} ${dc}`;
 *     → 只有 GM 被改写；非 GM 保留基类那个 "DC"。
 */
class AttackRollStub {
  async _prepareChatRenderContext() {
    const dc = 12;
    // ① 基类：给**所有人**都赋上 targetLabel
    const dcLabel = game.user.isGM ? String(dc) : "";
    const baseLabel = "DC";                       // SKILLS[type] 查不到 → 回落 _loc("DICE.DC")
    const cardData = {
      dc,
      defenseType: "DC",                          // 基类给的是字面量，不是真实防御
      targetLabel: dcLabel ? `${baseLabel} ${dcLabel}` : baseLabel
    };
    // ② AttackRoll 覆盖：真实防御名人人可见，但 targetLabel 只给 GM 改写
    cardData.defenseType = "反射";
    if ( game.user.isGM ) cardData.targetLabel = `${cardData.defenseType} ${dc}`;
    // 测试用：模拟「上游哪天自己把防御名给了玩家」，此时本补丁必须放手
    else if ( this.__upstreamFixed ) cardData.targetLabel = "反射（上游自己给的）";
    // 测试用：模拟「上游改了 GM 那份的格式、不再含防御名」——
    // 此时 includes 判据挡不住，只剩 !isGM 拦着。补丁仍然不许碰 GM 的那份。
    if ( game.user.isGM && this.__gmLabelNoType ) cardData.targetLabel = "目标 12";
    return cardData;
  }
}

/** 自定义元素桩件：复刻 `_buildElements` 里那句致命的 removeAttribute（:7527） */
class CurrencyElement {
  constructor() { this.__attrs = {}; this.__listeners = {}; }
  getAttribute(k) { return k in this.__attrs ? this.__attrs[k] : null; }
  setAttribute(k, v) { this.__attrs[k] = String(v); }
  removeAttribute(k) { delete this.__attrs[k]; }
  addEventListener(type, fn) { (this.__listeners[type] ??= []).push(fn); }
  dispatchEvent(ev) { for (const fn of this.__listeners[ev.type] ?? []) fn(ev); }
  _buildElements() {
    this._value = Number(this.getAttribute("value") || 0);
    this.removeAttribute("value");
  }
}

globalThis.CONFIG = {
  Actor: { documentClass: CrucibleActor },
  ActiveEffect: { documentClass: CrucibleActiveEffect },
  Item: { dataModels: { weapon: CrucibleWeaponModel, armor: CrucibleArmorModel } }
};
/**
 * crucible 的符文 Spellcraft 词缀钩子（编译产物 :13668-13675）。
 * 复刻上游那个 bug：`this` 是 **CrucibleActor 文档**（callActorHooks :36578 `fn.call(this, item, ...)`），
 * 而文档上**没有** `training` getter（全 23 个 getter 里没这一项），于是 `this.training[runeId]` 抛 TypeError。
 * `prepareGrimoire` 的 hook 配置没有 `throws`（:1168），所以异常被 catch 成 console.error ——
 * 结果是 runeIds 推进去了、训练阶位没设上：**拿到符文但按未受训 −4 算**。
 */
const HOOKS_AFFIX = {};
for (const runeId of ["storm", "flame", "death"]) {
  HOOKS_AFFIX[`${runeId}Spellcraft`] = {
    prepareGrimoire(item, grimoire) {
      grimoire.runeIds.push(runeId);
      this.training[runeId] = Math.max(this.training[runeId] ?? 0, 1);   // ← 上游的 bug
    }
  };
}
/**
 * crucible 的 swallow 钩子（编译产物 :10530 常量、:10538-10539 写入端）。
 * 真实的 HOOKS.swallow 是可写的普通对象（:14044 只冻命名空间），所以这里**不能** freeze。
 */
HOOKS_ACTION.swallow = {
  _SWALLOWED_EFFECT_ID: "swallowed00000000",                                  // :10530，17 字符
  prepare() {
    const s = this.effects.find(e => e.scope === TARGET_SCOPES.ENEMIES);       // :10538
    if (s) s._id = HOOKS_ACTION.swallow._SWALLOWED_EFFECT_ID;                  // :10539
  }
};

// 对照组一：id 不以 Spellcraft 结尾
HOOKS_AFFIX.returning = { prepareGrimoire(item, grimoire) { grimoire.touched = true; } };
// 对照组二：**id 同样以 Spellcraft 结尾**，但它是姿态词缀、不碰 training。
// 真实数据里 40 个 Spellcraft 词缀只有 12 个是符文，其余 28 个（姿态/变形/施法方式）长这样 ——
// 只靠 id 形状判据会把它们一并顶掉，所以源码特征串那道判据是必需的。
HOOKS_AFFIX.arrowSpellcraft = {
  prepareGrimoire(item, grimoire) { (grimoire.gestureIds ??= []).push("arrow"); }
};

globalThis.crucible = {
  api: {
    models: { CrucibleAction },
    dice: { AttackRoll: AttackRollStub },
    applications: {
      elements: { HTMLCrucibleCurrencyElement: CurrencyElement },
      CrucibleBaseActorSheet: CrucibleBaseActorSheetStub
    },
    // 外层 freeze、子表可写 —— ember 正是靠这一点注册进来的（:14044 / ember.mjs:126744）
    hooks: Object.freeze({
      action: HOOKS_ACTION,
      affix: HOOKS_AFFIX,
      talent: {
        // ember.mjs:126089 / :126067 —— 源码里那两个坏查询串就是 E2 闸门的判据
        emberWirrunLinea: { prepareAttack() { return this.effects.get("implacableHunter"); } },
        emberVrjnharLine: { finalizeAction() { return this.effects.get("formidableStamin"); } },
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

console.log("\nP1 副手攻击");
{
  const mh = { id: "w1", name: "剑", system: { slot: SLOTS.MAINHAND }, toObject: () => ({ system: { slot: SLOTS.EITHER } }) };
  const oh = { id: "w2", name: "匕首", system: { slot: SLOTS.OFFHAND } };
  const actor = new CrucibleActor("A", [mh, oh], { mainhand: mh, offhand: oh });
  actor.itemList = { get: id => [mh, oh].find(i => i.id === id) ?? null, [Symbol.iterator]: function* () { yield mh; yield oh; } };

  actor.lastConfirmedAction = { events: [{ type: "strike", weapon: { _id: "w1", system: { slot: SLOTS.EITHER } } }] };
  const a = new CrucibleAction({ id: "offhandStrike", name: "副手攻击" }, { actor });
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

console.log("\nP2 猝然撕咬范围");
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

console.log("\nN1 湮解印记的效果 ID");
{
  const actor = new CrucibleActor("N1");
  const victim = new CrucibleActor("Victim");
  const prior = new CrucibleActor("Prior");
  prior.effects = new Map([["abyssMarkUnmak0", {}]]);
  prior.effects.has = prior.effects.has.bind(prior.effects);
  actor.flags.ember.abyssMarkTarget = prior.uuid;

  const a = new CrucibleAction({ id: "abyssMarkUnmaking", effects: [{ name: "湮解印记" }] }, { actor });
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

console.log("\nN3 斥退踢击的踉跄时长");
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

console.log("\nN4 余烬之火花的作用域");
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

console.log("\nN5 惑乱凝视的防御标签");
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

console.log("\nN7 暗焰光束的 composed 标签");
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

console.log("\nP3 / N9 符文戏法与训练阶位");
{
  const talent = (id, rune, training = { type: "", rank: null }, actions = []) =>
    ({ id, type: "talent", name: id, system: { rune, training, actions } });

  /**
   * ⚠ 真实的 ember 血统**自带自己的招牌动作**（实测 emberZephLineage 有
   *   inscrutableVisage / menacingVisage / beguilingVisage 三条）。
   *   桩件原先写成 actions: []，把它误建模成了「空的陈旧快照」——
   *   而 0.7.4 起这两种情况走**不同开关**，判据正是「自己有没有动作」。
   *   桩件不照实写，就测不出这个区分。
   */
  const zeph = talent("emberZephLineage", "storm", { type: "storm", rank: 1 },
    [{ id: "inscrutableVisage" }, { id: "menacingVisage" }, { id: "beguilingVisage" }]);
  const actor = new CrucibleActor("D", [zeph]);
  actor.prepareData();
  check("注入了 energize", !!actor.system.actions.energize, Object.keys(actor.system.actions).join(","));
  check("带上了合集里的中文名", actor.system.actions.energize?.name === "聚能 Energize");
  check("T2：不传 parent（否则配置卡一改就报错）", !actor.system.actions.energize.parent);
  check("T2：item 关联仍在", actor.system.actions.energize.item === zeph);

  const before = Object.keys(actor.system.actions).length;
  actor.prepareData();
  check("重复准备不会重复注入", Object.keys(actor.system.actions).length === before);

  // N9：按 rune 查表，所以小写 id 的旧快照同样命中，并补上训练阶位
  const stale = talent("runeflame0000000", "flame");
  const summon = new CrucibleActor("Summon", [stale]);
  summon.prepareData();
  check("旧快照（小写 id）也被命中 → enkindle", !!summon.system.actions.enkindle);
  check("补上了训练阶位 flame = 1", summon.system.training.flame === 1, JSON.stringify(summon.system.training));

  const frost = new CrucibleActor("Frost", [talent("runefrost0000000", "frost")]);
  frost.prepareData();
  check("新增的 frost → condense", !!frost.system.actions.condense);

  const trained = new CrucibleActor("Trained", [talent("x", "illumination", { type: "illumination", rank: 2 })]);
  trained.system.training.illumination = 2;
  trained.prepareData();
  check("上游已填训练阶位 → 整条跳过", trained.system.training.illumination === 2);

  // 旧快照（training.type 为空，会走到赋值那一行）但角色已从别处拿到更高阶位 —— 不能被压回 1
  const higher = new CrucibleActor("Higher", [talent("runeStorm0000000", "storm")]);
  higher.system.training.storm = 3;
  higher.prepareData();
  check("旧快照 + 已有更高阶位 → 取 max 不降级", higher.system.training.storm === 3, String(higher.system.training.storm));

  const own = new CrucibleActor("Own", [talent("runeStorm0000000", "storm", { type: "storm", rank: 1 }, [{ id: "energize" }])]);
  own.prepareData();
  check("条目自己就带该动作 → 不重复注入", !own.system.actions.energize);

  /**
   * P3 与 P3′ 是**性质不同的两件事**，0.7.4 拆成两个开关：
   *  P3  陈旧快照（`crucible.summons` 里 `Rune: X` 的 actions 是空数组，
   *      而 `crucible.talent` 里同名正版有）—— 同一条目两份数据自相矛盾，**可证的缺陷**
   *  P3′ 别的天赋顺带给了符文（ember 四血统）—— crucible 全文 `cantrip` 零命中、
   *      `RUNES` 配置也没有戏法字段，系统从未承诺「有符文就有戏法」，**是内容判断**
   * 判据：这个天赋自己有没有动作。没有 = 坏掉的快照；有 = 另一种东西。
   */
  {
    const mkActor = (id, actions) => {
      const a = new CrucibleActor("split", [talent(id, "storm", { type: "storm", rank: 1 }, actions)]);
      a.prepareData();
      return a;
    };
    const K_SNAP = "ember-crucible-tempfix.patchRuneCantrips";
    const K_LINE = "ember-crucible-tempfix.patchLineageCantrips";

    // 只关「血统」那条：快照仍然补，血统不补
    setSetting(K_LINE, false);
    check("关掉 P3′ → 陈旧快照仍然补戏法",
      !!mkActor("runeStorm0000000", []).system.actions.energize);
    check("关掉 P3′ → 自带动作的天赋不再补戏法",
      !mkActor("emberZephLineage", [{ id: "inscrutableVisage" }]).system.actions.energize);
    setSetting(K_LINE, true);

    // 只关「快照」那条：反过来
    setSetting(K_SNAP, false);
    check("关掉 P3 → 陈旧快照不再补戏法",
      !mkActor("runeStorm0000000", []).system.actions.energize);
    check("关掉 P3 → 自带动作的天赋仍然补戏法",
      !!mkActor("emberZephLineage", [{ id: "inscrutableVisage" }]).system.actions.energize);
    setSetting(K_SNAP, true);

    // 两条都关 → 一个都不补
    setSetting(K_SNAP, false); setSetting(K_LINE, false);
    check("两条都关 → 快照不补", !mkActor("runeStorm0000000", []).system.actions.energize);
    check("两条都关 → 血统不补",
      !mkActor("emberZephLineage", [{ id: "inscrutableVisage" }]).system.actions.energize);
    setSetting(K_SNAP, true); setSetting(K_LINE, true);
  }

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

console.log("\nN12：物品自带效果的 turns 时长（N10 的 preActivate 够不着的那一半）");
{
  const AE = CONFIG.ActiveEffect.documentClass;
  const mk = duration => new AE(duration);

  // 上游 :39581 的拦截还在时：单位被改掉，效果因此**建得出来**（不再返回 false）
  const e1 = mk({ value: 6, units: "turns", expiry: null });
  const r1 = await e1._preCreate({}, {}, {});
  check("N12 单位改成 rounds", e1.duration.units === "rounds", e1.duration.units);
  check("N12 数值不动", e1.duration.value === 6, String(e1.duration.value));
  check("N12 expiry 按上游迁移映射补成 turnEnd", e1.duration.expiry === "turnEnd", String(e1.duration.expiry));
  check("N12 效果不再被拒绝创建", r1 !== false, String(r1));

  // 已经有 expiry 的不许覆盖（`??=` 的语义）
  const e2 = mk({ value: 3, units: "turns", expiry: "turnStart" });
  await e2._preCreate({}, {}, {});
  check("N12 已有 expiry → 不覆盖", e2.duration.expiry === "turnStart", String(e2.duration.expiry));

  // 不相干的单位一律不碰
  const e3 = mk({ value: 2, units: "rounds", expiry: "turnStart" });
  await e3._preCreate({}, {}, {});
  check("N12 rounds 不碰", e3.duration.units === "rounds" && e3.duration.expiry === "turnStart");

  // months 仍然该被上游拒绝——我们只放行 turns，不顺手把另一个也放了
  const e4 = mk({ value: 1, units: "months", expiry: null });
  check("N12 不顺手放行 months", (await e4._preCreate({}, {}, {})) === false);

  // 反向：关掉开关 → 回到上游原行为（照样被拒）
  setSetting("ember-crucible-tempfix.patchTurnsDuration", false);
  const e5 = mk({ value: 6, units: "turns", expiry: null });
  check("N12 关掉开关 → 回到上游原行为（仍被拒绝）", (await e5._preCreate({}, {}, {})) === false);
  check("N12 关掉开关 → 也不改数据", e5.duration.units === "turns", e5.duration.units);
  setSetting("ember-crucible-tempfix.patchTurnsDuration", true);

  // guard：上游一旦放宽限制，这条必须退让。这里验证的是 installPrototypePatches 的判据，
  // 不是包装体的运行时分支——所以要在一个**未包装**的类上重新走一遍安装。
  class RelaxedAE {
    async _preCreate() { return undefined; }          // 源码里不再有那串特征
  }
  const realDoc = CONFIG.ActiveEffect.documentClass;
  CONFIG.ActiveEffect.documentClass = RelaxedAE;
  globalThis.emberCrucibleTempFix.installPrototypePatches();
  check("N12 上游放宽后不再包装", !RelaxedAE.prototype._preCreate.__tempfixPatched);
  CONFIG.ActiveEffect.documentClass = realDoc;
}

console.log("\nI7：投掷武器的下拉框只列扔得出去的武器（上游 issue #1288）");
{
  const wp = (id, name, canThrow, ranged = false) =>
    ({ id, name, system: { canThrow }, config: { category: { ranged } } });
  const mk = (weapons, tags = ["thrown", "melee"]) => {
    const a = new CrucibleAction({ id: "throwWeapon", tags }, {});
    a.__weapons = weapons;
    return a;
  };

  // 复现上游缺陷本身：不打补丁时徒手也在可选列表里。
  // I7 现在包的就是 _prepareWeaponChoices 本身，所以要拿**原实现**来演示出厂形态。
  const bare = mk([wp("dagger", "匕首", true), wp("fist", "徒手", false)]);
  const rawChoices = CrucibleAction.prototype._prepareWeaponChoices.__tempfixOriginal;
  check("I7 补丁确实包在 _prepareWeaponChoices 上（而不是更晚的某处）",
    rawChoices instanceof Function);
  bare.usage.weaponChoices = rawChoices.call(bare);
  check("上游出厂时每一条都是 viable（缺陷本身）",
    bare.usage.weaponChoices.every(c => c.viable));

  const a = mk([wp("dagger", "匕首", true), wp("fist", "徒手", false), wp("claw", "利爪", false)]);
  a.prepare();
  const ids = a.getValidWeaponChoices().map(c => c.id);
  check("I7 扔不出去的被标成不可选", ids.join(",") === "dagger", ids.join(","));
  check("I7 不可选的仍留在完整列表里（只是 viable=false，不是删掉）",
    a.usage.weaponChoices.length === 3, String(a.usage.weaponChoices.length));

  // 幂等：再准备一次结果不变
  a.prepare();
  check("I7 幂等", a.getValidWeaponChoices().map(c => c.id).join(",") === "dagger");

  // 第二个症状：卡在非法选择上的动作应当自动脱困
  const stuck = mk([wp("dagger", "匕首", true), wp("fist", "徒手", false)]);
  stuck.usage.weaponChoice = "fist";                 // 玩家上次选中了扔不出去的那个
  stuck.prepare();
  check("I7 卡住的非法选择会自动落回能扔的那把", stuck.usage.weapon?.id === "dagger",
    String(stuck.usage.weapon?.id));
  check("I7 脱困后 canUse 不再抛错", (() => { try { stuck.canUse(); return true; } catch { return false; } })());

  // 反向 ①：没有 thrown 标签的动作一概不碰
  const nt = mk([wp("dagger", "匕首", true), wp("fist", "徒手", false)], ["melee"]);
  nt.prepare();
  check("I7 只管带 thrown 标签的动作", nt.getValidWeaponChoices().length === 2,
    String(nt.getValidWeaponChoices().length));

  // 反向 ②：canThrow 读不到（上游改了结构）时不猜——只有显式 false 才标不可选
  const unknown = mk([{ id: "x", name: "结构变了", system: {}, config: { category: { ranged: false } } }]);
  unknown.prepare();
  check("I7 canThrow 读不到时不猜（保守放行）", unknown.getValidWeaponChoices().length === 1);

  // 反向 ③：关掉开关 → 回到上游原行为
  setSetting("ember-crucible-tempfix.patchThrowableOnly", false);
  const off = mk([wp("dagger", "匕首", true), wp("fist", "徒手", false)]);
  off.prepare();
  check("I7 关掉开关 → 回到上游原行为（徒手又出现了）",
    off.getValidWeaponChoices().length === 2, String(off.getValidWeaponChoices().length));
  setSetting("ember-crucible-tempfix.patchThrowableOnly", true);

  // 反向 ④：不能顶掉 melee 标签自己的过滤（两条要能叠加）
  const both = mk([wp("dagger", "匕首", true), wp("bow", "弓", true, true)]);
  both.prepare();
  check("I7 与 melee 的过滤叠加而不是互相覆盖",
    both.getValidWeaponChoices().map(c => c.id).join(",") === "dagger",
    both.getValidWeaponChoices().map(c => c.id).join(","));
}

console.log("\nN11 符文 Spellcraft 词缀的训练阶位");
{
  // 复刻真实调用：this 绑定 actor **文档**（文档上没有 training getter）
  const actor = new CrucibleActor("N11");
  const call = (id, grimoire) => HOOKS_AFFIX[id].prepareGrimoire.call(actor, { name: "词缀" }, grimoire);

  const g = { runeIds: [] };
  check("补丁装上后不再抛 TypeError", throws(() => call("stormSpellcraft", g)) === null);
  check("符文仍然被授予", g.runeIds.includes("storm"));
  check("训练阶位这次真的设上了", actor.system.training.storm === 1, JSON.stringify(actor.system.training));

  const g2 = { runeIds: [] };
  call("flameSpellcraft", g2);
  call("deathSpellcraft", g2);
  check("12 个符文词缀是同一族，全部被覆盖", actor.system.training.flame === 1 && actor.system.training.death === 1);

  // 反向：已有更高阶位不降级
  actor.system.training.storm = 3;
  call("stormSpellcraft", { runeIds: [] });
  check("已有更高阶位 → 取 max 不降级", actor.system.training.storm === 3, String(actor.system.training.storm));

  // 反向：不碰 training 的词缀钩子不被替换
  check("不碰 training 的词缀钩子原样保留", !HOOKS_AFFIX.returning.prepareGrimoire.__tempfixOverride);
  const g3 = {};
  HOOKS_AFFIX.returning.prepareGrimoire.call(actor, {}, g3);
  check("对照组照常工作", g3.touched === true);

  // 反向（关键）：**同样以 Spellcraft 结尾**的姿态词缀绝不能被顶掉 ——
  // 真实数据里 40 个 Spellcraft 词缀只有 12 个是符文，只靠 id 形状判据会误伤另外 28 个
  check("姿态类 Spellcraft 词缀没被替换", !HOOKS_AFFIX.arrowSpellcraft.prepareGrimoire.__tempfixOverride);
  const g4 = { runeIds: [] };
  HOOKS_AFFIX.arrowSpellcraft.prepareGrimoire.call(actor, {}, g4);
  check("姿态词缀仍然授予姿态而不是符文", g4.gestureIds?.includes("arrow") && !g4.runeIds.length,
    JSON.stringify(g4));

  // 反向：重复安装是安全的
  const before = HOOKS_AFFIX.stormSpellcraft.prepareGrimoire;
  globalThis.emberCrucibleTempFix.installAffixTrainingFix();
  check("重复安装不会二次包装", HOOKS_AFFIX.stormSpellcraft.prepareGrimoire === before);
}

console.log("\nC 系列：crucible 自身的缺陷");
{
  const actor = new CrucibleActor("C");

  // C4 翻滚：scope ALLIES → ENEMIES，且**不能**顶掉 crucible 自己的 tumble.prepare
  const tumble = new CrucibleAction({ id: "tumble", target: { type: "single", scope: TARGET_SCOPES.ALLIES } }, { actor });
  tumble.prepare();
  check("C4 ALLIES → ENEMIES", tumble.target.scope === TARGET_SCOPES.ENEMIES, String(tumble.target.scope));
  check("C4 用的是 initialize，没顶掉上游的 tumble.prepare",
    ACTIONS().tumble.prepare === undefined && typeof ACTIONS().tumble.initialize === "function");
  const tumbleFixed = new CrucibleAction({ id: "tumble", target: { type: "single", scope: TARGET_SCOPES.ENEMIES } }, { actor });
  tumbleFixed.prepare();
  check("C4 上游改好后不再插手（幂等）", tumbleFixed.target.scope === TARGET_SCOPES.ENEMIES);

  // C5 曙光信标：pulse + SELF → ENEMIES
  const beacon = new CrucibleAction({ id: "dawnBeacon", target: { type: "pulse", scope: TARGET_SCOPES.SELF, size: 60 } }, { actor });
  beacon.prepare();
  check("C5 pulse+SELF → ENEMIES", beacon.target.scope === TARGET_SCOPES.ENEMIES, String(beacon.target.scope));
  const notPulse = new CrucibleAction({ id: "dawnBeacon", target: { type: "single", scope: TARGET_SCOPES.SELF } }, { actor });
  notPulse.prepare();
  check("C5 归属判据：不是 pulse 就不动", notPulse.target.scope === TARGET_SCOPES.SELF);

  // X1 补掷骰实现
  const pust = new CrucibleAction({ id: "repugnantPustules", target: { type: "pulse", size: 3 }, tags: ["reaction", "weakened", "reflex"] }, { actor });
  pust.prepare();
  check("X1 补上了 generic", pust.tags.has("generic"));
  check("X1 原有标签一个不少", pust.tags.has("reflex") && pust.tags.has("weakened") && pust.tags.has("reaction"));
  const remains = new CrucibleAction({ id: "abyssalRemains", target: { type: "pulse", size: 4 }, tags: ["weakened", "reflex"] }, { actor });
  remains.prepare();
  check("X1 两条动作共用同一份补丁体", remains.tags.has("generic"));
  const already = new CrucibleAction({ id: "abyssalRemains", target: { type: "pulse" }, tags: ["spell", "reflex"] }, { actor });
  const n0 = already.tags.size;
  already.prepare();
  check("X1 上游已有别的 roll 提供者（spell）→ 不再加 generic", (already.tags.size === n0) && !already.tags.has("generic"));

  // C1 吞下的效果 ID（常量改写，可逆）
  const sw = crucible.api.hooks.action.swallow;
  check("C1 常量已换成合法的 16 字符", /^[a-zA-Z0-9]{16}$/.test(sw._SWALLOWED_EFFECT_ID), sw._SWALLOWED_EFFECT_ID);
  // ⚠ 关掉开关**故意不还原**成坏值：还原会让本次会话里已经被吞下去的目标再也放不出来
  //   （「反吐」按坏 id 查、查不到 → token 保持 hidden）。而坏值本来就是非法的，
  //   留着合法 id 不造成任何伤害。要回到上游原样就停用模块并刷新。
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", false);
  check("C1 关掉开关不还原坏值（否则已吞的目标会被锁死）", sw._SWALLOWED_EFFECT_ID === "swallowed0000000", sw._SWALLOWED_EFFECT_ID);
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", true);
  check("C1 再打开仍是合法 id", sw._SWALLOWED_EFFECT_ID.length === 16);

  // ⚠ 顺序要紧：警告是按 key 去重的（warnedGuards），所以「不该报警」这条必须排在
  //   「未知非法值会报警」**之前**，否则被去重吃掉、断言永远打不响（变异测试抓出来的）。
  const warnsBefore = warnCount;
  sw._SWALLOWED_EFFECT_ID = "swallowed0000000";                                    // 上游修成了和我们一样的 16 位值
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", false);
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", true);
  check("C1 上游修好后不再改写", sw._SWALLOWED_EFFECT_ID === "swallowed0000000");
  check("C1 上游修好后不该报警（长度判据的意义）", warnCount === warnsBefore, warnCount + " vs " + warnsBefore);

  const warnsBefore2 = warnCount;
  sw._SWALLOWED_EFFECT_ID = "gulped000000000000";                                  // 未知非法值（18）
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", false);
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", true);
  check("C1 遇到未知非法值 → 退让不猜", sw._SWALLOWED_EFFECT_ID === "gulped000000000000");
  check("C1 未知非法值会报警一次", warnCount > warnsBefore2);
  sw._SWALLOWED_EFFECT_ID = "swallowed00000000";
  setSetting("ember-crucible-tempfix.patchSwallowEffectId", true);
}

console.log("\nI 系列：上游还没修的开放 issue");
{
  const actor = new CrucibleActor("I");

  // I1 #1403：strikes 为空数组时 every() 真空通过 → 动作可用但什么都不做，还退还动作点
  const empty = new CrucibleAction({ id: "wildStrike", tags: ["natural"] }, { actor });
  empty.usage.strikes = [];
  check("I1 没有天生武器 → 拦住", throws(() => empty.canUse()) !== null);

  const armed = new CrucibleAction({ id: "wildStrike", tags: ["natural"] }, { actor });
  armed.usage.strikes = [{ name: "利爪" }];
  check("I1 有天生武器 → 放行", throws(() => armed.canUse()) === null);

  const notNatural = new CrucibleAction({ id: "wildStrike", tags: ["melee"] }, { actor });
  notNatural.usage.strikes = [];
  check("I1 归属判据：没有 natural 标签就不插手", throws(() => notNatural.canUse()) === null);

  // I2 #1412：hasKnowledge 只读 background 那一份
  const hero = new CrucibleActor("I2hero");
  hero.type = "hero";
  hero.system.details = {
    background: { knowledge: new Set(["beasts"]) },       // 背景给的
    knowledge: new Set(["beasts", "undead"])              // 聚合值（含 GM 手工加的 undead）
  };
  check("I2 背景给的知识仍然认", hero.hasKnowledge("beasts") === true);
  check("I2 手工添加的知识现在也认了", hero.hasKnowledge("undead") === true);
  check("I2 没有的知识仍然是 false", hero.hasKnowledge("dragons") === false);

  const npc = new CrucibleActor("I2npc");
  npc.type = "adversary";
  npc.system.details = { knowledge: new Set(["beasts"]) };
  check("I2 非 hero 仍然返回 false（与上游一致）", npc.hasKnowledge("beasts") === false);

  const noAgg = new CrucibleActor("I2old");
  noAgg.type = "hero";
  noAgg.system.details = { background: { knowledge: new Set(["fey"]) } };   // 没有聚合值
  check("I2 读不到聚合值 → 退回上游行为", noAgg.hasKnowledge("fey") === true);

  // I3 #1406：私人传记无条件渲染给所有能打开卡的人
  const sheetCls = crucible.api.applications.CrucibleBaseActorSheet;
  const asOwner = new sheetCls({ isOwner: true });
  const asViewer = new sheetCls({ isOwner: false });
  const [own, view] = await Promise.all([asOwner._prepareContext(), asViewer._prepareContext()]);
  check("I3 拥有者仍然看得到私记", own.biography.privateHTML === "<p>GM 私记</p>");
  check("I3 非拥有者看不到私记原文", !("privateHTML" in view.biography) && !("privateSrc" in view.biography));
  check("I3 privateField 是删掉而不是置 null（否则模板刷红字）", !("privateField" in view.biography));
  check("I3 公开传记不受影响", view.biography.publicHTML === "<p>公开</p>");
}

console.log("\n显示层：I5 防御类型 / I6 夹击叠层 / B5 当前装备");
{
  /**
   * I5 #1402：defenseType 人人都算了，但 targetLabel 只有 GM 那份带防御名。
   * ⚠ 非 GM 的 targetLabel **不是空的**，是占位符 "DC"（基类 :2212 赋的）——
   *   补丁曾按「空才补」写判据，于是整条从未执行过。这里先钉死这个前提。
   */
  const roll = new AttackRollStub();
  game.user.isGM = false;
  setSetting("ember-crucible-tempfix.patchDefenseTypeLabel", false);
  const upstream = await roll._prepareChatRenderContext();
  check("I5 前提：上游给非 GM 的是占位符「DC」而非空值",
    upstream.targetLabel === "DC", String(upstream.targetLabel));
  setSetting("ember-crucible-tempfix.patchDefenseTypeLabel", true);

  let card = await roll._prepareChatRenderContext();
  check("I5 玩家端补上了防御类型", card.targetLabel === "反射", card.targetLabel);
  check("I5 但不泄漏 DC 数字", !String(card.targetLabel).includes("12"));
  check("I5 玩家端不再是占位符「DC」", card.targetLabel !== "DC");

  game.user.isGM = true;
  card = await roll._prepareChatRenderContext();
  check("I5 GM 端仍带 DC（上游原样）", card.targetLabel === "反射 12", card.targetLabel);
  game.user.isGM = false;

  setSetting("ember-crucible-tempfix.patchDefenseTypeLabel", false);
  card = await roll._prepareChatRenderContext();
  check("I5 关掉开关 → 回到上游原行为（玩家端仍是「DC」）",
    card.targetLabel === "DC", String(card.targetLabel));
  setSetting("ember-crucible-tempfix.patchDefenseTypeLabel", true);

  // 上游哪天自己把防御名带给玩家了 → 本补丁必须空转，不许再插一手。
  // 真跑一遍包装后的方法，不要只验判据表达式（那是同义反复）。
  roll.__upstreamFixed = true;                 // 让桩件模拟「上游已修好」
  card = await roll._prepareChatRenderContext();
  check("I5 上游已带防御名 → 原样放行，不重复改写",
    card.targetLabel === "反射（上游自己给的）", String(card.targetLabel));
  delete roll.__upstreamFixed;

  // GM 那份永远不许碰。当前上游格式下 includes 判据恰好也挡得住，
  // 但那是巧合——上游一改 GM 的格式就只剩 !isGM 拦着了。这里把意图钉死。
  game.user.isGM = true;
  roll.__gmLabelNoType = true;
  card = await roll._prepareChatRenderContext();
  check("I5 GM 那份即使不含防御名也不许改写",
    card.targetLabel === "目标 12", String(card.targetLabel));
  delete roll.__gmLabelNoType;
  game.user.isGM = false;

  // I6 #1311：关闭时上游只清 controlled，换选后旧图形成孤儿
  const cleared = [];
  const mk = n => ({ name: n, _clearEngagementVisualization() { cleared.push(n); }, _visualizeEngagement() {} });
  const t1 = mk("选中的"), t2 = mk("换选前的孤儿");
  globalThis.canvas.tokens.controlled = [t1];
  globalThis.canvas.tokens.placeables = [t1, t2];
  const controls = { tokens: { tools: { debugFlanking: {
    onChange(_e, active) {
      globalThis.CONFIG.debug = { flanking: active };
      for ( const token of globalThis.canvas.tokens.controlled ) {
        if ( active ) token._visualizeEngagement(); else token._clearEngagementVisualization();
      }
    }
  } } } };
  for ( const fn of hookRegistry.getSceneControlButtons ?? [] ) fn(controls);
  controls.tokens.tools.debugFlanking.onChange({}, false);
  check("I6 关闭时连孤儿一起清掉", cleared.includes("换选前的孤儿"), cleared.join(","));
  check("I6 选中的那个也照常清", cleared.includes("选中的"));

  // B5 ac1b5cfc：上游的循环上界每 push 一件就缩一格
  const claws = i => ({ name: "爪" + i, type: "weapon", uuid: "u" + i, img: "", getTags: () => ({ damage: "d", range: "r" }) });
  const sheet = new (crucible.api.applications.CrucibleBaseActorSheet)({
    isOwner: true,
    equipment: { weapons: { natural: [claws(1), claws(2), claws(3)] } }
  });
  const ctx = await sheet._prepareContext();
  const nat = ctx.featuredEquipment.filter(e => e.type === "weapon");
  check("B5 补齐到 3 件天生武器", nat.length === 3, String(nat.length));
  check("B5 不重复已列出的", new Set(ctx.featuredEquipment.map(e => e.uuid)).size === ctx.featuredEquipment.length);

  // ⚠ 关键场景：护甲追加在末尾且占一格——拿 fe.length 比 3 会让所有有护甲的角色 100% 空转
  const withArmor = new (crucible.api.applications.CrucibleBaseActorSheet)({
    isOwner: true,
    equipment: { armor: { name: "锁子甲", uuid: "armor1" }, weapons: { natural: [claws(1), claws(2), claws(3)] } }
  });
  const ctx2 = await withArmor._prepareContext();
  const nat2 = ctx2.featuredEquipment.filter(e => e.type === "weapon");
  check("B5 有护甲行时同样补齐（护甲不占武器预算）", nat2.length === 3, String(nat2.length));
  check("B5 护甲仍在最后一格", ctx2.featuredEquipment.at(-1).type === "armor", ctx2.featuredEquipment.at(-1)?.type);
}

console.log("\n实测回归：强健体力（弗尔金哈尔血统 Vrjnhar Lineage）—— 用户在真实牌桌上报的第一条");
{
  // 用户报告：「强健体力用了以后不加效果」。取证结论 = N10。
  // 本机两份数据的真实形态（两份都要过）：
  //   ember.crucible-character   → duration: {turns: 6}                              （旧形态，加载时迁移）
  //   ember.crucible-adventure   → duration: {value: 6, units: "turns", expiry: null}（已迁移形态）
  // 消耗是 {action: 0, focus: 1, heroism: 1} —— 花掉 1 专注 + 1 点英雄气概，什么都拿不到。
  const actor = new CrucibleActor("Svala");

  for ( const [label, duration] of [
    ["合集里的旧形态 {turns:6}", { turns: 6 }],
    ["冒险包里的已迁移形态", { value: 6, units: "turns", expiry: null, expired: false }]
  ] ) {
    const a = new CrucibleAction({
      id: "formidableStamina", tags: [],
      effects: [{ name: "Formidable Stamina", scope: TARGET_SCOPES.SELF, statuses: [], duration, system: { changes: [] } }]
    }, { actor });
    a.preActivate();
    const d = a.effects[0].duration;
    check(`强健体力（${label}）：效果这次真的会被创建`, preCreateWouldReject(a.effects[0]) === false, JSON.stringify(d));
    check(`强健体力（${label}）：时长仍是 6 轮`, d.value === 6 && d.units === "rounds", JSON.stringify(d));
    check(`强健体力（${label}）：效果 ID 对齐到 ember 要查的那个`, a.effects[0]._id === "formidableStamin", String(a.effects[0]._id));
  }
}

console.log("\nE2：效果 ID 与 ember 的查询串对不上");
{
  const actor = new CrucibleActor("E2");

  // 系统实际会生成 implacableHunte0（generateId(id,15)+"0"），而 ember 查 implacableHunter
  const hunt = new CrucibleAction({ id: "implacableHunter", effects: [{ name: "Implacable Hunter" }] }, { actor });
  hunt.preActivate();
  check("E2 写入端对齐到 ember 要找的 id", hunt.effects[0]._id === "implacableHunter", hunt.effects[0]._id);
  check("E2 对齐后的 id 仍是合法的 16 位", /^[a-zA-Z0-9]{16}$/.test(hunt.effects[0]._id));

  const stam = new CrucibleAction({ id: "formidableStamina", effects: [{ name: "Formidable Stamina" }] }, { actor });
  stam.preActivate();
  check("E2 第二条同样对齐", stam.effects[0]._id === "formidableStamin", stam.effects[0]._id);

  // 反向：上游自己设了 _id → 不插手
  const preset = new CrucibleAction({ id: "implacableHunter", effects: [{ _id: "somethingElse000" }] }, { actor });
  preset.preActivate();
  check("E2 上游已设 _id → 不插手", preset.effects[0]._id === "somethingElse000");

  // 反向（关键）：ember 把查询串改对了 → 我们必须退让，否则反而会把它的新查询打断
  const realHook = crucible.api.hooks.talent.emberWirrunLinea;
  crucible.api.hooks.talent.emberWirrunLinea = {
    prepareAttack() { const q = this.effects.get("implacableHunte0"); return q; }   // ember 改对了
  };
  const fixed = new CrucibleAction({ id: "implacableHunter", effects: [{ name: "x" }] }, { actor });
  fixed.preActivate();
  check("E2 ember 改对之后 → 不再强设 _id", fixed.effects[0]._id === undefined, String(fixed.effects[0]._id));
  crucible.api.hooks.talent.emberWirrunLinea = realHook;
}

console.log("\nI4 / E1：重复准备的加成叠加、抗性 change 少了 .bonus");
{
  const actor = new CrucibleActor("I4");

  // I4：empowered 是 `damageBonus += 6`（:4432），而 _configureUsage 只重置 cost
  const kick = new CrucibleAction({ id: "flyingKick", tags: ["empowered"], target: { type: "movement" } }, { actor });
  kick.prepare();
  check("I4 第一次准备 → +6", kick.usage.bonuses.damageBonus === 6, String(kick.usage.bonuses.damageBonus));
  kick.prepare();
  check("I4 位移规划后的第二次准备 → 仍是 +6（不叠加）", kick.usage.bonuses.damageBonus === 6, String(kick.usage.bonuses.damageBonus));
  kick.prepare();
  check("I4 路径非法重规划的第三次 → 仍是 +6", kick.usage.bonuses.damageBonus === 6, String(kick.usage.bonuses.damageBonus));
  check("I4 multiplier 恢复成 1 而不是 0", kick.usage.bonuses.multiplier === 1, String(kick.usage.bonuses.multiplier));

  setSetting("ember-crucible-tempfix.patchRepeatedPrepare", false);
  const kick2 = new CrucibleAction({ id: "flyingKick", tags: ["empowered"], target: { type: "movement" } }, { actor });
  kick2.prepare(); kick2.prepare();
  check("I4 关掉开关 → 回到上游原行为（叠加成 +12）", kick2.usage.bonuses.damageBonus === 12, String(kick2.usage.bonuses.damageBonus));
  setSetting("ember-crucible-tempfix.patchRepeatedPrepare", true);

  // E1：system.resistances.acid 是 SchemaField，change 少了 .bonus
  const eff = new CrucibleActiveEffect();
  eff.system = { changes: [
    { key: "system.resistances.acid", type: "add", value: 5 },
    { key: "system.resistances.corruption.bonus", type: "add", value: 3 },   // 本来就对
    { key: "system.resistances.notARealType", type: "add", value: 1 },       // 不认识 → 不碰
    { key: "system.defenses.armor.bonus", type: "add", value: 2 }            // 与抗性无关
  ] };
  eff.prepareBaseData();
  const keys = eff.system.changes.map(c => c.key);
  check("E1 补上了 .bonus", keys[0] === "system.resistances.acid.bonus", keys[0]);
  check("E1 本来就对的不动", keys[1] === "system.resistances.corruption.bonus");
  check("E1 不认识的伤害类型 → 不猜", keys[2] === "system.resistances.notARealType");
  check("E1 与抗性无关的不动", keys[3] === "system.defenses.armor.bonus");

  const eff2 = new CrucibleActiveEffect();
  eff2.system = { changes: [{ key: "system.resistances.acid.bonus", type: "add", value: 5 }] };
  eff2.prepareBaseData();
  check("E1 幂等：ember 修好后不再改", eff2.system.changes[0].key === "system.resistances.acid.bonus");
}

console.log("\nB4：掷骰对话框里换了技能却没生效");
{
  const actor = new CrucibleActor("B4");
  // 多技能团队检定：默认取第一项 acrobatics，玩家在对话框里换成 athletics
  const swapped = { data: { type: "athletics", messageMode: null }, async evaluate() { this.evaluated = true; }, async toMessage() {} };
  const orig = actor.getSkillCheck.bind(actor);
  actor.getSkillCheck = id => {
    const c = orig(id);
    c.__swapTo = swapped;                    // 对话框返回的是**另一份** roll
    return c;
  };
  const r = await actor.rollSkill(undefined, {
    dialog: { skills: { acrobatics: { dc: 12 }, athletics: { dc: 12 } } }
  });
  check("B4 采纳了对话框返回的那一份", r === swapped, r?.data?.type);
  check("B4 掷的是换过的技能", r.data.type === "athletics");
  check("B4 确实掷了", r.evaluated === true);

  // 反向：对话框取消 → 仍然返回 null
  actor.getSkillCheck = id => { const c = orig(id); c.__swapTo = null; c.dialog = async () => null; return c; };
  check("B4 取消对话框 → 返回 null", (await actor.rollSkill("acrobatics", { dialog: {} })) === null);

  // 反向：关掉开关 → 回到上游原行为（丢掉对话框返回值）
  setSetting("ember-crucible-tempfix.patchSkillDialogSwap", false);
  actor.getSkillCheck = id => { const c = orig(id); c.__swapTo = swapped; return c; };
  const r2 = await actor.rollSkill(undefined, { dialog: { skills: { acrobatics: { dc: 12 }, athletics: { dc: 12 } } } });
  check("B4 关掉开关 → 回到上游原行为（仍掷默认技能）", r2.data.type === "acrobatics", r2?.data?.type);
  setSetting("ember-crucible-tempfix.patchSkillDialogSwap", true);
}

console.log("\nB 系列：从上游开发版回搬");
{
  // B1 武器：0.10.1 在 prepareBaseData 里就把附魔加值算死，而词缀要到派生阶段才解析完
  const w = new CrucibleWeaponModel();
  w.__affixEnchantment = 3;          // 词缀推导出 +3，但 base 阶段还看不到
  w.prepareBaseData();
  check("B1 base 阶段拿到的是词缀生效前的值（复现上游 bug）", w.actionBonuses.enchantment === 0, String(w.actionBonuses.enchantment));
  w.prepareDerivedData();
  check("B1 派生阶段被修正成词缀生效后的真值", w.actionBonuses.enchantment === 3, String(w.actionBonuses.enchantment));
  w.prepareDerivedData();
  check("B1 幂等：再跑一次仍是 3", w.actionBonuses.enchantment === 3);

  // B2 护甲：base 里附魔值和 category 基数加在一起，只能按差额修正
  const a = new CrucibleArmorModel();
  a.__affixEnchantment = 2;
  a.prepareBaseData();
  check("B2 base 阶段 dodge.base = 基数 10 + 旧附魔 0", a.dodge.base === 10, String(a.dodge.base));
  a.prepareDerivedData();
  check("B2 派生阶段按差额补上 +2", a.dodge.base === 12, String(a.dodge.base));
  a.prepareDerivedData();
  check("B2 幂等：再跑一次仍是 12", a.dodge.base === 12, String(a.dodge.base));

  // 反向：没有词缀时（前后一致）不该动
  const a2 = new CrucibleArmorModel();
  a2.__affixEnchantment = 0;
  a2.prepareBaseData(); a2.prepareDerivedData();
  check("B2 无词缀 → 不动 dodge.base", a2.dodge.base === 10, String(a2.dodge.base));

  // 反向：关掉开关 → 回到上游原行为
  setSetting("ember-crucible-tempfix.patchEnchantmentBonus", false);
  const w2 = new CrucibleWeaponModel();
  w2.__affixEnchantment = 3;
  w2.prepareBaseData(); w2.prepareDerivedData();
  check("B1 关掉开关 → 回到上游原行为", w2.actionBonuses.enchantment === 0, String(w2.actionBonuses.enchantment));
  setSetting("ember-crucible-tempfix.patchEnchantmentBonus", true);

  // B3 货币元素：_buildElements 把 value 属性删掉，弹窗重连时读回 0
  const el = new CurrencyElement();
  el.setAttribute("value", "175");
  el._buildElements();
  check("B3 属性被写回（弹窗重连能读到）", el.getAttribute("value") === "175", String(el.getAttribute("value")));
  check("B3 _value 仍然正确", el._value === 175);

  el._value = 999;                      // 模拟 GM 改了货币
  el.dispatchEvent({ type: "change" });
  check("B3 改值后属性同步", el.getAttribute("value") === "999", String(el.getAttribute("value")));

  setSetting("ember-crucible-tempfix.patchCurrencyPopout", false);
  const el2 = new CurrencyElement();
  el2.setAttribute("value", "50");
  el2._buildElements();
  check("B3 关掉开关 → 回到上游原行为（属性被删）", el2.getAttribute("value") === null, String(el2.getAttribute("value")));
  setSetting("ember-crucible-tempfix.patchCurrencyPopout", true);
}

console.log("\nD 系列：描述与数据的伤害类型不一致");
{
  const actor = new CrucibleActor("D");

  const spray = new CrucibleAction({ id: "noxiousSpray", tags: ["melee", "natural", "reflex", "electricity"] }, { actor });
  spray.prepare();
  check("noxiousSpray 电击 → 毒（与上游 2cfed5dd 一致）", spray.usage.damageType === "poison", spray.usage.damageType);

  const sd = new CrucibleAction({ id: "selfDestruct", tags: ["generic", "fortitude", "piercing", "fire"] }, { actor });
  sd.prepare();
  check("selfDestruct 穿刺 → 火焰", sd.usage.damageType === "fire", sd.usage.damageType);

  const dt = new CrucibleAction({ id: "devourThoughts", tags: ["melee", "natural", "weakened"] }, { actor });
  dt.prepare();
  check("devourThoughts 钝击 → 灵能", dt.usage.damageType === "psychic", dt.usage.damageType);

  // 反向：上游把写错的标签删掉之后，归属判据不成立 → 补丁不插手
  const fixed = new CrucibleAction({ id: "noxiousSpray", tags: ["melee", "natural", "reflex"] }, { actor });
  fixed.prepare();
  check("上游删掉 electricity 标签 → 补丁不插手", fixed.usage.damageType !== "poison", String(fixed.usage.damageType));

  // 反向：上游补上了正确标签 → 幂等
  const already = new CrucibleAction({ id: "devourThoughts", tags: ["melee", "psychic"] }, { actor });
  already.prepare();
  check("上游补了 psychic 标签 → 幂等", already.usage.damageType === "psychic");

  // 反向：只带 fire 不带 piercing 的动作不受 selfDestruct 那条影响（归属判据要两个都在）
  const onlyFire = new CrucibleAction({ id: "selfDestruct", tags: ["generic", "fire"] }, { actor });
  onlyFire.prepare();
  check("selfDestruct 判据要 piercing+fire 同时在", onlyFire.usage.damageType === "fire");
}

/**
 * 不出现在任何补丁表里、但确实有代码读的设置键。
 * 每一条都注明消费点，否则这个「孤儿开关」断言会退化成一张许可名单。
 */
const EXPECTED_ORPHAN_SETTINGS = new Set([
  "patchSwallowEffectId",   // applySwallowEffectId()，applyToggles 里直接调
  "patchAffixTraining",     // installAffixTrainingFix()
  "patchFlankingToggle",    // installFlankingToggleFix()
  "patchDamageTypes",       // patchDamageTypes()，setup 阶段一次性改 CONFIG
  "patchRuneCantrips",      // P3：在 callActorHooks 包装里就地判定，不走补丁表
  "patchLineageCantrips"    // P3′：同上，且在 injectRuneCantrips 循环里**逐条**判定
]);

console.log("\n版本闸门（上游修好后自动停用，但 0.10.1 用户仍然要能用）");
{
  const ACT = () => globalThis.emberCrucibleTempFix.ACTION_PATCHES;
  const defs = globalThis.emberCrucibleTempFix.PATCH_DEFS;
  const p2 = defs.find(d => d.setting === "patchSuddenBite");

  check("没有 fixedIn → 照常生效", !!ACT().suddenBite);

  p2.fixedIn = "0.11.0";                     // 上游将在 0.11.0 修好，但我们装的是 0.10.1
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("当前版本低于 fixedIn → 仍然生效", !!ACT().suddenBite);

  p2.fixedIn = "0.10.1";                     // 正好等于当前版本 = 已经修好了
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("当前版本等于 fixedIn → 自动停用", ACT().suddenBite === undefined);

  p2.fixedIn = "0.10.0";                     // 更早就修好了
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("当前版本高于 fixedIn → 自动停用", ACT().suddenBite === undefined);

  delete p2.fixedIn;
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("撤掉 fixedIn → 恢复生效", !!ACT().suddenBite);

  const realVersion = game.system.version;
  delete game.system.version;
  p2.fixedIn = "0.10.0";
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("读不到系统版本 → 保守地继续生效", !!ACT().suddenBite);
  game.system.version = realVersion;

  // 另一条回退路径：核心的比较函数不在（旧版 Foundry / API 改名）
  const realCmp = foundry.utils.isNewerVersion;
  delete foundry.utils.isNewerVersion;
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("读不到比较 API → 同样保守地继续生效", !!ACT().suddenBite);
  foundry.utils.isNewerVersion = realCmp;

  // Ember 版本轴：ember 侧的数据缺陷该按 **Ember 版本** 封顶，不是 crucible 版本。
  // 依据是上游自己的 applyEmberPatches()（:45782）就是按 ember.version 闸门的。
  delete p2.fixedIn;
  globalThis.ember = { version: "0.6.0" };
  p2.fixedInEmber = "0.7.0";
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("Ember 版本低于 fixedInEmber → 仍然生效", !!ACT().suddenBite);
  p2.fixedInEmber = "0.6.0";
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("Ember 版本追上 fixedInEmber → 自动停用", ACT().suddenBite === undefined);
  delete globalThis.ember;
  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
  check("读不到 Ember 版本 → 保守地继续生效", !!ACT().suddenBite);
  delete p2.fixedInEmber;

  // 版本上限必须**也管得到原型补丁**。这是中央表 VERSION_CEILINGS 的存在理由：
  // 在它之前，闸门只作用于 PATCH_DEFS / UNIVERSAL_DEFS，而 B 系列（上游一发布
  // 就该退休的五条回搬）恰恰全是 PROTOTYPE_PATCHES —— fixedIn 写了也是死字。
  const ceilings = globalThis.emberCrucibleTempFix.VERSION_CEILINGS;
  const bumpB1 = v => { ceilings.patchEnchantmentBonus = { fixedIn: v }; };
  const realB1 = ceilings.patchEnchantmentBonus;

  const rollB1 = () => {
    const w = new CrucibleWeaponModel();
    w.__affixEnchantment = 3;
    w.prepareBaseData(); w.prepareDerivedData();
    return w.actionBonuses.enchantment;
  };

  bumpB1("0.11.0");
  check("原型补丁：当前版本低于 fixedIn → 仍然生效", rollB1() === 3, String(rollB1()));
  bumpB1("0.10.1");   // = 当前系统版本
  check("原型补丁：当前版本追上 fixedIn → 自动停用", rollB1() === 0, String(rollB1()));
  bumpB1("0.10.0");
  check("原型补丁：当前版本高于 fixedIn → 自动停用", rollB1() === 0, String(rollB1()));

  // 保守回退这条轴对原型补丁同样要成立
  const realVersion2 = game.system.version;
  delete game.system.version;
  check("原型补丁：读不到系统版本 → 保守地继续生效", rollB1() === 3, String(rollB1()));
  game.system.version = realVersion2;

  // Ember 轴也要能管到原型补丁
  ceilings.patchEnchantmentBonus = { fixedInEmber: "0.6.0" };
  globalThis.ember = { version: "0.6.0" };
  check("原型补丁：Ember 版本追上 fixedInEmber → 自动停用", rollB1() === 0, String(rollB1()));
  delete globalThis.ember;
  check("原型补丁：读不到 Ember 版本 → 保守地继续生效", rollB1() === 3, String(rollB1()));

  ceilings.patchEnchantmentBonus = realB1;

  /**
   * 0.10.2 已发布（2026-08）。B1–B5 的缺陷**上游都修好了**，本模块亲验：
   *   B1 :47338 `this.actionBonuses = {ability: 0, skill: -4, enchantment: 0};`（原为 enchantment.bonus）
   *   B2 armor 那句 `category.dodge.base(...) + enchantment.bonus` 已不存在
   *   B3 `removeAttribute("value")` 已不存在
   *   B4 :rollSkill 里已是 `check = response;`（采纳对话框换过的技能）
   *   B5 已是 `if ( featuredEquipment.length >= 3 ) break;`
   * 所以在 0.10.2 上这四个开关必须**全部自动停用**；而 0.10.1 的用户仍然要拿到补丁。
   * 这一组把「版本一到就退休」钉死 —— 退早了 0.10.1 用户受害，退晚了就是无谓的重复修补。
   */
  const settingOnProbe = k => globalThis.emberCrucibleTempFix.__settingOn(k);
  const B_KEYS = ["patchEnchantmentBonus", "patchCurrencyPopout",
                  "patchSkillDialogSwap", "patchFeaturedEquipment"];
  const realVer = game.system.version;

  game.system.version = "0.10.1";
  check("0.10.1 上 B 系列四条全部生效",
    B_KEYS.every(k => settingOnProbe(k)), B_KEYS.filter(k => !settingOnProbe(k)).join(","));

  game.system.version = "0.10.2";
  check("0.10.2 上 B 系列四条全部自动停用",
    B_KEYS.every(k => !settingOnProbe(k)), B_KEYS.filter(k => settingOnProbe(k)).join(","));
  check("0.10.2 上 B1 的行为回到上游原样", rollB1() === 0, String(rollB1()));

  game.system.version = "0.11.0";
  check("更高版本同样停用", B_KEYS.every(k => !settingOnProbe(k)));

  // 非 B 系列不受版本影响 —— 别把整批补丁一起误退休
  check("0.10.2 上非 B 系列不受影响",
    settingOnProbe("patchTurnsDuration") && settingOnProbe("patchAbyssMark"));

  /**
   * 0.10.2 顺带修好的另外六条（每条都在安装的 0.10.2 源码里读过新实现，并经三路独立证伪）。
   * 这一组把**退休名单本身**钉死：将来谁手滑删掉一条，或者反过来多退休一条，都会红。
   */
  const RETIRED_IN_0102 = [
    "patchEnchantmentBonus",   // B1/B2 #1396
    "patchCurrencyPopout",     // B3    #1379
    "patchSkillDialogSwap",    // B4    #1398
    "patchFeaturedEquipment",  // B5    #1388
    "patchRepeatedPrepare",    // I4    #1404
    "patchAffixTraining",      // N11   #1423
    "patchHasKnowledge",       // I2    #1412
    "patchPrivateBiography",   // I3    #1406
    "patchDefenseTypeLabel",   // I5    #1402
    "patchFlankingToggle"      // I6    #1311
  ];

  game.system.version = "0.10.2";
  const stillOn = RETIRED_IN_0102.filter(k => settingOnProbe(k));
  check(`0.10.2 上这 ${RETIRED_IN_0102.length} 条全部自动停用`, stillOn.length === 0, stillOn.join(","));

  game.system.version = "0.10.1";
  const offAt101 = RETIRED_IN_0102.filter(k => !settingOnProbe(k));
  check("0.10.1 上这些仍然全部生效（不能把老用户的补丁提前撤掉）",
    offAt101.length === 0, offAt101.join(","));

  /**
   * ⚠ patchDamageTypes 差点被误判退休：上游 changelog 说改了 Noxious Spray 的伤害类型，
   *   但那只动了 **crucible 自己的包**；ember 0.6.0 的对抗者快照里仍带 electricity。
   *   判定者只扫了一侧，三个独立证伪者都抓到了。这条断言把这个教训固定下来。
   */
  game.system.version = "0.10.2";
  check("patchDamageTypes 在 0.10.2 上仍然生效（ember 侧数据没跟着改）",
    settingOnProbe("patchDamageTypes"));
  check("退休名单里没有 patchDamageTypes",
    !RETIRED_IN_0102.includes("patchDamageTypes"));

  // 中央表与退休名单必须一致 —— 两处各写一遍，谁漏了都会红
  const ceilKeys = Object.keys(ceilings).sort();
  check("中央表的键集与退休名单完全一致",
    JSON.stringify(ceilKeys) === JSON.stringify([...RETIRED_IN_0102].sort()),
    `表:${ceilKeys.join(",")} / 名单:${[...RETIRED_IN_0102].sort().join(",")}`);

  game.system.version = realVer;
  check("恢复真实系统版本后 B1 又生效", rollB1() === 3, String(rollB1()));

  // settingOn 的**失败方向**必须是「保守生效」。
  // 这条不是理论洁癖：设置在 init 注册，而原型补丁的包装体在 setup 之后才被调用；
  // 万一注册没跑到（世界不是 crucible 系统、别的模块在 init 抛错打断了钩子链），
  // 读不到设置的正确反应是**继续打补丁**，而不是把 30 条补丁静默全关 ——
  // 后者会让人以为模块装上了、其实一条都没生效。
  {
    const realGet = game.settings.get;
    game.settings.get = () => { throw new Error("模拟：设置尚未注册"); };
    const w = new CrucibleWeaponModel();
    w.__affixEnchantment = 3;
    w.prepareBaseData(); w.prepareDerivedData();
    check("读不到设置 → 补丁仍然生效（保守方向）", w.actionBonuses.enchantment === 3, String(w.actionBonuses.enchantment));
    game.settings.get = realGet;
    const w2 = new CrucibleWeaponModel();
    w2.__affixEnchantment = 3;
    w2.prepareBaseData(); w2.prepareDerivedData();
    check("设置恢复后行为不变", w2.actionBonuses.enchantment === 3);
  }

  // 所有表里引用的设置键都必须**确实注册过**。写错一个键，settingOn() 会读不到设置、
  // 按保守方向返回 true —— 也就是那条补丁**永远关不掉**，而且一声不吭。
  const regd = globalThis.emberCrucibleTempFix.__registeredSettings;
  const T = globalThis.emberCrucibleTempFix;
  const referenced = [
    ...Object.keys(ceilings).map(k => [k, "VERSION_CEILINGS"]),
    ...T.PATCH_DEFS.map(d => [d.setting, "PATCH_DEFS"]),
    ...T.UNIVERSAL_DEFS.map(d => [d.setting, "UNIVERSAL_DEFS"]),
    ...T.PROTOTYPE_PATCHES.map(p => [p.setting, "PROTOTYPE_PATCHES"]),
    ...T.HOOK_OVERRIDES.filter(o => o.setting).map(o => [o.setting, "HOOK_OVERRIDES"])
  ];
  const dead = referenced.filter(([k]) => !regd.has(k));
  check(`各表引用的设置键全部注册过（共 ${referenced.length} 处引用）`,
    dead.length === 0, dead.map(([k, t]) => `${t}:${k}`).join(", "));

  // 反向：注册了却没人引用的设置键 = 面板上摆着一个不管事的开关
  const used = new Set(referenced.map(([k]) => k));
  const orphan = [...regd].filter(k => !used.has(k) && !EXPECTED_ORPHAN_SETTINGS.has(k));
  check("没有注册了却无人引用的开关", orphan.length === 0, orphan.join(", "));

  // N11 的退休闸门：上游补上 CrucibleActor#training 之后就不该再改词缀钩子
  Object.defineProperty(CrucibleActor.prototype, "training", { get() { return this.system.training; }, configurable: true });
  check("上游补上 training getter → N11 自动停用",
    globalThis.emberCrucibleTempFix.installAffixTrainingFix() === false);
  delete CrucibleActor.prototype.training;
  check("撤掉 getter → N11 恢复安装", globalThis.emberCrucibleTempFix.installAffixTrainingFix() === true);

  setSetting("ember-crucible-tempfix.patchSuddenBite", true);
}

console.log("\nI6 夹击叠层：安装时机与退让分支");
{
  const T = globalThis.emberCrucibleTempFix;
  // 复刻上游 debugFlanking.onChange（crucible-compiled.mjs:47965）——
  // 特征串 "canvas.tokens.controlled" 必须真的出现在源码里，闸门读的就是它
  const makeUpstream = () => (_event, active) => {
    CONFIG.debug = CONFIG.debug ?? {};
    CONFIG.debug.flanking = active;
    for ( const token of globalThis.canvas.tokens.controlled ) {
      if ( active ) token._visualizeEngagement(token.engagement);
      else token._clearEngagementVisualization();
    }
  };
  const mkControls = fn => ({ tokens: { tools: { debugFlanking: { onChange: fn } } } });

  const c1 = mkControls(makeUpstream());
  check("正常情况 → 包装上", T.__wrapFlankingTool(c1) === "已包装");
  check("幂等：再来一次不重复包", T.__wrapFlankingTool(c1) === "已经包装过");
  check("留了原实现的引用", typeof c1.tokens.tools.debugFlanking.onChange.__tempfixOriginal === "function");

  // 关掉叠层时必须清理**全部** token，不只是 controlled —— I6 的实质
  const cleared = [];
  const mkToken = id => ({ id, engagement: {}, _visualizeEngagement() {}, _clearEngagementVisualization() { cleared.push(id); } });
  const a = mkToken("选中的"), b = mkToken("没选中的");
  globalThis.canvas.tokens.controlled = [a];
  globalThis.canvas.tokens.placeables = [a, b];
  cleared.length = 0;
  c1.tokens.tools.debugFlanking.onChange({}, false);
  check("关闭时连没选中的 token 也清理了（孤儿图形）",
    cleared.includes("没选中的"), cleared.join(","));
  // 打开时不许乱清
  cleared.length = 0;
  c1.tokens.tools.debugFlanking.onChange({}, true);
  check("开启时不做清理", cleared.length === 0, cleared.join(","));
  globalThis.canvas.tokens.controlled = [];
  globalThis.canvas.tokens.placeables = [];

  // 上游改写实现 → 自动退让，而且**说出来**（以前是静默 return）
  const c2 = mkControls(function onChange() { /* 上游重写了，没有那句遍历 */ });
  const warnsBefore = warnCount;
  check("上游改写实现 → 闸门未匹配、自动退让", T.__wrapFlankingTool(c2) === "闸门未匹配");
  check("退让时原实现一字未动", !c2.tokens.tools.debugFlanking.onChange.__tempfixPatched);
  // ⚠ 「静默退让」正是本轮暴露的病根：I6 失效了却一句话都没有。
  //   所以退让必须**留声**，且只留一次（重渲染很频繁，刷屏同样是病）。
  check("退让时打了一条警告（不许静默）", warnCount > warnsBefore, `${warnsBefore} → ${warnCount}`);
  const warnsAfterFirst = warnCount;
  T.__wrapFlankingTool(mkControls(function onChange() { /* 同样改写过 */ }));
  check("退让的警告只打一次，不刷屏", warnCount === warnsAfterFirst, `${warnsAfterFirst} → ${warnCount}`);

  // 工具不在（控件还没渲染）
  check("控件还没渲染 → 报「没找到工具」", T.__wrapFlankingTool({}) === "没找到工具");
  check("controls 为 undefined 也不抛", T.__wrapFlankingTool(undefined) === "没找到工具");

  // 关掉开关 → 不包
  setSetting("ember-crucible-tempfix.patchFlankingToggle", false);
  const c3 = mkControls(makeUpstream());
  check("关掉开关 → 不包装", T.__wrapFlankingTool(c3) === "开关关闭");
  setSetting("ember-crucible-tempfix.patchFlankingToggle", true);

  /**
   * ⚠ 这条是本次真 bug 的直接判据：
   * 场景控件的首次渲染在 setup 之后、ready 之前（foundry.mjs:205843 → :206127），
   * 所以只在 ready 装就赶不上 —— 首次进世界 I6 完全不生效。
   * 现在 install 会**就地把已经渲染好的那个工具补包住**。
   */
  globalThis.ui.controls = { controls: mkControls(makeUpstream()) };
  T.installFlankingToggleFix();
  check("控件已渲染后才安装 → 就地补包住（不必等重渲染）",
    !!globalThis.ui.controls.controls.tokens.tools.debugFlanking.onChange.__tempfixPatched);
  delete globalThis.ui.controls;
}

console.log("\n版本一致性（缓存旧脚本的检测机制）");
{
  const T = globalThis.emberCrucibleTempFix;
  const manifest = { version: MANIFEST_VERSION };

  /**
   * ⚠ 这条断言是整个机制的命根子。SCRIPT_VERSION 靠人手同步，一旦忘了改，
   * 「缓存检测」就会**永远误报**（清单新、脚本常量旧），比没有还糟 ——
   * 用户会被一条假警告指着去清缓存。所以让它在离线测试里就红。
   */
  check("SCRIPT_VERSION 与 module.json 的 version 一致（发版时两处都要改）",
    T.SCRIPT_VERSION === manifest.version, `脚本 ${T.SCRIPT_VERSION} / 清单 ${manifest.version}`);

  // 一致 → 不报过期
  check("版本一致 → stale 为 false", T.versionCheck().stale === false);
  check("versionCheck 报出两边的版本",
    T.versionCheck().script === T.SCRIPT_VERSION && !!T.versionCheck().manifest);

  // 清单更新而脚本没更新（真实场景：浏览器缓存了旧 .mjs）→ 必须报过期
  const realGet = game.modules.get;
  game.modules.get = () => ({ id: "ember-crucible-tempfix", version: "99.0.0" });
  check("清单比脚本新 → 判定为缓存旧脚本", T.versionCheck().stale === true);
  check("过期时把两边版本都带出来", T.versionCheck().manifest === "99.0.0"
    && T.versionCheck().script === T.SCRIPT_VERSION);

  // 读不到清单（模块未注册 / API 变了）→ 不许误报成过期
  game.modules.get = () => undefined;
  check("读不到清单 → 不误报过期（保守）", T.versionCheck().stale === false);
  game.modules.get = realGet;
}

console.log("\n控制面板与命令表");
{
  const T = globalThis.emberCrucibleTempFix;
  const cat = T.SETTING_CATALOG;
  const cmds = T.COMMANDS;

  // 目录必须与实际注册的开关一一对应 —— 面板照它渲染，漏一条就是面板上少一个开关
  const regd = T.__registeredSettings;
  check("目录条数 = 注册的开关数", cat.length === regd.size, `${cat.length} / ${regd.size}`);
  check("目录里每个键都注册过", cat.every(s => regd.has(s.key)),
    cat.filter(s => !regd.has(s.key)).map(s => s.key).join(","));
  check("注册的每个开关都在目录里", [...regd].every(k => cat.some(s => s.key === k)),
    [...regd].filter(k => !cat.some(s => s.key === k)).join(","));
  check("目录没有重复键", new Set(cat.map(s => s.key)).size === cat.length);

  // 组号：面板按它分组，写错一个组号那条就整个不显示
  const GROUPS = new Set(["①", "②", "③", "④", "⑤"]);
  const badGroup = cat.filter(s => !GROUPS.has(s.group));
  check("每条都落在已知分组里（面板漏渲染的直接来源）", badGroup.length === 0,
    badGroup.map(s => `${s.key}:${s.group}`).join(","));
  for ( const g of GROUPS ) {
    check(`分组 ${g} 非空`, cat.some(s => s.group === g));
  }

  // 命令表
  check("命令 id 不重复", new Set(cmds.map(c => c.id)).size === cmds.length);
  check("每条命令都有可执行的 run", cmds.every(c => typeof c.run === "function"));
  check("每条命令都写了等价命令与效果", cmds.every(c => c.command && c.effect && c.label));
  check("help() 返回全部命令", T.help().length === cmds.length);

  // 批量开关：面板上「全部关闭」必须真的全关，而不是关一半
  const restore = cat.map(s => [s.key, getSetting(`ember-crucible-tempfix.${s.key}`)]);
  await T.setAllSettings(false);
  check("全部关闭 → 一条都不剩",
    cat.every(s => getSetting(`ember-crucible-tempfix.${s.key}`) === false));
  check("全部关闭后动作补丁表清空", Object.keys(T.ACTION_PATCHES).length === 0,
    Object.keys(T.ACTION_PATCHES).join(","));
  check("全部关闭后通用补丁也清空", T.UNIVERSAL_PATCHES.length === 0);

  await T.setAllSettings(true);
  check("全部开启 → 全都回来",
    cat.every(s => getSetting(`ember-crucible-tempfix.${s.key}`) === true));
  check("全部开启后通用补丁回到满员", T.UNIVERSAL_PATCHES.length === T.UNIVERSAL_DEFS.length);

  for ( const [k, v] of restore ) setSetting(`ember-crucible-tempfix.${k}`, v);

  // 面板 HTML：点不了按钮，但至少能验「每一项都真的渲染出来了」——
  // 漏渲染是静默失败，面板上少一个开关不会有任何报错。
  const html = T.__renderToolbox(null);
  const missingSettings = cat.filter(s => !html.includes(`data-setting="${s.key}"`));
  check("面板渲染出了每一个开关的切换按钮", missingSettings.length === 0,
    missingSettings.map(s => s.key).join(","));
  const missingCmds = cmds.filter(c => !html.includes(`data-command="${c.id}"`));
  check("面板渲染出了每一条命令的按钮", missingCmds.length === 0,
    missingCmds.map(c => c.id).join(","));
  check("面板把等价命令原文写出来了",
    cmds.filter(c => c.command !== "—（面板专用）").every(c => html.includes(esc(c.command))),
    cmds.filter(c => c.command !== "—（面板专用）" && !html.includes(esc(c.command))).map(c => c.id).join(","));
  check("面板列出了五个分组", Object.keys(T.SETTING_GROUPS ?? {}).length === 5 ||
    ["①", "②", "③", "④", "⑤"].every(g => html.includes(`<legend>${g}`)));

  // 输出区：命令跑完的结果要显示在面板里，且必须转义（诊断里含用户可控的角色名）
  const withOut = T.__renderToolbox({ ok: true, label: "自检", text: '<img src=x onerror=alert(1)>' });
  check("面板输出区转义了内容（角色名可能含尖括号）",
    withOut.includes("&lt;img") && !withOut.includes("<img src=x"));
  check("面板输出区把失败也显示出来",
    T.__renderToolbox({ ok: false, label: "自检", text: "boom" }).includes("⚠"));

  // ⚠ 这一组盯的是 0.7.0 漏测的那条缝：面板 HTML 有断言，而**类能不能建起来**、
  //   **菜单有没有真的注册上**一条都没有。用户报「看不到控制面板」时，
  //   我没有任何一条断言能回答「面板到底注册了没」。
  check("面板类建得起来（ApplicationV2 在场时不返回 null）", !!T.__getToolboxClass());
  check("面板类是 ApplicationV2 的子类",
    T.__getToolboxClass()?.prototype instanceof foundry.applications.api.ApplicationV2);
  check("面板类缓存住了（不是每次重建）", T.__getToolboxClass() === T.__getToolboxClass());
  check("面板类把两个动作都挂上了",
    !!T.__getToolboxClass()?.DEFAULT_OPTIONS?.actions?.run &&
    !!T.__getToolboxClass()?.DEFAULT_OPTIONS?.actions?.toggle);
  check("能实例化并 render（点开面板这一步）", (() => {
    try { return new (T.__getToolboxClass())().render({ force: true })?.rendered === true; }
    catch { return false; }
  })());

  // 菜单必须真的注册进去了 —— 这是「看不到控制面板」的直接判据
  check("控制面板菜单已注册", registeredMenus.some(m => m.key === "ember-crucible-tempfix.toolbox"),
    registeredMenus.map(m => m.key).join(",") || "（一个菜单都没注册）");
  const menu = registeredMenus.find(m => m.key === "ember-crucible-tempfix.toolbox");
  check("菜单的 type 就是面板类", menu?.type === T.__getToolboxClass());
  check("菜单限定 GM", menu?.restricted === true);

  // 注册数：设置全注册完之后菜单才注册。init 中途抛的话这两个数都会掉，
  // 而现实里的症状正是「只剩十几条设置 + 没有面板」。
  check("init 一路跑到底（32 项开关 + 1 个下拉 + 1 个菜单）",
    regd.size === 32 && registeredMenus.length === 1,
    `开关 ${regd.size} / 菜单 ${registeredMenus.length}`);
  check("下拉框在菜单之前注册（面板塌了也带不走它）",
    game.settings.settings?.has?.("ember-crucible-tempfix.redirectResource") !== false);

  /**
   * 面板注册的**失败路径**。这一组是用户报「看不到控制面板」逼出来的：
   * 面板本来夹在 bool() 与 redirectResource 之间且裸调 getToolboxClass()，
   * 它一抛就把 registerMenu + redirectResource + applyToggles 全带走，
   * 而症状只是「面板和下拉框不见了」，完全看不出 init 半途死了。
   */
  {
    const realAPI = foundry.applications.api;

    // ① ApplicationV2 缺席（init 阶段还没就位）→ 不抛，只是这次没注册上
    T.__resetToolboxClass();
    game.settings.menus.delete("ember-crucible-tempfix.toolbox");
    foundry.applications.api = undefined;
    let threw = false;
    let got;
    try { got = T.__registerToolboxMenu(); } catch { threw = true; }
    check("ApplicationV2 缺席 → 不抛", !threw);
    check("ApplicationV2 缺席 → 报告未注册", got === false, String(got));

    // ② 下一个阶段 ApplicationV2 就位 → 重试能补上（这就是 setup/ready 各试一次的意义）
    foundry.applications.api = realAPI;
    T.__resetToolboxClass();
    check("下个阶段重试 → 菜单补注册成功", T.__registerToolboxMenu() === true);
    check("重试后菜单确实进了 menus", game.settings.menus.has("ember-crucible-tempfix.toolbox"));

    // ③ 幂等：已经注册过就直接返回 true，不重复注册
    const before = registeredMenus.length;
    check("已注册 → 幂等返回 true", T.__registerToolboxMenu() === true);
    check("已注册 → 不重复注册", registeredMenus.length === before, `${before} → ${registeredMenus.length}`);

    // ④ 类构造抛异常 → 吞掉并报告，绝不外泄到 init
    T.__resetToolboxClass();
    game.settings.menus.delete("ember-crucible-tempfix.toolbox");
    foundry.applications.api = { get ApplicationV2() { throw new Error("模拟：类不可用"); } };
    let threw2 = false, got2;
    try { got2 = T.__registerToolboxMenu(); } catch { threw2 = true; }
    check("面板类抛异常 → 不外泄到 init", !threw2);
    check("面板类抛异常 → 报告未注册", got2 === false, String(got2));

    // 还原
    foundry.applications.api = realAPI;
    T.__resetToolboxClass();
    T.__registerToolboxMenu();
    check("收尾：菜单恢复注册", game.settings.menus.has("ember-crucible-tempfix.toolbox"));
  }
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

  /**
   * ⚠ diagnose 的 universal 一栏以前写死成 ["turnsDuration"]，
   *   I7 加进来之后就开始漏报 —— 补丁在跑、自检却说只有一条。
   *   用户贴 diagnose 才发现。所以这里盯两件事：每条都有 label、报出来的条数对得上。
   */
  {
    const defs = globalThis.emberCrucibleTempFix.UNIVERSAL_DEFS;
    const noLabel = defs.filter(d => !d.label);
    check("每条通用补丁都有 label（diagnose 靠它报名字）",
      noLabel.length === 0, noLabel.map(d => d.setting).join(","));
    check("label 不重复", new Set(defs.map(d => d.label)).size === defs.length);
    const u = globalThis.emberCrucibleTempFix.diagnose().patches.universal;
    check("diagnose 报出全部在跑的通用补丁（不是写死一条）",
      u.length === defs.length, `报了 ${u.length} 条 / 实际 ${defs.length} 条：${u.join(",")}`);
    check("diagnose 报的名字都能对上 label",
      u.every(n => defs.some(d => d.label === n)), u.join(","));

    /**
     * ⚠ I7 从通用补丁改挂成原型补丁之后，`UNIVERSAL_DEFS` 只剩一条 ——
     *   此时「写死成 `["turnsDuration"]`」与「按 defs 推导」输出**恰好相同**，
     *   上面那两条断言就失去了约束力（变异测试当场报了假绿）。
     *   所以临时注册第二条，把差异变得可观测：一条永远绿的断言等于没有断言。
     */
    const P = globalThis.emberCrucibleTempFix;
    const fakeBody = { prepare() {} };
    P.UNIVERSAL_DEFS.push({ setting: "__probe", label: "__probe", body: fakeBody });
    P.UNIVERSAL_PATCHES.push(fakeBody);
    try {
      const u2 = P.diagnose().patches.universal;
      check("diagnose 的 universal 是推导出来的，不是写死的",
        (u2.length === 2) && u2.includes("__probe") && u2.includes("turnsDuration"), u2.join(","));
    }
    finally {
      P.UNIVERSAL_DEFS.pop();
      P.UNIVERSAL_PATCHES.pop();
    }
  }

  check("通用补丁默认全部在册（现在只剩 N10，I7 已改挂原型补丁）",
    globalThis.emberCrucibleTempFix.UNIVERSAL_PATCHES.length === globalThis.emberCrucibleTempFix.UNIVERSAL_DEFS.length,
    `${globalThis.emberCrucibleTempFix.UNIVERSAL_PATCHES.length} / ${globalThis.emberCrucibleTempFix.UNIVERSAL_DEFS.length}`);
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
  // 报 bug 时贴的就是 diagnose 的输出。「在跑哪一版」是第一个要问的问题 ——
  // 用户报「看不到控制面板」时真实原因就是在跑 0.2.2，而当时输出里根本没有版本号。
  {
    const d = globalThis.emberCrucibleTempFix.diagnose();
    check("diagnose 带上了模块版本", !!d.version && d.version !== "?", String(d.version));
    check("diagnose 带上了脚本自身版本", !!d.scriptVersion, String(d.scriptVersion));
    check("diagnose 报出脚本是否过期", d.staleScript === false, String(d.staleScript));
    // ⚠ 上面那条在版本一致时恒为 false，写死 `staleScript: false` 也能骗过去
    //   （变异测试抓到过）。所以必须在**不一致**的条件下再验一次。
    {
      const realGet = game.modules.get;
      game.modules.get = () => ({ id: "ember-crucible-tempfix", version: "99.0.0" });
      const d2 = globalThis.emberCrucibleTempFix.diagnose();
      check("清单与脚本不一致时 diagnose 必须报 staleScript=true",
        d2.staleScript === true, String(d2.staleScript));
      check("此时 diagnose 的 version 与 scriptVersion 确实不同",
        d2.version === "99.0.0" && d2.scriptVersion !== "99.0.0",
        `${d2.version} / ${d2.scriptVersion}`);
      game.modules.get = realGet;
    }
    check("diagnose 带上了系统版本", !!d.system, String(d.system));
    check("diagnose 报出开关数", d.settingsRegistered === 32, String(d.settingsRegistered));
    check("diagnose 报出面板注册状态", d.panelRegistered === true, String(d.panelRegistered));
  }
}

function ACTIONS() { return globalThis.emberCrucibleTempFix.ACTION_PATCHES; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
