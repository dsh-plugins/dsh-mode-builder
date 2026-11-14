/**
 * `@dsh-plugin/dsh-mode-builder` 宿主端入口。
 *
 * 职责：把「模式管理」面板的操作翻译成磁盘上的模式定义，并把每条定义注册成
 * 宿主可用的 Agent 预设；配置界面本身由 dsh-loader 统一渲染，插件只声明模板。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, defineConfig } from '@dsh-plugin/dsh-loader/config';
import type { ConfigOperationResult, ConfigValue } from '@dsh-plugin/dsh-loader/config';
import type { CordisContext, HostAPI } from '@dsh-plugin/dsh-loader';
import { rowKindOf } from './catalog.js';
import {
  buildComposition,
  flattenLeaves,
  isSelectable,
  nextOrder,
  nodeToolNames,
  parseComposition,
  readTree,
  validateModeId,
  validateModeName,
  type CompositionRow,
  type RowNode,
} from './mode-plan.js';
import { listSourceSkills, snapshotSkills, type SkillListing, type SkillsRegistryLike } from './skills.js';
import { MODE_FORMAT_VERSION, ModeStore, type ModeRecord, type SkillKind } from './store.js';

export const name = '@dsh-plugin/dsh-mode-builder';
export const inject = ['dshLoader'];

/**
 * 宿主上下文：`dshLoader` 由 dsh-loader 注入；`inject` 用于等待预设注册表就绪。
 *
 * `CordisContext` 只描述 loader 自身依赖的最小表面，这里补上插件实际用到的
 * 两个成员，避免在运行期直接依赖 `@deepseek-ai/cordis` 的类型。
 */
interface HostContext extends CordisContext {
  dshLoader: HostAPI;
  inject?(deps: readonly string[], callback: (ctx: CordisContext) => void): void;
}

/** 配置模板标识，同时作为客户端面板注册时的 `configId`。 */
const CONFIG_ID = 'dsh-mode-builder';

/** 宿主自带的四个预设不能作为新模式 id。 */
const RESERVED_IDS: ReadonlySet<string> = new Set(['standard', 'ptc', 'minimal', 'cordis']);

/** 预设注册表暴露给本插件的最小接口。 */
interface AgentPresetService {
  register(definition: {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly order?: number;
    readonly plugins: readonly CompositionRow[];
  }): Promise<() => Promise<void>>;
  list(): Promise<readonly AgentPresetRow[]>;
  readDocument(id: string): Promise<{ readonly agentPreset: string; readonly content: string; readonly name?: string; readonly description?: string }>;
  acquireScope(id?: string): Promise<ScopeLease>;
}

/** 注册表返回的一行预设。 */
interface AgentPresetRow {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly order?: number;
  readonly broken?: string;
}

/** `acquireScope()` 借出的作用域租约。 */
interface ScopeLease {
  readonly key: unknown;
  [Symbol.asyncDispose](): Promise<void>;
}

/** 面板回传给客户端的模式行。 */
interface ModeSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePreset: string;
  readonly order: number;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  /** 预设当前无法挂载时的诊断，界面据此把该行标为不可用。 */
  readonly broken?: string;
}

/** 面板声明的配置模板。 */
const template = defineConfig({
  id: CONFIG_ID,
  packageName: name,
  title: '模式构建器',
  description: '从现有模式派生自定义模式：选择保留的工具与 SKILL，保存后即可在新建会话时选用。',
  fields: [],
  panels: [{
    id: 'modes',
    title: '模式管理',
    description: '新增的模式会立即出现在新建会话的模式列表；删除后该模式不再出现在列表，已开始的会话保持原有组合。',
    custom: true,
    fields: [
      { type: 'text', key: 'source', label: '来源模式' },
      { type: 'text', key: 'id', label: '模式 ID' },
      { type: 'text', key: 'name', label: '模式名称' },
      { type: 'textarea', key: 'description', label: '模式说明' },
      { type: 'array', key: 'tools', label: '保留的工具行', item: { type: 'text', label: '工具行标识' } },
      { type: 'array', key: 'skills', label: '保留的 SKILL', item: { type: 'text', label: 'SKILL 名称' } },
    ],
    operations: [
      { id: 'modes.list', input: [], readOnly: true },
      { id: 'modes.sources', input: [], readOnly: true },
      { id: 'modes.inspect', input: ['source'], readOnly: true },
      { id: 'modes.create', input: ['source', 'id', 'name', 'description', 'tools', 'skills'] },
      { id: 'modes.delete', input: ['id'] },
    ],
  }],
});

/**
 * 注册配置模板与全部面板操作，并把已保存的模式注册为 Agent 预设。
 * @param ctx 插件上下文，已注入 `dshLoader`。
 */
export async function apply(ctx: HostContext): Promise<void> {
  const loader = ctx.dshLoader;
  const store = new ModeStore(join(resolveDshHome(), 'data', 'dsh-mode-builder'));
  /** 当前已注册的预设及其注销函数，键为模式 id。 */
  const registered = new Map<string, () => Promise<void>>();

  const handle = await loader.config.register(ctx, template);

  const presets = (): AgentPresetService => {
    const service = ctx.get('agentPresets') as AgentPresetService | undefined;
    if (service === undefined) {
      throw new ConfigError('unavailable', '当前 profile 未启用 Agent 模式注册表，无法管理模式');
    }
    return service;
  };

  const skills = (): SkillsRegistryLike => {
    const service = ctx.get('skills') as SkillsRegistryLike | undefined;
    if (service === undefined) {
      throw new ConfigError('unavailable', '当前 profile 未启用技能注册表，无法读取来源模式的 SKILL');
    }
    return service;
  };

  /** 注销一个模式对应的预设；重复注销是安全的。 */
  const unregister = async (id: string): Promise<void> => {
    const dispose = registered.get(id);
    if (dispose === undefined) return;
    registered.delete(id);
    try {
      await dispose();
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mode-builder] 注销模式 ${id} 失败：${message(error)}`);
    }
  };

  /** 把一条模式记录注册成预设，覆盖同 id 的旧注册。 */
  const registerRecord = async (record: ModeRecord): Promise<void> => {
    await unregister(record.id);
    const definition: Parameters<AgentPresetService['register']>[0] = {
      id: record.id,
      name: record.name,
      description: record.description,
      order: record.order,
      plugins: record.rows,
    };
    registered.set(record.id, await presets().register(definition));
  };

  const summaries = async (): Promise<ModeSummary[]> => {
    const [records, roster] = await Promise.all([
      store.list(),
      presets().list().then(rows => rows, () => [] as readonly AgentPresetRow[]),
    ]);
    return records.map(record => {
      const row = roster.find(item => item.id === record.id);
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        sourcePreset: record.sourcePreset,
        order: record.order,
        tools: [...record.tools],
        skills: record.skills.map(skill => skill.name),
        ...(row?.broken === undefined ? {} : { broken: row.broken }),
      };
    });
  };

  /**
   * 读取来源模式的工具行、必需行与技能清单。
   * @param source 来源预设 id。
   * @param signal 取消信号。
   */
  const inspect = async (source: string, signal: AbortSignal): Promise<InspectResult> => {
    const service = presets();
    const document = await service.readDocument(source);
    const rows = parseComposition(document.content);
    const tree = readTree(rows);
    const leaves = flattenLeaves(tree);
    const options = leaves.filter(node => isSelectable(node)).map(node => ({
      key: node.key,
      module: node.name,
      group: node.path.at(-1) ?? '',
      tools: [...nodeToolNames(node)],
      enabled: node.raw.disabled !== true,
    }));
    const required = leaves
      .filter(node => rowKindOf(node.name) === 'required')
      .map(node => ({ key: node.key, module: node.name, tools: [...nodeToolNames(node)] }));
    const skillControlled = leaves.some(node => rowKindOf(node.name) === 'skill');
    const listing = skillControlled
      ? await readSourceSkills(service, source, signal)
      : { skills: [], virtual: [] };
    return {
      source,
      name: document.name ?? source,
      description: document.description ?? '',
      options,
      required,
      skillControlled,
      skills: listing.skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        kind: skill.kind,
      })),
      virtualSkills: listing.virtual,
    };
  };

  const readSourceSkills = async (
    service: AgentPresetService,
    source: string,
    signal: AbortSignal,
  ): Promise<SkillListing> => {
    let lease: ScopeLease;
    try {
      lease = await service.acquireScope(source);
    } catch (error) {
      throw new ConfigError('invalid', `来源模式「${source}」当前不可用：${message(error)}`);
    }
    try {
      return await listSourceSkills(skills(), lease.key, signal);
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  };

  handle.registerOperation('modes.list', async () => result({ modes: await summaries() }));

  handle.registerOperation('modes.sources', async () => {
    const roster = await presets().list();
    const usable = roster.filter(row => row.broken === undefined);
    const ordered = [...usable.filter(row => RESERVED_IDS.has(row.id)), ...usable.filter(row => !RESERVED_IDS.has(row.id))];
    return result({
      sources: ordered.map(row => ({
        id: row.id,
        name: row.name ?? row.id,
        description: row.description ?? '',
        builtin: RESERVED_IDS.has(row.id),
      })),
    });
  });

  handle.registerOperation('modes.inspect', async ({ input, signal }) => {
    const source = text(input.source);
    if (source.length === 0) throw new ConfigError('validation', '请先选择来源模式');
    return result(await inspect(source, signal));
  });

  handle.registerOperation('modes.create', async ({ input, signal }) => {
    const id = text(input.id).trim();
    const displayName = text(input.name).trim();
    const description = text(input.description).trim();
    const source = text(input.source);
    const keep = new Set(strings(input.tools));
    const wanted = new Set(strings(input.skills));

    const idProblem = validateModeId(id);
    if (idProblem !== undefined) throw new ConfigError('validation', idProblem);
    const nameProblem = validateModeName(displayName);
    if (nameProblem !== undefined) throw new ConfigError('validation', nameProblem);
    if (source.length === 0) throw new ConfigError('validation', '请先选择来源模式');
    if (RESERVED_IDS.has(id)) throw new ConfigError('validation', `「${id}」是宿主内置模式，请换一个 id`);
    if (await store.read(id) !== undefined) throw new ConfigError('validation', `模式 id「${id}」已存在`);

    const service = presets();
    const roster = await service.list();
    if (roster.some(row => row.id === id)) {
      throw new ConfigError('validation', `模式 id「${id}」与现有模式冲突`);
    }

    const document = await service.readDocument(source);
    const rows = parseComposition(document.content);
    const tree = readTree(rows);
    const selectable = new Map(flattenLeaves(tree).filter(node => isSelectable(node)).map(node => [node.key, node]));
    const keptRows = [...keep].filter(key => selectable.has(key));

    const listing = flattenLeaves(tree).some(node => rowKindOf(node.name) === 'skill')
      ? await readSourceSkills(service, source, signal)
      : { skills: [], virtual: [] };
    const unknown = [...wanted].filter(want => !listing.skills.some(skill => skill.name === want));
    if (unknown.length > 0) {
      throw new ConfigError('validation', `来源模式没有这些 SKILL：${unknown.join('、')}`);
    }
    const chosen = listing.skills.filter(skill => wanted.has(skill.name));
    signal.throwIfAborted();

    const skillsRoot = store.skillsDir(id);
    await snapshotSkills({ skills: chosen, target: skillsRoot, signal });
    const built = buildComposition({
      rows,
      keep: new Set(keptRows),
      skillDirs: chosen.length > 0 ? [skillsRoot] : null,
    });
    if (built.rows.length === 0) throw new ConfigError('validation', '派生结果为空，请至少保留一个工具');

    const order = nextOrder(roster.flatMap(row => (typeof row.order === 'number' ? [row.order] : [])));
    const now = new Date().toISOString();
    const record: ModeRecord = {
      version: MODE_FORMAT_VERSION,
      id,
      name: displayName,
      description,
      sourcePreset: source,
      order,
      tools: built.kept,
      skills: chosen.map(skill => ({ name: skill.name, kind: skill.kind })),
      rows: built.rows,
      createdAt: now,
      updatedAt: now,
    };
    await store.write(record);
    try {
      await registerRecord(record);
    } catch (error) {
      await store.remove(id);
      throw new ConfigError('failed', `模式保存后注册失败：${message(error)}`);
    }
    ctx.logger?.info?.(`[dsh-mode-builder] 已新增模式 ${id}（来源 ${source}）`);
    return result({ modes: await summaries() });
  });

  handle.registerOperation('modes.delete', async ({ input }) => {
    const id = text(input.id).trim();
    if (id.length === 0) throw new ConfigError('validation', '请选择要删除的模式');
    const record = await store.read(id);
    if (record === undefined) throw new ConfigError('validation', `模式「${id}」不存在`);
    await unregister(id);
    await store.remove(id);
    ctx.logger?.info?.(`[dsh-mode-builder] 已删除模式 ${id}`);
    return result({ modes: await summaries() });
  });

  // 预设注册表就绪后装载磁盘上的模式；注册表不可用的 profile（如纯命令行）跳过。
  if (ctx.inject === undefined) {
    ctx.logger?.warn?.('[dsh-mode-builder] 当前上下文不支持 inject，已保存的模式不会被注册');
    return;
  }
  ctx.inject(['agentPresets'], (scope: CordisContext) => {
    scope.effect(() => {
      let active = true;
      void (async () => {
        for (const record of await store.list()) {
          if (!active) return;
          try {
            await registerRecord(record);
          } catch (error) {
            ctx.logger?.warn?.(`[dsh-mode-builder] 装载模式 ${record.id} 失败：${message(error)}`);
          }
        }
      })();
      return async () => {
        active = false;
        for (const id of [...registered.keys()]) await unregister(id);
      };
    }, 'dsh-mode-builder: presets');
  });
}

/** `modes.inspect` 的返回结构。 */
interface InspectResult {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly options: readonly {
    readonly key: string;
    readonly module: string;
    readonly group: string;
    readonly tools: readonly string[];
    readonly enabled: boolean;
  }[];
  readonly required: readonly { readonly key: string; readonly module: string; readonly tools: readonly string[] }[];
  readonly skillControlled: boolean;
  readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly kind: SkillKind }[];
  readonly virtualSkills: readonly string[];
}

/** 统一包装操作返回值。 */
function result(value: unknown): ConfigOperationResult {
  return { value: value as ConfigValue };
}

function text(value: ConfigValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: ConfigValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析插件数据根目录，规则与宿主其余插件保持一致：`DSH_HOME` 优先，否则
 * 使用用户目录下的 `.dsh`；开头的 `~` 会展开。
 */
function resolveDshHome(): string {
  const configured = process.env.DSH_HOME?.trim();
  if (configured === undefined || configured.length === 0) return join(homedir(), '.dsh');
  return resolve(configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured);
}
