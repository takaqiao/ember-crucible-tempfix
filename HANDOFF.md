# 交接：Ember / Crucible 临时修补插件

> **新会话从这里开始读。** 这个项目和隔壁的 `Ember-Crucible Translation Project`（汉化）
> **没有依赖关系** —— 所有缺陷都落在上游，与汉化无关。

---

## 0. 上一轮最重要的事：P4 曾经修错，已撤回重写

初版 P4 建立在一个错误前提上：「数据里没有 `actionHooks` 键 ⇒ 这个动作没有自动化」。
**系统压根不读那个字段** —— 钩子按 action id 从 `crucible.api.hooks.action[id]` 取（`:19047`），
而 ember 在 `ember.mjs:142536` 用代码注册了 42 个（Ember 0.6.1）。「疗愈导流」一直是完整实现的。

初版补丁给它加了 `generic`，结果是：对**队友**掷一次针对 Wounds 阈值的攻击骰，
同时 ember 自己的 postActivate 照跑 → 同一次动作两笔恢复。**开着比关着更糟。**

现在 P4 只改一件事：把恒为 `health` 的资源种类改成那次被抵抗的骰子里的真实资源。

**教训（写进 `docs/上游缺陷诊断.md` §0 了，改任何补丁前先读那五条）：**
判断「这个动作有没有自动化」**只能**去 `ember.mjs` 里 grep `HOOKS$4.<actionId>`，不能看数据字段。

---

## 1. 这是什么

一个 Foundry 模块，用**运行时补丁**绕过 Crucible（0.10.1 / 0.10.2 实测）与 Ember（0.6.0 / 0.6.1 实测）的上游缺陷。
不写世界存盘数据，停用模块刷新即恢复原状。

| 补丁 | 症状 | 性质 |
|---|---|---|
| **P1** `offhandStrike` + N8 | 打完主手点副手攻击说「必须紧跟一次主手打击」；**空手时必然发生** | crucible 逻辑 bug |
| **P2** `suddenBite` | 凯思血统「猝然撕咬」min=max=2，贴着敌人反而咬不到 | ember 数据笔误 |
| **P3** 符文戏法 + N9 | `crucible.summons` 里 9 条 `Rune: X` 是旧快照：戏法与训练阶位全丢，而同名正版有 | crucible 陈旧数据 |
| **P3′** 血统戏法 | 别的天赋顺带给了符文却没给戏法。**内容判断而非缺陷**（系统从未承诺两者绑定），单独开关 | 设计取舍 |
| **P4** `mayisRestorativeRedirection` | 「疗愈导流」恢复的资源种类恒为生命值 | ember 读了不存在的字段 |
| **N1** `abyssMarkUnmaking` | 「湮解印记」点了什么都不发生，连聊天卡都不生成 | 效果 id 只有 15 字符 |
| **N10** 通用补丁 | **卡上写着「获得效果·∞」，人身上什么都没有**；19 个动作，crucible 自己就占 7 个 | 数据写 `{turns:N}`，而 `_preCreate` 拒绝 turns 单位 |
| **N2** `sentinelShielding` / `tyraphicTransformation` | 加值一条不生效（**需与 N10 同开**，否则效果压根不会被创建） | `changes` 写在了 effect 顶层 |
| **N3** `sentinelKick` | 「斥退踢击」的踉跄**永不消失**，每回合 −2 动作点 | duration 有 value 没 units |
| **N4** `heartSparkOfEmber` | 「余烬之火花」复活友方的分支永远选不中目标 | scope 写成了 ENEMIES |
| **N5** `bewilderingGaze` | 精神攻击按护甲结算，会被「用盾牌挡下」 | 缺 willpower 标签 |
| **N6** `antigravityStone` | 纯自身效果必须选别人才能用 | target 压根没填 |
| **N7** `darkflameCirclet` | 用一次崩在出卡之前，资源不扣、卡不出 | composed 标签只对法术合法 |
| **N11** 12 个符文 Spellcraft 词缀 | 拿到符文却按「未受训 −4」算；控制台刷错误 | crucible 把 training 写到了文档而非数据模型 |
| **N12** 原型补丁 | 物品**自带**的效果同样踩 N10，但创建不经过动作 —— `preActivate` 够不着 | 只能包 `CrucibleActiveEffect#_preCreate`；`preCreateActiveEffect` 钩子那条路是死的 |
| **I7** 通用补丁 | 投掷武器的下拉框列出扔不出去的武器（上游 issue #1288） | `thrown` 标签漏了别的需求标签都做的 viable 过滤 |

根因、行号级证据、以及同一份数据里的写法对照，全在 `docs/上游缺陷诊断.md`。
**不要重新推导** —— 那份文档每条结论都带行号。
⚠ 但那些行号引的是**编译产物**（历史原因），上游一发版就漂。
新做的取证请引 `systems/crucible/module/` 源码树，理由见 §3。

---

## 2. 文件在哪

```
C:\Users\Taka\Desktop\fvtt\ember-crucible-tempfix\      ← 源码唯一真源
├── module.json
├── scripts\tempfix.mjs        ← 全部逻辑（2097 行，注释密；顶部有四条共用前提）
├── README.md                  ← 面向使用者：修了什么、控制面板怎么用、目前什么状态
├── HANDOFF.md                 ← 本文件
├── docs\补丁详解.md            ← 每条补丁的根因与做法（原先在 README 里，0.7.0 拆出来）
├── docs\上游缺陷诊断.md        ← 完整取证；§0 共用前提、§4 与 §7 撤回记录、§6 已排除清单
├── tests\
│   ├── tempfix_harness.mjs    ← 离线断言 327 条（不需要 Foundry）
│   └── mutate.mjs             ← 变异测试：把补丁改回坏写法，期望 harness 变红（56/56）
└── probes\                    ← 取证脚本（node 五个 + 浏览器控制台两个）
    ├── dump_all.mjs / dump_pack.mjs / dump_actions.mjs / index_actions.mjs / find_field.mjs
    │                           ← LevelDB 合集离线导出与检索（node；需要仓库根的 classic-level）
    ├── console_action_sweep.js ← **动作遍历器**（浏览器控制台）：在准备好的活对象上跑 16 条断言
    │                             （0.6.0 修好了模态对话框 BLOCKER，现在可以直接 `await crucibleSweep()`）
    └── console_party_token_diagnose.js
                                ← 六边形/远景地图切换后队伍 token 隐形的分层取证（浏览器控制台）
```

Foundry 那边 `%LOCALAPPDATA%\FoundryVTT\Data\modules\ember-crucible-tempfix`
是指向上面这个目录的**目录联接（junction）**，只有一份源码、不会漂移。

---

## 3. 怎么验

### 离线（不需要开 Foundry）

```powershell
node "C:\Users\Taka\Desktop\fvtt\ember-crucible-tempfix\tests\tempfix_harness.mjs"
```

**327 条断言**，含大量反向断言（上游修好了就别动、只按 id 命中、ember 的钩子不能被顶掉、
关掉开关后行为回到上游原样）。当前：**327 passed / 0 failed**。

断言本身也验过 —— 变异测试把补丁逐个改回坏写法，期望 harness **变红**：

```powershell
node "C:\Users\Taka\Desktop\fvtt\ember-crucible-tempfix\tests\mutate.mjs"
```

当前 **56 处变异，56/56 全部被抓住**（脚本自己备份、finally 里还原，最后复跑一次确认绿）。
加补丁时**同时加一条变异**：一条永远绿的断言和没有断言是一回事 ——
这个脚本抓出过多条假绿，最近一条是「`settingOn` 读不到设置时保守生效」从来没被断言过。

> ⚠ 这只验证补丁逻辑，**不验证我对 Crucible 的建模对不对**。
> 桩件复刻的是「读出来的语义」。真实世界验证没有替代品。

### ⚠ 取证请读**源码树**，不要读编译产物

crucible 安装目录下同时有两份代码：

```
systems/crucible/crucible-compiled.mjs     ← 运行时加载的（system.json 的 esmodules 指它），49241 行
systems/crucible/module/                   ← **完整未压缩源码树**，159 个 .mjs，按关注点分目录
    documents/active-effect.mjs   hooks/talent.mjs   hooks/spellcraft.mjs
    models/action.mjs             dice/…             applications/…
```

两份**同源**（已用三处特征串交叉验证：`check = response;` / `featuredEquipment.length >= 3` /
`this.system.training[runeId]` 在两边各命中一次）。

**本仓早期的取证全部引的是编译产物的行号，那是走了弯路。** 后果是每次上游发版
行号大面积漂移（0.10.1→0.10.2 就从 48308 行涨到 49241 行），而
`module/documents/active-effect.mjs:152` 这种引用**基本不动**，而且一眼能看出在讲什么。

**以后取证一律引源码树**。两个例外：
1. `__guard` 的特征串仍要拿**编译产物**核对 —— 运行时 `String(fn)` 读到的是它，
   打包过程可能改写空白或变量名。
2. ember 没有源码树，只有 `scripts/ember.mjs`，那边只能读打包产物。

（旧文档里的编译产物行号没有批量重标 —— 200+ 处，重标的出错概率高于价值。
需要精确定位时用特征串搜索，或直接去源码树找同名文件。）

### 排障第一步：先确认在跑哪一版

模块目录常是指向源码的**目录联接**，而 Foundry 给模块 ESM 的 URL **不带版本参数** ——
清单（服务端读）永远是新的，浏览器执行的脚本却可能是旧缓存。
这个坑连烧两轮：一次是本地目录被当成证据（实为 0.2.0），
一次是用户报「设置只有十几条、没有控制面板」，真因就是缓存的 0.2.0 脚本。

0.7.2 起脚本自带 `SCRIPT_VERSION`，与清单不符会红字报错 + 常驻通知。
就绪时也会打一行：

```
ember-crucible-tempfix | v0.8.1 已就绪 —— 补丁开关 32 项，控制面板 已注册（系统 0.10.2 / Ember 0.6.1）
```

**对不上就 Ctrl+Shift+R**，在此之前任何症状都不必排查。

### 真实世界（**尚未做，这是最高优先级的未完项**）

开 Crucible 世界 → 启用模块 → 选中角色 token → 控制台 `emberCrucibleTempFix.diagnose()`。

逐项要确认的。**每行都标了设置键名**，好让「开关是不是都测过了」可以机械核对
（表的行数 > 开关数，因为有些开关管多个动作、必须分开验 —— 这正是以前漏测的地方）。

> **中文名以你装的汉化模块为准**，可能与本表不同。找不到就在控制台按 id 查：`_token.actor.actions.<id>`。
>
> **`diagnose()` 里有两条独立的轴**：「已包装」= 上游 guard 通过、补丁装上了；
> 「开/关」= 当前是否生效。**包装体永不卸载**，所以关掉开关后仍显示「已包装」，这是正常的。

**A 组 —— 选中角色 token 跑 `emberCrucibleTempFix.diagnose()` 就能看**

| 设置键 | # | 怎么看 | 期望 |
|---|---|---|---|
| `patchOffhandStrike` | P1 | **空手**打一次基础打击 →**点确认那张聊天卡**→ 再点副手攻击 | 能用。`weapons.mainhand.sourceSlot` 为 1（补之前是 0）、`id` 为 null |
| `patchOffhandStrike` | P1′ | 让上一个动作**不是**打击，再点副手攻击 | 仍然被拦住 |
| `patchSuddenBite` | P2 | 贴着敌人用猝然撕咬（`suddenBite`） | 能命中；`suddenBite` 为 `{minimum: null, maximum: 1}` |
| `patchLineageCantrips` | **P3′** | 泽夫角色的动作列表 | `diagnose().cantrips` 里出现 `energize`。⚠ 这条是**内容判断**：系统从没承诺「有符文就有戏法」，不认同就关掉它 |
| `patchRuneCantrips` | P3″ | 已经自己学了 `Rune: Storm` 的角色 | **不应该**出现两个 energize |
| `patchRuneCantrips` | **P3 / N9** | 召唤一只火精怪（走的是 `crucible.summons` 的旧快照） | 有 `enkindle`；`training.flame === 1`。这条才是可证的缺陷 |
| `patchAffixTraining` | N11 | 装一件带符文 Spellcraft 词缀的物品 | `training` 里该符文为 1；控制台不再刷 prepareGrimoire 错误 |
| `patchBewilderingGaze` | N5 | 用惑乱凝视（`bewilderingGaze`） | `bewilderingGaze.defenseType === "willpower"` |
| `patchAntigravityStone` | N6 | 用反重力石（`antigravityStone`） | 不需要选别人；`antigravityStone.type === "self"` |
| `patchSparkScope` | N4 | 对倒下的队友用余烬之火花（`heartSparkOfEmber`） | 能选中、使用按钮可点 |

**B 组 —— 要真的放一次动作**

| 设置键 | # | 怎么看 | 期望 |
|---|---|---|---|
| `patchTurnsDuration` | **N10** | ⚠ **Ember 0.6.1 起别再用血统变身验** —— 上游已把那九个迁好，照着验会看到本来就正常的行为。改用仍中招的：`shieldBash` 盾牌猛击（crucible 单机即可复现）或 `steamVent` 熔毁 | **身上真的出现效果图标**且 N 轮后消失；`patches.universal` 含 turnsDuration<br>缺陷曾由用户在 **Ember 0.6.0** 上实测确认（「强健体力」用了没效果，1 专注 + 1 点英雄气概白扣）；该动作在 0.6.1 已被上游修好 |
| `patchTurnsDuration` | **N12**（同一开关） | 把 `crucible-adventure` 的神话尖塔守护者 Mythspire Guardian 拖上桌 —— 它的「濒临死亡 Nearing Death」是 `transfer:true` | 该 token 身上直接带着「消损之毒 Wasting Poison」效果；控制台**不再**出现 `does not support effect durations of unit "turns"` |
| `patchEffectChanges` | N2 | 用强化护盾（`sentinelShielding`）。Ember 0.6.0 上要**先确认 N10 那格过了**；0.6.1 起该效果自己就能创建 | 图标出现后，护甲防御 +3 真的涨了 |
| `patchAbyssMark` | N1 | 暴击后用湮解印记（`abyssMarkUnmaking`） | 正常出卡、扣资源；`patches.hookOverrides` 显示已覆盖 |
| `patchStaggerDuration` | N3 | 被斥退踢击（`sentinelKick`）命中 | 踉跄 1 轮后消失，不是 ∞ |
| `patchDarkflameCirclet` | N7 | 佩戴并投注暗焰头环后用暗焰光束 | 正常出卡（控制台仍可能有一条 initialize 的 error，那是补不掉的化妆问题） |
| `patchRestorativeRedirection` | P4 | 被**打士气**的法术抵抗后用疗愈导流 | 恢复的是士气；`tags` 里**没有** generic、**仍有** harmless；`hasDice` 为 false |
| `patchSwallowEffectId` | C1 | 让一只穆塔普 Mootap 用吞下（`swallow`） | 正常出卡、目标身上出现效果；再用反吐（`regurgitate`）能放出来 |
| `patchTumbleScope` | C4 | **选中敌人**点翻滚（`tumble`，来自天赋「穿越翻滚」） | 不再报阵营不合法 |
| `patchDawnBeaconScope` | C5 | 用曙光信标（`dawnBeacon`） | 聊天卡上目标数 > 0、有骰子 |
| `patchMissingRollProvider` | X1 | 触发令人作呕的脓疱（`repugnantPustules`） | 聊天卡上有伤害骰。**数值来自系统默认，非上游权威值** |
| `patchMissingRollProvider` | X1′ | 触发深渊遗骸（`abyssalRemains`） | 同上 |
| `patchDamageTypes` | D-1 | ~~剧毒喷雾~~ —— **上游已修**：crucible 0.10.2 与 ember 0.6.1 的三份副本都已是 `poison`，本格按 `when()` 判据自动空转 | 无需验（另两格仍要验） |
| `patchDamageTypes` | D-2 | 用自毁（`selfDestruct`） | 算火焰，不是穿刺 |
| `patchDamageTypes` | D-3 | 用吞噬思维（`devourThoughts`） | 灵能伤害，不落回天生武器的钝击 |
| `patchWildStrike` | I1 | 让**没有天生武器**的角色点狂野打击（`wildStrike`） | 被拦住，不再白刷动作点 |
| `patchEffectIdAlignment` | E2-1 | 标记猎物（`implacableHunter`）后攻击它 —— **依赖 N10** | 出现 +2 恩惠骰 |
| `patchEffectIdAlignment` | E2-2 | 触发强健体力（`formidableStamina`）—— **依赖 N10** | 动作点真的退还 |
| `patchResistanceChangeKey` | E1 | 上稳定守护，看角色卡抗性 | 酸性抗性是数字，不是 `NaN` |
| `patchRepeatedPrepare` | I4 | 带**强化**标签的位移动作（如飞踢），规划路径后再规划一次 | 伤害不比条目描述多 6 点 |
| `patchSkillDialogSwap` | B4 | 多技能团队检定，在对话框里换成另一项技能 | 掷的是换后的那一项 |
| `patchHasKnowledge` | I2 | GM 手工加一条知识，再用评估力量 | 拿到 +2 恩惠骰 |
| `patchEnchantmentBonus` | B1/B2 | 给武器加词缀看攻击骰；给护甲加词缀看闪避 | 攻击骰里出现附魔加值；闪避防御涨 |
| `patchCurrencyPopout` | B3 | 角色卡弹成独立窗口 | 货币不为 0 |
| `patchFlankingToggle` | I6 | 开夹击叠层 → 换选别的 token → 关叠层 | 旧图形也消失，不用刷新 |
| `patchFlankingToggle` | I6′ | **刚进世界、一次控件图层都没切过**就直接测上一行 | 同样生效（0.7.2 之前这里是坏的：安装晚于控件首次渲染）；`diagnose().patches.others.flankingToggle` 为「已包装」 |
| `patchFeaturedEquipment` | B5 | 打开多爪多牙怪物的卡，看侧栏当前装备 | 列出 3 件天生武器 |
| `patchThrowableOnly` | **I7** | 装一把匕首（可投掷）+ 有天生武器的角色，打开「投掷武器」的武器下拉框 | 只列得出匕首；徒手/天生武器不再出现 |
| `patchThrowableOnly` | I7′ | 先在**关掉**本项时选中一个扔不出去的武器并使用（复现卡死），再开回来 | 下一次准备自动落回能扔的那把，动作恢复可用 |

**C 组 —— 需要第二个玩家端登录（不是 30 秒能做完的，单独排时间）**

| 设置键 | # | 怎么看 | 期望 |
|---|---|---|---|
| `patchPrivateBiography` | I3 | 用 limited/observer 权限的**玩家账号**打开 NPC 卡，切到生平页 | 看不到私人传记原文 |
| `patchDefenseTypeLabel` | I5 | **玩家端**看一张攻击聊天卡的目标栏 | 有防御类型（如「反射」），**仍然不显示 DC 数字** |

**D 组 —— 通用**

| 怎么看 | 期望 |
|---|---|
| 启动时的控制台 | 有若干行「已包装 X」；**无未捕获异常** |
| 关掉一个**动作类**补丁（P/N/C/X/D/I1/E2 那批） | `diagnose().patches.active` 里对应 action id 消失 |
| 关掉 N10 / N1 | 看 `patches.universal` / `patches.hookOverrides` |
| 关掉**原型类**补丁（B1–B4、I2–I5、E1、I4） | 看 `patches.prototypes` —— 每行是「标签 = 已包装/未包装 **/** 开/关」，**开关只改后半段** |
| 关掉 C1 / N11 / I6 | 看 `patches.others`（`swallowEffectId` 长度、`affixTrainingFixed` 条数、`flankingToggleWrapped`） |

---

## 4. 已知的不确定处（**别当成已验证**）

1. **32 条里只有 N10 得到过真实验证。** 其余全部只有静态取证 + 桩件断言。
   这是当前最大的风险面，也是下一步唯一该做的事。
   - ✅ **N10 已确认**：用户实测「强健体力」（`formidableStamina`）用了没任何效果，
     1 专注 + 1 点英雄气概白扣 —— 症状与诊断逐字吻合。这是第一条、也是目前唯一一条被现实证实的诊断。
   - 需要注意：**「缺陷存在」被证实了，「补丁修好了它」还没有。** 两件事要分开记。
2. **N2 的第三条加成（威吓 +2 恩惠骰）没有补。**
   `rollBonuses` 每轮被重置成恰好 `{damage:{}, boons:{}, banes:{}}`（`:41179`），
   而恩惠骰读取点（`:36852`）是全局的、**无法按技能限定**。要做只能在 `prepareSkillCheck` 分支里按
   `skill.id === "intimidation"` 加 —— crucible 自己在 `:11353`（berserkerRage）是这个套路，
   但实现前必须现场核对 `:36852-36875` 的签名。目前 README 里记了「仍未生效」。
3. **T2 的已知代价**：P3/N9 注入的动作**不传 parent**（传了会让配置卡一改就报错）。
   代价是 `CrucibleAction#clone`（`:19135`）不转发 item，执行时那份 clone 的 `this.item` 为 undefined，
   聊天卡少写一个 item uuid（`:21193`）。两处都 null-safe。
4. **T3 没做**：每次 `prepareData()` 都会 `new ActionCls(...)` 而不是复用长期实例
   （系统自带的走 `action.bind()` `:42048`）。差异在 `usage` 的共享语义（`:18986`）。留作 v2。
5. **P1 的三条成因里，B（聊天卡没确认）不是本模块能修的** —— 那是工作流问题，要确认聊天卡。

---

## 5. 实现要点（改代码前先看这几条）

先读 `scripts/tempfix.mjs` 顶部那四条共用前提，以及 `docs/上游缺陷诊断.md` §0。然后：

- 补丁通过**包装原型方法**实现（`CrucibleAction#_tests`、`CrucibleActor#callActorHooks`），
  与加载顺序无关。**不要**改成往 `crucible.api.hooks` 注册 —— 每个 action 在构造时就把
  `crucible.api.hooks.action[id]` **快照**成自己的 `hooks` 并冻结（`:19023`），改注册表对已构造的动作无效。
- **例外**：非动作类型的钩子（目前只有 N1 的 `talent.emberAbyssAttune.finalizeAction`）走
  `HOOK_OVERRIDES` + `installHookOverrides()` 直接替换注册表条目。那里有一道 `guard`：
  原实现源码里必须还能看到指定字符串，**上游一改就自动放弃**，不会带着过期假设继续跑。
- `_tests()` 的合并是 `Object.assign({}, own, extra)` —— **同名覆盖、其余保留**。
  所以：想追加就挑一个 ember 没定义的钩子名；想替换就必须把原逻辑整段照抄进来（N1 就是照抄的）。
  **N5 绝对不能定义 `postActivate`**（ember 用它施加 confused），N3 同理（它是击退）。
- 标签的增删要放在 `initialize` 里；`prepare` 那一轮才能吃到（标签永远排在钩子之前）。
- `injectRuneCantrips` 里那道 `actions !== actor.system.actions` 守卫：
  `CrucibleAction#clone()` 也会用**单条记录**调 `prepareActions` 钩子（`:19152`），不能往那种调用里塞东西。
- 戏法的源数据是 `ready` 时从 `crucible.talent` 合集**读**的，不是硬编码，为的是带上 babele 的中文名与描述。
- **每个钩子体第一行都必须是归属判据**（形状或 owner）—— 语料里存在同 id 不同数据的动作。
- **版本上限走中央表 `VERSION_CEILINGS`（设置键 → 上游哪版修好）**，不要再往补丁对象上挂
  `fixedIn`。历史教训：闸门原先只作用于 `PATCH_DEFS` / `UNIVERSAL_DEFS`，
  而 B 系列（上游一发布就该退休的五条回搬）**全是 `PROTOTYPE_PATCHES`** —— 写了也是死字。
- **原型补丁一律经 `settingOn()` 读开关**（它同时查中央表），不要直接 `game.settings.get`。
  `settingOn` 的失败方向是**保守生效**，这有断言盯着。
- 加补丁的同时**在 `tests/mutate.mjs` 里加一条变异**。一条永远绿的断言和没有断言是一回事。

---

## 6. 下一步（按顺序）

1. **开世界跑第 3 节那张表。** 除 N10 的缺陷侧外一条真实验证都没有，这是唯一该先做的事。
   表里每行都标了设置键名 —— 跑完对一遍键名，就知道开关是不是都覆盖到了。
   建议从 `patchTurnsDuration` 起手：它的缺陷侧已经确认，是唯一一个能拿现实做对照的。
2. 按实测结果订正本文件第 4 节。
3. 提两份 issue（清单已写好，见 `docs/上游缺陷诊断.md` 末尾）：
   一份给 `foundryvtt/crucible`（3 条），一份给 Mage Hand Press（8 条）。
4. 上游修好哪条就把对应开关关掉（多数补丁还会自己检测上游数据形状而失效）。
5. 可选：§4 里列的 T3、N2 威吓 +2 恩惠骰；以及 `docs` §7 那张「只上报不补」的表里，
   富文本拼写与资源路径可以做成**一次性数据修补脚本**单独发布（那些要写盘，不适合进本模块）。
