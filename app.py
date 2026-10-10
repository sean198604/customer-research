"""
客户背景调研工具 · 后端 (FastAPI)
- 账号系统（注册 / 登录 / 角色：admin | user）
- 名片 OCR（视觉模型 / Tesseract 兜底）
- 搜索富集（Serper，返回文本+图片+视频）
- DeepSeek 调研报告生成
- SQLite 存储 + 后台批量查询 / 导出
"""
import os
import io
import re
import json
import hmac
import time
import base64
import sqlite3
import hashlib
import secrets
import datetime
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any

import requests
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response, Header, Depends
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------- 配置 ----------------
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "customer_research.db"

DATA_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)

# 会话有效期（秒），默认 14 天
SESSION_TTL = int(os.getenv("SESSION_TTL", str(14 * 24 * 3600)))
# 首个管理员：首次启动若用户表为空，自动创建该管理员账号（可用环境变量覆盖）
DEFAULT_ADMIN_USER = os.getenv("DEFAULT_ADMIN_USER", "admin")
DEFAULT_ADMIN_PASS = os.getenv("DEFAULT_ADMIN_PASS", "admin123")

# ---------------- 配置（支持运行时热更新 / 设置页持久化）----------------
CONFIG_PATH = BASE_DIR / "config.json"

def _vision_defaults(provider):
    p = (provider or "openai").lower()
    if p == "qwen":
        return "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-vl-max"
    if p == "kimi":
        return "https://api.moonshot.cn/v1", "moonshot-v1-8k-vision-preview"
    if p == "ollama":
        return "http://host.docker.internal:11434/v1", "llama3.2-vision"
    return "https://api.openai.com/v1", "gpt-4o-mini"

def _read_config_file() -> Dict[str, Any]:
    """读取 config.json 并统一把键名转成大写，便于与 .env（大写）合并覆盖。"""
    if not CONFIG_PATH.exists():
        return {}
    try:
        raw = json.load(open(CONFIG_PATH, encoding="utf-8"))
    except Exception:
        return {}
    return {str(k).upper(): v for k, v in (raw or {}).items()}

def _as_int(v, default, lo=0, hi=10**9):
    try:
        n = int(float(v))
    except Exception:
        return default
    return max(lo, min(hi, n))

def reload_config():
    """优先读 .env（容器环境变量），再用 config.json（设置页写入）覆盖，实现运行时热更新。"""
    global DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
    global VISION_PROVIDER, VISION_API_KEY, VISION_BASE_URL, VISION_MODEL
    global SEARCH_PROVIDER, SERPER_API_KEY, BRAVE_API_KEY, TAVILY_API_KEY
    global RESEARCH_CONCURRENCY, DAILY_RESEARCH_QUOTA
    cfg = {
        "DEEPSEEK_API_KEY": os.getenv("DEEPSEEK_API_KEY", ""),
        "DEEPSEEK_BASE_URL": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        "DEEPSEEK_MODEL": os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        "VISION_PROVIDER": os.getenv("VISION_PROVIDER", "openai").lower(),
        "VISION_API_KEY": os.getenv("VISION_API_KEY", ""),
        "VISION_BASE_URL": os.getenv("VISION_BASE_URL", ""),
        "VISION_MODEL": os.getenv("VISION_MODEL", ""),
        "SEARCH_PROVIDER": os.getenv("SEARCH_PROVIDER", "ddg").lower(),
        "SERPER_API_KEY": os.getenv("SERPER_API_KEY", ""),
        "BRAVE_API_KEY": os.getenv("BRAVE_API_KEY", ""),
        "TAVILY_API_KEY": os.getenv("TAVILY_API_KEY", ""),
        # 调研队列：并发上限（默认 2）+ 每账号每日调研配额（默认 10，0 表示不限制）
        "RESEARCH_CONCURRENCY": os.getenv("RESEARCH_CONCURRENCY", "2"),
        "DAILY_RESEARCH_QUOTA": os.getenv("DAILY_RESEARCH_QUOTA", "10"),
    }
    cfg.update(_read_config_file())
    DEEPSEEK_API_KEY = cfg.get("DEEPSEEK_API_KEY", "")
    DEEPSEEK_BASE_URL = cfg.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
    DEEPSEEK_MODEL = cfg.get("DEEPSEEK_MODEL", "deepseek-chat")
    VISION_PROVIDER = (cfg.get("VISION_PROVIDER") or "openai").lower()
    VISION_API_KEY = cfg.get("VISION_API_KEY", "")
    if cfg.get("VISION_BASE_URL") and cfg.get("VISION_MODEL"):
        VISION_BASE_URL = cfg["VISION_BASE_URL"]; VISION_MODEL = cfg["VISION_MODEL"]
    else:
        VISION_BASE_URL, VISION_MODEL = _vision_defaults(VISION_PROVIDER)
    SEARCH_PROVIDER = (cfg.get("SEARCH_PROVIDER") or "ddg").lower()
    SERPER_API_KEY = cfg.get("SERPER_API_KEY", "")
    BRAVE_API_KEY = cfg.get("BRAVE_API_KEY", "")
    TAVILY_API_KEY = cfg.get("TAVILY_API_KEY", "")
    RESEARCH_CONCURRENCY = _as_int(cfg.get("RESEARCH_CONCURRENCY"), 2, lo=1, hi=16)
    DAILY_RESEARCH_QUOTA = _as_int(cfg.get("DAILY_RESEARCH_QUOTA"), 10, lo=0, hi=10**6)

reload_config()

SECTION_TITLES = [
    "公司基本资料", "销售渠道与市场布局", "采购品类与采购风格",
    "价格定位与价格带", "供应链模式", "终端客户群体",
    "竞争格局", "近期动态", "合作匹配度评估", "信息可靠性说明",
]
SECTION_ICONS = ["🏢", "🛒", "📦", "💰", "🔗", "👥", "⚔️", "📰", "🎯", "📌"]

# ---------------- 工具函数 ----------------
def now_iso():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

def save_upload(image_bytes: bytes, ext: str, user_id: int) -> str:
    """名片图片落盘到 uploads/<user_id>/，返回相对路径（含用户子目录），实现按用户分开存储。"""
    user_dir = UPLOAD_DIR / str(user_id)
    user_dir.mkdir(parents=True, exist_ok=True)
    h = hashlib.md5(image_bytes + str(time.time()).encode()).hexdigest()[:12]
    fname = f"{h}.{ext}"
    (user_dir / fname).write_bytes(image_bytes)
    return f"{user_id}/{fname}"

# ---------------- 数据库 ----------------
def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=20000")
    except Exception:
        pass
    return conn

def init_db():
    conn = get_db()
    conn.execute("""
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_name TEXT,
        title TEXT,
        company TEXT,
        country TEXT,
        phone TEXT,
        email TEXT,
        website TEXT,
        address TEXT,
        category TEXT,
        tags TEXT,
        notes TEXT,
        status TEXT DEFAULT 'new',
        source TEXT,
        card_image TEXT,
        report_json TEXT,
        images_json TEXT,
        videos_json TEXT,
        match_score TEXT,
        owner_id INTEGER,
        card_id INTEGER,
        created_at TEXT,
        updated_at TEXT
    )
    """)
    # 用户表
    conn.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        active INTEGER DEFAULT 1,
        created_at TEXT,
        last_login TEXT
    )
    """)
    # 会话表（Token 会话）
    conn.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT,
        expires_at REAL
    )
    """)
    # 名片表（名片为独立实体：先存名片，再 OCR，再调研）
    conn.execute("""
    CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER,
        filename TEXT,
        original_name TEXT,
        mime TEXT,
        size INTEGER,
        ocr_json TEXT,
        created_at TEXT
    )
    """)
    # 调研任务队列表（DB 持久化，重启不丢；用于排序/并发限流/每日配额统计）
    conn.execute("""
    CREATE TABLE IF NOT EXISTS research_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER,
        card_id INTEGER,
        status TEXT DEFAULT 'queued',
        payload_json TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT,
        started_at TEXT,
        finished_at TEXT
    )
    """)
    # 兼容旧库：补充缺失列
    ccols = [r["name"] for r in conn.execute("PRAGMA table_info(customers)").fetchall()]
    if "owner_id" not in ccols:
        conn.execute("ALTER TABLE customers ADD COLUMN owner_id INTEGER")
    if "card_id" not in ccols:
        conn.execute("ALTER TABLE customers ADD COLUMN card_id INTEGER")
    conn.commit()
    conn.close()

init_db()

def _cleanup_sessions():
    try:
        conn = get_db()
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
        conn.commit(); conn.close()
    except Exception:
        pass

# ---------------- 账号 / 鉴权 ----------------
def hash_password(password: str, salt: str = None) -> str:
    """scrypt 哈希（标准库，无外部依赖）。格式：scrypt$<salt>$<hash>"""
    salt = salt or secrets.token_hex(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"),
                        n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt}${dk.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt, _ = stored.split("$", 2)
        if algo != "scrypt":
            return False
        return hmac.compare_digest(hash_password(password, salt), stored)
    except Exception:
        return False

def ensure_default_admin():
    """用户表为空时，创建默认管理员（账号密码可用环境变量覆盖）。"""
    conn = get_db()
    n = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if n == 0:
        conn.execute(
            "INSERT INTO users (username, display_name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,?)",
            (DEFAULT_ADMIN_USER, "管理员", "", hash_password(DEFAULT_ADMIN_PASS), "admin", 1, now_iso()))
        conn.commit()
    conn.close()

def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn = get_db()
    conn.execute("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
                 (token, user_id, now_iso(), time.time() + SESSION_TTL))
    conn.commit(); conn.close()
    return token

def user_by_token(token: str):
    if not token:
        return None
    conn = get_db()
    row = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if not row:
        conn.close(); return None
    if row["expires_at"] and row["expires_at"] < time.time():
        conn.execute("DELETE FROM sessions WHERE token=?", (token,)); conn.commit(); conn.close()
        return None
    u = conn.execute("SELECT * FROM users WHERE id=?", (row["user_id"],)).fetchone()
    conn.close()
    if not u or not u["active"]:
        return None
    return dict(u)

def public_user(u: Dict) -> Dict:
    if not u:
        return None
    return {"id": u["id"], "username": u["username"], "display_name": u.get("display_name") or u["username"],
            "email": u.get("email") or "", "role": u.get("role") or "user", "active": u.get("active", 1),
            "created_at": u.get("created_at"), "last_login": u.get("last_login")}

def current_user(request: Request, authorization: Optional[str] = Header(None)):
    """从 Authorization: Bearer <token> 或 cookie 解析当前登录用户。"""
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        token = request.cookies.get("cr_token")
    u = user_by_token(token)
    if not u:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return u

def require_admin(user: Dict = Depends(current_user)):
    if (user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user

# 初始化：创建默认管理员 + 清理过期会话
ensure_default_admin()
_cleanup_sessions()

def row_to_dict(row):
    d = dict(row)
    for k in ("report_json", "images_json", "videos_json"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                d[k] = None
    return d

# ---------------- LLM / 搜索 ----------------
def call_chat(messages, temperature=0.3, json_mode=False):
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("未配置 DEEPSEEK_API_KEY，无法调用 AI 调研。请在 .env 中配置后重试。")
    payload = {"model": DEEPSEEK_MODEL, "messages": messages, "temperature": temperature}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    resp = requests.post(
        f"{DEEPSEEK_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                 "Content-Type": "application/json"},
        json=payload, timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]

def call_vision(image_b64: str, prompt: str) -> str:
    if not VISION_API_KEY:
        raise RuntimeError("未配置 VISION_API_KEY，回退到本地 OCR。")
    resp = requests.post(
        f"{VISION_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {VISION_API_KEY}",
                 "Content-Type": "application/json"},
        json={
            "model": VISION_MODEL,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}}
                ]
            }],
            "temperature": 0.1,
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]

def call_search(query: str) -> Dict[str, Any]:
    """统一搜索入口，返回 {"text": str, "images": [...], "videos": [...]}"""
    if SEARCH_PROVIDER == "serper" and SERPER_API_KEY:
        return _search_serper(query)
    if SEARCH_PROVIDER == "brave" and BRAVE_API_KEY:
        return _search_brave(query)
    if SEARCH_PROVIDER == "tavily" and TAVILY_API_KEY:
        return _search_tavily(query)
    return _search_ddg(query)  # 免 Key 兜底

def _search_serper(query):
    """Serper：search(文本) + images(图片墙) + videos(视频卡) 三个端点合并"""
    headers = {"X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json"}
    payload = {"q": query, "gl": "cn", "hl": "zh-cn"}
    parts, images, videos = [], [], []
    # 1) 文本检索
    try:
        r = requests.post("https://google.serper.dev/search", headers=headers, json=payload, timeout=30)
        r.raise_for_status(); d = r.json()
        for it in d.get("organic", [])[:8]:
            parts.append(f"- {it.get('title','')}\n  {it.get('snippet','')}\n  {it.get('link','')}")
        if d.get("knowledgeGraph"):
            kg = d["knowledgeGraph"]
            parts.append("知识图谱：" + "；".join(f"{k}:{v}" for k, v in kg.items() if isinstance(v, str)))
    except Exception:
        pass
    # 2) 图片墙
    try:
        r = requests.post("https://google.serper.dev/images", headers=headers, json=payload, timeout=30)
        r.raise_for_status(); d = r.json()
        for it in d.get("images", [])[:8]:
            if it.get("imageUrl"):
                images.append({"url": it["imageUrl"], "title": it.get("title", "")})
    except Exception:
        pass
    # 3) 视频卡
    try:
        r = requests.post("https://google.serper.dev/videos", headers=headers, json=payload, timeout=30)
        r.raise_for_status(); d = r.json()
        for it in d.get("videos", [])[:5]:
            if it.get("link"):
                videos.append({"url": it.get("link"), "title": it.get("title", ""),
                               "thumbnail": it.get("imageUrl", ""), "source": it.get("source", "")})
    except Exception:
        pass
    return {"text": "\n".join(parts), "images": images, "videos": videos}

def _search_brave(query):
    try:
        r = requests.get("https://api.search.brave.com/res/v1/web/search",
                         params={"q": query, "count": 8, "country": "cn", "search_lang": "zh"},
                         headers={"X-Subscription-Token": BRAVE_API_KEY, "Accept": "application/json"}, timeout=30)
        r.raise_for_status(); d = r.json()
    except Exception:
        return {"text": "", "images": [], "videos": []}
    parts = []
    for it in d.get("web", {}).get("results", [])[:8]:
        parts.append(f"- {it.get('title','')}\n  {it.get('description','')}\n  {it.get('url','')}")
    images = []
    for it in d.get("web", {}).get("results", [])[:8]:
        th = it.get("thumbnail")
        if isinstance(th, dict) and th.get("src"):
            images.append({"url": th["src"], "title": it.get("title", "")})
    return {"text": "\n".join(parts), "images": images[:8], "videos": []}

def _search_tavily(query):
    try:
        r = requests.post("https://api.tavily.com/search",
                          json={"api_key": TAVILY_API_KEY, "query": query, "max_results": 8, "search_depth": "basic"},
                          timeout=30)
        r.raise_for_status(); d = r.json()
    except Exception:
        return {"text": "", "images": [], "videos": []}
    parts = [f"- {it.get('title','')}\n  {it.get('content','')}\n  {it.get('url','')}" for it in d.get("results", [])[:8]]
    return {"text": "\n".join(parts), "images": [], "videos": []}

def _search_ddg(query):
    """DuckDuckGo HTML 免 Key 搜索（仅文本，best-effort）"""
    try:
        r = requests.post("https://html.duckduckgo.com/html/",
                          data={"q": query},
                          headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
                          timeout=20)
        r.raise_for_status(); html = r.text
    except Exception:
        return {"text": "", "images": [], "videos": []}
    titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', html, re.S)
    snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html, re.S)
    clean = lambda s: re.sub(r'<[^>]+>', '', s).strip()
    parts = []
    for i in range(min(8, len(titles))):
        t = clean(titles[i]); s = clean(snips[i]) if i < len(snips) else ""
        if t:
            parts.append(f"- {t}\n  {s}")
    return {"text": "\n".join(parts), "images": [], "videos": []}

# ---------------- 业务：OCR ----------------
def ocr_with_tesseract(image_bytes: bytes) -> Dict[str, Any]:
    import pytesseract
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(image_bytes))
        text = pytesseract.image_to_string(img, lang="chi_sim+eng")
    except Exception as e:
        return {"raw": "", "fields": {}, "warn": f"本地 OCR 失败：{e}"}
    return {"raw": text, "fields": parse_card_text(text), "warn": "已使用本地 OCR，识别可能不完整，请手动核对。"}

def parse_card_text(text: str) -> Dict[str, Any]:
    f = {"contact_name": "", "title": "", "company": "", "phone": "", "email": "", "website": "", "address": "", "country": ""}
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    # email
    m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    if m: f["email"] = m.group(0)
    # phone (international / common)
    m = re.search(r"(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}(?:[\s-]?\d{1,4})?", text)
    if m: f["phone"] = m.group(0).strip()
    # website
    m = re.search(r"(?:https?://)?(?:www\.)?[\w-]+\.(?:com|cn|net|org|co|io|de|jp|uk|fr|us|ru|in|kr|sg|hk|tw)[\w./-]*", text, re.I)
    if m: f["website"] = m.group(0)
    # title keywords
    for line in lines:
        low = line.lower()
        if any(k in low for k in ["manager", "director", "总裁", "经理", "总监", "owner", "ceo", "president", "founder", "sales", "采购", "销售", "负责人", "officer", "engineer", "工程师"]):
            f["title"] = line; break
    # company (line with co/ltd/inc/公司/株式会社)
    for line in lines:
        if any(k in line for k in ["co.", "ltd", "inc", "gmbh", "corp", "公司", "株式会社", "group", "有限", "股份", "industries", "trading"]):
            f["company"] = line; break
    # country heuristic
    for line in lines:
        for c in ["中国", "美国", "日本", "德国", "英国", "法国", "韩国", "印度", "越南", "泰国", "意大利", "西班牙", "Canada", "USA", "Germany", "Japan", "China"]:
            if c.lower() in line.lower():
                f["country"] = c; break
        if f["country"]: break
    # contact name = first non-empty short line not matched above
    for line in lines:
        if line == f["title"] or line == f["company"]: continue
        if 2 <= len(line.split()) <= 4 and len(line) <= 30 and not any(ch.isdigit() for ch in line):
            f["contact_name"] = line; break
    return f

# ---------------- 业务：调研 ----------------
RESEARCH_SYSTEM = """你是一名资深外贸客户开发专家，擅长通过公开信息调研海外采购商/进口商背景。
请基于提供的客户线索与联网检索素材，输出结构化调研报告。
严格要求：
1. 只输出能确认的真实信息；查不到的标注[未查到公开信息]，基于经验的推断标注[推测]，绝对不编造数据。
2. 必须返回 JSON，结构如下：
{
  "summary": "一句话客户画像（50字内）",
  "sections": [
    {"title":"公司基本资料","content":"markdown 正文..."},
    ...（共10个板块，标题依次为：公司基本资料 / 销售渠道与市场布局 / 采购品类与采购风格 / 价格定位与价格带 / 供应链模式 / 终端客户群体 / 竞争格局 / 近期动态 / 合作匹配度评估 / 信息可靠性说明）
  ],
  "match_score":"高|中|低",
  "match_reason":"匹配理由（品类/价格带/渠道/采购模式）",
  "recommendation":"开发切入建议",
  "risks":"潜在风险"
}
3. 第9板块（合作匹配度评估）必须给出 match_score 与理由。"""

def build_research_messages(info: Dict, search_text: str) -> List[Dict]:
    ctx = f"""【客户线索】
联系人：{info.get('contact_name','')}
职位：{info.get('title','')}
公司/客户名称：{info.get('company','') or info.get('name','')}
国家：{info.get('country','')}
电话：{info.get('phone','')}
邮箱：{info.get('email','')}
网站：{info.get('website','')}
地址：{info.get('address','')}
我方产品品类：{info.get('category','')}
补充线索/展会：{info.get('notes','')}

【联网检索素材】
{search_text if search_text else '（未配置搜索源，请基于你的知识库作答，并标注数据可能非最新）'}
"""
    return [
        {"role": "system", "content": RESEARCH_SYSTEM},
        {"role": "user", "content": ctx + "\n请输出 JSON 报告。"},
    ]

def normalize_report(obj: Dict) -> Dict:
    sections = obj.get("sections", [])
    # 确保顺序与标题
    ordered = []
    for i, title in enumerate(SECTION_TITLES, 1):
        found = next((s for s in sections if title in s.get("title", "")), None)
        ordered.append({"idx": i, "icon": SECTION_ICONS[i-1], "title": title,
                        "content": found["content"] if found else ""})
    return {
        "summary": obj.get("summary", ""),
        "sections": ordered,
        "match_score": obj.get("match_score", "中"),
        "match_reason": obj.get("match_reason", ""),
        "recommendation": obj.get("recommendation", ""),
        "risks": obj.get("risks", ""),
    }

# ---------------- 调研队列（排序 + 并发限流 + 每日配额） ----------------
# 设计：DB 持久化任务表 research_jobs + N 个后台工作线程（N = RESEARCH_CONCURRENCY）。
#     任务先入队（queued），工作线程按 id 升序 FIFO 取任务（running → done/error）。
#     并发上限由工作线程数决定，避免同时打爆搜索/大模型 API。
_dispatch_lock = threading.Lock()
_workers_started = False

def _today_prefix() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")

def quota_used(user_id: int) -> int:
    """统计今日该账号已创建的调研任务数（用于每日配额）。"""
    conn = get_db()
    n = conn.execute("SELECT COUNT(*) AS c FROM research_jobs WHERE owner_id=? AND created_at LIKE ?",
                     (user_id, _today_prefix() + "%")).fetchone()["c"]
    conn.close()
    return n

def quota_info(user_id: int) -> Dict[str, Any]:
    used = quota_used(user_id)
    limit = DAILY_RESEARCH_QUOTA
    remaining = -1 if limit <= 0 else max(0, limit - used)
    return {"date": _today_prefix(), "limit": limit, "used": used, "remaining": remaining}

def queue_position(job_id: int) -> int:
    """返回排队位置（1 表示下一个执行）；非排队状态返回 0。"""
    conn = get_db()
    row = conn.execute("SELECT status FROM research_jobs WHERE id=?", (job_id,)).fetchone()
    if not row or row["status"] != "queued":
        conn.close(); return 0
    n = conn.execute("SELECT COUNT(*) AS c FROM research_jobs WHERE status='queued' AND id<?",
                     (job_id,)).fetchone()["c"]
    conn.close()
    return n + 1

def _claim_next_job():
    with _dispatch_lock:
        conn = get_db()
        row = conn.execute("SELECT * FROM research_jobs WHERE status='queued' ORDER BY id ASC LIMIT 1").fetchone()
        if not row:
            conn.close(); return None
        conn.execute("UPDATE research_jobs SET status='running', started_at=? WHERE id=?",
                     (now_iso(), row["id"]))
        conn.commit(); conn.close()
        return dict(row)

_JOB_ACTIVE = ("queued", "running")

def _save_job_result(job_id: int, *, result=None, error=None, status=None):
    conn = get_db()
    if status is None:
        status = "error" if error else "done"
    conn.execute("UPDATE research_jobs SET status=?, result_json=?, error=?, finished_at=? WHERE id=?",
                 (status, json.dumps(result, ensure_ascii=False) if result is not None else None,
                  error, now_iso(), job_id))
    conn.commit(); conn.close()

def _do_research(info: Dict, owner_id: int, card_id: Optional[int]) -> Dict[str, Any]:
    """真正执行一次调研：搜索 → LLM → 生成报告 → 落库为 customer，并返回结果。"""
    sres = call_search(f"{info.get('company') or info.get('name')} {info.get('country','')} company profile")
    search_text = sres.get("text", "")
    images, videos = sres.get("images", []), sres.get("videos", [])
    raw = call_chat(build_research_messages(info, search_text), json_mode=True)
    obj = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
    report = normalize_report(obj)
    if SEARCH_PROVIDER == "ddg":
        report["search_note"] = "当前使用免费 DuckDuckGo 搜索（无需 API Key），仅文本结果，报告不含图片/视频墙；配置 Serper/Brave/Tavily 的 Key 后可获得更全数据与媒体墙。"
    elif not (images or videos):
        report["search_note"] = "已配置搜索源但未返回图片/视频，报告基于文本检索结果生成。"

    match_score = report.get("match_score", "中")
    conn = get_db(); now = now_iso()
    cur = conn.execute(
        """INSERT INTO customers (contact_name,title,company,country,phone,email,website,address,category,tags,notes,status,source,card_image,report_json,images_json,videos_json,match_score,owner_id,card_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (info.get("contact_name"), info.get("title"), info.get("company") or info.get("name"),
         info.get("country"), info.get("phone"), info.get("email"), info.get("website"),
         info.get("address"), info.get("category"), info.get("tags"), info.get("notes"),
         "researched", "card" if card_id else "manual",
         info.get("card_image"), json.dumps(report, ensure_ascii=False),
         json.dumps(images, ensure_ascii=False), json.dumps(videos, ensure_ascii=False),
         match_score, owner_id, card_id, now, now))
    cid = cur.lastrowid
    conn.commit(); conn.close()
    return {"customer_id": cid, "report": report, "images": images, "videos": videos}

def _run_job(job: Dict):
    try:
        info = json.loads(job.get("payload_json") or "{}")
        result = _do_research(info, job["owner_id"], job.get("card_id"))
        _save_job_result(job["id"], result=result, status="done")
    except RuntimeError as e:
        _save_job_result(job["id"], error=str(e))
    except Exception as e:
        _save_job_result(job["id"], error=f"AI 调研失败：{e}")

def _research_worker(idx: int):
    while True:
        try:
            job = _claim_next_job()
            if not job:
                time.sleep(1.2); continue
            _run_job(job)
        except Exception:
            time.sleep(1.2)

def start_workers():
    """启动并发工作线程池（幂等）。并发数取自 RESEARCH_CONCURRENCY。"""
    global _workers_started
    if _workers_started:
        return
    _workers_started = True
    # 重启后把上次遗留的 running（进程被杀）+ 未完成的 queued 复位，重新排队
    try:
        conn = get_db()
        conn.execute("UPDATE research_jobs SET status='queued', started_at=NULL WHERE status IN ('queued','running')")
        conn.commit(); conn.close()
    except Exception:
        pass
    n = max(1, RESEARCH_CONCURRENCY)
    for i in range(n):
        t = threading.Thread(target=_research_worker, args=(i,), daemon=True, name=f"research-worker-{i}")
        t.start()
    print(f"[research-queue] started {n} worker(s); daily quota = {DAILY_RESEARCH_QUOTA}")

# ---------------- FastAPI ----------------
app = FastAPI(title="客户背景调研工具")

# 启动调研队列工作线程（并发限流）
start_workers()

@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# ---------------- 账号接口 ----------------
class RegisterIn(BaseModel):
    username: str = ""
    password: str = ""
    display_name: str = ""
    email: str = ""

class LoginIn(BaseModel):
    username: str = ""
    password: str = ""

@app.post("/api/auth/register")
def auth_register(body: RegisterIn):
    username = (body.username or "").strip()
    password = body.password or ""
    if len(username) < 3:
        raise HTTPException(400, "用户名至少 3 个字符")
    if len(password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    if not re.match(r"^[A-Za-z0-9_@.\-]{3,32}$", username):
        raise HTTPException(400, "用户名只能包含字母、数字、下划线、@、.、-")
    conn = get_db()
    exists = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if exists:
        conn.close()
        raise HTTPException(409, "该用户名已被注册")
    cur = conn.execute(
        "INSERT INTO users (username, display_name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,?)",
        (username, (body.display_name or "").strip() or username, (body.email or "").strip(),
         hash_password(password), "user", 1, now_iso()))
    uid = cur.lastrowid
    conn.commit(); conn.close()
    token = create_session(uid)
    u = user_by_token(token)
    return {"token": token, "user": public_user(u)}

@app.post("/api/auth/login")
def auth_login(body: LoginIn):
    username = (body.username or "").strip()
    conn = get_db()
    u = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not u or not verify_password(body.password or "", u["password_hash"]):
        conn.close()
        raise HTTPException(401, "用户名或密码错误")
    if not u["active"]:
        conn.close()
        raise HTTPException(403, "该账号已被禁用，请联系管理员")
    conn.execute("UPDATE users SET last_login=? WHERE id=?", (now_iso(), u["id"]))
    conn.commit(); conn.close()
    token = create_session(u["id"])
    return {"token": token, "user": public_user(dict(u))}

@app.post("/api/auth/logout")
def auth_logout(request: Request, authorization: Optional[str] = Header(None)):
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        token = request.cookies.get("cr_token")
    if token:
        conn = get_db()
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        conn.commit(); conn.close()
    return {"ok": True}

@app.get("/api/auth/me")
def auth_me(user: Dict = Depends(current_user)):
    return {"user": public_user(user)}

class ProfileIn(BaseModel):
    display_name: str = ""
    email: str = ""
    old_password: str = ""
    new_password: str = ""

@app.put("/api/auth/profile")
def auth_profile(body: ProfileIn, user: Dict = Depends(current_user)):
    conn = get_db()
    sets, args = [], []
    if body.display_name.strip():
        sets.append("display_name=?"); args.append(body.display_name.strip())
    if body.email is not None:
        sets.append("email=?"); args.append(body.email.strip())
    if body.new_password:
        if len(body.new_password) < 6:
            conn.close(); raise HTTPException(400, "新密码至少 6 位")
        if not verify_password(body.old_password or "", user["password_hash"]):
            conn.close(); raise HTTPException(400, "原密码不正确")
        sets.append("password_hash=?"); args.append(hash_password(body.new_password))
    if sets:
        args.append(user["id"])
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", args)
        conn.commit()
    conn.close()
    return {"ok": True}

# ---------------- 管理员接口 ----------------
class UserAdminIn(BaseModel):
    username: str = ""
    password: str = ""
    display_name: str = ""
    email: str = ""
    role: str = "user"
    active: int = 1

@app.get("/api/admin/users")
def admin_list_users(admin: Dict = Depends(require_admin)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM users ORDER BY id ASC").fetchall()
    conn.close()
    return [public_user(dict(r)) for r in rows]

@app.post("/api/admin/users")
def admin_create_user(body: UserAdminIn, admin: Dict = Depends(require_admin)):
    username = (body.username or "").strip()
    if len(username) < 3:
        raise HTTPException(400, "用户名至少 3 个字符")
    if len(body.password or "") < 6:
        raise HTTPException(400, "密码至少 6 位")
    role = body.role if body.role in ("admin", "user") else "user"
    conn = get_db()
    if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
        conn.close(); raise HTTPException(409, "该用户名已存在")
    cur = conn.execute(
        "INSERT INTO users (username, display_name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,?)",
        (username, (body.display_name or "").strip() or username, (body.email or "").strip(),
         hash_password(body.password), role, int(body.active), now_iso()))
    conn.commit(); conn.close()
    return {"id": cur.lastrowid, "ok": True}

@app.put("/api/admin/users/{uid}")
def admin_update_user(uid: int, body: UserAdminIn, admin: Dict = Depends(require_admin)):
    conn = get_db()
    target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
        conn.close(); raise HTTPException(404, "用户不存在")
    sets, args = [], []
    if body.display_name.strip():
        sets.append("display_name=?"); args.append(body.display_name.strip())
    if body.email is not None:
        sets.append("email=?"); args.append(body.email.strip())
    if body.role in ("admin", "user"):
        # 不允许把最后一个管理员降级
        if target["role"] == "admin" and body.role == "user":
            n_admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").fetchone()["c"]
            if n_admins <= 1:
                conn.close(); raise HTTPException(400, "至少保留一名管理员")
        sets.append("role=?"); args.append(body.role)
    if body.active in (0, 1):
        if target["role"] == "admin" and int(body.active) == 0:
            n_admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").fetchone()["c"]
            if n_admins <= 1:
                conn.close(); raise HTTPException(400, "至少保留一名启用状态的管理员")
        if target["id"] == admin["id"] and int(body.active) == 0:
            conn.close(); raise HTTPException(400, "不能禁用当前登录的账号")
        sets.append("active=?"); args.append(int(body.active))
    if body.password:
        if len(body.password) < 6:
            conn.close(); raise HTTPException(400, "密码至少 6 位")
        sets.append("password_hash=?"); args.append(hash_password(body.password))
    if sets:
        args.append(uid)
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", args)
        conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/admin/users/{uid}")
def admin_delete_user(uid: int, admin: Dict = Depends(require_admin)):
    if uid == admin["id"]:
        raise HTTPException(400, "不能删除当前登录的账号")
    conn = get_db()
    target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not target:
        conn.close(); raise HTTPException(404, "用户不存在")
    if target["role"] == "admin":
        n_admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").fetchone()["c"]
        if n_admins <= 1:
            conn.close(); raise HTTPException(400, "至少保留一名管理员")
    conn.execute("DELETE FROM users WHERE id=?", (uid,))
    conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.get("/api/admin/stats")
def admin_stats(admin: Dict = Depends(require_admin)):
    conn = get_db()
    users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    active = conn.execute("SELECT COUNT(*) AS c FROM users WHERE active=1").fetchone()["c"]
    admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin'").fetchone()["c"]
    customers = conn.execute("SELECT COUNT(*) AS c FROM customers").fetchone()["c"]
    conn.close()
    return {"users": users, "active_users": active, "admins": admins, "customers": customers}

class ResearchIn(BaseModel):
    contact_name: str = ""
    title: str = ""
    company: str = ""
    country: str = ""
    phone: str = ""
    email: str = ""
    website: str = ""
    address: str = ""
    category: str = ""
    notes: str = ""
    tags: str = ""
    card_image: str = ""
    card_id: Optional[int] = None

# ---------------- 业务：名片（独立实体） ----------------
def _card_public(row) -> Dict[str, Any]:
    d = dict(row)
    if d.get("ocr_json"):
        try:
            d["ocr_json"] = json.loads(d["ocr_json"])
        except Exception:
            d["ocr_json"] = None
    return d

def _get_card_or_403(cid: int, user: Dict):
    conn = get_db()
    r = conn.execute("SELECT * FROM cards WHERE id=?", (cid,)).fetchone()
    conn.close()
    if not r:
        raise HTTPException(404, "名片不存在")
    if user.get("role") != "admin" and r["owner_id"] != user["id"]:
        raise HTTPException(403, "无权访问该名片")
    return r

@app.post("/api/cards")
async def create_card(file: UploadFile = File(...), user: Dict = Depends(current_user)):
    """存名片（独立功能）：上传即落盘保存，按 user_id 分目录，返回名片记录。"""
    data = await file.read()
    if not data:
        raise HTTPException(400, "空文件")
    ext = (file.filename or "jpg").split(".")[-1].lower().replace("jpeg", "jpg")
    if ext not in ("jpg", "png", "webp", "gif", "bmp", "heic", "jfif"):
        ext = "jpg"
    fname = save_upload(data, ext, user["id"])
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO cards (owner_id, filename, original_name, mime, size, ocr_json, created_at) VALUES (?,?,?,?,?,?,?)",
        (user["id"], fname, (file.filename or ""), file.content_type or "", len(data), None, now_iso()))
    card_id = cur.lastrowid
    conn.commit()
    r = conn.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
    conn.close()
    return {"ok": True, "card": _card_public(r)}

@app.get("/api/cards")
def list_cards(limit: int = 60, scope: str = "", user: Dict = Depends(current_user)):
    """列出名片：普通用户仅自己的；管理员默认自己的，scope=all 可看全部。"""
    conn = get_db()
    sql = "SELECT * FROM cards WHERE 1=1"; args = []
    is_admin = (user.get("role") == "admin")
    if (not is_admin) or scope != "all":
        sql += " AND owner_id=?"; args.append(user["id"])
    sql += " ORDER BY id DESC LIMIT ?"; args.append(max(1, min(300, int(limit or 60))))
    rows = conn.execute(sql, args).fetchall()
    # 每张名片附带其关联的调研客户（若有）
    out = []
    for r in rows:
        d = _card_public(r)
        c = conn.execute("SELECT id, company, status, match_score FROM customers WHERE card_id=? ORDER BY id DESC LIMIT 1",
                         (r["id"],)).fetchone()
        d["customer"] = dict(c) if c else None
        out.append(d)
    conn.close()
    return out

@app.get("/api/cards/{cid}")
def get_card(cid: int, user: Dict = Depends(current_user)):
    r = _get_card_or_403(cid, user)
    conn = get_db()
    c = conn.execute("SELECT id, company, status, match_score FROM customers WHERE card_id=? ORDER BY id DESC LIMIT 1",
                     (cid,)).fetchone()
    conn.close()
    d = _card_public(r); d["customer"] = dict(c) if c else None
    return d

@app.delete("/api/cards/{cid}")
def delete_card(cid: int, user: Dict = Depends(current_user)):
    r = _get_card_or_403(cid, user)
    # 删除磁盘文件（尽力而为）
    try:
        fp = UPLOAD_DIR / r["filename"]
        if fp.exists():
            fp.unlink()
    except Exception:
        pass
    conn = get_db()
    conn.execute("DELETE FROM cards WHERE id=?", (cid,))
    # 关联客户仅解除关联，不连带删除
    conn.execute("UPDATE customers SET card_id=NULL WHERE card_id=?", (cid,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.post("/api/cards/{cid}/ocr")
def card_ocr(cid: int, user: Dict = Depends(current_user)):
    """OCR（独立功能，前提是已有名片）：对已保存的名片做识别，回填字段。"""
    r = _get_card_or_403(cid, user)
    fp = UPLOAD_DIR / r["filename"]
    if not fp.exists():
        raise HTTPException(404, "名片原图已丢失")
    data = fp.read_bytes()
    b64 = base64.b64encode(data).decode()
    fields, warn = {}, ""
    try:
        vision_text = call_vision(b64, (
            "这是一张名片照片。请提取字段并以 JSON 返回，键为："
            "contact_name(人名), title(职位), company(公司名), phone, email, website, address, country(国家)。"
            "只返回 JSON，不要解释。"))
        try:
            fields = json.loads(re.search(r"\{.*\}", vision_text, re.S).group(0))
        except Exception:
            fields, warn = {}, "视觉模型返回解析失败，已回退本地 OCR。"
    except Exception as e:
        warn = str(e)
    if not fields:
        res = ocr_with_tesseract(data)
        fields, warn = res["fields"], res.get("warn", warn) or warn
    conn = get_db()
    conn.execute("UPDATE cards SET ocr_json=? WHERE id=?", (json.dumps(fields, ensure_ascii=False), cid))
    conn.commit(); conn.close()
    return {"image": r["filename"], "fields": fields, "warn": warn, "card_id": cid}

# ---------------- 业务：调研（入队，异步排队执行） ----------------
@app.get("/api/quota")
def get_quota(user: Dict = Depends(current_user)):
    return quota_info(user["id"])

@app.post("/api/research")
def api_research(body: ResearchIn, user: Dict = Depends(current_user)):
    """提交调研任务：不阻塞，直接入队；由后台工作线程按并发上限顺序执行。"""
    info = body.model_dump()
    # 每日配额校验（0 表示不限制）
    qi = quota_info(user["id"])
    if qi["limit"] > 0 and qi["used"] >= qi["limit"]:
        raise HTTPException(status_code=429,
            detail=f"今日调研配额已用完（{qi['used']}/{qi['limit']}）。每日 0 点重置，或联系管理员调整额度。")
    # 若带名片，校验归属并回填图片路径
    card_id = body.card_id
    if card_id:
        r = _get_card_or_403(card_id, user)
        info["card_image"] = r["filename"]
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO research_jobs (owner_id, card_id, status, payload_json, created_at) VALUES (?,?,?,?,?)",
        (user["id"], card_id, "queued", json.dumps(info, ensure_ascii=False), now_iso()))
    jid = cur.lastrowid
    conn.commit(); conn.close()
    return {"job_id": jid, "status": "queued", "position": queue_position(jid), "quota": quota_info(user["id"])}

@app.get("/api/research/jobs")
def list_research_jobs(active: int = 0, limit: int = 20, user: Dict = Depends(current_user)):
    conn = get_db()
    sql = "SELECT * FROM research_jobs WHERE owner_id=?"; args = [user["id"]]
    if active:
        sql += " AND status IN ('queued','running')"
    sql += " ORDER BY id DESC LIMIT ?"; args.append(max(1, min(100, int(limit or 20))))
    rows = conn.execute(sql, args).fetchall()
    conn.close()
    return [_job_public(dict(r)) for r in rows]

@app.get("/api/research/jobs/{jid}")
def get_research_job(jid: int, user: Dict = Depends(current_user)):
    conn = get_db()
    r = conn.execute("SELECT * FROM research_jobs WHERE id=?", (jid,)).fetchone()
    conn.close()
    if not r:
        raise HTTPException(404, "任务不存在")
    if user.get("role") != "admin" and r["owner_id"] != user["id"]:
        raise HTTPException(403, "无权访问该任务")
    d = _job_public(dict(r))
    if d["status"] == "queued":
        d["position"] = queue_position(jid)
    return d

def _job_public(d: Dict) -> Dict:
    d.pop("payload_json", None)
    if d.get("result_json"):
        try:
            d["result"] = json.loads(d["result_json"])
        except Exception:
            d["result"] = None
    d.pop("result_json", None)
    return d

@app.get("/api/ocr")
def _ocr_deprecated():
    raise HTTPException(status_code=410, detail="该接口已升级：请先 POST /api/cards 存名片，再 POST /api/cards/{id}/ocr 识别。")


# ---------------- CRUD ----------------
class CustomerIn(BaseModel):
    contact_name: str = ""
    title: str = ""
    company: str = ""
    country: str = ""
    phone: str = ""
    email: str = ""
    website: str = ""
    address: str = ""
    category: str = ""
    tags: str = ""
    notes: str = ""
    status: str = "new"
    source: str = "manual"
    card_image: str = ""
    report_json: str = ""
    images_json: str = ""
    videos_json: str = ""
    match_score: str = ""
    card_id: Optional[int] = None

@app.get("/api/customers")
def list_customers(q: str = "", status: str = "", country: str = "", scope: str = "",
                   user: Dict = Depends(current_user)):
    conn = get_db()
    sql = "SELECT * FROM customers WHERE 1=1"
    args = []
    # 数据范围：管理员默认看全部，可传 scope=mine 只看自己；普通用户只能看自己的
    is_admin = (user.get("role") == "admin")
    if (not is_admin) or scope == "mine":
        sql += " AND owner_id=?"; args.append(user["id"])
    if q:
        sql += " AND (company LIKE ? OR contact_name LIKE ? OR email LIKE ?)"
        args += [f"%{q}%", f"%{q}%", f"%{q}%"]
    if status:
        sql += " AND status=?"; args.append(status)
    if country:
        sql += " AND country=?"; args.append(country)
    sql += " ORDER BY id DESC"
    rows = conn.execute(sql, args).fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]

@app.get("/api/customers/{cid}")
def get_customer(cid: int, user: Dict = Depends(current_user)):
    conn = get_db()
    r = conn.execute("SELECT * FROM customers WHERE id=?", (cid,)).fetchone()
    conn.close()
    if not r: raise HTTPException(404, "未找到")
    row = dict(r)
    if user.get("role") != "admin" and row.get("owner_id") not in (None, user["id"]):
        raise HTTPException(403, "无权访问该客户")
    return row_to_dict(r)

@app.post("/api/customers")
def create_customer(c: CustomerIn, user: Dict = Depends(current_user)):
    conn = get_db(); now = now_iso()
    cur = conn.execute(
        """INSERT INTO customers (contact_name,title,company,country,phone,email,website,address,category,tags,notes,status,source,card_image,report_json,images_json,videos_json,match_score,owner_id,card_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (c.contact_name, c.title, c.company, c.country, c.phone, c.email, c.website,
         c.address, c.category, c.tags, c.notes, c.status, c.source, c.card_image,
         c.report_json, c.images_json, c.videos_json, c.match_score, user["id"], c.card_id, now, now))
    conn.commit(); conn.close()
    return {"id": cur.lastrowid}

@app.put("/api/customers/{cid}")
def update_customer(cid: int, c: CustomerIn, user: Dict = Depends(current_user)):
    conn = get_db()
    r = conn.execute("SELECT owner_id FROM customers WHERE id=?", (cid,)).fetchone()
    if not r:
        conn.close(); raise HTTPException(404, "未找到")
    if user.get("role") != "admin" and r["owner_id"] not in (None, user["id"]):
        conn.close(); raise HTTPException(403, "无权修改该客户")
    # 局部更新：只更新请求中显式传入的字段，避免误清空 report_json / card_id 等
    data = c.model_dump(exclude_unset=True)
    if "card_id" in data and data["card_id"]:
        card = conn.execute("SELECT owner_id FROM cards WHERE id=?", (data["card_id"],)).fetchone()
        if not card:
            conn.close(); raise HTTPException(400, "关联的名片不存在")
        if user.get("role") != "admin" and card["owner_id"] != user["id"]:
            conn.close(); raise HTTPException(403, "无权关联该名片")
    if not data:
        conn.close(); return {"ok": True}
    sets = [f"{k}=?" for k in data]
    args = list(data.values())
    sets.append("updated_at=?"); args.append(now_iso())
    args.append(cid)
    conn.execute(f"UPDATE customers SET {', '.join(sets)} WHERE id=?", args)
    conn.commit(); conn.close()
    return {"ok": True}

@app.delete("/api/customers/{cid}")
def delete_customer(cid: int, user: Dict = Depends(current_user)):
    conn = get_db()
    r = conn.execute("SELECT owner_id FROM customers WHERE id=?", (cid,)).fetchone()
    if not r:
        conn.close(); raise HTTPException(404, "未找到")
    if user.get("role") != "admin" and r["owner_id"] not in (None, user["id"]):
        conn.close(); raise HTTPException(403, "无权删除该客户")
    conn.execute("DELETE FROM customers WHERE id=?", (cid,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.get("/api/export")
def export_customers(format: str = "csv", q: str = "", status: str = "", country: str = "",
                     scope: str = "", user: Dict = Depends(current_user)):
    rows = list_customers(q, status, country, scope, user)
    if format == "json":
        return JSONResponse(rows)
    cols = ["id","contact_name","title","company","country","phone","email","website","address","category","tags","notes","status","match_score","created_at"]
    if format == "excel":
        import openpyxl
        wb = openpyxl.Workbook(); ws = wb.active; ws.append(cols)
        for r in rows:
            ws.append([r.get(c, "") for c in cols])
        out = io.BytesIO(); wb.save(out); out.seek(0)
        return FileResponse(io.BytesIO(out.read()), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename="customers.xlsx")
    # csv
    import csv
    out = io.StringIO(); w = csv.writer(out)
    w.writerow(cols)
    for r in rows:
        w.writerow([r.get(c, "") for c in cols])
    return FileResponse(io.BytesIO(out.getvalue().encode("utf-8-sig")), media_type="text/csv", filename="customers.csv")

@app.get("/api/health")
def health():
    return {"status": "ok", "deepseek": bool(DEEPSEEK_API_KEY), "vision": bool(VISION_API_KEY),
            "vision_provider": VISION_PROVIDER, "search_provider": SEARCH_PROVIDER,
            "search_key": bool(SERPER_API_KEY or BRAVE_API_KEY or TAVILY_API_KEY),
            "research_concurrency": RESEARCH_CONCURRENCY, "daily_quota": DAILY_RESEARCH_QUOTA}

@app.get("/api/config")
def get_config(admin: Dict = Depends(require_admin)):
    """返回配置；密钥仅以掩码形式下发，绝不返回明文。仅管理员可访问。"""
    mask = lambda v: ("•" * 10) if v else ""
    return {
        "deepseek_api_key": mask(DEEPSEEK_API_KEY),
        "vision_provider": VISION_PROVIDER,
        "vision_api_key": mask(VISION_API_KEY),
        "vision_base_url": VISION_BASE_URL,
        "vision_model": VISION_MODEL,
        "search_provider": SEARCH_PROVIDER,
        "serper_api_key": mask(SERPER_API_KEY),
        "brave_api_key": mask(BRAVE_API_KEY),
        "tavily_api_key": mask(TAVILY_API_KEY),
        "research_concurrency": RESEARCH_CONCURRENCY,
        "daily_quota": DAILY_RESEARCH_QUOTA,
    }

class ConfigIn(BaseModel):
    deepseek_api_key: str = ""
    vision_provider: str = "openai"
    vision_api_key: str = ""
    vision_base_url: str = ""
    vision_model: str = ""
    search_provider: str = "ddg"
    serper_api_key: str = ""
    brave_api_key: str = ""
    tavily_api_key: str = ""
    research_concurrency: str = ""
    daily_quota: str = ""

CFG_FIELDS = ["deepseek_api_key", "vision_provider", "vision_api_key", "vision_base_url",
              "vision_model", "search_provider", "serper_api_key", "brave_api_key", "tavily_api_key"]

@app.put("/api/config")
def update_config(c: ConfigIn, admin: Dict = Depends(require_admin)):
    """保存设置页配置到 config.json 并热更新（无需重启）。空字符串表示保留原值；'__CLEAR__' 表示清空。仅管理员可操作。"""
    cfg = _read_config_file()
    for k in CFG_FIELDS:
        v = getattr(c, k, "")
        if v == "__CLEAR__":
            cfg[k.upper()] = ""
        elif v == "":
            pass  # 保留原值
        else:
            cfg[k.upper()] = v
    # 数值型配置：调研并发数 / 每日配额（留空则保留）
    for k in ("research_concurrency", "daily_quota"):
        v = str(getattr(c, k, "") or "").strip()
        if v != "":
            cfg[k.upper()] = v
    json.dump(cfg, open(CONFIG_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    reload_config()
    return {"ok": True, "search_provider": SEARCH_PROVIDER, "vision_provider": VISION_PROVIDER,
            "deepseek": bool(DEEPSEEK_API_KEY), "vision": bool(VISION_API_KEY),
            "research_concurrency": RESEARCH_CONCURRENCY, "daily_quota": DAILY_RESEARCH_QUOTA}
