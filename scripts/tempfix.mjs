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
        // 只有这一条路。曾经还写过一条「从 ev.resources 里找 restoration===false 的」兜底，
        // 但序列化后的 resources 条目**根本没有 restoration 键**，那条恒为假 ——
        // 留着会让人以为有两层保险，实际只有一层。取不到就退回 health。
        const res = roll?.data?.damage?.resource;
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
  // 天赋侧的 HOOK_OVERRIDES 有 guard，动作侧原来没有 —— 那样 ember 修好 id 之后
  // 两侧会朝**相反方向**退让：天赋侧回到新 id、动作侧仍写我们的 id，
  // 结果标记挂上了但「收割 +2 专注」永远查不到。两侧的 guard 必须认同一个特征串。
  __guard: [ABYSS_MARK_ID_BAD],
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
  setting: "patchAbyssMark",
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
 * **本模块目前影响面最大的一条**：38 个动作、九个血统的招牌变身，效果从来没落地过。
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
 * 受影响面（本机 crucible + ember 全部 packs 深扫，按**不同动作 id** 去重）：**38 个**。
 * ⚠ 这个数早先写的是 19，是**漏数**：当时只统计了未迁移的 `{turns:N}` 旧形，
 * 漏掉了两类 ——（a）已经迁成 `units:"turns"` 的新形（`shieldBash`、`steamVent`），
 * （b）**冒险/预生成包里 actor 内嵌物品**上的副本，它们不是「重复」而是玩家真会用到的独立实例。
 *
 *  - ember 侧 32 个。九个血统的招牌能力全在里面：Altyra 雷法姆变身、Cor'ak 结晶创伤、
 *    Fej 极限代谢、Hulg'run 活石、Kivahr 律动、Thornling 荆棘皮、Vrjnhar 顽强、
 *    Wirrun 不懈猎手、Zeph 三张面具；敌手动作 abyssalWhispers / bewilderingGaze /
 *    frenziedClaws / searingStare / sentinelShielding 等；
 *    以及一批消耗品 alchemicalGrenade / frostFlask / electroAmpoule / cosmicGem×3。
 *  - **crucible 自己的内容 7 个**：devourThoughts、mindFlay、eldritchEmanation、
 *    ferociousHowl、pestilentLash、shieldBash、steamVent。
 *    也就是说这不是「ember 数据配 crucible 校验」的接缝问题，crucible 单机也踩。
 *
 * 另有 22 个同样坏掉的效果写在**物品文档自己的 `effects[]`** 上，走不到 `preActivate`——
 * 那一半由 {@link PROTOTYPE_PATCHES} 里的 **N12** 补，两者共用 `patchTurnsDuration` 开关。
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
  // 本条**整体顶掉** ember 的同名 preActivate。ember 一旦改写它，我们会静默继续跑旧逻辑
  // ——不报警也不退让，玩家看到「加值又不对了」而控制台一个字都没有。那正是 P4 的形状。
  __guard: ["defenses.armor.bonus"],
  preActivate() {
    const e = this.effects?.[0];
    if ( !e?.system ) return;                    // 上游改了 schema 就别动
    e.system.changes = [{ key: "system.defenses.armor.bonus", value: 3, type: "add" }];
  }
};

ACTION_PATCHES.tyraphicTransformation = {
  __guard: ["resistances.radiant"],
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
 *
 * ⚠ 补的是**实现**，不是**数值** —— 这点值得说清楚，因为它决定了本条的可信度：
 * 掷出来的每一项修正都来自动作自己的标签，没有一个数是我编的。
 *  - `reflex` → `usage.defenseType = "reflex"`（`:4519`）
 *  - `corruption` → 伤害类型（伤害类型标签由 `:161` 的注册表批量生成）
 *  - `toughness` → `usage.bonuses.ability = actor.getAbilityBonus(["toughness"])`（`:4671` 的循环）
 *  - `weakened` → `usage.bonuses.damageBonus -= 6`（`:4473`）
 * `generic.roll()`（`:4323`）把这四项原样读走。唯一没有作者授权来源的是 `bonuses.base`，
 * 它取 `?? 0` —— 也就是没有基础伤害，全部伤害来自命中溢出。
 * 注意 `abyssalRemains` **连 scaling 标签都没有**（tags 只有 weakened/reflex/corruption），
 * 所以它的 ability 加值是 0，打出来会明显偏弱。这是数据本身如此，不是本补丁削的。
 *
 * 覆盖面是**扫出来的**而不是碰上的：把 crucible 与 ember 两侧 packs 全部 409 条动作过了一遍，
 * 先按 `propagate` 求闭包（`natural`→`melee`→`strike` 这种链会补上掷骰实现，
 * 不求闭包会误报 13 条），再挑「带防御标签且闭包后仍无任何 roll 提供者」的。
 * 结果**只有三条**：本条这两个，加上 ember 的 `waterAversion`（Fej 血统）。
 * 第三条**故意不修** —— 它自己的描述里写着「ALPHA ONE: This action needs further balancing」，
 * 是作者挂着的半成品，不是漏了实现；而且它 `target.type` 是 `self`，
 * 下面的归属判据本来也拦得住。
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
    // ⚠ **故意不还原**。还原成坏值会让本次会话里已经被吞下去的目标再也放不出来
    //   （「反刍」按坏 id 查，查不到 → token 保持 hidden）。而坏值本来就是非法的、
    //   留着合法 id 不会造成任何伤害。要真回到上游原样，停用模块并刷新即可。
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
/*  B 系列：从上游开发版回搬的修复                   */
/* -------------------------------------------- */

/**
 * 「回搬」与前面所有补丁方向相反：上游 `master` 已经修好、但**还没发布**的 bug，
 * 我们先搬给还在 0.10.1 的人用。（0.10.2 至今未发。）
 *
 * ⚠ **不照抄上游代码。** crucible 的 LICENSE 明写
 * 「No permission is granted at this time to modify, publish, distribute, sell,
 * or otherwise use the software or its data in any other way.」
 * 所以这里全部用**包装**实现——读上游 diff 弄懂它修了什么，然后用自己的代码达到同样效果。
 * 需要整段照抄才能修的（如 `798a8638` 的 `rollSkill`）**一律不做**，记在 README 里。
 *
 * 每条都必须先回答「0.10.1 到底有没有这个 bug」——上游有些 commit 修的是
 * 未发布代码自己引入的回归，那种搬过来是无中生有。已按此筛掉 `33bc14ff`
 * （它修的是 `6b5551d6` 引入的回归，0.10.1 编译产物里 `ownedRef` 零命中）。
 *
 * @type {Array<{label: string, resolve: Function, method: string,
 *   guard?: {method: string, includes: string}, setting: string, wrap: Function}>}
 */
const PROTOTYPE_PATCHES = [];

/**
 * 包装任意类的原型方法。与 `HOOK_OVERRIDES` 的区别：那个换的是钩子注册表里的条目，
 * 这个换的是类原型上的方法（数据模型、自定义元素、角色卡都靠它）。
 *
 * `guard` 检的是**上游实现的源码特征串**——上游一改就跳过，不带着过期假设跑。
 * 开关是在**包装体内部**实时读的，所以关掉开关立刻回到原实现，不需要卸载。
 * @returns {boolean}
 */
function installPrototypePatches() {
  for ( const p of PROTOTYPE_PATCHES ) {
    let target = null;
    try { target = p.resolve(); } catch { /* 结构变了 */ }
    const proto = target?.prototype;
    const orig = proto?.[p.method];
    if ( !(orig instanceof Function) ) { warn(`跳过 ${p.label}：找不到 ${p.method}`); continue; }
    if ( orig.__tempfixPatched ) continue;

    if ( p.guard ) {
      // ⚠ 必须读**原始**实现的源码。同一个类可能有多条补丁，若 guard 指向的方法
      //   已经被我们前面那条包过，`String(fn)` 读到的是包装体，特征串必然找不到 ——
      //   于是后面的补丁被自己人挡在门外。（这个坑是变异测试之外由 B2 实测抓出来的。）
      const guardFn = proto[p.guard.method];
      const src = String(guardFn?.__tempfixOriginal ?? guardFn ?? "");
      if ( !src.includes(p.guard.includes) ) {
        warn(`跳过 ${p.label}：上游实现已变，自动退让`);
        continue;
      }
    }
    const patched = p.wrap(orig, p.setting);
    patched.__tempfixPatched = true;
    patched.__tempfixOriginal = orig;
    proto[p.method] = patched;
    log(`已包装 ${p.label}`);
  }
  return true;
}

/** init 里实际注册过的设置键；用来断言中央表/补丁表里没有写错的死键 */
const REGISTERED_SETTINGS = new Set();

/**
 * 注册时顺手记下的开关目录（键 / 显示名 / 提示 / 组号）。
 * 控制面板拿它渲染清单 —— 与设置面板**同一个真源**，不会两边说法不一致。
 * @type {Array<{key: string, name: string, hint: string, group: string}>}
 */
const SETTING_CATALOG = [];

/** 组号 → 组名。与 init 里 bool() 名称的首字符对应。 */
const SETTING_GROUPS = {
  "①": "影响最大 —— 效果根本没被创建",
  "②": "动作放不出去 / 点了什么都不发生",
  "③": "能用，但结算错了",
  "④": "回搬自上游开发版（上游发 0.10.2 后自动停用）",
  "⑤": "显示与界面"
};

/**
 * 版本上限的**中央表**：设置键 → 上游哪个版本修好了它。
 *
 * 放中央表而不是各自挂在补丁上，是因为版本闸门此前只作用于 `PATCH_DEFS` / `UNIVERSAL_DEFS`，
 * **对 10 条 `PROTOTYPE_PATCHES` 完全不生效** —— 而 B 系列（回搬自上游开发版、
 * 上游一发布就该退休的那五条）恰恰全是原型补丁。中央表让三类补丁走同一条判定。
 *
 * B1–B5 全部来自 crucible `master` 已合并、但 0.10.1 未包含的修复，
 * 因此填 `0.10.2`（下一个发布版）。0.10.2 至今未发，所以现在全部空转。
 * @type {Record<string, {fixedIn?: string, fixedInEmber?: string}>}
 */
const VERSION_CEILINGS = {
  patchEnchantmentBonus: { fixedIn: "0.10.2" },   // B1/B2 上游 bea623d8
  patchCurrencyPopout:   { fixedIn: "0.10.2" },   // B3   上游 1659465a
  patchSkillDialogSwap:  { fixedIn: "0.10.2" },   // B4   上游 798a8638
  patchFeaturedEquipment:{ fixedIn: "0.10.2" }    // B5   上游 ac1b5cfc
};

/** 包装体内部实时读开关（关掉即刻回到上游原行为），并顺带受版本上限约束 */
const settingOn = key => {
  // 失败方向**保守生效**——与模块其余闸门一致。设置在 init（:1742 起）全部注册完，
  // 而这里最早的调用点在 setup 之后，所以正常路径读不到的情况不存在；
  // 但真出现时「继续打补丁」比「静默全关」更符合本模块的声明。
  let on = true;
  try { on = game.settings.get(MODULE_ID, key); } catch { /* 未注册 → 保守生效 */ }
  return on && !ceilingReached(key);
};

/**
 * N12 —— N10 的**另一半**：不是由动作产出的效果，`preActivate` 够不着。
 *
 * N10 在 `preActivate` 里改 `this.effects[*].duration`，管的是「动作使用时现场生成的效果」。
 * 但同样一批坏数据还写在**物品文档自己的 `effects[]`** 上，它们的创建根本不经过动作：
 * 物品被角色持有时 `transfer:true` 的效果直接创建、GM 手动拖效果、宏里 `createEmbeddedDocuments`
 * ——这几条路 N10 一条都拦不到。全包深扫（409 条动作之外另算）在 `items[].effects[]` 上
 * 找到 **22 个** `units:"turns"` 效果，其中 `crucible-adventure` 包（真正会进 crucible 世界的那个）
 * 占 6 个，最扎眼的是 Mythspire Guardian 的「Nearing Death」——它是 `transfer:true`，
 * 意味着这个天赋**一被持有就该生效，实际上永远建不出来**。
 *
 * ⚠ 为什么必须包 `_preCreate` 而不是挂 `preCreateActiveEffect` 钩子：
 * 核心的创建流程（`foundry.mjs:80806-80808`）是
 *   `documentAllowed = await doc._preCreate(...) ?? true;`
 *   `documentAllowed &&= (noHook || Hooks.call("preCreateActiveEffect", ...));`
 * ——`_preCreate` **先**跑，crucible 的拒绝就在它里面（`:39581` 返回 `false`）；
 * 而 `&&=` 在左边已经是 `false` 时**根本不会调用**右边的钩子。
 * 也就是说钩子写了也白写，只能包原型方法抢在 `:39581` 之前把单位改掉。
 *
 * 与 N10 共用一个开关：同一个缺陷的两条路径，分开关反而容易只开一半。
 */
PROTOTYPE_PATCHES.push({
  label: "CrucibleActiveEffect#_preCreate（N12 物品自带效果的 turns 时长）",
  setting: "patchTurnsDuration",
  resolve: () => CONFIG.ActiveEffect?.documentClass,
  method: "_preCreate",
  // 上游一旦放宽这个限制，特征串消失 → 自动退让。与 systemRejectsTurns() 读的是同一处。
  guard: { method: "_preCreate", includes: '["months", "turns"].includes(this.duration.units)' },
  wrap: (orig, setting) => async function _preCreate(...args) {
    if ( settingOn(setting) && (this.duration?.units === "turns") ) {
      // expiry 映射与 N10 一致（上游 48bf4391f7 的 49/49）；已有 expiry 就不动。
      this.updateSource({ duration: { units: "rounds", expiry: this.duration.expiry ?? "turnEnd" } });
    }
    return orig.apply(this, args);
  }
});

/**
 * B1 + B2（上游 `bea623d8`，修 issue #1378 与 #1396）：
 * **词缀推导出来的附魔等级完全不生效。**
 *
 * 根因是**算得太早**。0.10.1 在 `prepareBaseData` 里就把附魔加值算死：
 *  - 武器 `:45092` `this.actionBonuses = {ability: 0, skill: -4, enchantment: enchantment.bonus};`
 *  - 护甲 `:44225` `this.dodge.base = category.dodge.base(this.armor.base) + enchantment.bonus;`
 *
 * 而**词缀**要到派生阶段才解析完，所以 base 阶段读到的 `config.enchantment` 是词缀生效**之前**的值。
 * 上游的修法就是把这两处挪进 `prepareDerivedData`。
 *
 * 玩家看到的：给武器加词缀后，物品卡上附魔等级显示正确，但拿它攻击时**掷骰里没有附魔加值**；
 * 手动把附魔等级改成同一档就有了。护甲那面是闪避防御不涨。
 *
 * 我们的做法（不照抄，用包装达到同效果）：
 *  - 武器：派生阶段结束后把 `actionBonuses.enchantment` **覆写**成此刻的真值（幂等）。
 *  - 护甲：base 阶段先记下它用了哪个值，派生阶段结束后按**差额**修正 `dodge.base`
 *    （不能直接覆写——base 里那一项和 `category.dodge.base(armor.base)` 加在了一起）。
 */
PROTOTYPE_PATCHES.push({
  label: "CrucibleWeaponItem#prepareDerivedData（B1 附魔加值）",
  setting: "patchEnchantmentBonus",
  resolve: () => CONFIG.Item?.dataModels?.weapon,
  method: "prepareDerivedData",
  guard: { method: "prepareBaseData", includes: "enchantment: enchantment.bonus" },
  wrap: (orig, setting) => function prepareDerivedData(...args) {
    const r = orig.apply(this, args);
    if ( settingOn(setting) && this.actionBonuses ) {
      const fresh = this.config?.enchantment?.bonus;
      if ( Number.isFinite(fresh) ) this.actionBonuses.enchantment = fresh;
    }
    return r;
  }
});

PROTOTYPE_PATCHES.push({
  label: "CrucibleArmorItem#prepareBaseData（B2 记录 base 用的附魔值）",
  setting: "patchEnchantmentBonus",
  resolve: () => CONFIG.Item?.dataModels?.armor,
  method: "prepareBaseData",
  guard: { method: "prepareBaseData", includes: "category.dodge.base(this.armor.base) + enchantment.bonus" },
  wrap: (orig, setting) => function prepareBaseData(...args) {
    const r = orig.apply(this, args);
    if ( settingOn(setting) ) {
      this.__tempfixBaseEnchantment = this.config?.enchantment?.bonus ?? 0;
      this.__tempfixDodgeFixed = false;   // 新的一轮准备，差额还没补
    }
    return r;
  }
});

PROTOTYPE_PATCHES.push({
  label: "CrucibleArmorItem#prepareDerivedData（B2 按差额修正闪避）",
  setting: "patchEnchantmentBonus",
  resolve: () => CONFIG.Item?.dataModels?.armor,
  method: "prepareDerivedData",
  guard: { method: "prepareBaseData", includes: "category.dodge.base(this.armor.base) + enchantment.bonus" },
  wrap: (orig, setting) => function prepareDerivedData(...args) {
    const r = orig.apply(this, args);
    if ( settingOn(setting) && this.dodge ) {
      const fresh = this.config?.enchantment?.bonus;
      const stale = this.__tempfixBaseEnchantment;
      // 幂等：真实流程里 base 每轮都会重算 dodge.base，但万一 derived 被单独调用两次，
      // 差额不能加两遍。base 那一侧负责把标记清掉。
      if ( !this.__tempfixDodgeFixed && Number.isFinite(fresh) && Number.isFinite(stale) && (fresh !== stale) ) {
        this.dodge.base += (fresh - stale);
        this.__tempfixDodgeFixed = true;
      }
    }
    return r;
  }
});

/**
 * B3（上游 `1659465a`，修 issue #1379）：**把角色卡弹成独立窗口后货币归零。**
 *
 * `HTMLCrucibleCurrencyElement._buildElements()`（`:7523-7527`）开头两行是
 * `this._value = Number(this.getAttribute("value") || 0);` 紧接着 `this.removeAttribute("value")`。
 * 属性一被删掉，元素被搬进另一个 document（弹窗）重新连接时就只能读回 **0**。
 * 报告人补充「一旦货币被改动就自己好了」——因为重渲染会走 `create()` 重新写上属性。
 *
 * 上游的修法是把 `removeAttribute` 换成 `setAttribute`，并在改值后同步属性。
 * 我们不动原方法，改为：原方法跑完之后把属性写回去；再挂一个 `change` 监听器保持同步
 * （改值那段在私有方法 `#onChangeInput` 里，包不到，但它会 `dispatchEvent` 一个冒泡的 change）。
 */
PROTOTYPE_PATCHES.push({
  label: "HTMLCrucibleCurrencyElement#_buildElements（B3 弹窗货币归零）",
  setting: "patchCurrencyPopout",
  resolve: () => globalThis.crucible?.api?.applications?.elements?.HTMLCrucibleCurrencyElement,
  method: "_buildElements",
  guard: { method: "_buildElements", includes: 'removeAttribute("value")' },
  wrap: (orig, setting) => function _buildElements(...args) {
    const r = orig.apply(this, args);
    if ( settingOn(setting) ) {
      const v = Number(this._value) || 0;
      this.setAttribute("value", String(v));
      if ( !this.__tempfixCurrencySync ) {
        this.__tempfixCurrencySync = true;
        this.addEventListener("change", () => {
          this.setAttribute("value", String(Number(this._value) || 0));
        });
      }
    }
    return r;
  }
});

/* -------------------------------------------- */
/*  I 系列：上游还没修的开放 issue                  */
/* -------------------------------------------- */

/**
 * I1（上游 issue **#1403**）：**Wild Strike 在没有天生武器时仍然可用，而且能白刷行动点。**
 *
 * `natural` 标签的 canUse（`:4273`）是
 * `if ( !this.usage.strikes.every(w => w.system.properties.has("natural")) ) throw ...`
 * —— `strikes` 是**空数组**时 `every` 返回 **true**，判据真空通过。
 *
 * 于是没有天生武器的角色点 Wild Strike：动作显示可用、点得动、生成聊天卡，
 * 但**一次骰都不掷、一点伤害都不出**，反而把行动点退还回来 —— 等于无本万利的行动点发生器。
 *
 * 上游 `crucible.api.hooks.action.wildStrike`（`:11051`）**只定义了 `acquireTargets`**，
 * 所以补一个 `canUse` 是纯追加，顶不掉任何东西。
 */
ACTION_PATCHES.wildStrike = {
  canUse() {
    if ( !this.tags.has("natural") ) return;              // 归属判据
    const strikes = this.usage?.strikes;
    if ( !Array.isArray(strikes) || strikes.length ) return;   // 上游修好、或本来就有天生武器
    throw new Error(game.i18n.localize("ACTION.WARNINGS.RequiresNatural"));
  }
};

/**
 * I2（上游 issue **#1412**）：**`hasKnowledge` 只认背景给的那一份知识。**
 *
 * `:36914` 整个函数体是
 * `return this.system.details.background.knowledge.has(knowledgeId);` ——
 * 读的是**背景条目自己那份快照**。而角色实际的知识聚合在 `system.details.knowledge`
 * （schema `:43018`，与 `details.languages` 并列；角色卡的编辑入口 `#onEditDetailsProperty`
 * `:15597` 写的也是 `system.details.<property>`，数据准备时会把背景那份并进来）。
 *
 * 后果不只是气泡：GM 手工给角色加的知识，在 Assess Strength / Intuit Weakness 里
 * **本该拿到的 +2 祝福不会出现**，玩家只会觉得「这知识加了好像没用」。
 *
 * 修法是**整体替换**（原函数只有两行，逻辑简单到不构成照抄）：改读聚合值，
 * 读不到再退回上游原来的那份，保证只增不减。
 */
PROTOTYPE_PATCHES.push({
  label: "CrucibleActor#hasKnowledge（I2 只认背景知识）",
  setting: "patchHasKnowledge",
  resolve: () => CONFIG.Actor?.documentClass,
  method: "hasKnowledge",
  guard: { method: "hasKnowledge", includes: "details.background.knowledge" },
  wrap: (orig, setting) => function hasKnowledge(knowledgeId) {
    if ( !settingOn(setting) ) return orig.call(this, knowledgeId);
    if ( this.type !== "hero" ) return false;              // 与上游一致
    const all = this.system?.details?.knowledge;
    if ( all?.has instanceof Function ) return all.has(knowledgeId);
    return orig.call(this, knowledgeId);                   // 读不到聚合值 → 退回上游行为
  }
});

/**
 * I3（上游 issue **#1406**）：**「私密传记」对只有 limited/observer 权限的用户照样渲染。**
 *
 * `CrucibleBaseActorSheet#_prepareContext`（`:14599`）无条件 `biography: await this.#prepareBiography()`，
 * 而 `#prepareBiography()`（`:14663`）把 `privateField` / `privateSrc` / `privateHTML`
 * **无条件**塞进上下文 —— 没有任何权限判断（那句 `secrets: this.document.isOwner` 只管
 * 富文本里的 secret 块，管不到 private 字段本身）。
 *
 * GM 把 NPC 权限设成 limited 好让玩家查基本信息，玩家切到「传记」页就能**原文读到 GM 私记**
 * —— 身份反转、隐藏动机、剧透。tooltip 上写着「仅拥有者可见」，实现没兑现。
 *
 * 修法：包装 `_prepareContext`，非拥有者时把 private 三件套抹掉。
 * 这是**只减不增**的改动，最坏情况是拥有者也看不到（那会立刻被发现），不会造成新的泄漏。
 */
PROTOTYPE_PATCHES.push({
  label: "CrucibleBaseActorSheet#_prepareContext（I3 私密传记泄漏）",
  setting: "patchPrivateBiography",
  resolve: () => globalThis.crucible?.api?.applications?.CrucibleBaseActorSheet,
  method: "_prepareContext",
  wrap: (orig, setting) => async function _prepareContext(...args) {
    const context = await orig.apply(this, args);

    // I3：非拥有者不该看到私密传记
    // ⚠ 不要把 `privateField` 置为 null —— 模板拿它去渲染表单控件，null 会让非拥有者
    //   每次渲染刷一条 console.error，并在传记页底部留一个没有标题的空折叠条。
    //   控制台噪声本身就是我们要清掉的东西（它会污染「无未捕获异常」这条验收标准）。
    //   正确做法是把这几个键**整个删掉**，模板取不到就不渲染那一段。
    if ( settingOn(setting) ) {
      const bio = context?.biography;
      if ( bio && !this.document?.isOwner ) {
        delete bio.privateField;
        delete bio.privateSrc;
        delete bio.privateHTML;
        delete bio.privateClass;
      }
    }

    // B5（上游 ac1b5cfc）：侧栏「精选装备」的天生武器循环上界写成 `i < 3 - featuredEquipment.length`，
    // 而每 push 一件上界就缩一格 —— 多爪多牙的怪物最多只列得出 1 件天生武器。
    // 纯显示层：动作列表里那些打击照常在，命中与伤害不受影响。
    // 这里在上游填完之后**补齐到 3 件**，顺序与上游一致（主手 → 副手 → 天生）。
    // ⚠ 那个「3」是**武器**预算，而**护甲是追加在数组末尾的**（`:14782`）——
    //   所以不能拿 `fe.length` 去比 3：护甲会占掉一格，导致所有有护甲行的角色 100% 空转。
    //   要按「非护甲条目」计数，并把补的天生武器插在护甲**之前**。
    if ( settingOn("patchFeaturedEquipment") ) {
      const fe = context?.featuredEquipment;
      const equipment = this.document?.equipment;
      const natural = equipment?.weapons?.natural;
      if ( Array.isArray(fe) && Array.isArray(natural) ) {
        const armorUuid = equipment?.armor?.uuid;
        const armorAt = armorUuid ? fe.findIndex(e => e.uuid === armorUuid) : -1;
        let weaponCount = fe.length - (armorAt >= 0 ? 1 : 0);
        const listed = new Set(fe.map(e => e.uuid));
        let insertAt = (armorAt >= 0) ? armorAt : fe.length;
        for ( const n of natural ) {
          if ( weaponCount >= 3 ) break;
          if ( listed.has(n.uuid) ) continue;
          const tags = n.getTags?.("short") ?? {};
          fe.splice(insertAt, 0, { name: n.name, type: n.type, uuid: n.uuid, img: n.img, tags: [tags.damage, tags.range] });
          insertAt++; weaponCount++;
        }
      }
    }
    return context;
  }
});

/**
 * B4（上游 `798a8638`）：**掷骰对话框里换了技能，实际掷的还是默认那个。**
 *
 * `rollSkill`（`:36937`）把 `check` 声明成 `const`，对话框返回的 `response`
 * 只用来判断「有没有取消」（`if (response === null) return null;`），**返回值本身被丢掉了**。
 * 于是多技能团队检定里玩家在对话框里换成另一项技能，掷的仍然是默认那一项。
 *
 * 触发面只有一条路径：`GroupCheck` 走 `rollSkill(undefined, {dialog: {…, skills}})`，
 * 而 `skillId ??= Object.keys(skills)[0]` 取的是第一项。单技能检定不受影响。
 *
 * 这一条**整体替换**（其余回搬全是包装）。理由是修改点在函数中段，包装够不着 `check` 这个局部量。
 * 闸门认的是**有 bug 的那一句原文** `const check = this.getSkillCheck` ——
 * 上游的修法正是把它改成 `let check`，所以上游一发布，闸门立刻失配、本条自动退休。
 */
PROTOTYPE_PATCHES.push({
  label: "CrucibleActor#rollSkill（B4 对话框换技能被丢弃）",
  setting: "patchSkillDialogSwap",
  resolve: () => CONFIG.Actor?.documentClass,
  method: "rollSkill",
  guard: { method: "rollSkill", includes: "const check = this.getSkillCheck" },
  wrap: (orig, setting) => async function rollSkill(skillId, options = {}) {
    if ( !settingOn(setting) ) return orig.call(this, skillId, options);
    let { banes = 0, boons = 0, dc, messageMode, dialog, chatMessage = false } = options;
    if ( dialog === true ) dialog = {};

    const skills = dialog?.skills;
    if ( skills ) {
      skillId ??= Object.keys(skills)[0];
      dc ??= skills[skillId].dc;
    }
    let check = this.getSkillCheck(skillId, { banes, boons, dc, passive: false });
    if ( messageMode ) check.data.messageMode = messageMode;
    const label = id => globalThis.SYSTEM?.SKILLS?.[id]?.label ?? id;
    let flavor = game.i18n.format("ACTION.SkillCheck", { skill: label(skillId) });

    if ( dialog ) {
      const { title, configurable = true } = dialog;
      const dialogOptions = { flavor, messageMode, title, configurable };
      if ( skills && (Object.keys(skills).length > 1) ) dialogOptions.skills = skills;
      const response = await check.dialog(dialogOptions);
      if ( response === null ) return null;
      // ↓ 这三行就是上游 798a8638 补的：采纳对话框返回的那一份
      check = response;
      skillId = check.data.type;
      flavor = game.i18n.format("ACTION.SkillCheck", { skill: label(skillId) });
    }

    await check.evaluate({ allowInteractive: check.data.messageMode !== "blind" });
    if ( chatMessage ) await check.toMessage({ flavor, flags: { crucible: { skill: skillId } } });
    return check;
  }
});

/**
 * I4（上游 issue **#1404**）：**位移类动作重复 prepare()，标签加成被累加。**
 *
 * `_configureUsage()`（`:20283`）的注释白纸黑字写着
 * 「Reset cost fields to their source values so that **repeated prepare() calls do not accumulate costs**」，
 * 但它**只重置了 cost**（action/focus/heroism/hands）。`usage.bonuses` 里
 * `damageBonus` / `multiplier` / `criticalSuccessThreshold` / `enchantment` 一个都没碰
 * （只有 `ability` 与 `skill` 被无条件重算，`:20297`）。
 *
 * 而 `usage.bonuses` 的归零**只发生在 `_prepareData()`**（`:19107` 的 Reset bonuses 块），
 * 那个方法只由 `_initialize()` 调用，`prepare()` 自己不调。
 *
 * 于是遇上 `empowered` 这种累加写法（`:4432` `damageBonus += 6`），
 * 位移规划流程里的第二次 `prepare()`（`:3085`）就把加成叠了一遍 ——
 * 飞踢的伤害比条目描述**多 6 点**；如果规划出的路径非法，还会
 * `delete this.action.movement; this.action.prepare();`（`:3096`）再叠一次，变成 **+18**。
 *
 * 修法：包 `prepare()`，在委托给原实现**之前**把 `usage.bonuses` 恢复成
 * `_prepareData()` 里那份「原始态」—— 六个字段逐字对齐上游自己的归零块，不多不少。
 * 第一次 prepare 时它是空操作（本来就是零），从第二次起才起作用。
 */
const PRISTINE_BONUSES = Object.freeze({
  ability: 0, skill: 0, enchantment: 0, damageBonus: 0, multiplier: 1, criticalSuccessThreshold: 0
});

PROTOTYPE_PATCHES.push({
  label: "CrucibleAction#prepare（I4 重复 prepare 累加加成）",
  setting: "patchRepeatedPrepare",
  resolve: () => globalThis.crucible?.api?.models?.CrucibleAction,
  method: "prepare",
  // 闸门认上游那句注释：它一旦把 bonuses 也放进重置块，注释多半会跟着改，本条自动退让
  guard: { method: "_configureUsage", includes: "do not accumulate costs" },
  wrap: (orig, setting) => function prepare(...args) {
    if ( settingOn(setting) && this.usage?.bonuses ) Object.assign(this.usage.bonuses, PRISTINE_BONUSES);
    return orig.apply(this, args);
  }
});

/**
 * E1：**「稳定护佑」的酸性抗性算成 `NaN`。**
 *
 * `ember.crucible-effects > wardOfStabilizat` 的唯一一条 change 是
 * `{key: "system.resistances.acid", type: "add", value: 5}` —— **少了 `.bonus`**。
 *
 * 而抗性的 schema（`:40972`）是
 * `resistances: SchemaField({<damageType>: SchemaField({bonus, immune})})` ——
 * `system.resistances.acid` **本身是一个 SchemaField**，不是数字。
 * 往 SchemaField 上做 "add"，派生出来的整个抗性对象被打坏，总值变 `NaN`，
 * 此后每一次酸性伤害结算都带着 NaN 传播（伤害数字变 NaN、聊天卡伤害栏是空的）。
 *
 * 同 pack 的对照：`luminousCrystal0` 三条、`bewilderment0001` 一条，
 * 全部规规矩矩写 `system.resistances.<type>.bonus`。
 * 实测该 pack 26 篇文档里 14 篇带 changes，**落在 `system.resistances.<type>` 这一层的只有它一条**。
 *
 * 修法：在效果的数据准备阶段把 key 补成 `.bonus`。
 * 归属判据严格：只认 `^system\.resistances\.<已知伤害类型>$`，不认识的一律不碰；
 * ember 哪天把 key 补对了，正则就不再匹配，补丁自动空转。
 */
PROTOTYPE_PATCHES.push({
  label: "CrucibleActiveEffect#prepareBaseData（E1 抗性 change 少了 .bonus）",
  setting: "patchResistanceChangeKey",
  resolve: () => CONFIG.ActiveEffect?.documentClass,
  method: "prepareBaseData",
  wrap: (orig, setting) => function prepareBaseData(...args) {
    const r = orig.apply(this, args);
    if ( !settingOn(setting) ) return r;
    const changes = this.system?.changes ?? this.changes;
    if ( !Array.isArray(changes) ) return r;
    const types = globalThis.SYSTEM?.DAMAGE_TYPES;
    for ( const c of changes ) {
      const m = /^system\.resistances\.([a-zA-Z]+)$/.exec(c?.key ?? "");
      if ( !m ) continue;                                  // 已经带 .bonus / 或压根不是抗性 → 不动
      if ( types && !(m[1] in types) ) continue;           // 不认识的伤害类型 → 不猜
      c.key = `${c.key}.bonus`;
    }
    return r;
  }
});

/**
 * E2：**ember 两处按「猜」出来的 id 查效果，而系统生成的是另一个 —— 查询永远落空。**
 *
 * 效果 id 由 `#recordEffectEvents`（`:19811`）`_id || getEffectId(this.id, {suffix: String(i)})` 生成，
 * 而 `getEffectId`（`:5358`）= `generateId(label, 16 - suffix.length) + suffix`，
 * `generateId`（`:48066`）是 `slice(length).padEnd(length, "0")`。**完全确定性**：
 *
 * | 动作 id | 系统实际生成 | ember 查的 |
 * |---|---|---|
 * | `implacableHunter` | `implacableHunte0` | `implacableHunter`（`ember.mjs:126089`） |
 * | `formidableStamina` | `formidableStami0` | `formidableStamin`（`ember.mjs:126067`） |
 *
 * 后果：Wirrun 血裔花 1 专注 + 1 英雄点标记猎物后，**朝猎物的攻击一次 +2 祝福都不会出现**；
 * Vrjnhar 血裔的「顽强体力」（行动点见底时退还 1 点）**从头到尾一次都不触发**。
 * 两条都是血裔的招牌能力，玩家只会以为自己记错了规则。
 *
 * 修法特意选了**轻的那一边**：ember 查的那两个串**本身就是合法的 16 位 id**，
 * 而这两个动作又**各只有一条效果**（index 0，无歧义）。
 * 所以不去替换 ember 的钩子（那要照抄几十行），而是把**写入端**的 `_id` 设成它要找的那个 ——
 * 两边自然对上，代码量十分之一。
 *
 * 闸门：ember 的钩子源码里必须还能看到那个坏查询串。它哪天改对了（改成真实 id 或改成动态计算），
 * 我们就不再强设 `_id`，系统照常生成真实 id，它自己的新查询也就能命中。
 */
const EFFECT_ID_ALIGNMENTS = [
  { actionId: "implacableHunter", effectId: "implacableHunter", talent: "emberWirrunLinea", hook: "prepareAttack" },
  { actionId: "formidableStamina", effectId: "formidableStamin", talent: "emberVrjnharLine", hook: "finalizeAction" }
];

for ( const a of EFFECT_ID_ALIGNMENTS ) {
  ACTION_PATCHES[a.actionId] = {
    preActivate() {
      const effect = this.effects?.[0];
      if ( !effect || effect._id ) return;                 // 上游自己设了 _id → 不插手
      // 闸门：ember 那边还在用坏查询串吗？
      const fn = globalThis.crucible?.api?.hooks?.talent?.[a.talent]?.[a.hook];
      if ( !(fn instanceof Function) ) return;
      if ( !String(fn).includes(`"${a.effectId}"`) ) return;   // ember 改对了 → 退让
      effect._id = a.effectId;
    }
  };
}

/**
 * I5（上游 issue **#1402**）：**玩家端的攻击卡只写 "DC"，看不到打的是哪条防御。**
 *
 * `AttackRoll#_prepareChatRenderContext`（`:3311`）其实**给所有人**都算好了防御名：
 *
 *   if ( defense ) cardData.defenseType = defense.shortLabel ?? defense.label;
 *   …
 *   if ( game.user.isGM ) cardData.targetLabel = `${cardData.defenseType} ${cardData.dc}`;
 *
 * 但模板渲染的是 `{{targetLabel}}`（`templates/dice/standard-check-chat.hbs:13`），
 * 而那一行**只给 GM 赋值** —— 非 GM 于是看不到防御类型。
 *
 * **防御类型本来就是公开信息**（条目描述里白纸黑字写着「攻击其反射」），
 * 该藏的只有 DC 数值。现在连类型一起被抹掉，纯属实现疏漏。
 *
 * 修法：非 GM 时把 `targetLabel` 补成**只有类型、不带数字**的形式 —— DC 仍然藏着。
 */
PROTOTYPE_PATCHES.push({
  label: "AttackRoll#_prepareChatRenderContext（I5 玩家端看不到防御类型）",
  setting: "patchDefenseTypeLabel",
  resolve: () => globalThis.crucible?.api?.dice?.AttackRoll,
  method: "_prepareChatRenderContext",
  guard: { method: "_prepareChatRenderContext", includes: "game.user.isGM" },
  wrap: (orig, setting) => async function _prepareChatRenderContext(...args) {
    const cardData = await orig.apply(this, args);
    if ( !settingOn(setting) ) return cardData;
    // 只在「上游没给赋值」时补，且只补类型 —— 绝不把 DC 泄漏给玩家
    if ( cardData && !cardData.targetLabel && cardData.defenseType ) {
      cardData.targetLabel = cardData.defenseType;
    }
    return cardData;
  }
});

/**
 * I6（上游 issue **#1311**）：**「可视化夹击」的叠层关不掉。**
 *
 * 工具的 `onChange`（`:47965`）只遍历 `canvas.tokens.controlled`：
 *
 *   for ( const token of globalThis.canvas.tokens.controlled ) {
 *     if ( active ) token._visualizeEngagement(token.engagement);
 *     else token._clearEngagementVisualization();
 *   }
 *
 * 于是换选之后，上一个 token 的多边形与方框就成了**孤儿** —— 钉死在画布上、不跟着任何东西动；
 * 再点一次开关也清不掉它（因为它已经不在 controlled 里了）。唯一解法是刷新页面。
 *
 * 修法：关闭时清**全部** token 而不只是选中的。这条不走 `PROTOTYPE_PATCHES` ——
 * 工具对象是在 `getSceneControlButtons` 钩子里现造的，包原型没用，得在同一个钩子里改它。
 */
function installFlankingToggleFix() {
  Hooks.on("getSceneControlButtons", controls => {
    let on = true;
    try { on = game.settings.get(MODULE_ID, "patchFlankingToggle"); } catch { /* 尚未注册 */ }
    if ( !on ) return;
    const tool = controls?.tokens?.tools?.debugFlanking;
    const orig = tool?.onChange;
    if ( !(orig instanceof Function) || orig.__tempfixPatched ) return;
    // 闸门：上游那句「只遍历 controlled」还在吗
    if ( !String(orig).includes("canvas.tokens.controlled") ) return;

    const patched = (event, active) => {
      const r = orig(event, active);
      if ( !active ) {
        // 上游只清了 controlled，把剩下的孤儿一并清掉
        for ( const token of globalThis.canvas?.tokens?.placeables ?? [] ) {
          try { token._clearEngagementVisualization?.(); } catch { /* 忽略单个 token 的失败 */ }
        }
      }
      return r;
    };
    patched.__tempfixPatched = true;
    patched.__tempfixOriginal = orig;
    tool.onChange = patched;
  });
  return true;
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
    // README 与 module.json 都承诺「每一项都能单独关掉」，此前这一条是例外。
    if ( o.setting && !settingOn(o.setting) ) continue;
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

  // 上游一旦给 CrucibleActor 补上 training getter（issue #1423 的正解），
  // ember 那句 `this.training[runeId]` 自己就能跑通，本条即退休。
  const actorProto = CONFIG.Actor?.documentClass?.prototype;
  if ( actorProto && ("training" in actorProto) ) {
    log("上游已补上 CrucibleActor#training，N11 自动停用");
    return false;
  }

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
  { setting: "patchDamageTypes", actionIds: ["noxiousSpray", "selfDestruct", "devourThoughts"] },
  { setting: "patchWildStrike", actionIds: ["wildStrike"] },
  { setting: "patchEffectIdAlignment", actionIds: ["implacableHunter", "formidableStamina"] }
];

/** actionId → 补丁体的原始引用（applyToggles 会按开关把它们放回/摘掉） */
const PATCH_BODIES = {};
for ( const { actionIds } of PATCH_DEFS ) {
  for ( const id of actionIds ) PATCH_BODIES[id] = ACTION_PATCHES[id];
}

/** 对每个动作都生效的补丁及其开关 */
/* -------------------------------------------- */
/*  I7：投掷武器下拉框列出扔不出去的武器（上游 issue #1288）  */
/* -------------------------------------------- */

/**
 * I7（上游 issue #1288）：「投掷武器」的下拉框把**扔不出去的**武器也列出来
 * —— 徒手、天生武器、以及任何 `canThrow` 为假的东西。
 *
 * 上游 issue 还提到第二个症状：**选了非法的那个再去用，这个动作从此点不动了，
 * 要重启会话或换装备才恢复。**
 *
 * 根因是一处**缺失**，不是写错。crucible 的每个「需求标签」都在自己的 `prepare()` 里
 * 把用不了的武器标成不可选 —— 这是上游自己确立的写法：
 *  - `melee`（`:4148`）  `if (c.item.config.category.ranged) c.viable = false;`
 *  - `ranged`（`:4177`） `if (!c.item.config.category.ranged) c.viable = false;`
 *  - `natural`（`:4279`）同一形状
 * 而 `thrown` 的 `prepare()`（`:4250-4253`）**只设了 range，一个字都没过滤**，
 * 尽管它的 `canUse()`（`:4246`）与 `preActivate()`（`:4257`）都对 `!canThrow` 抛错。
 * `_prepareWeaponChoices()`（`:20134`）把每一条都标 `viable: true` 出厂，
 * 注释明说「Requirement tags further restrict viability」—— 就差 `thrown` 没做。
 *
 * 本补丁按上游自己的形状把那个循环补上。
 *
 * 顺带把第二个症状一起解决了，理由能从代码上讲清楚：
 * `:4036` 是 `const locked = this.usage.weaponChoice ? choices.find(c => c.id === …)?.item : null;`
 * 而 `choices` 取自 `getValidWeaponChoices()`（`:20167`，只留 `viable`）。
 * 补上过滤之后，那个非法 id **在 choices 里找不到** ⇒ `locked` 为 null ⇒
 * 落到下面的 `choices.reduce(...)` 正常挑一把能扔的。也就是说：
 * 既进不去那个状态，已经进去了的下一次准备也会自动脱困。
 *
 * ⚠ 诚实边界：上游说的「要重启会话才恢复」我**没有复现过**，
 * 上面只是说明本补丁为什么让 `locked` 不再卡住 —— 如果卡死另有来源（比如卡在别处的缓存），
 * 本补丁不保证解决那一半。
 *
 * 为什么做成通用补丁而不是按 id：`thrown` 是**标签**，`throwWeapon`（`:4857`）不是唯一带它的动作
 * （装备包里的 `net` 也带）。按标签判、按上游语义走。
 * 通用补丁在 `_tests()` 里**最后**一格 yield，所以必然排在 `thrown.prepare` 之后 —— 正是需要的时机。
 */
const thrownChoicesPatch = {
  prepare() {
    if ( !this.tags?.has?.("thrown") ) return;                 // 归属判据
    const choices = this.usage?.weaponChoices;
    if ( !Array.isArray(choices) ) return;                     // 上游改了结构就别动
    // 上游哪天自己补上了这个过滤，这里就是空转（幂等：已经 false 的再设一次还是 false）
    for ( const c of choices ) {
      if ( c?.item && (c.item.system?.canThrow === false) ) c.viable = false;
    }
  }
};

const UNIVERSAL_DEFS = [
  { setting: "patchTurnsDuration", body: turnsDurationPatch },
  { setting: "patchThrowableOnly", body: thrownChoicesPatch }
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
function supersededByUpstream(fixedIn, fixedInEmber) {
  const iu = globalThis.foundry?.utils?.isNewerVersion;
  if ( typeof iu !== "function" ) return false;
  // isNewerVersion(v1, v0) = v1 是否比 v0 新。相等时返回 false，
  // 所以「当前版本 >= fixedIn」要写成 !(fixedIn 比 current 新)。
  const reached = (fixed, current) => !!fixed && !!current && !iu(fixed, current);
  // 两条轴：crucible 侧的缺陷按系统版本封顶，**ember 侧的数据缺陷按 Ember 版本封顶**。
  // 依据是上游自己的做法 —— `applyEmberPatches()`（`:45782`）就是
  // `if (isNewerVersion(ember.version, emberVersion)) continue;`，按 Ember 版本闸门。
  return reached(fixedIn, globalThis.game?.system?.version)
    || reached(fixedInEmber, globalThis.ember?.version);
}

/** 已经因版本上限停用过、并且已经说明过一次的补丁（避免每次改设置都刷屏） */
const announcedSuperseded = new Set();

/**
 * 单一判定入口：这条补丁是否已经被上游版本追上。
 *
 * 上限来源两处，补丁自带字段优先、其次 {@link VERSION_CEILINGS} 中央表。
 * `PATCH_DEFS` / `UNIVERSAL_DEFS` 走 `active()` 传 `def` 进来，
 * `PROTOTYPE_PATCHES` 只有设置键，走 {@link settingOn} 只查中央表 —— 两条路同一套判定。
 *
 * @param {string} setting   设置键
 * @param {object} [def]     补丁定义（可带 fixedIn / fixedInEmber）
 * @returns {boolean}
 */
function ceilingReached(setting, def) {
  const c = VERSION_CEILINGS[setting];
  const fixedIn = def?.fixedIn ?? c?.fixedIn;
  const fixedInEmber = def?.fixedInEmber ?? c?.fixedInEmber;
  if ( !supersededByUpstream(fixedIn, fixedInEmber) ) return false;
  if ( !announcedSuperseded.has(setting) ) {
    announcedSuperseded.add(setting);
    log(`${setting}：上游 ${fixedIn ?? fixedInEmber} 已修好，本补丁自动停用`);
  }
  return true;
}

function applyToggles() {
  const on = key => {
    try { return game.settings.get(MODULE_ID, key); } catch { return true; }   // 尚未注册时按开处理
  };
  const active = def => on(def.setting) && !ceilingReached(def.setting, def);
  for ( const def of PATCH_DEFS ) {
    const enabled = active(def);
    for ( const id of def.actionIds ) {
      if ( enabled ) ACTION_PATCHES[id] = PATCH_BODIES[id];
      else delete ACTION_PATCHES[id];
    }
  }
  applySwallowEffectId(active({ setting: "patchSwallowEffectId" }));
  // N11 与 HOOK_OVERRIDES 都是「装上就不卸」的，运行时切开关必须能双向生效
  if ( globalThis.game?.ready ) { try { installAffixTrainingFix(); } catch { /* 忽略 */ } }
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
/*  控制面板                                      */
/* -------------------------------------------- */

/**
 * 命令表 —— **按钮与控制台命令一一对应**。
 *
 * 面板上每个按钮都把等价命令写在旁边：会用面板的人不必学命令，
 * 要写宏 / 报 bug 的人也能直接抄走。两边跑的是同一个 `run`，不会出现「按钮和命令不一样」。
 *
 * @type {Array<{id: string, label: string, icon: string, command: string, effect: string,
 *               danger?: boolean, run: () => (Promise<any>|any)}>}
 */
const COMMANDS = [
  {
    id: "diagnose",
    label: "运行自检",
    icon: "fa-solid fa-stethoscope",
    command: "emberCrucibleTempFix.diagnose()",
    effect: "逐条列出补丁**此刻**的真实状态：包装上没有、开着还是关着、命中了哪些动作。选中一个 token 会连它的角色一起查。",
    run: () => globalThis.emberCrucibleTempFix.diagnose()
  },
  {
    id: "copy",
    label: "复制诊断报告",
    icon: "fa-solid fa-clipboard",
    command: "copy(emberCrucibleTempFix.diagnose())",
    effect: "把自检结果连同系统 / Ember / 模块版本复制到剪贴板。**报 bug 时先点这个**，把内容一起贴上。",
    async run() {
      const report = {
        module: game.modules.get(MODULE_ID)?.version ?? "?",
        system: game.system?.version ?? "?",
        ember: globalThis.ember?.version ?? "(未安装)",
        foundry: game.version ?? "?",
        settings: Object.fromEntries(SETTING_CATALOG.map(s => [s.key, settingOn(s.key)])),
        diagnose: globalThis.emberCrucibleTempFix.diagnose()
      };
      const text = JSON.stringify(report, null, 2);
      await game.clipboard.copyPlainText(text);
      ui.notifications.info("诊断报告已复制到剪贴板");
      return report;
    }
  },
  {
    id: "reprepare",
    label: "重新准备角色数据",
    icon: "fa-solid fa-rotate",
    command: "emberCrucibleTempFix.reprepareActors()",
    effect: "让刚改过的开关**立刻**作用到已经打开的角色卡上。<strong>不写盘</strong>，只是重跑一遍数据准备。改完开关发现卡上没变化就点它。",
    run: () => { reprepareActors(); ui.notifications.info("已重新准备全部角色数据"); }
  },
  {
    id: "enableAll",
    label: "全部开启",
    icon: "fa-solid fa-toggle-on",
    command: "—（面板专用）",
    effect: "把所有开关打开。这也是**默认状态** —— 装上模块什么都不点就是全开。",
    run: () => setAllSettings(true)
  },
  {
    id: "disableAll",
    label: "全部关闭",
    icon: "fa-solid fa-toggle-off",
    command: "—（面板专用）",
    effect: "把所有开关关掉，行为回到**上游原样**。用来对照「这个现象到底是不是本模块引起的」，不必停用模块刷新页面。",
    danger: true,
    run: () => setAllSettings(false)
  }
];

/** 批量开关。逐个 try —— 一个失败不能连累其余的。 */
async function setAllSettings(value) {
  let n = 0;
  for ( const s of SETTING_CATALOG ) {
    try { await game.settings.set(MODULE_ID, s.key, value); n++; }
    catch ( err ) { warn(`设置 ${s.key} 失败：${err?.message ?? err}`); }
  }
  ui.notifications.info(`${value ? "已开启" : "已关闭"} ${n} 项补丁`);
  return n;
}

/** 控制台版命令表：`emberCrucibleTempFix.help()` */
function printHelp() {
  console.log(`%c${MODULE_ID} —— 命令表`, "font-weight:bold;font-size:13px");
  console.table(COMMANDS.map(c => ({
    命令: c.command,
    效果: c.effect.replace(/<[^>]+>/g, "")
  })));
  console.log("%c面板：配置与设置 → 模块设置 → Ember / Crucible 临时修补 → 打开控制面板",
    "color:#888");
  return COMMANDS.map(c => c.command);
}

/**
 * 控制面板本体。
 *
 * 类**必须懒建** —— `foundry.applications.api.ApplicationV2` 在模块顶层求值时还不一定在，
 * 而且离线测试桩件里根本没有 foundry 这个全局。所以包在函数里、建一次缓存住。
 */
let _ToolboxClass = null;
function getToolboxClass() {
  if ( _ToolboxClass ) return _ToolboxClass;
  const AV2 = foundry?.applications?.api?.ApplicationV2;
  if ( !AV2 ) return null;

  _ToolboxClass = class TempfixToolbox extends AV2 {
    static DEFAULT_OPTIONS = {
      id: "ember-crucible-tempfix-toolbox",
      tag: "div",
      window: { title: "Ember / Crucible 临时修补 —— 控制面板", icon: "fa-solid fa-wrench", resizable: true },
      position: { width: 720, height: 640 },
      actions: {
        run: TempfixToolbox.#onRun,
        toggle: TempfixToolbox.#onToggle
      }
    };

    /** 上一次命令的输出，渲染在面板底部 */
    #output = null;

    static async #onRun(event, target) {
      const cmd = COMMANDS.find(c => c.id === target.dataset.command);
      if ( !cmd ) return;
      try {
        const result = await cmd.run();
        this.#output = { ok: true, label: cmd.label, text: fmtOutput(result) };
      } catch ( err ) {
        this.#output = { ok: false, label: cmd.label, text: String(err?.stack ?? err) };
      }
      this.render();
    }

    static async #onToggle(event, target) {
      const key = target.dataset.setting;
      try { await game.settings.set(MODULE_ID, key, !game.settings.get(MODULE_ID, key)); }
      catch ( err ) { ui.notifications.error(`切换 ${key} 失败：${err?.message ?? err}`); }
      this.render();
    }

    /** @override */
    async _renderHTML() {
      const div = document.createElement("div");
      div.innerHTML = renderToolbox(this.#output);
      return div;
    }

    /** @override */
    _replaceHTML(result, content) {
      content.replaceChildren(...result.childNodes);
    }
  };
  return _ToolboxClass;
}

/** 把命令返回值渲染成可读文本（对象走 JSON，其余走 String） */
function fmtOutput(v) {
  if ( v === undefined ) return "（无返回值，动作已执行）";
  if ( typeof v === "string" ) return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** 面板 HTML。提示语里本来就带 `<strong>`，所以命令表的「效果」列不转义；其余一律转义。 */
function renderToolbox(output) {
  const total = SETTING_CATALOG.length;
  const on = SETTING_CATALOG.filter(s => {
    try { return game.settings.get(MODULE_ID, s.key); } catch { return false; }
  }).length;
  // 被版本上限停用的：开关开着，但 settingOn() 说不生效
  const superseded = SETTING_CATALOG.filter(s => {
    try { return game.settings.get(MODULE_ID, s.key) && !settingOn(s.key); } catch { return false; }
  });

  const rows = COMMANDS.map(c => `
    <tr>
      <td style="width:11rem"><button type="button" data-action="run" data-command="${c.id}"
        class="${c.danger ? "" : ""}" style="width:100%">
        <i class="${c.icon}"></i> ${esc(c.label)}</button></td>
      <td style="width:15rem"><code style="user-select:all;font-size:.85em">${esc(c.command)}</code></td>
      <td>${c.effect}</td>
    </tr>`).join("");

  const groups = Object.entries(SETTING_GROUPS).map(([g, title]) => {
    const items = SETTING_CATALOG.filter(s => s.group === g);
    if ( !items.length ) return "";
    const lis = items.map(s => {
      let isOn = true, effective = true;
      try { isOn = game.settings.get(MODULE_ID, s.key); effective = isOn && settingOn(s.key); } catch { /* 读不到就当开着 */ }
      const badge = !isOn ? `<span style="opacity:.55">已关闭</span>`
        : effective ? `<span style="color:var(--color-level-success,#2b8a3e)">生效中</span>`
        : `<span style="color:var(--color-level-warning,#c8860d)" title="上游已修好，本条自动停用">上游已修</span>`;
      // 去掉组号前缀，面板里已经按组分好了
      const label = s.name.replace(/^[①②③④⑤]\s*/, "");
      return `<li style="display:flex;gap:.5rem;align-items:center;padding:.15rem 0">
        <button type="button" data-action="toggle" data-setting="${esc(s.key)}"
          style="flex:0 0 4.5rem;font-size:.8em">${isOn ? "关掉" : "开启"}</button>
        <span style="flex:0 0 5rem;font-size:.85em">${badge}</span>
        <span style="flex:1">${esc(label)}</span>
        <code style="font-size:.75em;opacity:.6">${esc(s.key)}</code>
      </li>`;
    }).join("");
    return `<fieldset style="margin-block:.5rem">
      <legend>${esc(g)} ${esc(title)}</legend>
      <ul style="list-style:none;margin:0;padding:0">${lis}</ul>
    </fieldset>`;
  }).join("");

  const out = output ? `
    <fieldset style="margin-block:.5rem">
      <legend>${output.ok ? "" : "⚠ "}${esc(output.label)} 的输出</legend>
      <pre style="max-height:18rem;overflow:auto;user-select:all;font-size:.8em;white-space:pre-wrap">${esc(output.text)}</pre>
    </fieldset>` : "";

  return `
  <section style="padding:.5rem;overflow:auto;height:100%">
    <p style="margin-top:0">
      共 <strong>${total}</strong> 项补丁，当前开启 <strong>${on}</strong> 项${
        superseded.length ? `，其中 <strong>${superseded.length}</strong> 项因上游已修好而自动停用` : ""}。
      系统 <code>${esc(game.system?.version ?? "?")}</code>
      · Ember <code>${esc(globalThis.ember?.version ?? "未安装")}</code>
      · 本模块 <code>${esc(game.modules.get(MODULE_ID)?.version ?? "?")}</code>
    </p>
    <p style="opacity:.75;font-size:.9em">
      全部是运行时修补，<strong>不写世界存盘数据</strong>。关掉开关即刻回到上游原行为，不需要刷新。
    </p>

    <fieldset style="margin-block:.5rem">
      <legend>命令 —— 按钮与控制台命令等价</legend>
      <table style="width:100%;font-size:.9em"><tbody>${rows}</tbody></table>
      <p style="margin:.4rem 0 0;opacity:.7;font-size:.85em">
        控制台里敲 <code style="user-select:all">emberCrucibleTempFix.help()</code> 可以打印同一张表。
      </p>
    </fieldset>

    ${out}

    <h3 style="margin-block:.75rem .25rem">补丁清单</h3>
    <p style="margin:0 0 .5rem;opacity:.75;font-size:.85em">
      「上游已修」= 开关还开着，但检测到上游版本已经修好了这条，于是自动让路 —— 这是正常的。
    </p>
    ${groups}
  </section>`;
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

  // 组号从 name 的首字符解析（"① N10 …"），控制面板按它分组 —— 与设置面板同一个真源
  const bool = (key, name, hint) => {
    REGISTERED_SETTINGS.add(key);
    SETTING_CATALOG.push({ key, name, hint, group: name.slice(0, 1) });
    return game.settings.register(MODULE_ID, key, {
      name, hint, scope: "world", config: true, type: Boolean, default: true, onChange: reload
    });
  };

  // ── ① 影响最大 —— 效果根本没被创建 ──────────────────────────────────────────
  bool("patchTurnsDuration", "① N10 + N12 修正被系统拒绝创建的效果时长（影响面最大）",
    "<strong>38 个动作</strong>的效果时长写的是旧的 <code>turns</code> 单位，而系统在创建效果时会直接拒绝这个单位——<strong>聊天卡写着「获得效果」，角色身上却什么都没有</strong>。<strong>九个血统的招牌变身全部中招</strong>（雷法姆变身/结晶创伤/极限代谢/活石/律动/荆棘皮/顽强/不懈猎手/泽夫三面具），此外还波及 crucible <strong>自己的</strong>内容 7 个（吞噬思绪/心灵摧残/奥术涌流/凶戾咆哮/疫疠之鞭/盾击/蒸汽喷发），以及 ember 的一批消耗品（炼金榴弹/冰霜瓶/电解安瓿/三枚宇宙宝石）。开启后把单位换成「轮」，数值不变。<br>同一开关还管 <strong>N12</strong>：另有 22 个效果直接写在物品文档上（例如 Mythspire Guardian 的「Nearing Death」，持有即应生效却永远建不出来），它们的创建不经过动作，要在效果创建那一层才拦得到。<br>注意这是解释而非还原：上游没有 turns 这个单位，原作者想要多久无从考证。");
  bool("patchEffectChanges", "① N2 修正「强化护盾」/「雷法姆变身」丢失的加值",
    "这两个动作把 changes 写在了效果数据的顶层，而系统只从 effect.system 下读。<strong>本项依赖上面的 N10</strong>——它们的效果同时还因时长单位非法而根本不会被创建，两个开关都开着才有意义。（威吓骰运那一条系统层面表达不了，仍未生效。）");
  bool("patchEffectIdAlignment", "① E2 让「不懈猎手」与「顽强体力」真正触发",
    "ember 这两处按猜出来的 id 查效果，而系统生成的是另一个——查询永远落空：<strong>朝猎物的攻击一次 +2 祝福都不会出现</strong>，「顽强体力」的行动点退还从头到尾一次都不触发。两条都是血裔的招牌能力。开启后把写入端的效果 ID 对齐到它要找的那个。<strong>本项依赖 N10</strong>——这两个动作的效果同时还因时长单位非法而根本不会被创建，两个开关都开着才有意义。");

  // ── ② 动作放不出去 / 点了什么都不发生 ─────────────────────────────────────────
  bool("patchAbyssMark", "② N1 修正深渊「湮灭之印」的非法效果 ID",
    "ember 硬编码的效果 id 只有 15 个字符，不是合法的 Foundry 文档 ID，导致这个动作抛异常中止——什么都不发生、连聊天卡都不生成、资源也不扣。开启后换成合法 ID（新旧标记都能清理）。");
  bool("patchSwallowEffectId", "② C1 修正「吞噬」的非法效果 ID（crucible 自身缺陷）",
    "crucible 给 Swallow 硬编码的效果 id 有 17 个字符，不是合法的 Foundry 文档 ID，导致这个动作抛异常中止——什么都不发生、连聊天卡都不生成、资源也不扣，配套的「反刍」也永远找不到要删的效果。开启后换成合法的 16 位 ID。");
  bool("patchDarkflameCirclet", "② N7 修正「暗焰头冠」的非法标签",
    "用了只对法术动作合法的 composed 标签，导致使用时崩在生成聊天卡之前——资源不扣、卡也不出。开启后移除该标签。");
  bool("patchSparkScope", "② N4 修正「余烬之火」的目标作用域",
    "作用域写成了「敌人」，但它的复活分支是针对友方尸体的，导致那半边永远选不中目标、使用按钮置灰。开启后放宽为「全部」，由动作自己的条件把关。");
  bool("patchAntigravityStone", "② N6 修正「反重力石」的目标类型",
    "纯自身效果却写成「单体目标且不可选自己」，必须拿别人凑数才能用，选自己反而会把规划好的位移路径丢掉。开启后改为自身目标。");
  bool("patchTumbleScope", "② C4 修正「翻滚穿越」的目标阵营（crucible 自身缺陷）",
    "目标阵营写成了「盟友」，而描述两次点名敌人。后果是选中敌人时提示阵营不合法、动作放不出来，只有选队友才能用。开启后改为敌人。");
  bool("patchDawnBeaconScope", "② C5 修正「黎明信标」的目标阵营（crucible 自身缺陷）",
    "这是个 60 尺的 pulse 区域，作用域却写成了「自身」，导致区域取目标时一个都取不到——光柱画出来了，聊天卡上零目标零骰子。开启后改为敌人。");

  // ── ③ 能用，但结算错了 ──────────────────────────────────────────────────
  bool("patchOffhandStrike", "③ P1 修正副手打击的前置判据",
    "系统用武器的<strong>存盘</strong> slot 判断上一击是不是主手，而对「任一手」武器来说手位只存在于派生值里；徒手更是从头到尾没被赋过手位。开启后改用角色身上那件武器当前的实际手位判断，并给徒手/临时武器补上手位。");
  bool("patchSuddenBite", "③ P2 修正凯思族「撕咬」的攻击范围",
    "ember 把 range 写成 min=max=2，而 minimum 量的是贴边距离（相邻＝0），等于把「贴着咬」排除掉了。开启后改为 min=空 / max=1，与同类近身单体动作一致。");
  bool("patchRestorativeRedirection", "③ P4 修正「疗愈导流」恢复的资源种类",
    "ember 读的是法术动作上不存在的 <code>damage.resource</code> 字段，结果恒为生命值。开启后改从那次被抵抗的骰子里取真实资源。动作本身的自动化是好的，本补丁<strong>不</strong>改标签、<strong>不</strong>加掷骰。");
  bool("patchStaggerDuration", "③ N3 修正「排斥踢」的踉跄变永久",
    "duration 有 value 却没有 units，被系统整段丢弃，踉跄因此永不过期——中招的角色每回合永久少 2 点行动点。开启后补上 units=rounds。");
  bool("patchBewilderingGaze", "③ N5 给「迷乱凝视」补上意志防御标签",
    "缺 willpower 标签，导致这个精神攻击按护甲结算（还会被「用盾牌挡下」）。开启后补上标签，与同类动作一致。");
  bool("patchMissingRollProvider", "③ X1 给两条区域伤害动作补上掷骰实现",
    "「脓疱迸裂」与「深渊残渣」都带防御与伤害类型标签，唯独缺少任何提供掷骰实现的标签，导致描述里承诺的伤害完全不会发生。已逐条确认这两个动作在 crucible 与 ember 的钩子注册表里都没有任何代码侧自动化；两侧 packs 全部 409 条动作扫过一遍，这类动作只有它们俩（另一条是作者自己标注「待平衡」的半成品，本模块不碰）。开启后补上通用掷骰标签。<strong>补的是实现而不是数值</strong>——防御、伤害类型、属性加值、−6 减值全部读自动作自己的标签，本模块不发明任何数字；「深渊残渣」数据里没有任何属性缩放标签，所以它打出来偏弱，这是原数据如此。");
  bool("patchDamageTypes", "③ D 系列 修正描述与数据不符的伤害类型",
    "三条动作的伤害类型与自己的描述矛盾：「毒液喷吐」结算成电击（上游已在开发版改成毒），「自毁」的烈焰爆炸结算成穿刺，「吞噬思绪」的灵能伤害落回天生武器的钝击。后果是抗性算错——吃火抗的角色挡不住火焰爆炸，吃钝击抗性的重甲反而能挡下纯精神攻击。开启后按描述修正。注意<strong>「吞噬思绪」来自 playtest（试玩）合集</strong>，不是正式内容包，若你的世界没导入过它这一条自然不会触发。");
  bool("patchResistanceChangeKey", "③ E1 修正「稳定护佑」把酸性抗性算成 NaN",
    "该效果的加值写在了抗性对象本身而不是它的 bonus 字段上，导致派生出来的酸性抗性变成 NaN，此后每次酸性伤害结算都带着 NaN 传播。开启后自动补上正确的字段路径。");
  bool("patchWildStrike", "③ I1 堵住「野性打击」的行动点漏洞（上游 issue #1403）",
    "没有天生武器的角色也能用「野性打击」——判据用 every() 检查空数组，真空通过。动作显示可用、生成聊天卡，但一次骰都不掷、一点伤害都不出，<strong>反而把行动点退还回来</strong>，等于无本万利的行动点发生器。开启后没有天生武器时正常拦住。");
  bool("patchRepeatedPrepare", "③ I4 修正位移动作重复准备导致的加成叠加（上游 issue #1404）",
    "位移类动作在规划路径后会第二次准备，而系统只重置了消耗、没重置加成——带「强化」标签的动作（如飞踢）伤害会<strong>比条目描述多 6 点</strong>；路径被判非法需要重新规划时会变成多 18 点。开启后每次准备前把加成恢复成原始态。");
  bool("patchAffixTraining", "③ N11 修正符文词缀不设训练等级",
    "crucible 自己的 bug：12 个符文 Spellcraft 词缀的钩子把训练等级写到了 actor <em>文档</em>上，而那里没有这个字段，于是抛异常被吞掉——<strong>符文知识拿到了，训练等级没设上</strong>，施放该符文的法术按「未受训 −4」结算，控制台每次数据准备刷一条错误。开启后改写到数据模型上。");
  bool("patchRuneCantrips", "③ P3 补上符文所授的小戏法与训练等级",
    "带 rune 的天赋（ember 四血统、以及召唤合集里九条旧快照）都没带该符文的招牌小戏法；旧快照还连训练等级一起丢了，导致本命符文法术按「未受训 −4」结算。开启后在运行时补齐。");
  bool("patchHasKnowledge", "③ I2 让手工添加的知识真正生效（上游 issue #1412）",
    "系统判断「角色有没有某项知识」时只读背景给的那一份，GM 手工加的知识一律当作不存在——用「评估强度」「洞察弱点」时本该拿到的 +2 祝福不会出现。开启后改读角色的知识聚合值。");
  bool("patchThrowableOnly", "③ I7 投掷武器的下拉框只列扔得出去的武器（上游 issue #1288）",
    "「投掷武器」的选择框把徒手、天生武器这些<strong>扔不出去</strong>的也列了出来，选中再用就报错。上游每个需求标签都会在准备阶段把用不了的武器标成不可选（近战标签排除远程武器、远程标签排除近战武器、天生标签同理），唯独「投掷」标签漏了这一步。开启后按上游自己的写法补上。<br>上游 issue 还提到「选了非法的那个之后这个动作从此点不动、要重启会话才恢复」——非法选项从可选列表里消失后，系统锁定所选武器的那一步会找不到它、自动落回正常挑选，因此下一次准备就会脱困。<strong>但那半个症状本模块没有复现过</strong>，若卡死另有来源则不保证解决。");

  // ── ④ 回搬自上游开发版（上游发 0.10.2 后自动停用） ────────────────────────────────
  bool("patchEnchantmentBonus", "④ B1/B2 回搬：词缀推导的附魔加值不生效（上游 bea623d8）",
    "附魔加值在数据准备的<strong>太早</strong>阶段就被算死，而词缀要到派生阶段才解析完——给武器加词缀后攻击掷骰里没有附魔加值、给护甲加词缀后闪避防御不涨，手动把附魔等级改成同一档反而就好了。上游已在开发版修好（尚未发布），本项把它回搬。");
  bool("patchCurrencyPopout", "④ B3 回搬：角色卡弹成独立窗口后货币归零（上游 1659465a）",
    "货币元素在首次构建时把自己的 value 属性删掉了，元素被搬进弹窗重新连接时只能读回 0。改动一次货币又会自己好。上游已在开发版修好（尚未发布），本项把它回搬。");
  bool("patchSkillDialogSwap", "④ B4 回搬：掷骰对话框里换了技能却没生效（上游 798a8638）",
    "多技能团队检定时，玩家在对话框里换成另一项技能，系统掷的仍然是默认那一项——对话框的返回值被丢掉了。上游已在开发版修好（尚未发布），本项把它回搬。单技能检定不受影响。");
  bool("patchFeaturedEquipment", "④ B5 修好侧栏「精选装备」只列得出 1 件天生武器（上游 ac1b5cfc）",
    "天生武器的循环上界写成「3 减去已列数量」，而每加一件上界就缩一格，导致多爪多牙的怪物最多只列出 1 件。纯显示层：动作列表里那些打击照常在，命中与伤害不受影响。上游已在开发版修好（尚未发布）。");

  // ── ⑤ 显示与界面 ─────────────────────────────────────────────────────
  bool("patchPrivateBiography", "⑤ I3 修补私密传记的泄漏（上游 issue #1406）",
    "<strong>这是信息泄漏</strong>：角色卡把「私密传记」无条件渲染给所有能打开卡的人，权限设成 limited/observer 的玩家照样能原文读到 GM 私记。提示语写着「仅拥有者可见」，实现却没兑现。开启后非拥有者看不到该字段。");
  bool("patchDefenseTypeLabel", "⑤ I5 让玩家也看得到攻击打的是哪条防御（上游 issue #1402）",
    "攻击聊天卡上的目标栏，GM 端显示「反射 12」而玩家端只有「DC」——防御类型本来是公开信息（条目描述里就写着），该藏的只有数值。开启后玩家端补上类型，<strong>仍然不显示 DC 数字</strong>。");
  bool("patchFlankingToggle", "⑤ I6 修好「可视化夹击」叠层关不掉（上游 issue #1311）",
    "关闭该调试叠层时系统只清理当前选中的 token，换选之后旧图形就钉死在画布上，再点开关也清不掉，只能刷新页面。开启后关闭时清理全部 token。仅 GM 可见。");

  // 控制面板入口。放在 bool() 全部注册完之后 —— 面板要读 SETTING_CATALOG。
  // 拿不到 ApplicationV2 就安静跳过：面板是便利设施，不能因为它没建成就让整个模块炸在 init。
  const Toolbox = getToolboxClass();
  if ( Toolbox ) {
    game.settings.registerMenu(MODULE_ID, "toolbox", {
      name: "控制面板",
      label: "打开控制面板",
      hint: "一处看全：每条补丁此刻是否生效、一键自检、复制诊断报告、批量开关。每个按钮旁边都写着等价的控制台命令。",
      icon: "fa-solid fa-wrench",
      type: Toolbox,
      restricted: true
    });
  }
  else warn("拿不到 ApplicationV2，控制面板未注册（补丁本身不受影响）");

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
  installPrototypePatches();
  // ember 在 init 注册钩子，而 #prepareHooks 在角色数据准备时才快照 —— setup 正好夹在中间
  installHookOverrides();
});

Hooks.once("ready", async () => {
  if ( game.system?.id !== "crucible" ) return;

  // setup 阶段可能因加载顺序没装上，这里补一次
  installActionHookPatch();
  installActorHookPatch();
  installAffixTrainingFix();
  installPrototypePatches();
  installFlankingToggleFix();
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
    VERSION_CEILINGS,
    __registeredSettings: REGISTERED_SETTINGS,
    /** 命令表；面板上的按钮跑的是同一批 `run` */
    COMMANDS,
    SETTING_CATALOG,
    SETTING_GROUPS,
    /** 面板 HTML 生成器；离线测试用它验「每个开关/命令都真的渲染出来了」 */
    __renderToolbox: renderToolbox,
    /** 打印命令表 —— 控制台版的控制面板 */
    help: printHelp,
    /** 打开控制面板（等价于 配置与设置 → 模块设置 → 打开控制面板） */
    openPanel() {
      const T = getToolboxClass();
      if ( !T ) return ui.notifications.error("这个 Foundry 版本拿不到 ApplicationV2，面板不可用");
      return new T().render({ force: true });
    },
    setAllSettings,
    reprepareActors,
    installAffixTrainingFix,
    installPrototypePatches,
    installFlankingToggleFix,
    PROTOTYPE_PATCHES,
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
      // 原型包装类补丁（10 条）在上面那几个字段里**一个都不出现** ——
      // 曾经因此让「关掉开关看 patches.active 有没有变」这个自检法对一半补丁失效。
      // 两条轴是独立的：**装没装上**看上游 guard 有没有通过；**生不生效**看开关
      //（包装体永不卸载，开关是在包装体内部实时读的）。
      // 每行各自 try/catch —— diagnose 是最后的自检手段，它自己抛异常比少打几个字段严重得多。
      out.patches.prototypes = PROTOTYPE_PATCHES.map(p => {
        let wrapped = "解析失败";
        try {
          const fn = p.resolve()?.prototype?.[p.method];
          wrapped = fn ? (fn.__tempfixPatched ? "已包装" : "未包装") : "找不到方法";
        } catch { /* 结构变了 */ }
        let onOff = "?";
        try { onOff = game.settings.get(MODULE_ID, p.setting) ? "开" : "关"; } catch { /* 未注册 */ }
        return `${p.label} = ${wrapped} / ${onOff}`;
      });
      // 既不走 ACTION_PATCHES 也不走 PROTOTYPE_PATCHES 的三条
      out.patches.others = (() => {
        const o = {};
        try {
          const cur = globalThis.crucible?.api?.hooks?.action?.swallow?._SWALLOWED_EFFECT_ID;
          o.swallowEffectId = `${cur}（${cur?.length ?? "?"} 字符）`;
        } catch { o.swallowEffectId = "解析失败"; }
        try {
          const affix = globalThis.crucible?.api?.hooks?.affix ?? {};
          o.affixTrainingFixed = Object.values(affix)
            .filter(c => c?.prepareGrimoire?.__tempfixOverride).length;
        } catch { o.affixTrainingFixed = "解析失败"; }
        try {
          const t = ui.controls?.controls?.tokens?.tools?.debugFlanking?.onChange;
          o.flankingToggleWrapped = t ? !!t.__tempfixPatched : "工具未注册";
        } catch { o.flankingToggleWrapped = "解析失败"; }
        return o;
      })();
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
