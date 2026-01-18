# API Keys Setup Guide

## Quick Setup

The Electron app needs API keys to work. You have two options:

### Option 1: Environment Variables (Recommended for Development)

Create a `.env` file in the `electron-app/` directory:

```env
TMDB_API_KEY=your_tmdb_api_key_here
TMDB_ACCESS_TOKEN=your_tmdb_access_token_here
PROWLARR_URL=http://localhost:9696
PROWLARR_API_KEY=your_prowlarr_api_key_here
```

**Note:** The main process will read these and store them securely.

### Option 2: In-App Settings (Coming Soon)

A settings UI will be added to configure API keys directly in the app.

## Getting API Keys

### TMDb (The Movie Database)

1. Go to https://www.themoviedb.org/
2. Create an account
3. Go to Settings → API
4. Request an API key
5. Copy either:
   - **API Key** (v3 auth) - Use as `TMDB_API_KEY`
   - **Access Token** (v4 auth) - Use as `TMDB_ACCESS_TOKEN`
   - You only need ONE of these (Access Token is preferred)

### Prowlarr

1. Install and run Prowlarr (https://github.com/Prowlarr/Prowlarr)
2. Go to Settings → General
3. Copy the **API Key**
4. Use your Prowlarr URL (usually `http://localhost:9696`)

## Testing Your Setup

After setting up API keys:

1. Start the app: `npm run dev`
2. Open DevTools (if enabled) and check console
3. Try searching for a movie (Cmd/Ctrl+K)
4. If you see 401 errors, check:
   - API keys are set correctly
   - No extra spaces in keys
   - TMDb key has proper permissions

## Troubleshooting

### "TMDb API authentication failed"
- Check your `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` is set
- Verify the key is correct (no extra spaces)
- Make sure you're using v3 API key or v4 access token

### "Prowlarr not configured"
- Check `PROWLARR_URL` and `PROWLARR_API_KEY` are set
- Verify Prowlarr is running
- Test Prowlarr API: `curl http://localhost:9696/api/v1/indexer?apikey=YOUR_KEY`

### Global Search Not Working
- Check browser console for errors
- Verify shadcn components are loading (Dialog, Command)
- Check if API keys are properly loaded (see console logs)

## Security Notes

- API keys are stored in Electron's secure storage (encrypted by OS)
- In development, they're also read from `.env` file
- Never commit `.env` file to git
- The `.env` file is already in `.gitignore`



