FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "laya[serve]"

ENV LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cpu \
    LAYA_MODELS=english \
    LAYA_DEFAULT_MODEL=english \
    LAYA_PRELOAD=1 \
    LAYA_MAX_LOADED=1 \
    OMP_NUM_THREADS=4 \
    TORCH_DISABLE_NATIVE_JIT=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["laya-serve"]
