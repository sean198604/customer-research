# 客户背景调研工具 (Customer Research)

外贸客户背景调研提示词生成工具，帮助快速生成针对性的客户调研指令。

## 技术栈

- **前端**: 原生 HTML/CSS/JS
- **部署**: Docker + Nginx
- **端口**: 7004

## 功能

- 🔎 **调研提示词生成** — 输入客户信息，自动生成结构化调研 Prompt
- 📝 **多维度调研** — 公司背景、产品线、市场定位、竞争对手等
- 📋 **一键复制** — 生成的 Prompt 可直接粘贴到 AI 工具中使用
- 🎨 **EGO 品牌主题** — 深蓝渐变风格

## 目录结构

```
├── customer-research.html   # 主页面
├── favicon.ico              # 网站图标
├── Dockerfile
└── docker-compose.yml
```

## 快速启动

```bash
docker-compose up -d
```

访问 `http://192.168.1.246:7004`
