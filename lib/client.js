// 提示词控制器（dsh-prompt-limiter）浏览器半边：设置里的一张卡片。
//
// 为什么手写 lazy-CJS 协议（window.__ModuleLoader__.load + 工厂返回
// cordis 插件导出）而不走打包：这样插件零构建、零依赖，`lib/client.js` 就是
// 源码。代价是只能用 `require` 拿 React 与宿主提供的包，UI 一律用原生元素 +
// 主题变量（--dsw-*）自绘，不 import 任何 dsh 客户端包。
//
// 数据全部来自宿主半边的 /prompt-limiter 路由：
//   GET  /prompt-limiter/report[?probe=1]  各方系统提示词大小与限额现状
//   POST /prompt-limiter/limits            改限额（落盘 limits.json）
//   POST /prompt-limiter/limits/reset      回到 cordis 行配置的默认值
// 这张卡片只做“看 + 改限额”，不修改任何提示词本身。
window.__ModuleLoader__.load({
  id: 'dsh-prompt-limiter',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 本包的 npm 名：插槽按包名分派，必须与 package.json 一致。 */
    var PACKAGE_NAME = 'dsh-prompt-limiter';

    /** 三种处置动作（与宿主半边 ACTION_KINDS 对齐）。 */
    var ACTIONS = ['warn', 'truncate', 'drop'];

    /** 文案。中文为主，英文备用——dsh 的界面语言由 locale 服务说了算，
     *  但这里只有几十个字符串，不值得为一句话拉一整套 locale 注册。 */
    var TEXT = {
      zh: {
        title: '提示词控制器',
        subtitle: '查看各方系统提示词的大小，并为单段或整体设置上限。',
        refresh: '刷新',
        probing: '探测中…',
        probe: '现场探测在线 Agent',
        probeShort: '现场探测',
        toolsShort: '工具',
        probeDiff: '与实际观测不同：现场组装拿不到的 provider 会让这个数偏小',
        probeHint: '为每个在线 Agent 在它自己的作用域里重新组装一次提示词，拿到此刻的确切组成。',
        loadFailed: '读取失败',
        saveFailed: '保存失败',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        reset: '重置为默认',
        loading: '加载中…',
        summary: '总览',
        parties: '各方',
        agg: '来源汇总',
        events: '最近越限',
        limitAction: '超限动作',
        actionWarn: '只记录（不改写）',
        actionTruncate: '截断',
        actionDrop: '丢弃',
        totalLimit: '总上限（字符，留空=不限）',
        sectionLimits: '逐段上限',
        sectionName: '段落 / 上下文名',
        sectionCap: '上限（字符）',
        addRow: '添加上限',
        wildcard: '兜底键 * ：未点名段落都用它',
        setLimit: '设为上限',
        remove: '删除',
        colName: '名称',
        colKind: '类型',
        colChars: '字符',
        colTokens: '≈token',
        colParties: '出现方数',
        colLimit: '上限',
        colState: '状态',
        over: '越限',
        ok: '正常',
        none: '不限制',
        noData: '还没有观测到任何组装。发起一次对话，或点「现场探测在线 Agent」。',
        neverObserved: '尚未观测到组装',
        assemblies: '组装次数',
        live: '在线',
        originSub: '子智能体',
        originRoot: '主 Agent',
        unknownParty: '未归属',
        peak: '峰值',
        violations: '越限次数',
        kindSection: '静态段落',
        kindContext: '运行时上下文',
        kindTool: '工具 schema',
        cols: '说明',
        expand: '展开明细',
        collapse: '收起明细',
        enable_tip: 'warn 是默认值：本插件只记账、绝不改写提示词。',
        viewFull: '查看全文',
        hideFull: '收起全文',
        clickItem: '点开看正文',
        copy: '复制',
        copyAll: '复制全文',
        copied: '已复制',
        copyFailed: '复制失败（浏览器不允许写剪贴板）',
        textLoading: '读取正文…',
        textFailed: '正文读取失败',
        textDisabled: '行配置 text:false 关掉了正文留存',
        notCaptured: '这一方还没组装过，或原文已超出留存上限被淘汰',
        oldHost: '宿主半边还是旧版本（/text 未注册）：重启 DSH 后即可点开正文',
        fromObserved: '来自实际组装',
        fromProbe: '来自现场探测',
        trimmedBanner: '这份正文已被限额裁剪过——它就是模型实际收到的那份。',
        trimmedShort: '已裁剪',
        emptyItem: '（这一项是空文本）',
        promptOrder: '按进模型的顺序：静态段落 → 运行时上下文 → 工具 schema。',
        colSource: '来源',
        colClass: '类别',
        clsDynamic: '动态回写',
        clsStatic: '静态',
        clsTool: '工具',
        onlyDynamic: '只看动态回写',
        suggestDynamic: '给动态项一键设限',
        dynamicLine: '动态回写',
        requests: '待批准的提额申请',
        noRequests: '没有待批准的申请',
        approve: '批准',
        reject: '拒绝',
        wanted: '申请到',
        currentCap: '现额度',
        noticeTitle: '模型当前收到的预算提示',
        noticeInactive: '未注入（没有配任何上限；配了才会占提示词的位置）',
        basisConfig: '你指定',
        basisCode: '扫源码',
        basisPrefix: '按名前缀推定',
        basisUnknown: '未知',
        sourceUnknown: '未知来源',
        whyVolatile: '实测在变',
        whyPrefix: '按名前缀',
        unlimitable: '静态/工具：默认不建议设限',
      },
      en: {
        title: 'Prompt controller',
        subtitle: 'Inspect the size of every party\u2019s system prompt and set per-section or total limits.',
        refresh: 'Refresh',
        probing: 'Probing…',
        probe: 'Probe live agents',
        probeShort: 'probe',
        toolsShort: 'tools',
        probeDiff: 'differs from the observed assembly (a probe can miss providers it cannot reach)',
        probeHint: 'Re-assembles each live agent\u2019s prompt inside its own scope for an exact current composition.',
        loadFailed: 'Load failed',
        saveFailed: 'Save failed',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reset: 'Reset to defaults',
        loading: 'Loading…',
        summary: 'Overview',
        parties: 'Parties',
        agg: 'By source name',
        events: 'Recent violations',
        limitAction: 'Action on exceed',
        actionWarn: 'Warn only (no rewrite)',
        actionTruncate: 'Truncate',
        actionDrop: 'Drop',
        totalLimit: 'Total limit (chars, empty = none)',
        sectionLimits: 'Per-section limits',
        sectionName: 'Section / context name',
        sectionCap: 'Limit (chars)',
        addRow: 'Add limit',
        wildcard: 'Wildcard * applies to every unnamed section',
        setLimit: 'Set limit',
        remove: 'Remove',
        colName: 'Name',
        colKind: 'Kind',
        colChars: 'Chars',
        colTokens: '≈tokens',
        colParties: 'Parties',
        colLimit: 'Limit',
        colState: 'State',
        over: 'over',
        ok: 'ok',
        none: 'none',
        noData: 'Nothing observed yet. Send a message, or use "Probe live agents".',
        neverObserved: 'not observed yet',
        assemblies: 'assemblies',
        live: 'live',
        originSub: 'subagent',
        originRoot: 'main agent',
        unknownParty: 'unattributed',
        peak: 'peak',
        violations: 'violations',
        kindSection: 'section',
        kindContext: 'context',
        kindTool: 'tool schema',
        cols: 'Note',
        expand: 'Details',
        collapse: 'Hide details',
        enable_tip: 'warn is the default: this plugin never rewrites a prompt while observing.',
        viewFull: 'View full prompt',
        hideFull: 'Hide full prompt',
        clickItem: 'Click to read',
        copy: 'Copy',
        copyAll: 'Copy all',
        copied: 'Copied',
        copyFailed: 'Copy failed (clipboard denied)',
        textLoading: 'Loading text…',
        textFailed: 'Could not load text',
        textDisabled: 'Text retention is off (row config text:false)',
        notCaptured: 'This party has not assembled yet, or its text was evicted by the retention cap',
        oldHost: 'The host half is an older build (no /text route): restart DSH to read prompt text',
        fromObserved: 'from the real assembly',
        fromProbe: 'from a probe',
        trimmedBanner: 'This text was trimmed by your limits — it is what the model actually received.',
        trimmedShort: 'trimmed',
        emptyItem: '(empty text)',
        promptOrder: 'In model order: static sections → runtime contexts → tool schemas.',
        colSource: 'Source',
        colClass: 'Class',
        clsDynamic: 'write-back',
        clsStatic: 'static',
        clsTool: 'tool',
        onlyDynamic: 'Write-back only',
        suggestDynamic: 'Suggest limits for write-back items',
        dynamicLine: 'write-back',
        requests: 'Raise requests awaiting you',
        noRequests: 'No pending requests',
        approve: 'Approve',
        reject: 'Reject',
        wanted: 'wants',
        currentCap: 'current cap',
        noticeTitle: 'Budget notice the model currently receives',
        noticeInactive: 'Not injected (no limits configured; it only costs prompt space when you set one)',
        basisConfig: 'declared by you',
        basisCode: 'found in source',
        basisPrefix: 'core prefix guess',
        basisUnknown: 'unknown',
        sourceUnknown: 'unknown source',
        whyVolatile: 'changed between runs',
        whyPrefix: 'by name prefix',
        unlimitable: 'static/tool: not a limit target by default',
      },
    };

    /** 取当前界面语言的文案；读不到就按页面语言猜。 */
    function makeText(localeRef) {
      var id = 'zh';
      try {
        var snap = localeRef.current && localeRef.current.getSnapshot ? localeRef.current.getSnapshot() : null;
        if (snap && typeof snap.id === 'string') id = snap.id;
      } catch (error) {
        /* 没有 locale 服务：看页面语言 */
      }
      if (!localeRef.current) {
        try {
          id = String(document.documentElement.lang || navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
        } catch (error) {
          id = 'zh';
        }
      }
      return id.toLowerCase().indexOf('zh') === 0 ? TEXT.zh : TEXT.en;
    }

    /** 千分位。 */
    function fmt(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—';
      return value.toLocaleString();
    }

    /** 时间戳 → 本地时分秒。 */
    function fmtTime(at) {
      if (typeof at !== 'number' || at <= 0) return '—';
      try {
        return new Date(at).toLocaleTimeString();
      } catch (error) {
        return '—';
      }
    }

    /** 短 id：会话 id 很长，界面里只留能认出人的那一段（去掉 session- 前缀与后面的 uuid）。 */
    function shortId(id) {
      if (typeof id !== 'string' || id === '') return '';
      var core = id.indexOf('session-') === 0 ? id.slice('session-'.length) : id;
      var dash = core.indexOf('-');
      if (dash > 0) core = core.slice(0, dash);
      return core.length > 8 ? core.slice(0, 8) : core;
    }

    /** 一方的显示名。 */
    function partyLabel(party, t) {
      if (!party.sessionId) return t.unknownParty;
      var head = party.header || {};
      var kind = head.origin === 'subagent' ? t.originSub : t.originRoot;
      var bits = [kind, shortId(party.sessionId)];
      if (typeof head.delegationDepth === 'number' && head.delegationDepth > 0) bits.push('d' + head.delegationDepth);
      if (head.agentPreset) bits.push(head.agentPreset);
      return bits.join(' · ');
    }

    /** 平铺的限额行（名 → 字符上限），保持插入顺序。 */
    function rowsFromCaps(caps) {
      var rows = [];
      var source = caps && typeof caps === 'object' ? caps : {};
      for (var name in source) {
        if (Object.prototype.hasOwnProperty.call(source, name)) rows.push({ name: name, value: String(source[name]) });
      }
      return rows;
    }

    /** 行 → 限额表；非法数字返回 null（调用方给出内联错误）。 */
    function capsFromRows(rows) {
      var out = {};
      for (var i = 0; i < rows.length; i += 1) {
        var name = String(rows[i].name || '').trim();
        var raw = String(rows[i].value || '').trim();
        if (name === '' && raw === '') continue;
        if (name === '') return { error: 'empty-name', index: i };
        var num = Number(raw);
        if (!isFinite(num) || num <= 0) return { error: 'bad-cap', index: i };
        out[name] = Math.floor(num);
      }
      return { caps: out };
    }

    /* ───────────────────────── 与宿主通信 ───────────────────────── */

    /** 解析一条路由应答：{ok:false} 或非 2xx 一律当失败抛出。 */
    function readEnvelope(response) {
      return response.json().catch(function () { return null; }).then(function (parsed) {
        if (!response.ok || parsed === null || parsed.ok === false) {
          var detail = parsed && parsed.error ? parsed.error : 'HTTP ' + response.status;
          throw new Error(String(detail));
        }
        return parsed;
      });
    }

    function getJson(url) {
      return fetch(url, { headers: { accept: 'application/json' } }).then(readEnvelope);
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readEnvelope);
    }

    /* ───────────────────────── 组件 ───────────────────────── */

    /** 主题色：拿不到主题变量时的兜底只求可读，不求好看。 */
    var C = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      dim: 'var(--dsw-alias-label-secondary, #6b7280)',
      line: 'var(--dsw-alias-border-l1, #e5e7eb)',
      line2: 'var(--dsw-alias-border-l2, #d1d5db)',
      panel: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
      card: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #d93f3f)',
      warn: 'var(--dsw-alias-state-warn-primary, #c47f00)',
      ok: 'var(--dsw-alias-state-success-primary, #1a9b52)',
    };

    var S = {
      section: { marginTop: '18px' },
      heading: { fontSize: '13px', fontWeight: 600, color: C.text, marginBottom: '8px' },
      intro: { fontSize: '12px', color: C.dim, lineHeight: 1.6, marginBottom: '10px' },
      card: { border: '1px solid ' + C.line, borderRadius: '12px', background: C.card, padding: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      btn: {
        fontSize: '12px', padding: '4px 10px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid ' + C.line2, background: 'transparent', color: C.text,
      },
      btnPrimary: {
        fontSize: '12px', padding: '4px 12px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid ' + C.brand, background: C.brand, color: '#fff',
      },
      input: {
        fontSize: '12px', padding: '4px 8px', borderRadius: '8px',
        border: '1px solid ' + C.line2, background: C.card, color: C.text,
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', color: C.dim, fontWeight: 500, padding: '4px 6px', borderBottom: '1px solid ' + C.line },
      td: { padding: '4px 6px', borderBottom: '1px solid ' + C.line, color: C.text, verticalAlign: 'top' },
      num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      pill: {
        display: 'inline-block', fontSize: '11px', padding: '1px 6px', borderRadius: '999px',
        border: '1px solid ' + C.line2, color: C.dim, marginLeft: '4px',
      },
      err: {
        fontSize: '12px', color: C.error, border: '1px solid ' + C.error, borderRadius: '8px',
        padding: '6px 8px', marginBottom: '8px',
      },
      bar: { height: '6px', borderRadius: '3px', background: C.line, overflow: 'hidden', minWidth: '60px' },
      link: { color: C.brand, cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap' },
      linkQuiet: { color: C.dim, cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap' },
      pre: {
        margin: '6px 0 0', padding: '8px 10px', background: C.panel,
        border: '1px solid ' + C.line, borderRadius: '8px',
        fontSize: '11.5px', lineHeight: 1.55, color: C.text,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere',
        maxHeight: '340px', overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
      },
      textHead: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: C.text, marginTop: '10px' },
      blockHead: {
        display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px',
        paddingBottom: '3px', borderBottom: '1px solid ' + C.line, fontSize: '12px', color: C.text,
      },
      warn: {
        fontSize: '12px', color: C.warn, border: '1px solid ' + C.warn, borderRadius: '8px',
        padding: '6px 8px', marginTop: '8px',
      },
    };

    /**
     * 造卡片组件。
     * @param react require('react') 拿到的 React
     * @param localeRef 语言句柄（可能为空）
     */
    function createCard(react, localeRef) {
      var h = react.createElement;

      /** 一条细进度条：段落字符占该方最大段落的比例。 */
      function bar(chars, max, over) {
        var width = max > 0 ? Math.max(2, Math.round((chars / max) * 100)) : 0;
        return h('div', { style: S.bar }, h('div', {
          style: { width: width + '%', height: '100%', background: over ? C.error : C.brand },
        }));
      }

      /**
       * 一方的明细：段落 / 上下文 / 工具。
       *
       * 定义在组件**内部**（而不是这里）——每一行都要能点开看正文，
       * 那就得闭包住 texts/openItem 这些状态。见组件里的 detail()。
       */

      return function PromptLimiterCard(props) {
        var t = makeText(localeRef);
        // 插件页用两种姿势问同一张卡片：`summary` 要一行字（列表里的摘要），
        // `page` 才是完整表单。忽略 view 会把整块面板塞进列表行里。
        var panel = props && props.panel === true;
        var view = props && props.view === 'summary' ? 'summary' : (panel ? 'panel' : 'page');
        var reportState = react.useState(null);
        var report = reportState[0];
        var setReport = reportState[1];
        var errorState = react.useState(null);
        var error = errorState[0];
        var setError = errorState[1];
        var noteState = react.useState(null);
        var note = noteState[0];
        var setNote = noteState[1];
        var busyState = react.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var draftState = react.useState({ action: 'warn', totalChars: '', rows: [] });
        var draft = draftState[0];
        var setDraft = draftState[1];
        var openState = react.useState({});
        var open = openState[0];
        var setOpen = openState[1];
        // 默认只看「动态回写」：上限真正该管的就是记忆/索引这一类回写内容。
        var dynamicFilterState = react.useState(true);
        var onlyDynamic = dynamicFilterState[0];
        var setOnlyDynamic = dynamicFilterState[1];
        // 正文（「具体提示词」）：按方懒加载一次，之后本地切；逐项展开与全文展开各一份开关。
        var textState = react.useState({});
        var texts = textState[0];
        var setTexts = textState[1];
        var itemState = react.useState({});
        var openItem = itemState[0];
        var setOpenItem = itemState[1];
        var fullState = react.useState({});
        var openFull = fullState[0];
        var setOpenFull = fullState[1];

        /** 把一份报告里的限额同步进草稿。 */
        var adoptLimits = function (limits) {
          setDraft({
            action: limits && ACTIONS.indexOf(limits.action) >= 0 ? limits.action : 'warn',
            totalChars: limits && typeof limits.totalChars === 'number' ? String(limits.totalChars) : '',
            rows: rowsFromCaps(limits ? limits.sections : {}),
          });
        };

        var load = function (probe) {
          setBusy(true);
          setError(null);
          setNote(null);
          getJson('/prompt-limiter/report' + (probe ? '?probe=1' : ''))
            .then(function (next) {
              setReport(next);
              adoptLimits(next.limits);
              if (probe) setNote(t.probe + ' ✓');
            })
            .catch(function (failure) { setError(t.loadFailed + ': ' + failure.message); })
            .then(function () { setBusy(false); });
        };

        react.useEffect(function () { load(false); }, []);

        var save = function () {
          var built = capsFromRows(draft.rows);
          if (built.error) {
            setError(built.error === 'empty-name' ? '有一行没写名字' : '上限必须是正整数');
            return;
          }
          var totalRaw = String(draft.totalChars || '').trim();
          var total = totalRaw === '' ? null : Number(totalRaw);
          if (total !== null && (!isFinite(total) || total <= 0)) {
            setError('总上限必须是正整数（或留空）');
            return;
          }
          setBusy(true);
          setError(null);
          setNote(null);
          postJson('/prompt-limiter/limits', { action: draft.action, totalChars: total, sections: built.caps })
            .then(function (result) {
              adoptLimits(result.limits);
              setNote(result.persisted === false ? t.saved + '（仅内存）' : t.saved);
              load(false);
            })
            .catch(function (failure) { setError(t.saveFailed + ': ' + failure.message); })
            .then(function () { setBusy(false); });
        };

        var reset = function () {
          setBusy(true);
          setError(null);
          postJson('/prompt-limiter/limits/reset', {})
            .then(function (result) { adoptLimits(result.limits); setNote(t.reset + ' ✓'); load(false); })
            .catch(function (failure) { setError(t.saveFailed + ': ' + failure.message); })
            .then(function () { setBusy(false); });
        };

        var patchRow = function (index, patch) {
          var rows = draft.rows.slice();
          rows[index] = Object.assign({}, rows[index], patch);
          setDraft(Object.assign({}, draft, { rows: rows }));
        };

        var removeRow = function (index) {
          var rows = draft.rows.slice();
          rows.splice(index, 1);
          setDraft(Object.assign({}, draft, { rows: rows }));
        };

        var addRow = function (name, value) {
          var rows = draft.rows.slice();
          rows.push({ name: name || '', value: value === undefined ? '' : String(value) });
          setDraft(Object.assign({}, draft, { rows: rows }));
        };

        var toggle = function (key) {
          var next = Object.assign({}, open);
          next[key] = !next[key];
          setOpen(next);
        };

        /** 批准 / 拒绝一条提额申请：决定权在人手里，这里只发这一票。 */
        var decide = function (requestId, approve) {
          setBusy(true);
          setError(null);
          setNote(null);
          postJson('/prompt-limiter/budget/decide', { id: requestId, approve: approve })
            .then(function (result) {
              setNote((approve ? t.approve : t.reject) + ' ✓ ' + requestId);
              if (result && result.limits) adoptLimits(result.limits);
              load(false);
            })
            .catch(function (failure) { setError(t.saveFailed + '：' + failure.message); })
            .then(function () { setBusy(false); });
        };

        /* ── 具体提示词：懒加载、逐项展开、全文阅读、复制 ───────────── */

        /** 把「看不到正文」的三种原因翻成人话。 */
        var reasonText = function (reason, failure) {
          if (reason === 'text-disabled') return t.textDisabled;
          if (reason === 'not-captured') return t.notCaptured;
          if (reason === 'unknown-party') return t.unknownParty;
          if (failure && /not-found|HTTP 404/.test(String(failure.message || failure))) return t.oldHost;
          return t.textFailed + '：' + (failure && failure.message ? failure.message : String(reason));
        };

        /** 取某一方的正文：整份抓一次，之后本地切（几十 KB 一次调用足够）。 */
        var loadText = function (partyKey) {
          var current = texts[partyKey];
          if (current && (current.status === 'loading' || current.status === 'ready')) return;
          setTexts(function (previous) {
            var next = Object.assign({}, previous);
            next[partyKey] = { status: 'loading' };
            return next;
          });
          getJson('/prompt-limiter/text?party=' + encodeURIComponent(partyKey))
            .then(function (data) {
              setTexts(function (previous) {
                var next = Object.assign({}, previous);
                next[partyKey] = data && data.available === true
                  ? { status: 'ready', data: data }
                  : { status: 'unavailable', reason: (data && data.reason) || 'not-captured' };
                return next;
              });
            })
            .catch(function (failure) {
              setTexts(function (previous) {
                var next = Object.assign({}, previous);
                next[partyKey] = { status: 'error', message: reasonText(null, failure) };
                return next;
              });
            });
        };

        /** 复制：优先剪贴板 API，老环境回退到 textarea + execCommand。 */
        var copyText = function (text) {
          var done = function () { setNote(t.copied); };
          try {
            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(text).then(done, function () { setError(t.copyFailed); });
              return;
            }
          } catch (error) { /* 落到回退路径 */ }
          try {
            var area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
            done();
          } catch (error) {
            setError(t.copyFailed);
          }
        };

        /** 逐项开关：第一次点顺手把这一方的整份正文取回来。 */
        var toggleItem = function (partyKey, kind, name) {
          var key = partyKey + '|' + kind + ':' + name;
          var next = Object.assign({}, openItem);
          next[key] = next[key] !== true;
          setOpenItem(next);
          if (next[key]) loadText(partyKey);
        };

        var itemOpen = function (partyKey, kind, name) {
          return openItem[partyKey + '|' + kind + ':' + name] === true;
        };

        var toggleFull = function (partyKey) {
          var next = Object.assign({}, openFull);
          next[partyKey] = next[partyKey] !== true;
          setOpenFull(next);
          if (next[partyKey]) loadText(partyKey);
        };

        /** 三态提示（加载中 / 看不到 + 原因 / 失败），共用给两种展开。 */
        var textNotReady = function (partyKey) {
          var state = texts[partyKey];
          if (!state || state.status === 'loading') return h('div', { style: S.intro }, t.textLoading);
          if (state.status === 'unavailable') return h('div', { style: S.intro }, reasonText(state.reason));
          if (state.status === 'error') return h('div', { style: S.err }, state.message);
          return null;
        };

        /** 已经取回的正文里挑一项（工具给美化后的 JSON）。 */
        var rawItemOf = function (data, kind, name) {
          var list = kind === 'section' ? data.sections : kind === 'context' ? data.contexts : data.tools;
          for (var i = 0; i < list.length; i += 1) {
            if (list[i].name === name) return kind === 'tool' ? list[i].json : list[i].text;
          }
          return null;
        };

        /** 一段正文 + 复制。 */
        var textPanel = function (text, key) {
          var body = typeof text === 'string' && text !== '' ? text : t.emptyItem;
          return h('div', { key: key },
            h('div', { style: S.textHead },
              h('span', { style: { flex: '1 1 auto', color: C.dim } }, fmt(body.length) + ' ' + t.colChars),
              h('a', {
                href: '#', style: S.link,
                onClick: function (event) { event.preventDefault(); copyText(body); },
              }, t.copy)),
            h('pre', { style: S.pre }, body));
        };

        /** 单项正文（挂在明细表那一行下面）。 */
        var itemText = function (party, kind, name) {
          var notReady = textNotReady(party.key);
          if (notReady !== null) return notReady;
          var text = rawItemOf(texts[party.key].data, kind, name);
          if (text === null) return h('div', { style: S.intro }, t.notCaptured);
          return textPanel(text, party.key + kind + name);
        };

        /** 全文按拼接顺序连起来（复制全文用）。 */
        var joinAll = function (data) {
          var parts = [];
          var add = function (head, text) { parts.push('===== ' + head + ' =====\n' + text); };
          var i;
          for (i = 0; i < data.sections.length; i += 1) add(data.sections[i].name, data.sections[i].text);
          for (i = 0; i < data.contexts.length; i += 1) add(data.contexts[i].name, data.contexts[i].text);
          for (i = 0; i < data.tools.length; i += 1) add('tool:' + data.tools[i].name, data.tools[i].json);
          return parts.join('\n\n');
        };

        /** 全文阅读器：按进模型的顺序铺开，逐块给复制。 */
        var fullReader = function (party) {
          var notReady = textNotReady(party.key);
          if (notReady !== null) return h('div', { style: { padding: '4px 0 8px' } }, notReady);
          var data = texts[party.key].data;
          var blocks = [];
          var push = function (kind, name, text) {
            var body = text === '' ? t.emptyItem : text;
            blocks.push(h('div', { key: 'blk-' + kind + '-' + name },
              h('div', { style: S.blockHead },
                h('span', { style: { flex: '1 1 auto' } }, name,
                  h('span', { style: { color: C.dim } },
                    ' · ' + (kind === 'section' ? t.kindSection : kind === 'context' ? t.kindContext : t.kindTool)
                    + ' · ' + fmt(body.length) + ' ' + t.colChars)),
                h('a', {
                  href: '#', style: S.linkQuiet,
                  onClick: function (event) { event.preventDefault(); copyText(body); },
                }, t.copy)),
              h('pre', { style: S.pre }, body)));
          };
          var i;
          for (i = 0; i < data.sections.length; i += 1) push('section', data.sections[i].name, data.sections[i].text);
          for (i = 0; i < data.contexts.length; i += 1) push('context', data.contexts[i].name, data.contexts[i].text);
          for (i = 0; i < data.tools.length; i += 1) push('tool', data.tools[i].name, data.tools[i].json);
          return h('div', { style: { padding: '4px 0 8px' } },
            h('div', { style: S.textHead },
              h('span', { style: { flex: '1 1 auto', color: C.dim } },
                t.promptOrder + ' · ' + (data.from === 'probe' ? t.fromProbe : t.fromObserved)
                + ' · ' + fmt(data.chars) + ' ' + t.colChars),
              h('a', {
                href: '#', style: S.link,
                onClick: function (event) { event.preventDefault(); copyText(joinAll(data)); },
              }, t.copyAll)),
            data.trimmed ? h('div', { style: S.warn }, t.trimmedBanner) : null,
            blocks);
        };

        /** 一方的明细：段落 / 上下文 / 工具；每行可点开看正文。 */
        /** 类别标签：动态回写 / 静态 / 工具，并给出判据（实测在变 / 按名前缀）。 */
        var classLabel = function (item) {
          if (item.class === 'tool') return { text: t.clsTool, color: C.dim, title: t.unlimitable };
          if (item.class === 'dynamic') {
            var why = item.dynamicBecause === 'volatile' ? t.whyVolatile : t.whyPrefix;
            return { text: t.clsDynamic + ' · ' + why, color: C.brand, title: t.clsDynamic };
          }
          return { text: t.clsStatic, color: C.dim, title: t.unlimitable };
        };

        /** 来源标签：插件名 + 依据（你指定 / 扫源码 / 按名前缀推定 / 未知）。 */
        var sourceLabel = function (item) {
          var source = item.source || {};
          var basis = source.basis === 'config' ? t.basisConfig
            : source.basis === 'code' ? t.basisCode
              : source.basis === 'prefix' ? t.basisPrefix
                : t.basisUnknown;
          return {
            text: source.plugin || t.sourceUnknown,
            suffix: basis,
            note: source.note || null,
          };
        };

        var detail = function (party) {
          var max = 1;
          var i;
          for (i = 0; i < party.sections.length; i += 1) max = Math.max(max, party.sections[i].chars);
          var rows = [];
          var push = function (kind, item) {
            var key = party.key + '|' + kind + ':' + item.name;
            var expanded = itemOpen(party.key, kind, item.name);
            var cls = classLabel(item);
            var src = sourceLabel(item);
            rows.push(h('tr', { key: key },
              h('td', { style: S.td },
                h('a', {
                  href: '#', style: S.link, title: t.clickItem,
                  onClick: function (event) { event.preventDefault(); toggleItem(party.key, kind, item.name); },
                }, expanded ? '▾ ' : '▸ ', item.name)),
              h('td', { style: S.td }, h('span', { style: { color: C.dim } },
                kind === 'section' ? t.kindSection : kind === 'context' ? t.kindContext : t.kindTool)),
              h('td', { style: S.td }, h('span', { style: { color: cls.color }, title: cls.title }, cls.text)),
              h('td', { style: S.td },
                h('div', { title: src.suffix }, src.text),
                h('div', { style: { fontSize: '10.5px', color: C.dim } }, src.suffix + (src.note ? ' · ' + src.note : ''))),
              h('td', { style: Object.assign({}, S.td, S.num) }, fmt(item.chars)),
              h('td', { style: Object.assign({}, S.td, S.num) }, fmt(item.estTokens)),
              h('td', { style: Object.assign({}, S.td, S.num) }, item.limit ? fmt(item.limit) : t.none),
              h('td', { style: S.td }, item.over
                ? h('span', { style: { color: C.error } }, t.over)
                : h('span', { style: { color: C.ok } }, t.ok)),
              h('td', { style: Object.assign({}, S.td, { width: '90px' }) }, bar(item.chars, max, item.over))));
            if (expanded) {
              rows.push(h('tr', { key: key + '-text' },
                h('td', {
                  style: Object.assign({}, S.td, { borderBottom: 'none', paddingBottom: '10px' }),
                  colSpan: 9,
                }, itemText(party, kind, item.name))));
            }
          };
          for (i = 0; i < party.sections.length; i += 1) push('section', party.sections[i]);
          for (i = 0; i < party.contexts.length; i += 1) push('context', party.contexts[i]);
          var items = party.tools && party.tools.items ? party.tools.items : [];
          for (i = 0; i < items.length; i += 1) push('tool', items[i]);

          return h('div', { style: { padding: '4px 0 8px' } },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, t.colName),
                h('th', { style: S.th }, t.colKind),
                h('th', { style: S.th }, t.colClass),
                h('th', { style: S.th }, t.colSource),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.colChars),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.colTokens),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.colLimit),
                h('th', { style: S.th }, t.colState),
                h('th', { style: S.th }, ''))),
              h('tbody', null, rows.length > 0 ? rows : h('tr', null,
                h('td', { style: S.td, colSpan: 9 }, h('span', { style: { color: C.dim } }, t.neverObserved))))));
        };

        /* ── 总览 + 限额编辑 ── */
        var parties = report ? report.parties : [];
        var maxTotal = 0;
        for (var i = 0; i < parties.length; i += 1) maxTotal = Math.max(maxTotal, parties[i].totalChars || 0);
        var overCount = 0;
        for (var j = 0; j < parties.length; j += 1) if (parties[j].over) overCount += 1;

        // 摘要视图：一行字说清此刻的体量与是否有人越限。
        if (view === 'summary') {
          if (error) return h('div', { style: { fontSize: '12px', color: C.error } }, error);
          if (!report) return h('div', { style: { fontSize: '12px', color: C.dim } }, t.loading);
          return h('div', { style: { fontSize: '12px', color: C.dim } },
            t.parties + ' ' + fmt(parties.length)
            + ' · max ' + fmt(maxTotal) + ' ' + t.colChars
            + ' · ' + fmt(report.observedAssemblies) + ' × ' + t.assemblies,
            overCount > 0 ? h('span', { style: { color: C.error } }, ' · ' + overCount + ' ' + t.over) : null);
        }

        var header = h('div', null,
          h('div', { style: { fontSize: '13px', fontWeight: 600, color: C.text } }, t.title),
          h('div', { style: S.intro }, t.subtitle));

        var buttons = [
          h('button', { key: 'refresh', style: S.btn, onClick: function () { load(false); }, disabled: busy }, t.refresh),
          h('button', { key: 'probe', style: S.btn, onClick: function () { load(true); }, disabled: busy }, busy ? t.probing : t.probe),
          note ? h('span', { key: 'note', style: { fontSize: '12px', color: C.ok } }, note) : null,
        ];

        var toolbar = h('div', { style: Object.assign({}, S.row, { marginBottom: '10px' }) }, buttons);

        // 注意：元素必须当「子节点」传，不能拼进字符串——拼进去会被 String() 成
        // [object Object]（渲染自测抓到的真 bug，见 test/render.mjs）。
        var summary = report ? h('div', { style: S.intro },
          t.summary + '：' + fmt(report.observedAssemblies) + ' × ' + t.assemblies
          + ' · ' + t.parties + ' ' + fmt(parties.length)
          + ' · max ' + fmt(maxTotal) + ' ' + t.colChars,
          overCount > 0 ? h('span', { style: { color: C.error } }, ' · ' + overCount + ' ' + t.over) : null) : null;

        var limitsBox = h('div', { style: S.card },
          h('div', { style: S.heading }, t.limitAction),
          h('div', { style: S.row },
            h('select', {
              style: S.input,
              value: draft.action,
              onChange: function (event) { setDraft(Object.assign({}, draft, { action: event.target.value })); },
            },
              h('option', { value: 'warn' }, t.actionWarn),
              h('option', { value: 'truncate' }, t.actionTruncate),
              h('option', { value: 'drop' }, t.actionDrop)),
            h('span', { style: { fontSize: '12px', color: C.dim } }, t.totalLimit),
            h('input', {
              style: Object.assign({}, S.input, { width: '110px' }),
              value: draft.totalChars,
              inputMode: 'numeric',
              placeholder: t.none,
              onChange: function (event) { setDraft(Object.assign({}, draft, { totalChars: event.target.value })); },
            })),
          h('div', { style: { height: '10px' } }),
          h('div', { style: S.heading }, t.sectionLimits),
          h('div', { style: S.intro }, t.wildcard),
          draft.rows.length === 0 ? h('div', { style: S.intro }, '—') : h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, t.sectionName),
              h('th', { style: Object.assign({}, S.th, S.num) }, t.sectionCap),
              h('th', { style: S.th }, ''))),
            h('tbody', null, draft.rows.map(function (row, index) {
              return h('tr', { key: 'row-' + index },
                h('td', { style: S.td }, h('input', {
                  style: Object.assign({}, S.input, { width: '100%' }),
                  value: row.name,
                  placeholder: t.sectionName,
                  onChange: function (event) { patchRow(index, { name: event.target.value }); },
                })),
                h('td', { style: Object.assign({}, S.td, S.num) }, h('input', {
                  style: Object.assign({}, S.input, { width: '110px', textAlign: 'right' }),
                  value: row.value,
                  inputMode: 'numeric',
                  onChange: function (event) { patchRow(index, { value: event.target.value }); },
                })),
                h('td', { style: S.td }, h('button', {
                  style: S.btn, onClick: function () { removeRow(index); },
                }, t.remove)));
            }))),
          h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
            h('button', { style: S.btn, onClick: function () { addRow('', ''); } }, t.addRow),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', { style: S.btn, onClick: reset, disabled: busy }, t.reset),
            h('button', { style: S.btnPrimary, onClick: save, disabled: busy }, busy ? t.saving : t.save)),
          h('div', { style: Object.assign({}, S.intro, { marginTop: '8px', marginBottom: 0 }) }, t.enable_tip));

        /* ── 各方 ── */
        var partyRows = [];
        // 这里必须用 let/const：var 是函数作用域，闭包会共享同一个 key，
        // 点任何一方的按钮都会作用在最后一方（渲染自测抓到的真 bug）。
        for (let p = 0; p < parties.length; p += 1) {
          const party = parties[p];
          const key = party.key;
          partyRows.push(h('tr', { key: 'party-' + key },
            h('td', { style: S.td },
              h('a', {
                href: '#',
                style: S.link,
                onClick: function (event) { event.preventDefault(); toggle(key); },
              }, open[key] ? t.collapse : t.expand),
              h('a', {
                href: '#',
                style: Object.assign({}, S.linkQuiet, { marginLeft: '8px' }),
                onClick: function (event) { event.preventDefault(); toggleFull(key); },
              }, openFull[key] ? t.hideFull : t.viewFull),
              h('span', { style: { marginLeft: '8px' } }, partyLabel(party, t)),
              party.live ? h('span', { style: S.pill }, t.live) : null,
              party.over ? h('span', { style: { color: C.error, marginLeft: '6px' } }, t.over) : null,
              party.trimmed ? h('span', { style: { color: C.warn, marginLeft: '6px' } }, t.trimmedShort) : null,
              party.dynamic && party.dynamic.items > 0
                ? h('div', { style: { fontSize: '11px', color: C.dim, marginTop: '2px' } },
                  t.dynamicLine + ' ' + fmt(party.dynamic.items) + ' ' + t.toolsShort
                  + ' · ' + fmt(party.dynamic.chars) + ' ' + t.colChars
                  + (party.dynamic.limited > 0 ? ' · ' + fmt(party.dynamic.limited) + '/' + t.colLimit : ''),
                  // 元素必须当子节点传，别拼进字符串（否则显示成 [object Object]）
                  party.dynamic.over > 0 ? h('span', { style: { color: C.error } }, ' · ' + party.dynamic.over + ' ' + t.over) : null)
                : null,
              party.probe ? h('div', { style: { fontSize: '11px', color: C.dim, marginTop: '2px' } },
                t.probeShort + ' ' + fmt(party.probe.totalChars) + ' ' + t.colChars
                + ' · ' + fmt(party.probe.toolCount) + ' ' + t.toolsShort
                + (party.assemblies > 0 && party.probe.totalChars !== party.totalChars
                  ? '（' + t.probeDiff + '）' : '')) : null),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(party.totalChars)),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(party.estTokens)),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(party.assemblies)),
            h('td', { style: Object.assign({}, S.td, S.num) }, party.peak ? fmt(party.peak.totalChars) : '—'),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(party.violations)),
            h('td', { style: S.td }, fmtTime(party.lastAt))));
          // 一行挂两种展开：全文阅读器优先（它是「具体提示词」的正门）。
          partyRows.push(h('tr', { key: 'party-detail-' + key },
            h('td', { style: Object.assign({}, S.td, { padding: 0, borderBottom: 'none' }), colSpan: 9 },
              openFull[key] ? fullReader(party) : (open[key] ? detail(party) : null))));
        }

        var partiesBox = h('div', { style: S.section },
          h('div', { style: S.heading }, t.parties),
          parties.length === 0
            ? h('div', { style: S.intro }, t.noData)
            : h('div', { style: S.card }, h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, t.colName),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.colChars),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.colTokens),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.assemblies),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.peak),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.violations),
                h('th', { style: S.th }, ''))),
              h('tbody', null, partyRows))));

        /* ── 来源汇总（默认只看动态回写：上限该管的就是它） ── */
        var aggregateAll = report && report.aggregate ? report.aggregate : [];
        // 旧宿主没有类别字段：那时不做筛选，否则表格会空得让人以为没数据。
        var hasClassInfo = aggregateAll.some(function (item) { return item.dynamic !== undefined; });
        var aggregate = (onlyDynamic && hasClassInfo
          ? aggregateAll.filter(function (item) { return item.dynamic === true; })
          : aggregateAll).slice(0, 30);
        var dynamicSuggested = aggregateAll.filter(function (item) { return item.dynamic === true && (item.limit === null || item.limit === undefined); });
        var aggRows = aggregate.map(function (item) {
          var cls = classLabel(item);
          var src = sourceLabel(item);
          return h('tr', { key: 'agg-' + item.kind + '-' + item.name },
            h('td', { style: S.td }, item.name),
            h('td', { style: S.td }, h('span', { style: { color: C.dim } },
              item.kind === 'section' ? t.kindSection : item.kind === 'context' ? t.kindContext : t.kindTool)),
            h('td', { style: S.td }, h('span', { style: { color: cls.color }, title: cls.title }, cls.text)),
            h('td', { style: S.td }, h('span', { title: src.suffix }, src.text)),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(item.chars)),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(item.estTokens)),
            h('td', { style: Object.assign({}, S.td, S.num) }, fmt(item.parties)),
            h('td', { style: S.td }, item.kind === 'tool' ? null : h('button', {
              style: S.btn,
              onClick: function () { addRow(item.name, Math.ceil(item.chars / 500) * 500); },
            }, t.setLimit)));
        });
        var aggBox = h('div', { style: S.section },
          h('div', { style: S.row },
            h('div', { style: Object.assign({}, S.heading, { flex: '1 1 auto' }) }, t.agg),
            h('label', { style: { fontSize: '12px', color: C.dim, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: onlyDynamic,
                onChange: function (event) { setOnlyDynamic(event.target.checked); },
              }), ' ' + t.onlyDynamic),
            dynamicSuggested.length > 0 ? h('button', {
              style: S.btn,
              onClick: function () {
                for (var index = 0; index < dynamicSuggested.length; index += 1) {
                  addRow(dynamicSuggested[index].name, Math.ceil(dynamicSuggested[index].chars / 500) * 500);
                }
              },
            }, t.suggestDynamic + '（' + dynamicSuggested.length + '）') : null),
          h('div', { style: S.card }, h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, t.colName),
              h('th', { style: S.th }, t.colKind),
              h('th', { style: S.th }, t.colClass),
              h('th', { style: S.th }, t.colSource),
              h('th', { style: Object.assign({}, S.th, S.num) }, t.colChars),
              h('th', { style: Object.assign({}, S.th, S.num) }, t.colTokens),
              h('th', { style: Object.assign({}, S.th, S.num) }, t.colParties),
              h('th', { style: S.th }, ''))),
            h('tbody', null, aggRows.length > 0 ? aggRows : h('tr', null,
              h('td', { style: S.td, colSpan: 8 }, h('span', { style: { color: C.dim } }, t.noData)))))));

        /* ── 最近越限 ── */
        var events = report && report.events ? report.events.slice(0, 10) : [];
        var eventBox = events.length === 0 ? null : h('div', { style: S.section },
          h('div', { style: S.heading }, t.events),
          h('div', { style: S.card }, h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, t.colName),
              h('th', { style: Object.assign({}, S.th, S.num) }, t.colChars),
              h('th', { style: Object.assign({}, S.th, S.num) }, t.colLimit),
              h('th', { style: S.th }, t.limitAction),
              h('th', { style: S.th }, ''))),
            h('tbody', null, events.map(function (event, index) {
              return h('tr', { key: 'ev-' + index },
                h('td', { style: S.td }, event.name),
                h('td', { style: Object.assign({}, S.td, S.num) }, fmt(event.chars)),
                h('td', { style: Object.assign({}, S.td, S.num) }, fmt(event.limit)),
                h('td', { style: S.td }, event.action === 'warn' ? t.actionWarn : event.action === 'drop' ? t.actionDrop : t.actionTruncate),
                h('td', { style: S.td }, h('span', { style: { color: C.dim } },
                  (event.sessionId ? shortId(event.sessionId) + ' · ' : '') + fmtTime(event.at))));
            }))))) ;

        /* ── 待批准的提额申请（模型申请，人批准） ── */
        var requests = report && report.requests ? report.requests : [];
        var pending = requests.filter(function (item) { return item.status === 'pending'; });
        var requestBox = h('div', { style: S.section },
          h('div', { style: S.heading }, t.requests + (pending.length > 0 ? '（' + pending.length + '）' : '')),
          pending.length === 0
            ? h('div', { style: S.intro }, t.noRequests)
            : h('div', { style: S.card }, h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, t.colName),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.currentCap),
                h('th', { style: Object.assign({}, S.th, S.num) }, t.wanted),
                h('th', { style: S.th }, '申请理由'),
                h('th', { style: S.th }, ''))),
              h('tbody', null, pending.map(function (request) {
                return h('tr', { key: request.id },
                  h('td', { style: S.td },
                    h('div', null, request.scope === 'total' ? '(总计)' : request.name),
                    h('div', { style: { fontSize: '10.5px', color: C.dim } },
                      request.scope + ' · ' + (request.sessionId ? shortId(request.sessionId) + ' · ' : '') + fmtTime(request.at))),
                  h('td', { style: Object.assign({}, S.td, S.num) }, request.current === null || request.current === undefined ? t.none : fmt(request.current)),
                  h('td', { style: Object.assign({}, S.td, S.num) }, fmt(request.wantChars)),
                  h('td', { style: S.td }, request.reason),
                  h('td', { style: S.td },
                    h('button', { style: S.btnPrimary, disabled: busy, onClick: function () { decide(request.id, true); } }, t.approve),
                    h('button', {
                      style: Object.assign({}, S.btn, { marginLeft: '6px' }),
                      disabled: busy,
                      onClick: function () { decide(request.id, false); },
                    }, t.reject)));
              })))));

        /* ── 模型看到的预算提示（透明：你到底告诉了模型什么） ── */
        var notice = report && report.notice ? report.notice : { active: false, text: '' };
        var noticeBox = h('div', { style: S.section },
          h('div', { style: S.heading }, t.noticeTitle),
          h('div', { style: S.card },
            notice.active && notice.text
              ? h('pre', { style: Object.assign({}, S.pre, { maxHeight: '220px' }) }, notice.text)
              : h('div', { style: Object.assign({}, S.intro, { marginBottom: 0 }) }, t.noticeInactive)));

        /* ── 说明 ── */
        var notes = report && report.notes ? report.notes : [];
        var notesBox = h('div', { style: S.section },
          h('div', { style: S.heading }, t.cols),
          h('div', { style: S.card }, notes.map(function (line, index) {
            return h('div', { key: 'note-' + index, style: Object.assign({}, S.intro, { marginBottom: '6px' }) }, '· ' + line);
          }).concat([
            h('div', { key: 'note-path', style: Object.assign({}, S.intro, { marginBottom: 0 }) },
              '· ' + (report ? report.limitsPath : '')),
          ])));

        // 中央面板：自己的标题条 + 独立滚动区，铺满主列。
        if (view === 'panel') {
          return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: C.card } },
            h('div', {
              style: {
                flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', gap: '12px',
                padding: '12px 16px', borderBottom: '1px solid ' + C.line, background: C.panel,
              },
            },
              h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: { fontSize: '14px', fontWeight: 600, color: C.text } }, t.title),
                h('div', { style: { fontSize: '11px', color: C.dim, marginTop: '2px' } }, t.subtitle),
                summary),
              h('div', { style: Object.assign({}, S.row, { flex: '0 0 auto' }) }, buttons)),
            h('div', { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 16px 28px' } },
              h('div', { style: { maxWidth: '1100px' } },
                error ? h('div', { style: S.err }, error) : null,
                limitsBox,
                partiesBox,
                aggBox,
                requestBox,
                eventBox,
                noticeBox,
                notesBox)));
        }

        return h('div', { style: { padding: '4px 0 16px' } },
          header,
          error ? h('div', { style: S.err }, error) : null,
          toolbar,
          summary,
          limitsBox,
          partiesBox,
          aggBox,
          requestBox,
          eventBox,
          noticeBox,
          notesBox);
      };
    }

    /**
     * 侧栏全局面板图标。owner 会给 {size, active}：尺寸照给，选中时用品牌色。
     * 三根高低不一的柱子 = 提示词各来源的体量对比，正是这个插件在说的事。
     */
    function createPanelIcon(react) {
      var h = react.createElement;
      return function PromptLimiterIcon(props) {
        var size = props && typeof props.size === 'number' ? props.size : 18;
        var active = props && props.active === true;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          stroke: active ? C.brand : 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false',
        },
          h('rect', { key: 'a', x: 2, y: 8.5, width: 3, height: 5.5, rx: 0.8 }),
          h('rect', { key: 'b', x: 6.5, y: 5, width: 3, height: 9, rx: 0.8 }),
          h('rect', { key: 'c', x: 11, y: 2.5, width: 3, height: 11.5, rx: 0.8 }));
      };
    }

    /** 挂卡片：slots 缺失就安静跳过（老宿主/headless 不该炸）。 */
    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return;
      var localeRef = { current: null };
      ctx.inject(['locale'], function (scope) {
        localeRef.current = scope.locale;
        if (typeof scope.effect === 'function') {
          scope.effect(function () {
            return function () { localeRef.current = null; };
          }, 'dsh-prompt-limiter: locale handle');
        }
      });
      ctx.inject(['slots'], function (scope) {
        var react;
        try {
          react = require('react');
        } catch (error) {
          console.error('[dsh-prompt-limiter] 拿不到 react，设置卡片跳过：' + error);
          return;
        }
        var Card = createCard(react, localeRef);
        var Icon = createPanelIcon(react);
        // 中央面板：同一份内容按面板样式渲染（props.panel = true）。
        var Panel = function PromptLimiterPanel(props) {
          return react.createElement(Card, Object.assign({}, props, { panel: true }));
        };

        // 「界面」的正门：左侧栏一个全局图标（id 与中央面板的 key 同名），
        // 点它就在主列打开提示词控制器面板。设置里那张卡片是同一个组件的另一副样子。
        scope.slots.inject('sidebar.panellist', function* () {
          yield scope.slots.register({
            name: 'sidebar.panellist',
            id: 'prompt-limiter',
            order: 20,
            label: function () { return makeText(localeRef).title; },
          }, Icon);
        });
        scope.slots.inject('main', function* () {
          yield scope.slots.register({ name: 'main', key: 'prompt-limiter' }, Panel);
        });

        // 新版宿主：Plugins 页上按包名分派的卡片；老版宿主：Settings 里的插件项。
        scope.slots.inject('plugins.bundle.config', function* () {
          yield scope.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, Card);
        });
        scope.slots.inject('settings.plugin.item', function* () {
          yield scope.slots.register({ name: 'settings.plugin.item', id: 'prompt-limiter', key: 'prompt-limiter', order: 41 }, Card);
        });
      });
    }

    exports.apply = apply;
    // 测试用：不构成插件契约。
    exports.__card = { rowsFromCaps: rowsFromCaps, capsFromRows: capsFromRows, PACKAGE_NAME: PACKAGE_NAME };
    // 两个服务都各自走作用域 inject，不是硬依赖。
    exports.inject = [];
    return module.exports;
  },
});
