/* ============================================================================
 * 全动作干跑遍历器 —— 把「缺陷检测」变成上游每发一版就能零成本重跑的回归
 *
 * **这是浏览器控制台脚本**（probes/ 下 dump_*.mjs 那几个是 node 的）。
 * 用法：以 GM 身份进世界、等 canvas ready，F12 控制台整段粘进去回车。
 * 粘贴即自动跑一遍并返回 Promise；要换参数重跑：
 *
 *     const R = await crucibleSweep({ includePacks: true, runPreActivate: true });
 *     copy(JSON.stringify(R.findings, null, 1));
 *
 * 行号约定：`:N` = systems/crucible/crucible-compiled.mjs（0.10.1，48308 行）；
 *           `foundry:N` = Foundry 的 resources/app/public/scripts/foundry.mjs；
 *           `ember:N` = modules/ember/scripts/ember.mjs；`tempfix:N` = 本模块 scripts/tempfix.mjs。
 *
 * ---------------------------------------------------------------------------
 * 一、第一原则：**一切判定都发生在 prepare() 跑完的活对象上**
 * ---------------------------------------------------------------------------
 * crucible 有大量值是标签/钩子在准备期才填进去的。在 `_source` 上判就会同时
 * 误报和漏报 —— 这正是本文件上一版被推翻的原因：
 *
 *   · `penetratingThrow` 静态看「射线长度 0」，实际带 `thrown` 标签，
 *     `thrown.prepare`（:4251）`this.range.maximum ??= 10` ⇒ 10 尺，**误报**；
 *   · `explosiveEmergence / tailSweep / whirlwind / sentinelSpin` 静态看「半径 0」，
 *     实际 `range.weapon === true`，由 `strike.prepare`（:4104，经 melee/natural 的
 *     propagate 到 strike）按武器射程填 ⇒ 全部正常，**误报**；
 *   · `kineticWall`（真正的几何退化）静态判据反而**漏了**。
 *
 * 所以：不做任何静态近似。拿不到准备后形态的条目一律计进 skipped，不猜。
 * 取准备态用 `clone({}, {lazy:true})` 再手动 `prepare()`，理由见 §P。
 *
 * ---------------------------------------------------------------------------
 * 二、只读保证（改任何一行之前先读完）
 * ---------------------------------------------------------------------------
 * 动作生命周期的写盘边界**逐行核过**，全部三处都在 `#use()` 的末尾（:19319 起）：
 *   :19383  this.region.constructor.create(regionData, {parent: canvas.scene, keepId:true})
 *   :19388  await this.toMessage(...)   → :21378 ChatMessage.create
 *   :19397  await this.actor.update({"flags.crucible": this.usage.actorFlags})
 * 在那之前的 initialize / prepare / configure / acquireTargets / preActivate / roll /
 * postActivate 七个阶段，上游代码**零 DB 写**（对 3600–13600 行按
 * `\.(create|update|delete|createEmbeddedDocuments|…|setFlag)\(` 扫得 25 处命中，逐个
 * 定位外层方法后，每一处都落在 `async confirm(reverse)` 里：:3955 / :8764 / :8857 /
 * :9753 / :10581 / :10607 / :11090；另有 :10008 `_rewrite`、:8522 `setProceduralName`、
 * :8635 随机战利品，三者不在动作生命周期内；其余命中是 `Set#delete` / `tags.delete` /
 * `HTMLCrucibleCurrencyElement.create` / `Object.create` 之类同名方法）。
 * ember 侧同样补扫过 prepareAction(s) / finalizeAction 的全部钩子区块：零 DB 写。
 *
 * 本脚本据此**只调**：构造 / `_prepareData` / `prepare` / `_canUse` / `_displayOnSheet` /
 * `recordEvent` / `_callActionHooksAsync("preActivate")`。
 * **绝不调**：`use()` / `#use()` / `toMessage()` / `confirm()` / `configureDialog()` /
 * `bind(actor)`（:19126 会 defineProperty 改写活对象再 reset，双重破坏）/
 * 不带 `lazy` 的 `clone()`（:19142 与世界那份 usage **共享同一对象**）/
 * `canvas.regions.placeRegion()`（:2811 要用户拖鼠标）。
 *
 * 另外装一道**写盘熔断**（§W）作为「零写盘」的可执行证明。熔断挡不住、只能靠纪律的三类：
 *   · `canvas.tokens.setTargets()`（走 user.broadcastActivity，会改所有玩家看到的高亮）
 *   · client scope 的 `settings.set`（localStorage）
 *   · `ui.notifications.*`（只刷屏，无数据变更）
 * 本脚本不进任何对话框、不取真实目标，三类都不会触发。
 *
 * ---------------------------------------------------------------------------
 * 三、这个脚本抓不到什么（诚实清单，别拿它的「全绿」当结论）
 * ---------------------------------------------------------------------------
 *  1. **区域动作的真实取靶**。`#acquireTargetsFromRegion`（:19614）第一行
 *     `if (!this.region) return []` —— 没放区域就返回空，**这个空不是缺陷证据**；
 *     要放区域就得 canvas ready 且改 canvas 状态。所以 C5 只能靠 scope 静态判（T1）。
 *  2. **postActivate / confirm 阶段写入的东西**。N1 的 `_id` 其实写在 ember 的
 *     `finalizeAction`（由 :19375 调用，在 `#resolveEventStream` 之后），干跑到 preActivate 为止，
 *     所以 N1 主要靠 ID2 的**源码扫描**兜底，那是二等证据。
 *  3. **依赖具体宿主的判定**。strike 类动作的 `range.maximum` 由该 actor 当前装备的武器
 *     决定（:4100-4105）；宿主空手时 `:4049 if(!strikes.length) return` 会让 maximum 停在 0。
 *     每条 finding 都带 `preparedAgainst`，换个宿主重跑结论可能变。
 *  4. **聊天卡宣称 vs 角色实况**（需要真发一次动作）、**babele 实际译条命中率**、
 *     **UI/窗口类缺陷**（I3 私人传记、I5 防御类型不显示、I6 夹击叠层）—— 全部不在动作层。
 *  5. **I4（重复准备叠伤害）**只在「同一实例被 prepare 两次」时显形；本脚本每条动作只
 *     prepare 一次，故不覆盖（脚本内附了 `checkIdempotency` 自检，见 §P，默认关；
 *     `crucibleSweep({checkIdempotent:true})` 打开后对同一 probe 再 prepare 一遍并比对
 *     cost / range / usage.bonuses，结果进 `R.stages.idempotencyFailures`）。
 *  6. **P1 / P3 / P4 / N4 / N5 / N6 / N7 / N11 / I2 / B1–B5 / D 组**：它们的判据分别在
 *     武器 slot 派生、天赋注入、聊天记录回溯、标签集合、词缀、伤害类型语义上，
 *     不是「动作能不能落地」这一层的问题，本遍历器不覆盖。
 *  7. **E2 只有启发式覆盖**（ID2/E2 是源码字面量比对，不是运行时验证）。
 *  8. 未被任何 actor 持有、且 `hostFallback` 关掉时的合集条目：`prepare()` 在 :19163
 *     因 `!this.actor` 直接 return，一行标签 prepare 都不跑 ⇒ 计入 `skipped.unprepared`。
 *
 * ---------------------------------------------------------------------------
 * 四、报数纪律
 * ---------------------------------------------------------------------------
 * 脚本里**不内嵌任何统计数字**。所有计数当场数出来，`R.scanned` / `R.stages` /
 * `R.coverage` 写清扫描口径（扫了哪些来源、过滤条件、怎么数的）。
 * 每条 finding 带 `preparedAgainst` / `stage` / `origin`，可复现到具体条目。
 * ========================================================================== */

(() => {

/* ============================================================================ */
/*  主函数                                                                      */
/* ============================================================================ */
globalThis.crucibleSweep = async function crucibleSweep({
  includePacks     = true,   // 扫合集（慢，但覆盖面大得多）
  includeAdventures= true,   // 冒险包：265 个 actor 全嵌在 1 个顶层文档里，不特判必然漏
  hostFallback     = true,   // 无宿主的合集条目：用一个挑定的 actor 现造实例来准备（见 §P 保真度警告）
  runPreActivate   = true,   // 跑 S2（preActivate 钩子）—— N1/N2 的活对象证据只在这一档
  scanHookSources  = true,   // 跑源码字面量扫描（ID2 / E2）
  scanEffectDocs   = true,   // 跑 ActiveEffect 文档扫描（E1）
  upstreamMode     = true,   // 跑之前挂起 tempfix 的 ACTION_PATCHES，测的是上游（见 §U）
  checkIdempotent  = false,  // 对每条动作跑两遍 prepare 并比对（I4 那一类），很慢
  maxUnits         = Infinity
} = {}) {

  const R = {
    _t: new Date().toISOString(),
    env: {},
    preconditions: {},
    host: null,            // 用来做准备的宿主 actor
    dummy: null,           // 用来当靶子的 actor
    scanned: {},           // 扫描口径
    stages: {},            // 每个检查点成功/失败的条数
    coverage: {},          // 每条断言覆盖了哪几条已知缺陷
    skipped: {},
    findings: [],
    byAssertion: {},
    writeAttempts: [],     // 写盘熔断记录 —— 正常必须是空数组
    dialogAttempts: [],    // 模态对话框熔断记录 —— 非空 = 跳过表漏了一个会弹框的钩子
    modalSkipped: [],      // 闸门① 主动跳过的会弹框的动作（记为「未覆盖」，不是「通过」）
    tempfixSuspended: [],
    errors: [],
    notes: []
  };

  const safe = (label, fn, d = null) => {
    try { return fn(); } catch (e) { R.errors.push(`${label}: ${e?.message ?? e}`); return d; }
  };
  /** ⚠ safe() 是同步的 —— 异步函数失败是 reject 不是 throw，包不住。异步一律走这个。 */
  const safeAsync = async (label, fn, d = null) => {
    try { return await fn(); } catch (e) { R.errors.push(`${label}: ${e?.message ?? e}`); return d; }
  };
  const add = (assertion, severity, o) => {
    const f = { assertion, severity, ...o };
    R.findings.push(f);
    (R.byAssertion[assertion] ??= []).push(f);
    return f;
  };
  /** actor.actions 是 Record（:36327），item.actions 可能是数组（:7726）。统一成数组。 */
  const toArray = c => {
    if ( !c ) return [];
    if ( Array.isArray(c) ) return c;
    if ( c instanceof Map || c instanceof Set ) return Array.from(c.values ? c.values() : c);
    if ( typeof c === "object" ) return Object.values(c);
    return [];
  };

  /* ========================================================================= */
  /*  §0 环境与前置                                                            */
  /* ========================================================================= */

  const S = globalThis.SYSTEM ?? globalThis.crucible?.CONST;
  if ( !S ) { R.errors.push("取不到 SYSTEM —— crucible 没装好，无法继续"); return R; }

  const TT = S.ACTION.TARGET_TYPES;          // :3413 起
  const SC = S.ACTION.TARGET_SCOPES;         // :3379 defineIntEnum
  const ID_RE = /^[a-zA-Z0-9]{16}$/;         // foundry:5725 isValidId

  R.env = safe("env", () => ({
    foundry: game.version,
    system: `${game.system.id} ${game.system.version}`,
    ember: game.modules.get("ember")?.active ? game.modules.get("ember").version : "(未启用)",
    tempfix: game.modules.get("ember-crucible-tempfix")?.active
      ? game.modules.get("ember-crucible-tempfix").version : "(未启用)",
    babele: game.modules.get("babele")?.active ? game.modules.get("babele").version : "(未启用)",
    canvasReady: !!canvas?.ready,
    gridDistance: safe("grid", () => canvas?.ready ? canvas.grid.distance : null, null),
    gridUnits: safe("gridu", () => canvas?.ready ? canvas.scene?.grid?.units : null, null),
    isGM: game.user.isGM
  }), {});

  /* ---- 宿主与靶子（要求：没选中任何 token 也要能跑） ---------------------- */
  /**
   * 宿主的挑法，从强到弱：
   *   ① 当前选中的 token 的 actor（GM 手动指定，保真度最高）
   *   ② game.user.character
   *   ③ 世界里第一个 hero 型 actor（有 token 的优先）
   * 都取不到 ⇒ 明确报「需要先选中一个角色」，仍然跑那些不需要宿主的断言
   * （ID2 / E2 源码扫描、E1 效果文档扫描，以及所有自带 actor 的动作条目）。
   */
  R.host = safe("host", () => {
    const controlled = canvas?.ready ? canvas.tokens?.controlled?.[0]?.actor : null;
    if ( controlled ) return {actor: controlled, how: "选中的 token"};
    if ( game.user.character ) return {actor: game.user.character, how: "game.user.character"};
    const heroes = game.actors.filter(a => a.type === "hero");
    const withToken = heroes.find(a => a.getActiveTokens?.(true, true)?.length);
    const pick = withToken ?? heroes[0] ?? game.actors.contents[0];
    return pick ? {actor: pick, how: "世界里挑的第一个角色（没选中 token）"} : null;
  }, null);

  R.dummy = safe("dummy", () => {
    const h = R.host?.actor;
    const others = game.actors.filter(a => a !== h && a.type !== "group");
    const withToken = others.find(a => a.getActiveTokens?.(true, true)?.length);
    const pick = withToken ?? others[0] ?? null;
    return pick ? {actor: pick, how: withToken ? "画布上有 token 的另一个 actor" : "世界里的另一个 actor"} : null;
  }, null);

  R.preconditions = {
    hasHost: !!R.host,
    hostName: R.host?.actor?.name ?? null,
    hostHow: R.host?.how ?? null,
    hasDummy: !!R.dummy,
    dummyName: R.dummy?.actor?.name ?? null,
    /** 没有 dummy ⇒ S2 里 ember 的 preActivate（ember:125605 `if (!target) return`）什么都不写，
     *  N1/N2 会**静默变绿**。所以这不是「通过」，是「未覆盖」。 */
    s2Usable: !!(R.dummy && runPreActivate),
    /**
     * B-W1 是**宿主相关**的断言：它只在 `usage.strikes` 为空时成立，
     * 而「空不空」取决于拿来准备的这个宿主有没有天生武器。
     * 宿主自带天生武器 ⇒ B-W1 一次都不会触发 ⇒ 报告里 I1 显示为「未命中」，
     * 读的人会以为 I1 不存在 —— 其实是**这次跑根本没能力判它**。
     * 所以把可判性单独记一格，别让它冒充「通过」。
     */
    w1Evaluable: safe("w1eval", () => {
      const a = R.host?.actor;
      if ( !a ) return false;
      const items = a.items?.contents ?? a.items ?? [];
      return ![...items].some(i => i?.system?.properties?.has?.("natural"));
    }, false),
    message: []
  };
  if ( !R.host ) R.preconditions.message.push(
    "⚠ 没找到可用的宿主角色：**请先选中一个角色的 token 再重跑**。" +
    "无宿主时只有源码扫描（ID2/E2）、效果文档扫描（E1），以及本身就挂在 actor 上的动作能判。");
  if ( !R.dummy && runPreActivate ) R.preconditions.message.push(
    "⚠ 世界里除宿主外没有第二个 actor：S2（preActivate）无法造靶子，" +
    "N1/N2 记为「未覆盖」而不是「通过」。");
  if ( !R.env.canvasReady ) R.preconditions.message.push(
    "⚠ canvas 未就绪：T3（贴身距离）仍可判（判据与格制无关），但 `gridDistance` 记为 null。");
  if ( R.host && !R.preconditions.w1Evaluable ) R.preconditions.message.push(
    `⚠ 宿主「${R.preconditions.hostName}」自带天生武器 ⇒ B-W1 的判据（usage.strikes 为空）` +
    "永远不成立，**I1 这次跑不出来**。报告里 I1 显示为「未命中」不等于 I1 不存在。" +
    "要判 I1：选中一个**没有天生武器**的角色 token 再重跑。");

  /* ========================================================================= */
  /*  §W 写盘熔断                                                              */
  /* ========================================================================= */
  /**
   * 唯一的收敛点是 **CONFIG.DatabaseBackend 实例**，不是 Document 原型：
   *   foundry:15108 Document.create   → foundry:14984 createDocuments → backend.create(:80377)
   *   foundry:15124 Document#update   → updateDocuments              → backend.update(:80427)
   *   foundry:15141 Document#delete   → deleteDocuments              → backend.delete(:80478)
   *   foundry:76615 foundry.documents.modifyBatch 第一行就是
   *                 CONFIG.DatabaseBackend.modifyDocumentBatch(:81203)
   *   :37545 _applyActionEffects 的落库出口走的就是 modifyBatch
   *
   * 为什么不打 Document 原型 —— 这是上一版最危险的一行：
   *   `patch(foundry.documents, "modifyBatch", …)`。`foundry.documents` 是
   *   **Object.freeze 的模块命名空间**（foundry:76621 起，`modifyBatch:` 成员在 :76693），
   *   严格模式下赋值抛 TypeError；而那行在 `try {` 之前，一抛就把已打上的 11 个
   *   Document 原型补丁**永久留在世界里**，GM 刷新前完全无法写入。
   *   顺带也避开 foundry:76116/76132/76151 MeasuredTemplateDocument 覆写静态方法的漏网。
   *
   * 本实现只加**实例自有属性**遮蔽原型方法，复原用 delete —— 即使中途抛异常，
   * 最坏结果也只是多留一个 own property，而不是改坏共享原型。
   */
  const installWriteFuse = () => {
    const targets = [];
    const be = CONFIG.DatabaseBackend;
    for ( const n of ["create", "update", "delete", "modifyDocumentBatch"] ) {
      if ( typeof be?.[n] !== "function" ) continue;
      if ( Object.prototype.hasOwnProperty.call(be, n) ) continue;   // 已被别人接管，不夺权
      targets.push([be, n, `DatabaseBackend#${n}`]);
    }
    // settings.set 的 client scope 不经 backend，单独遮一层
    if ( game.settings && !Object.prototype.hasOwnProperty.call(game.settings, "set") ) {
      targets.push([game.settings, "set", "ClientSettings#set"]);
    }
    for ( const [obj, key, label] of targets ) {
      Object.defineProperty(obj, key, {
        configurable: true, writable: true, enumerable: false,
        value: function() {
          const err = new Error(`写盘熔断：${label}`);
          R.writeAttempts.push({ method: label, stack: (err.stack || "").split("\n").slice(1, 8).join(" | ") });
          throw err;
        }
      });
    }
    return () => { for ( const [obj, key] of targets ) delete obj[key]; };
  };

  /* ========================================================================= */
  /*  §U 上游模式                                                              */
  /* ========================================================================= */
  /**
   * ⚠ 这不是可选项，是断言能不能用的前提。tempfix 自己就在 prepare/initialize 里改
   * range/target，**在准备后的活对象上判**如果不处理，装着 tempfix 跑会把这些判成「已修复」：
   *   tempfix:181  suddenBite.prepare       range.minimum=null / maximum=1   （P2 → T3）
   *   tempfix:512  heartSparkOfEmber        target.scope = ALL               （N4）
   *   tempfix:562  antigravityStone.prepare target.type = "self"             （N6）
   *   tempfix:612  tumble                   target.scope = ENEMIES           （C4）
   *   tempfix:632  dawnBeacon               target.scope = ENEMIES           （C5 → T1）
   * 全文 `this.range.*=` / `this.target.*=` 只有这 5 处，且全在 ACTION_PATCHES 体内；
   * UNIVERSAL_PATCHES / PROTOTYPE_PATCHES / HOOK_OVERRIDES 无一处写 range/target。
   *
   * 做法：`ACTION_PATCHES` 是活的可变对象，`_tests()` 包装器（tempfix:1411 安装，
   * :1421 现查 `ACTION_PATCHES[this.id]`）每次调用都重新读它 ⇒ 清空键即刻等于上游行为。
   * finally 里逐键还原，并把挂起的补丁名原样记进 R.tempfixSuspended。
   *
   * 注意：N10/N3/N2 的补丁是**通用补丁**（挂在 preActivate 上，对每个动作都跑），
   * 不在 ACTION_PATCHES 里，因此 D1/D2/K1 在装着 tempfix 时会看到「源坏、活好」——
   * 那三条断言各自比对 S0 与 S1/S2，命中时输出 `MASKED` 而不是「通过」。
   */
  const TF = globalThis.emberCrucibleTempFix;
  const suspended = {};
  const suspendTempfix = () => {
    if ( !(upstreamMode && TF?.ACTION_PATCHES) ) return () => {};
    for ( const k of Object.keys(TF.ACTION_PATCHES) ) {
      suspended[k] = TF.ACTION_PATCHES[k];
      delete TF.ACTION_PATCHES[k];
    }
    R.tempfixSuspended = Object.keys(suspended);
    return () => { for ( const [k, v] of Object.entries(suspended) ) TF.ACTION_PATCHES[k] = v; };
  };

  /* ========================================================================= */
  /*  §M 模态对话框熔断（BLOCKER 闸门 ②）                                       */
  /* ========================================================================= */
  /**
   * 四个 preActivate 钩子会 `await DialogV2.prompt(…)`：
   * amplifyAffix(:8755) / delay(:9231) / fieldStudy(:9479) / imbueAffix(:9724)。
   * 闸门 ① 的跳过表已经拦住这四个 id，但**跳过表是按 id 列的白名单，防不住新增的**——
   * 上游哪天再给别的动作加一个弹框钩子，脚本就又会挂在对话框上，
   * 而写盘熔断还遮着 DatabaseBackend，世界写不进任何东西。所以这里加第二道：
   * 把 `DialogV2.wait` 整个换掉（prompt/confirm/input 内部都转调它），
   * 任何漏网的弹框调用**立刻抛错并记账**，而不是无声等待。
   *
   * ⚠ 还原必须走 `getOwnPropertyDescriptor` + `defineProperty`。
   * 这四个方法是 `DialogV2` **类自身的 own static 属性**（foundry.mjs:37692 起），
   * 不是继承来的 —— 用 `delete` 还原会把真实实现**永久删掉**，
   * 直到刷新页面为止全世界的确认框都没了。
   */
  const installDialogFuse = () => {
    const D = foundry?.applications?.api?.DialogV2;
    if ( !D ) return () => {};
    const saved = [];
    for ( const n of ["wait", "prompt", "confirm", "input"] ) {
      const desc = Object.getOwnPropertyDescriptor(D, n);
      if ( !desc ) continue;                         // 上游改名了就别硬遮
      saved.push([n, desc]);
      Object.defineProperty(D, n, {
        ...desc,
        value: async function(...args) {
          const err = new Error(`模态对话框熔断：DialogV2.${n}`);
          R.dialogAttempts.push({
            method: `DialogV2.${n}`,
            stack: (err.stack || "").split("\n").slice(1, 8).join(" | ")
          });
          throw err;                                  // 立刻失败，绝不 await 住
        }
      });
    }
    return () => { for ( const [n, desc] of saved ) Object.defineProperty(D, n, desc); };
  };

  // ⚠ 先初始化成空函数再进 try：这三个装载动作本身也可能抛
  //   （`CONFIG.DatabaseBackend` 结构变了、`DialogV2` 换了命名空间……）。
  //   放在 try 外面就没人拆熔断，世界会一直写不进东西 —— 那正是本文件末尾 BLOCKER 的第三条。
  let restoreFuse = () => {};
  let restoreTempfix = () => {};
  let restoreDialog = () => {};

  try {
  restoreFuse = installWriteFuse();
  restoreDialog = installDialogFuse();
  restoreTempfix = suspendTempfix();

  /* ========================================================================= */
  /*  §E 枚举 —— 动作从哪来                                                    */
  /* ========================================================================= */
  /**
   * 递归到任意深度：冒险包顶层只有 1 个 Adventure 文档，265 个 actor 全嵌在
   * `doc.actors` 里，动作还要再下钻到 `actor.items[].actions`。
   * 顶层取样会漏掉绝大多数条目 —— 这个坑本项目踩过三次。
   */
  const units = [];
  const seen = new Set();
  const pushActions = (container, origin, actor = null, item = null) => {
    for ( const a of toArray(container) ) {
      if ( !a?.id ) continue;
      const key = `${origin}::${a.id}`;
      if ( seen.has(key) ) continue;
      seen.add(key);
      if ( units.length >= maxUnits ) return;
      units.push({ action: a, origin, actor: actor ?? a.actor ?? null, item });
    }
  };
  const packStats = [];
  const effectDocs = [];                    // D-E1 / D-D3 用
  const harvestActor = (actor, origin) => {
    pushActions(actor.actions, `${origin} > ${actor.name}`, actor);
    // 效果文档也要收：actor 自己身上的，以及**它每件物品自带的**。
    // 后者是 D-D3（N12）的主战场 —— 冒险包里 25 个坏时长效果（0.6.0 时 22 个，0.6.1 反而涨了）全都挂在
    // `doc.actors[].items[].effects[]` 上，只收 actions 会把它们整批漏掉。
    if ( scanEffectDocs ) {
      for ( const e of actor.effects ?? [] ) effectDocs.push({effect: e, origin: `${origin} > ${actor.name}`});
    }
    for ( const item of actor.items ?? [] ) {
      pushActions(item.actions, `${origin} > ${actor.name} > ${item.name}`, actor, item);
      if ( scanEffectDocs ) {
        for ( const e of item.effects ?? [] ) {
          effectDocs.push({effect: e, origin: `${origin} > ${actor.name} > ${item.name}`});
        }
      }
    }
  };

  const worldActors = Array.from(game.actors ?? []);
  for ( const a of worldActors ) safe(`world:${a.name}`, () => harvestActor(a, "world"));
  const worldActorUnits = units.length;
  for ( const i of Array.from(game.items ?? []) ) {
    safe(`worldItem:${i.name}`, () => pushActions(i.actions, `worldItem > ${i.name}`, null, i));
  }
  const worldItemUnits = units.length - worldActorUnits;

  if ( includePacks ) {
    for ( const pack of game.packs ) {
      const type = pack.metadata.type;
      if ( !["Item", "Actor", "Adventure", "ActiveEffect"].includes(type) ) continue;
      if ( (type === "Adventure") && !includeAdventures ) continue;
      const before = units.length;
      let docCount = 0;
      await safeAsync(`pack:${pack.collection}`, async () => {
        const docs = await pack.getDocuments();          // 纯读
        docCount = docs.length;
        for ( const doc of docs ) {
          if ( type === "Item" ) {
            pushActions(doc.actions, `${pack.collection} > ${doc.name}`, null, doc);
            for ( const e of doc.effects ?? [] ) effectDocs.push({effect: e, origin: `${pack.collection} > ${doc.name}`});
          }
          else if ( type === "Actor" ) harvestActor(doc, pack.collection);
          else if ( type === "ActiveEffect" ) effectDocs.push({effect: doc, origin: pack.collection});
          else {
            for ( const a of doc.actors ?? [] ) harvestActor(a, `${pack.collection} > ${doc.name}`);
            for ( const i of doc.items ?? [] ) {
              pushActions(i.actions, `${pack.collection} > ${doc.name} > ${i.name}`, null, i);
              if ( scanEffectDocs ) for ( const e of i.effects ?? [] ) {
                effectDocs.push({effect: e, origin: `${pack.collection} > ${doc.name} > ${i.name}`});
              }
            }
          }
        }
      });
      packStats.push({ pack: pack.collection, type, docs: docCount, actionsAdded: units.length - before });
    }
  }
  // world actor 与其物品的效果已在 harvestActor 里收过；这里只补世界层的独立物品
  if ( scanEffectDocs ) {
    for ( const i of Array.from(game.items ?? []) ) for ( const e of i.effects ?? [] ) effectDocs.push({effect: e, origin: `worldItem > ${i.name}`});
  }

  R.scanned = {
    口径: "world actors 的 actions + 其 items 的 actions；world items；" +
          (includePacks ? "全部 Item/Actor/Adventure/ActiveEffect 合集，冒险包递归下钻 doc.actors[].items[].actions" : "（未扫合集）"),
    去重键: "origin::actionId（同一 id 在不同持有者上算不同条目）",
    效果文档口径: "actor 自身 effects + 其每件物品的 effects + 世界独立物品 + Item/ActiveEffect 合集"
                + "（D-D3/N12 的目标就在 actor 内嵌物品那一层，只收 actions 会整批漏掉）",
    worldActors: worldActors.length,
    worldActorActions: worldActorUnits,
    worldItemActions: worldItemUnits,
    packsScanned: packStats.length,
    actionUnits: units.length,
    uniqueActionIds: new Set(units.map(u => u.action.id)).size,
    effectDocuments: effectDocs.length,
    packBreakdown: packStats
  };

  /* ========================================================================= */
  /*  §P 干跑 harness —— 三个检查点                                            */
  /* ========================================================================= */
  /**
   * S0  `action.toObject().effects`  —— 已过 `CrucibleAction.migrateData`(:21573，
   *     经 `CrucibleActionField extends EmbeddedDataField`(:22283) → foundry:11426 触发)
   *     与 schema 清洗的源形态。**注意**：`getDefaultAction` 这类独立构造的动作
   *     不走 EmbeddedDataField，因此不过 migrateData —— finding 里用 `origin` 区分。
   * S1  lazy clone + 手动 prepare()  —— `_prepareData`(:19064) + `_configureUsage`(:20283)
   *     + `_prepare`(:20314) + 标签/动作钩子的 prepare 全跑完。C1 的 `_id` 在这一档
   *     （`swallow.prepare` :10537-10539）。
   * S2  再跑 `_callActionHooksAsync("preActivate")` —— N1 的 `_id`（ember:125607）、
   *     N2 的顶层 changes（ember:125108/125151）在这一档。
   *
   * 为什么必须 lazy（:19137-:19160 逐条核过）：
   *   ① :19142 `context.usage = context.lazy ? deepClone(this.usage) : this.usage`
   *      —— **非 lazy 的 clone 与世界那份 usage 是同一个对象**（:18988 的注释明说
   *      usage 在同一 actor 的所有 clone 间共享）。而 prepare() 不幂等：
   *      `strike.prepare`(:4028) 会就地重置 usage.strikes / 写 actorStatus.hasAttacked，
   *      `usage.bonuses` 的归零只发生在 `_prepareData`(:19107) 而 prepare() 不调它，
   *      于是 `damageBonus += 6`(:4432) 每 prepare 一次叠一次（本模块 I4 修的就是这个）。
   *      不 lazy 就等于当场把 GM 会话里那个活动作改坏。
   *   ② :19037 `if (!options.lazy) this.prepare()` —— lazy 时构造期不自动 prepare，
   *      由我们控制时机。
   *   ③ :19152 `if (this.actor && !context.lazy)` —— `prepareActions` actor 钩子被跳过。
   *      **必须在 prepare() 之后手动补**：crucible 的 :12552 那个钩子读 `action.tags`，
   *      lazy clone 在 prepare 前 tags 只有 `_prepareData` 那一轮的结果。传一次性字面量
   *      对象，钩子里的 `delete actions[id]`（:12556 / ember:126108）只会动这个临时对象。
   *
   * deepClone 的残余风险（foundry:1819，:1846 对非 plain object **按引用返回**）：
   *   Set / Map / Document 不复制。stock crucible 的 usage 里只有 plain object / array /
   *   Item 引用，隔离成立；模块往 usage 上挂 Set/Map 会漏。`assertUsageIsolated` 做自检。
   */
  const assertUsageIsolated = (probe, source) => {
    if ( !probe || !source ) return null;
    if ( probe.usage === source.usage ) return "USAGE_SHARED";   // 致命：clone 没走 lazy
    const leaks = [];
    for ( const k of Object.keys(probe.usage ?? {}) ) {
      const v = probe.usage[k];
      if ( ((v instanceof Set) || (v instanceof Map)) && (v === source.usage?.[k]) ) leaks.push(k);
    }
    return leaks.length ? `USAGE_LEAK:${leaks.join(",")}` : null;
  };

  const stages = R.stages = {
    s0: 0, s1: 0, s2: 0,
    s1Failed: 0, s2Failed: 0,
    viaHost: 0,                 // 用 hostFallback 现造实例准备的条数
    usageIsolationWarnings: [],
    idempotencyFailures: []
  };
  R.skipped = { unprepared: 0, noRegion: 0, summon: 0, unknownTargetType: 0, weaponUnresolved: [] };

  /** S1：拿到「准备后」的独立副本。返回 {probe, via, host} 或 null。 */
  const prepareS1 = (u) => {
    const src = u.action;
    const own = u.actor ?? src.actor ?? null;
    // ① 有宿主：lazy clone
    if ( own ) {
      const probe = safe(`S1:${src.id}`, () => {
        const p = src.clone({}, {actor: own, lazy: true});
        p.prepare();                                       // :19162
        // 补回被 :19152 跳过的 actor 钩子，时机在 prepare 之后（钩子读的是准备后的 tags）
        safe(`S1hooks:${src.id}`, () => own.callActorHooks("prepareActions", {[p.id]: p}));
        return p;
      }, null);
      if ( !probe?._prepared ) return null;
      const iso = assertUsageIsolated(probe, src);
      if ( iso ) stages.usageIsolationWarnings.push({actionId: src.id, origin: u.origin, iso});
      return {probe, via: "clone", host: own};
    }
    // ② 无宿主：用挑定的宿主现造一个（保真度警告见抬头 §三.3）
    if ( !hostFallback || !R.host ) return null;
    const AC = globalThis.crucible?.api?.models?.CrucibleAction ?? src.constructor;
    const probe = safe(`S1c:${src.id}`, () => new AC(
      foundry.utils.deepClone(src.toObject()),
      {actor: R.host.actor, item: u.item ?? null, strict: false}   // :18992 usage 从 {} 起步，天然隔离
    ), null);
    if ( !probe?._prepared ) return null;
    stages.viaHost++;
    return {probe, via: "construct", host: R.host.actor};
  };

  /** S2：造靶子并跑 preActivate。只在需要「运行期写入」证据的断言里用。 */
  const buildDryTargets = (p, host) => {
    // 目标集按动作自己的形状造，**不调 acquireTargets**（:19442 依赖 game.user.targets 与
    // canvas 状态，:19478 的 default 分支还会弹 ui.notifications.warn）
    const mk = act => [act, {actor: act, uuid: act.uuid, name: act.name, token: null}];
    const cfg = TT[p.target?.type];
    if ( p.target?.type === "self" ) return new Map([mk(host)]);
    if ( p.target?.type === "none" ) return new Map();
    if ( p.target?.type === "summon" ) return new Map();                        // :19452
    if ( cfg?.region && [SC.NONE, SC.SELF].includes(p.target?.scope) ) return new Map();  // :19624 恒空
    const d = R.dummy?.actor;
    return d ? new Map([mk(d)]) : new Map();
  };
  /**
   * BLOCKER 闸门 ① —— preActivate 会弹模态对话框的动作 id。
   *
   * `runS2` 直接调 `_callActionHooksAsync("preActivate")`，**跳过了上游 `#use()` 里的
   * `_canUse()` 闸门**（crucible-compiled.mjs:19319-19323）。而这四个钩子会
   * `await DialogV2.prompt(…)`：amplifyAffix(:8755) / delay(:9231) / fieldStudy(:9479) / imbueAffix(:9724)。
   *
   * 其中 `delay` 最要命：它是 `DEFAULT_ACTIONS`（:4807）的成员，
   * `#prepareDefaultActions`（:42002）给**每一个** actor 无条件造一份 ——
   * 合集里约 300 条，加上世界里每个 actor 各一条。
   *
   * ⚠ 跳过必须走「未覆盖」而不是 `return null`：调用点把 `null` 当成「S2 跑通了」，
   * 会拿**没跑过 preActivate** 的形态去做 A-ID1 / A-K1 判定 —— 那是**假绿**，
   * 比不跑更糟。所以这里只登记，实际分流在调用点做。
   */
  const MODAL_PREACTIVATE_IDS = new Set(["delay", "fieldStudy", "imbueAffix", "amplifyAffix"]);

  const runS2 = async (p, host) => {
    // 复刻 #initializeSelfEvents(:19747-19753)：preActivate 钩子会读 selfUpdateEvent / selfEvents
    safe(`S2seed:${p.id}`, () => {
      const actorUpdates = foundry.utils.expandObject(p.usage.actorUpdates ?? {});
      actorUpdates.items ??= [];
      const itemSnapshots = p.usage.itemSnapshots?.length ? p.usage.itemSnapshots : [];
      p.recordEvent({type: "actorUpdate", actorUpdates, itemSnapshots}, {start: true});
      p.recordEvent({type: "activation", resources: []}, {start: true});
    });
    p.targets = buildDryTargets(p, host);
    // 只调钩子本身，不调 _preActivate(:20504) —— 后者还会跑 actor 钩子与 _canUse()
    try { await p._callActionHooksAsync("preActivate"); return null; }         // preActivate throws:true(:7385)
    catch (err) { return String(err?.message ?? err); }
  };

  /** 幂等自检（I4 那一类）：同一 probe 再 prepare 一次，比对关键派生值。 */
  const checkIdempotency = (p, u) => {
    const snap = () => JSON.stringify({
      cost: p.cost, range: p.range, bonuses: p.usage?.bonuses
    });
    const before = snap();
    safe(`idem:${p.id}`, () => p.prepare());
    if ( snap() !== before ) stages.idempotencyFailures.push({
      actionId: p.id, origin: u.origin, before, after: snap()
    });
  };

  /* ========================================================================= */
  /*  断言组 A · 效果能不能落地（读 S0 / S1 / S2）                             */
  /* ========================================================================= */

  /** 效果 schema 的六个键（:18624-18633）+ `_prepareData`(:19087-19099) 自己补的两个 */
  const FX_SCHEMA_KEYS = new Set(["name", "scope", "result", "statuses", "duration", "system"]);
  const FX_PREPARE_KEYS = new Set(["img", "tags"]);
  /** `#recordEffectEvents` 的解构（:19806）确实消费这两个，不算多余键 */
  const FX_CONSUMED_KEYS = new Set(["_id", "showIcon"]);

  /**
   * ── A-D1  duration.units ∈ {turns, months} ⇒ 效果压根不会被创建
   *    覆盖：**N10**（19 个动作：crucible 自己 7 个 + ember 侧敌手天赋与消耗品 13 个。
   *          Ember 0.6.1 已把九个血统的招牌变身全部迁好，别再拿它们当样本）
   *    机制：`CrucibleActiveEffect._preCreate`(:39581-39584) 对这两个单位
   *          `console.warn` + `return false` —— 文档不创建，聊天卡照写「获得…」。
   *    判据只读 S2（活对象）的 `effect.duration.units`。
   *    falsePositives：
   *      · 磁盘上的旧式 `{turns:N}` 由 `CrucibleAction.migrateData`(:21573) → 核心
   *        `#migrateDuration`(foundry:15931) 迁成 `units:"turns"`；但那条迁移有
   *        `typeof duration[unit] === "number"` 闸门，`{turns:null}` **不迁移**、
   *        `units` 保持 ""、不会撞 _preCreate。静态判据不加这道闸门会多报一批
   *        （abyssalRemains / abyssalWhip / elementalSummonSprite / elementalSummonVisitor /
   *        extrudeTendril / graveMark 这类）。**读活对象自动避开**，无须模拟。
   *      · 本模块 N10 补丁把 units 改成 rounds ⇒ 源坏活好 ⇒ 输出 MASKED，不是「通过」。
   *      · penetratingThrow / explosiveEmergence / whirlwind / sentinelSpin / wildStrike /
   *        kineticWall 的 effects 数组是空的，本断言对它们零读取，结构上不可能误报；
   *        tailSweep 有效果但 units 是 rounds，不触发。
   */
  const A_D1 = (fx, srcFx, ctx) => {
    const u = fx?.duration?.units;
    if ( !["turns", "months"].includes(u) ) {
      if ( ["turns", "months"].includes(srcFx?.duration?.units) ) add("A-D1", "MASKED", {...ctx,
        kind: "EFFECT_DURATION_REJECTED",
        detail: `源 units="${srcFx.duration.units}"，运行期已被改成 "${u ?? ""}" —— ` +
                "本模块（或别的模块）的补丁盖住了上游缺陷，不是上游修好了",
        covers: "N10"});
      return;
    }
    add("A-D1", "blocker", {...ctx, kind: "EFFECT_DURATION_REJECTED",
      observed: {units: u, value: fx.duration.value ?? null, expiry: fx.duration.expiry ?? null},
      detail: `duration.units="${u}" ⇒ CrucibleActiveEffect._preCreate(:39581-39584) 直接 return false，` +
              "ActiveEffect 永不创建（聊天卡上仍然白纸黑字写着「获得…」）",
      covers: "N10",
      player: "卡上写着获得效果，角色身上一个图标都没有"});
  };

  /**
   * ── A-D2  duration 有 value 没 units ⇒ 整段被丢弃
   *    覆盖：**N3**（sentinelKick 的踉跄永不消失，每回合 −2 动作点）
   *    机制：`#recordEffectEvents` :19810
   *          `duration.units ? duration : (duration.expiry ? {expiry} : undefined)`
   *          ⇒ 无 units 时数值被丢；连 expiry 也没有则整段 undefined ⇒ 核心 AE schema
   *          回落 `value ??= Infinity` ⇒ isTemporary 假 ⇒ 连过期注册表都不进。
   *    falsePositives：
   *      · `{value:null, units:""}` 是**合法的「无时限」写法**，`Number.isFinite` 已排除。
   *      · value 有值、units 空、但 expiry 有值 ⇒ :19810 只保留 {expiry}，效果仍会按事件
   *        过期，只是数值被吞 ⇒ 降为 warn，文案说清「不是永不过期，是数值被丢」。
   */
  const A_D2 = (fx, srcFx, ctx) => {
    const d = fx?.duration ?? {};
    if ( !Number.isFinite(d.value) || d.units ) {
      if ( Number.isFinite(srcFx?.duration?.value) && !srcFx?.duration?.units && d.units )
        add("A-D2", "MASKED", {...ctx, kind: "EFFECT_DURATION_DROPPED",
          detail: `源 {value:${srcFx.duration.value}, units:""}，运行期已补成 units="${d.units}"`,
          covers: "N3"});
      return;
    }
    add("A-D2", d.expiry ? "warn" : "blocker", {...ctx, kind: "EFFECT_DURATION_DROPPED",
      observed: {value: d.value, units: d.units ?? "", expiry: d.expiry ?? null},
      detail: d.expiry
        ? `value=${d.value} 无 units：:19810 只留 {expiry:"${d.expiry}"}，数值被丢弃（仍会按事件过期）`
        : `value=${d.value} 无 units 无 expiry：:19810 整段丢弃 ⇒ 核心 AE value??=Infinity ⇒ 效果永不过期`,
      covers: "N3",
      player: "负面状态挂上去就再也掉不了"});
  };

  /**
   * ── A-ID1  活对象上的非法效果 `_id` ⇒ 整个动作崩在出卡之前
   *    覆盖：**C1**（swallow，"swallowed00000000" 17 字符，写在 `prepare()` :10537-10539 ⇒ S1 抓）
   *          **N1**（abyssMarkUnmaking，"abyssMarkUnmak0" 15 字符，写在 preActivate
   *                 ember:125607 ⇒ **必须 S2 才抓得到**）
   *    机制链：`_id` **不在** effects schema（:18624-18633 只有六个键）⇒ 磁盘上写了也会被
   *          `SchemaField#_cleanType`/`#cleanKeys`(foundry:9704/9739) 剪掉 ⇒
   *          **活对象上出现 `_id` 一定是运行期代码写的**。:19812 是 `_id || getEffectId(...)`，
   *          硬编码值 truthy 压过自动生成 ⇒ `#resolveEventStream`(:19374) →
   *          `_applyActionEffects(…, {commit:false})`(:37501) → `this.effects.createDocument(data)`(:37532)
   *          → foundry:6175 `new ActiveEffect(data)`（默认 strict）→ DocumentIdField
   *          → foundry:5725 `/^[a-zA-Z0-9]{16}$/` ⇒ 抛。
   *          :19370 `#recordEffectEvents()` 与 :19374 `#resolveEventStream()` **不在**
   *          `#use()` 的任何一个 try/catch 内（那四个 try 在 :19322/:19338/:19351/:19360），
   *          所以异常一路逃出 `#use()`，**崩在 :19388 toMessage 之前** ⇒ 资源不扣、卡不出。
   *    falsePositives：
   *      · 判据是精确正则，无灰区。
   *      · 唯一的假阳来源是「这条效果本来就发不出去所以不会崩」—— 与 A-T1/A-R1 交叉抑制；
   *        但**不降级**：swallow 的第 0 条效果 scope=ENEMIES 且必有目标，必然触发。
   *      · 本模块的 C1/N1 补丁换成合法 id ⇒ 走 MASKED 分支。
   */
  const A_ID1 = (fx, ctx, stage) => {
    if ( !("_id" in (fx ?? {})) ) return;
    const v = String(fx._id);
    if ( ID_RE.test(v) ) return;
    add("A-ID1", "blocker", {...ctx, stage, kind: "EFFECT_ID_INVALID",
      observed: {_id: v, length: v.length},
      detail: `运行期在 ${stage} 写入的效果 _id "${v}"（${v.length} 字符）不满足 ` +
              "foundry:5725 的 16 位校验 ⇒ :37532 createDocument 当场抛，" +
              "异常逃出 #use() 且发生在三处写盘之前 ⇒ 资源不扣、聊天卡不生成",
      covers: stage === "S1" ? "C1" : "N1",
      player: "点了什么都不发生，只有控制台一条未捕获异常"});
  };

  /**
   * ── A-K1  活对象上出现 schema 之外的效果顶层键 ⇒ 载荷被丢
   *    覆盖：**N2**（ember:125108 / :125151 把 changes 写在 effect 顶层，
   *                 强化护盾 / 泰拉菲克变形的加值一条都不生效）
   *    机制：schema 只有六个键(:18624-18633)；`#recordEffectEvents` 的解构(:19806)与
   *          重建(:19811-19818)也只认那几个 + `_id` / `showIcon`。顶层 `changes` 既不在
   *          schema 里、也不被解构 ⇒ 静默蒸发。
   *    **必须区分两种同症状**（否则会把 N2 报成误报）：
   *      ① 磁盘上写在顶层的 changes —— 核心 `BaseActiveEffect.migrateData`(foundry:15873)
   *         会把它搬进 `system.changes`（`_addDataFieldMigration` foundry:15640；
   *         `DataField#clean` foundry:8865 先迁移后清洗），**有兜底、不是缺陷**；
   *         而且清洗之后 S0 上根本看不到它。
   *      ② ember 的钩子在**运行时**写的顶层 changes —— 发生在迁移之后，不受兜底保护。
   *    所以判据只认「S1/S2 上出现、而 S0 上没有」的键 ⇒ 精确指向 ②。
   *    falsePositives：
   *      · `_id` / `showIcon` 是被 :19806 真正消费的键（`showIcon` 还在 :19820 写回），
   *        不是多余载荷 ⇒ 白名单排除（`_id` 的合法性由 A-ID1 单独判）。
   *      · `img` / `tags` 由 `_prepareData`(:19087-19099) 自己补 ⇒ 白名单排除。
   */
  const A_K1 = (fx, srcFx, ctx, stage) => {
    for ( const k of Object.keys(fx ?? {}) ) {
      if ( FX_SCHEMA_KEYS.has(k) || FX_PREPARE_KEYS.has(k) || FX_CONSUMED_KEYS.has(k) ) continue;
      if ( srcFx && (k in srcFx) ) continue;                  // S0 就有 ⇒ 走核心迁移兜底，不报
      const v = fx[k];
      const empty = (v == null) || (Array.isArray(v) && !v.length)
        || ((typeof v === "object") && !Array.isArray(v) && !Object.keys(v).length);
      add("A-K1", empty ? "info" : "blocker", {...ctx, stage, kind: "EFFECT_TOPLEVEL_KEY",
        observed: {key: k, empty, preview: safe("k1", () => JSON.stringify(v)?.slice(0, 160), "(不可序列化)")},
        detail: `${stage} 阶段在效果顶层写了 schema 之外的键 "${k}"。` +
                "动作效果 schema(:18624-18633) 只有 name/scope/result/statuses/duration/system；" +
                ":19806 的解构与 :19811 的重建都不含它 ⇒ 载荷静默蒸发。" +
                "（这不是磁盘数据 —— S0 上没有这个键，核心的顶层→system 迁移兜底够不着运行期写入）",
        covers: (k === "changes") ? "N2" : "(新)",
        player: k === "changes" ? "图标挂上了，加值一条都不生效" : "效果的某部分载荷无声丢失"});
    }
  };

  /**
   * ── A-R1  result 闸门在「不掷骰的动作」上永不成立
   *    覆盖：**X1** 的 repugnantPustules（描述承诺「暴击时目标染疫」，动作自己一颗骰都不掷）
   *    机制：`#testEventResult`(:19906-19931) 在空 events 上：
   *          any → true(:19909)；custom → false(:19911)；`all && !hasRolls` → false(:19913)；
   *          `success && !all && !hasRolls` → true(:19915)；
   *          successCritical / failure / failureCritical → `find` 得 undefined → false。
   *    判据只读活对象的 `usage.hasDice`（准备后的真值）+ `_tests()` 里有没有 roll 提供者。
   *    falsePositives：
   *      · **绝不能**用「tags 里有没有掷骰标签」做前置过滤 —— 那是假阴性发生器：
   *        `strike.prepare`(:4049) 是 `if (!strikes.length) return;`，带 strike 系标签但取不到
   *        武器的动作 hasDice 停在 false，那恰恰是 I1 那一类真缺陷的形状。
   *      · 钩子可以直接 `recordEvent({type:"strike", roll})` 而不置 hasDice ⇒ 有 roll /
   *        postActivate 钩子的动作降级为 suspect，人工确认后再入基线。
   *      · `result.type:"custom"` 本就是「留给钩子处理」的设计（:19910 注释）⇒ 同样降 suspect。
   *      · 语料实测 `result.all === true` 与 `custom` 各 0 条 —— 这两个子句目前是死代码，
   *        断言的全部工作量压在 hasDice 这一个门上，读者不要高估它的独立性。
   */
  const NEVER_WITHOUT_ROLLS = new Set(["successCritical", "failure", "failureCritical"]);
  const A_R1 = (fx, ctx, p) => {
    if ( p.usage?.hasDice ) return;
    const rollers = safe("r1t", () => Array.from(p._tests()).filter(t => typeof t?.roll === "function"), []);
    if ( rollers.length ) return;
    const r = fx?.result ?? {};
    const type = r.type ?? "success";
    const dead = (type === "custom") || (r.all && (type !== "any")) || NEVER_WITHOUT_ROLLS.has(type);
    if ( !dead ) return;
    const hooky = !!(p.hooks?.roll || p.hooks?.postActivate);
    add("A-R1", (hooky || (type === "custom")) ? "suspect" : "blocker", {...ctx,
      kind: "EFFECT_RESULT_UNREACHABLE",
      observed: {resultType: type, all: !!r.all, hasDice: !!p.usage?.hasDice,
                 hookNames: Object.keys(p.hooks ?? {})},
      detail: `result={type:"${type}", all:${!!r.all}}，而准备后 usage.hasDice=false 且 _tests() 里` +
              "没有任何 roll 提供者 ⇒ #testEventResult([],…)(:19906-19931) 恒返回 false ⇒ 效果永不施加",
      covers: "X1",
      player: "描述承诺的附带效果从来不会发生"});
  };

  /* ========================================================================= */
  /*  断言组 B · 区域几何与取靶（读 S1）                                       */
  /* ========================================================================= */
  /**
   * `#getRegionData` 是 ActionUseDialog 的 **# 私有方法**（:2859，类在 :2396），
   * 外部够不着；唯一调用点 :2739 在 #onPlaceRegion 里，要么要用户拖鼠标（:2811），
   * 要么构造 RegionDocument（:2756）。好在**英尺量级的几何完全不需要 canvas** ——
   * :2861 的 `d = distancePixels` 只是最后乘上去的换算。下面逐行复算 :2864-2956：
   *
   *   :2864 maxRange  = range.maximum ?? 0
   *   :2865 baseRange = target.size ? target.size : maxRange
   *   :2866 addRange  = regionConfig.addSize ? (actor.size / 2) : 0
   *
   *   circle    半径 = baseRange + addRange   :2883
   *   cone      半径 = baseRange + addRange   :2893
   *   emanation 半径 = baseRange + addRange   :2909（另带 base:{type:"token"} 底座）
   *   line      长度 = maxRange  + addRange   :2919   ← **不吃 baseRange**
   *   rectangle 高   = maxRange               :2931   ← **不吃 baseRange**
   *   覆写（:2943-2955）：
   *     summon → 边长 = target.size ?? region.size ?? 1（:2945-2946，把 rectangle 的高整个盖掉）
   *     ray    → **target.size 只设射线宽度**（:2951），不参与长度 ← kineticWall 被漏报的根因
   *     wall   → 只改 elevation
   *   :2939 的 default 分支上游直接抛 —— 未知 shape 要如实报「上游会抛」。
   */
  const spanOf = (p, rc) => {
    const maxRange = p.range?.maximum ?? 0;                       // :2864
    const size = p.target?.size;
    switch ( rc.shape ) {
      case "line":
        return {span: maxRange, formula: "line.length = (maxRange + addRange)·d  (:2919)",
                note: "target.size 在 :2951 只设射线宽度，不参与长度"};
      case "circle": case "cone": case "emanation":
        return {span: (size ? size : maxRange),
                formula: `${rc.shape}.radius = (baseRange + addRange)·d，baseRange = target.size || range.maximum (:2865)`,
                note: rc.shape === "emanation" ? "emanation 自带 token 底座，半径 0 时形状就是施法者自己的足迹" : null};
      case "rectangle":
        return null;                                              // summon 专用，:2946 覆写
      default:
        return {span: null, unsupported: true, formula: `未知形状 "${rc.shape}"：:2939 的 default 分支上游会抛`};
    }
  };

  /* ========================================================================= */
  /*  主循环                                                                   */
  /* ========================================================================= */

  /** 伤害类型标签集（:4638 起 TAGS 会把每个伤害类型动态塞进标签表），B-X1 的「声明攻击意图」判据用 */
  const DMG = safe("dmg", () => new Set(Object.keys(S.DAMAGE_TYPES ?? {})), new Set());

  for ( const u of units ) {
    const src = u.action;
    const s0 = safe(`S0:${src.id}`, () => src.toObject().effects ?? [], []);
    stages.s0++;

    const got = prepareS1(u);
    if ( !got ) { R.skipped.unprepared++; continue; }
    const p = got.probe;
    stages.s1++;
    if ( checkIdempotent ) checkIdempotency(p, u);

    const t = p.target ?? {};
    const rng = p.range ?? {};
    const cfg = TT[t.type];
    const tags = safe("tags", () => Array.from(p.tags ?? []), []);
    const ctxBase = {
      actionId: p.id,
      actionName: p.name,
      origin: u.origin,
      preparedAgainst: `${got.host?.name ?? "(无)"} [${got.via}]`,
      preparedTarget: {type: t.type, size: t.size ?? null, scope: t.scope, self: !!t.self},
      preparedRange: {minimum: rng.minimum ?? null, maximum: rng.maximum ?? null, weapon: !!rng.weapon},
      tags
    };

    /* ---- A 组：S1 上的效果检查 ---------------------------------------- */
    /** ⚠ 必须**深拷贝快照**：`p.effects` 的元素在 S2 阶段是被钩子**就地改写**的，
     *  直接持引用会让「S1 有没有、S2 才出现」这个分档失效（两边指向同一个对象）。 */
    const fxS1 = toArray(p.effects).map(e => safe("snap", () => foundry.utils.deepClone(e), e));
    for ( const [i, fx] of fxS1.entries() ) {
      const ctx = {...ctxBase, effectIndex: i, effectName: fx?.name ?? null};
      A_ID1(fx, ctx, "S1");
      A_K1(fx, s0[i], ctx, "S1");
    }

    /* ---- B 组：几何与取靶 --------------------------------------------- */
    if ( !cfg ) { R.skipped.unknownTargetType++; }
    else if ( t.type === "summon" ) { R.skipped.summon++; }       // 几何被 :2946 覆写、取靶 :19452 提前返回
    else if ( cfg.region ) {
      /**
       * ── B-G1  区域几何退化：跨度为 0
       *    覆盖：**C6**（steamVent 半径退化）、**kineticWall**（射线长度退化）
       *    span=0 之后只剩 addRange = actor.size/2（:2866；`actor.size` 是 system.movement.size，
       *    单位是尺不是格 —— 佐证 :9210 直接把它赋给 range.maximum、:32000 与武器射程相加）。
       *    circle/cone/emanation：半径 size/2 的圆**恰好内切于施法者自己的足迹**（token 宽高
       *    就是 actor.size，origin 是 token 中心 :2738），`testInsideRegion` 要求候选 token 的
       *    包含测试点落进多边形，别的 token 一个点都进不来；再叠 :19623 在 target.self 假时
       *    先排除施法者 ⇒ 目标恒 0。
       *    ⚠ line **不能这么说**：`LineShapeData._getRays` 的宽度是以原点为中心的
       *    （foundry:71795-71801），kineticWall 退化后是「长 ≈ size/2 尺、宽 10 尺
       *    （target.size 经 :2951）」的横条，侧向贴边的 token 是吃得到的。所以它的缺陷是
       *    **「墙」只有两尺长**（且本该写 target.type:"wall"），不是「目标恒 0」。
       *    falsePositives（拿已知误报逐条验过，全部不再命中）：
       *      1. thrown 在准备期补距（:4251 `??= 10`）⇒ penetratingThrow 不命中。
       *      2. strike 按武器射程补距（:4104，门是 `range.weapon === true`）⇒
       *         explosiveEmergence / tailSweep / whirlwind / sentinelSpin / penetratingShot 不命中。
       *      3. 15 个动作钩子在 prepare 里补 range/target（:8904 :9175 :9210 :9272 :9280 :9533
       *         :9541 :9958 :10207-08 :10698 :10890-91 :10941-42 :10969 :11027-28）—— 同样，读准备后的值即可。
       *      **排除法一律是「只读准备后的值」，不做任何 range.weapon 式的静态白名单豁免。**
       *      4. `range.weapon===true` 但宿主空手 ⇒ :4049 提前 return，maximum 停 0。几何确实退化，
       *         但成因是装备不是数据 ⇒ 查 `usage.strikes.length`，为 0 就记进
       *         `skipped.weaponUnresolved` 不报（换个带武器的宿主重跑即消失）。
       *      5. summon 硬跳过（上面已处理）。
       *      6. aura（emanation）span=0 时形状恰等于施法者足迹；若某条 aura 的设计意图就是
       *         「只影响站我格子里的人」会是误报 —— 当前语料里 7 条 aura 全带 size 或 maximum。
       *      7. 若上游将来在 preActivate 之后才改几何，本断言会误报。已核实 crucible 的全部
       *         range/target 写点（4104 / 4251-52 / 8904 / 9175 / 9210 / 9272 / 9280 / 9533 / 9541 /
       *         9958 / 10207-08 / 10698 / 10890-91 / 10941-42 / 10969 / 11027-28 / 13458-59 / 45557）
       *         无一例外都在 prepare（或 gesture 的 initialize）里；ember 侧 0 处。
       */
      const g = spanOf(p, cfg.region);
      if ( g?.unsupported ) {
        add("B-G1", "warn", {...ctxBase, kind: "REGION_SHAPE_UNKNOWN", detail: g.formula, covers: "(新)"});
      }
      else if ( g && (g.span === 0) ) {
        const strikes = safe("strikes", () => toArray(p.usage?.strikes).length, 0);
        const indeterminate = (rng.weapon === true) && !strikes;
        if ( indeterminate ) R.skipped.weaponUnresolved.push({
          actionId: p.id, origin: u.origin, preparedAgainst: ctxBase.preparedAgainst});
        else {
          const addRange = cfg.region.addSize ? ((got.host?.size ?? 0) / 2) : 0;
          const isLine = cfg.region.shape === "line";
          add("B-G1", "blocker", {...ctxBase, kind: "REGION_SPAN_ZERO",
            observed: {span: 0, shape: cfg.region.shape, residualAddRange: addRange,
                       addSize: !!cfg.region.addSize, strikesResolved: strikes},
            detail: `${t.type}（${cfg.region.shape}）准备完成后跨度仍为 0。${g.formula}` +
                    (g.note ? `；${g.note}` : ""),
            reasoning: !addRange ? "addSize 为假，形状尺寸精确为 0"
              : isLine
                ? `长度塌缩到 addRange = actor.size/2 = ${addRange} 尺（:2866），` +
                  `而宽度仍按 target.size=${t.size ?? "(无)"} 走 :2951 ⇒ 「墙」只有 ${addRange} 尺长`
                : `半径只剩 addRange = actor.size/2 = ${addRange} 尺（:2866），` +
                  "该圆恰好内切于施法者自己的足迹；再叠 :19623 在 target.self 假时先排除施法者 ⇒ 目标恒 0",
            covers: (p.id === "steamVent") ? "C6" : (p.id === "kineticWall" ? "kineticWall" : "(新)"),
            player: isLine ? "描述写着一道长墙，画出来只有脚下一小条"
                           : "范围模板画出来了，却缩在施法者脚下，怎么摆都框不住人"});
        }
      }

      /**
       * ── B-T1 / B-T2  区域取靶：disposition 集为空
       *    覆盖：**C5**（dawnBeacon：60 尺光柱画得出来，一个目标都取不到）
       *    机制（这是本组最容易写错的一条，行号逐个核过）：
       *      `#getTargetDispositions()`(:19731-19739) 在 scope 为 NONE/SELF 时返回 **[]**(:19735)。
       *      区域路径 :19624 `if (!targetDispositions.includes(tokenDoc.disposition)) continue;`
       *        —— **没有 .length 守卫**，`[].includes()` 恒假 ⇒ 每个候选都被跳过 ⇒ 目标恒 0。
       *      单体路径 :19686-19687 写的是 `if (targetDispositions.length && !…)`，上游注释还专门
       *        说明「空集意味着 scope NONE/SELF，此处不受限」。**两条路径语义相反。**
       *    falsePositives：
       *      · **绝不能判「effect.scope ≠ target.scope 就报」**：`#getQualifyingEvent`(:19865-19895)
       *        对非 self 目标**根本不查阵营**，effect.scope=ENEMIES 配 target.scope=ALLIES 时效果
       *        照样落在盟友身上 —— 那是设计取向，不是落地失败。语料里这类组合有几十条。
       *      · summon 的 scope 按 TARGET_TYPES 就是 SELF 且 :19452 提前返回 ⇒ 已硬跳过。
       *      · 法术姿态的 scope 由 :45557 从 TARGET_TYPES 反写、composed 又被 `reshape.prepare`(:13458)
       *        覆写成 ALLIES/ENEMIES ⇒ 读准备后的值自动排除。
       *      · **若该动作的效果全是 SELF 作用域，零外部目标是无害的**（:19799 会把施法者补进
       *        allActors，自身效果照常应用）⇒ 自动降级到 minor。dawnBeacon 不属于这种：
       *        它唯一那条效果是 ENEMIES 作用域，:19874 的 canAffectSelf 对自身 return false
       *        ⇒ **整条动作完全空转**。
       *      · scope NONE 也可能是「不打算取靶、靠钩子结算」⇒ 严重度只给 major，
       *        并把该 id 的钩子注册状况一并报出来供人工裁决。
       */
      const effScopes = safe("effscope", () => toArray(p.effects).map(e => e?.scope ?? t.scope), []);
      const allSelfEffects = effScopes.length > 0 && effScopes.every(s => s === SC.SELF);
      const hookNames = Object.keys(p.hooks ?? {});
      if ( t.scope === SC.SELF ) {
        add("B-T1", allSelfEffects ? "minor" : "blocker", {...ctxBase, kind: "REGION_SCOPE_SELF",
          observed: {effectScopes: effScopes, allEffectsSelfScoped: allSelfEffects, hookNames},
          detail: "区域类型 + target.scope=SELF：:19735 返回空数组，:19624 的 includes 恒假 ⇒ 目标恒 0。" +
                  (allSelfEffects
                    ? "但本动作的效果全是 SELF 作用域 —— :19799 会把施法者补进 allActors，自身效果照常应用，故降级"
                    : "且效果不是全 SELF 作用域，:19874 的 canAffectSelf 对自身 return false ⇒ 整条动作空转"),
          covers: (p.id === "dawnBeacon") ? "C5" : "(新)",
          player: "范围放出来、聊天卡出了，目标栏是空的，一颗骰子都不掷"});
      }
      else if ( t.scope === SC.NONE ) {
        add("B-T2", "major", {...ctxBase, kind: "REGION_SCOPE_NONE",
          observed: {effectScopes: effScopes, hookNames},
          detail: "区域类型 + target.scope=NONE：同 :19735 空集 ⇒ 取靶恒 0；" +
                  "且 :19871 `#getQualifyingEvent` 对 scope NONE 直接 return false",
          caveat: "scope NONE 也可能是「本来就不取靶、靠钩子结算」的写法 —— " +
                  `本条动作注册的钩子：${hookNames.length ? hookNames.join("/") : "**一个都没有**"}`,
          covers: "(新)",
          player: "区域模板放得下去，但没有任何目标被记录"});
      }

      /**
       * ── B-I1  区域动作上的 range.minimum 是死字段（info）
       *    `range.minimum` 一共**三个**消费点：
       *      :19692 `#acquireSingleTargets` —— **仅 single**，读派生值
       *      :3054  移动规划 planMovement({minDistance}) —— 仅 movement
       *      :20190 `_getWeaponAvailability` —— 读 **`this._source.range.minimum`**，
       *             对任何带 strike 链、且当前有目标的动作生效（含区域类）
       *    区域类型里没有一个会把它当「内圈半径」——那个语义在 crucible 里不存在。
       *    falsePositives：带 strike 链的区域动作（:20190 会读它）⇒ 用
       *      `tags.includes("strike") || usage.weaponChoices.length` 排除，
       *      lunariumTidalWave（natural→melee→strike）正是靠这条被排掉。
       */
      if ( (rng.minimum ?? 0) > 0 ) {
        const strikeChain = tags.includes("strike")
          || safe("wc", () => toArray(p.usage?.weaponChoices).length, 0) > 0;
        if ( !strikeChain ) add("B-I1", "info", {...ctxBase, kind: "REGION_MINIMUM_INERT",
          detail: `range.minimum=${rng.minimum} 写在区域类型上，但三个消费点没有一个会读它：` +
                  ":19692 仅 single、:3054 仅 movement、:20190 需要 strike 链解析出武器",
          covers: "(新)",
          player: "无可观察症状 —— 只说明数据里有个不起作用的字段"});
      }
    }
    else if ( t.type === "single" ) {
      /**
       * ── B-T3  single + minimum > 0 ⇒ **贴身永远打不到**
       *    覆盖：**P2**（凯思血统的猝然撕咬，min=2 max=2，贴着敌人反而咬不到）
       *    机制：`getLinearRange`(:32122-32159) 量的是**基座到基座**，
       *          `ab.overlaps(tb)` 与贴边一律返回 **0**（:32129-32134）；
       *          :19692 `if (this.range.minimum && (range < this.range.minimum))` ⇒
       *          minimum > 0 时相邻目标必然被 MinimumRange 拒。
       *    为什么不用「可达距离集 {0, gd, 2gd, …} 与 [min,max] 无交」那条：
       *      crucible 在方格场景上**强制微格**（`Scene#prepareBaseData` :40311-40317：
       *      SQUARE + ft + distance===5 + size%5===0 ⇒ `grid.distance = 1`），
       *      可达集是 {0,1,2,3,…} 尺，suddenBite 的 [2,2] 反而**可达** ⇒ 那条判据在真实
       *      世界里是空转，P2 会漏报。本判据与格制完全无关。
       *    严重度：`maximum <= minimum`（窗口退化成一条线且贴身被排除）⇒ major；否则 info
       *      （比如 implacableHunter min=1 max=60，只是标记不了贴身目标，属设计取舍）。
       *    falsePositives：
       *      · movement 类型走 :3054 的连续距离规划，不受此限 ⇒ 判据只对 single 生效。
       *      · 区域类型根本不读 minimum ⇒ 同上。
       *      · minimum 为 0/null 时 :19692 的 `&&` 短路 ⇒ 不设门，自动不报。
       */
      const min = rng.minimum ?? 0;
      if ( min > 0 ) {
        const max = rng.maximum;
        const degenerate = (max != null) && (max <= min);
        add("B-T3", degenerate ? "major" : "info", {...ctxBase, kind: "SINGLE_MIN_EXCLUDES_ADJACENT",
          observed: {minimum: min, maximum: max ?? null, gridDistance: R.env.gridDistance},
          detail: `single 的 range.minimum=${min} > 0。getLinearRange(:32129-32134) 对足迹重叠或` +
                  "贴边一律返回 0 ⇒ :19692 的 MinimumRange 把**所有相邻目标**排除" +
                  (degenerate ? `；而 maximum=${max} <= minimum，可用窗口退化成一条线` : ""),
          covers: (p.id === "suddenBite") ? "P2" : "(新)",
          player: degenerate ? "贴着打说太近，退开又说太远 —— 这个动作几乎点不出去"
                             : "贴身的目标选不中，必须先退开"});
      }
    }
    else R.skipped.noRegion++;

    /**
     * ── B-W1  带 natural 标签却一件天生武器都没有，动作照样可用
     *    覆盖：**I1**（狂野打击没有天生武器也能用，白刷动作点）
     *    机制：`natural.canUse`(:4272-4276) 是
     *          `if (!this.usage.strikes.every(w => w.system.properties.has("natural"))) throw`
     *          —— `[].every(...)` 对空数组返 **true** ⇒ 空手时闸门放行；
     *          而 `strike.prepare`(:4049) `if (!strikes.length) return;` 又让它一颗骰都不掷。
     *    判据必须在活对象上：`usage.strikes.length === 0` 且 `_canUse()`(:20355，纯读+抛)
     *    不抛、且 `_displayOnSheet()`(:20479) 为真（真的会显示在卡上给人点）。
     *    falsePositives：
     *      · 换一个有天生武器的宿主就消失 —— 所以 finding 必带 `preparedAgainst`，
     *        它描述的是「这个宿主 + 这条动作」的组合，不是纯数据缺陷。
     *      · 资源不足等原因导致 `_canUse` 抛时不报（那时按钮本来就是灰的）。
     */
    if ( tags.includes("natural") ) {
      const strikes = safe("w1s", () => toArray(p.usage?.strikes).length, 0);
      if ( strikes === 0 ) {
        const canUse = safe("w1c", () => { p._canUse(); return true; }, false);
        const shown = safe("w1d", () => p._displayOnSheet(), false);
        if ( canUse && shown ) add("B-W1", "major", {...ctxBase, kind: "NATURAL_NO_STRIKES",
          observed: {strikes: 0, canUse: true, displayOnSheet: true},
          detail: "带 natural 标签但准备后 usage.strikes 为空：natural.canUse(:4272) 的 " +
                  "`[].every(...)` 返回 true ⇒ 闸门放行；strike.prepare(:4049) 的 " +
                  "`if(!strikes.length) return` ⇒ 一颗骰都不掷。动作可点、动作点照扣、什么都不发生",
          covers: "I1",
          player: "点了扣动作点，什么都没打出来"});
      }
    }

    /**
     * ── B-X1  声明了攻击意图，却没有任何 roll 提供者
     *    覆盖：**X1**（令人作呕的脓疱 / 深渊遗骸：描述承诺的伤害完全不会发生）
     *    判据（三重，缺一不可，全部读活对象）：
     *      ① `usage.hasDice === false`（准备后的真值 —— 直接置它的只有
     *         strike:4056 / hazard:4291 / generic:4317 / healing:4548 / rallying:4561 /
     *         每个技能标签:4720 / 姿态:13356 / Counterspell:22177 / 法术 :21951/:21957）
     *      ② `_tests()`(:20220，yield 标签 handler + `this.hooks`) 里没有任何 roll 函数
     *         —— `this.hooks` 来自 `crucible.api.hooks.action[id]` 注册表，**只有运行时才有**，
     *         离线永远算不准这一格，这正是遍历器的不可替代价值
     *      ③ 动作**声明了攻击意图**：usage.defenseType 有值，或 tags 里带伤害类型
     *    falsePositives：
     *      · 纯自身增益 / 布景类动作 hasDice 天然为假 ⇒ 靠 ③ 排除。
     *      · `composed` / `spell` / `iconicSpell` 走 `CrucibleSpellAction`（:22024/:22096/:22185
     *        覆写了 _roll），但 darkflameCirclet 这种把 composed 打在**基类**上的（那是 N7）
     *        会漏出来 ⇒ 显式按标签排除，交给 N7 的判据处理。
     */
    const spellish = tags.some(x => ["composed", "spell", "iconicSpell"].includes(x));
    if ( !spellish && !p.usage?.hasDice ) {
      const rollers = safe("x1t", () => Array.from(p._tests()).filter(x => typeof x?.roll === "function"), []);
      const declaresCombat = !!p.usage?.defenseType || tags.some(x => DMG.has(x));
      if ( !rollers.length && declaresCombat ) add("B-X1", "major", {...ctxBase, kind: "NO_ROLL_PROVIDER",
        observed: {hasDice: false, defenseType: p.usage?.defenseType ?? null,
                   damageTags: tags.filter(x => DMG.has(x)), hookNames: Object.keys(p.hooks ?? {})},
        detail: "动作声明了攻击意图（防御类型或伤害类型标签），但准备后 usage.hasDice=false " +
                "且 _tests()(:20220，标签 handler + crucible.api.hooks.action[id]) 里没有任何 roll 提供者 " +
                "⇒ 不会记录任何 strike 事件 ⇒ 伤害恒为 0",
        covers: "X1",
        player: "描述里写的伤害一点都打不出来"});
    }

    /* ---- S2：跑 preActivate，取运行期写入的证据 ------------------------ */
    // 闸门 ①：会弹模态对话框的四个 id 一律不跑 S2，落到下面的「未覆盖」分支去。
    const s2Blocked = MODAL_PREACTIVATE_IDS.has(p.id);
    if ( s2Blocked && runPreActivate && R.preconditions.s2Usable ) {
      R.modalSkipped.push({ actionId: p.id, origin: u.origin });
    }
    if ( runPreActivate && R.preconditions.s2Usable && !s2Blocked ) {
      const err = await runS2(p, got.host);
      if ( err ) { stages.s2Failed++; R.errors.push(`S2:${p.id}: ${err}`); }
      else stages.s2++;
      const fxS2 = toArray(p.effects);
      for ( const [i, fx] of fxS2.entries() ) {
        const ctx = {...ctxBase, effectIndex: i, effectName: fx?.name ?? null};
        // S1 已报过的不重复报：baseline 取「磁盘键 ∪ S1 快照键」，只留 S2 新出现的
        const before = fxS1[i];
        if ( !before || (before._id !== fx._id) ) A_ID1(fx, ctx, "S2");
        A_K1(fx, {...(s0[i] ?? {}), ...(before ?? {})}, ctx, "S2");
        A_D1(fx, s0[i], ctx);
        A_D2(fx, s0[i], ctx);
        A_R1(fx, ctx, p);
      }
    }
    else {
      // 没有 S2（要么全局没开、要么被闸门① 拦下）：
      // D1/D2/R1 仍然可以在 S1 上判（它们读的字段准备期就定了），
      // 但 ID1/K1 的 preActivate 那一档记为「未覆盖」而不是「通过」。
      for ( const [i, fx] of fxS1.entries() ) {
        const ctx = {...ctxBase, effectIndex: i, effectName: fx?.name ?? null};
        A_D1(fx, s0[i], ctx);
        A_D2(fx, s0[i], ctx);
        A_R1(fx, ctx, p);
      }
    }
  }

  /* ========================================================================= */
  /*  断言组 C · 源码字面量扫描（二等证据，明确标注）                          */
  /* ========================================================================= */
  /**
   * ── C-ID2  钩子源码里的非法效果 id 字面量
   *    覆盖：**C1**（swallow 的 `_SWALLOWED_EFFECT_ID = "swallowed00000000"`，17 字符，:10530）
   *          **N1**（ember 的 `_id = "abyssMarkUnmak0"`，15 字符）
   *    为什么需要它：dry-run 只跑到 preActivate，而 :9692 / :10289 / :10576 / ember 的一批
   *    `_id` 写在 **postActivate** 里（写到 `event.effects[0]` 而不是 `this.effects`），
   *    活对象抓不到。这条用源码兜底，**是启发式二等证据**，不能当运行时验证用。
   *    扫描口径：遍历 `crucible.api.hooks` 的**全部命名空间**（:14044 起共 10 个：
   *      accessory / action / affix / armor / consumable / spell / spellcraft / talent / tool / weapon
   *      —— ember 用 `Object.entries(hooks)` 往全部命名空间合并，只扫 action/talent 会漏），
   *    跳过非对象成员（HOOK_PARTIAL 是字符串、formatHookContext 是函数）。
   *    两种命中形态：
   *      · 配置常量：属性名以 id 结尾、值是字符串字面量（如 `_SWALLOWED_EFFECT_ID`）
   *      · 钩子源码：函数体里紧贴 `_id:` / `_id =` 的字符串字面量
   *    falsePositives：
   *      · 只认紧贴 `_id` 的字面量与名字以 id 结尾的常量 ⇒ 排除掉注册表本身的 16 位 key
   *        （warden0000000000 / runewarden000000 / shieldward000000 之类）与其它无关串。
   *      · 命中里要区分「会抛的写入点」与「静默丢弃的删除存根」：`_applyActionEffects`(:37526)
   *        要求 `existing` 才会进 toDelete，找不到就静默丢弃 ⇒ `_action:"delete"` 那种不会抛。
   *        本脚本无法从字面量判断上下文，一律标 heuristic，由人工裁决。
   */
  const idUniverse = new Set();     // C-E2 用：所有「真实会被生成」的效果 id
  if ( scanHookSources ) safe("C-ID2", () => {
    const getEffectId = S.EFFECTS?.getEffectId;
    if ( getEffectId ) for ( const u of units ) {
      const n = toArray(u.action.effects).length;
      for ( let i = 0; i < n; i++ ) safe("uni", () => idUniverse.add(getEffectId(u.action.id, {suffix: String(i)})));
      safe("uni0", () => idUniverse.add(getEffectId(u.action.id)));
    }
    for ( const {effect} of effectDocs ) if ( effect?.id ) idUniverse.add(effect.id);

    const hooks = globalThis.crucible?.api?.hooks ?? {};
    for ( const [ns, reg] of Object.entries(hooks) ) {
      if ( !reg || (typeof reg !== "object") ) continue;                 // 跳过 HOOK_PARTIAL / formatHookContext
      for ( const [key, cfgObj] of Object.entries(reg) ) {
        if ( !cfgObj || (typeof cfgObj !== "object") ) continue;
        for ( const [name, v] of Object.entries(cfgObj) ) {
          if ( typeof v === "string" ) {
            if ( /id$/i.test(name) && !ID_RE.test(v) ) add("C-ID2", "heuristic", {
              kind: "HOOK_SOURCE_BAD_ID", namespace: ns, hookKey: key, at: name,
              observed: {literal: v, length: v.length}, tier: "config-const",
              detail: `钩子注册表常量 ${ns}.${key}.${name} = "${v}"（${v.length} 字符），不满足 foundry:5725 的 16 位校验`,
              covers: (v.length === 17) ? "C1" : ((v.length === 15) ? "N1" : "(新)")});
            continue;
          }
          if ( typeof v !== "function" ) continue;
          const src = safe("fnsrc", () => Function.prototype.toString.call(v), "");
          for ( const m of src.matchAll(/_id\s*[:=]\s*["'`]([^"'`]*)["'`]/g) ) {
            if ( ID_RE.test(m[1]) ) { idUniverse.add(m[1]); continue; }
            add("C-ID2", "heuristic", {kind: "HOOK_SOURCE_BAD_ID", namespace: ns, hookKey: key, at: name,
              observed: {literal: m[1], length: m[1].length}, tier: "hook-source",
              detail: `${ns}.${key}.${name}() 源码里写着 _id = "${m[1]}"（${m[1].length} 字符）` +
                      "⇒ :19812 的 `_id || getEffectId(...)` 让它压过自动生成 ⇒ :37532 createDocument 抛",
              caveat: "无法从字面量判断这是创建点还是 `_action:\"delete\"` 存根；后者只会静默丢弃、不抛",
              covers: (m[1].length === 17) ? "C1" : ((m[1].length === 15) ? "N1" : "(新)")});
          }
        }
      }
    }
  });

  /**
   * ── C-E2  钩子里按「猜出来的 id」查效果，查询串与真实生成结果对不上
   *    覆盖：**E2**（威伦 Wirrun 猎物加骰 / 弗尔金哈尔 Vrjnhar 强健体力从来没触发过）
   *    机制：效果 id 由 `getEffectId(label, {suffix})`(:5358) = `generateId(label, 16-suffix.length)`
   *          (:48066，camelCase 后 slice/padEnd 到定长) 生成。钩子若手写一个「看起来像」的
   *          16 位串去 `effects.has(...)` 查，只要 generateId 的结果差一个字符就永远查不到。
   *    判据：把「本次扫描能生成的全部效果 id」+「效果文档的真实 id」+「源码里合法的 _id 字面量」
   *          并成一个宇宙，再扫钩子源码里 `effects.has("…")` / `effects.get("…")` 的 16 位字面量，
   *          不在宇宙里的报出来，并给出前缀最接近的候选。
   *    ⚠ 这是**启发式**：宇宙不可能完备（没装的模块、动态生成的状态效果 id 都不在里面），
   *      所以 severity 一律 heuristic，报告里必须人工核对。E1（抗性 NaN）与 E2 都不是
   *      「动作能不能落地」这一层的问题，本遍历器只能提供线索。
   *    falsePositives：宇宙不完备导致的假阳是主要风险；用「前缀候选」列出来辅助人工排除。
   */
  if ( scanHookSources ) safe("C-E2", () => {
    const hooks = globalThis.crucible?.api?.hooks ?? {};
    const near = lit => Array.from(idUniverse).filter(x => x.slice(0, 8) === lit.slice(0, 8)).slice(0, 5);
    for ( const [ns, reg] of Object.entries(hooks) ) {
      if ( !reg || (typeof reg !== "object") ) continue;
      for ( const [key, cfgObj] of Object.entries(reg) ) {
        if ( !cfgObj || (typeof cfgObj !== "object") ) continue;
        for ( const [name, v] of Object.entries(cfgObj) ) {
          if ( typeof v !== "function" ) continue;
          const src = safe("fnsrc2", () => Function.prototype.toString.call(v), "");
          for ( const m of src.matchAll(/effects\??\.(?:has|get)\(\s*["'`]([A-Za-z0-9]{16})["'`]\s*\)/g) ) {
            if ( idUniverse.has(m[1]) ) continue;
            add("C-E2", "heuristic", {kind: "STALE_EFFECT_LOOKUP", namespace: ns, hookKey: key, at: name,
              observed: {query: m[1], nearest: near(m[1])},
              detail: `${ns}.${key}.${name}() 里 effects.has("${m[1]}")，但本次扫描能生成的效果 id ` +
                      `宇宙（${idUniverse.size} 个：全部动作的 getEffectId(:5358) 产物 + 效果文档真实 id + ` +
                      "源码里合法的 _id 字面量）里没有这一条 ⇒ 该分支可能从来没触发过",
              caveat: "启发式：id 宇宙不可能完备（未装模块、动态状态效果不在其中），必须人工核对",
              covers: "E2"});
          }
        }
      }
    }
  });

  /* ========================================================================= */
  /*  断言组 D · ActiveEffect 文档（不是动作层，单列）                         */
  /* ========================================================================= */
  /**
   * ── D-E1  change 的 key 打在 SchemaField 上 ⇒ 派生值变 NaN
   *    覆盖：**E1**（Ward of Stabilization 把酸性抗性算成 NaN，此后每次酸性结算都传播 NaN）
   *    机制：`system.resistances.acid` 是一个 SchemaField（下面才是 base/bonus/total 这些叶子）。
   *          `add` 型 change 取 `getProperty(actor, key)` 得到一个**对象**，`Number(对象) + delta`
   *          ⇒ NaN，并顺着抗性结算一路传播。正确写法是打在叶子上（`.bonus`）。
   *    判据（活判据，比白名单准）：把 key 去掉 `system.` 前缀后用
   *          `CONFIG.Actor.dataModels[type].schema.getField(path)`(foundry:9662) 解析，
   *          解析结果是 SchemaField（或解析不到）⇒ 报。
   *    falsePositives：
   *      · `scaleResource` 型 change **故意**打在 SchemaField 上（:39488 `getProperty(actor, key)`
   *        取的就是整个资源池对象，再改它的 max）⇒ 按 `change.type` 显式豁免。
   *      · `.immune` 这类布尔叶子会被白名单式判据误报（语料里有 10 条），
   *        用 schema 解析后它是 BooleanField，**自动不报**。
   *      · 解析不到的 key 可能是别的模块加的字段 ⇒ 单独标 `unresolved`，降为 warn。
   */
  const EFFECT_CHANGE_EXEMPT_TYPES = new Set(["scaleResource"]);
  if ( scanEffectDocs ) safe("D-E1", () => {
    const models = CONFIG.Actor?.dataModels ?? {};
    const resolve = path => {
      const seen = [];
      for ( const [type, cls] of Object.entries(models) ) {
        const f = safe("gf", () => cls.schema?.getField(path), undefined);
        if ( f ) seen.push({type, field: f.constructor?.name, isSchema: f instanceof foundry.data.fields.SchemaField});
      }
      return seen;
    };
    let scanned = 0, changes = 0;
    for ( const {effect, origin} of effectDocs ) {
      scanned++;
      for ( const c of toArray(effect?.system?.changes) ) {
        changes++;
        if ( !c?.key || !String(c.key).startsWith("system.") ) continue;
        if ( EFFECT_CHANGE_EXEMPT_TYPES.has(c.type) ) continue;
        const path = String(c.key).slice("system.".length);
        const seen = resolve(path);
        if ( !seen.length ) {
          add("D-E1", "warn", {kind: "CHANGE_KEY_UNRESOLVED", origin, effectName: effect.name,
            observed: {key: c.key, type: c.type ?? null, value: c.value ?? null},
            detail: `change 的 key 在任何一个 Actor 数据模型的 schema 里都解析不到` +
                    "（可能是别的模块加的字段，也可能是拼写错）",
            covers: "(新)"});
          continue;
        }
        if ( seen.every(s => s.isSchema) ) {
          add("D-E1", "blocker", {kind: "CHANGE_KEY_NOT_LEAF", origin, effectName: effect.name,
            observed: {key: c.key, type: c.type ?? null, value: c.value ?? null,
                       resolvedAs: seen.map(s => `${s.type}:${s.field}`)},
            detail: `change 的 key 打在 SchemaField（非叶子）上：取到的是一个对象，` +
                    "`Number(对象) + delta` ⇒ **NaN**，并顺着后续结算一路传播。正确写法是打在叶子字段上（如 `.bonus`）",
            covers: "E1",
            player: "这一路的抗性/防御从此显示为 NaN，所有相关结算都失真"});
        }
      }
    }
    R.scanned.effectChangesScanned = changes;
    R.scanned.effectDocsScanned = scanned;
  });

  /**
   * ── D-D3  效果**文档**上的 duration.units ∈ {turns, months} ⇒ 这个效果永远建不出来
   *    覆盖：**N12**（N10 的另一半：不由动作产出、`preActivate` 够不着的那批）
   *    机制：与 A-D1 同一道拦截 —— `CrucibleActiveEffect._preCreate`(:39581-39584)
   *          对这两个单位直接 `return false`。区别只在**这个效果从哪来**：
   *          A-D1 读的是动作的 `effects[]`，这里读的是**物品文档自己的 `effects[]`**。
   *          后者的创建路径（`transfer:true` 的持有即生效、GM 手动拖、宏里
   *          `createEmbeddedDocuments`）一条都不经过动作。
   *    ⚠ 已经**存在于世界里**的效果文档不会再走 `_preCreate` —— 能扫到它就说明它建成了
   *      （多半是 crucible 加这道拦截之前建的）。所以真正的受害者是**尚未创建**的那批，
   *      也就是合集里的模板。因此这里对 world 与 pack 两个来源分开标注严重度：
   *      pack 来源 = major（拖上桌时必然失败），world 来源 = info（已经建成了，只是不该建成）。
   */
  if ( scanEffectDocs ) safe("D-D3", () => {
    for ( const {effect, origin} of effectDocs ) {
      const u = effect?.duration?.units;
      if ( (u !== "turns") && (u !== "months") ) continue;
      const fromWorld = String(origin).startsWith("world");
      add("D-D3", fromWorld ? "info" : "major", {
        kind: "EFFECT_DOC_DURATION_REJECTED", origin, effectName: effect.name,
        observed: {units: u, value: effect?.duration?.value ?? null,
                   transfer: effect?.transfer ?? null, parent: effect?.parent?.name ?? null},
        detail: "效果**文档**（不是动作产出的效果）的 duration.units 是 " +
                `"${u}"，而 CrucibleActiveEffect._preCreate(:39581) 对这两个单位直接 return false` +
                (fromWorld ? " —— 本条已经在世界里，说明它是加这道拦截之前建的"
                           : " ⇒ 从合集拖上桌时这个效果建不出来"),
        covers: "N12",
        player: u === "turns" ? "物品/天赋挂上了，该带的效果却一直没出现" : "同上"});
    }
  });

  /* ========================================================================= */
  /*  §R 报告                                                                  */
  /* ========================================================================= */

  if ( !R.preconditions.s2Usable ) R.notes.push(
    "S2（preActivate）未运行 ⇒ A-ID1 的 S2 档与 A-K1 的 S2 档记为**未覆盖**，不是「通过」。" +
    "N1（abyssMarkUnmaking 的 _id）与 N2（顶层 changes）本轮只有 C-ID2 的源码级证据。");
  if ( R.tempfixSuspended.length ) R.notes.push(
    "已挂起 tempfix 的 ACTION_PATCHES ⇒ B 组测的是上游原状；" +
    "但 N10/N3/N2 的**通用补丁**不在 ACTION_PATCHES 里，它们的命中会显示为 MASKED（源坏、活好）。" +
    "要拿到完全干净的上游读数，请把模块整体停用后重跑，两份报告对照。");
  if ( R.stages.viaHost ) R.notes.push(
    `有 ${R.stages.viaHost} 条动作没有自己的宿主，是拿「${R.host?.actor?.name}」现造实例准备的：` +
    "strike 类动作的 range.maximum 取决于该宿主当时的装备（:4100-4105），" +
    "thrown 的 `??= 10`（:4251）也只在此前没人填过时生效 ⇒ 换宿主结论可能变，看 finding 的 preparedAgainst。");

  R.coverage = {
    "A-D1 EFFECT_DURATION_REJECTED": "N10（19 个动作 units:\"turns\" 的效果永不创建；Ember 0.6.1 已迁走一大半，crucible 自己那 7 个没动）",
    "A-D2 EFFECT_DURATION_DROPPED":  "N3（sentinelKick 踉跄永不过期）",
    "A-ID1 EFFECT_ID_INVALID":       "C1（swallow 17 字符，S1 档）/ N1（abyssMarkUnmaking 15 字符，S2 档）",
    "A-K1 EFFECT_TOPLEVEL_KEY":      "N2（ember 运行期往效果顶层写 changes）",
    "A-R1 EFFECT_RESULT_UNREACHABLE":"X1 的效果侧（result 闸门在无骰动作上恒不成立）",
    "B-G1 REGION_SPAN_ZERO":         "C6（steamVent 半径退化）/ kineticWall（射线长度退化）",
    "B-T1 REGION_SCOPE_SELF":        "C5（dawnBeacon 取不到目标）",
    "B-T2 REGION_SCOPE_NONE":        "（无对应已知条目，需人工裁决）",
    "B-T3 SINGLE_MIN_EXCLUDES_ADJACENT": "P2（suddenBite 贴身咬不到）",
    "B-I1 REGION_MINIMUM_INERT":     "（info，无对应已知条目）",
    "B-W1 NATURAL_NO_STRIKES":       "I1（wildStrike 空 strikes 仍可用）"
                                     + (R.preconditions.w1Evaluable ? "" : " ⚠ 本次不可判：宿主自带天生武器"),
    "B-X1 NO_ROLL_PROVIDER":         "X1（缺 roll 提供者，伤害恒 0）",
    "C-ID2 HOOK_SOURCE_BAD_ID":      "C1 / N1 的源码级证据（补 postActivate 盲区，二等证据）",
    "C-E2 STALE_EFFECT_LOOKUP":      "E2（按猜出来的 id 查效果，启发式）",
    "D-E1 CHANGE_KEY_NOT_LEAF":      "E1（ward 抗性 NaN）",
    "D-D3 EFFECT_DOC_DURATION_REJECTED": "N12（物品文档自带效果的 turns 时长，preActivate 够不着）"
  };

  const SEV_ORDER = ["blocker", "major", "warn", "suspect", "minor", "heuristic", "info", "MASKED"];
  R.findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  R.summary = {
    findings: R.findings.length,
    bySeverity: R.findings.reduce((acc, f) => (acc[f.severity] = (acc[f.severity] ?? 0) + 1, acc), {}),
    byAssertion: Object.fromEntries(Object.entries(R.byAssertion).map(([k, v]) => [k, v.length])),
    coversHit: Array.from(new Set(R.findings.map(f => f.covers).filter(x => x && (x !== "(新)")))).sort(),
    writeAttempts: R.writeAttempts.length,
    dialogAttempts: R.dialogAttempts.length,
    modalSkipped: R.modalSkipped.length,
    errors: R.errors.length
  };

  return R;

  } finally {
    // ⚠ 这几行比任何一条断言都重要：熔断留着不复原，这个世界在刷新之前完全无法写入。
    //   逐个 try —— 前一个还原抛错不能连累后面的。
    try { restoreTempfix(); } catch (e) { console.error("还原 tempfix 失败", e); }
    try { restoreDialog(); }  catch (e) { console.error("还原对话框熔断失败", e); }
    try { restoreFuse(); }    catch (e) { console.error("还原写盘熔断失败", e); }
  }
};

/* ============================================================================ */
/*  自动跑一遍并分层打印                                                        */
/* ============================================================================ */
const banner = (t) => console.log(`%c${t}`, "font-size:13px;font-weight:bold");

// ⛔ 不再自动运行 —— 见文件末尾的 BLOCKER 说明。
// 这个包装只负责在你手动调用时把报告打出来；粘贴脚本本身不会触发任何扫描。
const run = Promise.resolve({ blocked: true, reason: "未自动运行；见文件末尾说明" });
globalThis.crucibleSweepReport = async opts => globalThis.crucibleSweep(opts).then(R => {
  if ( R?.blocked ) return R;
  banner("crucible 全动作干跑遍历器");
  console.log(R);

  if ( R.preconditions?.message?.length ) {
    banner("前置条件");
    for ( const m of R.preconditions.message ) console.warn(m);
  }

  banner("§1 扫描口径（数字全部当场数出来）");
  console.log(R.scanned);
  console.log("检查点：", R.stages, "跳过：", R.skipped);
  if ( R.tempfixSuspended?.length )
    console.log(`%c已临时挂起 tempfix 的 ${R.tempfixSuspended.length} 条 ACTION_PATCHES（测的是上游）：`,
      "color:#c80", R.tempfixSuspended.join(", "));

  banner("§2 写盘熔断");
  if ( R.writeAttempts.length ) {
    console.error("⚠ 有代码试图写盘！这不该发生，请把下表贴回来：");
    console.table(R.writeAttempts);
  } else console.log("%c✔ 全程零写盘（DatabaseBackend 的 create/update/delete/modifyDocumentBatch 与 settings.set 均未被调用）", "color:#4a4");

  if ( R.notes.length ) {
    banner("§2b 读这份报告之前必须知道的事");
    for ( const n of R.notes ) console.warn(n);
  }

  banner("§3 命中汇总");
  console.log(R.summary);
  console.table(Object.entries(R.byAssertion).map(([a, list]) => ({
    断言: a, 命中: list.length, 覆盖: R.coverage[Object.keys(R.coverage).find(k => k.startsWith(a)) ?? ""] ?? ""
  })));

  banner("§4 逐条命中（按严重度）");
  for ( const [a, list] of Object.entries(R.byAssertion) ) {
    console.groupCollapsed(`${a} — ${list.length} 条`);
    console.table(list.map(f => ({
      严重度: f.severity, 动作: f.actionId ?? f.hookKey ?? f.effectName, 名称: f.actionName ?? f.at ?? "",
      覆盖: f.covers ?? "", 阶段: f.stage ?? "", 准备于: f.preparedAgainst ?? "", 出处: f.origin ?? f.namespace ?? ""
    })));
    console.log(list);
    console.groupEnd();
  }

  if ( R.skipped?.weaponUnresolved?.length ) {
    banner("§5 不可判：range.weapon 为真但宿主空手（换个带武器的宿主重跑）");
    console.table(R.skipped.weaponUnresolved);
  }
  if ( R.stages?.usageIsolationWarnings?.length ) {
    console.warn("⚠ usage 隔离自检报警（deepClone 对 Set/Map 按引用返回，foundry:1846）：",
      R.stages.usageIsolationWarnings);
  }
  if ( R.errors.length ) {
    banner("§6 错误（不是缺陷，是脚本自己跑不通的地方）");
    console.log(R.errors);
  }

  banner("§7 这个脚本抓不到什么");
  console.log([
    "区域动作的真实取靶（:19614 无 region 时返回空，那个空不是证据）",
    "postActivate / confirm 阶段的写入（N1 只能靠 C-ID2 源码扫描兜底）",
    "依赖具体宿主装备的判定（每条 finding 带 preparedAgainst，换宿主结论可能变）",
    "聊天卡宣称 vs 角色实况、babele 译条命中率、UI/窗口类缺陷（I3/I5/I6）",
    "I4 重复准备叠伤害（默认关；crucibleSweep({checkIdempotent:true}) 打开）",
    "P1/P3/P4/N4/N5/N6/N7/N11/I2/B1-B5/D 组 —— 判据不在「动作能不能落地」这一层",
    "C-E2 与 D-E1 是效果层不是动作层，且 C-E2 是启发式"
  ]);

  console.log("%c重跑：await crucibleSweep({includePacks:true, runPreActivate:true, upstreamMode:true})",
    "color:#888");
  return R;
});

/* ============================================================================
 * BLOCKER 已修复（本轮）—— 记录当初是什么、两道闸怎么补的
 * ----------------------------------------------------------------------------
 * 问题：`runS2` 直接 `await p._callActionHooksAsync("preActivate")`，
 * **跳过了上游 `#use()` 里的 `_canUse()` 闸门**（crucible-compiled.mjs:19319-19323）。
 * 而 crucible 有四个 preActivate 钩子会 `await DialogV2.prompt(…)`：
 *   amplifyAffix(:8755) / delay(:9231) / fieldStudy(:9479) / imbueAffix(:9724)
 * `delay` 是 `DEFAULT_ACTIONS`（:4807）的成员，`#prepareDefaultActions`（:42002）
 * 给**每一个** actor 无条件造一份 —— 合集里约 300 条，加上世界里每个 actor 各一条。
 * 后果里最糟的一条：写盘熔断在脚本卡在对话框期间一直遮着 `CONFIG.DatabaseBackend`，
 * **世界在把几百个对话框点完或 F5 之前写不进任何东西。**
 *
 * 三处修复：
 *  ① `MODAL_PREACTIVATE_IDS` 跳过表（§S2 上方）。调用点走「未覆盖」分支，
 *     **不是** `return null` —— 后者会被记成「S2 跑通了」，然后拿没跑过 preActivate
 *     的形态去做 A-ID1/A-K1 判定，那是假绿。被跳过的条目登记进 `R.modalSkipped`。
 *  ② `installDialogFuse()` 遮 `DialogV2.wait/prompt/confirm/input`（§M）。
 *     跳过表是按 id 列的白名单，防不住上游新增的弹框钩子；这道闸让漏网的调用
 *     **立刻抛错并记进 `R.dialogAttempts`**，而不是无声 await 住。
 *     还原走 `getOwnPropertyDescriptor` + `defineProperty` —— 这四个是 `DialogV2`
 *     **类自身的 own static 属性**（foundry.mjs:37692 起），用 `delete` 还原会把
 *     真实实现永久删掉，刷新前全世界的确认框都没了。
 *  ③ `installWriteFuse()` / `installDialogFuse()` / `suspendTempfix()` 全部移进 `try`，
 *     三个 restore 先初始化成空函数 —— 装载动作本身抛错时也保证 finally 拆得掉熔断。
 *
 * 跑法（仍建议先备份世界、且没有其他人在线 —— 它会对约 300 个动作跑准备与 preActivate）：
 *
 *     await crucibleSweep()
 *     await crucibleSweep({ includePacks: true, runPreActivate: true, upstreamMode: true })
 *
 * 跑完必看两个数：`R.summary.writeAttempts` 与 `R.summary.dialogAttempts`，
 * **正常都应该是 0**。非 0 说明有代码试图写盘 / 弹框，被熔断挡下了 —— 那本身就是发现。
 * ========================================================================== */
console.log("%c遍历器已定义。跑：await crucibleSweep()", "color:#888");
console.log("%c建议先备份世界、且无人在线 —— 它会对约 300 个动作跑 prepare 与 preActivate。", "color:#888");
return run;

})();
