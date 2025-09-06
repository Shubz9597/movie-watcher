package torrentx

import (
	"encoding/xml"
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
		} `xml:"item"`
	} `xml:"channel"`
}

func (c *TorznabClient) Query(title string, season, episode int, abs *int) ([]types.Candidate, error) {
	q := title
	if abs != nil {
		q = title + " " + pad2(*abs)
	} else {
		q = title + " S" + pad2(season) + "E" + pad2(episode)
	}
	u, _ := url.Parse(c.BaseURL)
	u.Path = "/api/v1/indexers/all/results/torznab/api"
	v := url.Values{}
	v.Set("apikey", c.APIKey)
	v.Set("t", "search")
	v.Set("q", q)
	u.RawQuery = v.Encode()

	req, _ := http.NewRequest("GET", u.String(), nil)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var feed torznabFeed
	if err := xml.NewDecoder(resp.Body).Decode(&feed); err != nil {
		return nil, err
	}

	var out []types.Candidate
	for _, it := range feed.Channel.Items {
		ih, magnet := parseLink(it.Link)
		out = append(out, types.Candidate{
			InfoHash: ih, Magnet: magnet, Title: it.Title,
			ReleaseGroup: pickGroup(it.Title),
			Resolution:   pickRes(it.Title),
			Codec:        pickCodec(it.Title),
			Source:       pickSource(it.Title),
			Seeders:      it.Seeders, Leechers: it.Peers, SizeBytes: it.Size,
			ParsedSeason: season, ParsedEpisode: episode,
			SourceKind: "single",
		})
	}
	return out, nil
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
			return l[i+5 : i+45], link
		}
	}
	return "", link
}
