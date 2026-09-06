package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Playback journey over the public V1 surface (T047): resolve → ranged
// stream → heartbeat → resume. Only public endpoints; the ranged GET asserts
// the 206/Content-Range contract the players depend on.

type ResolveResult struct {
	MagnetURI string `json:"magnetUri"`
	InfoHash  string `json:"infoHash,omitempty"`
}

// Resolve turns a torrent-search sourceId into a playable magnet.
func (c *Client) Resolve(ctx context.Context, sourceID string) (ResolveResult, error) {
	body := strings.NewReader(`{"sourceId":` + jsonString(sourceID) + `}`)
	resp, err := c.do(ctx, http.MethodPost, "/v1/torrents/resolve", body, "application/json")
	if err != nil {
		return ResolveResult{}, err
	}
	var result ResolveResult
	if err := decodeJSON(resp, &result); err != nil {
		return ResolveResult{}, err
	}
	return result, nil
}

// StreamRange performs one ranged GET against /stream and returns the status
// code, Content-Range, and body bytes.
func (c *Client) StreamRange(ctx context.Context, magnet string, fileIndex int, start, end int64) (int, string, []byte, error) {
	path := "/stream?cat=movie&magnet=" + url.QueryEscape(magnet)
	if fileIndex >= 0 {
		path += "&fileIndex=" + strconv.Itoa(fileIndex)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, "", nil, err
	}
	return resp.StatusCode, resp.Header.Get("Content-Range"), body, nil
}

type HeartbeatRequest struct {
	SubjectID string  `json:"subjectId"`
	SeriesID  string  `json:"seriesId"`
	Season    int     `json:"season"`
	Episode   int     `json:"episode"`
	PositionS float64 `json:"position_s"`
	DurationS float64 `json:"duration_s"`
	ClientID  string  `json:"clientId,omitempty"`
	SessionID string  `json:"sessionId,omitempty"`
	Seq       int     `json:"seq,omitempty"`
}

// Heartbeat reports playback progress. clientId is opaque correlation
// metadata (FR-013), never authentication.
func (c *Client) Heartbeat(ctx context.Context, request HeartbeatRequest) error {
	if request.ClientID == "" {
		request.ClientID = c.ClientID
	}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	resp, err := c.do(ctx, http.MethodPost, "/v1/session/heartbeat", strings.NewReader(string(body)), "application/json")
	if err != nil {
		return err
	}
	var payload struct {
		OK      bool   `json:"ok"`
		Ignored string `json:"ignored,omitempty"`
	}
	return decodeJSON(resp, &payload)
}

type ResumeState struct {
	Found     bool    `json:"found"`
	SeriesID  string  `json:"seriesId,omitempty"`
	Season    int     `json:"season,omitempty"`
	Episode   int     `json:"episode,omitempty"`
	PositionS float64 `json:"position_s,omitempty"`
	DurationS float64 `json:"duration_s,omitempty"`
	Percent   float64 `json:"percent,omitempty"`
}

// Resume reads the shared household progress (15 s rewind applied by the
// server). Progress saved by any client under the same subject is visible
// here (SC-002).
func (c *Client) Resume(ctx context.Context, subjectID, seriesID string) (ResumeState, error) {
	var state ResumeState
	path := "/v1/resume?subjectId=" + url.QueryEscape(subjectID) + "&seriesId=" + url.QueryEscape(seriesID) + "&clientId=" + c.ClientID
	resp, err := c.do(ctx, http.MethodGet, path, nil, "")
	if err != nil {
		return ResumeState{}, err
	}
	err = decodeJSON(resp, &state)
	return state, err
}

// RunJourney completes the full SC-001 journey: negotiate → search → detail
// → episodes → resolve → ranged stream → heartbeat → resume.
func (c *Client) RunJourney(ctx context.Context, query, magnet, subjectID, seriesID string) error {
	fmt.Printf("[journey] client=%s base=%s\n", c.ClientID, c.BaseURL)

	if err := c.EnsureCompatible(ctx); err != nil {
		return err
	}
	fmt.Println("[journey] 1. protocol negotiation: compatible")

	titles, err := c.Search(ctx, query)
	if err != nil {
		return fmt.Errorf("search: %w", err)
	}
	if len(titles) == 0 {
		return errNoSource
	}
	fmt.Printf("[journey] 2. search: %d results (first: %s)\n", len(titles), titles[0].ID)

	detail, err := c.TitleDetail(ctx, titles[0].ID)
	if err != nil {
		return fmt.Errorf("detail: %w", err)
	}
	fmt.Printf("[journey] 3. detail: %s (%s)\n", detail.Title, detail.Type)

	episodes, err := c.Episodes(ctx, titles[0].ID, 1)
	if err != nil {
		return fmt.Errorf("episodes: %w", err)
	}
	fmt.Printf("[journey] 4. episodes: %d for season 1\n", len(episodes))

	if magnet == "" {
		return fmt.Errorf("journey requires -magnet (streaming needs a torrent fixture)")
	}
	status, contentRange, body, err := c.StreamRange(ctx, magnet, -1, 0, 1023)
	if err != nil {
		return fmt.Errorf("stream: %w", err)
	}
	if status != http.StatusPartialContent || len(body) != 1024 {
		return fmt.Errorf("stream range: status=%d bytes=%d (want 206/1024) content-range=%q", status, len(body), contentRange)
	}
	fmt.Printf("[journey] 5. stream: 206 %s (%d bytes)\n", contentRange, len(body))

	if err := c.Heartbeat(ctx, HeartbeatRequest{SubjectID: subjectID, SeriesID: seriesID, Season: 1, Episode: 1, PositionS: 600, DurationS: 1440}); err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	fmt.Println("[journey] 6. heartbeat: ok (position 600s)")

	state, err := c.Resume(ctx, subjectID, seriesID)
	if err != nil {
		return fmt.Errorf("resume: %w", err)
	}
	if !state.Found {
		return fmt.Errorf("resume: not found after heartbeat")
	}
	fmt.Printf("[journey] 7. resume: found position=%.0fs (shared subject)\n", state.PositionS)
	return nil
}

func jsonString(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}
