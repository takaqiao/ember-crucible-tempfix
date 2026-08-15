# Ember / Crucible 临时修补

针对 **Crucible 0.10.1** 与 **Ember 0.6.0** 上游若干数据/逻辑缺陷的运行时补丁。

**全部是运行时修补，不写世界存盘数据。** 停用模块 → 刷新 → 恢复原状。
每一项都能在「配置设置 → 模块设置 → Ember / Crucible 临时修补」里单独关掉。

> 唯一的例外：**已经生成的聊天卡里存着当时的动作快照**（`_prepareMessage` 会把
> `action.toObject()` 写进 flags）。停用模块不会改写旧卡，旧卡再点确认仍按当时的行为结算。

---

## 安装

Foundry「配置与设置 → 附加模块 → 安装模块」，在最下面的 **Manifest URL** 里粘贴：

```
https://github.com/takaqiao/ember-crucible-tempfix/releases/latest/download/module.json
```

**依赖**：`crucible` 系统 ≥ 0.10.0。Ember 模块不是硬依赖 ——
没装 Ember 时 P2–P4 与 N1–N7 不会命中任何动作，模块仍可安全启用（P1 是纯 crucible 侧的）。

> 开发时也可以把仓库直接克隆到 `%LOCALAPPDATA%\FoundryVTT\Data\modules\ember-crucible-tempfix`，
> 或者建一个指向源码目录的**目录联接**（`New-Item -ItemType Junction`，不需要管理员权限），
> 改完文件在 Foundry 里刷新即可生效。

## 这个模块修了什么

| 补丁 | 症状 | 谁的问题 |
|---|---|---|
| **P1** | 打完主手点副手打击说「必须紧跟一次主手打击」，**空手时必然发生** | crucible |
| **P2** | 凯思族「撕咬」贴着敌人反而咬不到 | ember |
| **P3** | 血统/召唤物给了符文却没给对应小戏法；旧快照还丢了训练等级（−4） | 两侧 |
| **P4** | 「疗愈导流」恢复的资源种类恒为生命值 | ember |
| **N10** | **卡上写着「获得效果·∞」，人身上什么都没有——九个血统的招牌变身全部中招** | ember 数据 × crucible 校验 |
| **N11** | 符文词缀给了符文知识，却按「未受训 −4」结算；控制台每次数据准备刷错误 | crucible |
| **N1** | 「湮灭之印」点了什么都不发生，连聊天卡都不生成 | ember |
| **N2** | 「强化护盾」/「雷法姆变身」的加值不生效（需与 N10 同开） | ember |
| **N3** | 「排斥踢」的踉跄**永不消失**，每回合 −2 行动点 | ember |
| **N4** | 「余烬之火」复活友方的分支永远选不中目标 | ember |
| **N5** | 「迷乱凝视」按护甲结算，会被「用盾牌挡下」 | ember |
| **N6** | 「反重力石」纯自身效果却必须选别人才能用 | ember |
| **N7** | 「暗焰头冠」用一次崩在出卡之前，资源不扣、卡不出 | ember |
| **C1** | 「吞噬」点了什么都不发生、连聊天卡都不生成（效果 ID 有 17 字符） | crucible |
| **C4** | 「翻滚穿越」选敌人报「阵营不合法」，只有选队友才能用 | crucible |
| **C5** | 「黎明信标」60 尺光柱画出来了，却一个目标都取不到 | crucible |
| **X1** | 「脓疱迸裂」「深渊残渣」描述承诺的伤害完全不会发生 | 两侧 |
| **D** | 三条动作的伤害类型与自己的描述矛盾（毒→电击 / 火→穿刺 / 灵能→钝击） | 两侧 |
| **B1/B2** | 词缀推导的附魔加值不进攻击骰、不进闪避防御（**回搬自上游开发版**） | crucible |
| **B3** | 角色卡弹成独立窗口后货币显示为 0（**回搬自上游开发版**） | crucible |
| **B4** | 多技能团队检定里换了技能，掷的还是默认那个（**回搬自上游开发版**） | crucible |
| **I1** | 「野性打击」没有天生武器也能用，**白刷行动点** | crucible |
| **I2** | 手工添加的知识不生效，评估强度/洞察弱点少 +2 祝福 | crucible |
| **I3** | **私密传记泄漏**：limited/observer 的玩家照样读得到 GM 私记 | crucible |
| **I4** | 位移动作重复准备，带「强化」的伤害**多 6 点**（重规划时多 18） | crucible |
| **E1** | 「稳定护佑」把酸性抗性算成 **NaN**，此后每次酸性结算都传播 NaN | ember |
| **E2** | Wirrun 猎物加骰 / Vrjnhar 顽强体力**从来没触发过**（按猜出来的 id 查效果） | ember |

> **状态**：全部 27 条只有静态取证 + 184 条离线断言（另有 48/48 变异测试证明断言真的会红），**尚未在真实牌桌上验证过**。
> 详见 `HANDOFF.md` §3 的验证表。

---

## P1 · 副手打击的前置判据（含徒手）

**症状**：打完主手，点副手打击，提示「必须紧跟一次主手打击」。**赤手空拳时必然发生。**

**根因**（`crucible-compiled.mjs:10132`）

```js
lastAction.events.find(e => e.type === "strike")?.weapon.system.slot !== SYSTEM.WEAPON.SLOTS.MAINHAND
```

`e.weapon` 是 `snapshot()`（`:7753`）的产物，取的是 **`_source`**。而「这件武器现在握在哪只手」
对 slot 为 `EITHER(0)` 的武器只存在于**派生值**里：schema 的 `initial: 0`（`:44989`）+
`_prepareWeapons`（`:41550`/`:41555`）只改派生不回写 `_source`。
实测 `ember.crucible-adventure` 里有 **161 件已装备、非天生、`_source.slot = 0` 的武器**，
分布在 111 个 actor 上（其中 9 个带 Dual Wield）。

更主的一条是**徒手**：`UNARMED_DATA`（`:6681`）里根本没有 slot 字段，
`_prepareWeapons` 的徒手赋值（`:41562`/`:41565`）**一个字都不设 slot**，
而且 `_getUnarmedWeapon`（`:41624`）产的是没有 `_id` 的临时实例。
于是系统自己在 `:41606` 明文把全徒手判为双持、Flurry / Dervish 赤手空拳都能用，
**唯独 Dual Wield 自己那条不行**。

顺带第二个洞：只看 `find()` 取到的**第一个** strike 事件，双持/多击时第一个未必是主手那一击。

**本模块的做法**：① 拿事件里的武器 id 回查角色身上那件武器**当前的派生 slot**，查不到再退回快照值，
并且**任意一次** strike 命中主手（或双手）即通过；② 给没有 `_id` 的徒手/临时武器用 `updateSource`
补上手位（纯内存实例，**不落库**；系统自己在 `:18286` 就是这个用法）。

> 想彻底修好数据而不是靠补丁：把主手武器**卸下再装备一次** —— 那条路径会把 slot 写进存盘值。
> 但徒手那条路径没有等价的手工做法。

---

## P2 · 凯思族「撕咬」的攻击范围

**症状**：`Keth Lineage > Sudden Bite` 的最小/最大距离都是 2，贴着敌人反而咬不到。

**根因**：`range: {minimum: 2, maximum: 2}`，而 `minimum` 量的是**贴边距离**
（`getLinearRange`，`:32158`，相邻两个 token 是 0）。min=2 把「贴着咬」排除，max=2 又把远的排除。

| 动作 | 目标类型 | range |
|---|---|---|
| `Rune: Storm > Energize` | single | `min: null, max: 1` |
| `Heart Attunement > Spark of Ember` | single | `min: null, max: 1` |
| `Keth Lineage > Sudden Bite` | **single** | **`min: 2, max: 2`** |

**本模块的做法**：`target.type === "single"` 时改为 `min: null, max: 1`。上游改成锥形则自动不生效。

---

## P3 · 符文所授的小戏法与训练等级

**症状**：血统给了符文（比如泽夫给风暴符文）却没给对应动作；召唤出来的精怪不但没有小戏法，
施放本命符文的法术还按「未受训 −4」算。

**根因**：`system.rune` 只负责把符文塞进 `grimoire.runeIds`（`:41287`），
而每个符文的**招牌小戏法**挂在 crucible 那条 `Rune: X` 天赋的 `system.actions` 上。

- **ember 四个血统**（Zeph/Drakon/Kiska/Nir'ae）一个都没带，其中三个还漏了 `training` 等级。
- **`crucible.summons` 里 9 条 `Rune: X` 是 0.9.0 的旧快照**：`training` 全空、`actions` 全空，
  其中 4 条还是已废弃的小写 id。`training.type` 为空串会让 `#prepareTalents`（`:41281`）整段跳过，
  于是精怪**能施法、只是未受训**（`untrained.bonus = -4`，`:6834`）。

**本模块的做法**：按 **rune** 查表（不是按天赋 item id），一次盖住两批；
小戏法的数据从 `crucible.talent` 合集**读**出来，所以名字与描述会带上 babele 的中文。
玩家自己已经学了 `Rune: X`、或条目本身就带该动作时不会重复添加。

> `life`(Healer) / `soul`(bard) 故意不在表里 —— 它们的**正版条目**训练等级本来就是空的，属于设计。

---

## P4 · 「疗愈导流」恢复的资源种类

> **本条曾经修错过。** 初版判定「这个动作没有自动化」并给它加了 `generic`，
> 结果是对**队友**掷一次针对 Wounds 阈值的攻击骰、而且恢复被记两笔。
> 真相是 ember 一直有完整实现（`ember.mjs:125213`），只是数据里没有 `actionHooks` 字段 ——
> **而系统压根不读那个字段**（钩子按 action id 从 `crucible.api.hooks.action[id]` 取）。
> 完整的撤回记录见 `docs/上游缺陷诊断.md` §4。

**症状**：被一个打**士气**的法术抵抗后用「疗愈导流」，恢复的却是生命值。

**根因**（`ember.mjs:125221`）

```js
this.usage.resource = lastAction.damage?.resource ?? "health";
```

`CrucibleSpellAction.#prepareDamage`（`:21884`）产出的对象是
`{base, bonus, multiplier, type, restoration}` —— **没有 `resource` 键**，所以恒为 `"health"`。
真值在那次被抵抗的骰子里（`AttackRoll#resolveDamage` `:3291` 把 resource 写进 `data.damage`）。

**本模块的做法**：只覆盖 `canUse` —— 先调用 ember 的原实现（复用它的全部校验、让它照常报错），
再改 `usage.resource`。**不改标签、不加掷骰、不碰恢复量。**

「恢复哪种资源」是一个设置项：**自动推断**（默认，回溯最近 40 条聊天记录）/ 总是生命值 / 总是士气。

---

## N1 · 「湮灭之印」的非法效果 ID

**症状**：暴击后用「湮灭之印」，走完对话框**什么都不发生** —— 不扣资源、不生成聊天卡，
只有控制台一条未捕获异常。rank-2 的收割 +2 Focus 也永远不触发。

**根因**：`ember.mjs:125607` 硬编码 `_id = "abyssMarkUnmak0"` —— **15 个字符**，
而 `isValidId` 要求恰好 16 位。crucible 在 `:19812` 是 `_id || getEffectId(...)`，硬编码值 truthy 压过自动生成。
抛出点在 `#resolveEventStream()`（`:19374`）且全程没有 try/catch，一路逃出 `#use()` ——
**崩在 `toMessage` 之前**。

**本模块的做法**：换成合法的 16 字符 ID。动作侧与天赋侧（`emberAbyssAttune.finalizeAction`）
**必须一起改** —— 后者同样按坏 id 查找，只修写入端反而会让它开始漏删。
清理旧标记时**新旧两个 id 都认**，好让升级前挂上的标记也能被清掉。

---

## N10 · 被系统拒绝创建的效果时长（影响面最大的一条）

**症状**：**聊天卡白纸黑字写着「获得 XXX · 持续 ∞」，角色身上一个图标都没有。**
控制台有一句 warn，但没人会把它和「我的变身没生效」联系起来。

**九个血统的招牌变身全部中招** —— Altyra 雷法姆变身、Cor'ak 结晶创伤、Fej 极限代谢、
Hulg'run 活石、Kivahr 律动、Thornling 荆棘皮、Vrjnhar 顽强、Wirrun 不懈猎手、Zeph 三张面具；
外加 abyssalWhispers / bewilderingGaze / frenziedClaws / searingStare / sentinelShielding 等敌手动作。
本机数据实测 **19 个动作 / 20 条效果**，冒险包里还有重复副本。

**根因**：数据里写的是 v12 时代的 `{turns: N}`。核心的 `#migrateDuration`（foundry.mjs:15931）
把它迁成 `{value: N, units: "turns"}` —— **迁移本身是成功的**。然后撞上 `CrucibleActiveEffect._preCreate`（`:39581`）：

```js
if ( ["months", "turns"].includes(this.duration.units) ) {
  console.warn("The Crucible system does not support effect durations of unit \"turns\" or \"months\"!");
  return false;                    // ← 效果压根不会被创建
}
```

**本模块的做法**：把 `units` 由 `"turns"` 改成 `"rounds"`，数值不动，补上 **`expiry: "turnEnd"`**。

依据是上游自己迁移**同一种数据**时的映射：commit `48bf4391f7`（PR #695
「Migrate ActiveEffect expiry to V14 native schema」）把自家 `_source` 里旧的
`{turns:N, rounds:null}` 全部迁成 `{value:N, units:"rounds", expiry:"turnEnd"}` —— 实测 **49/49，零例外**。

> v0.2.1 曾经用 `turnStart`，**那是写反的** —— `turnStart` 是上游给 `{rounds:N}` 那种数据的映射，
> 套到 turns 数据上会让九大血统的变身多撑约两个 turn。v0.2.2 已订正。
> （**N3 排斥踢仍用 `turnStart`**：它的数据不是 turns 型，最近的权威是
> crucible 自家的 `SYSTEM.EFFECTS.staggered` 生成器 `:5740`，产出就是 turnStart。）

> ⚠ 这是**解释**不是还原。上游没有 turns 这个单位，作者想要的「N 个回合」只能映射到 rounds，
> 数值等价与否无从考证（`implacableHunter` 写的是 `turns: 360`）。所以这一条有单独开关。

这也是本模块第一条**通用补丁** —— 它对每个动作都跑，作为额外的一格注入而不与动作自带的钩子合并，
所以顶不掉任何上游实现。

---

## N2 · 「强化护盾」/「雷法姆变身」丢失的加值

> **这一节在 v0.2.0 里写错了。** 当时写的症状是「效果图标照常挂上，但加值不生效」——
> 实际上**图标根本不会出现**：这两个动作的效果同时还踩了 N10（`units:"turns"` 被拒绝创建）。
> 也就是说 v0.2.0 的 N2 补丁是**完全空转**的：往一个永远不会被创建的效果里写 `system.changes` 毫无意义。
> **N2 必须与 N10 一起开才有意义**，v0.2.1 起两者都默认开启。

**症状**：（在 N10 开启、效果能正常创建之后）图标挂上了，但 +3 护甲 / 辐能抗性 / 辐能伤害加值
**一条都不生效**。

**根因**：`ember.mjs:125108` / `:125149` 把 `changes` 写在了 **effect 顶层**。
动作 effects 的 schema（`:18624`）只有 `name/scope/result/statuses/duration/system`，
`changes` 由 `system` 提供；`#recordEffectEvents` 的解构（`:19806`）与重建（`:19811`）都不含顶层 `changes`，
核心的顶层→system 迁移够不着（键在 `:19806` 就被剥掉了）。
同文件里正确写法有 4 处（`:124978` / `:125032` / `:125049` / `:125458`）。

**本模块的做法**：写到 `effect.system.changes` 下。

> **已知未修**：「雷法姆变身」的第三条加成（威吓 +2 骰运）没有补 ——
> `rollBonuses` 每轮被重置成恰好 `{damage:{}, boons:{}, banes:{}}`（`:41179`），
> 骰运的读取点（`:36852`）是全局的、**无法按技能限定**。

---

## N3 · 「排斥踢」的踉跄变永久

**症状**：被哨卫「排斥踢」命中的角色，`staggered` **永不消失**，
而 `:41808` 使该角色**每回合永久少 2 点行动点**。效果卡渲染成 ∞ 归入 persistent 段，极易被当成设定。

**根因**：`duration = {value: 1, units: "", expiry: null}`。`:19810` 判 `duration.units` 为空 → 整段丢弃
→ 核心 AE schema 回落 → `value ??= Infinity` → `isTemporary` 为假 → **连过期注册表都不进**。
全库 550 条 duration 里「value 是数字而 units 为空」只有这 2 行。

**本模块的做法**：补上 `units: "rounds"` 与 `expiry: "turnStart"`（与 `SYSTEM.EFFECTS.staggered` 自己的产物一致）。
真正的「无时限」写法是 `value: null`，那种不动。

---

## N4 · 「余烬之火」的目标作用域

**症状**：想把倒下的队友拉起来 → 目标条目渲染成 unmet、提示「Invalid target scope」、**使用按钮置灰**。
只有对着敌对阵营的不死生物才能用（那半边正常）。

**根因**：`target.scope = 3`（ENEMIES），而钩子（`:125385`）的载荷是纯单向增益（回满 health、减 wounds），
代价还含 2 点英雄点。对照 crucible.spell 的 `Revive` 完全同构但 `scope: 4`，靠 `isDead` 闸门做门禁。

**本模块的做法**：把 ENEMIES 放宽为 ALL，由动作自己的条件把关。
同天赋的 `heartHallow`（减益）用 scope 3 是**对的**，所以补丁只按 id 命中。

---

## N5 · 「迷乱凝视」缺意志防御标签

**症状**：这个精神攻击**按护甲结算** —— 失败时随机抽 Dodge/Parry/Block/Armor/Glance，
会出现「一次精神凝视被用盾牌挡下」；而且 `result >= GLANCE` 就结算，**掷骰失败也可能擦过去打出士气伤害**。

**根因**：tags 是 `["generic","void","presence","morale"]`，**缺 `willpower`**。
另三个标签都不碰 `defenseType`，于是 `generic.prepare` 的 `defenseType ??= "physical"`（`:4319`）生效。
对照 crucible 自己的 `terrifyingPresence` 带 `willpower`；ember 自己另外 3 条 generic+morale 动作也都带防御标签。

**本模块的做法**：补上 `willpower` 标签（靠它的裸 `=` 压过 generic 的 `??=`）。
**不碰 `postActivate`** —— ember 用它施加 confused。

---

## N6 · 「反重力石」的目标类型

**症状**：点了会先让你规划位移路径，规划完报「无效目标」；
**把自己设为目标反而触发「不能以自己为目标」，并把刚规划好的路径整个丢弃**，陷入重复规划。

**根因**：`target = {type: "single", scope: 4, self: false}` —— 两个值恰好都是 schema 默认，作者压根没填。
对照 ember 自己的 Nimble Leap（纯自身位移）写 `type: "self"`。
全 20 个合集里 35 条带 movement 标签的动作，`single && scope 4` 只有这一条。

**本模块的做法**：改成 `type: "self"`。
（不用 `self = true`：那条路径的自动退化条件是「当前没选中别的代币」，战斗中残留目标极常见。）

---

## N7 · 「暗焰头冠」的非法标签

**症状**：装备并投注后，控制台每次数据准备刷一条错误；点「暗焰射线」→
**什么都不发生**，资源不扣、聊天卡不生成。

**根因**：tags 含 `composed`，而物品动作一律实例化为基类 `CrucibleAction`。
`composed.configureVFX`（`:3907`）的守卫恰好放行 → `SPELL_VFX_GESTURES[action.gesture.id]` 抛 TypeError，
而 `configureVFXEffect()`（`:20951`）的调用点在 `ChatMessage.create` **之前**且全程没有 try/catch。

**本模块的做法**：在 `prepare` 里删掉 `composed`。
（`initialize` 那条 console.error 补不掉 —— 标签永远排在钩子之前，属于化妆问题。）

> 上报给 ember 的正解是把 `composed` 换成 `spell`，与同包另外 4 件投注物品一致。

---

## 自检

控制台（选中你的 token 之后）：

```js
emberCrucibleTempFix.diagnose()
```

会打印：每个包装装没装上、当前启用哪几个、钩子覆盖状态、缓存了几个小戏法，
以及所选角色的 `suddenBite` 范围、疗愈导流的 usage、迷乱凝视的防御类型、
余烬之火的 scope、反重力石的 target 类型、已注入的小戏法、训练等级、
主副手武器的**存盘 slot vs 派生 slot**。

改完设置后模块会自动重跑一遍角色数据准备；也可以手动 `emberCrucibleTempFix.reprepareActors()`。

---

## 兼容性说明

- 补丁全部通过**包装原型方法**实现（`CrucibleAction#_tests`、`CrucibleActor#callActorHooks`），
  不依赖模块与系统的加载顺序。唯一的例外是 N1 的天赋侧钩子，它直接替换
  `crucible.api.hooks.talent` 里的条目，并带一道 **guard**：
  原实现源码里必须还能看到指定字符串，**上游一改就自动放弃**。
- 每次包装前都检查 `__tempfixPatched` 标记，重复安装是安全的。
- **与 crucible 自带的 Ember 兼容层不冲突。** crucible 内建了一层
  `EMBER_PATCHES = {"0.5.1": …}`（`:45771`），由 `applyEmberPatches()`（`:45782`）在 setup 阶段套用，
  闸门是 `if (isNewerVersion(ember.version, emberVersion)) continue;` ——
  **装 Ember 0.6.0 时它整层跳过**，不会与本模块争同一批钩子。
  （这也说明上游认可「按 Ember 版本闸门」这个形状，本模块的 `fixedInEmber` 与它同源。）
- **闸门有三条轴**：数据形状检测 / `__guard` 源码特征串 / 版本上限。
  版本上限又分两轴 —— crucible 侧的缺陷按 `game.system.version` 封顶，
  **ember 侧的数据缺陷按 `ember.version` 封顶**（上游修数据 ≠ 系统发版）。
  三条轴的失败方向一律是**保守生效**：读不到就继续打补丁。
- 与 `crucible-cn` / `ember_cn_unofficial` 两个汉化模块互不干涉：
  那两个只经 babele 改字符串，本模块只碰动作的判据、标签与 usage。
- 上游一旦修好对应缺陷，把对应开关关掉即可 —— 多数补丁还会自己检测上游数据形状而失效
  （P2 检测 `target.type`、N3 检测 `duration.units`、N6 检测 `target.self`、N1 检测源码 guard）。
- **P3/N9 注入的动作不传 `parent`**（传了会让动作配置卡一改字段就报错）。
  已知代价：`clone()` 不转发 item，聊天卡少写一个 item uuid。两处都是 null-safe 的。

诊断过程与完整证据见 `docs\上游缺陷诊断.md`；交接说明见 `HANDOFF.md`。
