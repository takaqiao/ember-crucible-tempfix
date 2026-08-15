/* ============================================================================
 * A2（重设计）区域几何退化 / 取靶不可能
 *
 * 这是 console_action_sweep.js 的一个**断言段**，不是独立脚本。
 * 装配方式：把 `A2_runRegionGeometry` 整个粘进 sweep 的 try 块里，用 sweep 自己的
 * `units / add / safe / toArray / R` 调它。段末的 §校准 给出离线复现口径与逐条命中/不命中结果。
 *
 * ---------------------------------------------------------------------------
 * 为什么原版 A2 是坏的（一句话）：它在 `_source` 形态的数据上算几何，
 * 而 crucible 有 **19 个准备期写点**会在 `prepare()` 里把 range/target 填出来。
 * 逐个核实过的写点清单（crucible-compiled.mjs 0.10.1，48308 行）：
 *
 *   标签 prepare（TAGS）
 *     :4104  strike.prepare   this.range.maximum = Math.max(max ?? 0, _source.max + weaponRange)
 *                             —— 只在 `this.range.weapon === true` 时执行，weaponRange 来自
 *                                当前解析出的武器（usage.strikes / usage.weapon）
 *     :4251  thrown.prepare   this.range.maximum ??= 10      （thrown → propagate ["melee"] → strike）
 *   动作钩子 prepare（crucible.api.hooks.action[id]）
 *     :8904  blastFlask.target.size          :9175  crushingLeap.target.size
 *     :9210  defensiveRoll.range.maximum     :9272  electrochargeAmpoule.target.size
 *     :9280  evasiveShot.range.maximum       :9533  flyingKick.range.maximum
 *     :9541  frostFlask.target.size          :9958  intercept.range.maximum
 *     :10207 overrun.target.size             :10208 overrun.range.maximum
 *     :10698 ruthlessMomentum.range.maximum  :10890 throw.target.size
 *     :10891 throw.range.maximum             :10941 tramplingCharge.target.size
 *     :10942 tramplingCharge.range.maximum   :10969 tuskCharge.range.maximum
 *     :11027 vaultingSweep.range.maximum     :11028 vaultingSweep.target.size
 *     :13458 reshape.target.scope（restoration ? ALLIES : ENEMIES）
 *
 *   propagate 链（决定哪些动作会走到 :4104）：
 *     projectile→ranged  mechanical→ranged  talisman→strike  unarmed→melee
 *     melee→strike  ranged→strike  mainhand→strike  twohand→strike  offhand→strike
 *     thrown→melee(→strike)  natural→melee(→strike)
 *
 *   ember（modules/ember/scripts/*.mjs）对 range/target 的写点：**0 处**（grep 全空）。
 *
 * 所以本段的第一原则：**只在 `prepare()` 跑完的活对象上判**，一条静态近似都不做。
 * 做不到的地方（未被任何 actor 持有的合集条目）如实计入 skipped，不猜。
 *
 * ---------------------------------------------------------------------------
 * §几何 —— 逐行核实的 `#getRegionData`（:2859–:2960）
 *
 *   :2864  maxRange  = range.maximum ?? 0
 *   :2865  baseRange = target.size ? target.size : maxRange
 *   :2866  addRange  = regionConfig.addSize ? (this.actor.size / 2) : 0
 *
 *   形状              取哪个量当「伸出去的跨度」            行号
 *   ------------      ---------------------------------    --------
 *   circle            radius = (baseRange + addRange) * d   :2878–:2887
 *   cone              radius = (baseRange + addRange) * d   :2888–:2898
 *   emanation         radius = (baseRange + addRange) * d   :2899–:2913（外加 base:{type:"token"} 底座）
 *   line              length = (maxRange  + addRange) * d   :2914–:2923  ← **不走 baseRange**
 *   rectangle         height =  maxRange * d                :2924–:2941  ← **不走 baseRange**
 *
 *   形状之后还有一段按 target.type 的覆写（:2943–:2955）：
 *     summon:  shape.height = shape.width = (target.size ?? region.size(3) ?? 1) * d
 *              → rectangle 的 `height = maxRange*d` 被整个盖掉。rectangle 只有 summon 用，
 *                所以「矩形按 maximum 定高」这条在真实语料里**是死的**。
 *     ray:     if (target.size) shape.width = target.size * d
 *              → **ray 的 target.size 是宽度，不是长度**。这是 kineticWall 被漏报的根因：
 *                它 size=10 看着「有值」，但长度取的是 maximum（null → 0）。
 *     wall:    只改 elevation，不改长度。
 *
 *   TARGET_TYPES（:3413–:3517）里各类型的 region 配置：
 *     type    shape      anchor  addSize  ephemeral  scope(默认)
 *     cone    cone       self    true     true       ALL
 *     fan     cone       self    true     true       ALL
 *     pulse   circle     self    true     true       ALL
 *     aura    emanation  self    false    false      ALL   （addSize false 是因为 emanation 自带底座）
 *     blast   circle     vertex  —        true       ALL
 *     ray     line       self    true     true       ALL
 *     summon  rectangle  vertex  —        true       SELF
 *     wall    line       vertex  —        false      ALL
 *
 * 判据：**span = 0 即退化**，其中
 *     line 形状      → span = 准备后的 range.maximum
 *     其余圆锥类     → span = 准备后的 (target.size || range.maximum)
 *     rectangle      → 不判（summon 专用且被覆写）
 *
 * span=0 之后剩下的只有 addRange = actor.size/2。`actor.size` 是 `system.movement.size`
 * （:36467），单位是**距离单位（尺）**不是格数 —— 佐证：:9210 直接把它赋给 range.maximum，
 * :32000 拿它跟主手武器射程相加。taxonomy 默认 4（:42111），即中型生物残留半径 2 尺。
 * 5 尺格上，2 尺半径的圆只盖得住施法者自己那一格的中心；而 `#acquireTargetsFromRegion`
 * （:19617）在 `target.self` 为假时**首先把施法者排除**（:19623），于是目标数恒为 0。
 *
 * ---------------------------------------------------------------------------
 * §取靶 —— 区域路径没有单体路径的空集保护
 *
 *   `#getTargetDispositions`（:19731）：scope 为 NONE/SELF ⇒ **返回 []**。
 *   单体路径 `#acquireSingleTargets`（:19687）显式写了
 *       if ( targetDispositions.length && !targetDispositions.includes(...) )
 *   注释里也说明「空集意味着 NONE/SELF，此处不受限」。
 *   区域路径 `#acquireTargetsFromRegion`（:19624）**没有 .length 守卫**：
 *       if ( !targetDispositions.includes(tokenDoc.disposition) ) continue;
 *   空数组 includes 恒假 ⇒ 每个候选都被 continue 掉 ⇒ **目标恒为 0**，与几何无关。
 *   （位移路径 :19545 同样没守卫，但位移动作零目标本来就是常态，故不报。）
 *
 *   summon 必须豁免：`acquireTargets`（:19452）在进区域分支之前就
 *       if ( targetType === "summon" ) return this.targets = new Map();
 *   它的 scope 按配置就是 SELF，报它必是误报。
 *
 * ---------------------------------------------------------------------------
 * §range.minimum 的三个消费点（原草稿只知道一个）
 *
 *   :19692  `#acquireSingleTargets` —— **仅 single 路径**，读派生 `this.range.minimum`
 *   :3054   移动规划 `planMovement({minDistance: this.action.range?.minimum})` —— 仅 movement
 *   :20190  `_getWeaponAvailability` —— 读 **`this._source.range.minimum`**（不是派生值），
 *           对任何带 strike 链标签、且当前有目标的动作生效（含区域类）
 *
 *   距离由 `getLinearRange`（:32122）算**基座到基座**：足迹重叠或相邻贴边 ⇒ **0**；
 *   其余按 `canvas.grid.measurePath` 走格。所以单体动作可达的距离集合是
 *       D = {0} ∪ {k·canvas.grid.distance}
 *   `[minimum, maximum]` 与 D 无交 ⇒ 这个动作**对任何站位都取不到靶**。
 *   —— 这才是 P2「凯思族撕咬贴着敌人反而咬不到」的正确判据；
 *      草稿那条 `minimum === maximum` 在全语料是 **0 命中**（见下表），纯属空转。
 * ============================================================================ */

/**
 * @param {object} ctx
 * @param {Array<{action: CrucibleAction, origin: string, actor: CrucibleActor|null}>} ctx.units
 * @param {(assertion: string, severity: string, o: object) => object} ctx.add
 * @param {(label: string, fn: Function, d?: any) => any} ctx.safe
 * @param {(c: any) => any[]} ctx.toArray
 * @param {object} ctx.R          sweep 的结果对象；本段往 R.a2 里写扫描口径
 * @param {object} ctx.S          SYSTEM
 * @param {boolean} [ctx.upstreamMode=true]  跑之前把 tempfix 的 ACTION_PATCHES 清空（见 §U）
 */
function A2_runRegionGeometry({units, add, safe, toArray, R, S, upstreamMode = true}) {

  const TT = S.ACTION.TARGET_TYPES;
  const SCOPES = S.ACTION.TARGET_SCOPES;

  /* ---------------------------------------------------------------- */
  /*  §U 上游模式                                                      */
  /* ---------------------------------------------------------------- */
  /**
   * ⚠ 这一段是本断言能不能用的前提，不是可选项。
   *
   * tempfix 自己就在 prepare/initialize 里改 range/target：
   *   scripts/tempfix.mjs:181  suddenBite.prepare   range.minimum = null; range.maximum = 1   （P2）
   *   scripts/tempfix.mjs:632  dawnBeacon.initialize target.scope = ENEMIES                   （C5）
   *   scripts/tempfix.mjs:612  tumble.initialize     target.scope = ENEMIES                   （C4）
   *   scripts/tempfix.mjs:512  heartSparkOfEmber     target.scope = ALL                       （N6 侧）
   * 「在准备后的活对象上判」如果不做处理，装着 tempfix 跑就会把 **P2 与 C5 判成已修复**
   * —— 这个断言测的是上游，不是我们自己。
   *
   * 处理方式：`emberCrucibleTempFix.ACTION_PATCHES` 是活的可变对象，
   * `_tests()` 包装器（tempfix.mjs:1322）每次调用现查它。清空键 ⇒ 下一次 prepare() 就是上游行为。
   * finally 里逐键还原。**只清 ACTION_PATCHES 就够**：已核实 UNIVERSAL_PATCHES /
   * PROTOTYPE_PATCHES / HOOK_OVERRIDES 里没有任何一处写 range/target（grep 全空）。
   */
  const TF = globalThis.emberCrucibleTempFix;
  const suspended = {};
  let upstream = false;
  if ( upstreamMode && TF?.ACTION_PATCHES ) {
    for ( const k of Object.keys(TF.ACTION_PATCHES) ) {
      suspended[k] = TF.ACTION_PATCHES[k];
      delete TF.ACTION_PATCHES[k];
    }
    upstream = true;
  }

  const a2 = R.a2 = {
    upstreamMode: upstream,
    tempfixPatchesSuspended: Object.keys(suspended),
    /* 扫描口径 —— 每个数字都是当场数出来的 */
    unitsSeen: 0,
    prepared: 0,            // 成功拿到「准备后」形态的动作条目数
    skippedUnprepared: 0,   // 没有宿主 actor ⇒ prepare() 在 :19163 直接 return ⇒ 无法判
    skippedNoRegion: 0,     // target.type 不带 region 配置（none/self/single/movement）
    skippedSummon: 0,       // summon：几何被 :2945 覆写、取靶在 :19452 提前返回
    regionEvaluated: 0,
    singleEvaluated: 0,
    weaponUnresolved: [],   // range.weapon 为真但准备后仍没解析出武器 ⇒ 几何不可判，不算命中
    gridDistance: null
  };

  a2.gridDistance = safe("a2:grid", () => canvas?.ready ? canvas.grid.distance : null, null);

  /* ---------------------------------------------------------------- */
  /*  取「准备后」形态                                                  */
  /* ---------------------------------------------------------------- */
  /**
   * `clone({}, {lazy:true})` 的三个性质（:19137–:19160）逐条核实过：
   *   ① lazy ⇒ `_initialize` 末尾**不自动** prepare（:19037），由我们显式调；
   *   ② lazy ⇒ `context.usage = deepClone(this.usage)`（:19142），
   *      **不与世界里那份 usage 共享对象** —— 非 lazy 的 clone 会共享，prepare() 会就地
   *      重置 usage.strikes / usage.bonuses，等于污染世界状态。这是必须 lazy 的原因。
   *   ③ lazy ⇒ 跳过 `actor.callActorHooks("prepareActions", ...)`（:19152）。
   *      代价：actor 级钩子对动作的调整不体现。已核实 crucible 与 ember 的 prepareActions
   *      钩子都不写 range/target，对本断言无影响。
   * 全程只碰内存，不触发任何 Document 写方法（sweep 的写盘熔断可作证）。
   */
  const preparedForm = (u) => {
    const a = u.action;
    if ( !u.actor && !a.actor ) return null;          // :19163 prepare() 需要 actor
    const probe = a.clone({}, {lazy: true});
    probe.prepare();
    if ( !probe._prepared ) return null;
    return probe;
  };

  /* ---------------------------------------------------------------- */
  /*  几何跨度（照抄 :2859–:2960）                                      */
  /* ---------------------------------------------------------------- */
  const spanOf = (p, regionCfg) => {
    const maxRange = p.range?.maximum ?? 0;
    const size = p.target?.size;
    switch ( regionCfg.shape ) {
      case "line":                                     // ray / wall —— :2919 length 用 maxRange
        return {span: maxRange, formula: "line.length = (maxRange + addRange) · d  (:2919)",
          note: "target.size 在 :2951 只设 shape.width（射线宽度），不参与长度"};
      case "circle": case "cone": case "emanation":    // circle :2883 / cone :2893 / emanation :2909
        return {span: (size ? size : maxRange),
          formula: `${regionCfg.shape}.radius = (baseRange + addRange) · d，baseRange = target.size || range.maximum  (:2865)`,
          note: regionCfg.shape === "emanation" ? "另带 base:{type:\"token\"} 底座，半径 0 时等于施法者自身足迹" : null};
      case "rectangle":
        return null;                                   // summon 专用，:2946 覆写 height/width
      default:
        return null;
    }
  };

  /* ---------------------------------------------------------------- */
  /*  主循环                                                           */
  /* ---------------------------------------------------------------- */
  for ( const u of units ) safe(`A2:${u.action?.id}`, () => {
    a2.unitsSeen++;
    const src = u.action;
    const srcType = src.target?.type;
    const cfg = TT[srcType];

    // 先按**源**类型做两个豁免，避免白跑 prepare
    if ( !cfg ) return;                                        // 未知类型：交给别的断言
    if ( !cfg.region && srcType !== "single" ) { a2.skippedNoRegion++; return; }
    if ( srcType === "summon" ) { a2.skippedSummon++; return; }

    const p = preparedForm(u);
    if ( !p ) { a2.skippedUnprepared++; return; }
    a2.prepared++;

    const t = p.target ?? {};
    const rng = p.range ?? {};
    const pcfg = TT[t.type];                                    // 准备期理论上可换类型；重取一次
    if ( !pcfg ) return;
    if ( t.type === "summon" ) { a2.skippedSummon++; return; }

    const tags = safe("a2:tags", () => Array.from(p.tags ?? []), []);
    const base = {
      actionId: p.id, actionName: p.name, origin: u.origin, actor: u.actor?.name ?? null,
      preparedTarget: {type: t.type, size: t.size ?? null, scope: t.scope, self: !!t.self},
      preparedRange: {minimum: rng.minimum ?? null, maximum: rng.maximum ?? null, weapon: !!rng.weapon},
      sourceRange: {minimum: src._source?.range?.minimum ?? null, maximum: src._source?.range?.maximum ?? null},
      tags
    };

    /* ============================================================ */
    /*  A2-G1  区域几何退化                                          */
    /* ============================================================ */
    if ( pcfg.region ) {
      a2.regionEvaluated++;
      const g = spanOf(p, pcfg.region);
      if ( g && g.span === 0 ) {

        /**
         * ⚠ 唯一的不可判分支：`range.weapon === true` 而准备期没解析出武器。
         * :4104 的 `range.maximum` 由 `usage.strikes` 里那把武器的 `system.range` 填，
         * :4049 又有 `if ( !strikes.length ) return;` —— 宿主没装/没有天生武器时
         * strike.prepare 提前 return，maximum 停在 0。这时几何确实是退化的，
         * 但**因是空手，不是因为数据写错**（那属于 I1 那一类）。计入 weaponUnresolved，不报。
         */
        const strikes = safe("a2:strikes", () => toArray(p.usage?.strikes).length, 0);
        if ( rng.weapon === true && !strikes ) {
          a2.weaponUnresolved.push({actionId: p.id, origin: u.origin, actor: u.actor?.name ?? null});
          return;
        }

        const addRange = pcfg.region.addSize ? ((u.actor?.size ?? p.actor?.size ?? 0) / 2) : 0;
        add("A2", "blocker", {...base, kind: "REGION_SPAN_ZERO",
          detail: `${t.type}（${pcfg.region.shape}）准备完成后跨度仍为 0。${g.formula}${g.note ? "；" + g.note : ""}`,
          observed: {span: 0, residualAddRange: addRange,
            addSize: !!pcfg.region.addSize, strikesResolved: strikes,
            gridDistance: a2.gridDistance},
          reasoning: addRange
            ? `残留半径只有 addRange = actor.size/2 = ${addRange} 尺（:2866），小于一格；`
              + `而 :19623 在 target.self 为假时先把施法者排除 ⇒ 目标恒为 0`
            : "addSize 为假，形状尺寸精确为 0",
          player: "范围模板画出来了，却缩在施法者脚下，怎么摆都框不住人"});
      }
    }

    /* ============================================================ */
    /*  A2-T1 / A2-T2  区域取靶：空 disposition 集                    */
    /* ============================================================ */
    if ( pcfg.region ) {
      if ( t.scope === SCOPES.SELF ) {
        add("A2", "blocker", {...base, kind: "REGION_SCOPE_SELF",
          detail: "区域类型 + target.scope = SELF：:19731 返回空数组，"
            + ":19624 的 `dispositions.includes(...)` 恒假，每个候选都被 continue ⇒ 目标恒为 0。"
            + "对照单体路径 :19687 有 `.length` 守卫，两条路径语义相反",
          player: "范围放出来、聊天卡出了，目标栏是空的，一颗骰子都不掷"});
      }
      else if ( t.scope === SCOPES.NONE ) {
        add("A2", "major", {...base, kind: "REGION_SCOPE_NONE",
          detail: "区域类型 + target.scope = NONE：同 :19731 空集，取靶恒为 0；"
            + "且 :19871 `#getQualifyingEvent` 对 scope NONE 直接 return false",
          caveat: "scope NONE 也可能是「本来就不打算取靶、靠钩子结算」的写法 —— "
            + "落地前必须先确认这条动作有没有注册钩子（crucible/ember 两侧都 grep）",
          player: "区域模板放得下去，但没有任何目标被记录"});
      }

      /* --------------------------------------------------------- */
      /*  A2-I1  区域动作上的 range.minimum 是不是死字段              */
      /* --------------------------------------------------------- */
      if ( (rng.minimum ?? 0) > 0 ) {
        // strike 链一旦生效，:20190 会读 _source.range.minimum 当武器可用性门槛
        const strikeChain = tags.includes("strike") || safe("a2:wc", () => (p.usage?.weaponChoices ?? []).length, 0) > 0;
        if ( !strikeChain ) {
          add("A2", "info", {...base, kind: "REGION_MINIMUM_INERT",
            detail: `range.minimum = ${rng.minimum} 写在区域类型上，但三个消费点没有一个会读它：`
              + ":19692 仅 single、:3054 仅 movement、:20190 需要 strike 链解析出武器。"
              + "作者若以为它是「内圈半径」，那个语义在 crucible 里不存在",
            player: "没有可观察症状 —— 这条只说明数据里有个不起作用的字段"});
        }
      }
    }

    /* ============================================================ */
    /*  A2-T3  单体：可达距离集合与 [min,max] 无交                    */
    /* ============================================================ */
    if ( t.type === "single" ) {
      a2.singleEvaluated++;
      const min = rng.minimum ?? 0;
      const max = rng.maximum;
      const gd = a2.gridDistance;
      if ( min > 0 && gd ) {
        /**
         * 可达的基座距离（:32122 getLinearRange）：
         *   足迹重叠或贴边 ⇒ 0；否则 canvas.grid.measurePath 的整格步进。
         * D = {0, gd, 2gd, ...}。斜向在某些格制下会出现中间值，
         * 所以这里只把 D 当**充分条件**：D 与 [min,max] 无交才报，
         * 有交则一定不报（不会因为 D 取窄了而漏掉正常动作）。
         */
        /**
         * ⚠ :19692 / :19694 两个门都写成 `if ( this.range.minimum && ... )`，
         *   所以 **0 与 null 一样等于「不设门」**。maximum 为 0/null ⇒ 上限不存在 ⇒ 必可达。
         */
        const hi = max ? max : Infinity;
        let reachable = (hi === Infinity);
        for ( let k = 1; !reachable && (k * gd <= hi + 1e-9) && (k <= 1000); k++ ) {
          if ( k * gd >= min - 1e-9 ) reachable = true;
        }
        if ( !reachable ) {
          add("A2", "blocker", {...base, kind: "SINGLE_RANGE_UNREACHABLE",
            detail: `single 的 [minimum=${min}, maximum=${max}] 里没有一个可达的基座距离。`
              + `:32122 对重叠/贴边返回 0（< ${min}，被 :19692 的 MinimumRange 拒），`
              + `再远一格是 ${gd} 尺（> ${max}，被 :19693 的 MaximumRange 拒）`,
            observed: {gridDistance: gd, reachableSet: `{0, ${gd}, ${2 * gd}, …}`},
            player: "贴着打说太近，退一格说太远 —— 这个动作对任何站位都点不出去"});
        }
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /*  还原 tempfix                                                     */
  /* ---------------------------------------------------------------- */
  if ( upstream ) for ( const [k, v] of Object.entries(suspended) ) TF.ACTION_PATCHES[k] = v;

  return a2;
}

/* ============================================================================
 * §草稿里被删掉的四条，以及删的理由（每条都用全语料复核过）
 *
 * ① REGION_EPHEMERAL_NO_EFFECT（「ephemeral 且 effects 为空 ⇒ 区域被删」）—— **删**。
 *    ephemeral 为 true 的 cone/fan/pulse/blast/ray/summon 本来就**不该**留下区域，
 *    `:20575` 的 delete 是设计而非缺陷；语料里 198 条非 summon 区域动作实例里绝大多数命中它，纯噪声。
 *    真正有判据的是反面：非 ephemeral 的 aura/wall 若没有自身效果承载区域 —— 但
 *    `#recordEffectEvents`（:19840）在 `regionEffectRequired` 时**自动补一条自身效果**，
 *    所以那个洞不存在。kineticWall 的「墙不该被删」属于**设计意图**（它应当写成
 *    `target.type:"wall"`），从数据里推不出来，本断言只报它可推的那一半（几何退化）。
 *
 * ② SUMMON_RANGE_UNSET（「summon 没写 maximum ⇒ 召唤物钉在身旁」）—— **删**。
 *    `clampSummonPlacement`（:32188）在 maxRange=0 时：先 `tMin = _searchLowest(...)`
 *    求出**不重叠**的最近距离（:32209），再 `t = Math.max(dist, tMin)`；
 *    超距时 `_searchHighest(tMin, t, ...)` 的谓词全假 ⇒ 返回 `lo = tMin`。
 *    也就是说召唤物落在**相邻合法位**，不是退化。29 条 summon 全部会被误报。
 *
 * ③ SINGLE_RANGE_DEGENERATE（`minimum === maximum`）—— **换掉**。
 *    全语料 0 命中（见校准表 D 行），是条空转断言；而它本想抓的 P2（suddenBite
 *    min=2 max=2）恰恰是 min===max —— 之所以 0 命中，是因为它还多加了
 *    `rng.maximum != null && rng.maximum === rng.minimum` 之外的过滤，且判在源数据上。
 *    换成「可达距离集合无交」后 P2 被抓到，且是全语料唯一命中。
 *
 * ④ MOVEMENT_TAG_SINGLE_TARGET —— **移出本断言**。
 *    它抓的是 N6（antigravityStone），属于「自身效果被迫选人」而非几何/取靶几何问题；
 *    而且草稿里的 `scope === ALL` 过滤是为了让计数好看**倒推出来的**（作者自己在注释里
 *    写「不加 scope 过滤会误报 9 条」），这是曲线拟合，不是判据。交给覆盖 N6 的那条断言。
 * ============================================================================ */

/* ============================================================================
 * §校准（离线，复现口径写在下面）
 *
 * 口径：递归遍历 packdump/ 与 packdump2/ 共 **24 个合集 JSON** 的**任意深度** `actions` 数组
 * （顶层取样会漏掉 ember.crucible-adventure.json 里嵌套的 265 个 actor —— 该文件独占
 * 851 条动作，占全语料 60%）。命中统计以「动作实例」为单位，同时给出去重后的数据形态数。
 *
 *   有 actions 的文件      11 / 24
 *   动作实例               1410
 *   不同 action id         342
 *   target.type 分布       single 802 / self 310 / pulse 110 / blast 46 / movement 42 /
 *                          summon 29 / none 29 / ray 15 / cone 11 / fan 9 / aura 7 / wall 0
 *   受几何判据管辖         227 - 29(summon) = 198 个实例
 *
 * ⚠ 校准是**离线模拟**：node 里跑不了 prepare()，所以按上面那张写点表把
 *   thrown(:4251) / strike(:4104, 以 range.weapon 为门) / 15 个动作钩子逐条模拟。
 *   模拟的是「哪些字段会被填」，不是填成多少 —— 对「span 是否为 0」这个二值判定足够。
 *   真实运行时不做模拟，直接读准备后的值。
 *
 * ── A) 静态判定会报、准备后自动消失的（= 草稿的误报面）：9 个数据形态 / 21 个实例
 *      12x explosiveEmergence  pulse  weapon=true  [melee,natural,empowered]      ← 任务点名
 *       3x tailSweep           pulse  weapon=true  [natural]                       ← 任务点名
 *       1x whirlwind           pulse  weapon=true  [dualwield,melee,mainhand,offhand] ← 任务点名
 *       2x sentinelSpin        pulse  weapon=true  [melee,mainhand]                ← 任务点名
 *       1x penetratingShot     ray    weapon=true  [mechanical,ranged,weakened]    ← 任务没点名，同类
 *       1x penetratingThrow    ray    weapon=false [melee,thrown]                  ← 任务点名，走 :4251
 *      **准备后全部 span > 0，本断言 0 命中。** 其中 penetratingThrow 是唯一一条不靠
 *      range.weapon 而靠 `thrown.prepare` 的，正是草稿翻车的那条。
 *
 * ── B) 准备后仍退化（= A2-G1 的全部命中）：3 个数据形态 / 8 个实例
 *       6x steamVent   pulse  size=- max=-  weapon=false  [ranged,fire]
 *                      → circle baseRange 0；`ranged` 虽经 propagate 到 strike，
 *                        但 range.weapon 为 false，:4104 那行不执行 ⇒ 停在 0。**C6** ✔
 *       2x kineticWall ray    size=10 max=- weapon=false  []
 *                      → line 取 maxRange=0；size=10 只是射线宽度（:2933）⇒ 长度 0。**kineticWall** ✔
 *      除这两条外**无其他命中**。任务要求的三条必中里，第三条 dawnBeacon 不由几何抓，
 *      由 A2-T1 抓（它 size=60，几何完全正常）。
 *
 * ── C) A2-T1/T2（区域 + scope SELF/NONE）：7 个数据形态 / 9 个实例
 *      scope=SELF（blocker）
 *       3x dawnBeacon        pulse size=60  effects=[{scope:ENEMIES, statuses:[blinded]}]   **C5** ✔
 *                            → 60 尺光柱照常画出，但 :19731 空集 ⇒ 0 目标；
 *                              自身也进不了（effect scope 是 ENEMIES，:19874–:19876 对自身 return false）
 *                              ⇒ **整条动作完全空转**
 *       3x engulfingDarkness pulse size=20  effects=[]     ← 不在 27 条清单里，与 C5 同形状
 *      scope=NONE（major，需人工确认）
 *       2x steelJawArm       blast size=2 max=4    effects=[] tags=[consume]
 *       1x cosmicGemCharge   blast size=2 max=120  effects=[]
 *      已 grep：crucible-compiled.mjs 与 ember 的三份 mjs 里，这四个 id **一个钩子都没注册**。
 *      所以 engulfingDarkness / steelJawArm / cosmicGemCharge 同时也是「可证明的空动作」，
 *      与 X1 同类，最终归属交给 A7 那条断言裁决 —— 本断言只报「取不到靶」这一面。
 *
 * ── D) 草稿的 `minimum === maximum`：**0 命中**（空转断言，已删）
 *
 * ── E) 换上「可达距离无交」后，全语料带 range.minimum 的 6 个数据形态逐条过：
 *      suddenBite        single   min=2  max=2    → D∩[2,2] = ∅          **命中（P2）** ✔
 *      implacableHunter  single   min=1  max=60   → 5,10,…,60 可达        不报
 *                        （附带事实：min=1 使贴身 d=0 被排除，Wirrun 标记不了贴身目标；
 *                          但这属于「设计取舍」，不是取不到靶，不报）
 *      drakonfire        cone     min=8  max=8    → cone 不读 minimum     不报，改由 A2-I1 记 info
 *      lunariumTidalWave ray      min=60 max=60   → `natural`→melee→strike 链在，
 *                        :20190 会读 _source.minimum；d=60 可达（12 格）不报
 *      ferociousLeap     movement min=4  max=10   → 走 :3054 连续距离      不报
 *      flyingKick        movement min=3  max=null → 同上，且 max 由 :9533 填 不报
 *      **命中面 = {suddenBite}，误报面 = 空。**
 *
 * ── 汇总：三个必中全中（steamVent / kineticWall / dawnBeacon），
 *          外加 P2(suddenBite) 与两条同形状的新发现（engulfingDarkness、scope-NONE 两条）；
 *          六条已知误报（penetratingThrow + explosiveEmergence/tailSweep/whirlwind/sentinelSpin
 *          + penetratingShot）**全部不命中**。
 * ============================================================================ */

/* ============================================================================
 * §falsePositives —— 逐条断言的误报面与排除法
 *
 * A2-G1 REGION_SPAN_ZERO
 *   1. 【已排除】标签在准备期补距。thrown(:4251) 补 10 尺；strike(:4104) 在
 *      `range.weapon === true` 时按武器射程补。**排除法：只读准备后的值**，
 *      不做任何 `range.weapon` 白名单式的静态豁免（草稿就是这么试的，结果放跑了
 *      penetratingThrow 那种不靠 weapon 的）。
 *   2. 【已排除】动作钩子在准备期补距（15 个 id，行号见抬头）。同上，读准备后的值即可。
 *   3. 【降级为不可判】`range.weapon:true` 但宿主空手 ⇒ :4049 提前 return，maximum 停 0。
 *      这时几何确实退化，但成因是宿主装备而非数据。**排除法：查 `usage.strikes.length`，
 *      为 0 就记进 `R.a2.weaponUnresolved` 不报。** 换一个带武器的宿主再跑就消失。
 *   4. 【结构性豁免】summon —— 几何被 :2946 覆写、取靶在 :19452 提前返回。硬跳过。
 *   5. 【残余风险】aura（emanation）span=0 时形状恰好等于施法者自身足迹。
 *      若某条 aura 的设计意图就是「只影响站在我格子里的人」，会是误报。
 *      语料里 7 条 aura 全部有 size 或 maximum，**当前 0 命中**；真出现时按底座语义人工判。
 *   6. 【不可判】动作若在 `preActivate` 之后才改几何 —— 已核实 crucible/ember 都没有
 *      这种写法（19 个写点全在 initialize/prepare）。若上游新增，本断言会误报，
 *      届时把写点表补齐即可。
 *
 * A2-T1 REGION_SCOPE_SELF
 *   1. 【结构性豁免】summon 的 scope 按 TARGET_TYPES 就是 SELF，且 :19452 提前返回。硬跳过。
 *   2. 【已排除】法术姿态（gesture）的 scope 由 :45557 从 TARGET_TYPES 反写，
 *      composed 法术又被 `reshape.prepare`(:13458) 覆写成 ALLIES/ENEMIES ⇒ 永不为 SELF。
 *      读准备后的值自动排除，不需要额外过滤。
 *   3. 【残余风险】若一条区域动作**只**打算给自己挂效果（effect.scope = SELF），
 *      那么零外部目标是无害的 —— 自身效果仍会应用（:19799 `allActors` 会补上施法者）。
 *      **排除法：finding 里带上 `effects[].scope`，全部为 SELF 时人工降级。**
 *      dawnBeacon 不属于这种：它唯一那条效果是 ENEMIES 作用域，:19874–:19876 对自身 return false。
 *
 * A2-T2 REGION_SCOPE_NONE
 *   1. 【已知误报面】scope NONE 可能表示「取靶交给钩子」。**排除法：报之前先 grep
 *      `crucible.api.hooks.action[id]` 与 ember 两份 mjs**。当前三条命中全部 0 钩子。
 *   2. 严重度定为 major 而非 blocker，就是因为这条判据自身不闭合。
 *
 * A2-T3 SINGLE_RANGE_UNREACHABLE
 *   1. 【已排除】movement 类型 —— 它走 :3054 的连续距离规划，不受格点集约束。
 *      判据只对 `target.type === "single"` 生效。
 *   2. 【已排除】区域类型 —— 区域路径根本不读 minimum。
 *   3. 【保守化】可达集只取 `{0} ∪ {k·gridDistance}`。真实斜向距离在某些格制下有中间值，
 *      **只会让可达集变大 ⇒ 只会让本断言更保守（漏报而非误报）**。这是有意的方向选择。
 *   4. 【依赖 canvas】gridDistance 取自 `canvas.grid.distance`。canvas 未就绪时整条跳过
 *      （`a2.gridDistance === null` 时不报），不用 5 尺去假设。
 *   5. 【残余风险】巨型生物基座大，:32122 是基座到基座，min 较大时仍可能贴身可达。
 *      这只会让实际可达集更宽 ⇒ 同样是漏报方向。
 *
 * A2-I1 REGION_MINIMUM_INERT
 *   1. 【已排除】带 strike 链的区域动作 —— :20190 会读 `_source.range.minimum` 当武器
 *      可用性门槛，字段不是死的。判据里用 `tags.has("strike") || usage.weaponChoices.length`。
 *      lunariumTidalWave（natural→melee→strike）正是靠这条被排除。
 *   2. 严重度 info：它没有玩家可见症状，只是数据里有个不起作用的字段。
 *
 * ── 全局：**这条断言测的是上游**。装着 tempfix 跑而不开 upstreamMode，
 *          P2 与 C5 会被 tempfix 自己的 prepare/initialize 补丁抹掉（tempfix.mjs:181/632），
 *          呈现为「已修复」。upstreamMode 默认开，且把挂起的补丁名字原样记进
 *          `R.a2.tempfixPatchesSuspended`，让读数的人能看见这件事发生过。
 * ============================================================================ */
