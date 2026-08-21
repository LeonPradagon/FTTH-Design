FROM python:3.11-slim AS builder

ENV PATH=/opt/venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv /opt/venv

WORKDIR /workspace
COPY app/server/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

ENV PRISMA_BINARY_CACHE_DIR=/opt/prisma-cache
COPY app/server/schema.prisma ./app/server/schema.prisma
RUN prisma generate --schema /workspace/app/server/schema.prisma \
    && find /opt/prisma-cache -type f -name 'query-engine-*' \
        -exec install -m 0755 {} /opt/prisma-query-engine \; \
    && test -x /opt/prisma-query-engine

FROM python:3.11-slim AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PRISMA_QUERY_ENGINE_BINARY=/opt/prisma-query-engine

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app

WORKDIR /workspace
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=app:app /opt/prisma-query-engine /opt/prisma-query-engine
COPY --chown=app:app app/server ./app/server
COPY --chown=app:app samples ./samples

RUN mkdir -p /workspace/app/server/data /workspace/app/server/cache \
    && chown -R app:app /workspace/app/server/data /workspace/app/server/cache

USER app
WORKDIR /workspace/app
EXPOSE 8000

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
