# torWatch server image (multi-arch ARM64/AMD64, FR-009).
# Built from deploy/torwatch-server via scripts/build-images.sh with
# immutable version tags; never :latest in deployments.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY torrent-streamer/go.mod torrent-streamer/go.sum ./
RUN go mod download
COPY torrent-streamer/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags "-s -w -X torrent-streamer/internal/buildinfo.AppVersion=${TORWATCH_VERSION:-dev}" \
    -o /out/torwatch-vod ./cmd/vod

FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl
COPY --from=build /out/torwatch-vod /usr/local/bin/torwatch-vod
EXPOSE 4001
ENTRYPOINT ["/usr/local/bin/torwatch-vod"]
