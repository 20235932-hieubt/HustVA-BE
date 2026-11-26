# Embedding service: dangvantuan/vietnamese-document-embedding on CPU.
# The model (~1.2 GB) is downloaded on first start into HF_HOME, which compose mounts from the host.
FROM python:3.14-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    EMBEDDING_HOST=0.0.0.0 \
    EMBEDDING_PORT=8001
RUN pip install torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY app.py ./
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=10s --start-period=600s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/info', timeout=5)"
CMD ["python", "app.py"]
