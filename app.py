"""
客户背景调研工具 · 后端 (FastAPI)
- 名片 OCR（视觉模型 / Tesseract 兜底）
- 搜索富集（Serper，返回文本+图片+视频）
- DeepSeek 调研报告生成
- SQLite 存储 + 后台批量查询 / 导出
"""
import os
import io
import re
import json
import sqlite3
import hashlib
import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

import requests
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
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

def reload_config():
    """优先读 .env（容器环境变量），再用 config.json 覆盖（设置页写入），实现运行时热更新。"""
    global DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
    global VISION_PROVIDER, VISION_API_KEY, VISION_BASE_URL, VISION_MODEL
    global SEARCH_PROVIDER, SERPER_API_KEY, BRAVE_API_KEY, TAVILY_API_KEY
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
    }
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.load(open(CONFIG_PATH, encoding="utf-8")))
        except Exception:
            pass
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

reload_config()

SECTION_TITLES = [
    "公司基本资料", "销售渠道与市场布局", "采购品类与采购风格",
    "价格定位与价格带", "供应链模式", "终端客户群体",
    "竞争格局", "近期动态", "合作匹配度评估", "信息可靠性说明",
]
SECTION_ICONS = ["🏢", "🛒", "📦", "💰", "🔗", "👥", "⚔️", "📰", "🎯", "📌"]

# ---------------- 数据库 ----------------
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
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
        created_at TEXT,
        updated_at TEXT
    )
    """)
    conn.commit()
    conn.close()

init_db()

def row_to_dict(row):
    d = dict(row)
    for k in ("report_json", "images_json", "videos_json"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                d[k] = None
    return d

# ---------------- 工具函数 ----------------
def now_iso():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

def save_upload(image_bytes: bytes, ext: str) -> str:
    h = hashlib.md5(image_bytes).hexdigest()[:12]
    fname = f"{h}.{ext}"
    (UPLOAD_DIR / fname).write_bytes(image_bytes)
    return fname

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

# ---------------- FastAPI ----------------
app = FastAPI(title="客户背景调研工具")

@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

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
    save: bool = True

@app.post("/api/ocr")
async def api_ocr(file: UploadFile = File(...)):
    data = await file.read()
    ext = (file.filename or "jpg").split(".")[-1].lower().replace("jpeg", "jpg")
    fname = save_upload(data, ext)
    # 转 base64 供视觉模型
    import base64
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
    return {"image": fname, "fields": fields, "warn": warn}

@app.post("/api/research")
def api_research(body: ResearchIn):
    info = body.model_dump()
    search_text = ""
    images, videos = [], []
    sres = call_search(f"{info.get('company') or info.get('name')} {info.get('country','')} company profile")
    search_text = sres.get("text", "")
    images, videos = sres.get("images", []), sres.get("videos", [])
    try:
        raw = call_chat(build_research_messages(info, search_text), json_mode=True)
        obj = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
        report = normalize_report(obj)
        if SEARCH_PROVIDER == "ddg":
            report["search_note"] = "当前使用免费 DuckDuckGo 搜索（无需 API Key），仅文本结果，报告不含图片/视频墙；配置 Serper/Brave/Tavily 的 Key 后可获得更全数据与媒体墙。"
        elif not (images or videos):
            report["search_note"] = "已配置搜索源但未返回图片/视频，报告基于文本检索结果生成。"
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 调研失败：{e}")

    match_score = report.get("match_score", "中")
    saved_id = None
    if body.save:
        conn = get_db()
        now = now_iso()
        cur = conn.execute(
            """INSERT INTO customers (contact_name,title,company,country,phone,email,website,address,category,tags,notes,status,source,card_image,report_json,images_json,videos_json,match_score,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (info.get("contact_name"), info.get("title"), info.get("company") or info.get("name"),
             info.get("country"), info.get("phone"), info.get("email"), info.get("website"),
             info.get("address"), info.get("category"), info.get("tags"), info.get("notes"),
             "researched", "ocr" if info.get("card_image") else "manual",
             info.get("card_image"), json.dumps(report, ensure_ascii=False),
             json.dumps(images, ensure_ascii=False), json.dumps(videos, ensure_ascii=False),
             match_score, now, now))
        saved_id = cur.lastrowid
        conn.commit(); conn.close()
    return {"id": saved_id, "report": report, "images": images, "videos": videos}

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

@app.get("/api/customers")
def list_customers(q: str = "", status: str = "", country: str = ""):
    conn = get_db()
    sql = "SELECT * FROM customers WHERE 1=1"
    args = []
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
def get_customer(cid: int):
    conn = get_db()
    r = conn.execute("SELECT * FROM customers WHERE id=?", (cid,)).fetchone()
    conn.close()
    if not r: raise HTTPException(404, "未找到")
    return row_to_dict(r)

@app.post("/api/customers")
def create_customer(c: CustomerIn):
    conn = get_db(); now = now_iso()
    cur = conn.execute(
        """INSERT INTO customers (contact_name,title,company,country,phone,email,website,address,category,tags,notes,status,source,card_image,report_json,images_json,videos_json,match_score,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (c.contact_name, c.title, c.company, c.country, c.phone, c.email, c.website,
         c.address, c.category, c.tags, c.notes, c.status, c.source, c.card_image,
         c.report_json, c.images_json, c.videos_json, c.match_score, now, now))
    conn.commit(); conn.close()
    return {"id": cur.lastrowid}

@app.put("/api/customers/{cid}")
def update_customer(cid: int, c: CustomerIn):
    conn = get_db()
    conn.execute(
        """UPDATE customers SET contact_name=?,title=?,company=?,country=?,phone=?,email=?,website=?,address=?,category=?,tags=?,notes=?,status=?,source=?,card_image=?,report_json=?,images_json=?,videos_json=?,match_score=?,updated_at=? WHERE id=?""",
        (c.contact_name, c.title, c.company, c.country, c.phone, c.email, c.website,
         c.address, c.category, c.tags, c.notes, c.status, c.source, c.card_image,
         c.report_json, c.images_json, c.videos_json, c.match_score, now_iso(), cid))
    conn.commit(); conn.close()
    return {"ok": True}

@app.delete("/api/customers/{cid}")
def delete_customer(cid: int):
    conn = get_db()
    conn.execute("DELETE FROM customers WHERE id=?", (cid,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.get("/api/export")
def export_customers(format: str = "csv", q: str = "", status: str = "", country: str = ""):
    rows = list_customers(q, status, country)
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
            "search_key": bool(SERPER_API_KEY or BRAVE_API_KEY or TAVILY_API_KEY)}

@app.get("/api/config")
def get_config():
    """返回配置；密钥仅以掩码形式下发，绝不返回明文。"""
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

@app.put("/api/config")
def update_config(c: ConfigIn):
    """保存设置页配置到 config.json 并热更新（无需重启）。空字符串表示保留原值；'__CLEAR__' 表示清空。"""
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.load(open(CONFIG_PATH, encoding="utf-8"))
        except Exception:
            cfg = {}
    fields = ["deepseek_api_key", "vision_provider", "vision_api_key", "vision_base_url",
              "vision_model", "search_provider", "serper_api_key", "brave_api_key", "tavily_api_key"]
    for k in fields:
        v = getattr(c, k, "")
        if v == "__CLEAR__":
            cfg[k] = ""
        elif v == "":
            pass  # 保留原值
        else:
            cfg[k] = v
    json.dump(cfg, open(CONFIG_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    reload_config()
    return {"ok": True, "search_provider": SEARCH_PROVIDER, "vision_provider": VISION_PROVIDER,
            "deepseek": bool(DEEPSEEK_API_KEY), "vision": bool(VISION_API_KEY)}
