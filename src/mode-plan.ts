/**
 * 派生模式的纯逻辑：解析来源预设的组合 YAML、按勾选结果裁剪行、重写技能行。
 *
 * 这里不碰文件系统与 Cordis，便于单元测试；宿主入口只负责读写与注册。
 */
import * as yaml from 'js-yaml';
import {
  SKILL_PROVIDER_MODULE,
  SKILL_TOOL_MODULE,
  companionsOf,
  rowKindOf,
  toolNamesOf,
} from './catalog.js';

/** 一行组合插件配置（与 Cordis entry 行的结构一致）。 */
export type CompositionRow = Record<string, unknown>;

/** 解析后的行树节点。 */
export interface RowNode {
  /** 行身份：来源显式声明的 `id`，否则为 `模块名#序号`；同一份文档内稳定。 */
  readonly key: string;
  /** 模块说明符。 */
  readonly name: string;
  /** 是否为 group 容器行。 */
  readonly group: boolean;
  /** 原始行数据（不含子行）。 */
  readonly raw: CompositionRow;
  /** group 的子行；非 group 为空数组。 */
  readonly children: readonly RowNode[];
  /** 自顶层起的容器 id 链，用于界面分组显示。 */
  readonly path: readonly string[];
}

/** 模式 id 的合法形状：小写字母开头，允许数字与连字符，长度 2–32。 */
export const MODE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** `!!js` 表达式节点：Loader 用 `__jsExpr` 字段承载表达式文本。 */
const JS_EXPR_TAG = 'tag:yaml.org,2002:js';

/** 与 `@deepseek-ai/cordis-plugin-include` 一致的 YAML 方言，保留表达式节点。 */
const schema = yaml.JSON_SCHEMA.extend(
  new yaml.Type(JS_EXPR_TAG, {
    kind: 'scalar',
    resolve: (data: unknown) => typeof data === 'string',
    construct: (data: string) => ({ __jsExpr: data }),
    predicate: (data: unknown) => isJsExpr(data),
    represent: (data: { __jsExpr?: string }) => data.__jsExpr,
  }) as unknown as yaml.Type,
);

/**
 * 判定一个值是否为 Loader 的 `!!js` 表达式节点。
 * @param value 待判定的值。
 * @returns 是否为表达式节点。
 */
export function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && '__jsExpr' in value;
}

/**
 * 解析预设声明的组合 YAML。
 *
 * 只接受顶层为行数组的文档；`!!js` 标量保留为 `{ __jsExpr }` 节点，写回时
 * 由 Loader 重新求值，派生模式因此继承来源模式的条件行语义。
 * @param content `AgentPresetRegistry.readDocument()` 返回的 YAML 文本。
 * @returns 顶层行数组。
 * @throws 文档不是行数组时抛错，错误信息直接展示给用户。
 */
export function parseComposition(content: string): CompositionRow[] {
  const parsed = yaml.load(content, { schema });
  if (!Array.isArray(parsed)) throw new Error('来源模式的组合内容不是插件行列表，无法派生');
  return parsed.map((row, index) => asRow(row, index));
}

/**
 * 把行数组读成树。
 * @param rows 顶层或 group 内的行数组。
 * @param path 当前容器 id 链。
 * @returns 该层的行节点。
 */
export function readTree(rows: readonly CompositionRow[], path: readonly string[] = []): RowNode[] {
  return rows.map((raw, index) => {
    const name = typeof raw.name === 'string' ? raw.name : '';
    const group = raw.group === true;
    const key = rowKey(raw, index);
    return {
      key,
      name,
      group,
      raw,
      children: group ? readTree(asRows(raw.config), [...path, key]) : [],
      path,
    };
  });
}

/**
 * 展开树里所有非容器行。
 * @param nodes 行节点。
 * @returns 按文档顺序排列的叶子行。
 */
export function flattenLeaves(nodes: readonly RowNode[]): RowNode[] {
  const leaves: RowNode[] = [];
  for (const node of nodes) {
    if (node.group) leaves.push(...flattenLeaves(node.children));
    else leaves.push(node);
  }
  return leaves;
}

/** 派生选项。 */
export interface BuildOptions {
  /** 来源模式的顶层行。 */
  readonly rows: readonly CompositionRow[];
  /** 用户勾选保留的可选行 key。 */
  readonly keep: ReadonlySet<string>;
  /** 技能快照目录；`null` 表示不保留任何 SKILL。 */
  readonly skillDirs: readonly string[] | null;
}

/** 派生结果。 */
export interface BuiltComposition {
  /** 新的组合行（可直接交给 `agentPresets.register()`）。 */
  readonly rows: CompositionRow[];
  /** 实际保留的可选行 key，用于回显与校验。 */
  readonly kept: string[];
}

/**
 * 按勾选结果裁剪来源模式的组合。
 *
 * 必需行原样保留；技能行由 `skillDirs` 整体决定；其余行仅当用户勾选时保留。
 * 组行只是容器：子行全部被移除时整组消失。用户显式保留的字面 `disabled: true`
 * 行会解除停用，因为“勾选保留”就是对来源默认停用的覆盖；`!!js` 条件保持不动。
 * @param options 派生选项。
 * @returns 新的组合行与保留的可选行 key。
 */
export function buildComposition(options: BuildOptions): BuiltComposition {
  const keep = expandCompanions(options.rows, options.keep);
  const effective: BuildOptions = { ...options, keep };
  const state = { skillSeen: false };
  const rows = filterRows(options.rows, effective, state);
  if (options.skillDirs !== null && !state.skillSeen) {
    rows.push(skillProviderRow(options.skillDirs));
    rows.push({ id: 'tool-skill', name: SKILL_TOOL_MODULE });
  }
  const kept = [...keep].filter(key => containsKey(rows, key));
  return { rows, kept };
}

/**
 * 把勾选行的必需同行模块补进保留集合。
 *
 * 只补充来源文档里确实存在的行：来源没有该模块时不做无中生有的插入，交由
 * 界面在来源模型缺失依赖时提示。
 * @param rows 来源模式的顶层行。
 * @param keep 用户勾选的行 key。
 * @returns 补全依赖后的保留集合。
 */
function expandCompanions(rows: readonly CompositionRow[], keep: ReadonlySet<string>): Set<string> {
  const leaves = flattenLeaves(readTree(rows));
  const expanded = new Set(keep);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of leaves) {
      if (!expanded.has(node.key)) continue;
      for (const companion of companionsOf(node.name)) {
        for (const candidate of leaves) {
          if (candidate.name !== companion || expanded.has(candidate.key)) continue;
          expanded.add(candidate.key);
          changed = true;
        }
      }
    }
  }
  return expanded;
}

/**
 * 校验派生模式的 id。
 * @param id 用户填写的 id。
 * @returns 错误文案；合法时返回 `undefined`。
 */
export function validateModeId(id: unknown): string | undefined {
  if (typeof id !== 'string' || id.length === 0) return '请填写模式 ID';
  if (!MODE_ID_PATTERN.test(id)) {
    return '模式 ID 只能使用小写字母、数字和连字符，且以小写字母开头，长度 2–32';
  }
  return undefined;
}

/**
 * 校验派生模式的显示名称。
 * @param name 用户填写的名称。
 * @returns 错误文案；合法时返回 `undefined`。
 */
export function validateModeName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.trim().length === 0) return '请填写模式名称';
  if (name.trim().length > 60) return '模式名称不能超过 60 个字符';
  return undefined;
}

/**
 * 判定来源文档里的行是否为可勾选能力。
 * @param node 行节点。
 * @returns 可勾选时为 true。
 */
export function isSelectable(node: RowNode): boolean {
  return !node.group && rowKindOf(node.name) === 'option';
}

/**
 * 读取一行声明的工具名。
 * @param node 行节点。
 * @returns 工具名列表。
 */
export function nodeToolNames(node: RowNode): readonly string[] {
  return toolNamesOf(node.name);
}

/**
 * 计算新模式的排序值，使新增模式排在既有模式之后。
 * @param orders 既有模式的 `order` 列表。
 * @returns 新的 `order`。
 */
export function nextOrder(orders: readonly number[]): number {
  const highest = orders.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 100);
  return highest + 1;
}

/**
 * 行身份：显式 `id` 优先，否则用模块名与层内序号组合，保证同一文档可复现。
 * @param raw 行数据。
 * @param index 该行在其所在数组中的序号。
 * @returns 行 key。
 */
function rowKey(raw: CompositionRow, index: number): string {
  const id = raw.id;
  if (typeof id === 'string' && id.length > 0) return id;
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'row';
  return `${name}#${index}`;
}

function filterRows(
  rows: readonly CompositionRow[],
  options: BuildOptions,
  state: { skillSeen: boolean },
): CompositionRow[] {
  const output: CompositionRow[] = [];
  rows.forEach((raw, index) => {
    const key = rowKey(raw, index);
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (raw.group === true) {
      const children = filterRows(asRows(raw.config), options, state);
      if (children.length === 0) return;
      output.push({ ...raw, config: children });
      return;
    }
    const kind = rowKindOf(name);
    if (kind === 'skill') {
      if (options.skillDirs === null) return;
      state.skillSeen = true;
      output.push(name === SKILL_PROVIDER_MODULE
        ? { ...raw, config: skillProviderConfig(raw.config, options.skillDirs) }
        : { ...raw });
      return;
    }
    if (kind === 'required') {
      output.push({ ...raw });
      return;
    }
    if (!options.keep.has(key)) return;
    const row: CompositionRow = { ...raw };
    if (row.disabled === true) delete row.disabled;
    output.push(row);
  });
  return output;
}

function containsKey(rows: readonly CompositionRow[], key: string): boolean {
  return rows.some((raw, index) => {
    if (raw.group === true) return containsKey(asRows(raw.config), key);
    return rowKey(raw, index) === key;
  });
}

function skillProviderRow(dirs: readonly string[]): CompositionRow {
  return { id: 'skill-filesystem', name: SKILL_PROVIDER_MODULE, config: skillProviderConfig(undefined, dirs) };
}

function skillProviderConfig(current: unknown, dirs: readonly string[]): CompositionRow {
  const base: CompositionRow = isPlainObject(current) ? { ...current } : {};
  delete base.bundledSkillDir;
  delete base.customSkillDirs;
  delete base.includeDefaultRoots;
  delete base.watch;
  return { ...base, includeDefaultRoots: false, customSkillDirs: [...dirs], watch: false };
}

function isPlainObject(value: unknown): value is CompositionRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRows(value: unknown): CompositionRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((row, index) => asRow(row, index));
}

function asRow(value: unknown, index: number): CompositionRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`来源模式的第 ${String(index + 1)} 行不是插件配置对象`);
  }
  return value as CompositionRow;
}
