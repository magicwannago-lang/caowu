# 治愈文案师（healing-scribe）智能体配置

草屋「衡几」的自媒体文案输出器物。综合「现代心理问题总结 + 儒释道典籍 + 时事」生成治愈性文案的 DSH（DeepSeek Harness）智能体 preset。

## 目录结构

```
healing/
├─ preset.yml                 # 显示名与描述
├─ agent.cordis.yml           # 组装：人设 + 可配置模型 + Obsidian MCP + 时事检索 + 技能
└─ skills/
   └─ healing-copywriting/
      └─ SKILL.md             # 治愈文案工作流：流程、体裁规格、输出模板、典籍速查
```

## 安装与启用

1. 把 `healing-scribe` 整个目录复制到 DSH 的 preset 根目录（`<dshHome>/.agent-presets/healing-scribe`）。
2. 创建会话时选择「治愈文案师」preset（会话一旦产出内容便不可切换）。

## 大模型配置（在组装文件中改）

`agent.cordis.yml` 中专门有一段：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official   # 提供方路由
    model: deepseek-v4-flash      # 模型 id
```

- 默认走 DeepSeek 官方，可选 `deepseek-v4-flash`（快、省）或 `deepseek-v4-pro`（更强），改 `model` 即可。
- 换其他提供方时，把 `provider`、`model` 一并改成该适配器注册的路由与模型 id（宿主须已注册对应适配器）。
- 调用模型需要 API Key：DeepSeek 官方适配器读环境变量 `DEEPSEEK_API_KEY`。

## 前置依赖：Obsidian MCP

1. 在 Obsidian 中安装社区插件 **Local REST API**，开启并生成 API Key。
2. 安装 Python 与 [uv](https://docs.astral.sh/uv/)（提供 `uvx` 命令）。
3. 将 API Key 写入环境变量 `OBSIDIAN_API_KEY`（组装文件中已引用；也可改为字面量）。

启动后 Obsidian 工具以 `mcp__obsidian__*` 形式出现（如搜索、读取文件、写入内容）。连接失败不会中断宿主启动，只是工具不出现并记录错误。

## 知识库（Obsidian 笔记库）

知识库模板在 `../vault-template/`：

```
vault/
├─ 心理问题/       # ★ 现代人心理问题汇总（六大板块选题总表）+ 单题笔记
├─ 儒释道典籍/     # 儒家（论语/孟子/大学/中庸）、道家（道德经/庄子）、佛家（心经/金刚经/六祖坛经）
├─ 时事/           # 现实锚点，持续补充；目录不足时智能体联网检索
└─ 治愈文案/       # 成稿归档（用户确认后保存）
```

时事条目目前只有格式示例，后续补充；在那之前智能体会用网页检索查找近期真实素材。

## 使用示例

- 我最近工作压力很大，总觉得自己不够好，想写一段发朋友圈的文字，温柔一点的。
- 从心理问题总表里随机抽一条，给我写三条不同角度的短文。
- 结合最近的节气，写一篇关于「群体性孤独」的公众号长文。

流程：定位/抽取心理问题 → 取典籍原文 → 定时事锚点 → 三重印证 → 成稿（标题 + 正文 + 供核对的出处）。

## 安全边界

涉及自伤、自杀等危机信号时，不产出安抚性文案，停止创作流程，温和引导寻求专业心理援助（全国心理援助热线 12356）。
