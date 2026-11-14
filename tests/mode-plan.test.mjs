import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComposition,
  flattenLeaves,
  isSelectable,
  nextOrder,
  parseComposition,
  readTree,
  validateModeId,
  validateModeName,
} from '../lib/mode-plan.js';

/** 一段接近真实预设的派生素材：必需行、可选行、条件行、工具组与技能行。 */
const SOURCE = `
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hello
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    applyPatch: false
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join('x', 'skills')
    watch: true
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
    - id: optional-reader
      name: '@deepseek-ai/dsh-tool-web'
      disabled: true
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
`;

const rows = parseComposition(SOURCE);

test('parseComposition 保留 !!js 表达式节点', () => {
  const bash = rows.find(row => row.id === 'tool-bash');
  assert.deepEqual(bash.disabled, { __jsExpr: "process.platform === 'win32'" });
  const tree = readTree(rows);
  const skill = flattenLeaves(tree).find(node => node.name === '@deepseek-ai/dsh-skill-filesystem');
  assert.ok(skill !== undefined);
});

test('buildComposition 只保留必需行与已勾选的可选行', () => {
  const built = buildComposition({ rows, keep: new Set(['tool-fs']), skillDirs: null });
  const names = built.rows.map(row => row.name);
  assert.deepEqual(names, [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-tool-fs',
  ]);
  assert.deepEqual(built.kept, ['tool-fs']);
});

test('buildComposition 保留仍含已勾选行的工具组', () => {
  const built = buildComposition({ rows, keep: new Set(['optional-reader']), skillDirs: null });
  const group = built.rows.find(row => row.id === 'planning');
  assert.ok(group !== undefined);
  assert.deepEqual(group.config.map(row => row.id), ['optional-reader']);
});

test('buildComposition 在未勾选任何技能时移除技能发现与加载行', () => {
  const built = buildComposition({ rows, keep: new Set(), skillDirs: null });
  const names = built.rows.map(row => row.name);
  assert.ok(!names.includes('@deepseek-ai/dsh-skill-filesystem'));
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-skill'));
});

test('buildComposition 用快照目录重写技能发现配置', () => {
  const built = buildComposition({ rows, keep: new Set(), skillDirs: ['/data/modes/demo/skills'] });
  const provider = built.rows.find(row => row.name === '@deepseek-ai/dsh-skill-filesystem');
  assert.deepEqual(provider.config, {
    includeDefaultRoots: false,
    customSkillDirs: ['/data/modes/demo/skills'],
    watch: false,
  });
  assert.ok(built.rows.some(row => row.name === '@deepseek-ai/dsh-tool-skill'));
});

test('buildComposition 在来源缺少技能行时补插技能发现与加载行', () => {
  const bare = parseComposition("- id: persona\n  name: '@deepseek-ai/dsh-persona'\n");
  const built = buildComposition({ rows: bare, keep: new Set(), skillDirs: ['/data/modes/demo/skills'] });
  assert.deepEqual(built.rows.map(row => row.name), [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tool-skill',
  ]);
});

test('buildComposition 保留 !!js 条件行，勾选即解除字面停用', () => {
  const kept = buildComposition({ rows, keep: new Set(['tool-bash', 'optional-reader']), skillDirs: null });
  const bash = kept.rows.find(row => row.id === 'tool-bash');
  assert.deepEqual(bash.disabled, { __jsExpr: "process.platform === 'win32'" });
  const group = kept.rows.find(row => row.id === 'planning');
  const option = group.config.find(row => row.id === 'optional-reader');
  assert.equal('disabled' in option, false);
  assert.deepEqual(kept.kept.sort(), ['optional-reader', 'tool-bash']);
});

test('buildComposition 丢弃子行全部移除后的空组', () => {
  const built = buildComposition({ rows, keep: new Set(), skillDirs: null });
  assert.ok(!built.rows.some(row => row.id === 'planning'));
});

test('readTree 与 isSelectable 区分容器行、必需行与可选行', () => {
  const tree = readTree(rows);
  assert.equal(tree.find(node => node.key === 'planning').group, true);
  const leaves = flattenLeaves(tree);
  assert.equal(isSelectable(leaves.find(node => node.key === 'tool-fs')), true);
  assert.equal(isSelectable(leaves.find(node => node.key === 'persona')), false);
  assert.equal(isSelectable(leaves.find(node => node.key === 'plan-mode')), true);
  assert.equal(isSelectable(leaves.find(node => node.key === 'tool-skill')), false);
  assert.deepEqual(leaves.find(node => node.key === 'plan-mode').path, ['planning']);
});

test('validateModeId 与 validateModeName 拒绝非法输入', () => {
  assert.equal(validateModeId('demo-mode'), undefined);
  assert.match(validateModeId(''), /请填写/);
  assert.match(validateModeId('Demo'), /小写字母/);
  assert.match(validateModeId('-demo'), /小写字母/);
  assert.match(validateModeId('demo mode'), /小写字母/);
  assert.equal(validateModeName('演示模式'), undefined);
  assert.match(validateModeName('   '), /请填写/);
  assert.match(validateModeName('x'.repeat(61)), /60/);
});

test('nextOrder 在现有最大排序值之后追加', () => {
  assert.equal(nextOrder([]), 101);
  assert.equal(nextOrder([1, 2, 3, 4]), 101);
  assert.equal(nextOrder([1, 140, 20]), 141);
  assert.equal(nextOrder([Number.NaN, 7]), 101);
});

/** 工作流工具依赖 PTC 引擎：勾选工具时引擎必须同时保留。 */
const WORKFLOW = `
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
`;

test('buildComposition 勾选工作流工具时自动保留 PTC 引擎', () => {
  const rowsWithWorkflow = parseComposition(WORKFLOW);
  const kept = buildComposition({ rows: rowsWithWorkflow, keep: new Set(['tool-workflow']), skillDirs: null });
  const group = kept.rows.find(row => row.id === 'delegation');
  assert.deepEqual(group.config.map(row => row.id), ['workflow-ptc', 'tool-workflow']);
  assert.deepEqual(kept.kept.sort(), ['tool-workflow', 'workflow-ptc']);
});

test('buildComposition 未勾选工作流工具时整组消失', () => {
  const rowsWithWorkflow = parseComposition(WORKFLOW);
  const kept = buildComposition({ rows: rowsWithWorkflow, keep: new Set(), skillDirs: null });
  assert.ok(!kept.rows.some(row => row.id === 'delegation'));
});
