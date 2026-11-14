/**
 * 官方插件模块与模型可见工具名的对应关系，以及派生模式时的行分类规则。
 *
 * 这部分是数据而不是逻辑：新增官方工具包后在此登记即可，界面与派生逻辑都不必改。
 * 未登记的模块按“未知行”处理——界面显示模块名，勾选后整行原样保留。
 */

/** 从 0.2.2 的官方工具包出发整理的“模块 → 其注册的工具名”。 */
export const MODULE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-tool-fs': ['read', 'write', 'edit', 'read_image', 'apply_patch'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-pwsh-persistent': ['pwsh'],
  '@deepseek-ai/dsh-tool-bash-persistent': ['bash'],
  '@deepseek-ai/dsh-tool-web': ['web_search', 'web_fetch'],
  '@deepseek-ai/dsh-tool-jobs': ['job_list', 'job_output', 'job_kill'],
  '@deepseek-ai/dsh-tool-schedule': ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-present': ['present'],
  '@deepseek-ai/dsh-tool-office': ['office_render', 'office_convert', 'office_recalculate'],
  '@deepseek-ai/dsh-tool-subagent': ['subagent', 'subagent_fork', 'list_subagent_models'],
  '@deepseek-ai/dsh-tool-subagent-control': ['list_agents', 'send_message', 'wait_agent', 'interrupt_agent'],
  '@deepseek-ai/dsh-tool-workflow': ['workflow'],
  '@deepseek-ai/dsh-tool-cordis': ['cordis_inspect_list', 'cordis_inspect_query'],
  '@deepseek-ai/dsh-tool-terminal': ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_list', 'terminal_close', 'terminal_signal'],
  '@deepseek-ai/dsh-tool-str-replace-editor': ['str_replace_editor'],
  '@deepseek-ai/dsh-tool-working-directory': ['working_directory'],
  '@deepseek-ai/dsh-tool-workspace-dependencies': ['load_workspace_dependencies'],
  '@deepseek-ai/dsh-plan-mode': ['enter_plan_mode', 'exit_plan_mode'],
  '@deepseek-ai/dsh-plugin-manager/tools': ['plugin_manager'],
  '@deepseek-ai/dsh-plugin-market/tools': ['plugin_market'],
  '@deepseek-ai/dsh-tool-executor-ptc': ['run_code'],
};

/** 技能发现提供方：其行内容由派生模式的 SKILL 勾选结果整体重写。 */
export const SKILL_PROVIDER_MODULE = '@deepseek-ai/dsh-skill-filesystem';

/** 技能目录与加载工具：勾选任意 SKILL 时保留，一个都不留时连同发现方一并移除。 */
export const SKILL_TOOL_MODULE = '@deepseek-ai/dsh-tool-skill';

/**
 * 派生模式必须原样保留的行：人设与指令注入、上下文与压缩管线、工具执行器，
 * 以及全部斜杠命令。移除它们会让模式无法组成一次可用的对话轮次。
 */
export const REQUIRED_MODULES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-harness-dev-context',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-tool-executor-ptc',
]);

/**
 * 能力行的依赖：勾选前面的行时，必须同时保留后面的模块，否则工具会在运行期失效。
 * 例如工作流工具需要 PTC 工作流引擎来执行编排脚本。
 */
export const MODULE_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-tool-workflow': ['@deepseek-ai/dsh-workflow-ptc'],
};

/** 斜杠命令包整体必需：模式不声明命令时，用户按 `/` 将没有任何可选项。 */
const REQUIRED_MODULE_PREFIX = '@deepseek-ai/dsh-command-';

/**
 * 一行的派生归类。
 *
 * - `required`：恒保留，界面只读展示。
 * - `skill`：由 SKILL 勾选结果整体管理。
 * - `option`：可勾选的工具行或其他能力行。
 */
export type RowKind = 'required' | 'skill' | 'option';

/**
 * 判定一行在派生时的归类。
 * @param moduleName 该行声明的模块说明符。
 * @returns 该行的归类。
 */
export function rowKindOf(moduleName: string): RowKind {
  if (moduleName === SKILL_PROVIDER_MODULE || moduleName === SKILL_TOOL_MODULE) return 'skill';
  if (REQUIRED_MODULES.has(moduleName) || moduleName.startsWith(REQUIRED_MODULE_PREFIX)) return 'required';
  return 'option';
}

/**
 * 读取一行对外声明的工具名。
 * @param moduleName 该行声明的模块说明符。
 * @returns 已知模块的工具名列表；未知模块为空数组。
 */
export function toolNamesOf(moduleName: string): readonly string[] {
  return MODULE_TOOLS[moduleName] ?? [];
}

/**
 * 读取一行的必需同行模块。
 * @param moduleName 该行声明的模块说明符。
 * @returns 必须同时保留的模块名；没有依赖时为空数组。
 */
export function companionsOf(moduleName: string): readonly string[] {
  return MODULE_COMPANIONS[moduleName] ?? [];
}
