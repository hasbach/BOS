# Official uv image: Python 3.12 with uv preinstalled.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /srv/backend

# Dependencies first, so code changes do not reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY . .
# Data files the code reads at run time ship with it; fail the build if one is missing.
RUN test -s app/data/common_passwords.txt

RUN useradd --create-home bos && mkdir -p /data/uploads && chown -R bos /data/uploads
USER bos

EXPOSE 8000
CMD ["flask", "--app", "app:create_app", "run", "--host", "0.0.0.0", "--port", "8000"]
