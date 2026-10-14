FROM python:3.12-slim

# ffmpeg for rendering and probing; fonts-dejavu because burned-in captions and
# drawtext need a real font file on disk, not a webfont.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY forge ./forge

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

# Renders are CPU-bound and run minutes long, so a single worker per container
# and horizontal scaling beats threads fighting over the same cores.
CMD ["uvicorn", "forge.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
