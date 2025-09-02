package buffer

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/torrentx"
)

type playState string

const (
	StatePlaying playState = "playing"
	StatePaused  playState = "paused"
)

type Key struct {
	Cat  string
	IH   string
	FIdx int
}

type Controller struct {
	mu             sync.Mutex
	state          playState
	playhead       int64
	rollingBps     int64
	targetAheadSec int64

	// warmer control
	warmCtx    context.Context
	warmCancel context.CancelFunc
}

var (
	bufMu    sync.Mutex
	ctrls    = map[Key]*Controller{}
	firstHit = struct {
		sync.Mutex
		m map[Key]bool
	}{m: make(map[Key]bool)}
)

func key(cat string, ih metainfo.Hash, fidx int) Key {
	return Key{Cat: cat, IH: ih.HexString(), FIdx: fidx}
}

func Get(k Key) *Controller {
	bufMu.Lock()
	defer bufMu.Unlock()
	if c, ok := ctrls[k]; ok {
		return c
	}
	c := &Controller{
		state:          StatePlaying,
		rollingBps:     24_000_000 / 8, // 3 MB/s fallback
		targetAheadSec: config.TargetPlaySec(),
	}
	ctrls[k] = c
	return c
}

func (c *Controller) State() playState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

func (c *Controller) SetState(ps playState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = ps
	if ps == StatePlaying {
		c.targetAheadSec = config.TargetPlaySec()
	} else {
		c.targetAheadSec = config.TargetPauseSec()
	}
}

func (c *Controller) SetPlayhead(pos int64) {
	c.mu.Lock()
	c.playhead = pos
	c.mu.Unlock()
}

func (c *Controller) Playhead() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.playhead
}

func (c *Controller) UpdateThroughput(bytes, millis int64) {
	if millis <= 0 || bytes <= 0 {
		return
	}
	obs := (bytes * 1000) / millis
	if obs <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rollingBps == 0 {
		c.rollingBps = obs
		return
	}
	c.rollingBps = (c.rollingBps*7 + obs*3) / 10
}

func (c *Controller) TargetBytes() int64 {
	c.mu.Lock()
	bps := c.rollingBps
	sec := c.targetAheadSec
	c.mu.Unlock()
	if bps <= 0 {
		bps = 24_000_000 / 8
	}
	if bps < (24_000_000 / 8) {
		sec = sec + sec/3 // +33% when slow swarm
	}
	return bps * sec
}

func (c *Controller) TargetAheadSeconds() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.targetAheadSec
}

func (c *Controller) SetTargetSeconds(playSec, pauseSec int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == StatePlaying {
		c.targetAheadSec = playSec
	} else {
		c.targetAheadSec = pauseSec
	}
}

func IsFirstHit(k Key) bool {
	firstHit.Lock()
	defer firstHit.Unlock()
	if !firstHit.m[k] {
		firstHit.m[k] = true
		return true
	}
	return false
}

// ========== Warmer ==========

func (c *Controller) StartWarm(cat string, t *torrent.Torrent, f *torrent.File, start int64) {
	c.mu.Lock()
	if c.warmCancel != nil {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.warmCtx = ctx
	c.warmCancel = cancel
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			if c.warmCancel != nil {
				c.warmCancel = nil
				c.warmCtx = nil
			}
			c.mu.Unlock()
		}()

		rd := f.NewReader()
		defer rd.Close()

		for {
			c.mu.Lock()
			st := c.state
			ctx := c.warmCtx
			target := c.TargetBytes()
			pos := c.playhead
			c.mu.Unlock()

			if st != StatePaused || ctx == nil {
				return
			}

			if _, err := rd.Seek(pos, io.SeekStart); err != nil {
				time.Sleep(300 * time.Millisecond)
				continue
			}
			rd.SetResponsive()
			rd.SetReadahead(target)

			need := target - ContiguousAheadPieceExact(t, f, pos)
			if need <= 256<<10 {
				time.Sleep(750 * time.Millisecond)
				continue
			}

			chunk := need
			localWarmMB := config.WarmReadAheadMB()
			if torrentx.IsLikely4K(f.Path(), f.Length()) {
				if config.WarmReadAhead4KMB() > 0 {
					localWarmMB = config.WarmReadAhead4KMB()
				} else if localWarmMB < 64 {
					localWarmMB = 64
				}
			}
			maxChunk := localWarmMB << 20
			if chunk > maxChunk {
				chunk = maxChunk
			}

			start := time.Now()
			got := torrentx.Prebuffer(rd, chunk, 5*time.Second)
			c.UpdateThroughput(got, int64(time.Since(start).Milliseconds()))

			select {
			case <-time.After(150 * time.Millisecond):
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (c *Controller) StopWarm() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.warmCancel != nil {
		c.warmCancel()
		c.warmCancel = nil
		c.warmCtx = nil
	}
}

// ========== Piece-accurate contiguous bytes ==========
func ContiguousAheadPieceExact(t *torrent.Torrent, f *torrent.File, from int64) int64 {
	info := t.Info()
	if info == nil {
		return 0
	}
	fileLen := f.Length()
	if from >= fileLen {
		return 0
	}
	pieceLen := info.PieceLength
	if pieceLen <= 0 {
		return 0
	}

	fileStartGlobal := f.Offset() + from
	fileEndGlobal := f.Offset() + fileLen

	startPiece := int(fileStartGlobal / pieceLen)
	pieceOff := fileStartGlobal % pieceLen

	if t.PieceBytesMissing(startPiece) != 0 {
		return 0
	}

	var ahead int64
	segEnd := min64(fileEndGlobal, (int64(startPiece)+1)*pieceLen)
	ahead += segEnd - (int64(startPiece)*pieceLen + pieceOff)

	for p := startPiece + 1; (int64(p) * pieceLen) < fileEndGlobal; p++ {
		if t.PieceBytesMissing(p) != 0 {
			break
		}
		ps := int64(p) * pieceLen
		pe := ps + pieceLen
		if pe > fileEndGlobal {
			pe = fileEndGlobal
		}
		ahead += pe - ps
	}
	return ahead
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
