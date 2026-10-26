/**
 * Client half of the RimWorld log bundle.
 *
 * Mounts a compact "RimWorld 日志" bar under the composer. It shows the detected log
 * sources with their cost/benefit note, lets the user pick which sources the next
 * analysis should cover, and explains the exact one-keystroke entry point (`/rimlog`).
 *
 * The browser half deliberately performs no host calls: every operation is owned by the
 * Host half, and `references/user-actions.md` in the official plugin skill states that an
 * operation must be implemented once, on the Host. This bar routes the user to it.
 *
 * It must not import any Harness Client package (they change without notice and a throwing
 * import blanks the whole slot entry), so it uses only React from the platform table.
 *
 * @module rimworld-log/client
 */

window.__ModuleLoader__.load({
  id: '@local/rimworld-log',
  factory(require) {
    const React = require('react');

    const SOURCES = [
      {
        id: 'realtime',
        label: 'RimCrow 实时日志',
        file: 'RimCrow_Realtime.log',
        cost: 'Token 低',
        strength: '最强',
        note: '结构化 JSON：带 level、完整堆栈、count 去重、关联 mod 与文件。首选。',
      },
      {
        id: 'realtimePrev',
        label: 'RimCrow 上一轮日志',
        file: 'RimCrow_Realtime-prev.log',
        cost: 'Token 低',
        strength: '回溯',
        note: '与实时日志同格式（结构化、带完整堆栈），内容是上一次启动；用于对比本次新增了什么。',
      },
      {
        id: 'player',
        label: 'RimWorld 原生日志',
        file: 'Player.log',
        cost: 'Token 高',
        strength: '兼容',
        note: '纯文本、无法去重，同样信息花费约为实时日志的 2–5 倍；未启用辅助模组时是唯一来源，也可交叉验证。',
      },
      {
        id: 'playerPrev',
        label: '上次运行日志',
        file: 'Player-prev.log',
        cost: 'Token 高',
        strength: '回溯',
        note: '与 Player.log 同格式，用于对比本次新增了什么。',
      },
    ];

    const COMMAND_HINT = '/rimlog';
    /** Draft selection shared by every mount of this bar; analysis itself stays on the Host. */
    const draft = { sources: ['realtime'], open: false };

    /** One selectable source row with its cost/benefit note. */
    function SourceRow(props) {
      const { source, selected, onToggle } = props;
      const [hover, setHover] = React.useState(false);
      return React.createElement(
        'label',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '6px 8px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
          },
        },
        React.createElement('input', {
          type: 'checkbox',
          checked: selected,
          onChange: onToggle,
          style: { marginTop: '3px', cursor: 'pointer' },
        }),
        React.createElement(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          React.createElement(
            'span',
            { style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontWeight: 600 } }, source.label),
            React.createElement(
              'span',
              { style: { fontSize: '11px', opacity: 0.65 } },
              `${source.file} · ${source.cost} · 信息强度 ${source.strength}`,
            ),
          ),
          React.createElement(
            'span',
            { style: { fontSize: '11px', lineHeight: 1.5, opacity: hover ? 0.95 : 0.7 } },
            source.note,
          ),
        ),
      );
    }

    /** The bar under the composer. */
    function RimWorldLogBar() {
      const [, forceRender] = React.useState(0);
      const rerender = () => forceRender((n) => n + 1);
      const toggleOpen = () => {
        draft.open = !draft.open;
        rerender();
      };
      const toggleSource = (id) => {
        const index = draft.sources.indexOf(id);
        if (index === -1) draft.sources.push(id);
        else if (draft.sources.length > 1) draft.sources.splice(index, 1);
        rerender();
      };

      const commandLine = draft.sources.length > 0 && !(draft.sources.length === 1 && draft.sources[0] === 'realtime')
        ? `${COMMAND_HINT} ${draft.sources.join(' ')}`
        : COMMAND_HINT;

      return React.createElement(
        'div',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-1, transparent)',
            margin: '4px 0',
            fontSize: '12px',
            overflow: 'hidden',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px' } },
          React.createElement('span', { style: { fontWeight: 600 } }, 'RimWorld 日志'),
          React.createElement(
            'span',
            { style: { opacity: 0.6, fontSize: '11px' } },
            `一键分析：输入 ${commandLine} 回车`,
          ),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: toggleOpen,
              title: draft.open ? '收起日志来源选项' : '选择要分析的日志来源',
              style: {
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
                borderRadius: '5px',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '11px',
                padding: '2px 8px',
              },
            },
            draft.open ? '收起来源' : '选择来源',
          ),
        ),
        draft.open
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 10px 8px' } },
              SOURCES.map((source) => React.createElement(SourceRow, {
                key: source.id,
                source,
                selected: draft.sources.includes(source.id),
                onToggle: () => toggleSource(source.id),
              })),
              React.createElement(
                'div',
                { style: { fontSize: '11px', opacity: 0.65, lineHeight: 1.6, paddingTop: '2px' } },
                `将执行：${commandLine}`,
              ),
              React.createElement(
                'div',
                { style: { fontSize: '11px', opacity: 0.65, lineHeight: 1.6 } },
                '其它用法：/rimlog --full（忽略增量、整份重扫）、/rimlog --since 2026-10-08（按时间过滤）、',
                '/rimlog player 帮我确认是不是这个 mod 的问题（追加自己的要求）。',
              ),
              React.createElement(
                'div',
                { style: { fontSize: '11px', opacity: 0.65, lineHeight: 1.6 } },
                '分析在本地预聚类后交给当前会话；对话与结论由 DSH 保存，随时可接着问。',
              ),
            )
          : null,
      );
    }

    // ---- 设置 → 内置插件 → RimWorld 日志 ------------------------------------
    //
    // 表单直接读写 Host 的行配置（configForms），不经过任何 agent 工具调用。
    // 语义与 lib/config.js 对齐：空字符串 = 未设置（下落到 settings.json / 默认）；
    // 每行失焦即保存，保存结果就地提示。
    const SETTINGS_FIELDS = [
      { key: 'patchDir', label: '补丁输出目录', type: 'text', hint: '留空 = 默认 ~/.dsh/rimworld-log/patches' },
      { key: 'workspaceDir', label: '工作区目录', type: 'text', hint: '留空 = 自动探测' },
      { key: 'snapshotDir', label: '快照目录', type: 'text', hint: '留空 = 工作区旁的 snapshots' },
      { key: 'clusterLimit', label: '分析返回的问题簇上限', type: 'number', hint: '默认 14，上限 40' },
      {
        key: 'defaultSource', label: '缺省日志来源', type: 'select', hint: 'analyze 不指定来源时用它',
        options: [
          { value: 'realtime', label: 'RimCrow 实时日志' },
          { value: 'player', label: 'RimWorld 原生日志' },
          { value: 'playerPrev', label: '上次运行日志' },
          { value: 'realtimePrev', label: 'RimCrow 上一轮实时日志' },
        ],
      },
      { key: 'ignoredSignatures', label: '忽略的错误签名（每行一条，子串匹配）', type: 'lines', hint: '目前作用于紧凑视图；如 PA\'s God Hands 的故意红字' },
      { key: 'language', label: '输出语言（预留）', type: 'text', hint: '当前全部中文，此键暂未生效' },
    ];

    function SettingsPanel(props) {
      // 注意：useForm 返回的是快照（{status, writable, value, revision}），**不是控制器**；
      // 写入必须走 face 里显式提供的 setField（闭包持有真正的 ConfigFormController）。
      // 直接在快照上调用 .set 会 TypeError —— 实测踩过，表现为「保存失败」。
      const snapshot = props.useForm((v) => v);
      const ready = snapshot.status === 'ready';
      const config = ready ? (snapshot.value ?? {}) : {};
      const writable = snapshot.writable !== false;
      const [drafts, setDrafts] = React.useState({});
      const [notice, setNotice] = React.useState(null);

      const draftOf = (field) => {
        if (drafts[field.key] !== undefined) return drafts[field.key];
        const v = config[field.key];
        if (field.type === 'lines') return Array.isArray(v) ? v.join('\n') : '';
        return v === undefined || v === null ? '' : String(v);
      };

      const setDraft = (key, value) => setDrafts((prev) => ({ ...prev, [key]: value }));

      const commit = async (field) => {
        const raw = drafts[field.key];
        if (raw === undefined) return;
        let value = raw;
        if (field.type === 'number') {
          if (String(raw).trim() === '') value = null;
          else {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) { setNotice({ key: field.key, ok: false, text: '需要非负数字' }); return; }
            value = n;
          }
        } else if (field.type === 'lines') {
          value = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
        }
        try {
          const accepted = await props.setField(field.key, value);
          if (accepted === true) {
            // 保存成功：**保留输入值**（不要回落到快照——快照来自运行中插件的旧 fiber.config，
            // 会立刻把输入回滚成旧数字，看起来像"没保存上"）。
            // harness 的 config 写入对 linked bundle 的 host 半区不触发热重载，所以值要等
            // 下次激活（重启 DSH）才真正生效——界面必须说清楚，别假装是即时的。
            setNotice({ key: field.key, ok: true, text: '已保存，重启 DSH 后生效' });
            setDrafts((prev) => ({ ...prev, [field.key]: String(value) }));
          } else {
            setNotice({ key: field.key, ok: false, text: '保存被拒绝' });
            setDrafts((prev) => { const next = { ...prev }; delete next[field.key]; return next; });
          }
        } catch (error) {
          // 把真实原因带出来：RemoteError 会把 host 侧拒绝的原文放在 message 里
          // （settings/conflict / settings/rejected），只显示"保存失败"等于把诊断信息扔掉。
          const detail = String(error?.message ?? error?.code ?? error);
          console.error('[rimworld-log] 设置保存失败:', error);
          setNotice({ key: field.key, ok: false, text: `保存失败：${detail}` });
          setDrafts((prev) => { const next = { ...prev }; delete next[field.key]; return next; });
        }
      };

      const rowStyle = { display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' };
      const inputStyle = {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
        borderRadius: '6px', background: 'transparent', color: 'inherit',
        padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
      };

      if (!ready) {
        return React.createElement('div', { style: { padding: '12px 0', fontSize: '13px', opacity: 0.65 } },
          '配置服务未就绪（插件可能正在重载），稍后重开设置面板。');
      }

      return React.createElement('div', { style: { maxWidth: '640px', display: 'flex', flexDirection: 'column' } },
        React.createElement('p', { style: { margin: '0 0 4px', fontSize: '12px', opacity: 0.7, lineHeight: 1.6 } },
          '这里写的是插件行配置：保存即写入磁盘，重启 DSH 后生效（harness 不会对已加载的 host 半区热重载配置）。',
          '环境变量始终优先于这里；settings.json 是旧的文件层，仍被读取但界面优先。'),
        SETTINGS_FIELDS.map((field) => React.createElement(
          'div', { key: field.key, style: rowStyle },
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontWeight: 600, fontSize: '13px' } }, field.label),
            notice && notice.key === field.key
              ? React.createElement('span', { style: { fontSize: '11px', color: notice.ok ? 'var(--dsw-alias-state-success, #2e9e5b)' : 'var(--dsw-alias-state-danger, #d05252)' } }, notice.text)
              : null,
          ),
          field.type === 'select'
            ? React.createElement('select', {
                value: draftOf(field) || config[field.key] || '',
                disabled: !writable,
                onChange: (e) => { setDraft(field.key, e.target.value); },
                onBlur: () => commit(field),
                style: { ...inputStyle, cursor: 'pointer' },
              },
              field.options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)))
            : field.type === 'lines'
              ? React.createElement('textarea', {
                  value: draftOf(field),
                  disabled: !writable,
                  rows: 3,
                  onChange: (e) => setDraft(field.key, e.target.value),
                  onBlur: () => commit(field),
                  style: { ...inputStyle, resize: 'vertical' },
                })
              : React.createElement('input', {
                  type: field.type === 'number' ? 'number' : 'text',
                  value: draftOf(field),
                  disabled: !writable,
                  min: field.type === 'number' ? 0 : undefined,
                  placeholder: field.hint,
                  onChange: (e) => setDraft(field.key, e.target.value),
                  onBlur: () => commit(field),
                  onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); },
                  style: inputStyle,
                }),
          React.createElement('span', { style: { fontSize: '11px', opacity: 0.6, lineHeight: 1.5 } }, field.hint),
        )),
        !writable
          ? React.createElement('p', { style: { margin: '8px 0 0', fontSize: '12px', opacity: 0.7 } },
              '当前配置不可写（可能被更高层的补丁覆盖）。')
          : null,
      );
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'rimworld-log-bar',
          order: 60,
        }, RimWorldLogBar));

        // 设置 → 内置插件：一张 RimWorld 日志标签页，读写 Host 的行配置。
        // 设置左栏的独立一页（settings.section 列表槽），和「通用 / 模型 / Agent 预设 /
        // 内置插件」平级，order 21 = 紧跟在 Agent 预设（order 20）正下方。
        // configForms.get 返回 ConfigFormController：{ getSnapshot, subscribe, set, mutate, unset }。
        // - 读：把控制器当 store 交给 hooks.form → 组件拿到快照 { status, writable, value }。
        // - 写：**必须**经 face 显式提供 setField（快照上没有 set；直接调会 TypeError）。
        // set 落到 profile patch，重启 DSH 后生效（host 半区不会热重载配置）。
        // whileServed 保证配置服务不在时（如插件被禁用）这一页也不出现。
        // 整段用 try 包住：configForms 万一不可用，只少这一页设置，
        // 上面的日志来源条必须照常工作（客户端的既有红线：一个抛错会带死整条槽位）。
        try {
          const form = ctx.configForms.get('rimworld-log');
          const face = () => ({
            hooks: { form },
            setField: (key, value) => form.set(key, value),
          });
          ctx.effect(() => ctx.configForms.whileServed(['rimworld-log'], () =>
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: 'rimworld-log',
              order: 21,
              label: 'RimWorld 日志',
              inject: face,
            }, SettingsPanel))));
        } catch (error) {
          console.error('[rimworld-log] 设置页注册失败（日志来源条不受影响）:', error);
        }
      },
    };
  },
});
