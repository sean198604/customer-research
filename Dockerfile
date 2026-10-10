FROM python:3.12-slim

# 安装 Tesseract 中英文 OCR 作为无密钥兜底
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

ENV PORT=8000
EXPOSE 8000

# 单进程运行：调研队列用进程内工作线程池控制并发（RESEARCH_CONCURRENCY），
# 多 worker 会让并发上限翻倍并可能重复领取任务，故固定 --workers 1。
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1"]
