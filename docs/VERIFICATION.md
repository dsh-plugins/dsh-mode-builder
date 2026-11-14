# 验证记录

本次开发使用 `.test/mode-builder/home` 独立 DSH home、独立 profile 与端口 `55393` 验证，运行版本为 DSH `0.2.2-rc.2` + `@dsh-plugin/dsh-loader@2.0.0-dev.43473963317`。

## 已执行检查

| 层级 | 命令或操作 | 结果 |
| --- | --- | --- |
| 派生规则 | `npm test` | 13 项通过：`!!js` 往返、必需行保留、组裁剪与空组丢弃、技能行重写与补插、技能为空的整行移除、字面停用解除、工作流依赖自动带出 PTC 引擎、id/名称校验、排序值计算。 |
| 类型检查 | `npm run typecheck` | 宿主与 TSX 客户端均通过。 |
| 构建 | `npm run build` | 生成 `lib/index.js` 与 `lib/client.js`；客户端产物以 `window.__ModuleLoader__.load({ id: "@dsh-plugin/dsh-mode-builder"` 开头，内部无顶层裸声明。 |
| 宿主加载 | 独立实例启动日志 | 无 `plugin tree failed to load`；插件详情页显示「模式构建器 v0.1.0 / 运行中」，组件 1 个 1 运行中。 |
| 配置面板 | 插件详情页 | 「模式管理」面板渲染表格与「刷新 / 新增模式」按钮；空态文案正确。 |
| 来源清单 | 向导选择「标准模式」 | 工具按「其他 / 计划模式 / 任务委派」分组列出，显示每个模块注册的工具名（`read`、`grep`、`workflow` 等）；「固定保留」列出 persona、agent-instructions、time-context、command-goal、压缩管线；SKILL 列表出现 `dsh-doc`，并提示 `diagnose-windows-sandbox-acl`、`office*` 等虚拟技能无法携带。 |
| 创建流程 | 向导填写 id/名称/说明并勾选 | 表格新增行，提示「已新增模式「演示模式」」，`tools` 与 `skills` 计数与实际勾选一致。 |
| 磁盘产物 | 检查 `data/dsh-mode-builder/modes/demo-mode.json` | 必需行原样保留、未勾选行已移除、`skill-filesystem` 重写为 `includeDefaultRoots: false` + 快照目录、技能目录已复制 `dsh-doc/SKILL.md` 及其 references/templates。 |
| 新会话可选 | 新建会话页模式胶囊 | 无需刷新整页，切回新会话后列表出现「演示模式」；选中后胶囊显示该模式，未出现拒绝提示。 |
| 预设定版 | 设置 → 内置插件 | 预设切换器列出全部 6 个预设；选中「只读检索模式」后组合只显示 persona、agent-instructions、time-context、tool-fs-search、skill-filesystem、tool-skill、command-goal、压缩组与 workflow-ptc + tool-workflow，全部「已启用」，无诊断行。 |
| 二次派生 | 以「演示模式」为来源新建「只读检索模式」 | 来源下拉列出既有自定义模式；清单只显示该模式保留的 4 行与 1 个技能；取消勾选「文件读写」后落盘为 3 行。 |
| 工作流依赖 | 创建时勾选 `tool-workflow` | 登记结果自动补入 `workflow-ptc`（`tools` 为 `["tool-fs","tool-fs-search","tool-workflow","workflow-ptc"]`）。 |
| 删除 | 面板删除与 `modes.delete` | 表格行消失；模式 JSON 与技能快照目录一并移除，`data/dsh-mode-builder` 下无残留。 |
| 列表诊断 | `modes.list` | 已注册模式不含 `broken` 字段，说明预设挂载成功。 |

## 未覆盖面

- 未在会话里实际发送消息：预设在「选定即组合」阶段已挂载成功（内置插件页显示全部行已启用），继续发送只会额外产生模型调用费用。
- 未验证 Windows 之外的平台；`!!js` 平台分支随行保留，派生逻辑本身不读平台。

## 复现方式

```powershell
# 1. 准备独立实例（profile 目录用 junction 指向本仓库，避免每次 build 后重新安装）
$home = '<repo>\.test\mode-builder\home'
$env:DSH_HOME = $home
node '<launcher>\versions\0.2.2-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile web --host 127.0.0.1 --port 55393 --no-open
```

启动日志会打印带 token 的地址；打开后进入「插件 → 模式构建器 → 模式管理」即可复现上述流程。

修改宿主端 `lib/index.js` 后必须重启该实例（Node ESM 模块缓存按 URL 驻留）；只改客户端时重启同样是最省事的验证方式，因为实例启动时才会重新计算 bundle 修订号。
