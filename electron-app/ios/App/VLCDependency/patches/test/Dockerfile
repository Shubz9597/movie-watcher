FROM debian:bookworm
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential autoconf automake libtool pkg-config gettext autopoint flex bison git ca-certificates \
    libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libpostproc-dev \
    libass-dev libfreetype-dev libfribidi-dev libharfbuzz-dev libfontconfig-dev fonts-dejavu-core fonts-liberation \
    libebml-dev libmatroska-dev zlib1g-dev ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*
