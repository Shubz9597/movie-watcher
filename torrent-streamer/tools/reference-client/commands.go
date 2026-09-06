package main

import (
	"context"
	"fmt"
	"net/http"
)

func runVersion(ctx context.Context, client *Client) error {
	version, err := client.FetchVersion(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("serverVersion=%s protocolVersion=%d supportedProtocolRange=%v capabilities=%v\n",
		version.ServerVersion, version.ProtocolVersion, version.SupportedProtocolRange, version.Capabilities)
	decision := Negotiate(version.SupportedProtocolRange, clientSupportedProtocolMin, clientSupportedProtocolMax)
	fmt.Printf("negotiation: compatible=%v protocol=%d %s\n", decision.Compatible, decision.Protocol, decision.Reason)
	if !decision.Compatible {
		return &ProtocolMismatchError{Reason: decision.Reason}
	}
	return nil
}

func runSearch(ctx context.Context, client *Client, query string) error {
	titles, err := client.Search(ctx, query)
	if err != nil {
		return err
	}
	for _, title := range titles {
		fmt.Printf("%s\t%s\t%s\t%d\n", title.ID, title.Type, title.Title, title.Year)
	}
	fmt.Printf("total=%d\n", len(titles))
	return nil
}

func runTitle(ctx context.Context, client *Client, titleID string) error {
	title, err := client.TitleDetail(ctx, titleID)
	if err != nil {
		return err
	}
	fmt.Printf("%s\t%s\t%s\t%s\n", title.ID, title.Type, title.Title, title.IMDBID)
	return nil
}

func runEpisodes(ctx context.Context, client *Client, titleID string, season int) error {
	episodes, err := client.Episodes(ctx, titleID, season)
	if err != nil {
		return err
	}
	for _, episode := range episodes {
		fmt.Printf("S%02dE%02d\t%s\t%s\n", episode.Season, episode.Episode, episode.AirDate, episode.Title)
	}
	fmt.Printf("total=%d\n", len(episodes))
	return nil
}

func runResolve(ctx context.Context, client *Client, sourceID string) error {
	result, err := client.Resolve(ctx, sourceID)
	if err != nil {
		return err
	}
	fmt.Printf("magnetUri=%s infoHash=%s\n", result.MagnetURI, result.InfoHash)
	return nil
}

func runStream(ctx context.Context, client *Client, magnet string, fileIndex int) error {
	status, contentRange, body, err := client.StreamRange(ctx, magnet, fileIndex, 0, 1023)
	if err != nil {
		return err
	}
	fmt.Printf("status=%d contentRange=%s bytes=%d\n", status, contentRange, len(body))
	if status != http.StatusPartialContent {
		return fmt.Errorf("expected 206 partial content, got %d", status)
	}
	return nil
}

func runHeartbeat(ctx context.Context, client *Client, subjectID, seriesID string) error {
	if err := client.Heartbeat(ctx, HeartbeatRequest{SubjectID: subjectID, SeriesID: seriesID, Season: 1, Episode: 1, PositionS: 600, DurationS: 1440}); err != nil {
		return err
	}
	fmt.Println("heartbeat ok")
	return nil
}

func runResume(ctx context.Context, client *Client, subjectID, seriesID string) error {
	state, err := client.Resume(ctx, subjectID, seriesID)
	if err != nil {
		return err
	}
	if !state.Found {
		fmt.Println("found=false")
		return nil
	}
	fmt.Printf("found=true seriesId=%s S%02dE%02d position=%.0fs duration=%.0fs\n",
		state.SeriesID, state.Season, state.Episode, state.PositionS, state.DurationS)
	return nil
}

func runJourney(ctx context.Context, client *Client, query, magnet, subjectID, seriesID string) error {
	return client.RunJourney(ctx, query, magnet, subjectID, seriesID)
}
