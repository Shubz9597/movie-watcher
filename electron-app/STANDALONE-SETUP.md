# Making Electron App Standalone (No Next.js Required)

## Current Architecture

**Right now:**
- Electron app → calls Next.js API routes → Next.js calls external APIs
- Requires Next.js running on `localhost:3000`

## Standalone Architecture

**After migration:**
- Electron app → calls external APIs directly (TMDb, Prowlarr, Jikan)
- No Next.js needed!

## What Needs to Be Moved

### 1. API Services (Created)
- ✅ `src/lib/services/tmdb-service.ts` - TMDb API calls
- ✅ `src/lib/services/prowlarr-service.ts` - Prowlarr/torrent API calls  
- ✅ `src/lib/services/jikan-service.ts` - Jikan/anime API calls

### 2. Environment Variables
Create `.env` file in `electron-app/`:
```env
TMDB_API_KEY=your_tmdb_key
TMDB_ACCESS_TOKEN=your_tmdb_token
PROWLARR_URL=http://localhost:9696
PROWLARR_API_KEY=your_prowlarr_key
```

### 3. Update Components
Replace Next.js API calls with direct service calls:
- `HomePage.tsx` - Use `tmdb-service.getMovies()` instead of `/api/tmdb/movies`
- `GlobalSearch.tsx` - Use `tmdb-service.searchMulti()` instead of `/api/tmdb/multi`
- `TorrentPanel.tsx` - Use `prowlarr-service.searchMovieTorrents()` instead of `/api/torrents/movie`
- `TitlePage.tsx` - Use `tmdb-service.getMovie()` / `jikan-service.getAnime()` instead of API routes

### 4. Data Adapters
Move data transformation logic from Next.js:
- `lib/adapters/media.ts` - Transform TMDb/Jikan responses
- `lib/adapters/tmdb.ts` - TMDb-specific adapters

## Benefits

✅ **No Next.js dependency** - App runs completely standalone  
✅ **Faster** - No extra HTTP hop through Next.js  
✅ **Simpler** - One less service to run  
✅ **Portable** - Just Electron app + Go backend  

## Migration Steps

1. **Install dependencies:**
   ```bash
   npm install fast-xml-parser  # For parsing Prowlarr XML
   ```

2. **Set up environment variables:**
   - Copy `.env.example` to `.env`
   - Add your API keys

3. **Update components:**
   - Replace fetch calls to `/api/*` with service calls
   - Update data transformation to match Next.js adapters

4. **Test:**
   - Verify all features work without Next.js
   - Check API rate limits (TMDb, Jikan have limits)

## Notes

- **API Keys**: Store securely (Electron has secure storage options)
- **Rate Limits**: TMDb (40 req/10s), Jikan (3 req/sec) - may need caching
- **CORS**: Not an issue in Electron (no browser CORS restrictions)
- **Go Backend**: Still needed for streaming (`localhost:4001`)

Would you like me to complete the migration? I can:
1. Update all components to use the new services
2. Move data adapters from Next.js
3. Set up environment variable handling
4. Add caching for rate limit protection



