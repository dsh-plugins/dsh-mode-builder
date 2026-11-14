/**
 * 读取来源模式实际可见的 SKILL，并把选中的技能快照成模式自带的技能根目录。
 *
 * 快照而不是引用原始路径，原因是派生模式要能长期稳定：用户后来移动或删除
 * 原始技能目录时，模式里勾选的技能仍应可用；同时 `skill-filesystem` 的
 * `customSkillDirs` 只接受“根目录”，无法只挑同一个根下的个别技能。
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SkillKind } from './store.js';

/** 技能快照的总字节上限：超过时拒绝派生，避免把巨型资源复制进模式目录。 */
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** 技能发现服务的只读视图，形状对齐 `ctx.skills`。 */
export interface SkillsRegistryLike {
  list(options: { cwd?: string; scope?: unknown; signal?: AbortSignal }): Promise<readonly SkillSummaryLike[]>;
}

/** 技能摘要中本插件用到的字段。 */
export interface SkillSummaryLike {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly path?: string;
  readonly resourceBase?: { readonly kind: string; readonly path?: string };
}

/** 一条可勾选的技能。 */
export interface SourceSkill {
  /** 技能名，也就是注册表里的唯一键。 */
  readonly name: string;
  /** 路由说明，界面展示用。 */
  readonly description: string;
  /** 发现来源桶（user-dsh、custom、bundled 等）。 */
  readonly source: string;
  /** 快照方式。 */
  readonly kind: SkillKind;
  /** 原始路径，仅用于复制。 */
  readonly path: string;
}

/** 技能清单及其不可快照的条目。 */
export interface SkillListing {
  /** 可勾选并能快照的技能。 */
  readonly skills: SourceSkill[];
  /** 没有本地文件的虚拟技能名，无法带进派生模式。 */
  readonly virtual: string[];
}

/**
 * 读取某个作用域当前可见的技能。
 *
 * 不传 `cwd`，因此项目级技能不参与：模式在配置时就确定，而项目根目录取决于
 * 之后打开的工作区，无法在派生时固定下来。
 * @param registry 技能注册表。
 * @param scope 来源预设的作用域 key。
 * @param signal 取消信号。
 * @returns 可快照技能与虚拟技能名单。
 */
export async function listSourceSkills(
  registry: SkillsRegistryLike,
  scope: unknown,
  signal: AbortSignal,
): Promise<SkillListing> {
  const summaries = await registry.list({ scope, signal });
  const skills: SourceSkill[] = [];
  const virtual: string[] = [];
  for (const summary of summaries) {
    const path = summary.path;
    if (typeof path !== 'string' || path.length === 0) {
      virtual.push(summary.name);
      continue;
    }
    skills.push({
      name: summary.name,
      description: summary.description,
      source: summary.source,
      kind: basename(path).toLowerCase() === 'skill.md' ? 'directory' : 'file',
      path,
    });
  }
  return { skills, virtual };
}

/**
 * 把选中的技能复制到模式自带的技能根目录。
 *
 * 目录型技能整体复制（保留其 references 等相对资源），平铺型复制同名
 * `<name>.md`。目标目录先清空，保证重复派生不会残留旧技能。
 * @param options 快照参数。
 * @throws 技能文件缺失或总大小超过上限时抛错，错误信息直接展示给用户。
 */
export async function snapshotSkills(options: {
  readonly skills: readonly SourceSkill[];
  readonly target: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { skills, target, signal } = options;
  await rm(target, { recursive: true, force: true });
  if (skills.length === 0) return;
  let total = 0;
  for (const skill of skills) {
    signal.throwIfAborted();
    total += await measure(skill.kind === 'directory' ? dirname(skill.path) : skill.path);
    if (total > MAX_SNAPSHOT_BYTES) {
      throw new Error(`所选 SKILL 合计超过 ${String(MAX_SNAPSHOT_BYTES / 1024 / 1024)} MiB，请少选一些`);
    }
  }
  await mkdir(target, { recursive: true });
  for (const skill of skills) {
    signal.throwIfAborted();
    if (skill.kind === 'directory') {
      await cp(dirname(skill.path), join(target, skill.name), { recursive: true });
    } else {
      await cp(skill.path, join(target, `${skill.name}.md`));
    }
  }
}

/**
 * 统计一个路径的字节数。
 * @param path 文件或目录。
 * @returns 该路径下所有普通文件的大小之和。
 */
async function measure(path: string): Promise<number> {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await measure(join(path, entry.name));
  }
  return total;
}
