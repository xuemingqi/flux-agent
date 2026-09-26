# Flux Agent

用 TypeScript 实现的本地 Agent 工作台。已打通模型对话、工作区工具、权限审批、长期记忆和 SQLite 持久化：浏览器提交任务 → Hono 创建运行 → LangChain 调用模型与受控工具 → SSE 展示过程 → SQLite 保存记录。

## 本期能力

- 新建、切换会话，悬停菜单重命名或删除会话，连续多轮文字对话，安全的 Markdown 展示。
- 深色工作台、可收起侧栏、对话／轨迹视图；思考和工具默认折叠，展开查看完整内容、输入参数、进度、结果、耗时与执行状态。
- 接入真实的 `get_current_time` 只读时间工具，模型可调用后继续回答。工具开始、进度、结束和失败事件通过 SSE 推送，刷新可恢复。
- OpenAI-compatible Chat Completions 接口，支持在模型设置页面配置地址、名称和密钥，保存后立即生效。
- 后台运行与浏览器订阅分离；刷新页面可接续正在生成的回复。
- 生成中可调整方向：模型输出立即停止，已开始的工具完成后切换，跳过尚未开始的旧调用；处理状态实时展示并保存。
- 手动停止生成、明确错误终态；清理完成后才进入 `cancelled`。
- 同一会话限制一个活动运行，不同会话最多同时运行 4 轮。
- 本机监听、Host/Origin 校验、随机会话凭据；模型密钥不发送给浏览器。
- 本地工作区管理，输入框内选择“仅可查看／工作区内修改／完全权限”，新对话默认工作区内修改。
- 每个项目行悬停显示“更多操作”和“新建会话”；支持重命名、移除及重新添加。移除会同时删除该项目的全部会话，保留实际目录与长期记忆。
- 真实目录列表、UTF-8 文件读取、文本搜索、文件写入和本机命令工具；工作区内修改展示前后内容，允许或拒绝只影响本次调用。
- Drizzle + SQLite 保存模型配置、工作区、会话、原生模型消息、执行过程、审批及工具执行凭证。已保存内容重启后可查看。
- 工作区长期记忆管理、候选确认、全文检索、置顶、版本冲突校验、过期与禁用；每次模型请求展示实际引用的记忆。
- 模型设置支持自动获取或手动配置上下文窗口与输出预算；输入达到窗口的 90% 时生成摘要，压缩后目标为整个输入占窗口的 20%，摘要与完整原始历史分别保存到 SQLite。
- 多 Agent 支持并行分工、串行传递结果，每个子任务使用独立上下文并共用主 Agent 的模型、地址和 API Key；委派工具旁实时展示子任务状态，可展开查看过程与结果。模型鉴权、限流、上下文溢出及协议错误分类展示，不回显供应商敏感信息。
- 多步骤任务可通过 `update_plan` 建立和更新计划，页面实时展示步骤状态；刷新、重启保留最新进度，停止后不会自动勾选完成。
- 每轮回答可标记“有帮助／需改进”、补充文字意见并修改或撤回。计划和反馈随运行保存到 SQLite，反馈关联本轮 Agent 定义版本，不会自动变成长期记忆。

重启后未完成的运行标为“已中断”，待审批请求过期，未确认的副作用需要检查实际状态；不会自动重放写入或命令。当前还未实现 LangGraph 检查点续跑、MCP、向量语义记忆和附件。按当前需求不实现沙箱能力。实现边界与后续接入位置见 [实施状态](docs/implementation-status.md)。

可以在对话中输入“先制定计划，再读取项目 README 并总结结构”体验计划功能。简单问答不强制创建计划；任务计划表示模型报告的进度，工具执行仍按原权限与审批处理。回答结束后，底部显示评价按钮与“补充意见”。反馈只保存在本机，不会自动发送给模型或触发训练。

生成期间输入新要求，按 Enter 或“调整方向”即可切换：正在输出的回答立即停止；已开始的单个工具／命令先完成，尚未开始的旧调用跳过，然后优先处理新消息，不重放已完成操作。待审批的修改仍需允许或拒绝，插话不代表批准。页面显示“等待当前执行单元完成”与“已开始处理”；同一运行继续，补充、过程及结果写入 SQLite，刷新可恢复。发送失败保留草稿，相同消息标识重试不会重复接收。手动停止仍可取消整个运行。

## 一键安装与启动

无需提前安装 Node.js、克隆仓库或构建项目，直接在准备作为工作区的目录打开终端执行：

**macOS / Linux（Bash）**

```bash
curl -fsSL https://raw.githubusercontent.com/xuemingqi/flux-agent/dev/install.sh | bash
```

**Windows（PowerShell 5.1+）**

```powershell
irm https://raw.githubusercontent.com/xuemingqi/flux-agent/dev/install.ps1 | iex
```

**已有 Node.js 24+ 和 npm**

```bash
npm config set @yonyeyy:registry https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/
npx --yes @yonyeyy/flux-agent@latest web
```

脚本检测到可用的 Node.js 24+ 时直接复用；缺失或版本过低时，macOS / Linux 通过 [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) 安装 Node.js 24，Windows 通过 [WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/install) 安装或升级 Node.js LTS，并再次确认版本满足要求。随后写入用户 npm 配置中的 `@yonyeyy:registry`，执行 `npx --yes @yonyeyy/flux-agent@latest web`。

macOS / Linux 需要 Bash 和 curl 或 wget，nvm 安装到用户目录并可能更新 shell 配置；Windows 在需要安装 Node.js 时须有 WinGet（Microsoft Store 的“应用安装程序”提供），系统可能提示管理员授权。没有 WinGet 时脚本会提示先安装它或 Node.js 24+。下载需能访问 GitHub、Node.js 下载站点和 CNB 制品库。服务在当前终端前台运行，打开输出的 <http://127.0.0.1:3000> 使用，按 Ctrl+C 停止；不会注册开机自启服务。

也可以下载根目录的 [install.sh](install.sh) / [install.ps1](install.ps1) 后运行，并把 CLI 参数传给脚本：

```bash
bash ./install.sh --port 3100 --workspace /path/to/project
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --port 3100 --workspace "C:\My Project"
```

## npm CLI 使用与打包

发布包名称为 `@yonyeyy/flux-agent`，当前版本 `0.1.2`，通过 [CNB 公开制品库](https://cnb.cool/yonyeyy/flux-agent) 分发。首次使用先配置该 scope 的下载地址，其他依赖继续使用原有 npm 源：

```bash
npm config set @yonyeyy:registry https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/
npx --yes @yonyeyy/flux-agent@latest web
```

用户只需 Node.js 24 或更高版本和 npm，无需克隆仓库、安装 pnpm 或自行构建。启动后打开终端输出的 <http://127.0.0.1:3000>，首次在页面配置模型，按 Ctrl+C 停止服务。

```bash
npx @yonyeyy/flux-agent web --port 3100 --workspace /path/to/project
npx @yonyeyy/flux-agent web --data-dir /path/to/data --env-file /path/to/.env
npx @yonyeyy/flux-agent --help
```

CLI 默认以执行命令的当前目录作为首次工作区，数据仍保存在 `~/.flux-agent`，不会写入 npx 的安装缓存。已有数据目录保留已保存的工作区，`--workspace` 仅用于没有工作区的首次启动。命令行参数优先于环境变量；`--env-file` 指定的文件不会覆盖已存在的环境变量。CLI 不自动读取当前目录的 `.env`，需要时显式传入。

开发者在仓库根目录打包和验证：

```bash
pnpm install --frozen-lockfile
pnpm test:cli
npm pack
```

`npm pack` 会通过 `prepack` 自动执行完整构建，只生成本地 `yonyeyy-flux-agent-0.1.2.tgz`，不会发布。可从其他目录安装该文件验证：

```bash
npm exec --package=/absolute/path/yonyeyy-flux-agent-0.1.2.tgz -- flux-agent web
```

根包通过 `bin/flux-agent.mjs` 提供命令；内部 workspace 模块由 esbuild 合并为 ESM 后端入口，第三方运行依赖由 npm 安装。`files` 只包含 CLI 和 `dist/`，另由 npm 自动包含 `package.json`、README 等标准文件；构建产物包含网页和 SQLite 迁移，不携带 `.env`、数据库、测试或本机 `node_modules`。SQLite 沿用 `better-sqlite3`，若目标平台没有匹配的预编译二进制，安装时需要本地编译工具链。

发布目标已固定为 CNB 的 `yonyeyy/flux-agent` 制品库，使用具有该制品库 `registry-package` 读写权限的 CNB 访问令牌认证；公开下载无需令牌。这里的包名由 CNB 制品库管理，无需先在 npmjs 注册同名 scope。令牌只配置在本机，不写入仓库或发布包。项目的开源许可证需由维护者另行选定（当前仓库没有 LICENSE）。

维护者完成认证后，可显式发布已验证的压缩包：

```bash
npm publish ./yonyeyy-flux-agent-0.1.2.tgz --registry=https://npm.cnb.cool/yonyeyy/flux-agent/-/packages/
```

## 启动

推荐 Node.js 24 LTS，使用 `pnpm@11.19.0`。版本与依赖组合以 `pnpm-lock.yaml` 为准；TypeScript 固定为 5.9.3，以兼容当前 Vue 类型检查工具。

首次使用时先安装 pnpm（VS Code 终端也需要能找到该命令）：

```bash
npm install --global pnpm@11.19.0
pnpm --version
```

然后在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173>。首次启动没有模型配置时，首页自动显示“连接你的第一个模型”页面。填写接口地址、模型名称和 API Key，点击“保存并开始对话”，无需重启。之后可以通过侧栏的“模型设置”修改；已有运行使用原模型，新运行使用新配置。

模型配置保存在本机 `~/.flux-agent/app.db` 的 `model_settings` 表中，与会话统一使用 SQLite，不再新写配置文件。升级时自动导入旧版 `model.json`，数据库提交成功后删除旧文件；已有数据库配置优先。API Key 不回显、不写入浏览器本地存储；当前密钥在数据库中为明文，数据库文件权限为 `0600`，请将数据目录保持私有。修改模型时密钥留空可保留原值，更换接口地址需重新填写。保存只验证格式，不会自动调用模型。

可选：复制 `.env.example` 为 `.env`，配置端口或通过环境变量提供初始模型配置：

```dotenv
MODEL_BASE_URL=https://your-gateway.example/v1
MODEL_API_KEY=your-api-key
MODEL_NAME=your-model-name
```

地址应是 API 根地址，不要填完整的 `/chat/completions` 路径。如果供应商支持 `stream_options.include_usage`，可设置 `MODEL_STREAM_USAGE=true`；默认关闭以兼容更多网关。模型调用默认不自动重试。命令、模型请求和整轮任务均没有本地固定时长限制；文件审批持续等待用户决定，手动停止会取消待审批请求。旧的 `MODEL_TIMEOUT_MS` 环境变量不再使用。首次启动时完整的环境变量模型配置也会导入 SQLite，之后数据库配置优先。

模型需要支持工具调用（function calling）。可发送“帮我查询当前日期和时间”验证真实工具调用。思考面板只展示模型实际返回的 `reasoning_content` 或标准 reasoning 内容块；模型未返回时不显示思考。工具进度也只展示工具实际发出的事件，快速工具可能直接完成。用量在供应商返回时按本轮所有模型调用累加。

前端默认 5173、后端默认 3000，只监听本机；可以通过 `.env` 中的 `WEB_PORT` 和 `PORT` 修改，通过 `FLUX_DATA_DIR` 修改数据库目录。默认工作区是本项目，可用 `FLUX_WORKSPACE_DIR` 指定首次创建的工作区，也可点击侧栏加号，通过 macOS 系统窗口选择已有目录。所有已添加的工作区在侧栏分组显示，各自保留会话列表；点击名称切换当前工作区，旁边箭头独立折叠或展开该组。取消目录选择不改变当前工作区，重复选择同一目录不会创建重复项。原生选择器当前支持 macOS，其他系统仍可使用 CLI 的 `--workspace` 或 `FLUX_WORKSPACE_DIR`。修改 `.env` 或共享包后，用 Ctrl+C 停止旧服务，再执行 `pnpm dev`。同一数据库仅允许一个服务进程，避免重复启动破坏运行状态。

## 权限与工具

项目行右侧的 `…` 和 `+` 平时隐藏，悬停或键盘聚焦时显示，触屏设备直接显示。`+` 在对应项目内新建会话；`…` 可重命名或移除工作区。重命名只改变显示名称；确认移除后会永久删除该工作区的全部会话、消息、模型历史、运行记录、审批及工具执行凭证，不再转入“未分组”。实际目录和长期记忆保留，记忆的已删除会话来源链接会清除。重新添加同一目录可恢复名称和记忆，但不会恢复已删除的会话。有运行中任务的工作区需等任务结束后再移除。旧版本已移除并留在“未分组”的会话，可重新添加对应目录后再移除一次清理。

| 权限         | 文件范围           | 写入                           | Shell                  |
| ------------ | ------------------ | ------------------------------ | ---------------------- |
| 仅可查看     | 所选工作区         | 禁止                           | 禁止                   |
| 工作区内修改 | 所选工作区         | 展示完整修改前后内容，逐次审批 | 禁止                   |
| 完全权限     | 可访问工作区外路径 | 无逐次审批                     | 本机执行，允许网络访问 |

权限在运行开始时固定，执行中不能修改；开启完全权限需要明确确认。文件工具校验真实路径，拒绝越界及符号链接逃逸，不能直接访问 Flux 数据目录。命令没有操作系统沙箱，因此仅在完全权限下提供，命令持续运行至完成或用户停止；停止时结束整个进程组。日志只捕获最后 64000 个字符并标记截断，输出过多不会杀死命令。需要完整日志时，可让模型将输出重定向到工作区文件。完全权限下的命令具有当前系统用户权限。

文件读取不限制大小，完整返回 UTF-8 文本；单次写入限制 64 KB，使用原子替换。父目录必须存在，审批后原文或目标路径变化则拒绝写入。搜索使用字面字符串，跳过 `.git`、`node_modules` 和符号链接，最多扫描 500 项、返回 50 条结果。审批可在刷新后继续处理，断开浏览器不等于拒绝；停止运行会取消待审批请求。

生产构建及同源启动：

```bash
pnpm build
pnpm start
```

打开 <http://127.0.0.1:3000>。API 与构建后的页面由同一个 Hono 服务提供。

每条会话右侧也有悬停显示的 `…`，支持重命名和删除，键盘聚焦及触屏同样可用。删除会话会清理关联消息、模型历史、运行、子任务和审批记录，保留项目文件与长期记忆。正在运行的会话需先停止后删除。

## 多 Agent 编排

主 Agent 可以通过 `delegate_tasks` 将任务分给多个子 Agent：`parallel` 并行执行独立任务（最多同时执行 3 个，多余任务等待）；`sequential` 串行执行，并将前序结果交给后续任务。可直接发送“让两个 Agent 分别分析架构和测试，再汇总”，或“先让一个 Agent 实现，再让另一个审查”。子 Agent 使用独立上下文，继承当前工作区、模型和固定权限，文件修改仍需审批；并行任务应避免修改同一文件。

回复上方的子 Agent 卡片可以展开查看状态、思考、工具过程、结果和摘要，全部保存在 SQLite。主任务停止会取消子任务并等待清理；调整方向时，子任务的模型生成中止，已开始的工具完成后让出执行。当前支持单层主从编排，暂不支持递归派生、独立后台子会话或重启续跑。

同一次委派中的子 Agent 可以使用 `send_agent_message` 互相提问、分享发现或提供审查意见，使用 `receive_agent_messages` 短暂等待回复，单次等待最多 10 秒。来信会在接收方下一次模型请求中自动加入上下文；已结束的子 Agent 不会被自动唤醒。界面区分待接收、已送达和未送达，送达仅表示已加入模型请求，不代表已回复。串行任务的结果交接也会记录。消息随运行保存到 SQLite，服务重启会将未送达消息标记为未送达，不重放任务。

可以尝试：“让两个 Agent 并行协作，一个检查实现，一个检查测试。请互相发送发现、回应对方的问题，交换意见后再由主 Agent 汇总。”模型会根据任务需要选择是否交流；旧任务不会补造消息。

页面顶部保留“对话 / 轨迹”，并提供“协作空间”入口。Three.js 渲染的小熊猫、垂耳兔、薄荷熊和小花猫共享现代开放办公空间，会呼吸、眨眼、摇尾巴；思考、阅读、敲键盘和完成任务有对应动作。场景随人数扩展，默认只显示紧凑消息预览，点击角色展开按时间排列的完整消息、模型返回的思考、工具记录和收发交流，主 Agent 的历史按对话轮次分组；新消息不会覆盖旧记录，消息支持 Markdown。真实消息到达时，发送方会走向同伴并面对面展示对话气泡；交流记录支持回放，刷新后不会自动重演历史消息。多个轮次可切换查看。三个视图共用任务数据，切换不会重启任务，输入、停止、审批和文件预览仍可使用。3D 场景按需加载，离开场景释放资源，支持暂停和减少动态效果；设备不支持 WebGL 时保留简洁的小动物展示及全部任务操作。

## 长期记忆与上下文

从侧栏进入“长期记忆”，手动添加的事实和项目约定立即启用；也可以在聊天中要求模型记住某项约定，模型通过 `propose_memory` 提交待确认候选，用户在页面确认后才用于新请求。记忆绑定当前工作区，跨工作区不共享。候选工具不写项目文件，也不能替用户确认、修改权限或批准工具操作。

管理页支持搜索、编辑、置顶、禁用、有效期和删除，模型候选可打开来源会话。并发编辑使用版本校验，旧版本提交返回冲突，不覆盖较新的修改。删除同步清理全文索引，禁用或过期的条目不再自动引用；原始聊天记录和已经发送给模型的内容不会被追溯抹除。

`memories` 保存结构化记忆，`memories_fts` 是 SQLite FTS5 trigram 检索索引。检索按当前问题分词，三个及以上字符使用全文索引，短中文词使用字面匹配；置顶优先，再按匹配度和更新时间排序，剩余预算补充其他已确认记忆，避免“我是谁”这类问法没有词面交集而漏检。每个工作区最多 200 条，每条最多 4000 字符，每次最多选取 6 条、合计 6000 字符，仍受请求预算约束。模型还可在所有权限模式下通过 `search_memories` 主动查询已确认记忆，空查询按页浏览，返回 `nextOffset` 时可继续检索；候选、禁用、过期和其他工作区条目不会返回。目前没有 embedding 语义搜索或自动总结全部聊天。

模型设置会在填写或更换模型后查询当前服务商的 `/models` 容量元数据，也可点击“自动获取”。DeepSeek 官方接口未返回容量时，使用已核实的官方规格补充识别；不将官方规格套用到同名第三方接口。无法识别时需要手动填写，不再默认为 32768。已有窗口配置保留，可重新获取后保存。最大输出默认 0，表示不发送 `max_tokens`，由服务商决定输出预算；可选填写显式预算，思考与正文共同占用该预算。模型明确返回长度截断时会展示原因并保存终止标识。

压缩触发阈值为 `min(窗口 × 90%, 窗口 − 输出预留)`，未指定输出时预留窗口的 10%，不再叠加第二层折扣。按字符类别与消息开销近似估算 token（并非供应商精确 tokenizer）；预留量不会发送为模型输出限制。压缩目标为整个输入不超过窗口的 20%，包括系统提示、工具定义、记忆、摘要和保留原文。当前模型按动态摘要预算分块归纳，保留目标、最新调整、关键事实、操作结果与待办；工具调用及对应结果整体处理，当前任务和调整消息的原文始终保留。必要内容超过目标时会明确提示，没有可安全压缩的历史时跳过摘要请求。页面显示已完成片段数，刷新后也能看到当前压缩进度。

摘要与累计覆盖的原生消息数量保存在 SQLite 的运行快照里，成功轮次的摘要在后续对话中复用，原始消息和工具历史不删除。摘要生成失败会保留原文，并在上下文详情中提示，不把供应商报错当成历史事实。供应商明确返回上下文溢出时，会尝试进一步压缩后重试一次模型请求；不会重放工具。单条输入、系统提示或工具定义本身超过供应商容量时仍需调整输入或模型窗口。

每轮回复上方的“本轮上下文”可查看估算量、压缩前后大小、历史摘要、旧记录的工具结果缩短数量及实际引用的记忆。会话摘要用于承接本会话上下文，不自动转成跨会话长期记忆。此阶段没有 LangGraph checkpoint 恢复、embedding 或跨工作区记忆。

## 代码入口与扩展

| 位置                                                           | 当前职责                                 | 后续接入点                                        |
| -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `packages/contracts/src/index.ts`                              | Zod API schema、会话、运行、SSE 事件契约 | 新增工具、审批、附件等明确事件类型                |
| `packages/agent-runtime/src/agents/agent-runtime.ts`           | 一轮运行的上下文输入、事件输出和取消信号 | 替换为自定义 LangGraph 工作流，保持前端协议稳定   |
| `packages/agent-runtime/src/agents/agent-definition.ts`        | Agent 身份、系统提示词和允许执行的工具   | 在 `tools` 注入新的 LangChain／MCP 工具           |
| `packages/agent-runtime/src/agents/langchain-agent-runtime.ts` | 模型文本、思考及工具生命周期事件适配     | 通过 middleware 管理每次请求，后续扩展检查点管理  |
| `packages/agent-runtime/src/models/openai-compatible.ts`       | OpenAI-compatible 模型适配               | 新增其他 LangChain 模型，在 bootstrap 装配        |
| `apps/server/src/runs/run-manager.ts`                          | 运行生命周期、取消、历史选择和日志展示   | 引入队列、分页和执行租约                          |
| `apps/server/src/runs/run-store.ts`                            | 运行快照与工具执行凭证的存储契约         | 后续改为按会话加载、其他存储适配器                |
| `apps/server/src/storage/sqlite-run-store.ts`                  | Drizzle 事务、SQLite 恢复和迁移          | 保留独立的 LangGraph 检查点存储边界               |
| `apps/server/src/tools/tool-execution-service.ts`              | 参数、权限、审批、执行和凭证             | 新工具继续复用宿主执行入口                        |
| `apps/server/src/permissions/approval-service.ts`              | 单次审批的等待、决定和取消               | 后续结合持久检查点恢复审批等待                    |
| `apps/server/src/bootstrap/main.ts`                            | 模型、运行管理、HTTP 与静态资源装配      | 在这里接入真实能力实现                            |
| `apps/server/src/settings/model-settings-service.ts`           | 本地模型配置和运行实例                   | 接入系统凭据存储、多模型配置                      |
| `apps/server/src/memory/memory-store.ts`                       | 工作区记忆存储及检索契约                 | 扩展 embedding 索引，保留作用域、确认与有效期过滤 |
| `packages/agent-runtime/src/context/context-builder.ts`        | 原生工具历史校验、预算估算和记忆注入     | 精确 tokenizer 与分层上下文                       |
| `packages/agent-runtime/src/context/context-compressor.ts`     | 分块摘要、请求压缩与检查点复用           | 摘要质量评估、多层摘要                            |
| `packages/agent-runtime/src/agents/delegate-tasks.ts`          | 并行／串行子任务、权限继承与取消         | 多层编排、独立子会话与持久恢复                    |
| `apps/web/src/pages/MemoryPage.vue`                            | 记忆搜索、确认、编辑和删除               | 后续增加来源定位和冲突合并                        |
| `apps/web/src/pages/ModelSettingsPage.vue`                     | 首次配置和模型设置页面                   | 扩展模型能力配置                                  |
| `apps/web/src/composables/use-chat.ts`                         | 页面数据、发送、SSE 订阅和按帧更新       | 根据共享事件契约扩展状态                          |
| `apps/web/src/components/RunStepContent.vue`                   | 思考、工具参数／进度／结果的统一展示     | 新工具复用该组件；新增审批等步骤时扩展契约        |

保留实际使用的边界，不建立空的插件/工具/记忆模块。当前 SQLite 保存业务快照，启动时恢复历史；这不等于 LangGraph checkpoint 续跑。运行对象在单进程内持有，最多 100 个会话；后续扩大规模时应改为分页和按需加载。当前每轮只发送成功完成的历史对话，失败、取消或中断的整轮仍可查看，但不加入下一轮上下文。不再按会话轮数、运行步数或累计回答字符数中止任务，单条输入仍最多 32000 字符。

新完成轮次保存用户消息、助手文本、供应商返回的 reasoning_content、工具调用 ID／参数和工具结果，后续请求恢复原生配对关系；升级前未保存原生消息的历史回退为用户／助手文本，不伪造缺失工具历史。执行图不设固定迭代次数；单个工具的进度展示保留末尾 64000 个字符，单份工具展示内容最多 32000 字符，超长展示明确标记截断，任务继续运行。发送模型前的裁剪与本地存储分离，不会删掉历史记录；保存原生消息不等于自动重新执行旧工具。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm exec playwright install chromium
pnpm test:e2e
```

安装脚本的模拟测试：macOS / Linux 执行 `pnpm test:installers`；Windows 执行 `pnpm test:installers:windows`（也可使用 `pwsh -NoProfile -File tests/installers.test.ps1`）。测试覆盖 Node 复用与安装、参数传递和失败中止，不会实际安装 Node 或改写用户 npm 配置。

本机已有 Chrome 时，也可用 `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`。端到端测试会在 4318/4319/4320 启动独立应用和本地模拟模型，使用独立的临时配置目录，覆盖首次配置和真实 LangChain → HTTP → SSE → 浏览器链路，不读取或覆盖用户模型配置，不依赖供应商密钥，也不产生模型费用；这些测试不代表已经验证实际供应商账号。模拟模型只存在于 `tests/fixtures`，应用始终使用真实的模型适配器。

设计方案见 [docs/technical-proposal.md](docs/technical-proposal.md)。本次实现依据 [LangChain 流式接口](https://docs.langchain.com/oss/javascript/langchain/streaming)、[ChatOpenAI 适配文档](https://docs.langchain.com/oss/javascript/integrations/chat/openai)和 [Hono SSE helper](https://hono.dev/docs/helpers/streaming)。

macOS 目录选择使用 Apple 标准的 [choose folder](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/PromptforaFileorFolder.html)，只由用户点击加号触发；宿主执行固定脚本，不接受模型传入的命令。
