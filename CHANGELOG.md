# 更新日志

本文件记录对玩家可见的行为变化。行号级的取证过程在 `docs/上游缺陷诊断.md`。

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
