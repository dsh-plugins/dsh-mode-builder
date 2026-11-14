/**
 * 模式定义在磁盘上的读写。
 *
 * 每条模式一个 JSON 文件，自带 `version` 字段便于未来迁移；文件由插件独占，
 * 写入使用「临时文件 + 重命名」保证不会留下半截内容。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CompositionRow } from './mode-plan.js';

/** 模式文件的格式版本。 */
export const MODE_FORMAT_VERSION = 1;

/** 技能快照的类型：目录型技能整目录复制，平铺型只复制单个 Markdown 文件。 */
export type SkillKind = 'directory' | 'file';

/** 已保存的模式定义。 */
export interface ModeRecord {
  /** 文件格式版本。 */
  readonly version: typeof MODE_FORMAT_VERSION;
  /** 模式 id，同时是预设 id 与文件名。 */
  readonly id: string;
  /** 展示名称。 */
  readonly name: string;
  /** 一句话说明，可为空。 */
  readonly description: string;
  /** 派生来源的预设 id。 */
  readonly sourcePreset: string;
  /** 在模式列表中的排序值。 */
  readonly order: number;
  /** 保留的工具行 key（回显与诊断用）。 */
  readonly tools: readonly string[];
  /** 保留的 SKILL 名单。 */
  readonly skills: readonly { readonly name: string; readonly kind: SkillKind }[];
  /** 最终组合行，直接交给预设注册表。 */
  readonly rows: readonly CompositionRow[];
  /** 创建时间（ISO 8601）。 */
  readonly createdAt: string;
  /** 最后更新时间（ISO 8601）。 */
  readonly updatedAt: string;
}

/** 模式目录的读写器。 */
export class ModeStore {
  /**
   * @param root 模式数据根目录，模式文件写入其 `modes/` 子目录，技能快照写入 `skills/`。
   */
  constructor(private readonly root: string) {}

  /** 模式 JSON 所在目录。 */
  get modesDir(): string {
    return join(this.root, 'modes');
  }

  /**
   * 某个模式的技能快照根目录。
   * @param id 模式 id。
   * @returns 该模式的技能根目录。
   */
  skillsDir(id: string): string {
    return join(this.root, 'skills', id);
  }

  /**
   * 列出全部已保存模式。
   *
   * 无法解析的文件不会让整个列表失败：它们在读取时被跳过，避免一条损坏记录
   * 让用户在界面上完全看不到其余模式。
   * @returns 按 `order` 升序排列的模式记录。
   */
  async list(): Promise<ModeRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.modesDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records: ModeRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await this.read(name.slice(0, -'.json'.length));
      if (record !== undefined) records.push(record);
    }
    return records.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  /**
   * 读取单个模式。
   * @param id 模式 id。
   * @returns 模式记录；文件不存在或内容不合法时返回 `undefined`。
   */
  async read(id: string): Promise<ModeRecord | undefined> {
    if (!isSafeId(id)) return undefined;
    let text: string;
    try {
      text = await readFile(this.file(id), 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    return normalize(parsed);
  }

  /**
   * 写入一个模式，覆盖同 id 的旧记录。
   * @param record 待写入的模式记录。
   */
  async write(record: ModeRecord): Promise<void> {
    if (!isSafeId(record.id)) throw new Error(`非法的模式 id：${record.id}`);
    const file = this.file(record.id);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * 删除一个模式及其技能快照。
   * @param id 模式 id。
   */
  async remove(id: string): Promise<void> {
    if (!isSafeId(id)) throw new Error(`非法的模式 id：${id}`);
    await rm(this.file(id), { force: true });
    await rm(this.skillsDir(id), { recursive: true, force: true });
  }

  /**
   * 读取技能快照目录中的技能名，用于在界面上回显。
   * @param id 模式 id。
   * @returns 技能名列表；没有快照时为空。
   */
  async snapshotSkillNames(id: string): Promise<string[]> {
    const root = this.skillsDir(id);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) names.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith('.md')) names.push(entry.name.slice(0, -3));
    }
    return names.sort();
  }

  private file(id: string): string {
    return join(this.modesDir, `${id}.json`);
  }
}

/**
 * 把磁盘内容整理成模式记录。
 *
 * 只做结构收敛，不做业务校验：组合行原样保留，注册预设时由宿主复核。
 * @param value 解析后的 JSON 值。
 * @returns 合法记录或 `undefined`。
 */
function normalize(value: unknown): ModeRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  if (typeof id !== 'string' || !isSafeId(id)) return undefined;
  if (typeof name !== 'string' || name.trim().length === 0) return undefined;
  if (!Array.isArray(record.rows)) return undefined;
  const skills = Array.isArray(record.skills)
    ? record.skills.flatMap(item => {
      if (typeof item !== 'object' || item === null) return [];
      const entry = item as { name?: unknown; kind?: unknown };
      if (typeof entry.name !== 'string') return [];
      return [{ name: entry.name, kind: entry.kind === 'file' ? 'file' as const : 'directory' as const }];
    })
    : [];
  return {
    version: MODE_FORMAT_VERSION,
    id,
    name,
    description: typeof record.description === 'string' ? record.description : '',
    sourcePreset: typeof record.sourcePreset === 'string' ? record.sourcePreset : '',
    order: typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : 100,
    tools: Array.isArray(record.tools) ? record.tools.filter((item): item is string => typeof item === 'string') : [],
    skills,
    rows: record.rows as CompositionRow[],
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

/** 模式 id 只允许进入文件名占位符，不允许路径分隔符或点号穿越。 */
function isSafeId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,31}$/.test(id);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
