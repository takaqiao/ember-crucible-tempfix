# 更新日志

本文件记录对玩家可见的行为变化。行号级的取证过程在 `docs/上游缺陷诊断.md`。

## 0.2.2

### ⚠ 订正 v0.2.1：N10 的 `expiry` 方向写反了

`turnStart` → **`turnEnd`**。依据是上游自己迁移**同一种数据**时的映射：
commit `48bf4391f7`（PR #695「Migrate ActiveEffect expiry to V14 native schema」）
把自家 `_source` 里旧的 `{turns:N, rounds:null}` 全部迁成
`{value:N, units:"rounds", expiry:"turnEnd"}` —— 实测 **49/49，零例外**。

`turnStart` 是上游给 `{rounds:N}` 那种数据的映射，套到 turns 数据上会让九大血统的变身
**多撑约两个 turn**。

**N3（排斥踢）保持 `turnStart` 不变** —— 它的数据不是 turns 型，
最近的权威是 crucible 自家的 `SYSTEM.EFFECTS.staggered` 生成器，产出就是 turnStart。

### 新增：P1 的上游退让闸门

P1 是唯一「整体顶掉上游实现却没有闸门」的补丁。今天无害（上游 `canUse` 一字未改），
但上游哪天自己修好，我们会带着旧逻辑继续跑 —— 那不是双重应用，是**静默替换**。

现在 `ACTION_PATCHES` 支持 `__guard`：列出上游实现里必须还能看到的特征串，
看不到就**逐键退让**并警告一次。纯追加的键（上游没有同名钩子）不受约束。

### 订正统计数字

`_source.slot = 0` 的武器实测数，由「85 件 / 61 个 actor / 其中 11 个带 Dual Wield」
订正为 **161 件 / 111 个 actor / 其中 9 个带 Dual Wield**。
范围：`ember.crucible-adventure` 的 265 个 actor；过滤条件为 equipped 且 category 非 natural/unarmed；
含场景 token delta 结果不变。原数字三项全错，是引用了未经复核的结果。

> 顺带核实：受 N10 影响的动作数**仍是 19 个 / 20 处**（全 10 个 ember pack 都扫过，
> 其余 8 个 pack 零命中）。上游对账里「32 个 / 92 处」那个说法未能复现。

### 测试

94 → **97 条断言**；变异测试 17 → **19 处，19/19 全部被抓住**。

## 0.2.1

### 新增 N10 —— 目前影响面最大的一条

**19 个动作的效果从来没有落地过**，其中包含**九个血统的招牌变身**
（Altyra 雷法姆变身、Cor'ak 结晶创伤、Fej 极限代谢、Hulg'run 活石、Kivahr 律动、
Thornling 荆棘皮、Vrjnhar 顽强、Wirrun 不懈猎手、Zeph 三张面具）。

玩家看到的是：**聊天卡白纸黑字写着「获得 XXX · 持续 ∞」，角色身上一个图标都没有。**

根因是数据写的是 v12 时代的 `{turns: N}`，核心迁移成 `{value: N, units: "turns"}`（迁移本身成功），
随后被 `CrucibleActiveEffect._preCreate` 的 `["months","turns"].includes(units) → return false` 当场拒绝。
开启后把单位换成 `rounds`、数值不变、补上 `expiry`，与 crucible 自己对 staggered 的转换惯例一致。

> 这是**解释**不是还原：上游没有 turns 这个单位，原作者想要多久无从考证。所以有单独开关。

这是本模块第一条**通用补丁**（对每个动作都跑）。它作为额外的一格注入、**不与动作自带的钩子合并**，
所以顶不掉任何上游实现 —— 这一点有专门的反向断言把关。

### ⚠ 订正：v0.2.0 的 N2 补丁是空转的

`sentinelShielding` / `tyraphicTransformation` 的效果**同时**踩了 N10 ——
`units:"turns"` 使它们根本不会被创建，往一个不存在的效果里写 `system.changes` 毫无意义。
v0.2.0 的 README 写的症状「图标照常挂上，但加值不生效」也是错的：**图标根本不会出现**。

N2 的实现本身没问题，但**必须与 N10 一起开才有意义**。两者现在都默认开启。
（顺带：`bewilderingGaze` 的 confused 效果也在这 19 个里 —— N5 修好了它的攻击判定，
但它施加的效果同样从来没落地过，v0.2.1 起才真正完整。）

### 测试

- 断言 74 → **94**，新增的 16 条覆盖迁移链、单位改写、以及「通用补丁不能顶掉按 id 的补丁与 ember 的钩子」。
- 变异测试 13 → **17 处，17/17 全部被抓住**，其中包括把通用补丁改成与 hooks 合并（会立刻红 7 条）。

## 0.2.0

### ⚠ 破坏性订正

- **P4「疗愈导流」整条撤回重写。** 0.1.0 的实现建立在一个错误前提上
  （「数据里没有 `actionHooks` 键 ⇒ 这个动作没有自动化」——**系统压根不读那个字段**，
  钩子按 action id 从 `crucible.api.hooks.action[id]` 取，而 ember 在代码里注册了 43 个）。
  旧实现给动作加了 `generic`，实际后果是：对**队友**掷一次针对创伤阈值的攻击骰，
  同时 ember 自己的 `postActivate` 照跑 → 同一次动作记两笔恢复。**开着比关着更糟。**
  新实现只覆盖 `canUse`，只修一件事：把恒为生命值的恢复资源改成那次被抵抗的骰子里的真实资源。
- `redirectResource` 设置项默认值由「生命值」改为「自动推断」（否则新补丁默认什么都不做）。
- 修复自动推断读错字段名（`ev.roll` → `ev.rollIndex`）—— 旧版 auto 档 100% 失效且静默退回生命值。

### 新增补丁

- **N1** `abyssMarkUnmaking`：硬编码的效果 ID 只有 15 个字符（要求恰好 16），
  导致整个动作抛异常中止 —— 不扣资源、不生成聊天卡。动作侧与天赋侧一起修。
- **N2** `sentinelShielding` / `tyraphicTransformation`：`changes` 写在效果顶层而非 `effect.system` 下，
  图标挂上但加值一条不生效。（威吓骰运那一条系统层面表达不了，仍未生效。）
- **N3** `sentinelKick`：`duration` 有 value 没 units，被系统整段丢弃 →
  踉跄永不消失，中招者每回合永久 −2 行动点。
- **N4** `heartSparkOfEmber`：作用域写成「敌人」，复活友方的分支永远选不中目标。
- **N5** `bewilderingGaze`：缺 `willpower` 标签，精神攻击按护甲结算。
- **N6** `antigravityStone`：纯自身效果写成「单体且不可选自己」，必须拿别人凑数才能用。
- **N7** `darkflameCirclet`：`composed` 标签只对法术动作合法，导致使用时崩在生成聊天卡之前。

### 扩充既有补丁

- **P1** 补上徒手 / 临时武器路径。`UNARMED_DATA` 里根本没有 slot 字段、
  `_prepareWeapons` 的徒手赋值一个字都不设手位、`_getUnarmedWeapon` 产的实例没有 `_id`
  —— 0.1.0 的三级判据在空手时**全部落空**。这是这条缺陷最主的成因，不是边角情况。
- **P3** 改为按 **rune** 查表（原先按血统 item id），一次盖住 ember 四血统与
  `crucible.summons` 里 9 条 0.9.0 旧快照，并补上被丢掉的训练等级（否则本命符文法术按「未受训 −4」算）。

### 自身修补

- 切换设置后角色卡现在真的会刷新：crucible 的卡全是 ApplicationV2，
  而 0.1.0 只遍历 `ui.windows`（V1），里面一个 crucible 角色卡都没有。
- P3/N9 注入的动作不再传 `parent` —— 传了会让动作配置卡一改字段就弹红条报错。
- `module.json`：删掉空的 `manifest`/`download`（schema 是 `blank:false`，空串会挂黄色警告）；
  `compatibility.minimum` 由 13 改为 14（crucible 0.10.1 自己就要求核心 ≥14.364）。
- 非 crucible 世界现在在 `init` 最前面就 return，不再注册任何设置项。

### 测试

- 断言 20 → **74** 条，补上五处桩件盲区（聊天记录恒空、`prepareData` 不清空动作表、
  设置项 `onChange` 从不触发、标签集接受任意字符串、缺 `hooks` 快照桩）。
  正是这些盲区让 `ev.roll` 这个 100% 失效的 bug 一路绿灯通过。
- 加了变异测试：把 13 处补丁逐个改回坏写法，确认桩件真的会红。**13/13 全部被抓住。**

## 0.1.0

首个版本：P1 副手打击判据、P2 凯思族撕咬范围、P3 血统所授符文的小戏法、P4 疗愈导流（**已知有害，见 0.2.0**）。
