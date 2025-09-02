package config

import (
	"io"
	"log"
	"os"

	"torrent-streamer/internal/logx"
)

func SetupLogging() {
	var out io.Writer = os.Stdout
	if p := LogFilePath(); p != "" {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			log.Printf("WARN opening LOG_FILE=%q: %v", p, err)
		} else {
			out = io.MultiWriter(os.Stdout, f)
		}
	}

	log.SetFlags(0)
	log.SetPrefix("")

	filter := logx.New(out, LogDedupWindow(), LogAllowRegex(), LogDenyRegex())
	log.SetOutput(filter)
	log.Printf("[init] logging configured (dedup=%s allow=%q deny=%q)", LogDedupWindow(), LogAllowRegex(), LogDenyRegex())
}
