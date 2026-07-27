# actoviq-agent-sdk 0.4.7 集成问题

本文记录本项目升级到 `actoviq-agent-sdk@0.4.7` 后，通过桌面 Agent、技术报告 Agent 和视觉布局 skill 集成测试确认的问题。测试基线为 Node.js 22.20.0。

## 1. `validateInput` 未在本地工具执行链中调用

- 严重度：高
- 现象：`tool()` 定义的 `validateInput` 存在于公开类型中，但 `createLocalToolAdapter().execute()` 仅执行 schema parse、tool execute 和 output parse。
- 影响：依赖 `validateInput` 的能力、安全或业务门禁在真实 tool loop 中不会生效。
- 本项目绕过：`view_schematic_for_layout` 在 `execute` 首行重复执行视觉能力硬校验；`validateInput` 仅保留为前置提示和未来兼容。
- SDK 建议：在调用 `definition.execute()` 前执行并强制处理 `definition.validateInput()` 的拒绝结果，并增加通过 SDK tool loop 的回归测试。

## 2. OpenAI 兼容适配器丢弃 tool-result 中的图片

- 严重度：高
- 现象：Anthropic 风格 `tool_result.content` 为数组时，OpenAI 适配器只连接其中的 `text`，忽略 `image` block。
- 影响：工具虽然成功返回 PNG，OpenAI/DeepSeek 兼容视觉模型的下一轮请求仍看不到图片。
- 本项目绕过：注入项目侧 `ModelApi` 包装器，把 tool-result 内的图片提升为紧随其后的独立 `user` 图片消息，再委托 SDK OpenAI adapter。
- SDK 建议：适配 tool result 时保留文本 `role=tool` 消息，并把图片转换为后续 `role=user` 的 `image_url` 内容；同时覆盖 streaming 与 non-streaming。

## 3. skill 的 `allowedTools` 不会过滤有效工具目录

- 严重度：中高
- 现象：agent 的 `allowedTools` 会参与工具过滤，而 skill 的同名字段只生成 allow permission；skill 仍默认继承 SDK 默认工具。
- 影响：开发者容易误以为视觉只读 skill 只拥有声明的工具，实际可能同时得到 Write、Edit、Shell 或其他全局工具。
- 本项目绕过：视觉 skill 显式设置 `inheritDefaultTools: false`，并只注册 `view_schematic_for_layout`；质量报告由 host 嵌入 stage packet，不再依赖 Read。
- SDK 建议：统一 agent/skill 的 `allowedTools` 语义，或将 skill 字段改名为 `allowedToolPermissions` 并在文档中明确说明。

## 4. `maxToolIterations: 0` 不能覆盖非零全局值

- 严重度：中
- 现象：运行时使用 truthy 选择覆盖值，`0` 被当作未设置。
- 影响：希望完全禁止工具循环的专用 agent 无法用零值覆盖全局配置。
- 本项目绕过：专用文本 agent 使用 `inheritDefaultTools: false` 且不注册工具；视觉 host 使用隔离工具目录和有限迭代数。
- SDK 建议：用空值合并或 `!== undefined` 判断覆盖值，并增加 `0`、`1`、未设置三种测试。

## 5. 空工具数组仍会继承默认工具

- 严重度：文档/API 易用性
- 现象：`tools: []` 表示“不追加工具”，不是“没有工具”；只有 `inheritDefaultTools: false` 才能关闭继承。
- 影响：连接测试、报告生成等看似无工具的 agent 仍可能把管理工具 schema 发给模型。
- 本项目处理：所有内置无工具 agent 都建立专用 profile，并设置 `inheritDefaultTools: false`。
- SDK 建议：在类型文档和运行时诊断中明确两者差异；可考虑提供 `toolMode: 'none' | 'inherit' | 'custom'`。

## 建议加入 SDK 的验收测试

1. `validateInput` 拒绝后 tool execute 和 provider 后续轮次均不得发生。
2. OpenAI 两轮工具调用中，第二轮同时包含原 tool call 结果及可解码的 PNG `image_url`。
3. skill 设置工具白名单后，有效 provider tools 必须与白名单完全一致。
4. agent 的 `maxToolIterations: 0` 必须覆盖全局非零值。
5. `tools: []`、`inheritDefaultTools: false` 及两者组合的工具目录快照测试。

