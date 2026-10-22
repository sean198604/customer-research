# 名片宝（Customer Research）· 项目结构说明

> 面向研发/运维/交接人员的项目结构与技术架构说明文档。  
> 项目定位、部署信息与归档资料见 `PROJECT-REGISTRATION.md`；部署与运维操作见 `README.md`。

---

## 1. 项目概览

**名片宝** 是一个面向外贸展会拓客场景的客户背景调研工具。核心链路：

```
拍照上传名片 → OCR 识别 → 人工校正基本信息 → 搜索富集 + DeepSeek 调研 → 结构化报告 → 入库批量管理/导出
```

**技术形态**：单容器全栈应用。FastAPI（Python）同时提供 REST API 与托管静态前端，SQLite 持久化，Docker Compose 部署，对外暴露 7004 端口。

| 项 | 说明 |
|---|---|
| 后端 | Python 3.12-slim + FastAPI + Uvicorn（容器内 8000 端口） |
| 前端 | 原生 HTML/CSS/JS 单页应用（无构建步骤），遵循 Product Flow UI 规范（深海蓝企业后台风格） |
| 存储 | SQLite（`data/customer_research.db`）；名片原图存 `data/uploads/` |
| 部署 | Docker Compose，服务/容器名 `customer-research-7004`，宿主 7004 → 容器 8000（uvicorn） |
| 外部依赖 | DeepSeek（文本生成）、视觉模型（OCR，可选）、搜索源（Serper/Brave/Tavily/DuckDuckGo） |

---

## 2. 目录结构

```text
customer-research/
├── app.py                     # FastAPI 后端（唯一后端入口，含全部 API 与业务逻辑）
├── requirements.txt           # Python 依赖清单
├── Dockerfile                 # 镜像构建（Python 3.12-slim + Tesseract + 依赖）
├── docker-compose.yml         # 编排：服务 customer-research-7004，端口 7004:8000，命名卷 cr_data
├── .env                       # 运行时密钥（不入库，已被 .gitignore 屏蔽）
├── .env.example               # 环境变量模板（含各 Key 填写说明）
├── .gitignore                 # 忽略 .env / data/ / *.log / __pycache__ 等
├── README.md                  # 部署与运维说明
├── PROJECT-REGISTRATION.md    # 项目登记归档资料（按规范模板，Key 已掩码）
├── PROJECT-STRUCTURE.md       # 本文件：项目结构说明
├── customer-research.html     # 早期纯静态原型（保留，非当前运行版本）
├── favicon.ico                # 站点图标（放大镜）
├── static/                    # 前端静态资源（由 FastAPI 挂载 /static）
│   ├── index.html             # 页面骨架：侧栏 + 顶栏 + 各视图容器
│   ├── styles.css             # 设计令牌 + 组件样式（含移动端适配）
│   ├── app.js                 # 前端逻辑：路由、上传、调研、报告渲染、客户库、设置
│   └── favicon.ico            # 图标副本
├── screenshots/               # 归档用真实功能截图
│   ├── screenshot-entry.png
│   ├── screenshot-library.png
│   └── screenshot-settings.png
└── data/                      # 运行时数据（容器内，经命名卷 cr_data 持久化，不入库）
    ├── customer_research.db   # SQLite 数据库
    └── uploads/               # 名片原图
```

---

## 3. 系统架构

```text
┌─────────────────────────── 浏览器（PC / 移动端）───────────────────────────┐
│  static/index.html + styles.css + app.js   （原生 SPA，单页多视图）        │
│  视图：名片宝（录入调研） | 客户库 | 设置                                  │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ HTTP (JSON / multipart)
┌───────────────────────────────▼───────────────────────────────────────────┐
│                        FastAPI（app.py，uvicorn）                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐  │
│  │ OCR 服务     │  │ 搜索富集      │  │ DeepSeek 调研  │  │ 存储 / 导出    │  │
│  │ 视觉模型优先 │  │ 多源路由      │  │ 10 维度报告    │  │ SQLite + CSV  │  │
│  │ Tesseract兜底│  │ 文本+图+视频  │  │ JSON 结构化    │  │ Excel / JSON  │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  └───────┬───────┘  │
│         │                │                  │                  │          │
│  config.json（设置页持久化）← reload_config() 运行时热更新                 │
└─────────┼────────────────┼──────────────────┼──────────────────┼──────────┘
          ▼                ▼                  ▼                  ▼
   视觉模型 API      搜索源 API        DeepSeek API      SQLite / 本地磁盘
 (qwen/kimi/ollama  (serper/brave/   (deepseek-chat)   data/customer_
  /openai)           tavily/ddg)                        research.db
```

**关键设计**：单进程单容器承载前后端；配置（密钥/Provider）支持**运行时热更新**，设置页改 Key 即时生效，无需重建镜像。

---

## 4. 数据流

> **三个独立功能**：① 存名片 ② OCR ③ 调研。三者解耦——OCR 的前提是已存名片；调研既可带名片，也可只输入客户名称。调研结果与名片通过 `customers.card_id` 关联。

### 4.1 主链路：名片 → 报告 → 入库

```text
【① 存名片】用户拍照/选图
   │  POST /api/cards (multipart: file)
   ▼
   保存原图 → data/uploads/<user_id>/<md5>.<ext>（按账号分目录）
   写入 cards 表（owner_id / filename / …），返回名片记录
   │
   ▼ 前端加入「名片夹」；选中名片
   │  POST /api/cards/{id}/ocr      ← 【② OCR】前提是已有名片
   ▼
   视觉模型 call_vision()（qwen/kimi/ollama/openai）
     解析失败或无 Key → 回退本地 Tesseract ocr_with_tesseract()
     → parse_card_text() 正则抽取字段
   回填 cards.ocr_json，返回 { fields, warn }
   │
   ▼ 前端渲染到可编辑表单（客户名可人工校正）
   │  POST /api/research (JSON: ResearchIn，可带 card_id)   ← 【③ 调研】
   ▼
   配额校验（每账号每日上限）→ 写入 research_jobs（status=queued），立即返回 job_id
   │      ↓ 后台工作线程池（并发 = RESEARCH_CONCURRENCY，默认 2）FIFO 领取任务
   │  call_search() 按 SEARCH_PROVIDER 路由 → 统一 { text, images, videos }
   │  build_research_messages() 拼装提示词（含搜索结果）
   │  call_chat() 调 DeepSeek，json_mode → normalize_report() 规范化为 10 板块
   │  写入 customers 表（含 report_json/images_json/videos_json + card_id 关联）
   │  更新 research_jobs → done（result_json 内含 customer_id）
   ▼
   │  GET /api/research/jobs/{job_id} 轮询（queued→running→done/error）
   ▼
前端渲染报告：摘要 + 匹配度 + 10 个可折叠板块 + 图片墙 + 视频卡
```

**为什么用队列**：调研会同时打搜索源与大模型 API，若用户集中提交会瞬时打爆额度/限流。改为「先入队、按并发上限顺序执行」，并发上限由 `RESEARCH_CONCURRENCY` 控制（默认 2），并对每账号做每日配额（`DAILY_RESEARCH_QUOTA`，默认 10）。任务表持久化在 `research_jobs`，重启后未完成任务会自动重新排队。

### 4.2 报告结构（10 个固定板块）

在 `app.py` 中以 `SECTION_TITLES` / `SECTION_ICONS` 定义：

| # | 板块 | 图标 |
|---|---|---|
| 1 | 公司基本资料 | 🏢 |
| 2 | 销售渠道与市场布局 | 🛒 |
| 3 | 采购品类与采购风格 | 📦 |
| 4 | 价格定位与价格带 | 💰 |
| 5 | 供应链模式 | 🔗 |
| 6 | 终端客户群体 | 👥 |
| 7 | 竞争格局 | ⚔️ |
| 8 | 近期动态 | 📰 |
| 9 | 合作匹配度评估 | 🎯 |
| 10 | 信息可靠性说明 | 📌 |

### 4.3 搜索源路由（`call_search`）

按 `SEARCH_PROVIDER` 环境变量分发，各源统一输出 `{text, images, videos}`：

| Provider | 函数 | 是否需 Key | 是否含图片/视频 |
|---|---|---|---|
| `serper` | `_search_serper` | ✅ | ✅ search + /images + /videos 三端点合并 |
| `brave` | `_search_brave` | ✅ | 文本为主 |
| `tavily` | `_search_tavily` | ✅ | 文本为主 |
| `ddg`（默认） | `_search_ddg` | ❌ 免 Key | 仅文本 |

### 4.4 视觉 OCR 路由（`_vision_defaults`）

按 `VISION_PROVIDER` 自动设定 BASE_URL 与 MODEL，用户只需填 Key：

| Provider | BASE_URL | MODEL |
|---|---|---|
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| `kimi` | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| `ollama` | `http://host.docker.internal:11434/v1` | `llama3.2-vision` |
| `openai`（默认） | `https://api.openai.com/v1` | `gpt-4o-mini` |

---

## 5. API 接口清单

### 5.1 账号 / 鉴权

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 公开 | 注册新用户（默认角色 `user`），成功即返回 token 并登录 |
| POST | `/api/auth/login` | 公开 | 登录，返回 token + 用户信息 |
| POST | `/api/auth/logout` | 登录 | 注销，删除当前会话 |
| GET | `/api/auth/me` | 登录 | 读取当前登录用户 |
| PUT | `/api/auth/profile` | 登录 | 修改自己的显示名/邮箱/密码 |

### 5.2 账户管理（仅管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users` | 新建用户（可指定角色） |
| PUT | `/api/admin/users/{uid}` | 修改用户（角色/启用/重置密码） |
| DELETE | `/api/admin/users/{uid}` | 删除用户（连带清理其会话） |
| GET | `/api/admin/stats` | 概览统计（用户数、启用数、管理员数、客户数） |

### 5.3 业务 / 系统

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/` | 公开 | 返回前端页面 `static/index.html` |
| GET | `/static/*` | 公开 | 静态资源（CSS/JS/图标） |
| GET | `/uploads/*` | 公开 | 名片原图访问（含 `/<user_id>/` 子目录） |
| POST | `/api/cards` | 登录 | **存名片**（multipart `file`）→ 落盘 `uploads/<uid>/` + 入库，返回名片记录 |
| GET | `/api/cards` | 登录 | 名片列表；普通用户仅自己，管理员 `scope=all` 看全部；每条附带关联客户 |
| GET | `/api/cards/{id}` | 登录 | 单张名片详情（owner 校验） |
| DELETE | `/api/cards/{id}` | 登录 | 删除名片（连带删原图、解除客户关联） |
| POST | `/api/cards/{id}/ocr` | 登录 | **OCR**（前提是有名片）→ 回填字段，写入 `cards.ocr_json` |
| POST | `/api/research` | 登录 | **提交调研任务**（可带 `card_id`）→ 入队，返回 `job_id` / `position` / `quota` |
| GET | `/api/research/jobs` | 登录 | 我的调研任务列表（`active=1` 仅进行中） |
| GET | `/api/research/jobs/{jid}` | 登录 | 单任务状态（queued/running/done/error）；排队时含 `position`；完成后含 `result` |
| GET | `/api/quota` | 登录 | 今日调研配额 `{date,limit,used,remaining}` |
| GET | `/api/customers` | 登录 | 客户列表；管理员默认全部（`scope=mine` 仅自己），普通用户仅自己 |
| GET | `/api/customers/{cid}` | 登录 | 单个客户详情（owner 校验） |
| POST | `/api/customers` | 登录 | 新建客户（自动记录 owner_id / card_id） |
| PUT | `/api/customers/{cid}` | 登录 | **局部更新**：只更新请求中显式传入的字段（避免误清空报告/关联） |
| DELETE | `/api/customers/{cid}` | 登录 | 删除客户（owner 校验） |
| GET | `/api/export` | 登录 | 批量导出 `csv\|excel\|json`，按角色自动限定数据范围 |
| GET | `/api/health` | 公开 | 健康检查 + 配置状态（含并发数/配额） |
| GET | `/api/config` | **管理员** | 读取 API 配置（Key 掩码）+ 并发/配额 |
| PUT | `/api/config` | **管理员** | 写入 API 配置，落盘 `config.json` 并热更新 |

> 鉴权方式：请求头 `Authorization: Bearer <token>`。Token 为服务端随机会话串，存 `sessions` 表，默认有效期 14 天，可被管理员禁用账号或删除会话即时失效。
> `/api/ocr`（旧的一体化上传+识别接口）已停用，返回 410，请改用「先存名片再 OCR」的卡片接口。

---

## 6. 数据模型

### 6.1 `customers` 表（SQLite）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增主键 |
| `contact_name` | TEXT | 联系人姓名 |
| `title` | TEXT | 职位 |
| `company` | TEXT | 客户 / 公司名称 |
| `country` | TEXT | 国家 / 地区 |
| `phone` | TEXT | 电话 |
| `email` | TEXT | 邮箱 |
| `website` | TEXT | 网站 |
| `address` | TEXT | 地址 |
| `category` | TEXT | 产品品类 |
| `tags` | TEXT | 标签（逗号分隔） |
| `notes` | TEXT | 展会/展位/补充线索 |
| `status` | TEXT | 状态：`new` → `researched` → `contacted` → `deal` |
| `source` | TEXT | 来源 |
| `card_image` | TEXT | 名片原图文件名 |
| `report_json` | TEXT(JSON) | 调研报告（10 板块结构化） |
| `images_json` | TEXT(JSON) | 图片墙 URL 列表 |
| `videos_json` | TEXT(JSON) | 视频卡列表 |
| `match_score` | TEXT | 合作匹配度（高 / 中 / 低） |
| `owner_id` | INTEGER | 归属用户（`users.id`），用于数据隔离 |
| `card_id` | INTEGER | 关联名片（`cards.id`），调研结果与名片由此建立关联 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 更新时间 |

> `report_json / images_json / videos_json` 以字符串存储，读取时由 `row_to_dict()` 反序列化为对象。
> `source` 取值：`manual`（直接输入名称调研）/ `card`（由名片发起）/ 旧数据 `ocr`。

### 6.2 `cards` 表（名片 · 独立实体）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增主键（前端展示为 `CR-0001`） |
| `owner_id` | INTEGER | 归属用户（按账号分开存储） |
| `filename` | TEXT | 相对路径，形如 `<user_id>/<md5>.<ext>` |
| `original_name` | TEXT | 上传时的原始文件名 |
| `mime` | TEXT | MIME 类型 |
| `size` | INTEGER | 字节数 |
| `ocr_json` | TEXT | OCR 结果（JSON 字符串），可为空 |
| `created_at` | TEXT | 创建时间 |

> 名片实体与调研解耦：可只存名片不做调研；OCR 依赖已保存的名片；调研可携带 `card_id`。

### 6.3 `research_jobs` 表（调研任务队列）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 任务 ID（前端用于轮询） |
| `owner_id` | INTEGER | 提交用户（每日配额按此统计） |
| `card_id` | INTEGER | 关联名片（可空 = 直接输入名称调研） |
| `status` | TEXT | `queued` / `running` / `done` / `error` |
| `payload_json` | TEXT | 调研入参快照（ResearchIn） |
| `result_json` | TEXT | 完成结果（report / images / videos / customer_id） |
| `error` | TEXT | 失败原因 |
| `created_at` / `started_at` / `finished_at` | TEXT | 时间戳 |

> 队列由 `start_workers()` 启动的 `RESEARCH_CONCURRENCY` 个工作线程消费（FIFO，按 `id` 升序）；`queued→running` 的领取用全局锁保证不重复。重启时把遗留的 `queued/running` 复位为 `queued` 重新排队。

### 6.4 `users` 表（账号）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增主键 |
| `username` | TEXT UNIQUE | 登录名（3–32 位字母/数字/`_@.-`） |
| `display_name` | TEXT | 显示名称 |
| `email` | TEXT | 邮箱（选填） |
| `password_hash` | TEXT | scrypt 哈希，格式 `scrypt$<salt>$<hash>`（标准库，无外部依赖） |
| `role` | TEXT | 角色：`admin`（管理员）/ `user`（普通用户） |
| `active` | INTEGER | 1 启用 / 0 禁用 |
| `created_at` / `last_login` | TEXT | 创建时间 / 最近登录 |

### 6.5 `sessions` 表（会话）

| 字段 | 类型 | 说明 |
|---|---|---|
| `token` | TEXT PK | 随机会话串（登录后下发） |
| `user_id` | INTEGER | 所属用户 |
| `created_at` | TEXT | 创建时间 |
| `expires_at` | REAL | 过期时间戳（默认 14 天） |

### 6.6 权限模型

| 能力 | 管理员 admin | 普通用户 user |
|---|---|---|
| 注册 / 登录 | ✅ | ✅（注册后即为普通用户） |
| 存名片 / OCR / 调研 / 建客户 | ✅ | ✅ |
| 名片夹可见范围 | 自己的（`scope=all` 可看全部） | **仅自己** |
| 客户数据可见范围 | **全部**（可切 `scope=mine`） | **仅自己** |
| 账户管理（用户增删改/角色） | ✅ | ❌ |
| API Key / 并发 / 配额配置 | ✅ | ❌ |

> 首个管理员：首次启动若 `users` 表为空，自动按 `DEFAULT_ADMIN_USER/PASS`（默认用户名 `admin`，密码取 `.env` 配置值）创建。后续可在「账户管理」中新增管理员或调整角色。系统强制「至少保留一名启用状态的管理员」。

### 6.7 配置存储（双源，优先级：`config.json` > `.env`）

`reload_config()` 的加载顺序：
1. 先读环境变量（`.env` 经 Compose 注入容器）；
2. 再用 `config.json`（设置页写入）覆盖（读取时键名统一转大写后合并）。

涉及项：`DEEPSEEK_API_KEY / _BASE_URL / _MODEL`、`VISION_PROVIDER / _API_KEY / _BASE_URL / _MODEL`、`SEARCH_PROVIDER`、`SERPER_API_KEY`、`BRAVE_API_KEY`、`TAVILY_API_KEY`，以及队列参数 `RESEARCH_CONCURRENCY`（并发，默认 2）、`DAILY_RESEARCH_QUOTA`（每账号每日调研上限，默认 10，0=不限）。

**安全**：所有 Key 仅存于服务端（`.env` 与 `config.json`），`/api/config` 读取时一律以 `••••••••` 掩码返回，前端不落任何明文。

---

## 7. 前端结构

### 7.1 页面骨架（`static/index.html`）

- **左侧侧栏**：品牌头（客户调研中心 / CUSTOMER RESEARCH）+ 导航（名片宝 / 客户库；管理员额外显示「账户管理」「API 设置」）+ 右上角骑线圆形折叠钮 + 底部**当前登录用户区**（头像/名称/角色 + 退出按钮）；移动端转为抽屉（汉堡按钮 + 遮罩，折叠钮隐藏）。
- **顶栏**：标题 `#tb-title`（靠左）+ 副标题 `#tb-sub` + 操作区 `#tb-actions`（**右上角常驻「?」应用说明按钮** `#helpBtn`）。
- **应用说明弹层** `#helpPop`：点击右上角 `?` 弹出，再点关闭（也支持点击外部 / Esc 关闭），含 5 步使用说明。
- **内容区**：四个视图容器——
  - `#view-entry`：名片宝录入工作台（**单行三步流程条** + **名片夹**（上传即存、缩略图列表、删/选）+ 可编辑表单 + OCR 重试 + 调研按钮 + 配额提示 + 调研报告）
  - `#view-library`：客户库（统计条 + 搜索/筛选 + **卡片视图/列表视图切换** + 导出下拉；管理员多一个数据范围筛选）
  - `#view-settings`：API 设置（仅管理员，嵌入在账户管理页与独立视图两处复用）
  - `#view-admin`：账户管理（仅管理员：统计卡 + 用户表 + API 配置）
- **登录门** `#authGate`（`.is-open` 控制显隐）：未登录时全屏覆盖，桌面为「深蓝品牌区 + 表单区」左右分栏，移动端为深蓝页头 + 单列表单；含登录/注册切换、行内错误提示与提交中状态。
- **客户档案抽屉** `#lightbox-host` 内 `.profile`：三标签页（客户档案 / 调研报告 / 媒体资料），由 `viewCustomer(id)` 渲染。
- 全局：`#toast` 提示、`#lightbox-host` 灯箱/弹窗挂载点。

### 7.2 前端逻辑（`static/app.js`）

| 函数 | 职责 |
|---|---|
| `boot()` | 启动：有 token 则校验并进入，否则显示登录门 |
| `switchAuth()` / `doLogin()` / `doRegister()` / `doLogout()` | 登录/注册/退出；token 存 localStorage |
| `applyRoleUI()` / `renderSidebarUser()` | 按角色显示/隐藏管理入口，渲染侧栏用户区 |
| `toggleHelp()` / `renderHelpBtn()` | 右上角「应用说明」弹层开关；视图切换后重建按钮 |
| `go(view)` | 视图路由切换（含管理员视图的权限兜底） |
| `renderEntry()` | 渲染名片宝录入视图（单行步骤条 + 名片夹 + 表单 + 配额） |
| `loadCards()` / `cardChip()` / `selectCard(id)` / `delCard(id)` | 名片夹：列出/渲染/选中（回填 OCR）/删除本账号名片 |
| `handleFile(f)` | 上传名片 → `POST /api/cards`（存到本账号）→ 自动 `runOcr()` |
| `runOcr()` / `fillFormFromFields(f2)` | 对已选名片调 `POST /api/cards/{id}/ocr` → 回填表单 |
| `doResearch()` / `pollJob(jobId)` | 提交调研任务 → 轮询 `GET /api/research/jobs/{id}`（排队位置/执行中/完成） |
| `loadQuota()` | 读取 `GET /api/quota` 渲染「今日调研配额」提示 |
| `renderReport()` / `renderReportHTML()` / `rptToggleAll()` | 报告渲染（摘要 hero + 维度计数 + 全部展开/折叠 + 空维度标记） |
| `renderLibrary()` / `loadLib()` / `renderLibStats()` | 客户库：统计条 + 卡片/列表视图渲染 |
| `libCardHTML()` / `custCard()` | **客户档案卡片**（头像 + 结构化字段 + 标签 + 匹配度 + 报告状态） |
| `libTableHTML()` | 列表视图（表格） |
| `setLibView(v)` | 卡片/列表视图切换（localStorage 记忆） |
| `viewCustomer(id)` / `pfTab(t)` / `closeProfile()` | **客户档案抽屉**（三标签页 + 内联编辑 + 状态流转） |
| `profileFieldsHTML()` / `mediaHTML()` | 档案字段分组渲染 / 媒体墙 |
| `editCustomer()` / `saveCustomer()` | 档案内联编辑（PUT 局部更新，仅提交改动字段） |
| `renderAdmin()` / `loadUsers()` / `saveUser()` / `delUser()` | 账户管理（统计、用户 CRUD、角色与会话控制） |
| `renderSettingsInto()` / `saveSettings()` | API 配置读写（管理员，含并发/配额） |
| `mdToHtml()` | 报告 Markdown 轻量渲染 |
| `authHeaders()` / `api()` | 统一携带 `Authorization: Bearer`；401 自动回到登录门 |
| 灯箱 / toast | `lightbox()`、`toast()` 等交互工具 |

### 7.3 视觉规范

本项目已按公司 **Product Flow UI 规范**统一，不再使用毛玻璃与大面积渐变。

**设计令牌**

| 类别 | 取值 |
|---|---|
| 主色 | `#1a365d`（悬停 `#16345f`），浅底 `#eef3fa`，边框 `#ccdaeb` |
| 语义色 | 危险 `#b42318`（仅删除/驳回）、成功 `#087443`、风险/待确认 `#9a5b06` |
| 文本 | 主 `#0d1b2a` / 次 `#1c2d40` / 正文 `#35485e` / 弱 `#8496a9` |
| 面与线 | 页面底 `#f4f6f9`，卡片 `#fff`，次级面 `#f8fafc`，线 `#e3e8ef` |
| 尺寸 | 页头 **76px**（移动 68px）、侧栏 **236px**（收起 80px）、内容限宽 1440px |
| 圆角 | 6 / 8 / 10 / 12px |
| 动效 | 统一 `150ms ease-out`；按压缩放取消，仅位移 1px；支持 `prefers-reduced-motion` |

**字号规格**

| 用途 | 规格 |
|---|---|
| 页头模块标题 / 卡片标题 | 14px / 700 |
| 弹窗标题 | 16px / 700 |
| 正文、表格主数据 | 13–14px / 400–600 |
| 标准按钮 | 13px / 600 |
| 紧凑按钮、模块标签、表单标签 | 12px / 600 |
| 文件名、编号、时间等辅助信息 | 10–11px |

**控件规格**

- 按钮：`default 40px / sm 32px / icon 32px`；主按钮实心深蓝，次按钮白底灰蓝边框，危险操作为白底红字红边（不做大面积红底）。
- 标签页（登录页切换、客户档案抽屉）：32px 高、12px 字号、8px 圆角、深蓝选中态。
- 图标：侧栏与按钮统一 1.7px 描边线性 SVG，不再使用 emoji 作为功能图标（报告维度图标保留内容语义）。
- 焦点：统一蓝色轮廓，`outline` 不隐藏。

**侧栏折叠钮（SideToggle，对齐公司 UI 组件规范）**

> 规范以组件真源实现为唯一依据。

- 形态：**28 × 28 px 正圆**（`border-radius:50%`），白底 + `1px #e3e8ef` 描边 + `0 1px 3px rgba(13,27,42,.10)` 轻投影；禁止圆角方钮、禁止渐变/内阴影。
- 位置：`position:absolute; top:0; right:-15px; height:var(--header-h)` ⇒ **圆心正好压在侧栏右边线上**（侧栏含 1px 边框，故取 -15px，探出 14px），垂直居中于品牌行（cy = 38px，与 32px Logo 中心对齐）。
- 两态：展开 / 收起**坐标完全一致**，切换不位移；移动端（≤820px）隐藏，由左上角菜单按钮开合。
- 图标：`viewBox 0 0 24 24`，渲染 15px，`stroke-width 1.8`；图元 = 圆角面板 `rect(3,4,18,16,r3.4)` + 左栏分隔线 `M9.4 4v16` + 尖括号。展开态箭头指左 `M15.6 9.4L12.7 12l2.9 2.6`，收起态左右镜像指右 `M13.1 9.4L16 12l-2.9 2.6`；禁用 `|<` 类「缩进」语义图标与图标字体。
- 交互：hover 底变 `#eef3fa`、图标变 `#1a365d`、投影加深；`:focus-visible` 2px 浅蓝环；`aria-label` / `title` 随状态在「折叠侧栏 / 展开侧栏」间切换（`syncSideToggle()` 同步）。

| 展开态（局部放大） | 收起态（局部放大） |
| --- | --- |
| ![侧栏折叠钮展开态](screenshots/zoom-toggle-expanded.png) | ![侧栏折叠钮收起态](screenshots/zoom-toggle-collapsed.png) |

**页面结构**

- **登录页**：左侧 400px 深蓝品牌区（网格底纹 + 价值说明），右侧表单区；移动端转为深蓝页头 + 单列表单，支持行内错误提示与提交中禁用。
- **框架层**：白底侧栏 + 白底固定页头，细边框分隔，无磨砂。
- **数据层**：客户库卡片、档案抽屉、调研报告均为实心白卡；卡片网格 `repeat(auto-fill, minmax(300px,1fr))`，hover 仅变边框与阴影，不做位移。

**移动端专项**：侧栏抽屉（236px）、客户库自动单列、档案抽屉全屏、按钮 44px 触控高度、表单 16px 防 iOS 缩放、`env(safe-area-inset-*)` 刘海适配、工具栏分行不溢出（实测 360 / 390 / 768 三档无横向滚动）。

**打印**：`@media print` 隐藏侧栏/工具栏/标签页，报告单页导出 PDF。

---

## 8. 部署与运行结构

```yaml
# docker-compose.yml 核心结构
services:
  customer-research-7004:        # 服务名
    build: .
    container_name: customer-research-7004
    ports: ["7004:8000"]         # 宿主 7004 → 容器 8000（uvicorn）
    volumes: ["cr_data:/app/data"]  # 命名卷：数据库与上传图持久化
    env_file: .env
    restart: unless-stopped
volumes:
  cr_data:                       # 命名卷（非 bind mount）
```

| 操作 | 命令 |
|---|---|
| 启动 | `docker-compose up -d` |
| 重建（改代码后） | `docker-compose up -d --build` |
| 停止 | `docker-compose down` |
| 日志 | `docker logs customer-research-7004` |
| 健康检查 | `GET /api/health` |

**运行时数据**：`data/customer_research.db`（数据库）+ `data/uploads/`（名片原图），通过**命名卷 `cr_data`** 挂载至容器 `/app/data` 持久化，容器重建不丢数据（`docker volume` 管理）。

**环境变量分层**：
- `.env` → 初始默认值（Compose 注入）
- `config.json` → 设置页运行时覆盖（热更新，优先）
- 仅改 Key/Provider → 走设置页即可，**无需重建镜像**

---

## 9. 关键约束与注意事项

1. **Key 安全**：所有 API Key 仅存服务端，`.env` 与 `config.json` 均不入库（`.gitignore` 屏蔽），前端一律掩码显示。
2. **内网 http 部署**：非 HTTPS 环境下浏览器禁用 `navigator.clipboard`，复制类功能需走 `execCommand` 兜底。
3. **OCR 兜底**：未配置视觉 Key 时回退本地 Tesseract，识别偏弱，需人工校正（尤其客户名）。
4. **搜索能力差异**：`ddg` 免 Key 仅文本；配置 Serper 才有图片 + 视频媒体墙（`_search_serper` 三端点合并）。
5. **数据模型演进**：`report_json / images_json / videos_json` 为 JSON 文本列，若结构变更需兼容旧数据读取。
6. **单容器设计**：前后端同进程，改动 `app.py` 需重建镜像；仅改静态资源可 `docker cp` 热更。
7. **调研队列（重要）**：调研改为异步队列执行，前端轮询任务状态。并发上限 = `RESEARCH_CONCURRENCY`（默认 2），每账号每日上限 = `DAILY_RESEARCH_QUOTA`（默认 10，0=不限）。**必须单进程运行**（`uvicorn --workers 1`）——多 worker 会让并发上限翻倍且可能重复领取任务，故 Dockerfile 固定 `--workers 1`。
8. **并发数调整需重启**：`RESEARCH_CONCURRENCY` 在启动时决定工作线程数，设置页改后需重启容器生效；`DAILY_RESEARCH_QUOTA` 即时生效。
9. **内置 Tesseract**：镜像基于 `python:3.12-slim` 并预装 `tesseract-ocr(-chi-sim)`，作为无视觉 Key 时的兜底。
10. **PUT 语义**：`PUT /api/customers/{id}` 为**局部更新**（`exclude_unset`），只改传入字段——改状态/编辑档案不会清空报告或名片关联。

---

## 10. 相关文档

| 文档 | 内容 |
|---|---|
| `README.md` | 部署与运维操作说明（启停/更新/回滚/日志） |
| `PROJECT-REGISTRATION.md` | 项目登记归档资料（基础信息/部署记录/图片清单，Key 掩码） |
| `PROJECT-STRUCTURE.md` | 本文件：项目结构与技术架构 |
| `.env.example` | 环境变量模板与各 Key 免费获取说明 |
