FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv/app

COPY app ./app
COPY tests ./tests
COPY scripts ./scripts

# Container listen port (host-side port is mapped in docker-compose.yml).
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/health', timeout=2).read()"]

CMD ["python", "-m", "app.server"]
