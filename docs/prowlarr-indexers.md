# Manage TorWatch search sources with Prowlarr

Prowlarr is TorWatch's advanced search-source manager. It controls which indexers are searched for movies, series, and anime.

## What TorWatch configures

During startup, TorWatch checks whether Prowlarr has any indexers. If it is completely empty, TorWatch adds a broad public, no-login starter set when the definitions are available:

- Movies and series: YTS, Knaben, TorrentDownload, The Pirate Bay, and LimeTorrents.
- Anime: Nyaa.si and SubsPlease.

If one or more indexers already exist, TorWatch leaves all of them unchanged.

The starter sources use a grab limit of 15 where the indexer exposes that setting. Where supported, the minimum is one seeder for anime specialists, two for broad sources, and three for YTS. Magnet links are preferred where the source supports them. YTS, Nyaa.si, and SubsPlease have higher search priority for their specialties. These are only initial values; change them at any time in Prowlarr.

1337x is intentionally not enabled by the starter setup. In the tested setup it needed FlareSolverr and could take 5–17 seconds for one request, so including it in every search delayed the complete result list. Add it manually as a disabled, on-demand source if its extra coverage is worth that delay. EZTV is also omitted because its current Cloudflare challenge did not pass through the tested FlareSolverr setup.

TorWatch removes exact duplicate torrents by info hash. If public sites mirror the same release without exposing a hash, it also collapses records with the same normalized release name and byte size, keeping the copy with more seeders and preferring a direct magnet.

When a torrent was previously played for the same movie or episode, TorWatch places it first and marks it **Previously used**. The saved magnet remains available from playback history even when an indexer no longer includes it in its current results; if that torrent has gone offline, choose the next ranked source.

Source availability can vary by country and over time. Only use sources and content you are legally allowed to access.

## Open Prowlarr

Keep TorWatch services running, then either:

- Open **TorWatch Settings > Search sources > Open Prowlarr**.
- Visit [http://127.0.0.1:9696](http://127.0.0.1:9696) on the same computer.

Prowlarr is intentionally local-only. Other devices cannot open this address.

## Add an indexer

1. Open **Indexers** in Prowlarr.
2. Select **Add Indexer**.
3. Choose a source and enter any details it requires.
4. Select **Test**.
5. Select **Save** after the test succeeds.

Public sources usually need no account. Private sources may require credentials, cookies, or an invite supplied by that source.

## Change or remove an indexer

Open **Indexers**, select the source, then change its settings, disable it, or delete it. Test an edited source before saving whenever possible. Changes take effect in later TorWatch searches; no app reinstall is required.

## Important settings

- Do not change Prowlarr's port unless TorWatch is also configured to use the new port.
- Do not rotate Prowlarr's API key while TorWatch is open. If you do rotate it, fully restart TorWatch so it can read the new key.
- A minimum seeder value that is too high can hide otherwise valid results.
- Some sources may require FlareSolverr when their anti-bot protection is active.

## If searches return no results

1. Confirm at least one suitable indexer is enabled.
2. Open each indexer and run **Test**.
3. Check whether your VPN, DNS, firewall, or region blocks the source.
4. Try another enabled source for the same content type.
5. Restart TorWatch after changing Prowlarr's API key or port.
