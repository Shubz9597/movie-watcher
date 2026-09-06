// reference-client is a minimal Go CLI test harness (plan P6, spec
// Assumption): it completes the full viewing journey against one TorWatch
// backend using ONLY public endpoints plus protocol negotiation. It is a
// verification harness for SC-001/SC-002, not a shipped product.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:4001", "backend base URL")
	command := flag.String("cmd", "version", "version|search|title|episodes|resolve|stream|heartbeat|resume|journey")
	query := flag.String("q", "", "search query / command argument")
	titleID := flag.String("title", "", "opaque catalog title id")
	season := flag.Int("season", 1, "season number")
	sourceID := flag.String("source", "", "torrent search sourceId to resolve")
	magnet := flag.String("magnet", "", "magnet uri to stream")
	fileIndex := flag.Int("fileIndex", -1, "file index to stream")
	subjectID := flag.String("subject", "", "progress subject id")
	seriesID := flag.String("series", "", "series id for progress")
	configDir := flag.String("config-dir", "", "client-id persistence directory (default: user config dir)")
	flag.Parse()

	client, err := NewClient(*base, *configDir)
	if err != nil {
		exitf("client init: %v", err)
	}
	ctx := context.Background()

	var err2 error
	switch *command {
	case "version":
		err2 = runVersion(ctx, client)
	case "search":
		err2 = runSearch(ctx, client, *query)
	case "title":
		err2 = runTitle(ctx, client, *titleID)
	case "episodes":
		err2 = runEpisodes(ctx, client, *titleID, *season)
	case "resolve":
		err2 = runResolve(ctx, client, *sourceID)
	case "stream":
		err2 = runStream(ctx, client, *magnet, *fileIndex)
	case "heartbeat":
		err2 = runHeartbeat(ctx, client, *subjectID, *seriesID)
	case "resume":
		err2 = runResume(ctx, client, *subjectID, *seriesID)
	case "journey":
		err2 = runJourney(ctx, client, *query, *magnet, *subjectID, *seriesID)
	default:
		err2 = fmt.Errorf("unknown command %q", *command)
	}
	if err2 != nil {
		exitf("%s: %v", *command, err2)
	}
}

func exitf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "reference-client: "+strings.TrimRight(format, "\n")+"\n", args...)
	os.Exit(1)
}
