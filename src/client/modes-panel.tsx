/**
 * 「模式管理」面板：列表 + 新增弹层。
 *
 * 弹层分四步：来源模式、命名、工具、SKILL。工具与 SKILL 清单在选定来源后
 * 由宿主读取该预设真实可见的能力，前端只负责展示与勾选。
 */
import * as React from 'react';
import { Arco, MenuSelect, Scrollbar, type ConfigPanelProps, type ConfigValues } from '@dsh-plugin/dsh-loader/client';
import { BUILTIN_SOURCE_KEYS, GROUP_KEYS, MODULE_KEYS, SKILL_SOURCE_KEYS, type ModeBuilderKey } from './locales.js';

/** 一行已保存模式，字段与宿主 `modes.list` 的输出一致。 */
interface ModeRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePreset: string;
  readonly order: number;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly broken?: string;
}

/** 一行可选来源模式。 */
interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly builtin: boolean;
}

/** 来源模式里一个可勾选的行。 */
interface OptionRow {
  readonly key: string;
  readonly module: string;
  readonly group: string;
  readonly tools: readonly string[];
  readonly enabled: boolean;
}

/** 来源模式的读取结果。 */
interface InspectResult {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly options: readonly OptionRow[];
  readonly required: readonly { readonly key: string; readonly module: string; readonly tools: readonly string[] }[];
  readonly skillControlled: boolean;
  readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly kind: 'directory' | 'file' }[];
  readonly virtualSkills: readonly string[];
}

/** 带占位符替换的翻译函数。 */
export type Translator = (key: ModeBuilderKey, vars?: Record<string, string | number>) => string;

/** 面板组件的翻译上下文。 */
export const TranslatorContext = React.createContext<Translator>(key => key);

/** 弹层与列表的局部样式，全部使用宿主 Arco 主题变量。 */
const CSS = `
.modebuilder-table{max-height:360px}
.modebuilder-toolbar{display:flex;justify-content:flex-end;gap:8px;margin:8px 0}
.modebuilder-error{margin:8px 0}
.modebuilder-name{font-weight:600}
.modebuilder-desc{color:var(--color-text-3);font-size:12px;overflow-wrap:anywhere}
.modebuilder-code{font-family:var(--font-mono,monospace);font-size:12px;color:var(--color-text-2)}
.modebuilder-modal.arco-modal{top:120px;margin-bottom:120px;max-height:calc(100dvh - 240px);display:flex;flex-direction:column;width:min(880px,calc(100vw - 32px))}
.modebuilder-modal>div:has(>.arco-modal-header){display:flex;flex-direction:column;min-height:0;max-height:inherit}
.modebuilder-modal .arco-modal-header,.modebuilder-modal .arco-modal-footer{flex-shrink:0}
.modebuilder-modal .arco-modal-content{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:16px 20px}
.modebuilder-modal-wrap{overflow:hidden}
.modebuilder-scroll{flex:0 1 auto;min-height:0;width:100%}
.modebuilder-body{min-width:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:14px}
.modebuilder-field{display:flex;flex-direction:column;gap:6px}
.modebuilder-field>span{font-weight:600}
.modebuilder-help{color:var(--color-text-3);font-size:12px;line-height:1.5}
.modebuilder-section{border:1px solid var(--color-border-2);border-radius:8px;padding:12px}
.modebuilder-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.modebuilder-section-head>span{font-weight:600}
.modebuilder-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px 16px}
.modebuilder-group{margin-top:8px}
.modebuilder-group-title{color:var(--color-text-3);font-size:12px;margin:8px 0 4px}
.modebuilder-tools{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.modebuilder-footer{display:flex;justify-content:space-between;align-items:center;gap:12px}
.modebuilder-footer-right{display:flex;gap:8px}
.modebuilder-required{display:flex;flex-wrap:wrap;gap:6px}
`;

/** 面板主体。 */
export function ModesPanel({ view, client }: ConfigPanelProps): React.ReactElement {
  const t = React.useContext(TranslatorContext);
  const [modes, setModes] = React.useState<ModeRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<ModeRow | undefined>();

  const active = React.useRef(true);
  const calls = React.useRef(new Set<AbortController>());
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const call of calls.current) call.abort();
      calls.current.clear();
    };
  }, []);

  const invoke = React.useCallback(async (operation: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    const controller = new AbortController();
    calls.current.add(controller);
    try {
      const result = await client.invoke(view.template.id, operation, { input: input as ConfigValues }, controller.signal);
      return result.value;
    } catch (cause) {
      if (active.current && !controller.signal.aborted) setError(errorText(cause));
      return undefined;
    } finally {
      calls.current.delete(controller);
    }
  }, [client, view.template.id]);

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    const value = await invoke('modes.list');
    if (!active.current) return;
    if (value !== undefined) setModes(modesOf(value));
    setLoading(false);
  }, [invoke]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const remove = async (row: ModeRow): Promise<void> => {
    setError('');
    const value = await invoke('modes.delete', { id: row.id });
    if (!active.current) return;
    if (value !== undefined) {
      setModes(modesOf(value));
      setNotice(t('deleteDone', { name: row.name }));
      setPendingDelete(undefined);
    }
  };

  const columns = [
    {
      title: t('columnName'),
      dataIndex: 'name',
      render: (_value: unknown, row: ModeRow) => (
        <div>
          <div className="modebuilder-name">{row.name}</div>
          {row.description ? <div className="modebuilder-desc">{row.description}</div> : null}
        </div>
      ),
    },
    {
      title: t('columnId'),
      dataIndex: 'id',
      width: 150,
      render: (_value: unknown, row: ModeRow) => <span className="modebuilder-code">{row.id}</span>,
    },
    {
      title: t('columnSource'),
      dataIndex: 'sourcePreset',
      width: 120,
      render: (_value: unknown, row: ModeRow) => <span className="modebuilder-code">{row.sourcePreset}</span>,
    },
    {
      title: t('columnTools'),
      dataIndex: 'tools',
      width: 90,
      render: (_value: unknown, row: ModeRow) => t('toolsCount', { count: row.tools.length }),
    },
    {
      title: t('columnSkills'),
      dataIndex: 'skills',
      width: 110,
      render: (_value: unknown, row: ModeRow) => row.skills.length === 0
        ? <span className="modebuilder-desc">—</span>
        : <span title={row.skills.join('、')}>{t('skillsCount', { count: row.skills.length })}</span>,
    },
    {
      title: t('columnActions'),
      width: 100,
      render: (_value: unknown, row: ModeRow) => (
        <Arco.Button size="mini" status="danger" onClick={() => { setPendingDelete(row); }}>{t('delete')}</Arco.Button>
      ),
    },
  ];

  return (
    <>
      <style>{CSS}</style>
      <div className="modebuilder-toolbar">
        <Arco.Button size="small" loading={loading} onClick={() => { void refresh(); }}>{t('refresh')}</Arco.Button>
        <Arco.Button size="small" type="primary" onClick={() => { setCreating(true); }}>{t('add')}</Arco.Button>
      </div>
      {error ? <Arco.Alert className="modebuilder-error" type="error" content={error} /> : null}
      {notice ? <Arco.Alert className="modebuilder-error" type="success" content={notice} /> : null}
      <Scrollbar className="modebuilder-table" aria-label={t('panelTitle')}>
        <Arco.Table
          rowKey="id"
          size="small"
          pagination={false}
          data={modes}
          columns={columns as never}
          noDataElement={<div className="modebuilder-help">{loading ? t('loading') : t('empty')}</div>}
        />
      </Scrollbar>
      {creating ? (
        <CreateDialog
          client={client}
          configId={view.template.id}
          onClose={() => { setCreating(false); }}
          onCreated={(next, created) => {
            setModes(next);
            setCreating(false);
            setNotice(t('createDone', { name: created }));
          }}
        />
      ) : null}
      {pendingDelete ? (
        <Arco.Modal
          visible
          title={t('deleteTitle')}
          className="modebuilder-modal"
          wrapClassName="modebuilder-modal-wrap"
          alignCenter={false}
          maskClosable={false}
          onCancel={() => { setPendingDelete(undefined); }}
          footer={<div className="modebuilder-footer">
            <span className="modebuilder-desc">{pendingDelete.id}</span>
            <div className="modebuilder-footer-right">
              <Arco.Button onClick={() => { setPendingDelete(undefined); }}>{t('cancel')}</Arco.Button>
              <Arco.Button type="primary" status="danger" onClick={() => { void remove(pendingDelete); }}>{t('delete')}</Arco.Button>
            </div>
          </div>}
        >
          <style>{CSS}</style>
          <p>{t('deleteConfirm', { name: pendingDelete.name })}</p>
          {pendingDelete.broken ? <Arco.Alert type="warning" content={t('broken', { reason: pendingDelete.broken })} /> : null}
        </Arco.Modal>
      ) : null}
    </>
  );
}

/** 新增模式的弹层。 */
function CreateDialog({ client, configId, onClose, onCreated }: {
  client: ConfigPanelProps['client'];
  configId: string;
  onClose(): void;
  onCreated(next: ModeRow[], name: string): void;
}): React.ReactElement {
  const t = React.useContext(TranslatorContext);
  const [sources, setSources] = React.useState<SourceRow[]>([]);
  const [source, setSource] = React.useState('');
  const [inspect, setInspect] = React.useState<InspectResult | undefined>();
  const [inspectError, setInspectError] = React.useState('');
  const [inspectLoading, setInspectLoading] = React.useState(false);
  const [id, setId] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [tools, setTools] = React.useState<ReadonlySet<string>>(new Set());
  const [skills, setSkills] = React.useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const active = React.useRef(true);
  const calls = React.useRef(new Set<AbortController>());
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const call of calls.current) call.abort();
      calls.current.clear();
    };
  }, []);

  const call = React.useCallback(async (operation: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    const controller = new AbortController();
    calls.current.add(controller);
    try {
      const result = await client.invoke(configId, operation, { input: input as ConfigValues }, controller.signal);
      return result.value;
    } finally {
      calls.current.delete(controller);
    }
  }, [client, configId]);

  React.useEffect(() => {
    void (async () => {
      try {
        const value = await call('modes.sources');
        if (!active.current || value === undefined) return;
        setSources(sourcesOf(value));
      } catch (cause) {
        if (active.current) setError(errorText(cause));
      }
    })();
  }, [call]);

  const pickSource = (next: string): void => {
    setSource(next);
    setInspect(undefined);
    setInspectError('');
    setTools(new Set());
    setSkills(new Set());
    if (next.length === 0) return;
    setInspectLoading(true);
    void (async () => {
      try {
        const value = await call('modes.inspect', { source: next });
        if (!active.current || value === undefined) return;
        const result = inspectOf(value);
        setInspect(result);
        setTools(new Set(result.options.filter(option => option.enabled).map(option => option.key)));
        setSkills(new Set(result.skills.map(skill => skill.name)));
      } catch (cause) {
        if (active.current) setInspectError(errorText(cause));
      } finally {
        if (active.current) setInspectLoading(false);
      }
    })();
  };

  const submit = async (): Promise<void> => {
    const idProblem = idProblemOf(id, t);
    if (idProblem !== undefined) { setError(idProblem); return; }
    const nameProblem = nameProblemOf(displayName, t);
    if (nameProblem !== undefined) { setError(nameProblem); return; }
    if (source.length === 0) { setError(t('sourceRequired')); return; }
    setError('');
    setSaving(true);
    try {
      const value = await call('modes.create', {
        source,
        id: id.trim(),
        name: displayName.trim(),
        description: description.trim(),
        tools: [...tools],
        skills: [...skills],
      });
      if (!active.current || value === undefined) return;
      onCreated(modesOf(value), displayName.trim());
    } catch (cause) {
      if (active.current) setError(`${t('createFailed')}${errorText(cause)}`);
    } finally {
      if (active.current) setSaving(false);
    }
  };

  const toolGroups = React.useMemo(() => groupOptions(inspect?.options ?? [], t), [inspect, t]);

  return (
    <Arco.Modal
      visible
      title={t('createTitle')}
      className="modebuilder-modal"
      wrapClassName="modebuilder-modal-wrap"
      alignCenter={false}
      maskClosable={false}
      unmountOnExit
      onCancel={onClose}
      footer={<div className="modebuilder-footer">
        <span className="modebuilder-help">
          {t('selectedSummary', { tools: tools.size, skills: skills.size })}
        </span>
        <div className="modebuilder-footer-right">
          <Arco.Button disabled={saving} onClick={onClose}>{t('cancel')}</Arco.Button>
          <Arco.Button type="primary" loading={saving} onClick={() => { void submit(); }}>{t('confirm')}</Arco.Button>
        </div>
      </div>}
    >
      <style>{CSS}</style>
      <Scrollbar className="modebuilder-scroll" aria-label={t('createTitle')}>
        <div className="modebuilder-body">
          {error ? <Arco.Alert type="error" content={error} /> : null}

          <section className="modebuilder-section">
            <div className="modebuilder-section-head"><span>{t('createStepSource')}</span></div>
            <label className="modebuilder-field">
              <span>{t('sourceLabel')}</span>
              <MenuSelect
                label={t('sourceLabel')}
                value={source}
                placeholder={t('sourcePlaceholder')}
                onChange={(value: string) => { pickSource(String(value ?? '')); }}
                options={sources.map(row => ({
                  value: row.id,
                  label: sourceName(row, t),
                }))}
              />
            </label>
            {source.length > 0 ? <p className="modebuilder-help">{sourceDescription(source, sources, t)}</p> : null}
            <p className="modebuilder-help">{t('sourceHint')}</p>
            {inspectLoading ? <p className="modebuilder-help">{t('sourcePending')}</p> : null}
            {inspectError ? <Arco.Alert type="error" content={`${t('inspectFailed')}${inspectError}`} /> : null}
          </section>

          <section className="modebuilder-section">
            <div className="modebuilder-section-head"><span>{t('createStepIdentity')}</span></div>
            <label className="modebuilder-field">
              <span>{t('idLabel')}</span>
              <Arco.Input value={id} placeholder={t('idPlaceholder')} maxLength={32} onChange={(value: string) => { setId(value); }} />
            </label>
            <p className="modebuilder-help">{t('idHint')}</p>
            <label className="modebuilder-field">
              <span>{t('nameLabel')}</span>
              <Arco.Input value={displayName} placeholder={t('namePlaceholder')} maxLength={60} onChange={(value: string) => { setDisplayName(value); }} />
            </label>
            <p className="modebuilder-help">{t('nameHint')}</p>
            <label className="modebuilder-field">
              <span>{t('descriptionLabel')}</span>
              <Arco.Input.TextArea
                value={description}
                placeholder={t('descriptionPlaceholder')}
                autoSize={{ minRows: 2, maxRows: 4 }}
                maxLength={200}
                onChange={(value: string) => { setDescription(value); }}
              />
            </label>
          </section>

          <section className="modebuilder-section">
            <div className="modebuilder-section-head">
              <span>{t('createStepTools')}</span>
              <Arco.Space>
                <Arco.Button size="mini" disabled={inspect === undefined} onClick={() => { setTools(new Set((inspect?.options ?? []).map(option => option.key))); }}>{t('selectAll')}</Arco.Button>
                <Arco.Button size="mini" disabled={inspect === undefined} onClick={() => { setTools(new Set()); }}>{t('clearAll')}</Arco.Button>
              </Arco.Space>
            </div>
            <p className="modebuilder-help">{t('toolsHint')}</p>
            {toolGroups.map(group => (
              <div className="modebuilder-group" key={group.id || 'ungrouped'}>
                {toolGroups.length > 1 ? <div className="modebuilder-group-title">{group.title}</div> : null}
                <div className="modebuilder-grid">
                  {group.options.map(option => (
                    <div key={option.key}>
                      <Arco.Checkbox
                        checked={tools.has(option.key)}
                        onChange={(checked: boolean) => {
                          setTools(current => {
                            const next = new Set(current);
                            if (checked) next.add(option.key); else next.delete(option.key);
                            return next;
                          });
                        }}
                      >
                        {moduleLabel(option.module, t)}
                      </Arco.Checkbox>
                      {option.tools.length > 0 ? (
                        <div className="modebuilder-tools">
                          {option.tools.map(tool => <span className="modebuilder-code" key={tool}>{tool}</span>)}
                        </div>
                      ) : (
                        <div className="modebuilder-tools"><span className="modebuilder-code">{shortModule(option.module)}</span></div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {inspect !== undefined && inspect.required.length > 0 ? (
              <div className="modebuilder-group">
                <div className="modebuilder-group-title">{t('toolsRequired')}</div>
                <div className="modebuilder-required">
                  {inspect.required.map(row => <Arco.Tag key={row.key} size="small">{moduleLabel(row.module, t)}</Arco.Tag>)}
                </div>
              </div>
            ) : null}
          </section>

          <section className="modebuilder-section">
            <div className="modebuilder-section-head">
              <span>{t('createStepSkills')}</span>
              <Arco.Space>
                <Arco.Button size="mini" disabled={inspect === undefined} onClick={() => { setSkills(new Set((inspect?.skills ?? []).map(skill => skill.name))); }}>{t('selectAll')}</Arco.Button>
                <Arco.Button size="mini" disabled={inspect === undefined} onClick={() => { setSkills(new Set()); }}>{t('clearAll')}</Arco.Button>
              </Arco.Space>
            </div>
            <p className="modebuilder-help">{t('skillsHint')}</p>
            {inspect !== undefined && inspect.skills.length === 0 ? <p className="modebuilder-help">{t('skillsEmpty')}</p> : null}
            <div className="modebuilder-grid">
              {(inspect?.skills ?? []).map(skill => (
                <div key={skill.name}>
                  <Arco.Checkbox
                    checked={skills.has(skill.name)}
                    onChange={(checked: boolean) => {
                      setSkills(current => {
                        const next = new Set(current);
                        if (checked) next.add(skill.name); else next.delete(skill.name);
                        return next;
                      });
                    }}
                  >
                    <span className="modebuilder-code">{skill.name}</span>
                  </Arco.Checkbox>
                  <div className="modebuilder-desc">{skill.description}</div>
                  <div className="modebuilder-desc">{skillSourceLabel(skill.source, t)}</div>
                </div>
              ))}
            </div>
            {inspect !== undefined && inspect.virtualSkills.length > 0 ? (
              <p className="modebuilder-help">{t('skillsVirtual', { names: inspect.virtualSkills.join('、') })}</p>
            ) : null}
          </section>
        </div>
      </Scrollbar>
    </Arco.Modal>
  );
}

/** 把工具行按容器分组，用于界面分节。 */
function groupOptions(options: readonly OptionRow[], t: Translator): { id: string; title: string; options: OptionRow[] }[] {
  const groups = new Map<string, OptionRow[]>();
  for (const option of options) {
    const list = groups.get(option.group) ?? [];
    list.push(option);
    groups.set(option.group, list);
  }
  return [...groups.entries()].map(([id, list]) => ({
    id,
    title: id.length === 0
      ? t('groupUngrouped')
      : GROUP_KEYS[id] === undefined ? id : t(GROUP_KEYS[id]),
    options: list,
  }));
}

function moduleLabel(module: string, t: Translator): string {  const key = MODULE_KEYS[module];
  return key === undefined ? shortModule(module) : t(key);
}

function shortModule(module: string): string {
  return module.replace(/^@deepseek-ai\//, '').replace(/^dsh-/, '');
}

function skillSourceLabel(source: string, t: Translator): string {
  const key = SKILL_SOURCE_KEYS[source];
  return key === undefined ? t('sourceOther') : t(key);
}

/** 来源模式的展示名：内置四模式走字典，其余用预设自带的 `name`。 */
function sourceName(row: SourceRow, t: Translator): string {
  const builtin = BUILTIN_SOURCE_KEYS[row.id];
  return builtin === undefined ? row.name : t(builtin.name);
}

/** 来源模式的一句话说明。 */
function sourceDescription(id: string, rows: readonly SourceRow[], t: Translator): string {
  const builtin = BUILTIN_SOURCE_KEYS[id];
  if (builtin !== undefined) return t(builtin.description);
  return rows.find(row => row.id === id)?.description ?? '';
}

function idProblemOf(id: string, t: Translator): string | undefined {
  const value = id.trim();
  if (value.length === 0) return t('idRequired');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(value)) return t('idInvalid');
  return undefined;
}

function nameProblemOf(name: string, t: Translator): string | undefined {
  const value = name.trim();
  if (value.length === 0) return t('nameRequired');
  if (value.length > 60) return t('nameTooLong');
  return undefined;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function modesOf(value: unknown): ModeRow[] {
  const rows = (value as { modes?: unknown } | undefined)?.modes;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (typeof row !== 'object' || row === null) return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return [];
    return [{
      id: item.id,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      sourcePreset: typeof item.sourcePreset === 'string' ? item.sourcePreset : '',
      order: typeof item.order === 'number' ? item.order : 0,
      tools: Array.isArray(item.tools) ? item.tools.filter((entry): entry is string => typeof entry === 'string') : [],
      skills: Array.isArray(item.skills) ? item.skills.filter((entry): entry is string => typeof entry === 'string') : [],
      ...(typeof item.broken === 'string' ? { broken: item.broken } : {}),
    }];
  });
}

function sourcesOf(value: unknown): SourceRow[] {
  const rows = (value as { sources?: unknown } | undefined)?.sources;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (typeof row !== 'object' || row === null) return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== 'string') return [];
    return [{
      id: item.id,
      name: typeof item.name === 'string' ? item.name : item.id,
      description: typeof item.description === 'string' ? item.description : '',
      builtin: item.builtin === true,
    }];
  });
}

function inspectOf(value: unknown): InspectResult {
  const data = (value ?? {}) as Record<string, unknown>;
  const options = Array.isArray(data.options) ? data.options : [];
  const required = Array.isArray(data.required) ? data.required : [];
  const skills = Array.isArray(data.skills) ? data.skills : [];
  return {
    source: typeof data.source === 'string' ? data.source : '',
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : '',
    options: options.flatMap(row => {
      if (typeof row !== 'object' || row === null) return [];
      const item = row as Record<string, unknown>;
      if (typeof item.key !== 'string' || typeof item.module !== 'string') return [];
      return [{
        key: item.key,
        module: item.module,
        group: typeof item.group === 'string' ? item.group : '',
        tools: Array.isArray(item.tools) ? item.tools.filter((entry): entry is string => typeof entry === 'string') : [],
        enabled: item.enabled !== false,
      }];
    }),
    required: required.flatMap(row => {
      if (typeof row !== 'object' || row === null) return [];
      const item = row as Record<string, unknown>;
      if (typeof item.key !== 'string' || typeof item.module !== 'string') return [];
      return [{
        key: item.key,
        module: item.module,
        tools: Array.isArray(item.tools) ? item.tools.filter((entry): entry is string => typeof entry === 'string') : [],
      }];
    }),
    skillControlled: data.skillControlled === true,
    skills: skills.flatMap(row => {
      if (typeof row !== 'object' || row === null) return [];
      const item = row as Record<string, unknown>;
      if (typeof item.name !== 'string') return [];
      return [{
        name: item.name,
        description: typeof item.description === 'string' ? item.description : '',
        source: typeof item.source === 'string' ? item.source : '',
        kind: item.kind === 'file' ? 'file' as const : 'directory' as const,
      }];
    }),
    virtualSkills: Array.isArray(data.virtualSkills)
      ? data.virtualSkills.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}
