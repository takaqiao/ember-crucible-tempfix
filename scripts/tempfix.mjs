/**
 * Ember / Crucible 临时修补
 *
 * 全部是**运行时**修补：不写世界存盘数据，停用模块即恢复原状。
 * （唯一的例外说明见 README「兼容性」——已经生成的聊天卡里存着当时的动作快照。）
 *
 * ── 共用前提（改代码前必读，这四条是所有补丁的地基）────────────────────────
 *
 * ① **动作钩子不来自数据字段。** `grep -c actionHooks crucible-compiled.mjs` = 0。
 *    钩子只有一个来源：`CrucibleAction.#prepareHooks(actionId)`（:19047）→
 *    `crucible.api.hooks.action[actionId]`，按 **action id** 索引。
 *    ember 在 `ember.mjs:126744` 用 `Object.assign(crucible.api.hooks[k], v)` 注册了 43 个动作钩子。
 *    数据里那些 `"actionHooks": []` 是系统压根不读的死字段。
 * ② **`_tests()` 的合并语义是「同名覆盖，其余保留」。** 我们的包装 yield 出
 *    `Object.assign({}, own, extra)`：补丁提供哪个键就顶掉 ember 的哪个键，没提供的原样保留。
 *    → 想**追加**行为就挑一个 ember 没定义的钩子名；想**替换**就必须把原逻辑整段照抄进来。
 * ③ **标签永远排在钩子之前**（`_tests` = `yield* this.tags.tags(); yield this.hooks;`），
 *    所以补丁改不到本轮标签的 initialize/prepare；谁赢由 `??=` 与裸 `=` 的差异决定，不是优先级。
 * ④ **按 action id 注入必须加归属判据**（形状或 owner）——语料里存在同 id 不同数据的动作
 *    （steamVent / lightningBurst / frenziedClaws）。每个钩子体第一行都是判据。
 *
 * ── 补丁清单 ──────────────────────────────────────────────────────────────
 *  P1  offhandStrike        副手打击的前置判据取的是存盘 slot（含 N8：徒手/临时武器手位）
 *  P2  suddenBite           凯思族「撕咬」把锥形的 min=max 写法套到了单体上
 *  P3  rune cantrips        带 rune 的天赋漏了该符文的招牌小戏法（含 N9：训练等级 + summons 合集）
 *  P4  restorativeRedirect  「疗愈导流」恢复的资源种类恒为生命值
 *  N1  abyssMarkUnmaking    硬编码效果 id 只有 15 字符 → 动作抛异常、连聊天卡都不生成
 *  N2  sentinelShielding    changes 写在效果顶层而不是 effect.system 下 → 加值全丢
 *      tyraphicTransform    同上
 *  N3  sentinelKick         staggered 的 duration 有 value 没 units → 变永久
 *  N4  heartSparkOfEmber    scope 写成 ENEMIES，复活友方的分支永远选不中
 *  N5  bewilderingGaze      缺 willpower 标签 → 精神攻击打的是护甲
 *  N6  antigravityStone     纯自身效果写成 single + self:false → 完全不可用
 *  N7  darkflameCirclet     composed 标签只对法术动作合法 → 使用时崩在出卡之前
 *
 * 每一项都能在「配置设置 → 模块设置」里单独关掉。
 */

const MODULE_ID = "ember-crucible-tempfix";
const log = (...a) => console.log(`${MODULE_ID} |`, ...a);
const warn = (...a) => console.warn(`${MODULE_ID} |`, ...a);

/** @returns {{EITHER:number, MAINHAND:number, OFFHAND:number, TWOHAND:number}} */
const slots = () => globalThis.SYSTEM?.WEAPON?.SLOTS ?? { EITHER: 0, MAINHAND: 1, OFFHAND: 2, TWOHAND: 3 };

/* -------------------------------------------- */
/*  补丁表                                        */
/* -------------------------------------------- */

/**
 * actionId → 一组 action hook。经下面的 `_tests` 包装注入，**覆盖**该动作自带的同名 hook。
 * @type {Record<string, Record<string, Function>>}
 */
const ACTION_PATCHES = {};

/**
 * 需要整体替换的 `crucible.api.hooks` 条目（动作钩子走 ACTION_PATCHES，这里是天赋等其它类型）。
 * `guard` 是原实现源码里必须还能看到的字符串 —— 上游一改就自动放弃，不会带着过期假设跑下去。
 * @type {Array<{type: string, id: string, hook: string, guard?: string, impl: Function}>}
 */
const HOOK_OVERRIDES = [];

/**
 * 对**每一个**动作都生效的补丁。与 ACTION_PATCHES 的关键区别：
 * 它们作为**额外的一格** yield 出去，**不与 `this.hooks` 合并** ——
 * 所以既不会顶掉 ember 的同名钩子，也不会顶掉按 id 的补丁（见顶部前提 ②）。
 * 只用于「整类数据都写错了、按 id 列不全」的缺陷。
 * @type {Array<Record<string, Function>>}
 */
const UNIVERSAL_PATCHES = [];

/** 已经就「上游实现变了」警告过的 `<actionId>.<hook>`，避免每次数据准备刷屏 */
const warnedGuards = new Set();

/* -------------------------------------------- */
/*  P1：副手打击 + N8 徒手手位                     */
/* -------------------------------------------- */

/**
 * 系统原判据（crucible-compiled.mjs:10132）：
 *
 *   lastAction.events.find(e => e.type === "strike")?.weapon.system.slot !== SLOTS.MAINHAND
 *
 * 两个问题：
 *  ① `e.weapon` 是 `CrucibleItem#snapshot()`（:7753）的产物，取的是 **_source**。
 *    而「这件武器现在握在哪只手」对 slot 为 EITHER 的武器只存在于**派生值**里：
 *    schema `slot` 的 `initial: 0`（:44989）+ `_prepareWeapons`（:41550/:41555）只改派生不回写 _source。
 *    实测 `ember.crucible-adventure` 里有 **161 件已装备、非天生、_source.slot=0 的武器**，
 *    分布在 111 个 actor 上（其中 9 个带 Dual Wield）—— 复现用例：Juro Wandren 的双匕首。
 *  ② 只看 `find()` 的**第一个** strike 事件；双持/多次打击时第一次可能不是主手那一击。
 *
 * 修法：拿事件里的武器 id 回查角色身上那件武器的**派生** slot；查不到再退回快照值；
 * 并且**任意一次** strike 命中主手（或双手）即通过。
 *
 * 徒手/临时武器那条路径（_id 为 null，三级判据全部落空）由 `fixTransientWeaponSlots` 从源头修好，
 * 见下。两者是互补的：这里放宽判据，那里补上缺失的手位。
 */
ACTION_PATCHES.offhandStrike = {
  // 本补丁**整体顶掉**上游的 canUse（`Object.assign` 是按名覆盖）。上游哪天自己修好了，
  // 我们会带着旧逻辑继续跑，既不报警也不退让 —— 那不是双重应用，是**静默替换**。
  // 所以给它一道与 HOOK_OVERRIDES.guard 同款的特征串闸门：看不到就整键退让。
  __guard: ["MustFollowMainhandStrike", "SLOTS.MAINHAND"],
  canUse() {
    const actor = this.actor;
    const fail = () => {
      throw new Error(game.i18n.format("ACTION.WARNINGS.MustFollowMainhandStrike", { action: this.name }));
    };
    const last = actor?.lastConfirmedAction;
    if ( !last ) return fail();

    const { MAINHAND, TWOHAND } = slots();
    const mainhandId = actor.equipment?.weapons?.mainhand?.id ?? null;

    const strikes = (last.events ?? []).filter(e => e.type === "strike");
    if ( !strikes.length ) return fail();

    const ok = strikes.some(e => {
      const id = e.weapon?._id ?? e.weapon?.id ?? null;

      // 优先：角色身上那件武器**当前**的派生 slot（这才是「握在哪只手」的真值）
      const live = id ? actor.items.get(id) : null;
      const liveSlot = live?.system?.slot;
      if ( (liveSlot === MAINHAND) || (liveSlot === TWOHAND) ) return true;

      // 其次：这件武器此刻就是主手武器
      if ( id && mainhandId && (id === mainhandId) ) return true;

      // 最后才退回快照里的存盘值（原系统只看这一项）
      const snapSlot = e.weapon?.system?.slot;
      return (snapSlot === MAINHAND) || (snapSlot === TWOHAND);
    });

    if ( !ok ) return fail();
  }
};

/**
 * N8：徒手与临时武器上游忘了赋手位。
 *
 * `UNARMED_DATA`（:6681）的 system 里没有 slot → `NumberField initial: 0` = EITHER；
 * unarmed 类目允许 EITHER/MAINHAND/OFFHAND，所以 `prepareBaseData`（:45077）的兜底也不触发；
 * `_prepareWeapons` 的 either 桶明确写了 `w.system.slot = MAINHAND/OFFHAND`（:41550/:41555），
 * **紧接着的徒手赋值（:41562/:41565）一个字都不设 slot**。
 * 于是 `strike.roll`（:4131）记下的 snapshot 是 `{_id: null, slot: 0}`，副手打击判据恒假 ——
 * 而系统自己在 :41606 明文把全徒手判为双持，Flurry / Dervish 赤手空拳都能用，唯独 Dual Wield 不行。
 *
 * 用 `updateSource` 而不是改派生值：只有 _source 才会进 snapshot。
 * 徒手 item 是纯内存 transient（`_getUnarmedWeapon` :41624 `new itemCls(data, {parent})`，
 * 不在任何集合里），`updateSource` 不落库 —— 系统自己在 :18286 就是这个用法。
 * @param {object} actor
 */
function fixTransientWeaponSlots(actor) {
  const w = actor.equipment?.weapons;
  if ( !w ) return;
  const S = slots();
  const fix = (item, slot) => {
    if ( !item || item.id ) return;                        // 有 _id 的真武器一律不碰
    if ( item.system?._source?.slot !== S.EITHER ) return; // 上游修好了、或本来就有手位 → 不动
    item.system.updateSource({ slot });
  };
  fix(w.mainhand, S.MAINHAND);
  fix(w.offhand, S.OFFHAND);
}

/* -------------------------------------------- */
/*  P2：凯思族「撕咬」的范围                        */
/* -------------------------------------------- */

/**
 * ember 的 `Keth Lineage > suddenBite` 写着 `range: {minimum: 2, maximum: 2}`。
 * `minimum` 量的是**贴边距离**（getLinearRange，相邻两个 token 是 0），
 * 所以 min=2 把「贴着咬」直接排除掉了 —— 在 5 尺格的场景上这个动作永远无法生效。
 *
 * 对照同类近身单体动作一律 `min: null, max: 1`
 * （`Rune: Storm > Energize`、`Heart Attunement > Spark of Ember`）。
 *
 * 注：`range.minimum` 只有三个消费点 —— :19692（**仅 single**）、:20190（_getWeaponAvailability，
 * 读 _source）、:3054（仅 movement）。所以 cone 根本不读 minimum，
 * 「锥形的 min=max 是锥长」那个旧说法是错的：锥长只取 maximum。
 */
ACTION_PATCHES.suddenBite = {
  prepare() {
    if ( this.target?.type !== "single" ) return;   // 上游若改成锥形就别动它
    this.range.minimum = null;
    this.range.maximum = 1;
  }
};

/* -------------------------------------------- */
/*  P4：疗愈导流（2026-08 重写）                    */
/* -------------------------------------------- */

/**
 * ⚠ 本条曾经修错过，重写前请读完这段。
 *
 * **旧实现的三条前提全是错的**：ember 并没有「漏掉自动化」——
 * 它在 `ember.mjs:125213-125233` 注册了完整的 `canUse` / `initialize` / `postActivate`。
 *  - 不掷骰不是缺陷：无骰恢复（postActivate 记 resources 事件）是 crucible 的正典写法，
 *    自家的 secondWind(:10711) / rallyingCry(:10257) / fontOfLife(:9547) 等 11 条全是如此，
 *    secondWind 甚至显式 `usage.hasDice = false`。
 *  - `harmless` 不会归零它：harmless.postActivate(:4453) 只动 `event.roll?.hasDamage` 的骰子，
 *    而 resources 事件不是 roll。crucible 自家的 revive(:10620) 还主动调用它再发放恢复。
 *  - 旧补丁加 `generic` 的后果：generic.roll(:4323) 会对**队友**掷一次针对 Wounds 阈值的攻击骰，
 *    而 ember 的 postActivate 照跑 → 同一次动作两笔恢复。
 *
 * **真正剩下的唯一缺陷**：`ember.mjs:125221` 读 `lastAction.damage?.resource`，
 * 而 `CrucibleSpellAction.#prepareDamage`（:21884）产出的对象是
 * `{base, bonus, multiplier, type, restoration}` —— **没有 `resource` 键**，所以恒为 "health"。
 * 会打士气的符文确实存在（control :5792、illusion :5859）。
 *
 * 只覆盖 `canUse`：它是 ember 设 usage.resource 的地方，也是 prepare 之后唯一还能改的时机
 * （生命周期：prepare :20320 → canUse :20429 → roll :20519 → postActivate :20531）。
 */
ACTION_PATCHES.mayisRestorativeRedirection = {
  canUse() {
    const base = this.hooks?.canUse;
    if ( !(base instanceof Function) ) return;   // ember 没装或改了实现 —— 不接管
    base.call(this);                             // 复用 ember 的全部校验，让它照常 throw
    const res = resolveRedirectResource(this.actor);
    if ( res ) this.usage.resource = res;
  }
};

/**
 * 回溯最近一次针对本角色的法术，取那一骰**实际打的**资源。
 *
 * 事件在 flags 里是序列化过的：target 是 uuid 字符串，骰子下标的键名是 **rollIndex**
 * （`CrucibleActionEvent#toObject` :18296 写入 `obj.rollIndex = this.roll.data.index`，
 * `fromObject` :18327 读回）。序列化对象里**没有 `roll` 这个键** —— 旧实现读 `ev.roll`，
 * 所以 auto 档 100% 失效且静默退回 health。
 * @param {object} actor
 * @returns {"health"|"morale"}
 */
function resolveRedirectResource(actor) {
  let mode = "auto";
  try { mode = game.settings.get(MODULE_ID, "redirectResource"); } catch { /* 设置还没注册 */ }
  if ( mode !== "auto" ) return mode;
  if ( !actor?.uuid ) return "health";

  try {
    for ( const m of game.messages.contents.slice(-40).reverse() ) {
      const f = m.flags?.crucible;
      if ( !Array.isArray(f?.events) ) continue;
      if ( !f.action?.tags?.includes("spell") ) continue;
      for ( const ev of f.events ) {
        if ( ev.target !== actor.uuid ) continue;
        const idx = ev.rollIndex;
        const roll = Number.isInteger(idx) ? m.rolls?.[idx] : null;
        const res = roll?.data?.damage?.resource
          ?? ev.resources?.find(r => (r.restoration === false) && ["health", "morale"].includes(r.resource))?.resource;
        if ( (res === "health") || (res === "morale") ) {
          log(`疗愈导流：从「${f.action?.name ?? "?"}」推断出目标资源 = ${res}`);
          return res;
        }
      }
    }
  } catch ( err ) {
    warn("疗愈导流：资源自动推断失败，退回 health", err);
  }
  return "health";
}

/* -------------------------------------------- */
/*  N1：深渊「湮灭之印」的非法效果 id               */
/* -------------------------------------------- */

/** 16 字符；ember 写的 "abyssMarkUnmak0" 只有 15，过不了 `/^[a-zA-Z0-9]{16}$/`。 */
const ABYSS_MARK_ID = "abyssMarkUnmak00";
/** ember 原值 —— guard 与「读旧标记」两处都要用到。 */
const ABYSS_MARK_ID_BAD = "abyssMarkUnmak0";

/**
 * `ember.mjs:125607` 写死 `this.effects[0]._id = "abyssMarkUnmak0"` —— 15 字符。
 * `isValidId` 要求恰好 16 位；`DocumentIdField._validateType` 抛错。
 * crucible 在 :19812 是 `_id: _id || getEffectId(...)`，硬编码值是 truthy，压过自动生成。
 * 抛出点在 `#resolveEventStream()`（:19374 调用），一路逃出 `#use()` ——
 * **崩在 `toMessage` 之前，所以连聊天卡都不生成、资源一点不扣**。rank-2 的收割 +2 Focus 也永远不触发。
 *
 * 必须整体替换而不是「调原实现再改 _id」：原实现里「移除旧目标身上的标记」那一步同样按坏 id 查找，
 * 修好写入端之后它反而会开始漏删。下面是 `ember.mjs:125604-125619` 的逐行照抄，只换常量
 * ——并且读旧标记时**新旧两个 id 都认**，好让升级前挂上的标记也能被清掉。
 */
ACTION_PATCHES.abyssMarkUnmaking = {
  preActivate() {
    const target = this.targets.values().next().value?.actor;
    if ( !target ) return;
    const effect = this.effects?.[0];
    if ( !effect ) return;
    effect._id = ABYSS_MARK_ID;
    foundry.utils.setProperty(this.selfUpdateEvent.actorUpdates, "flags.ember.abyssMarkTarget", target.uuid);

    // Move the mark: stage deletion of any prior mark on a different target
    const priorUuid = this.actor.flags.ember?.abyssMarkTarget;
    if ( priorUuid && (priorUuid !== target.uuid) ) {
      const priorTarget = fromUuidSync(priorUuid);
      for ( const id of [ABYSS_MARK_ID, ABYSS_MARK_ID_BAD] ) {
        if ( priorTarget?.effects?.has(id) ) {
          this.recordEvent({ type: "effect", target: priorTarget, effects: [{ _id: id, _action: "delete" }] });
        }
      }
    }
  }
};

/**
 * 天赋侧：`emberAbyssAttune.finalizeAction`（ember.mjs:126119-126153）同样按坏 id 查找，
 * 修好写入端之后它一条都读不到 —— 两侧必须一起改。
 * 这是 `ember.mjs:126119-126153` 的逐行照抄，只换常量。
 */
HOOK_OVERRIDES.push({
  type: "talent", id: "emberAbyssAttune", hook: "finalizeAction", guard: ABYSS_MARK_ID_BAD,
  impl: function finalizeAction(_item, action) {
    // Harvest +2 Focus when this action drops the currently-marked target into weakened/broken/dead.
    const markedUuid = this.flags.ember?.abyssMarkTarget;
    if ( !markedUuid ) return;
    const target = fromUuidSync(markedUuid);
    const markId = [ABYSS_MARK_ID, ABYSS_MARK_ID_BAD].find(id => target?.effects?.has(id));
    if ( !target || (target === this) || !markId ) return;

    // Nothing left to harvest from this mark.
    const r = target.system.resources;
    if ( (r.health.value === 0) || (r.morale.value === 0) || target.system.isDead ) {
      action.recordEvent({ type: "effect", target, effects: [{ _id: markId, _action: "delete" }] });
      return;
    }

    // Sum net resource deltas applied to the marked target by this action
    let dHealth = 0;
    let dMorale = 0;
    let dWounds = 0;
    for ( const event of action.events ) {
      if ( event.target !== target ) continue;
      const rt = event.resourceTotals;
      dHealth += (rt.health ?? 0);
      dMorale += (rt.morale ?? 0);
      dWounds += (rt.wounds ?? 0);
    }
    const woundsMax = r.wounds?.max ?? Infinity;
    const isDefeated = ((r.health.value + dHealth) <= 0) || ((r.morale.value + dMorale) <= 0)
      || (r.wounds && ((r.wounds.value + dWounds) >= woundsMax));
    if ( !isDefeated ) return;

    // Record the harvest, consume the mark, and clear the caster's mark flag
    action.recordEvent({ target: this, resources: [{ resource: "focus", delta: 2 }],
      statusText: [{ text: "Mark of Unmaking" }] });
    action.recordEvent({ type: "effect", target, effects: [{ _id: markId, _action: "delete" }] });
    foundry.utils.setProperty(action.selfUpdateEvent.actorUpdates, "flags.ember.abyssMarkTarget",
      globalThis._del ?? null);
  }
});

/* -------------------------------------------- */
/*  N10：units:"turns" 的效果永远不会被创建         */
/* -------------------------------------------- */

/**
 * **本模块目前影响面最大的一条**：19 个动作、九个血统的招牌变身，效果从来没落地过。
 *
 * 链条：
 *  ① 数据里写的是 v12 时代的 `{turns: N}`（或 `{turns: N, rounds: null}`）。
 *  ② `CrucibleAction.migrateData`（`:21573`）对每条 effect 调核心 `ActiveEffect.migrateData`，
 *     `#migrateDuration`（foundry.mjs:15931）按 seconds→turns→rounds 找第一个**数字**属性，
 *     补出 `{value: N, units: "turns"}`。**迁移本身是成功的。**
 *  ③ 然后 `CrucibleActiveEffect._preCreate`（`:39581`）撞上这个：
 *
 *       if ( ["months", "turns"].includes(this.duration.units) ) {
 *         console.warn("The Crucible system does not support effect durations of unit \"turns\" or \"months\"!");
 *         return false;                    // ← 效果压根不会被创建
 *       }
 *
 * 玩家看到的是：**聊天卡白纸黑字写着「获得 XXX · 持续 ∞」，角色身上一个图标都没有。**
 * 控制台有那句 warn，但没人会把它和「我的变身没生效」联系起来。
 *
 * 受影响的（本机数据实测 19 个动作 / 20 条效果，冒险包里还有重复副本）：
 * Altyra 雷法姆变身、Cor'ak 结晶创伤、Fej 极限代谢、Hulg'run 活石、Kivahr 律动、
 * Thornling 荆棘皮、Vrjnhar 顽强、Wirrun 不懈猎手、Zeph 三张面具 —— **九个血统的招牌能力全在里面**；
 * 外加 abyssalWhispers / bewilderingGaze / frenziedClaws / searingStare / sentinelShielding 等敌手动作。
 *
 * 修法：把 `units` 从 `"turns"` 改成 `"rounds"`，数值不动，补上 `expiry`。
 * 依据是 crucible 自己的转换惯例 —— `SYSTEM.EFFECTS.staggered`（`:5740`）的产物就是
 * `{value: turns, units: "rounds", expiry: "turnStart"}`。
 *
 * > ⚠ 这是**解释**不是还原：上游没有 turns 这个单位，作者想要的「N 个回合」只能映射到 rounds。
 * >   数值等价与否无从考证（`implacableHunter` 写的是 `turns: 360`）。所以给了单独开关。
 *
 * 注：本机数据里 `months` 用法为 0 条，所以只处理 turns。
 */
/**
 * 上游是否**仍然**拒绝 `units:"turns"`。
 *
 * 直接读 `_preCreate` 的源码找那道拦截 —— 与 `HOOK_OVERRIDES` 的 `guard` 是同一个思路：
 * 上游哪天放宽了限制，这里就检测不到，补丁自动停用，**不会擅自把 turns 改写成 rounds**。
 * 失败方向也是安全的：检测不到就什么都不做，等于没装本模块。
 * @returns {boolean}
 */
let _rejectsTurns = null;
function systemRejectsTurns() {
  if ( _rejectsTurns !== null ) return _rejectsTurns;
  try {
    const src = String(CONFIG.ActiveEffect?.documentClass?.prototype?._preCreate ?? "");
    _rejectsTurns = /["']turns["']/.test(src);
    if ( !_rejectsTurns ) log("上游似乎已支持 turns 时长单位，N10 自动停用");
  } catch {
    _rejectsTurns = false;   // 读不到就别乱改
  }
  return _rejectsTurns;
}

const turnsDurationPatch = {
  preActivate() {
    if ( !systemRejectsTurns() ) return;            // 上游放宽了就别动它
    for ( const effect of this.effects ?? [] ) {
      const d = effect?.duration;
      if ( !d || (d.units !== "turns") ) continue;
      d.units = "rounds";
      // expiry 用 turnEnd 而不是 turnStart —— 依据是上游自己迁移同一种数据时的映射：
      // commit 48bf4391f7（PR #695「Migrate ActiveEffect expiry to V14 native schema」）
      // 把自家 _source 里旧的 `{turns:N, rounds:null}` 全部迁成
      // `{value:N, units:"rounds", expiry:"turnEnd"}` —— 实测 49/49，零例外。
      // （turnStart 是上游给 `{rounds:N}` 那种数据的映射，套到 turns 数据上会多撑约两个 turn。）
      // 注意：N3 的 sentinelKick 保持 turnStart，它的数据不是 turns 型，
      // 最近的权威是 crucible 自家的 SYSTEM.EFFECTS.staggered 生成器（:5740），产出就是 turnStart。
      d.expiry ??= "turnEnd";
    }
  }
};

/* -------------------------------------------- */
/*  N2：changes 写在效果顶层                       */
/* -------------------------------------------- */

/**
 * `ember.mjs:125108`（sentinelShielding）与 `:125149`（tyraphicTransformation）写的是
 * `Object.assign(this.effects[0], {changes: [...]})` —— **顶层**。
 * 动作 effects 的 schema（:18624）只有 `name/scope/result/statuses/duration/system`，
 * `changes` 由 `system` 提供；`#recordEffectEvents` 的解构（:19806）与重建（:19811）都不含顶层 changes，
 * 核心的顶层→system 迁移够不着（键在 :19806 就被剥掉了）。
 * → 效果图标照常挂上，加值一条都不生效。
 *
 * 同文件的正确写法有 4 处对照：crystalizeWounds :124978、extremeMetabolism :125032、
 * livingStone :125049、auraSlipstream :125458，全部写在 `system.changes` 下。
 *
 * 注：`mode` vs `type` 不是第二个缺陷 —— `mode` 是野键会被 schema 清掉，
 * `type` 落 `initial: "add"`，而作者要的正是 ADD。**唯一的缺陷是少了 `.system` 这一层。**
 */
ACTION_PATCHES.sentinelShielding = {
  preActivate() {
    const e = this.effects?.[0];
    if ( !e?.system ) return;                    // 上游改了 schema 就别动
    e.system.changes = [{ key: "system.defenses.armor.bonus", value: 3, type: "add" }];
  }
};

ACTION_PATCHES.tyraphicTransformation = {
  preActivate() {
    const e = this.effects?.[0];
    const a = this.actor;
    if ( !e?.system || !a ) return;
    const presence = a.system?.abilities?.presence?.value ?? 0;
    e.system.changes = [
      { key: "system.resistances.radiant.bonus", value: 2 * (a.level ?? 0), type: "add" },
      { key: "system.rollBonuses.damage.radiant", value: Math.ceil(presence / 2), type: "add" }
      // 第三条「威吓 +2 骰运」用 change 表达不出来：rollBonuses 每轮被重置成
      // 恰好 {damage:{}, boons:{}, banes:{}}（:41179），而骰运的读取点（:36852）是全局的、
      // 无法按技能限定。留给上游修，README 里记了一句。
    ];
  }
};

/* -------------------------------------------- */
/*  N3：排斥踢的 staggered 变永久                  */
/* -------------------------------------------- */

/**
 * 数据里 `duration = {value: 1, units: "", expiry: null}`。
 * :19810 `const effectDuration = duration.units ? duration : (duration.expiry ? {...} : undefined)`
 * → undefined → 核心 AE schema 回落 `{value: null, units: "seconds"}`
 * → `unprepared.value ??= Infinity` → `isTemporary` 为假 → **连过期注册表都不进**。
 * 而 :41808 `else if (statuses.has("staggered")) resources.action.bonus -= 2`
 * —— 中招的角色**每回合永久少 2 点行动点**，效果卡渲染成 ∞ 归入 persistent 段，极易被当成设定。
 *
 * 全库唯一性：1437 个动作实例、550 条 duration，`value 是数字 && units === ""` 只有这 2 行。
 * `SYSTEM.EFFECTS.staggered`（:5740）自己的产物是 `{value: turns, units: "rounds", expiry: "turnStart"}`。
 */
ACTION_PATCHES.sentinelKick = {
  preActivate() {
    const d = this.effects?.[0]?.duration;
    if ( !d ) return;
    if ( d.units ) return;                       // 上游修好了就别动
    if ( typeof d.value !== "number" ) return;   // 真正的「无时限」写法是 value:null + units:""
    d.units = "rounds";
    d.expiry ??= "turnStart";
  }
};

/* -------------------------------------------- */
/*  N4：余烬之火的目标作用域                        */
/* -------------------------------------------- */

/**
 * 数据 `target: {type:"single", number:1, scope:3, self:false}`，而钩子（ember.mjs:125385）
 * 的载荷是 `{resource:"health", delta: max-value}` + `{resource:"wounds", delta: -value}`
 * —— 纯单向增益，代价还含 2 点英雄点。scope=3（ENEMIES）使复活友方尸体的分支**永远选不中目标**：
 * 目标条目渲染成 unmet、提示「Invalid target scope」、「使用」按钮置灰。
 *
 * 对照：crucible.spell 的 Revive 完全同构（single / max 1 / 复活死者）但 `scope: 4`，
 * 靠 isDead 闸门做门禁；ember 自己所有回复类动作落在 scope 4/2/1。
 * 同天赋的 heartHallow（减益）用 scope 3 是**对的**，所以判据必须按 id 命中。
 *
 * crucible 自己有一等先例：`HOOKS$1.reshape.prepare`（:13456）就是在 prepare 里改 target.scope。
 */
ACTION_PATCHES.heartSparkOfEmber = {
  prepare() {
    const S = globalThis.SYSTEM?.ACTION?.TARGET_SCOPES ?? { ENEMIES: 3, ALL: 4 };
    if ( this.target?.scope === S.ENEMIES ) this.target.scope = S.ALL;
  }
};

/* -------------------------------------------- */
/*  N5：迷乱凝视缺防御标签                          */
/* -------------------------------------------- */

/**
 * tags 是 `["generic","void","presence","morale"]`，缺 `willpower` —— 另三个标签都不碰 defenseType
 * （void :4657 只设 damageType，presence :4672 只设 ability，morale :4687 只设 resource），
 * 于是 `generic.prepare` 的 `defenseType ??= "physical"`（:4319）生效，**精神凝视按护甲结算**。
 *
 * 后果比「DC 取错」更难看：physical 在 testDefense 里走专属分支（:36988），
 * 失败时随机抽 Dodge/Parry/Block/Armor/Glance —— 一次精神凝视被「用盾牌挡下」；
 * 而且 `resolveDamage` 在 result >= GLANCE 时就结算，**掷骰失败也可能擦过去打出士气伤害**。
 *
 * 对照：crucible 自己的 terrifyingPresence = `['reaction','generic','harmless','willpower','presence']`；
 * ember 自己另外 3 条 generic+morale 动作全带防御标签。全语料 20 条 generic 动作里只有它一条漏。
 *
 * ⚠ 补丁体绝对不能定义 `postActivate` —— ember 在 :124960 用它施加 confused，顶掉就是更严重的回归。
 * 靠 `willpower.prepare` 的裸 `=`（:4534）压过 generic 的 `??=`，与标签排序无关。
 */
ACTION_PATCHES.bewilderingGaze = {
  initialize() {
    if ( !this.tags.has("generic") ) return;                       // 归属判据
    if ( this.tags.has("fortitude") || this.tags.has("reflex") || this.tags.has("willpower") ) return;
    this.tags.add("willpower");
  }
};

/* -------------------------------------------- */
/*  N6：反重力石的目标类型                          */
/* -------------------------------------------- */

/**
 * `target = {type:"single", number:1, scope:4, self:false}` + `tags:["movement"]`，
 * 两个值恰好都是 schema 默认（:18610 / :18617）—— 作者压根没填 target。
 * 后果：带 movement 标签会先让玩家规划位移路径，规划完 acquireTargets 报「无效目标」；
 * **把自己设为目标反而触发 CannotTargetSelf，并把刚规划好的路径整个丢弃**（:3089），陷入重复规划。
 *
 * 对照：ember 自己的 Nimble Leap（纯自身位移）写 `type:"self", scope:1`；crucible 的 Gliding 写 `type:"self"`。
 * 全 20 个 pack 里 35 条带 movement 的动作，`type=single && scope=4` 只有这一条。
 *
 * 不用备选方案 `target.self = true`：:19459 的自动退化条件是「用户当前没有选中任何别的代币」，
 * 战斗中残留目标极常见，那时会静默改去针对旁观者。
 */
ACTION_PATCHES.antigravityStone = {
  prepare() {
    if ( (this.target?.type !== "single") || this.target.self ) return;   // 上游修了就别动
    this.target.type = "self";
  }
};

/* -------------------------------------------- */
/*  N7：暗焰头冠的 composed 标签                    */
/* -------------------------------------------- */

/**
 * tags 是 `["composed","corruption"]`，而物品动作一律实例化为基类 `CrucibleAction`
 * （`CrucibleActionField.initialize` :22289 只对 counterspell 特判）。
 *  - `composed.initialize`（:3898）：`if (this.composition === 0) return;` —— 基类没有 composition，
 *    `undefined !== 0` → `this.rune.name` 抛 TypeError（被 _callActionHooks 的 catch 吞成 console.error）。
 *  - `composed.configureVFX`（:3907）→ `configureSpellVFXEffect`（:32826）：守卫恰好放行 →
 *    `SPELL_VFX_GESTURES[action.gesture.id]` 抛 TypeError。而 `configureVFXEffect()`（:20951）是裸循环，
 *    调用点 :21200 在 `ChatMessage.create`（:21378）**之前**且全程没有 try/catch
 *    → **使用时什么都不发生，资源不扣、聊天卡不生成**。
 *
 * 在 prepare 里删标签能救掉出卡崩溃（configureVFXEffect 遍历时已经查不到 composed）；
 * initialize 那条 console.error 补不掉（标签永远排在钩子之前），属于化妆问题。
 * 迭代中删标签是安全的：`tags()`（:18412）循环开始时取到旧 #sorted 引用，`delete()`（:18444）
 * 走 #sort() **重新赋值**一个新数组。
 *
 * 上报给 ember 的正解是把 composed 换成 `spell`（同包另外 4 件投注物品都是这么写的），
 * 而不是补 generic + 防御标签 —— 那会与物品自己写的「effects are not yet automated」冲突。
 */
ACTION_PATCHES.darkflameCirclet = {
  prepare() {
    if ( this.tags.has("composed") ) this.tags.delete("composed");
  }
};

/* -------------------------------------------- */
/*  C 系列：crucible 自身的缺陷                     */
/* -------------------------------------------- */

/**
 * C4「翻滚穿越」的目标阵营写反了。
 *
 * `crucible.talent > tumblethrough000 > tumble` 的 `target.scope` 是 **2 (ALLIES)**，
 * 而描述两次点名 enemy（「穿过目标敌人的格子」）。后果：选中敌人点它 →
 * 目标条目标红 InvalidTargetScope（`:19686`），动作放不出来；只有选队友才能用。
 *
 * ⚠ **必须挂 `initialize` 而不是 `prepare`** —— crucible 自己在 `:10958` 定义了
 * `HOOKS$6.tumble`（含 prepare，设 `movement.strength = POWERFUL`），
 * 提供同名钩子会把它顶掉（见顶部前提 ②）。这正是 P4 犯过的错。
 */
ACTION_PATCHES.tumble = {
  initialize() {
    if ( this.target?.type !== "single" ) return;                 // 归属判据
    const S = globalThis.SYSTEM?.ACTION?.TARGET_SCOPES ?? { ALLIES: 2, ENEMIES: 3 };
    if ( this.target.scope !== S.ALLIES ) return;                 // 上游改好了就别动
    this.target.scope = S.ENEMIES;
  }
};

/**
 * C5「黎明信标」是 pulse 区域却把 scope 写成 **1 (SELF)**。
 *
 * 实测数据：`target = {type:"pulse", scope:1, size:60}`。
 * 区域取目标那条路径（`#acquireTargetsFromRegion` `:19620`）**没有单体路径那样的空集保护**
 * （对照 `:19686`），于是一个目标都取不到：60 尺光柱画出来了，聊天卡上零目标零骰子，
 * 站在正中央的敌人不会被致盲，行动与专注全打水漂。
 *
 * crucible 与 ember 都没有为 `dawnBeacon` 注册任何钩子（两份源码 grep 均 0 命中），
 * 所以这里用哪个钩子名都是纯追加，不会顶掉谁。
 */
ACTION_PATCHES.dawnBeacon = {
  initialize() {
    if ( this.target?.type !== "pulse" ) return;                  // 归属判据
    const S = globalThis.SYSTEM?.ACTION?.TARGET_SCOPES ?? { SELF: 1, ENEMIES: 3 };
    if ( this.target.scope !== S.SELF ) return;                   // 上游改好了就别动
    this.target.scope = S.ENEMIES;
  }
};

/**
 * X1 两条区域伤害动作**缺任何提供 `roll()` 的标签**，描述里承诺的伤害完全不会发生。
 *
 *  - `repugnantPustules`（crucible 敌手天赋）：pulse size 3，
 *    tags `[reaction, weakened, reflex, corruption, toughness]`
 *  - `abyssalRemains`（ember 敌手）：pulse size 4，tags `[weakened, reflex, corruption]`
 *
 * 两者都带 `reflex`（防御类型）与伤害类型标签，唯独没有 `generic` / `strike` / `spell` / `hazard`
 * 这类**提供 roll 实现**的标签 —— `_roll()`（`:20519`）因此调不到任何东西。
 *
 * ⚠ 与 P4 的区别（这是本条能做的唯一理由）：
 * P4 那次错在「数据里没有 actionHooks ⇒ 没自动化」，而 ember 其实在**代码里**注册了钩子。
 * 这两条我按教训逐个 grep 过 —— `crucible-compiled.mjs` 与 `ember.mjs` 里
 * `HOOKS*.repugnantPustules` / `HOOKS*.abyssalRemains` **都是 0 命中**，
 * 确实没有任何代码侧自动化。所以补 `generic` 是把缺的那一环补上，不是叠加。
 */
const missingRollProviderPatch = {
  initialize() {
    if ( this.target?.type !== "pulse" ) return;                  // 归属判据
    // 上游任何时候补了 roll 提供者，这里就自动退让
    for ( const t of ["generic", "strike", "spell", "hazard", "summon"] ) {
      if ( this.tags.has(t) ) return;
    }
    this.tags.add("generic");
  }
};
ACTION_PATCHES.repugnantPustules = missingRollProviderPatch;
ACTION_PATCHES.abyssalRemains = missingRollProviderPatch;

/**
 * C1「吞噬」的效果 ID 是 **17 字符** —— crucible 自家的 N1。
 *
 * `crucible-compiled.mjs:10530` `_SWALLOWED_EFFECT_ID: "swallowed00000000"`
 * （"swallowed" 9 + 8 个 0 = 17），而 `DocumentIdField` 要求恰好 16。
 *
 * 链路与 N1 abyssMarkUnmaking 逐点同构：
 *  ① `swallow.prepare()`（`:10538`）`this.effects.find(e => e.scope === ENEMIES)` ——
 *     **实测数据里第 0 条效果的 scope 就是 3**（statuses `["restrained","blinded"]`），find 必中。
 *     （旧文档 §7 写的「因 scope 未设而潜伏」是没查数据得出的，**已推翻**。）
 *  ② `:19811` `_id: _id || getEffectId(...)` —— 硬编码值 truthy，压过自动生成。
 *  ③ 建效果时被 `DocumentIdField._validateType` 打回，**崩在 `toMessage()`（:21376）之前**。
 *
 * 改常量而不是照抄钩子：回读端 `regurgitate.postActivate`（`:10598`/`:10600`）读的是
 * **同一个引用**，一次赋值两端同时修好。世界里也不可能存在旧的 17 字符效果（从来没创建成功过），
 * 所以不需要 N1 那种新旧双认。
 *
 * 影响面：本机 20 个合集、按 `item.name === "Swallow"` 精确匹配，命中 **5 个 adversary**
 * （全在 ember.crucible-adventure：Mootap ×2 / Sarracenias / Obsidian Vine Outgrowth / Towering Obsidian Vine）。
 */
const SWALLOWED_ID_BAD = "swallowed00000000";   // 17，crucible 0.10.1 的原值
const SWALLOWED_ID = "swallowed0000000";        // 16

/** 按开关改写 / 还原 swallow 的效果 ID 常量。可逆，所以能挂在 applyToggles 上。 */
function applySwallowEffectId(enabled) {
  const sw = globalThis.crucible?.api?.hooks?.action?.swallow;
  const cur = sw?._SWALLOWED_EFFECT_ID;
  if ( typeof cur !== "string" ) return;                 // 上游改了结构 → 退让

  if ( !enabled ) {
    if ( cur === SWALLOWED_ID ) sw._SWALLOWED_EFFECT_ID = SWALLOWED_ID_BAD;   // 关掉 → 还原
    return;
  }
  if ( cur.length === 16 ) return;                       // 上游修好了 → 退让
  if ( cur !== SWALLOWED_ID_BAD ) {                      // 变成了另一个非法值 → 不猜
    const key = "swallow._SWALLOWED_EFFECT_ID";
    if ( !warnedGuards.has(key) ) {
      warnedGuards.add(key);
      warn(`${key} 变成了未知值「${cur}」，C1 自动退让`);
    }
    return;
  }
  sw._SWALLOWED_EFFECT_ID = SWALLOWED_ID;
  if ( sw._SWALLOWED_EFFECT_ID !== SWALLOWED_ID ) {      // 对象被冻结过 → 老实报错
    warn("crucible.api.hooks.action.swallow 不可写，C1 未生效");
    return;
  }
  log("已修正 swallow 的效果 ID");
}

/* -------------------------------------------- */
/*  D 系列：描述与数据的伤害类型不一致               */
/* -------------------------------------------- */

/**
 * **这一类是上游自己在修的**，所以判据可靠：`master` 的 commit `2cfed5dd`
 * 「Change damage type of noxious spray from electricity to poison **as mentioned in the description**」
 * —— 上游用「描述里写的是什么」当判据改数据。我们照同一判据把本机剩下的几条一并修上。
 *
 * 机制：伤害类型标签的 initialize 是 `this.usage.damageType ??= id`（`:4662`），
 * **先到先得**；而标签永远排在钩子之前（顶部前提 ③），所以我们在 `prepare` 里用裸 `=`
 * 就是最后一个写入者。`generic.prepare` 的 `damageType ??= "void"`（`:4321`）也压不过。
 *
 * | 动作 | 现状 | 描述写的 | 出处 |
 * |---|---|---|---|
 * | `noxiousSpray` | tags 含 `electricity` | toxic discharge + 附带 poisoned | 上游已改（`2cfed5dd`） |
 * | `selfDestruct` | 同时带 `piercing` 与 `fire` | "consumed in a **fiery** explosion" | 本机反查 |
 * | `devourThoughts` | **一个伤害类型标签都没有** → 落回天生武器的钝击 | "**Psychic** damage" | 本机反查（playtest 包） |
 *
 * 每条的归属判据都是「那个写错的标签还在不在」——上游一改，判据不成立，补丁自动空转。
 *
 * 注：`distract` 也在反查里被点过名，但**故意不修** —— 它的描述
 * 「Deception based Skill Attack against the Willpower defense」本身是自洽的，
 * 证据不足以判定是缺陷。
 */
const DAMAGE_TYPE_FIXES = {
  // 写错的标签还在 → 才修
  noxiousSpray: { to: "poison", when(a) { return a.tags.has("electricity"); } },
  selfDestruct: { to: "fire", when(a) { return a.tags.has("piercing") && a.tags.has("fire"); } },
  // 这条没有任何伤害类型标签，判据改成「还没有 psychic 标签」
  devourThoughts: { to: "psychic", when(a) { return !a.tags.has("psychic"); } }
};

for ( const [actionId, cfg] of Object.entries(DAMAGE_TYPE_FIXES) ) {
  ACTION_PATCHES[actionId] = {
    prepare() {
      if ( this.usage.damageType === cfg.to ) return;   // 已经对了（上游修好了）→ 不动
      if ( !cfg.when(this) ) return;                    // 归属判据不成立 → 不动
      this.usage.damageType = cfg.to;
    }
  };
}

/* -------------------------------------------- */
/*  P3 + N9：符文小戏法与训练等级                   */
/* -------------------------------------------- */

/**
 * `system.rune` 只负责把符文塞进 `grimoire.runeIds`（:41287），
 * 而每个符文的**招牌小戏法**挂在 crucible 那条 `Rune: X` 天赋的 `system.actions` 上。
 *
 * 按 **rune** 查表而不是按天赋 item id —— 这样同时盖住两批：
 *  - ember 的 4 个血统（Zeph/Drakon/Kiska/Nir'ae，item id 各不相同）
 *  - `crucible.summons` 里 9 条旧快照（_stats.systemVersion 停在 0.9.0，training 全空、actions 全空，
 *    其中 4 条还是已废弃的小写 id `runeflame0000000` 等）
 *
 * `life`(Healer) / `soul`(bard) 故意不在表里：它们的**正版条目**训练等级本来就是空的，
 * 属于设计而不是旧快照。
 * @type {Record<string, {talentId: string, actionId: string}>}
 */
const RUNE_CANTRIPS = {
  storm:        { talentId: "runeStorm0000000", actionId: "energize" },
  flame:        { talentId: "runeFlame0000000", actionId: "enkindle" },
  illusion:     { talentId: "runeIllusion0000", actionId: "seeming" },
  illumination: { talentId: "runeIllumination", actionId: "reveal" },
  frost:        { talentId: "runeFrost0000000", actionId: "condense" },
  earth:        { talentId: "runeEarth0000000", actionId: "mould" },
  death:        { talentId: "runeDeath0000000", actionId: "ennervate" }
};

/** actionId → 小戏法的源数据（ready 时从合集读一次，因此会带上 babele 的中文名与描述） */
const CANTRIP_SOURCES = {};

/**
 * N9(a)：旧快照的 `system.training` 是 `{type:"", rank:null}`。
 * `#prepareTalents` :41281 `if (training.type) {` —— 空串直接跳过，`system.training.<rune>` 压根不存在；
 * 但 :41287 仍 push 进 grimoire.runeIds，所以精怪**能施法、只是未受训** →
 * `getSkillBonus`（:36647）落到 `untrained.bonus = -4`（:6834）。
 * 对照 `crucible.pregens` 里 27 条同类内嵌副本全部带 `{type, rank:1}`。
 * @param {object} actor
 */
function fixRuneTalentTraining(actor) {
  const training = actor.system?.training;
  if ( !training ) return;
  for ( const item of actor.items ) {
    if ( item.type !== "talent" ) continue;
    const rune = item.system?.rune;
    if ( !rune || !RUNE_CANTRIPS[rune] ) continue;
    if ( item.system.training?.type ) continue;              // 上游已填 → 不插手
    training[rune] = Math.max(training[rune] ?? 0, 1);       // 不降级已有的更高等级
  }
}

/**
 * N9(b) + P3：把缺失的小戏法补进 `system.actions`。
 * @param {object} actor    角色
 * @param {object} actions  `system.actions` 那个 record（不是数组）
 */
function injectRuneCantrips(actor, actions) {
  if ( !actions || (typeof actions !== "object") ) return;
  // `clone()` 也会用**单条记录**调这个钩子（:19152），别往那种调用里塞
  if ( actions !== actor.system?.actions ) return;

  const ActionCls = globalThis.crucible?.api?.models?.CrucibleAction;
  if ( !ActionCls ) return;

  for ( const item of actor.items ) {
    if ( item.type !== "talent" ) continue;
    const cfg = RUNE_CANTRIPS[item.system?.rune];
    if ( !cfg ) continue;
    if ( actions[cfg.actionId] ) continue;                                   // 玩家自己也学了 Rune: X
    if ( item.system.actions?.some(a => a.id === cfg.actionId) ) continue;   // 条目自己就带
    const source = CANTRIP_SOURCES[cfg.actionId];
    if ( !source ) continue;

    // T2：**不传 parent**。传了 parent 会让 `canEdit`（:14956）为真，
    // 玩家打开动作配置卡改任何字段都会走到 `_processSubmitData`（:14282）的
    // `findIndex(a => a.id === this.action.id)` → 必返 -1 → throw（右上角红条，卡住不保存）。
    // `item` 在 `_configure`（:18977）里被 defineProperty 冻成值，与 parent 无关，所以名称/图标不受影响。
    // 已知代价：`clone()`（:19135）不转发 item，执行时那份 clone 的 this.item 为 undefined，
    // 聊天卡少一个 item uuid（:21193）。已记进 README。
    actions[cfg.actionId] = new ActionCls(foundry.utils.deepClone(source), { actor, item });
  }
}

/**
 * 把符文小戏法的源数据读进缓存。走合集读取而不是硬编码，是为了带上 babele 的中文名与中文描述。
 */
async function loadCantripSources() {
  const pack = game.packs.get("crucible.talent");
  if ( !pack ) { warn("找不到 crucible.talent 合集，P3/N9 不生效"); return; }
  for ( const cfg of Object.values(RUNE_CANTRIPS) ) {
    if ( CANTRIP_SOURCES[cfg.actionId] ) continue;
    try {
      const doc = await pack.getDocument(cfg.talentId);
      const src = doc?.toObject()?.system?.actions?.find(a => a.id === cfg.actionId);
      if ( src ) CANTRIP_SOURCES[cfg.actionId] = src;
      else warn(`${cfg.talentId} 里没有 ${cfg.actionId}`);
    } catch ( err ) {
      warn(`读取 ${cfg.talentId} 失败`, err);
    }
  }
  log(`已缓存 ${Object.keys(CANTRIP_SOURCES).length} 个符文小戏法`);
}

/* -------------------------------------------- */
/*  安装：动作 hook 注入                           */
/* -------------------------------------------- */

/**
 * `CrucibleAction#_tests()`（:20220）是 `yield* this.tags.tags(); yield this.hooks;`。
 * `this.hooks` 是构造时从 `crucible.api.hooks.action[id]` 快照下来的**冻结**对象（:19023），
 * 所以改注册表对已构造的动作无效。这里改成包装 `_tests`：每次调用都现算，
 * 把自带 hooks 那一格换成「自带 ∪ 我们的补丁」（补丁同名覆盖）。与加载顺序完全无关。
 * @returns {boolean} 是否安装成功
 */
function installActionHookPatch() {
  const A = globalThis.crucible?.api?.models?.CrucibleAction;
  if ( !A?.prototype?._tests ) {
    warn("找不到 CrucibleAction._tests，动作级补丁未安装");
    return false;
  }
  if ( A.prototype._tests.__tempfixPatched ) return true;

  const original = A.prototype._tests;
  function* patchedTests() {
    const extra = ACTION_PATCHES[this.id];
    if ( extra ) {
      const own = this.hooks;
      // 逐键过滤：只有「要顶掉上游同名钩子」的键才受 __guard 约束。
      // 上游没有同名钩子的键（纯追加，如 bewilderingGaze.initialize）一律放行。
      const merged = {};
      for ( const [k, v] of Object.entries(extra) ) {
        if ( k === "__guard" ) continue;                        // 必须剥掉，否则会被当成钩子调用
        if ( extra.__guard && (own[k] instanceof Function) ) {
          const src = String(own[k]);
          if ( ![].concat(extra.__guard).every(g => src.includes(g)) ) {
            const key = `${this.id}.${k}`;
            if ( !warnedGuards.has(key) ) {
              warnedGuards.add(key);
              warn(`${key}：上游实现已变，本补丁自动退让`);
            }
            continue;
          }
        }
        merged[k] = v;
      }
      for ( const test of original.call(this) ) {
        if ( test === own ) yield Object.assign({}, own, merged);
        else yield test;
      }
    }
    else yield* original.call(this);

    // 通用补丁作为**额外的一格**在最后 yield：不与 hooks 合并，所以既顶不掉 ember 的钩子、
    // 也顶不掉按 id 的补丁；放在最后是让它做最终归一化（前面任何一步写成 turns 都还救得回来）。
    for ( const p of UNIVERSAL_PATCHES ) yield p;
  }
  patchedTests.__tempfixPatched = true;
  A.prototype._tests = patchedTests;
  log("已包装 CrucibleAction._tests");
  return true;
}

/**
 * 整体替换 `crucible.api.hooks` 里的条目（目前只有 N1 的天赋侧）。
 * `crucible.api.hooks` 外层被 Object.freeze（:14044），但 `.action` / `.talent` 子表是可写普通对象
 * —— ember 自己就是靠这一点注册进来的。
 * @returns {boolean}
 */
function installHookOverrides() {
  const hooks = globalThis.crucible?.api?.hooks;
  if ( !hooks ) { warn("crucible.api.hooks 不可用，钩子覆盖未安装"); return false; }
  for ( const o of HOOK_OVERRIDES ) {
    const cfg = hooks[o.type]?.[o.id];
    const orig = cfg?.[o.hook];
    if ( !(orig instanceof Function) ) { warn(`跳过 ${o.type}.${o.id}.${o.hook}：未注册`); continue; }
    if ( orig.__tempfixOverride ) continue;
    if ( o.guard && !String(orig).includes(o.guard) ) {
      warn(`跳过 ${o.type}.${o.id}.${o.hook}：上游实现已变，不再套用旧假设`);
      continue;
    }
    o.impl.__tempfixOverride = true;
    o.impl.__tempfixOriginal = orig;
    cfg[o.hook] = o.impl;
    log(`已覆盖 ${o.type}.${o.id}.${o.hook}`);
  }
  return true;
}

/* -------------------------------------------- */
/*  N11：符文 Spellcraft 词缀的训练等级             */
/* -------------------------------------------- */

/**
 * crucible 自己的 bug（`crucible-compiled.mjs:13668-13675`）：
 *
 *   for ( const runeId of Object.keys(RUNES) ) {
 *     HOOKS[`${runeId}Spellcraft`] = {
 *       prepareGrimoire(item, grimoire) {
 *         grimoire.runeIds.push(runeId);
 *         this.training[runeId] = Math.max(this.training[runeId] ?? 0, 1);   // ← 这里
 *       }
 *     };
 *   }
 *
 * `callActorHooks`（`:36571`）是 `fn.call(this, item, ...args)`，`this` 绑定的是
 * **CrucibleActor 文档**；而 `training` 只存在于数据模型上，文档类**没有这个 getter**
 * （全部 getter 里找不到 `get training()`）。于是 `this.training[runeId]` 抛 TypeError。
 *
 * 后果不是「建卡失败」而是**静默降级**：`prepareGrimoire` 的 hook 配置没有 `throws`（`:1168`），
 * 异常被 `callActorHooks` 的 try/catch 吞成 console.error；而抛出点在
 * `grimoire.runeIds.push(runeId)` **之后** —— 所以符文知识拿到了、训练等级没设上，
 * 角色施放该符文的法术时按**未受训 −4**（`:6834`）结算，每次数据准备还刷一条控制台错误。
 *
 * 影响面：12 个符文 Spellcraft 词缀（`crucible.affixes` 里 `system.identifier` 与钩子键逐一对应，
 * 无补零问题）。词缀钩子按 `affix.system.identifier` 查表（`:42078` / `:23113`）。
 *
 * 修法：不硬编码符文清单，而是**按源码特征扫出所有中招的条目**再逐个替换 ——
 * 上游修好之后特征串消失，自动不再命中。
 * @returns {boolean}
 */
function installAffixTrainingFix() {
  let on = true;
  try { on = game.settings.get(MODULE_ID, "patchAffixTraining"); } catch { /* 尚未注册 */ }
  if ( !on ) return false;

  const affix = globalThis.crucible?.api?.hooks?.affix;
  if ( !affix ) { warn("crucible.api.hooks.affix 不可用，N11 未安装"); return false; }

  let n = 0;
  for ( const [id, cfg] of Object.entries(affix) ) {
    const fn = cfg?.prepareGrimoire;
    if ( !(fn instanceof Function) || fn.__tempfixOverride ) continue;
    // 只碰真的写了 `this.training[` 的那些 —— 上游修好后这个特征就没了
    if ( !String(fn).includes("this.training[") ) continue;
    const runeId = id.replace(/Spellcraft$/, "");
    if ( !runeId || (runeId === id) ) continue;               // 键形不对就别猜

    const patched = function prepareGrimoire(item, grimoire) {
      grimoire.runeIds.push(runeId);
      // 唯一的改动：写数据模型而不是文档
      const training = this.system?.training;
      if ( training ) training[runeId] = Math.max(training[runeId] ?? 0, 1);
    };
    patched.__tempfixOverride = true;
    patched.__tempfixOriginal = fn;
    cfg.prepareGrimoire = patched;
    n++;
  }
  if ( n ) log(`N11：修正了 ${n} 个符文 Spellcraft 词缀的训练等级写入`);
  return true;
}

/* -------------------------------------------- */
/*  安装：角色数据准备钩子                          */
/* -------------------------------------------- */

/**
 * 角色数据准备会调 `callActorHooks("prepareGrimoire", …)`（:41686）与
 * `callActorHooks("prepareActions", this.actions)`（:41694）。我们在它们之后补数据。
 *
 * 没有走 `crucible.api.hooks.talent[...]` 注册表，是因为那要求条目本身注册过钩子；
 * 包装原型方法则对所有角色一律生效、且与加载顺序无关。
 * @returns {boolean}
 */
function installActorHookPatch() {
  const proto = CONFIG.Actor?.documentClass?.prototype;
  if ( typeof proto?.callActorHooks !== "function" ) {
    warn("找不到 CrucibleActor#callActorHooks，P3/N8/N9 未安装");
    return false;
  }
  if ( proto.callActorHooks.__tempfixPatched ) return true;

  const original = proto.callActorHooks;
  function patchedCallActorHooks(hook, ...args) {
    const result = original.call(this, hook, ...args);
    const on = key => { try { return game.settings.get(MODULE_ID, key); } catch { return false; } };
    if ( hook === "prepareGrimoire" ) {
      if ( on("patchRuneCantrips") ) {
        try { fixRuneTalentTraining(this); }
        catch ( err ) { warn("修正符文训练等级失败", this?.name, err); }
      }
    }
    else if ( hook === "prepareActions" ) {
      if ( on("patchOffhandStrike") ) {
        try { fixTransientWeaponSlots(this); }
        catch ( err ) { warn("修正徒手手位失败", this?.name, err); }
      }
      if ( on("patchRuneCantrips") ) {
        try { injectRuneCantrips(this, args[0]); }
        catch ( err ) { warn("注入符文小戏法失败", this?.name, err); }
      }
    }
    return result;
  }
  patchedCallActorHooks.__tempfixPatched = true;
  proto.callActorHooks = patchedCallActorHooks;
  log("已包装 CrucibleActor#callActorHooks");
  return true;
}

/* -------------------------------------------- */
/*  开关                                          */
/* -------------------------------------------- */

/**
 * 按设置增减 ACTION_PATCHES 的成员。关掉某一项就是把它从表里摘掉，
 * 包装过的 `_tests` 下一次调用就查不到它了 —— 不需要卸载原型补丁。
 * @type {Array<{setting: string, actionIds: string[]}>}
 */
const PATCH_DEFS = [
  { setting: "patchOffhandStrike", actionIds: ["offhandStrike"] },
  { setting: "patchSuddenBite", actionIds: ["suddenBite"] },
  { setting: "patchRestorativeRedirection", actionIds: ["mayisRestorativeRedirection"] },
  { setting: "patchAbyssMark", actionIds: ["abyssMarkUnmaking"] },
  { setting: "patchEffectChanges", actionIds: ["sentinelShielding", "tyraphicTransformation"] },
  { setting: "patchStaggerDuration", actionIds: ["sentinelKick"] },
  { setting: "patchSparkScope", actionIds: ["heartSparkOfEmber"] },
  { setting: "patchBewilderingGaze", actionIds: ["bewilderingGaze"] },
  { setting: "patchAntigravityStone", actionIds: ["antigravityStone"] },
  { setting: "patchDarkflameCirclet", actionIds: ["darkflameCirclet"] },
  { setting: "patchTumbleScope", actionIds: ["tumble"] },
  { setting: "patchDawnBeaconScope", actionIds: ["dawnBeacon"] },
  { setting: "patchMissingRollProvider", actionIds: ["repugnantPustules", "abyssalRemains"] },
  { setting: "patchDamageTypes", actionIds: ["noxiousSpray", "selfDestruct", "devourThoughts"] }
];

/** actionId → 补丁体的原始引用（applyToggles 会按开关把它们放回/摘掉） */
const PATCH_BODIES = {};
for ( const { actionIds } of PATCH_DEFS ) {
  for ( const id of actionIds ) PATCH_BODIES[id] = ACTION_PATCHES[id];
}

/** 对每个动作都生效的补丁及其开关 */
const UNIVERSAL_DEFS = [
  { setting: "patchTurnsDuration", body: turnsDurationPatch }
];

/**
 * 版本闸门：某条补丁在上游哪个版本被修好。
 *
 * 装的还是 0.10.1 的人**仍然需要**这些补丁，所以这是**加上限**而不是删除 ——
 * 系统版本一旦追上 `fixedIn`，该条自动停用并在控制台说明一次。
 *
 * 这是本模块的第**三**种闸门，三种各管一段：
 *  - **数据形状**（P2 看 `target.type`、N3 看 `duration.units`、N10 读 `_preCreate` 源码）
 *    —— 管「上游改了数据/校验」，最灵敏，但只对能从运行时看出来的改动有效。
 *  - **`__guard` 特征串**（P1、HOOK_OVERRIDES）—— 管「上游重写了我们要顶掉的那段实现」。
 *  - **版本上限**（本节）—— 管「上游修好了，但改动从运行时看不出来」。
 *
 * @param {string} [fixedIn]  上游修好它的系统版本；空表示尚未修好
 * @returns {boolean}         这条补丁是否已被上游取代
 */
function supersededByUpstream(fixedIn) {
  if ( !fixedIn ) return false;
  const current = globalThis.game?.system?.version;
  if ( !current ) return false;
  const iu = globalThis.foundry?.utils?.isNewerVersion;
  if ( typeof iu !== "function" ) return false;
  // isNewerVersion(v1, v0) = v1 是否比 v0 新。相等时返回 false，
  // 所以这里要「当前版本 >= fixedIn」需写成 !(fixedIn 比 current 新)。
  return !iu(fixedIn, current);
}

/** 已经因版本上限停用过、并且已经说明过一次的补丁（避免每次改设置都刷屏） */
const announcedSuperseded = new Set();

function applyToggles() {
  const on = key => {
    try { return game.settings.get(MODULE_ID, key); } catch { return true; }   // 尚未注册时按开处理
  };
  const active = ({ setting, fixedIn }) => {
    if ( !on(setting) ) return false;
    if ( !supersededByUpstream(fixedIn) ) return true;
    if ( !announcedSuperseded.has(setting) ) {
      announcedSuperseded.add(setting);
      log(`${setting}：上游 ${fixedIn} 已修好，本补丁自动停用`);
    }
    return false;
  };
  for ( const def of PATCH_DEFS ) {
    const enabled = active(def);
    for ( const id of def.actionIds ) {
      if ( enabled ) ACTION_PATCHES[id] = PATCH_BODIES[id];
      else delete ACTION_PATCHES[id];
    }
  }
  applySwallowEffectId(active({ setting: "patchSwallowEffectId" }));
  UNIVERSAL_PATCHES.length = 0;
  for ( const def of UNIVERSAL_DEFS ) {
    if ( active(def) ) UNIVERSAL_PATCHES.push(def.body);
  }
}

/**
 * 让改动立刻在已经准备好的角色上生效（不写盘，只重跑数据准备）。
 *
 * T1：crucible 的角色卡全是 ApplicationV2（:14443 等），而且 crucible 在 :47399 主动
 * `unregisterSheet` 掉了核心的 V1 卡 —— **`ui.windows` 里一个 crucible 角色卡都没有**。
 * 只刷 `ui.windows` 等于运行中切换开关后角色卡永远停在旧数据。照抄核心的双循环写法。
 */
function reprepareActors() {
  const t0 = performance.now();
  let n = 0;
  for ( const actor of game.actors ?? [] ) {
    try { actor.prepareData(); n++; } catch ( err ) { warn("重新准备失败", actor?.name, err); }
  }
  for ( const scene of game.scenes ?? [] ) {
    for ( const token of scene.tokens ?? [] ) {
      if ( token.actorLink || !token.actor ) continue;
      try { token.actor.prepareData(); n++; } catch { /* 忽略 */ }
    }
  }
  ui.actors?.render();
  for ( const app of Object.values(ui.windows ?? {}) ) if ( app.actor ) app.render(false);
  for ( const app of foundry.applications?.instances?.values() ?? [] ) {
    const dn = app.document?.documentName;
    if ( app.actor || (dn === "Actor") || (dn === "Item") ) app.render();
  }
  log(`重新准备了 ${n} 个角色，用时 ${Math.round(performance.now() - t0)}ms`);
}

/* -------------------------------------------- */
/*  生命周期                                      */
/* -------------------------------------------- */

Hooks.once("init", () => {
  if ( game.system?.id !== "crucible" ) {
    warn("当前世界不是 crucible 系统，本模块不做任何事");
    return;
  }

  const reload = () => { applyToggles(); if ( game.ready ) reprepareActors(); };

  const bool = (key, name, hint) => game.settings.register(MODULE_ID, key, {
    name, hint, scope: "world", config: true, type: Boolean, default: true, onChange: reload
  });

  bool("patchOffhandStrike", "P1 修正副手打击的前置判据",
    "系统用武器的<strong>存盘</strong> slot 判断上一击是不是主手，而对「任一手」武器来说手位只存在于派生值里；徒手更是从头到尾没被赋过手位。开启后改用角色身上那件武器当前的实际手位判断，并给徒手/临时武器补上手位。");
  bool("patchSuddenBite", "P2 修正凯思族「撕咬」的攻击范围",
    "ember 把 range 写成 min=max=2，而 minimum 量的是贴边距离（相邻＝0），等于把「贴着咬」排除掉了。开启后改为 min=空 / max=1，与同类近身单体动作一致。");
  bool("patchRuneCantrips", "P3 补上符文所授的小戏法与训练等级",
    "带 rune 的天赋（ember 四血统、以及召唤合集里九条旧快照）都没带该符文的招牌小戏法；旧快照还连训练等级一起丢了，导致本命符文法术按「未受训 −4」结算。开启后在运行时补齐。");
  bool("patchRestorativeRedirection", "P4 修正「疗愈导流」恢复的资源种类",
    "ember 读的是法术动作上不存在的 <code>damage.resource</code> 字段，结果恒为生命值。开启后改从那次被抵抗的骰子里取真实资源。动作本身的自动化是好的，本补丁<strong>不</strong>改标签、<strong>不</strong>加掷骰。");
  bool("patchAbyssMark", "N1 修正深渊「湮灭之印」的非法效果 ID",
    "ember 硬编码的效果 id 只有 15 个字符，不是合法的 Foundry 文档 ID，导致这个动作抛异常中止——什么都不发生、连聊天卡都不生成、资源也不扣。开启后换成合法 ID（新旧标记都能清理）。");
  bool("patchDamageTypes", "D 系列 修正描述与数据不符的伤害类型",
    "三条动作的伤害类型与自己的描述矛盾：「毒液喷吐」结算成电击（上游已在开发版改成毒），「自毁」的烈焰爆炸结算成穿刺，「吞噬思绪」的灵能伤害落回天生武器的钝击。后果是抗性算错——吃火抗的角色挡不住火焰爆炸，吃钝击抗性的重甲反而能挡下纯精神攻击。开启后按描述修正。");
  bool("patchSwallowEffectId", "C1 修正「吞噬」的非法效果 ID（crucible 自身缺陷）",
    "crucible 给 Swallow 硬编码的效果 id 有 17 个字符，不是合法的 Foundry 文档 ID，导致这个动作抛异常中止——什么都不发生、连聊天卡都不生成、资源也不扣，配套的「反刍」也永远找不到要删的效果。开启后换成合法的 16 位 ID。");
  bool("patchTumbleScope", "C4 修正「翻滚穿越」的目标阵营（crucible 自身缺陷）",
    "目标阵营写成了「盟友」，而描述两次点名敌人。后果是选中敌人时提示阵营不合法、动作放不出来，只有选队友才能用。开启后改为敌人。");
  bool("patchDawnBeaconScope", "C5 修正「黎明信标」的目标阵营（crucible 自身缺陷）",
    "这是个 60 尺的 pulse 区域，作用域却写成了「自身」，导致区域取目标时一个都取不到——光柱画出来了，聊天卡上零目标零骰子。开启后改为敌人。");
  bool("patchMissingRollProvider", "X1 给两条区域伤害动作补上掷骰实现",
    "「脓疱迸裂」与「深渊残渣」都带防御与伤害类型标签，唯独缺少任何提供掷骰实现的标签，导致描述里承诺的伤害完全不会发生。已逐条确认这两个动作在 crucible 与 ember 的钩子注册表里都没有任何代码侧自动化。开启后补上通用掷骰标签。");
  bool("patchAffixTraining", "N11 修正符文词缀不设训练等级",
    "crucible 自己的 bug：12 个符文 Spellcraft 词缀的钩子把训练等级写到了 actor <em>文档</em>上，而那里没有这个字段，于是抛异常被吞掉——<strong>符文知识拿到了，训练等级没设上</strong>，施放该符文的法术按「未受训 −4」结算，控制台每次数据准备刷一条错误。开启后改写到数据模型上。");
  bool("patchTurnsDuration", "N10 修正被系统拒绝创建的效果时长（影响面最大）",
    "19 个动作的效果时长写的是旧的 <code>turns</code> 单位，而系统在创建效果时会直接拒绝这个单位——<strong>聊天卡写着「获得效果」，角色身上却什么都没有</strong>。<strong>九个血统的招牌变身全部中招</strong>（雷法姆变身/结晶创伤/极限代谢/活石/律动/荆棘皮/顽强/不懈猎手/泽夫三面具）。开启后把单位换成「轮」，数值不变。注意这是解释而非还原：上游没有 turns 这个单位，原作者想要多久无从考证。");
  bool("patchEffectChanges", "N2 修正「强化护盾」/「雷法姆变身」丢失的加值",
    "这两个动作把 changes 写在了效果数据的顶层，而系统只从 effect.system 下读。<strong>本项依赖上面的 N10</strong>——它们的效果同时还因时长单位非法而根本不会被创建，两个开关都开着才有意义。（威吓骰运那一条系统层面表达不了，仍未生效。）");
  bool("patchStaggerDuration", "N3 修正「排斥踢」的踉跄变永久",
    "duration 有 value 却没有 units，被系统整段丢弃，踉跄因此永不过期——中招的角色每回合永久少 2 点行动点。开启后补上 units=rounds。");
  bool("patchSparkScope", "N4 修正「余烬之火」的目标作用域",
    "作用域写成了「敌人」，但它的复活分支是针对友方尸体的，导致那半边永远选不中目标、使用按钮置灰。开启后放宽为「全部」，由动作自己的条件把关。");
  bool("patchBewilderingGaze", "N5 给「迷乱凝视」补上意志防御标签",
    "缺 willpower 标签，导致这个精神攻击按护甲结算（还会被「用盾牌挡下」）。开启后补上标签，与同类动作一致。");
  bool("patchAntigravityStone", "N6 修正「反重力石」的目标类型",
    "纯自身效果却写成「单体目标且不可选自己」，必须拿别人凑数才能用，选自己反而会把规划好的位移路径丢掉。开启后改为自身目标。");
  bool("patchDarkflameCirclet", "N7 修正「暗焰头冠」的非法标签",
    "用了只对法术动作合法的 composed 标签，导致使用时崩在生成聊天卡之前——资源不扣、卡也不出。开启后移除该标签。");

  game.settings.register(MODULE_ID, "redirectResource", {
    name: "P4 疗愈导流恢复哪种资源",
    hint: "条目描述说「恢复原法术所针对的那种资源」。默认「自动推断」会从最近的聊天记录里回溯那次被抵抗的法术实际打的资源，推断不到时按生命值处理。",
    scope: "world", config: true, type: String, default: "auto",
    choices: { auto: "自动推断（回溯最近的法术）", health: "总是生命值", morale: "总是士气" },
    onChange: reload
  });

  applyToggles();
});

Hooks.once("setup", () => {
  if ( game.system?.id !== "crucible" ) return;
  applyToggles();
  installActionHookPatch();
  installActorHookPatch();
  installAffixTrainingFix();
  // ember 在 init 注册钩子，而 #prepareHooks 在角色数据准备时才快照 —— setup 正好夹在中间
  installHookOverrides();
});

Hooks.once("ready", async () => {
  if ( game.system?.id !== "crucible" ) return;

  // setup 阶段可能因加载顺序没装上，这里补一次
  installActionHookPatch();
  installActorHookPatch();
  installAffixTrainingFix();
  installHookOverrides();

  await loadCantripSources();
  reprepareActors();

  globalThis.emberCrucibleTempFix = {
    RUNE_CANTRIPS,
    CANTRIP_SOURCES,
    ACTION_PATCHES,
    UNIVERSAL_PATCHES,
    PATCH_DEFS,
    UNIVERSAL_DEFS,
    HOOK_OVERRIDES,
    reprepareActors,
    installAffixTrainingFix,
    /** 让 N10 的上游 guard 重新检测一次（测试用；正常运行时缓存一次即可） */
    resetTurnsGuard() { _rejectsTurns = null; },
    /** 自检：把每个补丁当前的实际状态打印出来 */
    diagnose(actor) {
      actor ??= canvas?.tokens?.controlled?.[0]?.actor ?? game.user?.character;
      const out = { module: MODULE_ID, actor: actor?.name ?? null, patches: {} };
      const A = globalThis.crucible?.api?.models?.CrucibleAction;
      out.patches.testsWrapped = !!A?.prototype?._tests?.__tempfixPatched;
      out.patches.actorHooksWrapped = !!CONFIG.Actor.documentClass.prototype.callActorHooks.__tempfixPatched;
      out.patches.active = Object.keys(ACTION_PATCHES);
      out.patches.universal = UNIVERSAL_PATCHES.length ? ["turnsDuration"] : [];
      out.patches.hookOverrides = HOOK_OVERRIDES.map(o => {
        const fn = globalThis.crucible?.api?.hooks?.[o.type]?.[o.id]?.[o.hook];
        return `${o.type}.${o.id}.${o.hook}=${fn?.__tempfixOverride ? "已覆盖" : "未覆盖"}`;
      });
      out.patches.cantripsCached = Object.keys(CANTRIP_SOURCES);
      if ( actor ) {
        const bite = actor.actions?.suddenBite;
        if ( bite ) out.suddenBite = { minimum: bite.range.minimum, maximum: bite.range.maximum };
        const rr = actor.actions?.mayisRestorativeRedirection;
        if ( rr ) out.restorativeRedirection = {
          tags: Array.from(rr.tags),
          resource: rr.usage.resource,
          ability: rr.usage.bonuses.ability,
          // 这两项应当保持 ember 原样（false / 未设）—— 若为 true 说明旧的 P4 补丁又回来了
          hasDice: rr.usage.hasDice,
          restoration: rr.usage.restoration
        };
        const gaze = actor.actions?.bewilderingGaze;
        if ( gaze ) out.bewilderingGaze = { tags: Array.from(gaze.tags), defenseType: gaze.usage.defenseType };
        const spark = actor.actions?.heartSparkOfEmber;
        if ( spark ) out.heartSparkOfEmber = { scope: spark.target.scope };
        const stone = actor.actions?.antigravityStone;
        if ( stone ) out.antigravityStone = { type: stone.target.type };
        for ( const cfg of Object.values(RUNE_CANTRIPS) ) {
          if ( actor.actions?.[cfg.actionId] ) (out.cantrips ??= []).push(cfg.actionId);
        }
        out.training = foundry.utils.deepClone(actor.system?.training ?? {});
        const w = actor.equipment?.weapons;
        if ( w ) out.weapons = ["mainhand", "offhand"].reduce((o, k) => {
          const it = w[k];
          if ( it ) o[k] = {
            name: it.name, id: it.id,
            sourceSlot: it.system?._source?.slot ?? it.toObject?.().system?.slot,
            derivedSlot: it.system?.slot
          };
          return o;
        }, {});
      }
      console.log(out);
      return out;
    }
  };

  log(`已就绪。控制台自检：emberCrucibleTempFix.diagnose()`);
});
