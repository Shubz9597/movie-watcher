package torrentx

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"torrent-streamer/pkg/types"
)

type TorznabClient struct {
	BaseURL string // e.g. http://localhost:9696
	APIKey  string
	HTTP    *http.Client
}

type torznabFeed struct {
	Channel struct {
		Items []struct {
			Title   string `xml:"title"`
			Link    string `xml:"link"`
			Size    int64  `xml:"size"`
			Seeders int    `xml:"seeders"`
			Peers   int    `xml:"peers"`
			Attrs   []struct {
				Name  string `xml:"name,attr"`
				Value string `xml:"value,attr"`
			} `xml:"attr"`
		} `xml:"item"`
	} `xml:"channel"`
}

func (c *TorznabClient) Query(ctx context.Context, title string, season, episode int, abs *int) ([]types.Candidate, error) {
	if strings.TrimSpace(c.BaseURL) == "" || strings.TrimSpace(c.APIKey) == "" {
		return nil, fmt.Errorf("Prowlarr is not configured")
	}
	q := title
	if abs != nil {
		q = title + " " + pad2(*abs)
	} else if season == 0 && episode == 0 {
		q = title
	} else {
		q = title + " S" + pad2(season) + "E" + pad2(episode)
	}
	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Prowlarr URL: %w", err)
	}
	u.Path = "/api/v1/indexers/all/results/torznab/api"
	v := url.Values{}
	v.Set("apikey", c.APIKey)
	v.Set("t", "search")
	v.Set("q", q)
	u.RawQuery = v.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create Prowlarr request: %w", err)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query Prowlarr: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Prowlarr returned status %d", resp.StatusCode)
	}

	var feed torznabFeed
	if err := xml.NewDecoder(resp.Body).Decode(&feed); err != nil {
		return nil, fmt.Errorf("decode Prowlarr response: %w", err)
	}

	var out []types.Candidate
	for _, it := range feed.Channel.Items {
		attrs := make(map[string]string, len(it.Attrs))
		for _, attr := range it.Attrs {
			attrs[strings.ToLower(attr.Name)] = attr.Value
		}
		ih, magnet := parseLink(firstNonEmptyString(attrs["magneturl"], it.Link))
		if ih == "" {
			ih = strings.ToUpper(strings.TrimSpace(attrs["infohash"]))
		}
		if !validInfoHash(ih) {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(magnet), "magnet:") {
			magnet = "magnet:?xt=urn:btih:" + strings.ToUpper(ih)
		}
		sourceKind := "single"
		lowerTitle := strings.ToLower(it.Title)
		if strings.Contains(lowerTitle, "complete") || strings.Contains(lowerTitle, "batch") || strings.Contains(lowerTitle, "season pack") {
			sourceKind = "season_pack"
		}
		out = append(out, types.Candidate{
			InfoHash: ih, Magnet: magnet, Title: it.Title,
			ReleaseGroup: pickGroup(it.Title),
			Resolution:   pickRes(it.Title),
			Codec:        pickCodec(it.Title),
			Source:       pickSource(it.Title),
			Seeders:      it.Seeders, Leechers: it.Peers, SizeBytes: it.Size,
			ParsedSeason: season, ParsedEpisode: episode,
			SourceKind: sourceKind,
		})
	}
	return out, nil
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func validInfoHash(value string) bool {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) == 40 {
		return strings.IndexFunc(value, func(r rune) bool {
			return !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'F'))
		}) == -1
	}
	if len(value) == 32 {
		return strings.IndexFunc(value, func(r rune) bool {
			return !((r >= 'A' && r <= 'Z') || (r >= '2' && r <= '7'))
		}) == -1
	}
	return false
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}
func pickRes(t string) string {
	t = strings.ToLower(t)
	for _, k := range []string{"2160p", "1080p", "720p", "480p"} {
		if strings.Contains(t, k) {
			return k
		}
	}
	return "1080p"
}
func pickCodec(t string) string {
	t = strings.ToLower(t)
	for _, k := range []string{"av1", "x265", "hevc", "x264", "h264", "hi10p"} {
		if strings.Contains(t, k) {
			if k == "x265" {
				return "hevc"
			}
			if k == "x264" {
				return "h264"
			}
			return k
		}
	}
	return "h264"
}
func pickSource(t string) string {
	t = strings.ToLower(t)
	if strings.Contains(t, "web-dl") {
		return "WEB-DL"
	}
	if strings.Contains(t, "webrip") {
		return "WEBRip"
	}
	if strings.Contains(t, "hdtv") {
		return "HDTV"
	}
	if strings.Contains(t, "bluray") {
		return "BluRay"
	}
	return "WEBRip"
}
func pickGroup(t string) string {
	parts := strings.Split(t, "-")
	if len(parts) > 1 {
		return strings.TrimSpace(parts[len(parts)-1])
	}
	return ""
}

func parseLink(link string) (string, string) {
	l := strings.ToLower(link)
	if strings.HasPrefix(l, "magnet:") {
		if i := strings.Index(l, "btih:"); i >= 0 && len(l) >= i+45 {
			return strings.ToUpper(l[i+5 : i+45]), link
		}
	}
	return "", link
}
