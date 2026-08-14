/**
 * 队伍 token 在 hex 图上不可见 —— 分层取证
 *
 * **这是浏览器控制台脚本，不是 node 脚本**（probes/ 下其它几个是 node 的）。
 * 用法：切到 vista、再切回 hex 图，**在 token 不可见的那一刻**，F12 控制台整段粘进去回车。
 *
 * 它只读不写（除了最后 probe.* 那几个显式调用），跑完把返回的对象整个贴回来。
 *
 * 要回答的问题是「**哪一层**断了」，而不是「猜哪里错了」：
 *   L0 对象还在不在        —— token / object / placeable / 类名（查 EmberVistaToken 泄漏）
 *   L1 token 自己的显示态   —— visible / renderable / alpha / hidden / elevation
 *   L2 mesh 与遮挡          —— mesh.visible / occluded / occludedAlpha
 *   L3 谁盖在它上面         —— elevation > -1 且覆盖 token 中心的 primary 精灵，逐个列出遮挡配置
 *   L4 泄漏的状态           —— renderable=false 且带 _oRenderable 的对象、未复原的 SFX 集合
 *   L5 位置与剔除           —— bounds 是不是被 vista 的视差算法算歪了
 */
(() => {
  const out = { _t: new Date().toISOString(), scene: null, L0: {}, L1: {}, L2: {}, L3: [], L4: {}, L5: {} };
  const safe = (fn, d = null) => { try { return fn(); } catch (e) { return `ERR: ${e.message}`; } };
  const num = v => (typeof v === "number" ? Math.round(v * 100) / 100 : v);

  /* ---------- 场景 ---------- */
  out.scene = safe(() => ({
    name: canvas.scene?.name,
    id: canvas.scene?.id,
    manager: ember?.scene?.constructor?.name,
    managerScene: ember?.scene?.scene?.name,
    level: canvas.level?.id,
    slice: safe(() => ember.region?.currentHex?.slice?.id ?? ember.region?.["#slice"]?.id, "(private)"),
    ready: canvas.ready
  }));

  /* ---------- L0 对象存在性 / 类泄漏 ---------- */
  const doc = safe(() => ember?.partyToken);
  const tok = safe(() => ember?.partyToken?.object);
  out.L0 = safe(() => ({
    hasDocument: !!doc,
    docId: doc?.id,
    docName: doc?.name,
    hasObject: !!tok,
    destroyed: tok?.destroyed ?? null,
    inPlaceables: !!canvas.tokens?.placeables?.includes(tok),
    inScene: !!canvas.scene?.tokens?.get(doc?.id),
    // 关键：vista 的 Token 子类有没有漏到 hex 图上
    tokenClass: tok?.constructor?.name,
    configuredClass: CONFIG.Token.objectClass?.name,
    classChain: safe(() => {
      const names = []; let p = tok?.constructor;
      while (p && names.length < 8) { names.push(p.name); p = Object.getPrototypeOf(p); }
      return names.join(" < ");
    }),
    VISTA_CLASS_LEAKED: /Vista/i.test(tok?.constructor?.name ?? "") || /Vista/i.test(CONFIG.Token.objectClass?.name ?? "")
  }));

  /* ---------- L1 token 显示态 ---------- */
  out.L1 = safe(() => ({
    visible: tok?.visible,
    renderable: tok?.renderable,
    alpha: num(tok?.alpha),
    worldAlpha: num(tok?.worldAlpha),
    parentName: tok?.parent?.name ?? tok?.parent?.constructor?.name,
    parentVisible: tok?.parent?.visible,
    parentRenderable: tok?.parent?.renderable,
    position: safe(() => ({ x: num(tok.position.x), y: num(tok.position.y) })),
    docXY: { x: doc?.x, y: doc?.y },
    sourceXY: { x: doc?._source?.x, y: doc?._source?.y },
    elevation: doc?.elevation,
    level: doc?.level,
    sort: doc?.sort,
    hidden: doc?.hidden,
    isSecret: safe(() => doc?.isSecret),
    controlled: tok?.controlled,
    // 视野判定（与遮挡是两回事）
    isVisibleTest: safe(() => tok?.isVisible),
    detectionFilter: !!tok?.detectionFilter
  }));

  /* ---------- L2 mesh 与遮挡 ---------- */
  const mesh = safe(() => tok?.mesh);
  out.L2 = safe(() => ({
    hasMesh: !!mesh,
    meshDestroyed: mesh?.destroyed ?? null,
    meshVisible: mesh?.visible,
    meshRenderable: mesh?.renderable,
    meshAlpha: num(mesh?.alpha),
    meshWorldAlpha: num(mesh?.worldAlpha),
    meshParent: mesh?.parent?.name ?? mesh?.parent?.constructor?.name,
    meshParentVisible: mesh?.parent?.visible,
    meshParentRenderable: mesh?.parent?.renderable,
    meshElevation: mesh?.elevation,
    meshSort: mesh?.sort,
    meshPos: safe(() => ({ x: num(mesh.position.x), y: num(mesh.position.y) })),
    // token 自己被不被遮挡（一般 token 不参与被遮挡，这里只是排除）
    meshOccluded: mesh?.occluded,
    meshOcclusionMode: mesh?.occlusionMode,
    meshOccludedAlpha: num(mesh?.occludedAlpha),
    // Ember 的复合 token 容器
    dynamic: safe(() => {
      const d = tok?.emberDynamicToken;
      if (!d) return null;
      return {
        visible: d.visible, renderable: d.renderable, alpha: num(d.alpha),
        childCount: d.children?.length,
        visibleChildren: d.children?.filter(c => c.visible).length,
        shadowEnabled: d.shadowEnabled
      };
    }),
    // 图层级遮挡开关：Ember 在 _initialize 里设成裸 VISIBLE，core 在 TokenLayer#_draw 里重置成 CONTROLLED|VISIBLE|HIGHLIGHTED
    layerOcclusionMode: canvas.tokens?.occlusionMode,
    TOKEN_OCCLUSION_MODES: safe(() => ({ ...CONST.TOKEN_OCCLUSION_MODES })),
    layerModeHasVISIBLE: safe(() => !!(canvas.tokens.occlusionMode & CONST.TOKEN_OCCLUSION_MODES.VISIBLE)),
    // undefined 说明 ember 那句 `CONST.TOKEN_OCCLUSION_MODES?.VISIBLE` 取到了 undefined
    layerModeIsUndefined: canvas.tokens?.occlusionMode === undefined
  }));

  /* ---------- L3 谁盖在它上面 ---------- */
  // 队伍 token 被刻意放在 elevation:-1，也就是画在地表美术之下；
  // 它能被看见**完全依赖**上面那些精灵被遮挡（occludedAlpha→0）而让开。
  // 所以这一节是本次排查的核心：列出所有覆盖 token 中心、且 elevation 更高的 primary 子对象。
  out.L3 = safe(() => {
    if (!tok) return "(无 token 对象)";
    const tb = tok.getBounds();
    const cx = tb.x + tb.width / 2;
    const cy = tb.y + tb.height / 2;
    const rows = [];
    for (const c of canvas.primary?.children ?? []) {
      if (c === mesh) continue;
      let b; try { b = c.getBounds(); } catch { continue; }
      if (!b || !b.width || !b.height) continue;
      if (!b.contains(cx, cy)) continue;
      const elev = c.elevation ?? 0;
      rows.push({
        name: c.name ?? c.constructor?.name,
        cls: c.constructor?.name,
        elevation: elev,
        sort: c.sort,
        aboveParty: elev > (doc?.elevation ?? -1),
        visible: c.visible,
        renderable: c.renderable,
        alpha: num(c.alpha),
        occlusionMode: c.occlusionMode,
        occluded: c.occluded,
        occludedAlpha: num(c.occludedAlpha),
        occlusionRadius: c.occlusionRadius,
        textureAlphaThreshold: c.textureAlphaThreshold,
        hoverFade: !!c.hoverFade,
        // 这一条是不是「盖住了又不肯让开」的元凶
        BLOCKS: (elev > (doc?.elevation ?? -1)) && c.visible && c.renderable
          && (c.alpha > 0.01) && !(c.occluded && (c.occludedAlpha < 0.5)),
        hasOwnRenderableBackup: "_oRenderable" in c
      });
    }
    rows.sort((a, b) => (b.elevation - a.elevation) || (b.sort ?? 0) - (a.sort ?? 0));
    return rows;
  });

  /* ---------- L4 泄漏的状态 ---------- */
  out.L4 = safe(() => ({
    // deactivateSFXEffects 存 _oRenderable 再置 renderable=false；
    // _onTearDown 走的是 clearAndDelete()（只清集合、**不复原**），所以切场景可能把 false 留在对象上
    primaryChildrenNotRenderable: (canvas.primary?.children ?? [])
      .filter(c => c.renderable === false)
      .map(c => ({ name: c.name ?? c.constructor?.name, cls: c.constructor?.name, _oRenderable: c._oRenderable })),
    withRenderableBackup: (canvas.primary?.children ?? [])
      .filter(c => "_oRenderable" in c)
      .map(c => ({ name: c.name ?? c.constructor?.name, renderable: c.renderable, _oRenderable: c._oRenderable })),
    withPaddingBackup: (canvas.primary?.children ?? [])
      .filter(c => "_oPadding" in c)
      .map(c => ({ name: c.name ?? c.constructor?.name, pluginName: c.pluginName, _oPadding: c._oPadding })),
    sfxSetPresent: !!ember?.scene?._deactivatedSFXObjects,
    spriteSetPresent: !!ember?.scene?._deactivatedSpriteEffectObjects,
    primaryChildCount: canvas.primary?.children?.length
  }));

  /* ---------- L5 位置与剔除 ---------- */
  out.L5 = safe(() => {
    const r = canvas.dimensions?.rect;
    const tb = tok ? tok.getBounds() : null;
    return {
      tokenBounds: tb ? { x: num(tb.x), y: num(tb.y), w: num(tb.width), h: num(tb.height) } : null,
      // vista 的 get bounds 用的是视差坐标；泄漏到 hex 图上会让 bounds 明显离谱
      boundsSane: tb ? (tb.width > 0 && tb.height > 0 && Math.abs(tb.x) < 1e6 && Math.abs(tb.y) < 1e6) : null,
      sceneRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      stageScale: num(canvas.stage?.scale?.x),
      cullable: tok?.cullable,
      meshCullable: mesh?.cullable
    };
  });

  /* ---------- 结论倾向 ---------- */
  out.VERDICT = safe(() => {
    const v = [];
    if (out.L0.VISTA_CLASS_LEAKED) v.push("A: vista 的 Token 子类漏到了 hex 图上（位置/bounds 走视差算法）");
    if (out.L1.hidden) v.push("B: 文档本身 hidden=true");
    if (out.L1.visible === false) v.push("C: token.visible=false —— 是**视野**判定挡的，与遮挡无关");
    if (out.L2.meshVisible === false && out.L1.visible !== false) v.push("D: mesh.visible=false 但 token.visible 正常 —— renderable 被谁按住了");
    if (out.L2.layerModeIsUndefined) v.push("E: canvas.tokens.occlusionMode 是 undefined（CONST.TOKEN_OCCLUSION_MODES 取空）");
    if (out.L2.layerModeHasVISIBLE === false) v.push("F: 图层遮挡掩码里没有 VISIBLE 位 —— 地表精灵不会为 token 让开");
    const blockers = Array.isArray(out.L3) ? out.L3.filter(r => r.BLOCKS) : [];
    if (blockers.length) v.push(`G: 有 ${blockers.length} 个精灵盖在 token 上且没有让开：` + blockers.map(b => b.name).join(", "));
    if (out.L4.primaryChildrenNotRenderable?.length) v.push("H: primary 里有 renderable=false 的残留（SFX 复原漏了）");
    if (out.L5.boundsSane === false) v.push("I: token 的 bounds 算歪了（视差坐标泄漏）");
    return v.length ? v : ["未命中任何已知模式 —— 把整个对象贴回来"];
  });

  /* ---------- 非破坏性探针（要手动一条条跑，别一次全跑） ---------- */
  globalThis.probe = {
    /** 强制走一次遮挡重算（绕过 occlusionMode setter 的 `值没变就 return` 早退） */
    refreshOcclusion() {
      const M = CONST.TOKEN_OCCLUSION_MODES;
      const before = canvas.tokens.occlusionMode;
      canvas.tokens.occlusionMode = 0;
      canvas.tokens.occlusionMode = before ?? M.VISIBLE;
      canvas.perception.update({ refreshOcclusion: true });
      return `occlusionMode ${before} → 0 → ${canvas.tokens.occlusionMode}，已请求 refreshOcclusion。看 token 回来没有`;
    },
    /** 强制把 token 自己重画一遍 */
    refreshToken() {
      const t = ember.partyToken?.object;
      if (!t) return "没有 token 对象";
      t.renderFlags.set({ refreshVisibility: true, refreshState: true, refreshMesh: true, refreshPosition: true });
      t.applyRenderFlags();
      return { visible: t.visible, meshVisible: t.mesh?.visible, alpha: t.alpha };
    },
    /** 把 primary 里所有 renderable=false 的残留放回来（验证 H） */
    restoreRenderable() {
      let n = 0;
      for (const c of canvas.primary.children) {
        if (c.renderable === false) { c.renderable = c._oRenderable ?? true; n++; }
      }
      return `复原了 ${n} 个对象的 renderable`;
    },
    /** 把盖在 token 上的精灵逐个临时藏掉，看是哪一个挡的（刷新即恢复，不写盘） */
    hideBlockers() {
      const t = ember.partyToken?.object;
      const tb = t.getBounds(), cx = tb.x + tb.width / 2, cy = tb.y + tb.height / 2;
      const hidden = [];
      for (const c of canvas.primary.children) {
        if (c === t.mesh) continue;
        let b; try { b = c.getBounds(); } catch { continue; }
        if (!b?.contains(cx, cy)) continue;
        if ((c.elevation ?? 0) <= (ember.partyToken.elevation ?? -1)) continue;
        c.visible = false; hidden.push(c.name ?? c.constructor?.name);
      }
      return { hidden, note: "token 现在露出来了吗？露出来 = 确认是遮挡问题。刷新 F5 恢复" };
    },
    /** 只把 token 抬到 elevation 0 之上试试（**会写盘**，验证完记得改回 -1） */
    async raiseElevation(e = 1) {
      await ember.partyToken.update({ elevation: e });
      return `elevation → ${e}（原值 -1，验证完请 probe.raiseElevation(-1) 改回去）`;
    }
  };

  console.log("%c队伍 token 取证", "font-size:14px;font-weight:bold");
  console.log(out);
  if (Array.isArray(out.L3) && out.L3.length) console.table(out.L3);
  console.log("%c倾向：", "font-weight:bold", out.VERDICT);
  console.log("探针（一条条手动跑）：probe.refreshOcclusion() / probe.refreshToken() / probe.restoreRenderable() / probe.hideBlockers() / probe.raiseElevation()");
  return out;
})();
