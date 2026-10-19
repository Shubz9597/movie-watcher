#!/bin/sh
set -e
cd /work/vlc
[ -x configure ] || ./bootstrap
[ -f config.status ] || ./configure --prefix=/opt/vlc --disable-lua --disable-qt --disable-skins2 --disable-xcb \
  --disable-alsa --disable-pulse --disable-dbus --disable-a52 --disable-libgcrypt --disable-vdpau --disable-va \
  --disable-wayland --disable-sdl-image --disable-srt --disable-nls --disable-vlm --disable-addonmanagermodules \
  --disable-update-check --enable-libass --enable-freetype --enable-avcodec --enable-swscale --enable-matroska
make -j"$(nproc)"
make install
