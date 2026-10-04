package main
import("context";"encoding/json";"net/http";"os";"time";"torrent-streamer/internal/catalog")
func main(){
 for _, kind := range []string{"search-anime","anime-detail","anime-episodes"} {
  s:=catalog.NewService(buildCatalogProviders(&http.Client{Timeout:8*time.Second}),catalog.Options{})
  for attempt:=1;attempt<=2;attempt++ {
   start:=time.Now();count:=0;found:=false;var degraded []string
   switch kind {
   case "search-anime": r:=s.Search(context.Background(),catalog.SearchQuery{Query:"Frieren",Type:catalog.TypeAnime,Limit:24}); count=len(r.Titles);degraded=r.DegradedProviders
   case "anime-detail": r:=s.Detail(context.Background(),"anilist:154587");found=r.Found;degraded=r.DegradedProviders
   case "anime-episodes": r:=s.Episodes(context.Background(),"anilist:154587",1); count=len(r.Episodes);degraded=r.DegradedProviders
   }
   json.NewEncoder(os.Stdout).Encode(map[string]any{"endpoint":kind,"attempt":attempt,"seconds":time.Since(start).Seconds(),"count":count,"found":found,"providers":degraded})
  }
  s.Close()
 }
}
func buildCatalogProviders(client *http.Client) []catalog.Provider {
	var providers []catalog.Provider
	apiKey, accessToken := os.Getenv("TMDB_API_KEY"), os.Getenv("TMDB_ACCESS_TOKEN")
	if apiKey != "" || accessToken != "" {
		providers = append(providers, catalog.NewTMDb(catalog.TMDbOptions{
			BaseURL:     envOr("TORWATCH_TMDB_BASE_URL", ""),
			APIKey:      apiKey,
			AccessToken: accessToken,
			HTTP:        client,
		}))
	}
	providers = append(providers,
		catalog.NewAniList(catalog.AniListOptions{BaseURL: envOr("TORWATCH_ANILIST_BASE_URL", ""), HTTP: client}),
		catalog.NewJikan(catalog.JikanOptions{BaseURL: envOr("TORWATCH_JIKAN_BASE_URL", ""), HTTP: client}),
		catalog.NewCinemeta(catalog.CinemetaOptions{BaseURL: envOr("TORWATCH_CINEMETA_BASE_URL", ""), HTTP: client}),
		catalog.NewAniZip(catalog.AniZipOptions{BaseURL: envOr("TORWATCH_ANIZIP_BASE_URL", ""), HTTP: client}),
	)
	return providers
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

