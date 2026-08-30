# Troubleshooting Guide

## Logs to attach to a bug report

After reproducing the problem, open the diagnostic folder in PowerShell:

```powershell
explorer "$env:APPDATA\TorWatch\logs"
```

Attach `errors.log` first, then attach the `source_log` named by the relevant correlated entry. The frontend file records Electron/React context; the backend file records Go context and is not restricted by the console allow-list. Rotated history is stored as `.1`, `.2`, and `.3` files.

## API Keys Not Loading from .env

### Check .env File Location
Make sure `.env` file is in the `electron-app/` directory (same level as `package.json`):
```
electron-app/
  ├── .env          ← Should be here
  ├── package.json
  ├── main.js
  └── ...
```

### Check .env File Format
Your `.env` file should look like this (no quotes, no spaces around `=`):
```env
TMDB_API_KEY=your_key_here
TMDB_ACCESS_TOKEN=your_token_here
```

**Common mistakes:**
- ❌ `TMDB_API_KEY = "key"` (spaces and quotes)
- ✅ `TMDB_API_KEY=key` (no spaces, no quotes)

### Check Console Logs
When you start the app, check the Electron console (main process) for:
```
[Config] Loaded .env file from: D:\Projects\movie-watcher\electron-app\.env
[Config] Found keys: TMDB_API_KEY, TMDB_ACCESS_TOKEN, ...
[Config] Configuration status: { hasTmdbKey: true }
```

If you see warnings, the .env file isn't being loaded.

### Restart After Changes
After creating/modifying `.env` file:
1. Stop the app completely
2. Restart: `npm run dev`

## Global Search Modal Not Opening

### Check Browser Console
Open DevTools (F12) and check for errors:
- Missing imports
- Radix UI errors
- React errors

### Test Click Handler
1. Click the search button in header
2. Check console for any errors
3. Try Cmd/Ctrl+K keyboard shortcut

### Verify Components
The Dialog and Command components should be imported from:
```typescript
import { Dialog, DialogContent, DialogTitle } from '../../../tor-watcher/components/ui/dialog';
import { Command, CommandInput, ... } from '../../../tor-watcher/components/ui/command';
```

### Check Radix UI Installation
Make sure these are installed:
```bash
npm list @radix-ui/react-dialog
npm list cmdk
```

## Still Having Issues?

1. **Clear cache and reinstall:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. **Check Electron console:**
   - Look for `[Config]` messages
   - Check for any error messages

3. **Verify API keys work:**
   Test TMDb API directly:
   ```bash
   curl "https://api.themoviedb.org/3/search/movie?api_key=YOUR_KEY&query=test"
   ```

4. **Check file paths:**
   - Make sure `.env` is in `electron-app/` directory
   - Check that `main.js` can find the file



