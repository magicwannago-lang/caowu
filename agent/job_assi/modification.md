# JobAgent招聘投递Agent 交付说明
## 文件清单
1. jobagent_v2_api.html 【前端页面，嵌入caowu页面】
2. main.py FastAPI后端骨架
3. modification.md 本说明文档

## 变更点（对比旧版localStorage版本 jobagent.html）
1. 完全移除localStorage本地持久化；全部配置、简历、岗位队列、投递日志存储后端。
2. 前端只做UI展示、人机交互、人工批复；业务计算、LLM调用、Cookie存储、爬虫、投递全部交给后端。
3. 页面初始化调用`initLoad()`拉取后端全部状态；每次操作完成调用`refreshPageData()`刷新页面状态。
4. Cookie、API密钥不会返回前端，前端仅提交，后端加密存储。
5. 保留全部UI样式、Tab布局、交互逻辑不变。

## 部署运行
### 安装依赖
```bash
pip install fastapi uvicorn pydantic
