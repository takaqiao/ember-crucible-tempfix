/**
 * 全动作无头遍历器 —— 把「缺陷检测」变成上游每发一版就能零成本重跑的回归测试
 *
 * **这是浏览器控制台脚本**（probes/ 下 dump_*.mjs 那几个是 node 的）。
 * 用法：以 GM 身份进入世界，等 canvas ready，F12 控制台整段粘进去回车，然后
 *
 *     const R = await crucibleSweep();          // 跑一遍，返回结构化对象
 *     copy(JSON.stringify(R.findings, null, 1)) // 把命中项贴回来
 *
 * ------------------------------------------------------------------
 * 只读保证（这是本脚本最重要的性质，改任何一行之前先读完）
 * ------------------------------------------------------------------
 * 动作的三个生命周期阶段里（crucible-compiled.mjs:18477 起的类文档）：
 *
 *   Phase 1 准备   _configureUsage(:20283) / _prepare(:20314)   —— 纯内存
 *   Phase 2 使用   #use(:19318)                                 —— 前 58 行纯内存，最后三步写盘
 *   Phase 3 确认   confirm(:20584) → #applyEvents(:20618)       —— 全程写盘
 *
 * `#use` 的写盘边界**逐行核实过**，就是这三处，全在方法末尾：
 *   :19380  this.region.constructor.create(regionData, {parent: canvas.scene, keepId: true})
 *   :19385  await this.toMessage(...)        → :21378 ChatMessage.create(messageData, options)
 *   :19393  await this.actor.update({"flags.crucible": this.usage.actorFlags})
 * 在那之前的 acquireTargets / _preActivate / _roll / #recordEffectEvents / #resolveEventStream
 * 全部只改动作实例自己的内存字段；#resolveEventStream(:19960) 甚至专门在
 * `actor.clone({}, {keepId:true})` 上用 `{commit:false}` 模拟（:20009 / :20020），
 * 这就是上游自己认可的「不落库地算一遍」写法。
 *
 * 但 `#use` 是私有方法，**没有办法只跑它的前半段**。所以本脚本的做法是：
 *   ① 绝不调用 use() / #use() / toMessage() / confirm() / updateMessage()；
 *   ② 只调 prepare 阶段（clone + prepare），其余全部改成**静态复算** ——
 *      把 crucible 自己的判定式（半径公式、_preCreate 的拒绝条件、效果 id 生成规则）
 *      照抄一份在这里，逐条注明行号，而不是让系统真的跑一遍；
 *   ③ 整个 sweep 期间装一道**写盘熔断**（见 §W）：把 Document 的所有写方法换成抛异常的桩，
 *      跑完在 finally 里复原。任何一次写盘尝试都会被记录在 R.writeAttempts 里并中断那一条断言。
 *
 * 也**不调用 acquireTargets()**（:19442）。它本身只读，但结果取决于当前 game.user.targets
 * 与 canvas 状态，对遍历毫无意义；而且 :19477 的 default 分支会弹 ui.notifications.warn，
 * strict 模式还会 throw。取靶相关的判定一律改成静态复算 #getRegionData(:2859) 的几何式。
 *
 * ------------------------------------------------------------------
 * 断言清单
 * ------------------------------------------------------------------
 *   A1 效果声明 vs 真能落地   —— N10（turns 单位被拒）/ N3（有 value 没 units）/ N2（顶层 changes）/ scope NONE
 *   A2 区域几何退化           —— steamVent（半径为 0）/ kineticWall（ephemeral 且无 effects）/
 *                                summonNoRange / suddenBite(P2) / antigravityStone(N6)
 *   A3 派生数据里的 NaN       —— wardOfStabilization（change key 少了 .bonus，打在 SchemaField 上）
 *   A4 钩子里的效果 id 死查   —— emberStaleLookups（slice 到 16）/ N1（15 字符硬编码 id）
 *   A5 聊天卡宣称 vs 角色实况 —— 已确认的卡说挂了效果，角色身上却没有
 *   A6 babele 实际生效译条数  —— ember_cn_unofficial 的冒险包（顶层文档改名，0 条命中）
 *   A7 可证明的空动作         —— abyssalRemains（无 roll 提供者、无 effects、无钩子 ⇒ 记不出任何事件）
 *   A8 准备期被吞掉的异常     —— N7 darkflameCirclet（composed 标签打在基类上，TypeError 被吞成 console.error）
 *
 * 报数纪律：本脚本**不内嵌任何统计数字**，所有计数都是当场数出来的，
 * 并且每条 finding 都带 scanned/scope 说明扫了什么范围。
 */

globalThis.crucibleSweep = async function crucibleSweep({
  includePacks = true,       // 是否把合集也扫进来（慢，但覆盖面大得多）
  includeAdventures = true,  // 冒险包：265 个 actor 全嵌在 1 个顶层文档里，不特判必然漏
  prepareBind = true,        // 是否做 T1 派生层（clone+prepare，会跑 initialize/prepare 钩子）
  maxPrepare = 4000
} = {}) {

  const R = {
    _t: new Date().toISOString(),
    env: {},
    scanned: {},
    findings: [],          // 全部命中，扁平
    byAssertion: {},       // 按断言分组
    writeAttempts: [],     // 写盘熔断记录 —— 正常情况必须是空数组
    errors: []
  };

  const safe = (label, fn, d = null) => {
    try { return fn(); } catch (e) { R.errors.push(`${label}: ${e.message}`); return d; }
  };
  /** ⚠ safe() 是同步的 —— 异步函数的失败是 reject 而不是 throw，用 safe 包不住。异步一律走这个。 */
  const safeAsync = async (label, fn, d = null) => {
    try { return await fn(); } catch (e) { R.errors.push(`${label}: ${e.message}`); return d; }
  };
  const add = (assertion, severity, o) => {
    const f = { assertion, severity, ...o };
    R.findings.push(f);
    (R.byAssertion[assertion] ??= []).push(f);
    return f;
  };

  /* ============================================================ */
  /*  §0 环境                                                     */
  /* ============================================================ */

  R.env = safe("env", () => ({
    foundry: game.version,
    system: `${game.system.id} ${game.system.version}`,
    ember: game.modules.get("ember")?.version ?? "(未安装)",
    tempfix: game.modules.get("ember-crucible-tempfix")?.active
      ? game.modules.get("ember-crucible-tempfix").version : "(未启用)",
    babele: game.modules.get("babele")?.active ? game.modules.get("babele").version : "(未启用)",
    canvasReady: !!canvas?.ready,
    isGM: game.user.isGM,
    // ⚠ 装了 tempfix 时 A1/A2 报的仍然是**上游数据的原状**：
    //   N10 的补丁是在 preActivate 钩子里把 turns 改写成 rounds（scripts/tempfix.mjs:415），
    //   不动数据层，所以静态读到的 units 依旧是 "turns"。这正是我们要的 —— 本脚本测的是上游。
    note: "A1/A2 反映上游数据原状，不受 tempfix 运行时补丁影响"
  }), {});

  const S = globalThis.SYSTEM ?? crucible?.CONST;         // :47196 globalThis.SYSTEM / :47208 crucible.CONST
  if ( !S ) { R.errors.push("取不到 SYSTEM，crucible 没装好？"); return R; }

  /* ============================================================ */
  /*  §W 写盘熔断                                                 */
  /* ============================================================ */
  /**
   * 把所有写盘入口换成「记录 + 抛异常」。任何一条断言里如果有代码想写盘，
   * 它会当场炸掉、被 safe() 捕获、并在 R.writeAttempts 里留下调用栈。
   * 这不是装饰 —— 它是「本脚本只读」这句话的**可执行证明**。
   */
  const Doc = foundry.abstract.Document;
  const trip = name => function(...args) {
    const err = new Error(`写盘熔断：${name}`);
    R.writeAttempts.push({ method: name, stack: err.stack?.split("\n").slice(1, 6).join(" | ") });
    throw err;
  };
  const patched = [];
  const patch = (obj, key, label) => {
    if ( !obj || typeof obj[key] !== "function" ) return;
    patched.push([obj, key, obj[key]]);
    obj[key] = trip(label);
  };

  patch(Doc.prototype, "update", "Document#update");
  patch(Doc.prototype, "delete", "Document#delete");
  patch(Doc.prototype, "createEmbeddedDocuments", "Document#createEmbeddedDocuments");
  patch(Doc.prototype, "updateEmbeddedDocuments", "Document#updateEmbeddedDocuments");
  patch(Doc.prototype, "deleteEmbeddedDocuments", "Document#deleteEmbeddedDocuments");
  patch(Doc, "create", "Document.create");
  patch(Doc, "createDocuments", "Document.createDocuments");
  patch(Doc, "updateDocuments", "Document.updateDocuments");
  patch(Doc, "deleteDocuments", "Document.deleteDocuments");
  patch(foundry.documents, "modifyBatch", "modifyBatch");          // :37543 _applyActionEffects 的落库出口
  patch(game.settings, "set", "settings.set");

  // ⚠ 从这里到 finally 之间的一切都必须在 try 里 —— 熔断一旦装上去而没复原，
  //   这个世界在刷新之前会**完全无法写入**。这比任何一条断言都重要。
  try {

  /* ============================================================ */
  /*  §E 枚举 —— 动作从哪来                                        */
  /* ============================================================ */

  /** actor.actions 是 Record（:36327 return this.system.actions），item.actions 可能是数组（:7726）。统一成数组。 */
  const toArray = c => {
    if ( !c ) return [];
    if ( Array.isArray(c) ) return c;
    if ( c instanceof Map ) return Array.from(c.values());
    if ( typeof c === "object" ) return Object.values(c);
    return [];
  };

  /** 一条待检动作的载体：动作本体 + 出处 + （可能的）宿主 actor */
  const units = [];
  const seen = new Set();
  const pushActions = (container, origin, actor = null) => {
    for ( const a of toArray(container) ) {
      if ( !a?.id ) continue;
      const key = `${origin}::${a.id}`;
      if ( seen.has(key) ) continue;
      seen.add(key);
      units.push({ action: a, origin, actor });
    }
  };
  const harvestActor = (actor, origin) => {
    pushActions(actor.actions, `${origin} > ${actor.name}`, actor);
    for ( const item of actor.items ?? [] ) {
      pushActions(item.actions, `${origin} > ${actor.name} > ${item.name}`, actor);
    }
  };

  // 世界里的 actor（这一层能拿到派生数据，A3 只在这一层跑）
  const worldActors = Array.from(game.actors ?? []);
  for ( const a of worldActors ) safe(`world:${a.name}`, () => harvestActor(a, "world"));

  // 合集
  const packStats = [];
  if ( includePacks ) {
    for ( const pack of game.packs ) {
      const type = pack.metadata.type;
      if ( !["Item", "Actor", "Adventure"].includes(type) ) continue;
      if ( type === "Adventure" && !includeAdventures ) continue;
      const before = units.length;
      await safeAsync(`pack:${pack.collection}`, async () => {
        const docs = await pack.getDocuments();           // 只读
        for ( const doc of docs ) {
          if ( type === "Item" ) pushActions(doc.actions, `${pack.collection} > ${doc.name}`);
          else if ( type === "Actor" ) harvestActor(doc, pack.collection);
          else {
            // 冒险包：顶层只有 1 个文档，actor 全嵌在 doc.actors 里 —— 按顶层取样必然漏
            for ( const a of doc.actors ?? [] ) harvestActor(a, `${pack.collection} > ${doc.name}`);
            for ( const i of doc.items ?? [] ) pushActions(i.actions, `${pack.collection} > ${doc.name} > ${i.name}`);
          }
        }
        return docs.length;
      });
      packStats.push({ pack: pack.collection, type, actionsAdded: units.length - before });
    }
  }

  R.scanned = {
    worldActors: worldActors.length,
    packsScanned: packStats.length,
    actionUnits: units.length,
    uniqueActionIds: new Set(units.map(u => u.action.id)).size,
    packBreakdown: packStats
  };

  /* ============================================================ */
  /*  A1 效果声明 vs 真能落地                                      */
  /* ============================================================ */
  /**
   * 一条声明出来的 effect 要真的挂到角色身上，得连过四道关：
   *
   *  ① #recordEffectEvents(:19810) 重建 duration：
   *       duration.units ? duration : (duration.expiry ? {expiry} : undefined)
   *     → units 为空但 value 是数字 ⇒ 整个 duration 被丢掉 ⇒ 核心 AE value ??= Infinity
   *       ⇒ isTemporary 为假 ⇒ 连过期注册表都不进 ⇒ **永不消失**（N3 sentinelKick）
   *  ② CrucibleActiveEffect._preCreate(:39581)：
   *       if ( ["months","turns"].includes(this.duration.units) ) return false;
   *     → **效果压根不会被创建**（N10，本项目认定影响 19 个动作 / 20 处）
   *  ③ effect 数据里的 _id 必须是合法的 16 字符 id（:19812 `_id || getEffectId(...)`，
   *     硬编码值 truthy 会压过自动生成）→ 15 字符会让整个动作在 #resolveEventStream 抛异常（N1）
   *  ④ #getQualifyingEvent(:19871)：scope 为 NONE 直接 return false ⇒ 这条 effect 永远不会应用
   *
   *  另外顶层 changes（N2）：动作 effect 的 schema(:18624) 只有 name/scope/result/statuses/duration/system，
   *  :19806 的解构与 :19811 的重建都不含顶层 changes ⇒ 图标照挂、加值一条不生效。
   */
  const ID_RE = /^[a-zA-Z0-9]{16}$/;                       // 核心 isValidId 的判据
  const SCOPES = S.ACTION.TARGET_SCOPES;

  let a1Checked = 0;
  for ( const u of units ) {
    const eff = safe(`A1:${u.action.id}`, () => toArray(u.action.effects), []);
    for ( const [i, e] of (eff ?? []).entries() ) {
      if ( !e ) continue;
      a1Checked++;
      const d = e.duration ?? {};
      const base = { actionId: u.action.id, actionName: u.action.name, effectIndex: i, origin: u.origin };

      // ② N10：units 落在系统明令拒绝的集合里
      if ( ["turns", "months"].includes(d.units) ) {
        add("A1", "blocker", { ...base, kind: "EFFECT_NEVER_CREATED",
          detail: `duration.units = "${d.units}"，被 CrucibleActiveEffect._preCreate(:39581) 直接 return false`,
          observed: { duration: { value: d.value, units: d.units, expiry: d.expiry } },
          player: "聊天卡白纸黑字写着获得了这个效果，角色身上一个图标都没有" });
      }

      // ① N3：有数字 value 却没有 units
      else if ( !d.units && Number.isFinite(d.value) ) {
        add("A1", "major", { ...base, kind: "EFFECT_NEVER_EXPIRES",
          detail: `duration = {value:${d.value}, units:""} —— :19810 会把整个 duration 丢成 undefined，核心回落 value=Infinity`,
          observed: { duration: { value: d.value, units: d.units, expiry: d.expiry } },
          player: "状态挂上去就永远不掉，效果卡渲染成 ∞ 归进 persistent 段" });
      }

      // ③ 非法 _id
      if ( e._id && !ID_RE.test(e._id) ) {
        add("A1", "blocker", { ...base, kind: "EFFECT_INVALID_ID",
          detail: `_id "${e._id}" 长度 ${e._id.length}，isValidId 要求恰好 16 个字母数字`,
          player: "动作走完对话框后什么都不发生：不扣资源、不出聊天卡，只有控制台一条未捕获异常" });
      }

      // N2 顶层 changes
      if ( Array.isArray(e.changes) && e.changes.length ) {
        add("A1", "major", { ...base, kind: "CHANGES_AT_TOP_LEVEL",
          detail: `effect 顶层有 ${e.changes.length} 条 changes；schema(:18624) 里 changes 由 system 提供，:19806 的解构够不着`,
          player: "图标照常挂上，加值一条都不生效" });
      }

      // ④ scope NONE
      const scope = e.scope ?? u.action.target?.scope;
      if ( scope === SCOPES.NONE ) {
        add("A1", "minor", { ...base, kind: "EFFECT_SCOPE_NONE",
          detail: "#getQualifyingEvent(:19871) 对 scope NONE 直接 return false" });
      }
    }
  }
  R.scanned.effectsChecked = a1Checked;

  /* ============================================================ */
  /*  A2 区域几何退化 / 取靶不可能                                 */
  /* ============================================================ */
  /**
   * 半径公式照抄 #getRegionData(:2859)：
   *   :2864  maxRange  = range.maximum ?? 0
   *   :2865  baseRange = target.size ? target.size : maxRange
   *   :2866  addRange  = regionConfig.addSize ? (actor.size / 2) : 0
   *   :2883  radius    = (baseRange + addRange) * distancePixels
   *
   * baseRange 为 0 ⇒ 半径只剩施法者自己的半个身位 ⇒ **一个目标都覆盖不到**（steamVent）。
   * 这里只判 baseRange，因为 addRange 需要宿主 actor，而 baseRange 为 0 与宿主无关。
   */
  const TT = S.ACTION.TARGET_TYPES;

  for ( const u of units ) safe(`A2:${u.action.id}`, () => {
    const a = u.action;
    const t = a.target ?? {};
    const rng = a.range ?? {};
    const cfg = TT[t.type];
    const base = { actionId: a.id, actionName: a.name, origin: u.origin,
      target: { type: t.type, size: t.size, scope: t.scope, self: t.self },
      range: { minimum: rng.minimum, maximum: rng.maximum } };

    if ( cfg?.region ) {
      const maxRange = rng.maximum ?? 0;
      const baseRange = t.size ? t.size : maxRange;

      /**
       * ⚠ 必须排除 range.weapon === true —— 这是本断言最大的误报来源，实测过。
       * `range.weapon` 为真时 range.maximum 由装备的武器在准备期填进来
       * （_getWeaponAvailability :20187 按 range.weapon 在 _source 与派生值之间切换），
       * 数据里留空是正常的。
       * 离线实测（425 条动作索引，10 个 pack）：36 条 pulse 里「既无 size 又无 maximum」的有 5 条，
       * 其中 4 条（explosiveEmergence / tailSweep / whirlwind / sentinelSpin）都是 range.weapon:true，
       * 只有 steamVent 是 false —— 也就是说这个过滤器恰好把已知缺陷从同形状的正常动作里挑了出来。
       * summon 不在这里报，交给下面更精确的 SUMMON_RANGE_UNSET。
       */
      if ( baseRange === 0 && cfg.region.shape !== "emanation"
           && rng.weapon !== true && t.type !== "summon" ) {
        add("A2", "blocker", { ...base, kind: "REGION_RADIUS_ZERO",
          detail: `${t.type}：既没有 target.size 也没有 range.maximum，且 range.weapon 不为真（不会由武器补距）⇒ :2865 baseRange = 0 ⇒ 半径只剩 addRange（自身半个身位）`,
          player: "范围模板缩成施法者脚下一小块，怎么放都打不到人" });
      }

      // ephemeral 的区域在确认那一刻被删（:20561-20575）；没有任何 effect 记着它 ⇒ 什么都没留下
      const ephemeral = a.usage?.region?.ephemeral ?? cfg.region.ephemeral;
      if ( ephemeral === true && toArray(a.effects).length === 0 && t.type !== "summon" ) {
        add("A2", "major", { ...base, kind: "REGION_EPHEMERAL_NO_EFFECT",
          detail: `${t.type} 的 region.ephemeral 为 true 且 effects 为空 ⇒ :20575 确认那刻区域被删，无任何持久痕迹`,
          player: "范围放出来了，确认之后一切复原，什么都没留下" });
      }

      // 召唤没写 range.maximum ⇒ clampSummonPlacement(:2781, maxRange=0) 把召唤物钉在召唤者身旁
      if ( t.type === "summon" && (rng.maximum ?? null) === null ) {
        add("A2", "major", { ...base, kind: "SUMMON_RANGE_UNSET",
          detail: "target.type=summon 且 range.maximum 为空 ⇒ :2781 clampSummonPlacement 的 maxRange 取 0，t 一路收回相邻位置",
          player: "无论鼠标点在哪，召唤物永远落在召唤者旁边" });
      }
    }

    // 单体：range.minimum 只有单体路径读（:19692）。贴边距离相邻两 token 为 0，
    // 所以 minimum > 0 就把「贴身」排除掉；再遇上 max === min 就只剩一圈极窄的环
    if ( t.type === "single" ) {
      if ( (rng.minimum ?? 0) > 0 && rng.maximum != null && rng.maximum === rng.minimum ) {
        add("A2", "major", { ...base, kind: "SINGLE_RANGE_DEGENERATE",
          detail: `range 的 min 与 max 都是 ${rng.minimum}，单体取靶(:19692)只放行恰好这个距离的目标`,
          player: "贴着打不行、离远了也不行，实战里几乎永远提示无效目标" });
      }
      /**
       * movement 标签 + 单体：先让玩家规划位移，规划完再报无效目标（N6 antigravityStone）。
       * ⚠ 必须同时要求 scope === ALL(4)。离线实测：movement+single 共 10 条，
       * 其中 sacrificeSelf(scope 2)、slipperyEscape(scope 1)、intercept×7(scope 3) 都是正常设计；
       * 只有 scope 4 那一条是「两个值恰好都是 schema 默认（:18610/:18617），作者压根没填」。
       * 不加 scope 过滤会误报 9 条。
       */
      const tags = safe("tags", () => Array.from(a.tags ?? []), []);
      if ( tags.includes("movement") && t.scope === SCOPES.ALL ) {
        add("A2", "major", { ...base, kind: "MOVEMENT_TAG_SINGLE_TARGET",
          detail: "带 movement 标签却是 single 目标；把自己设为目标会触发 CannotTargetSelf 并丢弃刚规划的路径(:3089)",
          player: "规划完位移被告知无效目标，改选自己又把路径整个丢掉，陷入重复规划" });
      }
    }
  });

  /* ============================================================ */
  /*  A3 派生数据里的 NaN / 该是数字却不是                          */
  /* ============================================================ */
  /**
   * wardOfStabilization 的 change key 写的是 `system.resistances.acid`（少了 `.bonus`），
   * 落在 SchemaField 上会把整个抗性对象换掉，抗性总值算成 NaN。
   * 这一层必须在**世界里的 actor** 上跑 —— 合集文档没有应用 ActiveEffect 的派生结果。
   */
  const walkNaN = (obj, path, out, depth = 0, seenObjs = new Set()) => {
    if ( depth > 6 || obj == null || typeof obj !== "object" ) return;
    if ( seenObjs.has(obj) ) return;
    seenObjs.add(obj);
    for ( const [k, v] of Object.entries(obj) ) {
      const p = path ? `${path}.${k}` : k;
      if ( typeof v === "number" && Number.isNaN(v) ) out.push(p);
      else if ( v && typeof v === "object" && !(v instanceof Set) && !(v instanceof Map) ) {
        walkNaN(v, p, out, depth + 1, seenObjs);
      }
    }
  };

  for ( const actor of worldActors ) safe(`A3:${actor.name}`, () => {
    const nan = [];
    walkNaN(actor.system, "system", nan, 0, new Set());
    if ( nan.length ) {
      add("A3", "blocker", { actorName: actor.name, actorId: actor.id, kind: "DERIVED_NAN",
        paths: nan.slice(0, 40), count: nan.length,
        detail: "派生数据里出现 NaN；最常见的成因是某条 ActiveEffect 的 change key 少了一层，打在 SchemaField 而不是 NumberField 上",
        player: "角色卡上那一格显示成 NaN 或空白，相关判定全部失灵" });
    }
    // 更精确的一版：直接看有没有 change 的 key 指向一个 SchemaField
    for ( const e of actor.effects ?? [] ) {
      for ( const c of e.changes ?? [] ) {
        const field = safe("field", () => actor.system.schema?.getField?.(c.key.replace(/^system\./, "")), null);
        if ( field && (field instanceof foundry.data.fields.SchemaField) ) {
          add("A3", "blocker", { actorName: actor.name, effectName: e.name, kind: "CHANGE_KEY_HITS_SCHEMAFIELD",
            changeKey: c.key, changeValue: c.value,
            detail: "这条 change 的 key 指向一个 SchemaField（一整个对象），不是数字字段 —— 应用后整个子对象被替换",
            player: "对应的派生总值变 NaN 或直接归零" });
        }
      }
    }
  });

  /* ============================================================ */
  /*  A4 钩子里按字面量查效果 id，而那个 id 根本不会被生成            */
  /* ============================================================ */
  /**
   * crucible 给动作效果分配 id 的唯一逻辑（:19812）：
   *     _id: _id || SYSTEM.EFFECTS.getEffectId(this.id, {suffix: String(i)})
   *   getEffectId(:5358)  = generateId(label, 16 - suffix.length) + suffix
   *   generateId(:48066)  = id.slice(0, length).padEnd(length, "0")
   * ⇒ 第 0 条效果的 id 是「actionId 截到 15 位，再拼一个 '0'」。
   *
   * ember 那两处写的是把 actionId 截到 **16** 位：
   *     effects.get("formidableStamin")   真值是 "formidableStami0"
   *     effects.get("implacableHunter")   真值是 "implacableHunte0"
   * 两个字面量都是**合法的 16 字符 id**，所以光查长度是抓不到的 ——
   * 必须拿它跟「系统真会生成的 id 全集」比对。N1 的 "abyssMarkUnmak0"（15 字符）也一并落网。
   */
  safe("A4", () => {
    // ① 系统真会生成的 id 全集：对每个动作 id 生成前若干个后缀
    const legit = new Set();
    const gen = crucible?.api?.methods?.generateId;
    if ( !gen ) throw new Error("取不到 crucible.api.methods.generateId");
    for ( const id of new Set(units.map(u => u.action.id)) ) {
      for ( let i = 0; i < 4; i++ ) {
        const suffix = String(i);
        legit.add(gen(id, 16 - suffix.length) + suffix);
      }
      legit.add(gen(id, 16));
    }
    // 数据里显式写死的 _id 也算合法来源
    for ( const u of units ) for ( const e of toArray(u.action.effects) ) if ( e?._id ) legit.add(e._id);
    // 世界里已经存在的效果 id 同样算数（可能来自别处）
    for ( const a of worldActors ) for ( const e of a.effects ?? [] ) legit.add(e.id);

    // ② 扫所有已注册钩子的源码，捞出 effects.get("…") / effects.has("…") 的字面量
    const hookRoot = crucible?.api?.hooks ?? {};
    const LOOKUP = /effects\s*[?.]*\.\s*(?:get|has)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    const IDLIT  = /_id\s*:\s*["'`]([^"'`]+)["'`]|_id\s*=\s*["'`]([^"'`]+)["'`]/g;
    let fnScanned = 0;

    for ( const [bucket, table] of Object.entries(hookRoot) ) {
      if ( !table || typeof table !== "object" ) continue;
      for ( const [ownerId, cfg] of Object.entries(table) ) {
        if ( !cfg || typeof cfg !== "object" ) continue;
        for ( const [hookName, fn] of Object.entries(cfg) ) {
          if ( typeof fn !== "function" ) continue;
          fnScanned++;
          const src = String(fn);
          for ( const m of src.matchAll(LOOKUP) ) {
            const lit = m[1];
            if ( legit.has(lit) ) continue;
            add("A4", "major", { kind: "STALE_EFFECT_LOOKUP", bucket, ownerId, hook: hookName, literal: lit,
              wouldBe: gen(ownerId, 15) + "0",
              detail: `钩子里查 effects.get("${lit}")，但系统生成规则(:19812→:5358→:48066)下这个 id 不会存在`,
              player: "该钩子的整段自动化静默失效 —— 没有报错、也没有任何提示" });
          }
          for ( const m of src.matchAll(IDLIT) ) {
            const lit = m[1] ?? m[2];
            if ( !lit || ID_RE.test(lit) ) continue;
            add("A4", "blocker", { kind: "HARDCODED_INVALID_ID", bucket, ownerId, hook: hookName, literal: lit,
              length: lit.length,
              detail: `钩子里硬编码 _id = "${lit}"（${lit.length} 字符），isValidId 要求恰好 16`,
              player: "整个动作抛异常中止：不扣资源、不出聊天卡" });
          }
        }
      }
    }
    R.scanned.hookFunctions = fnScanned;
    R.scanned.legitEffectIds = legit.size;
  });

  /* ============================================================ */
  /*  A5 聊天卡宣称的效果 vs 角色实际状态                            */
  /* ============================================================ */
  /**
   * 事件序列化在 CrucibleActionEvent#toObject(:18294)：
   *     {type, target: <uuid>, resources, effects, rollIndex?, ...}
   * 落库在 _applyActionEffects(:37501)，创建时带 **keepId: true**（:37540），
   * 所以 event.effects[i]._id 就是角色身上那条效果的 id —— 可以直接 get 回来对账。
   *
   * 这一条是**唯一从玩家视角出发**的断言：卡上写了、身上没有。
   * 它把 A1 里那些「静态推断会被拒绝」的结论，在真实牌面上再验一次。
   */
  safe("A5", () => {
    const msgs = Array.from(game.messages ?? []);
    let checked = 0;
    for ( const m of msgs ) {
      const flags = m.flags?.crucible;
      if ( !flags?.confirmed ) continue;                 // 只审已确认的卡，未确认的本来就还没落地
      const events = flags.events;
      if ( !Array.isArray(events) ) continue;
      for ( const ev of events ) {
        if ( ev.negated ) continue;                      // 被 negate 的事件本就不应用（:19232）
        const target = safe("uuid", () => foundry.utils.fromUuidSync(ev.target), null);
        if ( !target?.effects ) continue;
        for ( const e of ev.effects ?? [] ) {
          if ( !e?._id || e._action === "delete" ) continue;
          checked++;
          if ( !target.effects.get(e._id) ) {
            add("A5", "blocker", { kind: "CARD_CLAIMS_MISSING_EFFECT",
              messageId: m.id, when: new Date(m.timestamp).toISOString(),
              targetName: target.name, effectId: e._id, effectName: e.name,
              duration: e.duration,
              detail: "这张卡已确认，事件流里记着要给该角色挂这条效果，但角色身上查不到（_applyActionEffects 用 keepId 创建，id 应当一致）",
              player: "卡上写着「获得 XXX」，角色身上没有这个图标" });
          }
        }
      }
    }
    R.scanned.messagesAudited = msgs.length;
    R.scanned.claimedEffectsChecked = checked;
  });

  /* ============================================================ */
  /*  A6 babele：某个 pack 实际生效的译条数                         */
  /* ============================================================ */
  /**
   * babele 用**文件名**决定这份译文属于哪个 pack（translation-loader.js:103
   * `source.baseName.replace(/\.json$/,"")`），但条目是按**文档 name** 匹配的。
   * 于是文件名对得上、pack 显示「已翻译」，条目却可以一条都命中不了。
   *
   * 判据：game.babele.isTranslated(collection) 为真（babele.js:557），
   * 但逐条 translate(collection, entry, true) 全部返回 {}（mapped-compendium.js:336 的 miss 分支）。
   *
   * 本机实测（离线比对译文键与 packdump）：ember.crucible-adventure 的译文只有 1 条，
   * 键是 "Ember Beta Two"，而合集里那个唯一的顶层文档叫 **"Ember Early Access"** —— 命中 0/1。
   * 因为这个冒险包的 265 个 actor、全部物品场景日志都嵌在那一个顶层文档下，
   * 这一条没中，等于整包一个字都没翻译。
   */
  if ( game.babele?.isTranslated ) safe("A6", () => {
    const rows = [];
    for ( const pack of game.packs ) {
      const col = pack.collection;
      if ( !game.babele.isTranslated(col) ) continue;
      const index = Array.from(pack.index ?? []);
      let hit = 0;
      for ( const entry of index ) {
        const delta = safe("babele", () => game.babele.translate(col, { ...entry }, true), null);
        if ( delta && typeof delta === "object" && Object.keys(delta).length ) hit++;
      }
      const row = { pack: col, indexed: index.length, translated: hit,
        ratio: index.length ? +(hit / index.length).toFixed(3) : null };
      rows.push(row);
      if ( index.length > 0 && hit === 0 ) {
        add("A6", "blocker", { kind: "BABELE_ZERO_EFFECTIVE", ...row,
          detail: "babele 认为这个 pack 有译文（文件名对得上），但逐条匹配下来一条都没命中 —— 典型成因是条目键用的文档名与合集里的实际名字不一致",
          player: "这个合集在界面上完全是英文，但模块列表里显示汉化已启用" });
      }
      else if ( index.length > 0 && hit < index.length ) {
        add("A6", "minor", { kind: "BABELE_PARTIAL", ...row,
          detail: `${index.length - hit} 条文档没有对应译条` });
      }
    }
    R.scanned.babele = rows;
  });
  else R.errors.push("A6 跳过：game.babele.isTranslated 不可用");

  /* ============================================================ */
  /*  A7（自拟）可证明的空动作 —— 它不可能记录任何事件                */
  /* ============================================================ */
  /**
   * 动作的全部机械后果都必须走 recordEvent(:19192)，而 recordEvent 只会被这些地方调用：
   *   _roll(:20519 roll 钩子) / _preActivate(:20504) / _post(:20531 postActivate) / confirm 钩子
   *   以及 effects（走 #recordEffectEvents）、movement / summon 目标类型的内建路径。
   *
   * 提供 roll() 的是「标签 + 该动作自己的钩子」，取法与系统一致：遍历 _tests()(:20219)。
   * 如果一个动作 ——
   *   没有任何提供者定义 roll / preActivate / postActivate / confirm / postConfirm，
   *   且 effects 为空，且目标类型不是 movement / summon ——
   * 那它**在代码层面就不可能产生任何事件**，除了扣掉行动点之外什么都不会发生。
   *
   * abyssalRemains 就是这样：tags 是 ["weakened","reflex","corruption"]，
   * 三个都只是修饰 / 防御 / 伤害类型标签，一个都不提供 roll()。
   *
   * 误报控制：cost 全为 0 的纯展示条目、以及带 description 但明显是被动的条目会被排除；
   * 同时要求「有伤害类型标签或防御标签」才报 —— 也就是这条动作**看起来该造成伤害**。
   */
  const EVENT_HOOKS = ["roll", "preActivate", "postActivate", "confirm", "postConfirm"];
  const DAMAGE_TYPES = new Set(Object.keys(S.DAMAGE_TYPES ?? {}));
  const DEFENSE_TAGS = new Set(["physical", "reflex", "fortitude", "willpower"]);

  for ( const u of units ) safe(`A7:${u.action.id}`, () => {
    const a = u.action;
    if ( toArray(a.effects).length ) return;
    if ( ["movement", "summon"].includes(a.target?.type) ) return;

    const providers = [];
    for ( const test of a._tests() ) {                    // :20219 yield* tags.tags(); yield this.hooks
      if ( !test ) continue;
      for ( const h of EVENT_HOOKS ) if ( typeof test[h] === "function" ) providers.push(h);
    }
    if ( providers.length ) return;

    const tags = Array.from(a.tags ?? []);
    const looksHarmful = tags.some(t => DAMAGE_TYPES.has(t)) || tags.some(t => DEFENSE_TAGS.has(t));
    if ( !looksHarmful ) return;                          // 纯姿态/展示条目不报

    add("A7", "major", { actionId: a.id, actionName: a.name, origin: u.origin, kind: "INERT_CANDIDATE",
      tags, cost: { ...(a.cost ?? {}) },
      detail: "标签里有伤害类型/防御类型，但 _tests() 里没有任何提供者定义 roll/preActivate/postActivate/confirm，effects 也为空",
      // ⚠ 这条是**候选生成器，不是判决**：_tests()(:20219) 只 yield 标签处理器与动作钩子，
      //   看不到 actor 钩子。动作的 roll 也可以由 actor 钩子提供
      //   （_prepare :20322 callActorHooks("prepareAction")、_roll 那一步的 "rollAction"），
      //   那些注册在 crucible.api.hooks.talent[...] 上，按天赋而不是按动作索引。
      //   所以命中项必须逐条人工裁决：先去 crucible.api.hooks.talent 里找该动作宿主的天赋 id。
      caveat: "_tests() 看不到 actor 钩子（rollAction/prepareAction）——命中即需人工复核，不可直接当缺陷",
      player: "若确认成立：花掉行动点，聊天卡上只有一段描述，敌人一点血都不掉" });
  });

  /* ============================================================ */
  /*  A8（自拟）准备期被吞掉的异常                                  */
  /* ============================================================ */
  /**
   * _callActionHooks(:20244) 对每个钩子 try/catch，非 throws 类的失败一律吞成
   *     console.error(new Error(`The "${hookName}" action hook failed for Action "${this.id}"`, {cause: err}))
   * ——**动作照常继续跑**，玩家只会看到「什么都没发生」。N7 darkflameCirclet 就是这么塌的：
   * composed 标签打在基类 CrucibleAction 上（:22289 只对 counterspell 特判），
   * composed.initialize(:3898) 读 this.rune.name 抛 TypeError 被吞掉；
   * 真正致命的是后面 configureVFXEffect(:20951) 的调用点 :21200 在 ChatMessage.create(:21378)
   * **之前**且没有 try/catch —— 动作直接中止，资源不扣、卡也不出。
   *
   * 做法：在 clone+prepare 的过程中临时接管 console.error / console.warn，
   * 把捕获到的消息归属到当时正在准备的那个动作上。这是**读**不到的东西 ——
   * 必须真的把 prepare 跑一遍才会浮现，也正因为如此它只在 T1 层做。
   *
   * 安全性：prepare 阶段只调 _configureUsage(:20283) 与 _prepare(:20314)，
   * 二者只改动作实例自己的字段、只从 actor 读；期间写盘熔断全程挂着。
   */
  if ( prepareBind ) safe("A8", () => {
    const origError = console.error, origWarn = console.warn;
    let current = null;
    const captured = [];
    console.error = (...args) => { captured.push({ level: "error", unit: current, args: args.map(String) }); };
    console.warn  = (...args) => { captured.push({ level: "warn",  unit: current, args: args.map(String) }); };

    let prepared = 0;
    try {
      for ( const u of units ) {
        if ( prepared >= maxPrepare ) break;
        if ( !u.actor ) continue;                         // prepare() 在 :19158 对无 actor 的动作直接 return
        current = { actionId: u.action.id, actionName: u.action.name, origin: u.origin, actorName: u.actor.name };
        try {
          // clone 出一份再 prepare，绝不动原实例。context 不传 lazy ⇒ _initialize(:19012) 末尾会调 prepare()
          u.action.clone({}, { actor: u.actor, token: null });
          prepared++;
        } catch(err) {
          captured.push({ level: "throw", unit: current, args: [String(err?.message ?? err)] });
        }
      }
    } finally {
      console.error = origError; console.warn = origWarn; current = null;
    }
    R.scanned.actionsPrepared = prepared;

    // 归并：同一个动作 id 只报一次
    const byAction = new Map();
    for ( const c of captured ) {
      const k = `${c.unit?.actionId}::${c.args[0]?.slice(0, 120)}`;
      if ( !byAction.has(k) ) byAction.set(k, { ...c, count: 0 });
      byAction.get(k).count++;
    }
    for ( const c of byAction.values() ) {
      add("A8", c.level === "throw" ? "blocker" : "major", {
        kind: c.level === "throw" ? "PREPARE_THREW" : "PREPARE_SWALLOWED_ERROR",
        ...c.unit, occurrences: c.count, message: c.args.join(" ").slice(0, 400),
        detail: c.level === "throw"
          ? "clone+prepare 直接抛出 —— 这个动作连数据准备都过不去"
          : "准备期钩子失败被 _callActionHooks(:20246) 吞成 console.error，动作会带着残缺状态继续跑",
        player: "使用时什么都不发生，资源不扣、卡也不出；控制台有一条没人会去看的红字"
      });
    }
  });

  /* ============================================================ */
  /*  收尾：复原写盘熔断 + 汇总                                     */
  /* ============================================================ */
  } finally {
    // 无论上面发生什么（包括我自己写错代码抛异常），熔断都必须摘干净
    for ( const [obj, key, fn] of patched.reverse() ) obj[key] = fn;
  }

  const sev = s => R.findings.filter(f => f.severity === s).length;
  R.summary = {
    blocker: sev("blocker"), major: sev("major"), minor: sev("minor"),
    total: R.findings.length,
    byAssertion: Object.fromEntries(Object.entries(R.byAssertion).map(([k, v]) => [k, v.length])),
    byKind: R.findings.reduce((acc, f) => { acc[f.kind] = (acc[f.kind] ?? 0) + 1; return acc; }, {}),
    writeAttempts: R.writeAttempts.length,
    CLEAN: R.findings.length === 0 && R.writeAttempts.length === 0
  };

  console.log("%cCrucible/Ember 全动作遍历", "font-size:14px;font-weight:bold");
  console.log("环境", R.env);
  console.log("扫描范围", R.scanned);
  if ( R.writeAttempts.length ) {
    console.error("%c⚠ 有代码试图写盘，已被熔断拦下 —— 这是本脚本的 bug，请把 writeAttempts 贴回来",
      "color:red;font-weight:bold", R.writeAttempts);
  }
  if ( R.findings.length ) {
    console.table(R.findings.map(f => ({
      断言: f.assertion, 级别: f.severity, 类型: f.kind,
      对象: f.actionName ?? f.actorName ?? f.pack ?? f.ownerId ?? f.targetName ?? "",
      id: f.actionId ?? f.literal ?? f.effectId ?? f.changeKey ?? "",
      出处: (f.origin ?? "").slice(0, 60)
    })));
  }
  console.log("%c汇总", "font-weight:bold", R.summary);
  if ( R.errors.length ) console.warn("扫描过程中的错误", R.errors);
  console.log("完整对象已返回。建议：copy(JSON.stringify(R.findings, null, 1))");

  return R;
};

console.log("%c已装载 crucibleSweep()", "font-weight:bold",
  "\n用法：const R = await crucibleSweep();" +
  "\n只扫世界不扫合集（快）：await crucibleSweep({includePacks:false})" +
  "\n跳过 prepare 层（最保守）：await crucibleSweep({prepareBind:false})");
