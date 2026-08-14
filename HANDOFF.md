# 交接：Ember / Crucible 临时修补插件

> **新会话从这里开始读。** 这个项目和隔壁的 `Ember-Crucible Translation Project`（汉化）
> **没有依赖关系** —— 所有缺陷都落在上游，与汉化无关。

---

## 0. 上一轮最重要的事：P4 曾经修错，已撤回重写

初版 P4 建立在一个错误前提上：「数据里没有 `actionHooks` 键 ⇒ 这个动作没有自动化」。
**系统压根不读那个字段** —— 钩子按 action id 从 `crucible.api.hooks.action[id]` 取（`:19047`），
而 ember 在 `ember.mjs:126744` 用代码注册了 43 个。「疗愈导流」一直是完整实现的。

初版补丁给它加了 `generic`，结果是：对**队友**掷一次针对 Wounds 阈值的攻击骰，
同时 ember 自己的 postActivate 照跑 → 同一次动作两笔恢复。**开着比关着更糟。**

现在 P4 只改一件事：把恒为 `health` 的资源种类改成那次被抵抗的骰子里的真实资源。

**教训（写进 `docs/上游缺陷诊断.md` §0 了，改任何补丁前先读那五条）：**
判断「这个动作有没有自动化」**只能**去 `ember.mjs` 里 grep `HOOKS$4.<actionId>`，不能看数据字段。

---

## 1. 这是什么

一个 Foundry 模块，用**运行时补丁**绕过 Crucible 0.10.1 与 Ember 0.6.0 的上游缺陷。
不写世界存盘数据，停用模块刷新即恢复原状。

| 补丁 | 症状 | 性质 |
|---|---|---|
| **P1** `offhandStrike` + N8 | 打完主手点副手打击说「必须紧跟一次主手打击」；**空手时必然发生** | crucible 逻辑 bug |
| **P2** `suddenBite` | 凯思族「撕咬」min=max=2，贴着敌人反而咬不到 | ember 数据笔误 |
| **P3** 符文小戏法 + N9 | 血统/召唤物给了符文却没给对应动作；旧快照还丢了训练等级（−4） | 两侧数据缺口 |
| **P4** `mayisRestorativeRedirection` | 「疗愈导流」恢复的资源种类恒为生命值 | ember 读了不存在的字段 |
| **N1** `abyssMarkUnmaking` | 「湮灭之印」点了什么都不发生，连聊天卡都不生成 | 效果 id 只有 15 字符 |
| **N10** 通用补丁 | **卡上写着「获得效果·∞」，人身上什么都没有**；九个血统的招牌变身全部中招 | 数据写 `{turns:N}`，而 `_preCreate` 拒绝 turns 单位 |
| **N2** `sentinelShielding` / `tyraphicTransformation` | 加值一条不生效（**需与 N10 同开**，否则效果压根不会被创建） | `changes` 写在了 effect 顶层 |
| **N3** `sentinelKick` | 「排斥踢」的踉跄**永不消失**，每回合 −2 行动点 | duration 有 value 没 units |
| **N4** `heartSparkOfEmber` | 「余烬之火」复活友方的分支永远选不中目标 | scope 写成了 ENEMIES |
| **N5** `bewilderingGaze` | 精神攻击按护甲结算，会被「用盾牌挡下」 | 缺 willpower 标签 |
| **N6** `antigravityStone` | 纯自身效果必须选别人才能用 | target 压根没填 |
| **N7** `darkflameCirclet` | 用一次崩在出卡之前，资源不扣、卡不出 | composed 标签只对法术合法 |

根因、行号级证据、以及同一份数据里的写法对照，全在 `docs/上游缺陷诊断.md`。
**不要重新推导** —— 那份文档每条结论都带 `crucible-compiled.mjs` / `ember.mjs` 的行号。

---

## 2. 文件在哪

```
C:\Users\Taka\Desktop\fvtt\ember-crucible-tempfix\      ← 源码唯一真源
├── module.json
├── scripts\tempfix.mjs        ← 全部逻辑（约 990 行，注释密；顶部有四条共用前提）
├── README.md                  ← 面向使用者：每个补丁的根因与做法
├── HANDOFF.md                 ← 本文件
├── docs\上游缺陷诊断.md        ← 完整取证；§0 共用前提、§4 撤回记录、§6 已排除清单
├── tests\tempfix_harness.mjs  ← 离线冒烟测试（不需要 Foundry）
└── probes\                    ← 取证脚本（node 五个 + 浏览器控制台一个）
```

Foundry 那边 `%LOCALAPPDATA%\FoundryVTT\Data\modules\ember-crucible-tempfix`
是指向上面这个目录的**目录联接（junction）**，只有一份源码、不会漂移。

---

## 3. 怎么验

### 离线（不需要开 Foundry）

```powershell
node "C:\Users\Taka\Desktop\fvtt\ember-crucible-tempfix\tests\tempfix_harness.mjs"
```

**94 条断言**，含大量反向断言（上游修好了就别动、只按 id 命中、ember 的钩子不能被顶掉、
关掉开关后行为回到上游原样）。当前：**94 passed / 0 failed**。

桩件本身也验过 —— 变异测试把 17 处补丁逐个改回坏写法，**17/17 全部被抓住**。
（脚本没有入库，重跑的话照 §5 的写法现写一个即可：备份 → 字符串替换 → 跑 harness → finally 还原。）

> ⚠ 这只验证补丁逻辑，**不验证我对 Crucible 的建模对不对**。
> 桩件复刻的是「读出来的语义」。真实世界验证没有替代品。

### 真实世界（**尚未做，这是最高优先级的未完项**）

开 Crucible 世界 → 启用模块 → 选中角色 token → 控制台 `emberCrucibleTempFix.diagnose()`。

逐项要确认的：

| # | 怎么看 | 期望 |
|---|---|---|
| P1 | **空手**打一次基础打击，再点副手打击 | 能用。`diagnose()` 里 `weapons.mainhand.sourceSlot` 应为 1（补之前是 0），`id` 为 null |
| P1′ | 让上一个动作**不是**打击，再点副手打击 | 仍然应该被拦住 |
| P2 | 贴着敌人用撕咬 | 能命中；`suddenBite` 应为 `{minimum: null, maximum: 1}` |
| P3 | 泽夫角色的动作列表 | 出现「聚能 Energize」，且**名字是中文**（说明是从合集读的、babele 生效了） |
| P3′ | 已经自己学了 `Rune: Storm` 的角色 | **不应该**出现两个 energize |
| N9 | 召唤一只火精怪 | 有「点燃 Enkindle」；`diagnose()` 里 `training.flame === 1` |
| P4 | 被一个**打士气**的法术抵抗后用疗愈导流 | 恢复的是士气不是生命值；`tags` 里**没有** generic、**仍有** harmless；`hasDice` 为 false |
| N1 | 暴击后用「湮灭之印」 | 正常出卡、扣资源；`diagnose().patches.hookOverrides` 显示已覆盖 |
| **N10** | 用任一血统的招牌变身（如 Altyra 雷法姆变身） | **角色身上真的出现效果图标**、且过 N 轮后消失；`diagnose().patches.universal` 含 turnsDuration |
| N2 | 用「强化护盾」 | 先确认图标出现了（N10 生效），再看护甲防御 +3 真的涨了 |
| N3 | 被「排斥踢」命中 | 踉跄 1 轮后消失，不是 ∞ |
| N4 | 对倒下的队友用「余烬之火」 | 能选中、使用按钮可点 |
| N5 | 用「迷乱凝视」 | 打的是意志；`diagnose().bewilderingGaze.defenseType === "willpower"` |
| N6 | 用「反重力石」 | 不需要选别人；`diagnose().antigravityStone.type === "self"` |
| N7 | 佩戴并投注暗焰头冠后用「暗焰射线」 | 正常出卡（控制台可能仍有一条 initialize 的 console.error，那是补不掉的化妆问题） |
| — | 控制台 | 无未捕获异常；关掉任一开关后 `diagnose().patches.active` 里对应项消失 |

---

## 4. 已知的不确定处（**别当成已验证**）

1. **全部 12 条都只有静态取证 + 桩件测试，一次真实 Foundry 验证都没做过。**
   这是当前最大的风险面，也是下一步唯一该做的事。
2. **N2 的第三条加成（威吓 +2 骰运）没有补。**
   `rollBonuses` 每轮被重置成恰好 `{damage:{}, boons:{}, banes:{}}`（`:41179`），
   而骰运读取点（`:36852`）是全局的、**无法按技能限定**。要做只能在 `prepareSkillCheck` 分支里按
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
- 小戏法的源数据是 `ready` 时从 `crucible.talent` 合集**读**的，不是硬编码，为的是带上 babele 的中文名与描述。
- **每个钩子体第一行都必须是归属判据**（形状或 owner）—— 语料里存在同 id 不同数据的动作。

---

## 6. 下一步（按顺序）

1. **开世界跑第 3 节那张表。** 12 条补丁一条真实验证都没有，这是唯一该先做的事。
2. 按实测结果订正本文件第 4 节。
3. 提两份 issue（清单已写好，见 `docs/上游缺陷诊断.md` 末尾）：
   一份给 `foundryvtt/crucible`（3 条），一份给 Mage Hand Press（8 条）。
4. 上游修好哪条就把对应开关关掉（多数补丁还会自己检测上游数据形状而失效）。
5. 可选：§4 里列的 T3、N2 威吓骰运；以及 `docs` §7 那张「只上报不补」的表里，
   富文本拼写与资源路径可以做成**一次性数据修补脚本**单独发布（那些要写盘，不适合进本模块）。
