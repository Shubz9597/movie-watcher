# torWatch server image (multi-arch linux/amd64 + linux/arm64, FR-009).
# Built from the torrent-streamer module context via
# scripts/build-images.sh with immutable version tags; releases never use
# :latest. Build context MUST be torrent-streamer/ (see build-images.sh).
#
# Build args (declared below, passed by build-images.sh):
#   TORWATCH_VERSION  semantic version of this image
#   TORWATCH_REVISION git revision the image was built from
#   TORWATCH_BUILT_AT UTC build timestamp
FROM golang:1.24.2-alpine AS build
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

FROM alpine:3.20.6
# ca-certificates: HTTPS provider calls; tzdata: TZ support; curl: container
# healthcheck; ffmpeg: playback.compat.v1 tooling (transcode off by default).
RUN apk add --no-cache ca-certificates tzdata curl ffmpeg \
    && addgroup -g 1000 torwatch \
    && adduser -D -u 1000 -G torwatch torwatch
ENV FFPROBE_PATH=/usr/bin/ffprobe \
    FFMPEG_PATH=/usr/bin/ffmpeg
COPY --from=build /out/torwatch-vod /usr/local/bin/torwatch-vod
USER torwatch:torwatch
EXPOSE 4001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=5 \
  CMD curl -fsS http://127.0.0.1:4001/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/torwatch-vod"]
