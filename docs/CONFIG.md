# 配置与操作契约

插件通过 dsh-loader 的 config-api 声明一个配置模板（`id: dsh-mode-builder`），其中只有一个自定义面板 `modes`。面板本身不保存任何配置值：每次操作都直接读取磁盘上的模式目录，读操作返回给前端渲染。

## 面板声明

| 项 | 值 |
| --- | --- |
| config id | `dsh-mode-builder` |
| packageName | `@dsh-plugin/dsh-mode-builder` |
| 面板 id | `modes`（`custom: true`） |
| 客户端组件 | `src/client/modes-panel.tsx` 的 `ModesPanel` |

面板字段只用于校验操作入参，不会渲染成表单：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `source` | text | 来源预设 id |
| `id` | text | 新模式 id |
| `name` | text | 展示名称 |
| `description` | textarea | 一句话说明 |
| `tools` | array\<text\> | 保留的工具行 key |
| `skills` | array\<text\> | 保留的 SKILL 名 |

## 操作

| 操作 | 入参 | 读/写 | 返回 |
| --- | --- | --- | --- |
| `modes.list` | — | 只读 | `{ modes: ModeSummary[] }` |
| `modes.sources` | — | 只读 | `{ sources: { id, name, description, builtin }[] }` |
| `modes.inspect` | `source` | 只读 | `{ source, name, description, options[], required[], skillControlled, skills[], virtualSkills[] }` |
| `modes.create` | `source,id,name,description,tools,skills` | 写 | `{ modes }`（创建后的完整列表） |
| `modes.delete` | `id` | 写 | `{ modes }` |

`ModeSummary` 字段：`id`、`name`、`description`、`sourcePreset`、`order`、`tools`、`skills`，以及可选的 `broken`（预设当前无法挂载时的诊断）。

### `modes.inspect` 的返回细节

- `options[]`：来源模式里可勾选的行，含 `key`（行身份）、`module`（模块说明符）、`group`（所在容器 id，空串表示顶层）、`tools`（该行注册的工具名）与 `enabled`（来源里是否默认启用）。
- `required[]`：派生时恒保留的行，界面只读展示。
- `skills[]`：通过 `agentPresets.acquireScope(source)` 借出该预设作用域后，用 `ctx.skills.list({ scope })` 读到的真实技能；没有本地 `path` 的技能进入 `virtualSkills`，无法携带。

### `modes.create` 的校验

按以下顺序拒绝，错误以 `ConfigError` 形式返回给面板：

1. `id` 未填或不符合 `^[a-z][a-z0-9-]{1,31}$`。
2. `name` 为空或超过 60 字符。
3. `source` 为空。
4. `id` 属于宿主内置的 `standard` / `ptc` / `minimal` / `cordis`。
5. `id` 已存在于磁盘或当前预设名册。
6. 请求里的 `skills` 含有来源模式没有的技能。
7. 所选 SKILL 合计超过 32 MiB。
8. 派生结果为空行。

通过的请求会：复制技能快照 → 计算组合行 → 写模式 JSON → 注册预设。注册失败时删除刚写的模式文件，保证磁盘与内存一致。

## 磁盘格式

`${DSH_HOME}/data/dsh-mode-builder/modes/<id>.json`：

```json
{
  "version": 1,
  "id": "demo-mode",
  "name": "演示模式",
  "description": "…",
  "sourcePreset": "standard",
  "order": 101,
  "tools": ["tool-fs", "tool-fs-search"],
  "skills": [{ "name": "dsh-doc", "kind": "directory" }],
  "rows": [{ "id": "persona", "name": "@deepseek-ai/dsh-persona", "config": {} }],
  "createdAt": "2026-11-14T06:55:18.742Z",
  "updatedAt": "2026-11-14T06:55:18.742Z"
}
```

`rows` 是最终交给 `agentPresets.register()` 的 Cordis 行列表，`!!js` 条件以 `{ "__jsExpr": "…" }` 形式保存，与 Loader 的入口方言一致。无法解析的模式文件在列表时被跳过，不会让整个面板失效。

## 生命周期

- 插件 `apply()` 注册配置模板与 5 个操作，然后在 `ctx.inject(['agentPresets'])` 回调里读取磁盘上的全部模式并逐个注册。
- 卸载插件（或被禁用）时，`ctx.effect` 的清理函数逐个注销已注册的预设。
- 目标 profile 没有 Agent 预设注册表时（例如纯命令行 profile），插件仍可加载，但面板操作会返回「当前 profile 未启用 Agent 模式注册表」。

## 数据目录覆盖

数据根目录固定为 `${DSH_HOME}/data/dsh-mode-builder`，`DSH_HOME` 支持 `~` 展开；未设置时使用 `~/.dsh`。如需更换位置，请在启动前设置 `DSH_HOME`，插件不提供单独的目录配置项，以免出现「面板指向的目录」与「预设读取的目录」不一致。
