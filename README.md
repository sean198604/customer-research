<div align="center">

# 名片宝 · Card Research Workspace

**名片拍照 → OCR 识别 → AI 客户调研 → 客户资产沉淀**

[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

</div>

名片宝面向展会拓客与销售线索整理：上传一张名片照片，系统完成 OCR、可编辑字段校正、公开信息搜索和 AI 结构化调研，并把结果沉淀到可筛选、可导出的客户库。

> 数据与密钥说明：本项目不会提交 API Key、数据库、客户原始资料或部署环境配置。公开搜索结果仅用于辅助研判，请自行复核重要商业信息。

## ✨ 核心能力

- **名片 OCR**：支持拍照或上传图片；可使用 OpenAI 兼容视觉模型，未配置时自动回退本地 Tesseract。
- **人工校正**：OCR 后可修正客户姓名、公司、电话、邮箱、网站、国家及品类等字段。
- **AI 客户调研**：结合公开搜索与 DeepSeek，生成公司资料、渠道、采购风格、供应链、竞争、近期动态、合作匹配度等 10 个维度的结构化报告。
- **媒体富集**：配置 Serper、Brave 或 Tavily 后，调研报告可展示相关图片和视频卡片；默认 DuckDuckGo 文本搜索无需 Key。
- **客户资产库**：支持新建、已调研、已联系、商机等状态流转，以及关键词、国家、状态筛选。
- **批量导出**：客户库可导出 CSV、Excel 或 JSON，便于后续 CRM 或业务分析使用。
- **账号与权限**：内置登录 / 注册，管理员与普通用户两级角色，客户数据按账号隔离；管理员可在「账户管理」中增删用户、调整角色，并在「API 设置」页在线配置密钥（即时生效，无需重启）。

## 🖼️ 项目截图

<p align="center">
  <img src="screenshots/ui-library-desktop.png" alt="名片宝客户库 · 卡片视图" width="92%" />
</p>

<p align="center">
  <img src="screenshots/ui-login-mobile.png" alt="名片宝手机端 · 登录" width="23%" />
  <img src="screenshots/ui-entry-mobile.png" alt="名片宝手机端 · 名片录入" width="23%" />
  <img src="screenshots/ui-library-mobile.png" alt="名片宝手机端 · 客户库" width="23%" />
</p>

<p align="center"><sub>桌面端客户库（卡片视图） · 手机端 登录 / 名片录入 / 客户库</sub></p>

<details>
<summary><b>展开查看全部 20 张界面截图（桌面端 · 手机端 · 小屏适配 · 侧栏折叠）</b></summary>

### 桌面端 · 名片录入

![名片录入工作台](screenshots/ui-entry-desktop.png)

### 桌面端 · 登录与注册

![登录](screenshots/ui-login-desktop.png)

### 桌面端 · 客户库

| 卡片视图 | 表格视图 |
| --- | --- |
| ![客户库卡片视图](screenshots/ui-library-desktop.png) | ![客户库表格视图](screenshots/ui-table-desktop.png) |

### 桌面端 · 客户档案与账户管理

| 客户档案抽屉 | 账户管理与 API 密钥 |
| --- | --- |
| ![客户档案](screenshots/ui-profile-desktop.png) | ![账户管理](screenshots/ui-admin-desktop.png) |

### 桌面端 · API 设置与应用说明

| API 设置 | 应用说明浮层 |
| --- | --- |
| ![API 设置](screenshots/ui-settings-desktop.png) | ![应用说明](screenshots/ui-help-desktop.png) |

### 手机端 · 登录与注册

| 登录 | 注册 | 登录失败提示 |
| --- | --- | --- |
| ![手机端登录](screenshots/ui-login-mobile.png) | ![手机端注册](screenshots/ui-register-mobile.png) | ![登录失败提示](screenshots/ui-login-error.png) |

### 手机端 · 名片录入与客户库

| 名片录入 | 客户库 | 客户档案 |
| --- | --- | --- |
| ![手机端名片录入](screenshots/ui-entry-mobile.png) | ![手机端客户库](screenshots/ui-library-mobile.png) | ![手机端客户档案](screenshots/ui-profile-mobile.png) |

### 小屏适配（360 / 768 宽度）

| 360 · 名片录入 | 360 · 注册 | 360 · 客户库 | 768 · 名片录入 |
| --- | --- | --- | --- |
| ![360 名片录入](screenshots/ui-entry-360.png) | ![360 注册](screenshots/ui-register-360.png) | ![360 客户库](screenshots/ui-library-360.png) | ![768 名片录入](screenshots/ui-entry-768.png) |

### 侧栏折叠钮（展开 / 收起）

| 展开态 | 收起态 |
| --- | --- |
| ![侧栏展开](screenshots/ui-toggle-expanded.png) | ![侧栏收起](screenshots/ui-toggle-collapsed.png) |

</details>

> 截图说明：API Key 已全部掩码为 `**********`，名片缩略图为空白占位，客户库仅展示 Miniso、Pepco、Home Bargains、Daiso、Action、Dollar Tree 等**公开示例企业**及其公开工商联系方式。

## 🚀 快速启动

### Docker Compose（推荐）

```bash
git clone https://github.com/sean198604/customer-research.git
cd customer-research
cp .env.example .env
# 在 .env 中按需填写 API Key
docker compose up -d --build
```

启动后访问：`http://localhost:7004`

查看服务状态：

```bash
docker compose ps
curl http://localhost:7004/api/health
```

### 本地开发

需要 Python 3.12+ 与本地 Tesseract（如需无 Key OCR 兜底）：

```bash
python -m venv .venv
# Windows：.venv\Scripts\activate
# macOS / Linux：source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 7004
```

## ⚙️ 配置

复制 `.env.example` 为 `.env` 后按需配置：

| 变量 | 是否必需 | 用途 |
| --- | --- | --- |
| `DEFAULT_ADMIN_USER` / `DEFAULT_ADMIN_PASS` | 部署时建议设置 | 首次启动创建的管理员账号；**请务必改成自己的强密码** |
| `SESSION_TTL` | 可选 | 登录会话有效期（秒），默认 14 天 |
| `RESEARCH_CONCURRENCY` | 可选 | 同时执行的调研任务数，默认 2（调小更省额度） |
| `DAILY_RESEARCH_QUOTA` | 可选 | 每个账号每日调研次数上限，默认 10；填 `0` 表示不限 |
| `DEEPSEEK_API_KEY` | AI 调研时必需 | 生成结构化客户背景报告 |
| `VISION_API_KEY` | 可选 | OpenAI 兼容视觉 OCR；为空时回退本地 Tesseract |
| `VISION_PROVIDER` | 可选 | `openai`、`qwen`、`kimi` 或 `ollama` |
| `SERPER_API_KEY` | 可选 | 丰富图片和视频检索结果 |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` | 可选 | 其他搜索服务 |

> `DEFAULT_ADMIN_PASS` 请只写在 `.env` 中。`.env.example` 已随公开仓库发布，**不要**把真实密码填进模板文件。

不要提交 `.env`、运行时 `config.json`、`data/` 或任何真实客户数据。它们已经在 `.gitignore` 中排除。

## 📡 API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/ocr` | 名片图片转结构化字段 |
| `POST` | `/api/research` | 客户信息生成调研报告 |
| `GET` | `/api/customers` | 客户列表，支持筛选 |
| `GET` | `/api/customers/{id}` | 客户详情 |
| `POST` / `PUT` | `/api/customers[/id]` | 新建或更新客户 |
| `DELETE` | `/api/customers/{id}` | 删除客户 |
| `GET` | `/api/export?format=csv\|excel\|json` | 批量导出 |
| `GET` | `/api/health` | 服务和依赖配置状态 |

## 🧱 技术栈

- **前端**：原生 HTML、CSS、JavaScript；响应式工作台界面。
- **后端**：FastAPI + Uvicorn。
- **OCR**：视觉模型优先，本地 Tesseract 兜底。
- **数据**：SQLite；Docker 默认使用命名卷持久化。
- **部署**：Docker 多阶段构建与 Docker Compose。

## 📁 目录结构

```text
├── app.py                 # FastAPI API、OCR、搜索与客户库逻辑
├── static/                # 前端页面、样式与交互脚本
├── screenshots/           # 已脱敏项目截图
├── requirements.txt       # Python 依赖
├── Dockerfile
├── docker-compose.yml
└── .env.example           # 不含真实凭据的环境变量模板
```

> 完整的架构设计、数据流、API 清单与数据模型见 **[PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md)**；项目登记归档资料见 [PROJECT-REGISTRATION.md](PROJECT-REGISTRATION.md)。

## ⚠️ 数据边界

- 公开搜索、AI 生成内容可能不完整或存在时效性问题，重要信息应回查原始来源。
- OCR 结果需要人工核对，尤其是姓名、邮箱、电话和公司名称。
- 本项目处理的客户信息应遵守适用的数据保护和业务合规要求。
