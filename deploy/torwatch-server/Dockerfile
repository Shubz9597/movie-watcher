# torWatch server image (multi-arch linux/amd64 + linux/arm64, FR-009).
# Built from the torrent-streamer module context via
# scripts/build-images.sh with immutable version tags; releases never use
# :latest. Build context MUST be torrent-streamer/ (see build-images.sh).
#
# Build args (declared below, passed by build-images.sh):
#   TORWATCH_VERSION  semantic version of this image
#   TORWATCH_REVISION git revision the image was built from
#   TORWATCH_BUILT_AT UTC build timestamp
FROM golang:1.27.1-alpine AS build
ARG TORWATCH_VERSION=dev
ARG TORWATCH_REVISION=unknown
ARG TORWATCH_BUILT_AT=unknown
WORKDIR /src
# Cache dependency layers separately from changing source.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags "-s -w \
      -X torrent-streamer/internal/buildinfo.AppVersion=${TORWATCH_VERSION} \
      -X torrent-streamer/internal/buildinfo.Revision=${TORWATCH_REVISION} \
      -X torrent-streamer/internal/buildinfo.BuiltAt=${TORWATCH_BUILT_AT}" \
    -o /out/torwatch-vod ./cmd/vod

# Speech-to-text for dubs (internal/transcribe): whisper.cpp's CLI and its
# Silero voice detection, with the English base model. Dub subtitles are
# written from the English audio when online subtitles translate the
# original language instead (about 2 minutes per 23-minute episode).
FROM alpine:3.20.6 AS whisper
ARG WHISPER_CPP_VERSION=v1.9.5
ARG TARGETARCH
RUN apk add --no-cache build-base cmake git curl
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp /whisper \
 && X86="" && if [ "$TARGETARCH" = "amd64" ]; then X86="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; fi \
 && cmake -S /whisper -B /whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF $X86 -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /whisper/build -j"$(nproc)" --config Release --target whisper-cli whisper-vad-speech-segments \
 && install -m 0755 /whisper/build/bin/whisper-cli /whisper/build/bin/whisper-vad-speech-segments /usr/local/bin/
RUN mkdir -p /opt/whisper \
 && curl -fsSL -o /opt/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
 && curl -fsSL -o /opt/whisper/ggml-silero.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin \
 && echo "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002  /opt/whisper/ggml-base.en.bin" | sha256sum -c - \
 && echo "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf  /opt/whisper/ggml-silero.bin" | sha256sum -c -

FROM alpine:3.20.6
# ca-certificates: HTTPS provider calls; tzdata: TZ support; curl: container
# healthcheck; ffmpeg: playback.compat.v1 tooling (transcode off by default);
# libstdc++: whisper.cpp.
RUN apk add --no-cache ca-certificates tzdata curl ffmpeg libstdc++ \
    && addgroup -g 1000 torwatch \
    && adduser -D -u 1000 -G torwatch torwatch
ENV FFPROBE_PATH=/usr/bin/ffprobe \
    FFMPEG_PATH=/usr/bin/ffmpeg
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-vad-speech-segments /usr/local/bin/
COPY --from=whisper /opt/whisper /opt/whisper
COPY --from=build /out/torwatch-vod /usr/local/bin/torwatch-vod
USER torwatch:torwatch
EXPOSE 4001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=5 \
  CMD curl -fsS http://127.0.0.1:4001/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/torwatch-vod"]
