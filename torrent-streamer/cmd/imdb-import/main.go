// Command imdb-import refreshes the PostgreSQL IMDb ratings cache on demand.
package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"

	"torrent-streamer/internal/imdb"
	"torrent-streamer/migrations"
)

func main() {
	_ = godotenv.Load(".env", "../infra/prowlarr.env")
	dsn := os.Getenv("PG_DSN")
	if dsn == "" {
		log.Fatal("PG_DSN missing")
	}
	database, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("open PostgreSQL: %v", err)
	}
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	if err := database.PingContext(ctx); err != nil {
		log.Fatalf("connect to PostgreSQL: %v", err)
	}
	if err := migrations.Apply(ctx, database); err != nil {
		log.Fatalf("apply migrations: %v", err)
	}
	result, err := imdb.NewStore(database).RefreshIfDue(
		ctx,
		&http.Client{Timeout: 15 * time.Minute},
		os.Getenv("IMDB_RATINGS_URL"),
		time.Now(),
		0,
	)
	if err != nil {
		log.Fatalf("refresh IMDb ratings: %v", err)
	}
	if result.Updated {
		log.Printf("imported %d current IMDb ratings", result.RowCount)
		return
	}
	log.Print("IMDb ratings are already current")
}
