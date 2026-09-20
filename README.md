# 客户背景调研工具 (Customer Research)

展会拓客场景下，把名片拍照上传 → OCR 自动识别 → 一键 AI 调研出结构化报告 → 沉淀进客户库批量管理。

## 使用场景

1. 展会上收到客户名片，手机拍照上传
2. 系统 OCR 识别（视觉模型 / 本地 Tesseract 兜底），自动填好姓名、公司、电话、邮箱等
3. 在可编辑表单中**核对并修正客户名**等关键字段
4. 点「开始 AI 调研」：搜索公开资料 + DeepSeek 生成 10 维度结构化报告（含匹配度、图片、视频）
5. 报告自动存入**客户库**，支持筛选、状态流转、批量导出 CSV / Excel / JSON

## 技术栈

- **前端**：原生 HTML / CSS / JS（Liquid Glass 设计系统，零构建）
- **后端**：FastAPI（OCR + 搜索富集 + DeepSeek 调研 + SQLite 存储）
- **部署**：Docker + docker-compose，端口 7004

## 目录结构

```
├── app.py                 # FastAPI 后端（API + 静态托管）
├── static/
│   ├── index.html         # 页面骨架（侧栏 + 顶栏 + 视图容器）
│   ├── styles.css         # Liquid Glass 样式（EGO 统一设计系统）
│   ├── app.js             # 前端逻辑（OCR / 调研 / 客户库）
│   └── favicon.ico
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── .env.example           # 环境变量示例（复制为 .env 后填 key）
```

## 配置（.env）

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | **必填**，DeepSeek 文本调研 |
| `VISION_API_KEY` / `VISION_BASE_URL` / `VISION_MODEL` | 选填，名片 OCR 视觉模型（任意 OpenAI 兼容接口）；不填则回退本地 Tesseract |
| `SERPER_API_KEY` | 选填，搜索源；填了调研报告会带真实图片/视频且数据更新 |

> 不填任何 key 也能跑：OCR 用本地 Tesseract，客户库/导出正常；调研需配置 `DEEPSEEK_API_KEY` 后使用。

## 快速启动

```bash
cp .env.example .env      # 按需填入 API key
docker-compose up -d --build
```

访问 `http://192.168.1.246:7004`

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ocr` | 名片图片 → 结构化字段 |
| POST | `/api/research` | 客户信息 → 调研报告（JSON + 图片/视频） |
| GET | `/api/customers` | 客户列表（支持 q / status / country 过滤） |
| GET | `/api/customers/{id}` | 客户详情 |
| POST/PUT | `/api/customers[/id]` | 新建 / 更新 |
| DELETE | `/api/customers/{id}` | 删除 |
| GET | `/api/export?format=csv\|excel\|json` | 批量导出 |
| GET | `/api/health` | 健康检查（显示各 key 状态） |
