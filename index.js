/**
 * 一键复制标记（SiYuan plugin）
 *
 * 两种复制方式（右键菜单里给文本打标记时二选一）：
 *   click  - 单击文本直接复制，光标变小手
 *   button - 悬停出复制按钮，可开常驻
 * 另：选中任意文本 -> 选区右下角浮出临时复制按钮
 */
const { Plugin, Setting, openEmoji } = require("siyuan");

const COPY_GLYPH = "\uD83D\uDCCB";        // 📋
const OK_HAND = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 48 48"><g fill="none" stroke-width="3"><path fill="#8fbffa" d="M30.964 8.067c-.387-.804-.67-1.722-.307-2.536c.812-1.817 2.731-2.352 4.043-2.498c.865-.096 1.698.263 2.274.915c3.6 4.07 7.24 12.943 7.016 23.048c-.15 6.743-2.701 11.35-4.65 13.903c-1.31 1.717-3.284 2.712-5.408 3.11c-3.182.594-8.376 1.28-13.887.825c-2.255-.186-4.49-.763-6.408-1.964c-3.911-2.449-6.665-6.293-7.425-11.75c-.274-1.966.774-3.891 2.682-4.44q.556-.164 1.191-.277c1.53-.27 2.676 1.1 3.167 2.574c1.113 3.342 4.205 5.464 7.246 4.555c.62-.24 1.223-.602 1.76-.989c1.448-1.04 2.07-2.958 1.263-4.549c-1.463-2.89-4.454-4.152-8.082-3.214c-1.635.423-3.456.247-4.421-1.138a16 16 0 0 1-.623-.965c-1.17-1.968-.396-4.485 1.665-5.485c3.837-1.864 8.013-1.683 12.008-.142c-1.617-2.675-3.578-5.116-5.88-6.987c-.926-.754-1.686-1.827-1.43-2.994c.372-1.696 1.5-2.778 2.434-3.407c.836-.563 1.905-.506 2.79-.024c4.579 2.496 8.43 6.708 10.634 9.554c-.376-1.899-.947-3.664-1.652-5.125"/><path stroke="#2859c5" stroke-linecap="round" stroke-linejoin="round" d="M30.964 8.067c-.387-.804-.67-1.722-.306-2.536c.811-1.817 2.73-2.352 4.043-2.498c.864-.096 1.698.263 2.274.915c3.6 4.07 7.24 12.943 7.015 23.048c-.15 6.743-2.7 11.35-4.65 13.903c-1.31 1.717-3.284 2.712-5.408 3.11c-3.182.594-8.376 1.28-13.887.825c-2.254-.186-4.49-.763-6.407-1.964c-3.912-2.449-6.666-6.293-7.426-11.75c-.274-1.966.775-3.891 2.683-4.44q.556-.164 1.19-.277c1.53-.27 2.676 1.1 3.167 2.574c1.113 3.342 4.206 5.464 7.246 4.555c.62-.24 1.223-.602 1.76-.989c1.448-1.04 2.07-2.958 1.264-4.549c-1.464-2.89-4.455-4.152-8.083-3.214c-1.635.423-3.456.247-4.421-1.138a16 16 0 0 1-.622-.965c-1.172-1.968-.397-4.485 1.664-5.485c3.837-1.864 8.014-1.683 12.008-.142c-1.617-2.675-3.578-5.116-5.88-6.987c-.926-.754-1.686-1.827-1.43-2.994c.372-1.696 1.5-2.778 2.434-3.407c.836-.563 1.905-.506 2.79-.024c4.58 2.496 8.43 6.708 10.634 9.554c-.376-1.899-.947-3.664-1.652-5.125"/></g></svg>';

const MARK_SEL = 'span[style*="--sycopy"]';
const HOLD_MS = 3000;
const HOVER_GRACE_MS = 400;

class CopyMarkPlugin extends Plugin {
  async onload() {
    this.conf = Object.assign({ copyIcon: "", okIcon: "", persistent: false,
      enableClick: true, enableButton: true, inlineCodeCopy: false }, (await this.loadData("conf")) || {});

    // 解析自定义图标（emoji 原样用，Iconify 名称走 API 转 SVG）
    this.copyHTML = await this.resolveIcon(this.conf.copyIcon, COPY_GLYPH);
    this.okHTML = await this.resolveIcon(this.conf.okIcon, OK_HAND);

    this.current = null;      // 当前目标：标记 span
    this.currentText = "";
    this.savedRange = null;   // 右键时的选区快照
    this.holdUntil = 0;       // 点击后按钮保持到什么时候
    this.busy = false;
    this.raf = null;
    this.hideTimer = null;
    this.rangeMode = false;   // 当前按钮是跟选区还是跟 span

    this.buildUI();
    this.bindEvents();
    try { this.syncInlineButtons(); } catch (e) { console.error("[copy-mark] inline:", e); }
    // ponytail: 3s 轮询兜底（切文档/编辑后跟位），滚动和缩放另有即时触发
    this.inlineTimer = setInterval(() => {
      if (this.conf && this.conf.persistent) {
        try { this.syncInlineButtons(); } catch (e) {}
      }
    }, 3000);
    try { this.buildSetting(); } catch (e) { console.error("[copy-mark] setting:", e); }
    try { this.applyCodeCursor(); } catch (e) { console.error("[copy-mark] codeCursor:", e); }
  }

  onunload() {
    if (this.inlineTimer) { clearInterval(this.inlineTimer); this.inlineTimer = null; }
    if (this.inlineLayer && this.inlineLayer.parentNode) this.inlineLayer.parentNode.removeChild(this.inlineLayer);
    if (this.inlineMap) this.inlineMap.clear();
    this.unbindEvents();
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
    this.btn = null;

    const cur = document.getElementById("cm-code-cursor");
    if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
  }

  /* ---------------- 设置 ---------------- */

  // 支持两种写法：直接给 emoji；或给 Iconify 名（iconify/集合--图标名）
  async resolveIcon(spec, fallback) {
    const v = (spec || "").trim();
    if (!v) return fallback;
    // iconify 名里也有 "/"，必须先判，否则会被下面当成图片路径
    const m = /^iconify\/([a-z0-9-]+)--([a-z0-9-]+)$/i.exec(v);
    if (m) {
      try {
        const r = await fetch("https://api.iconify.design/" + m[1] + "/" + m[2] + ".svg?height=16");
        if (r.ok) {
          const t = await r.text();
          if (t && t.indexOf("<svg") !== -1) return t;
        }
      } catch (e) {}
      return fallback;
    }

    // 思源自定义表情返回的是图片相对路径
    if (v.indexOf("/") !== -1 || /\.(png|jpe?g|gif|webp|svg)$/i.test(v)) {
      const src = v.charAt(0) === "/" ? v : "/emojis/" + v;
      return '<img src="' + src + '" style="width:16px;height:16px;object-fit:contain;vertical-align:middle;">';
    }

    return v;   // emoji 字符
  }

  buildSetting() {
    let copyPicker, okPicker;

    // 图标落盘 + 立即重渲染（选中就存，不等确认）
    const saveIcons = async () => {
      this.conf.copyIcon = copyPicker ? copyPicker.getValue() : "";
      this.conf.okIcon = okPicker ? okPicker.getValue() : "";
      await this.saveData("conf", this.conf).catch(() => {});
      this.copyHTML = await this.resolveIcon(this.conf.copyIcon, COPY_GLYPH);
      this.okHTML = await this.resolveIcon(this.conf.okIcon, OK_HAND);
      this.btn.innerHTML = this.copyHTML;
      if (this.inlineLayer) this.inlineLayer.innerHTML = "";
      if (this.inlineMap) this.inlineMap.clear();
      this.syncInlineButtons();
    };

    const makePicker = (current, fallback) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "b3-button b3-button--outline";
      btn.style.cssText = "font-size:16px;line-height:1;padding:4px 12px;min-width:60px;min-height:32px;"
        + "display:inline-flex;align-items:center;justify-content:center;";

      let value = current || "";

      const render = async () => {
        if (!value) { btn.innerHTML = fallback; return; }
        const html = await this.resolveIcon(value, "");
        if (html) { btn.innerHTML = html; } else { btn.textContent = value; }
      };
      render();

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const r = btn.getBoundingClientRect();
        try {
          openEmoji({
            position: { x: r.left, y: r.bottom + 4 },
            selectedCB: (em) => {
              value = em;
              render();
              saveIcons();      // 选中即存
            },
          });
        } catch (err) {}
      });

      btn.getValue = () => value;
      btn.reset = () => { value = ""; btn.innerHTML = fallback; };
      return btn;
    };

    copyPicker = makePicker(this.conf.copyIcon, this.copyHTML || COPY_GLYPH);
    okPicker = makePicker(this.conf.okIcon, this.okHTML || OK_HAND);

    // 开关：各自独立，拨动即存，互不影响
    const pSwitch = document.createElement("input");
    pSwitch.type = "checkbox";
    pSwitch.className = "b3-switch";
    pSwitch.checked = !!this.conf.persistent;
    pSwitch.addEventListener("change", () => {
      this.conf.persistent = pSwitch.checked;
      this.saveData("conf", this.conf).catch(() => {});
      this.syncInlineButtons();
    });

    const cSwitch = document.createElement("input");
    cSwitch.type = "checkbox";
    cSwitch.className = "b3-switch";
    cSwitch.checked = this.conf.enableClick !== false;
    cSwitch.addEventListener("change", () => {
      this.conf.enableClick = cSwitch.checked;
      this.saveData("conf", this.conf).catch(() => {});
    });

    const bSwitch = document.createElement("input");
    bSwitch.type = "checkbox";
    bSwitch.className = "b3-switch";
    bSwitch.checked = this.conf.enableButton !== false;
    bSwitch.addEventListener("change", () => {
      this.conf.enableButton = bSwitch.checked;
      this.saveData("conf", this.conf).catch(() => {});
      this.syncInlineButtons();
    });

    // 行内代码点击复制：默认关闭，不标记也能用
    const iSwitch = document.createElement("input");
    iSwitch.type = "checkbox";
    iSwitch.className = "b3-switch";
    iSwitch.checked = this.conf.inlineCodeCopy === true;
    iSwitch.addEventListener("change", () => {
      this.conf.inlineCodeCopy = iSwitch.checked;
      this.saveData("conf", this.conf).catch(() => {});
      this.applyCodeCursor();
    });

    // 确认只兜底图标，绝不覆盖两个开关
    this.setting = new Setting({
      confirmCallback: () => { saveIcons(); },
    });

    this.setting.addItem({
      title: "复制图标",
      createActionElement: () => copyPicker,
    });
    this.setting.addItem({
      title: "成功图标",
      createActionElement: () => okPicker,
    });
    this.setting.addItem({
      title: "常驻复制按钮",
      description: "开启后，标记过的文字右侧一直显示复制按钮。",
      createActionElement: () => pSwitch,
    });
    this.setting.addItem({
      title: "点击文本直接复制",
      description: "对应右键菜单里的同名选项，关闭后该方式不可用。",
      createActionElement: () => cSwitch,
    });
    this.setting.addItem({
      title: "仅悬停显示复制按钮",
      description: "对应右键菜单里的同名选项，关闭后该方式不可用。",
      createActionElement: () => bSwitch,
    });
    this.setting.addItem({
      title: "行内代码点击复制",
      description: "开启后，点一下行内代码就直接复制（无需先标记）。按住 Ctrl / Cmd 再点可正常编辑。",
      createActionElement: () => iSwitch,
    });

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "b3-button b3-button--outline";
    resetBtn.textContent = "恢复默认";
    resetBtn.addEventListener("click", async () => {
      copyPicker.reset();
      okPicker.reset();
      this.conf.copyIcon = "";
      this.conf.okIcon = "";
      await this.saveData("conf", this.conf).catch(() => {});
      this.copyHTML = COPY_GLYPH;
      this.okHTML = OK_HAND;
      this.btn.innerHTML = this.copyHTML;
      if (this.inlineLayer) this.inlineLayer.innerHTML = "";
      if (this.inlineMap) this.inlineMap.clear();
      this.syncInlineButtons();
    });

    this.setting.addItem({
      title: "恢复默认图标",
      createActionElement: () => resetBtn,
    });
  }

  // 常驻按钮：每个标记文本右侧一直挂一个复制按钮
  syncInlineButtons() {
    if (!this.inlineLayer) {
      this.inlineLayer = document.createElement("div");
      this.inlineLayer.contentEditable = "false";
      this.inlineLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147482998;";
      document.body.appendChild(this.inlineLayer);
    }
    if (!this.inlineMap) this.inlineMap = new Map();

    // 设置页/对话框打开时不挂按钮，避免浮在对话框上
    const dialogOpen = !!document.querySelector(".b3-dialog");

    if (!this.conf.persistent || dialogOpen || this.conf.enableButton === false) {
      this.inlineLayer.innerHTML = "";   // 连孤儿节点一起清掉
      this.inlineMap.clear();
      return;
    }

    const spans = document.querySelectorAll('.protyle-wysiwyg span[style*="--sycopy"]');

    // ponytail: 上限 200，超了就不挂常驻按钮（悬停仍然可用），防止极端文档卡死
    if (spans.length > 200) {
      this.inlineLayer.innerHTML = "";
      this.inlineMap.clear();
      return;
    }

    const alive = new Set();

    spans.forEach((span) => {
      if (this.spanMode(span)) return;   // 点击模式不需要按钮
      const r = span.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) return;

      alive.add(span);
      let btn = this.inlineMap.get(span);
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.contentEditable = "false";
        btn.innerHTML = this.copyHTML || COPY_GLYPH;
        btn.style.cssText = "position:absolute;display:flex;align-items:center;justify-content:center;"
          + "width:22px;height:22px;border:none;border-radius:5px;padding:0;margin:0;"
          + "background:var(--b3-theme-surface);color:var(--b3-theme-on-surface);"
          + "box-shadow:0 1px 5px rgba(0,0,0,.16);cursor:pointer;pointer-events:auto;"
          + "font-size:13px;line-height:1;opacity:.75;transition:opacity .12s;";
        btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
        btn.addEventListener("mouseleave", () => { btn.style.opacity = ".75"; });
        btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const txt = this.cleanText(span.textContent || "");
          if (!txt) return;
          const br = btn.getBoundingClientRect();
          // 先把按钮收起来，让 ok 反馈独占这块位置，之后再恢复
          btn.style.display = "none";
          this.copyText(txt, br.left + br.width / 2, br.top + br.height / 2, false, () => {
            btn.style.display = "flex";
          });
        });
        this.inlineLayer.appendChild(btn);
        this.inlineMap.set(span, btn);
      }
      btn.innerHTML = this.copyHTML || COPY_GLYPH;
      btn.style.left = (r.right + 6) + "px";
      btn.style.top = (r.top + r.height / 2 - 11) + "px";
    });

    this.inlineMap.forEach((btn, span) => {
      if (!alive.has(span)) { btn.remove(); this.inlineMap.delete(span); }
    });
  }

  /* ---------------- UI ---------------- */

  buildUI() {
    const layer = document.createElement("div");
    layer.contentEditable = "false";
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.contentEditable = "false";
    btn.title = "复制";
    btn.style.cssText =
      "position:absolute;display:none;align-items:center;justify-content:center;" +
      "width:24px;height:24px;margin:0;padding:0;border:none;border-radius:5px;" +
      "background:var(--b3-theme-surface);color:var(--b3-theme-on-surface);" +
      "box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer;pointer-events:auto;" +
      "user-select:none;font-size:15px;line-height:1;opacity:.92;" +
      "transition:color .12s,opacity .12s;";
    btn.innerHTML = this.copyHTML || COPY_GLYPH;

    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; this.cancelHide(); });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = ".92"; this.scheduleHide(); });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.doCopy();
    });

    layer.appendChild(btn);
    document.body.appendChild(layer);

    this.layer = layer;
    this.btn = btn;
  }

  showAt(left, top) {
    if (left + 26 > window.innerWidth) left = Math.max(2, left - 30);
    if (top + 26 > window.innerHeight) top = Math.max(2, top - 26);
    this.btn.style.left = left + "px";
    this.btn.style.top = top + "px";
    this.btn.style.display = "flex";
  }

  hide() {
    this.btn.style.display = "none";
    this.current = null;
    this.currentText = "";
    this.rangeMode = false;
    this.holdUntil = 0;
  }

  cancelHide() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  scheduleHide() {
    this.cancelHide();
    const delay = Math.max(HOVER_GRACE_MS, this.holdUntil - Date.now());
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (Date.now() < this.holdUntil) return;
      this.hide();
    }, delay);
  }

  /* ---------------- 定位 ---------------- */

  place() {
    if (this.rangeMode) { this.placeForRange(); return; }
    if (!this.current || !this.current.isConnected) { this.hide(); return; }
    const r = this.current.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 &&
      r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    if (!visible) { this.hide(); return; }
    this.showAt(r.right + 4, r.top + r.height / 2 - 12);
  }

  placeForRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { this.hide(); return; }
    const rects = sel.getRangeAt(0).getClientRects();
    if (!rects.length) { this.hide(); return; }
    const r = rects[rects.length - 1];
    if (!r || (r.width === 0 && r.height === 0)) { this.hide(); return; }
    this.showAt(r.right + 6, r.bottom + 4);
  }

  schedulePlace() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.place(); });
  }

  /* ---------------- 复制 ---------------- */

  cleanText(t) {
    return t.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "");
  }

  /* ---------------- 行内代码点击复制 ---------------- */

  // 命中行内代码则返回该元素，否则 null
  inlineCodeOf(t) {
    if (!t || !t.closest) return null;
    // 必须用 ~= 而不是 =：思源会把加粗的行内代码渲染成 data-type="strong code"，
    // 精确匹配只能命中单纯的行内代码，会漏掉加粗/斜体等叠加样式的情况
    let code = t.closest('span[data-type~="code"], span[data-type~="inline-code"]');
    if (!code) {
      // 兜底：某些主题或渲染路径下可能是裸 <code>
      const c = t.closest("code");
      if (c && !c.classList.contains("hljs")) code = c;
    }
    if (!code) return null;
    if (!code.closest(".protyle-wysiwyg")) return null;
    // 代码块自带复制按钮，那里的点击要继续能编辑
    if (code.closest('[data-type="NodeCodeBlock"]')) return null;
    if (!this.cleanText(code.textContent || "").trim()) return null;
    return code;
  }

  // 必须在 mousedown 阶段拦：click 时光标已经进了行内代码，拦不住编辑态
  onMouseDown(e) {
    if (e.button !== 0) return;
    if (this.conf.inlineCodeCopy !== true) return;
    // 修饰键放行，保留正常进入编辑的能力
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

    const code = this.inlineCodeOf(e.target);
    if (!code) return;

    e.preventDefault();
    e.stopPropagation();

    const text = this.cleanText(code.textContent || "");
    if (!text) return;

    this._codeCopiedAt = Date.now();
    const r = code.getBoundingClientRect();
    let fx = r.right + 18;
    if (fx + 12 > window.innerWidth) fx = Math.max(14, r.left - 18);
    const fy = r.top + r.height / 2;
    this.copyText(text, fx, fy, false);
  }

  // 开启时把行内代码的指针改成小手，提示可点
  applyCodeCursor() {
    const ID = "cm-code-cursor";
    const on = this.conf.inlineCodeCopy === true;
    let el = document.getElementById(ID);
    if (on) {
      if (!el) {
        el = document.createElement("style");
        el.id = ID;
        el.textContent = '.protyle-wysiwyg span[data-type~="code"]{cursor:pointer;}';
        document.head.appendChild(el);
      }
    } else if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  flash() {
    this.busy = true;
    this.btn.innerHTML = this.okHTML;
    setTimeout(() => {
      if (!this.btn) return;   // 插件已卸载，btn 被置空
      this.btn.innerHTML = this.copyHTML || COPY_GLYPH;
      this.busy = false;
    }, 1200);
  }

  doCopy() {
    if (this.busy) return;
    let text = this.currentText;
    if (this.rangeMode) {
      const sel = window.getSelection();
      text = sel ? this.cleanText(sel.toString()) : "";
    }
    if (!text) return;
    const rect = this.btn.getBoundingClientRect();
    this.copyText(text, rect.left + rect.width / 2, rect.top + rect.height / 2, true);
  }

  // 统一复制入口：成功后给即时反馈
  copyText(text, x, y, onButton, onDone) {
    const done = (ok) => {
      if (ok) {
        if (onButton) { this.flash(); } else { this.showFlash(x, y); }
      }
      if (onDone) { setTimeout(onDone, 1100); }   // 等 ok 反馈(700+320)完全淡出
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(this.fallbackCopy(text))
      );
    } else {
      done(this.fallbackCopy(text));
    }
  }

  // 点击位置弹出 ok-hand，淡出消失（Telegram 式反馈）
  showFlash(x, y) {
    const el = document.createElement("div");
    el.innerHTML = this.okHTML;
    el.style.cssText = "position:fixed;z-index:2147483001;pointer-events:none;"
      + "transform:translate(-50%,-50%);opacity:1;transition:opacity .3s;"
      + "filter:drop-shadow(0 2px 6px rgba(0,0,0,.25));";
    el.style.left = x + "px";
    el.style.top = y + "px";
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 700);
  }

  /* ---------------- 标记 ---------------- */

  markedSpansIn(range) {
    if (!range) return [];
    const node = range.commonAncestorContainer;
    const root = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    if (!root) return [];
    const scope = (root.closest && root.closest(".protyle-wysiwyg")) || document.body;
    const all = scope.querySelectorAll(MARK_SEL);
    const out = [];
    for (let i = 0; i < all.length; i++) {
      try { if (range.intersectsNode(all[i])) out.push(all[i]); } catch (e) {}
    }
    return out;
  }

  notifySave(el) {
    if (!el) return;
    const editable = el.closest ? el.closest('[contenteditable="true"]') : null;
    if (!editable) return;
    try {
      editable.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: false, inputType: "insertText", data: null
      }));
    } catch (e) {
      editable.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  restoreRange() {
    if (!this.savedRange) return false;
    const sel = window.getSelection();
    if (!sel) return false;
    try {
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
      return true;
    } catch (e) { return false; }
  }

  elOf(n) {
    if (!n) return null;
    return n.nodeType === 1 ? n : n.parentElement;
  }

  // 行内代码是原子 token：选区只压到一半就把整段包进来，绝不切开
  // 返回 false 表示选区无效（调整后为空）
  snapCode(range) {
    const startEl = this.elOf(range.startContainer);
    const endEl = this.elOf(range.endContainer);
    const blockOf = (el) => (el && el.closest && el.closest("[data-node-id]")) || null;
    const b1 = blockOf(startEl), b2 = blockOf(endEl);

    // 只扫选区涉及的块；跨块时逐块处理，避免全文档遍历
    let codes = [];
    if (b1 && b1 === b2) {
      codes = Array.from(b1.querySelectorAll('span[data-type~="code"]'))
        .filter((sp) => range.intersectsNode(sp));
    } else {
      const host = (startEl && startEl.closest && startEl.closest(".protyle-wysiwyg")) || null;
      if (!host) return true;
      codes = Array.from(host.querySelectorAll('span[data-type~="code"]'))
        .filter((sp) => {
          const b = blockOf(sp);
          if (!b) return false;
          const inSel = (b === b1 || b === b2);
          return inSel && range.intersectsNode(sp);
        });
    }
    if (!codes.length) return true;

    const startIn = codes.find((sp) => sp.contains(startEl));
    const endIn = codes.find((sp) => sp.contains(endEl));
    try {
      if (startIn) range.setStartBefore(startIn);
      if (endIn) range.setEndAfter(endIn);
    } catch (e) { return false; }
    return !range.collapsed;
  }

  stamp(node, clickMode) {
    node.style.setProperty("--sycopy", "1");
    node.style.setProperty("--sycopy-mode", clickMode ? "click" : "button");
    if (clickMode) { node.style.cursor = "pointer"; }
    else { node.style.removeProperty("cursor"); }
  }

  applyMark(clickMode) {
    if (!this.restoreRange()) return;
    const range = this.savedRange;
    if (!range.toString()) return;
    if (!this.snapCode(range)) return;

    const sel = window.getSelection();
    const collapseAfter = (node) => {
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    };

    // 先抽出片段，再逐个节点打标记
    const frag = range.extractContents();

    // 格式节点（行内代码/加粗/斜体/链接/高亮…）必须自己带样式：
    // 包在它外面会被 Lute 拍平成纯文本，包在它里面会被整个丢弃
    frag.querySelectorAll("span[data-type]").forEach((sp) => this.stamp(sp, clickMode));

    // 剩下的裸文本，各包一层 text span
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach((n) => {
      if (!n.nodeValue) return;
      const p = n.parentElement;
      if (p && p.closest("span[data-type]")) return;   // 已在格式节点里，上面打过了
      const span = document.createElement("span");
      span.setAttribute("data-type", "text");
      this.stamp(span, clickMode);
      span.textContent = n.nodeValue;
      n.parentNode.insertBefore(span, n);
      n.parentNode.removeChild(n);
    });

    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) collapseAfter(last);

    const tail = last || (range.startContainer.nodeType === 1
      ? range.startContainer : range.startContainer.parentElement);
    this.notifySave(tail);
  }

  // 每个标记自己记着模式，互不影响
  spanMode(span) {
    if (!span) return false;
    const v = (span.style.getPropertyValue("--sycopy-mode") || "").trim();
    return v === "click";
  }

  setSpanMode(span, clickMode) {
    if (!span) return;
    if (clickMode) {
      span.style.setProperty("--sycopy-mode", "click");
      span.style.cursor = "pointer";
    } else {
      span.style.setProperty("--sycopy-mode", "button");
      span.style.removeProperty("cursor");
    }
    this.notifySave(span);
  }

  /* ---------------- 右键菜单 ---------------- */

  injectMenuItem() {
    const items = document.querySelector(".b3-menu .b3-menu__items");
    if (!items || items.querySelector(".sycopy-mode")) return;
    this.injectModeItems(items);
  }

  // 复制方式选择：直接摆在右键菜单里，第一次用就能选
  injectModeItems(items) {
    if (items.querySelector(".sycopy-mode")) return;

    const marks = this.markedSpansIn(this.savedRange);
    const current = marks.length ? this.spanMode(marks[0]) : null;

    const modes = [];
    if (this.conf.enableClick !== false) {
      modes.push({ key: true, glyph: "\uD83D\uDD90", label: "点击文本直接复制" });
    }
    if (this.conf.enableButton !== false) {
      modes.push({ key: false, glyph: "\uD83D\uDCCB", label: "仅悬停显示复制按钮" });
    }
    if (!modes.length) return;   // 两种方式都关了，菜单里什么都不加

    const sep = document.createElement("button");
    sep.className = "b3-menu__separator sycopy-mode";
    items.appendChild(sep);

    modes.forEach((m) => {
      const checked = current !== null && current === m.key;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "b3-menu__item sycopy-mode";
      item.innerHTML =
        '<span class="b3-menu__icon" style="font-size:13px;line-height:1;display:inline-flex;'
        + 'align-items:center;justify-content:center;width:14px;">' + (checked ? "\u2713" : "") + "</span>"
        + '<span class="b3-menu__label" style="opacity:' + (checked ? "1" : ".55") + ';">'
        + m.glyph + " " + m.label + "</span>";
      item.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const spans = this.markedSpansIn(this.savedRange);
          if (spans.length) {
            // 已标记：只改这几段的模式，不影响别处
            spans.forEach((sp) => this.setSpanMode(sp, m.key));
          } else {
            // 未标记：新建标记并写入所选模式
            this.applyMark(m.key);
          }
        } catch (err) {}
        try { window.siyuan.menus.menu.remove(); } catch (err) {}
      });
      items.appendChild(item);
    });
  }

  /* ---------------- 事件 ---------------- */

  onMouseOver(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (this.btn && this.btn.contains(t)) { this.cancelHide(); return; }

    // 快路径：绝大多数 mouseover 落在普通文字上，先廉价排除，避免 closest 逐层匹配
    const selfStyle = (t.getAttribute && t.getAttribute("style")) || "";
    const span = selfStyle.indexOf("--sycopy") !== -1 ? t : t.closest(MARK_SEL);
    if (span) {
      // 本段是点击模式、按钮方式被关、或已开常驻按钮时，都不挂悬停按钮
      if (this.spanMode(span) || this.conf.persistent) return;
      if (this.conf.enableButton === false) return;
      this.cancelHide();
      this.rangeMode = false;
      this.current = span;
      this.currentText = this.cleanText(span.textContent || "");
      this.place();
    } else if (!this.rangeMode) {
      this.scheduleHide();
    }
  }

  onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (this.btn && this.btn.contains(t)) return;

    // 行内代码：mousedown 已处理过就不再重复；若被别的监听抢先没处理到，这里兜底复制
    const inlineCode = this.inlineCodeOf(t);
    if (inlineCode) {
      if (this.conf.inlineCodeCopy === true) {
        const justDone = this._codeCopiedAt && (Date.now() - this._codeCopiedAt < 800);
        if (!justDone && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          const text = this.cleanText(inlineCode.textContent || "");
          if (text) {
            e.preventDefault();
            e.stopPropagation();
            const r = inlineCode.getBoundingClientRect();
            let fx = r.right + 18;
            if (fx + 12 > window.innerWidth) fx = Math.max(14, r.left - 18);
            this.copyText(text, fx, r.top + r.height / 2, false);
          }
        }
      }
      return;
    }

    const span = t.closest(MARK_SEL);
    if (!span) return;

    if (!this.spanMode(span)) {
      if (this.conf.enableButton === false) return;   // 这种方式已被关掉
      // 只让按钮停留，光标照常进入文字，可编辑
      this.cancelHide();
      this.rangeMode = false;
      this.current = span;
      this.currentText = this.cleanText(span.textContent || "");
      this.holdUntil = Date.now() + HOLD_MS;
      this.place();
      return;
    }

    if (this.conf.enableClick === false) return;

    // 开启点击复制：直接复制（不放光标、不弹菜单）
    e.preventDefault();
    e.stopPropagation();
    const text = this.cleanText(span.textContent || "");
    if (!text) return;

    // 反馈图标放文字右边，别盖住内容
    const r = span.getBoundingClientRect();
    let fx = r.right + 18;
    if (fx + 12 > window.innerWidth) fx = Math.max(14, r.left - 18);
    const fy = r.top + r.height / 2;
    this.copyText(text, fx, fy, false);
  }

  onContextMenu(e) {
    // 右键先收起浮动按钮，别压住菜单
    this.hide();

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (!sel.toString().trim()) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest(".protyle-wysiwyg")) return;

    this.savedRange = sel.getRangeAt(0).cloneRange();
    this.menuTimers = [20, 90, 220].map((d) => setTimeout(() => this.injectMenuItem(), d));
  }

  onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.rangeMode = false;
      if (!this.current) this.hide();
      return;
    }
    // 这里只判断有无内容，不读全文：全选长文档时 toString() 会复制几 MB 字符串
    if (sel.rangeCount && sel.toString().trim() === "") { this.rangeMode = false; return; }

    const node = sel.anchorNode;
    const el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    if (!el || !el.closest || !el.closest(".protyle-wysiwyg")) return;

    this.rangeMode = true;
    this.currentText = "";   // 复制时现取
    this.schedulePlace();
  }

  bindEvents() {
    this._onMouseOver = (e) => this.onMouseOver(e);
    this._onClick = (e) => this.onClick(e);
    this._onMouseDown = (e) => this.onMouseDown(e);
    this._onCtx = (e) => this.onContextMenu(e);
    this._onSel = () => this.onSelectionChange();
    this._onScroll = () => { this.schedulePlace(); this.syncInlineButtons(); };
    this._onResize = () => { this.schedulePlace(); this.syncInlineButtons(); };

    document.addEventListener("mouseover", this._onMouseOver, true);
    // 挂 window 而不是 document：capture 阶段比 document 更早，避免被思源自己的监听抢先
    window.addEventListener("mousedown", this._onMouseDown, true);
    document.addEventListener("click", this._onClick, true);
    document.addEventListener("contextmenu", this._onCtx, true);
    document.addEventListener("selectionchange", this._onSel);
    window.addEventListener("scroll", this._onScroll, true);
    window.addEventListener("resize", this._onResize);
  }

  unbindEvents() {
    document.removeEventListener("mouseover", this._onMouseOver, true);
    window.removeEventListener("mousedown", this._onMouseDown, true);
    document.removeEventListener("click", this._onClick, true);
    document.removeEventListener("contextmenu", this._onCtx, true);
    document.removeEventListener("selectionchange", this._onSel);
    window.removeEventListener("scroll", this._onScroll, true);
    window.removeEventListener("resize", this._onResize);
    if (this.menuTimers) this.menuTimers.forEach(clearTimeout);
  }
}

module.exports = CopyMarkPlugin;
