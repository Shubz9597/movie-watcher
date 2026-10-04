package search

import "testing"

// Real release names from the live indexers. Each case pins one way a public
// tracker mislabels or crowds a search.

func TestDecideRealReleases(t *testing.T) {
	t.Parallel()
	number := func(value int) *int { return &value }
	demonSlayerTMDb := []string{
		"Demon Slayer", "Kimetsu no Yaiba", "Demon Slayer - Kimetsu no Yaiba", "Guardianes de la noche: Kimetsu no Yaiba",
		"Kimetsu no Yaiba: Yuukaku-hen", "Kimetsu no Yaiba: Katanakaji no Sato-hen", "Kimetsu no Yaiba Katanakaji no Sato Hen",
		"Kimetsu no Yaiba: Mugen Ressha-hen", "Demon Slayer: Kimetsu no Yaiba Entertainment District Arc",
	}
	demonSlayerS1 := Request{Kind: KindAnime, Title: "Demon Slayer: Kimetsu no Yaiba", Aliases: demonSlayerTMDb,
		Season: number(1), Episode: number(1), Absolute: number(1), OriginalLanguage: "ja"}
	entertainmentDistrict := Request{Kind: KindAnime, Title: "Demon Slayer: Kimetsu no Yaiba Entertainment District Arc",
		Aliases: []string{"Kimetsu no Yaiba: Yuukaku-hen", "KnY 2"}, Season: number(1), Episode: number(5), Absolute: number(5), OriginalLanguage: "ja"}
	frierenS1 := Request{Kind: KindAnime, Title: "Frieren: Beyond Journey’s End", Aliases: []string{"Sousou no Frieren"},
		Season: number(1), Episode: number(5), Absolute: number(5), OriginalLanguage: "ja"}
	severance := Request{Kind: KindTV, Title: "Severance", Aliases: []string{"Ruptura"}, Season: number(1), Episode: number(1), Year: 2022, OriginalLanguage: "en"}
	wireS3 := Request{Kind: KindTV, Title: "The Wire", Season: number(3), Episode: number(2), Year: 2002, OriginalLanguage: "en"}
	officeUS := Request{Kind: KindTV, Title: "The Office", Aliases: []string{"The Office (US)"}, Season: number(2), Episode: number(1), Year: 2005, OriginalLanguage: "en"}
	interstellar := Request{Kind: KindMovie, Title: "Interstellar", Year: 2014, OriginalLanguage: "en"}
	threeIdiots := Request{Kind: KindMovie, Title: "3 Idiots", Year: 2009, OriginalLanguage: "hi"}
	dune := Request{Kind: KindMovie, Title: "Dune", Year: 2021, OriginalLanguage: "en"}

	tests := []struct {
		name    string
		request Request
		title   string
		accept  bool
		pack    packKind
	}{
		{"later arc is not season 1", demonSlayerS1, "[SubsPlease] Kimetsu no Yaiba - Katanakaji no Sato-hen - 01 (1080p)", false, packNone},
		{"arc batch is not season 1", demonSlayerS1, "[SubsPlease] Kimetsu no Yaiba Yuukaku hen (01 11) (1080p) [Batch]", false, packNone},
		{"anime film is not an episode", demonSlayerS1, "[SubsPlease] Kimetsu no Yaiba Movie 1 - Mugenjou-hen - Akaza Sairai - (1080p)", false, packNone},
		{"parenthetical alt title keeps the arc", demonSlayerS1, "[YakuboEncodes] Kimetsu No Yaiba (Demon Slayer) Entertainment District Arc 01 [1080p 10bit]", false, packNone},
		{"season 1 pack", demonSlayerS1, "[BlackRabbit] Demon Slayer - Kimetsu no Yaiba (2019) - S01 [Bluray-1080p][Opus 2.0][Dual Audio]", true, packSeason},
		{"multi-season pack covers season 1", demonSlayerS1, "[Trix] Kimetsu no Yaiba S01-05 [Dual Audio] [Multi Subs] (BD 1080p AV1)", true, packMultiSeason},
		{"french subtitles are dropped", demonSlayerS1, "Demon Slayer Kimetsu no Yaiba S01E01 VOSTFR 1080p WEB H.264 AAC -Tsundere-Raws (CR)", false, packNone},
		{"chinese subtitles are dropped", demonSlayerS1, "[CoolComic404][Kimetsu no Yaiba][01][1080P][WebRip][CHS JPN][HEVC 10bit AAC]", false, packNone},
		{"arc entry matches its own arc", entertainmentDistrict, "[SubsPlease] Kimetsu no Yaiba - Yuukaku-hen - 05 (1080p)", true, packNone},
		{"arc entry range", entertainmentDistrict, "[SubsPlease] Kimetsu no Yaiba - Yuukaku-hen - 01-11 (1080p)", true, packEpisodeRange},
		{"arc entry rejects the base show", entertainmentDistrict, "[SubsPlease] Kimetsu no Yaiba - 05 (1080p)", false, packNone},
		{"season 2 marker", frierenS1, "[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [6AAEC79A].mkv", false, packNone},
		{"ordinal season 2", frierenS1, "[Erai-raws] Sousou no Frieren 2nd Season - 05 [1080p CR WEB-DL AVC AAC]", false, packNone},
		{"season 1 episode", frierenS1, "[SubsPlease] Sousou no Frieren - 05 (1080p)", true, packNone},
		{"hyphenated season 2", frierenS1, "[Erai-raws]-Sousou-no-Frieren-2nd-Season--05-[1080p-CR-WEB-DL-AVC-AAC]", false, packNone},
		{"hyphenated range", demonSlayerS1, "[KaiDubs]-Demon-Slayer-(Kimetsu-no-Yaiba)--01-09-[1080p]-[English-Dub]", true, packEpisodeRange},
		{"season 1 batch", frierenS1, "[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]", true, packEpisodeRange},
		{"raw group", frierenS1, "[AsukaRaws] Sousou no Frieren - 05 (BD 1280x720 x264 AAC)", false, packNone},
		{"english dub allowed", frierenS1, "Frieren.Beyond.Journeys.End.S01E05.DUBBED.1080p.WEB.H264-SKYANiME", true, packNone},
		{"different show with the title in its episode name", severance, "Castle Rock S01E01 Severance 1080p WEBRip 2CH x265 HEVC-PSA", false, packNone},
		{"different show, EZTV keyword match", severance, "Law and Order S02E13 Severance 1080p HEVC x265-MeGusta", false, packNone},
		{"film sharing the title", severance, "Severance (2006) 1080p BRRip x264 -YTS", false, packNone},
		{"exact episode", severance, "Severance S01E01 Good News About Hell 1080p BluRay 10Bit DDP5 1 H265-d3g", true, packNone},
		{"other season pack", severance, "Severance Season 2 COMPLETE 720p ATVP WEB DL x264 S02 Full MIKE", false, packNone},
		{"season range pack", wireS3, "The.Wire.S01-S05.COMPLETE.SERIES.1080p.Bluray.x265-HiQVE", true, packMultiSeason},
		{"tight season range", wireS3, "The Wire (2002) S01-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1)", true, packMultiSeason},
		{"season list is not episodes", wireS3, "The Wire S01, 2, 3, 4 & 5 Complete Collection DVD Box Set H", true, packMultiSeason},
		{"seasons in words", wireS3, "The Wire 2002 Complete Series Seasons 1 to 5 1080p WEB x264 [i_c]", true, packMultiSeason},
		{"different show containing the title", wireS3, "Wire in the Blood 2002 S01-S06 720p WEB-DL HEVC x265 BONE", false, packNone},
		{"other season", wireS3, "The.Wire.S02.1080p.BluRay.x265", false, packNone},
		{"UK version", officeUS, "The.Office.UK.S02.1080p.HMAX.WEBRip.DD2.0.x264-pawel2006", false, packNone},
		{"US version", officeUS, "The Office US S02E01 The Dundies 1080p Extended Cut AMZN WEB-DL DDP5 1 H 264", true, packNone},
		{"series year mismatch", officeUS, "The Office 2001 S02 1080p WEB-DL", false, packNone},
		{"YTS film", interstellar, "Interstellar (2014) 1080p BRRip x264 -YTS", true, packNone},
		{"IMAX edition", interstellar, "Interstellar 2014 IMAX 1080p BluRay HEVC x265 5 1 BONE", true, packNone},
		{"documentary about the film", interstellar, "The Science of Interstellar (2014) 1080p BRRip x264 -YTS", false, packNone},
		{"hindi dub of an english film", interstellar, "Interstellar 2014 Hindi Dubbed 1080p WEBRip", false, packNone},
		{"french multi remux", interstellar, "Interstellar.2014.MULTI.VFF.1080p.BluRay.REMUX.DTS.HD.MA.5.1.AVC-Asgar", true, packNone},
		{"hindi original", threeIdiots, "3 Idiots 2009 1080p BluRay x264 Hindi AAC -Ozlem", true, packNone},
		{"cam rip", threeIdiots, "3 IDIOTS 2009 HINDI CAMRIP nEHAL", false, packNone},
		{"pre-dvd rip", threeIdiots, "3 Idiots 2009 Pre DVDRip 1CD Hindi Eng SuBs nEHAL", false, packNone},
		{"tv episode sharing words", threeIdiots, "Three.Idiots.in.Kenya.S01E03.1080p.WEB.h264-EDITH", false, packNone},
		{"3D release", dune, "Dune 2021 1080p 3D BluRay AAC5 1 [YTS MX]", false, packNone},
		{"sequel", dune, "Dune Part Two 2024 1080p WEBRip x264", false, packNone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			decision := decideRelease(test.request, buildKnownTitles(test.request), prowlarrRelease{Title: test.title})
			if decision.reject == test.accept {
				t.Fatalf("decideRelease(%q) reject = %t, want accept = %t", test.title, decision.reject, test.accept)
			}
			if test.accept && decision.pack != test.pack {
				t.Errorf("decideRelease(%q) pack = %d, want %d", test.title, decision.pack, test.pack)
			}
		})
	}
}

func TestParseSeasonsDoNotReadAnimeEpisodesAsSeasons(t *testing.T) {
	t.Parallel()
	parsed := parseRelease("[SubsPlease] Sousou no Frieren S2 - 05 (720p)", map[string]bool{"sousou": true, "no": true, "frieren": true})
	if len(parsed.seasons) != 1 || !parsed.seasons[2] {
		t.Fatalf("seasons = %v, want only season 2", parsed.seasons)
	}
	if len(parsed.absolutes) != 1 || parsed.absolutes[0] != 5 {
		t.Fatalf("absolutes = %v, want [5]", parsed.absolutes)
	}
}

func TestMoviesRankBySeedersWithTrustOnlyForNearTies(t *testing.T) {
	t.Parallel()
	service := newTestService(t, "http://127.0.0.1:9696")
	request := Request{Kind: KindMovie, Title: "Interstellar", Year: 2014, OriginalLanguage: "en"}
	releases := []prowlarrRelease{
		{Title: "Interstellar (2014) 1080p BRRip x264 -YTS", Indexer: "YTS", Protocol: "torrent", InfoHash: idHex('y'), Seeders: 100},
		{Title: "Interstellar 2014 1080p BluRay x265-GRP", Indexer: "TorrentDownload", Protocol: "torrent", InfoHash: idHex('t'), Seeders: 189},
		{Title: "Interstellar 2014 1080p WEB-DL x264-NEAR", Indexer: "TorrentDownload", Protocol: "torrent", InfoHash: idHex('n'), Seeders: 95},
	}
	results := service.normalize(request, releases)
	if len(results) != 3 || results[0].Seeders != 189 || results[1].Indexer != "YTS" {
		t.Fatalf("order = %v, want most seeded first, then YTS winning the near tie", []int{results[0].Seeders, results[1].Seeders, results[2].Seeders})
	}
}

// A one-letter difference is a spelling of the same show, not an arc: "Dragon
// Ball Z Kai" releases belong to a "Dragon Ball Kai" season 1 search.
func TestSingleLetterAliasIsNotAnArc(t *testing.T) {
	t.Parallel()
	number := func(value int) *int { return &value }
	request := Request{Kind: KindAnime, Title: "Dragon Ball Kai", Aliases: []string{"Dragon Ball Z Kai"},
		Season: number(1), Episode: number(1), Absolute: number(1), OriginalLanguage: "ja"}
	known := buildKnownTitles(request)
	if len(known.arcs) != 0 {
		t.Fatalf("arcs = %v; want none", known.arcs)
	}
	decision := decideRelease(request, known, prowlarrRelease{Title: "[Chotab] Dragon Ball Z Kai (2009) - 01 (BD 720p) [Dual-Audio]"})
	if decision.reject || !decision.episodeMatch {
		t.Fatalf("decision = %+v; want an episode match", decision)
	}
}
