# 草屋衡几·治愈文案师 Worker

草屋页面「自媒体文案输出」区域的后端。GitHub Pages 放不了密钥，由这个 Worker 保管：
查近期时事（Tavily）→ 组装内置知识库（心理问题总表 + 儒释道典籍）→ 调 DeepSeek 出稿。

## 一次性配置

```bash
npm i -g wrangler
wrangler login

# 两个密钥（DeepSeek 平台、Tavily 平台各申请一个）
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put TAVILY_API_KEY
```

- DeepSeek：https://platform.deepseek.com
- Tavily（时事搜索，免费额度 1000 次/月）：https://tavily.com

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入两个密钥
wrangler dev
```

另在仓库根目录 `python3 -m http.server 8000` 打开草屋页面即可联调
（CORS 已放行 http://localhost 任意端口）。

## 部署

```bash
wrangler deploy
```

得到地址形如 `https://caowu-healing.<account>.workers.dev`，
回填到 `../scripts/hengji.js` 的 `HEALING_API`，再随静态站一起 push。

## 接口

`POST /`

```json
{ "brief": "写给都市人的自我苛责短文，温柔一点" }
```

```json
{
  "copy": "成稿……",
  "sources": { "news": [ { "title": "...", "url": "...", "published": "...", "snippet": "..." } ] }
}
```

## 更新知识库

知识库内容来自 `../agent/vault-template/`（独立仓库）。增改心理问题或典籍笔记后：

```bash
python3 ../scripts/sync-knowledge.py
wrangler deploy
```

## 成本与防刷

接口开放、无口令。Tavily 免费 1000 次/月，DeepSeek 按量付费。
若日后被刷，在 Cloudflare 控制台为本 Worker 加一条速率限制规则即可，无需改代码。
