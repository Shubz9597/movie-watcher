package buffer

import (
	"context"
	"io"
	"log"
	"strings"
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
	// StateStopped prevents a closed player from retaining warmer demand.
	StateStopped playState = "stopped"
)

type Key struct {
	Cat  string
	IH   string
	FIdx int
}

type Controller struct {
	mu             sync.RWMutex // Changed to RWMutex to allow concurrent reads
	state          playState
	playhead       int64
	rollingBps     int64
	targetAheadSec int64

	// warmer control
	warmCancel context.CancelFunc
	warmDone   chan struct{}
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

// StopTorrent cancels and waits for every warmer associated with a torrent.
// It does not add, drop, or delete the torrent or its cached data.
func StopTorrent(ctx context.Context, cat, infoHash string) error {
	bufMu.Lock()
	controllers := make([]*Controller, 0)
	for k, c := range ctrls {
		if strings.EqualFold(k.Cat, cat) && strings.EqualFold(k.IH, infoHash) {
			controllers = append(controllers, c)
		}
	}
	bufMu.Unlock()

	done := make([]<-chan struct{}, 0, len(controllers))
	for _, c := range controllers {
		if ch := c.stop(); ch != nil {
			done = append(done, ch)
		}
	}
	for _, ch := range done {
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (c *Controller) State() playState {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

func (c *Controller) SetState(ps playState) {
	c.mu.Lock()
	c.state = ps
	if ps == StatePlaying {
		c.targetAheadSec = config.TargetPlaySec()
	} else if ps == StatePaused {
		c.targetAheadSec = config.TargetPauseSec()
	}
	cancel := c.warmCancel
	c.mu.Unlock()

	if ps != StatePaused && cancel != nil {
		cancel()
	}
}

func (c *Controller) SetPlayhead(pos int64) {
	c.mu.Lock()
	c.playhead = pos
	c.mu.Unlock()
}

func (c *Controller) Playhead() int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
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
	c.mu.RLock()
	bps := c.rollingBps
	sec := c.targetAheadSec
	c.mu.RUnlock()
	if bps <= 0 {
		bps = 24_000_000 / 8 // default 24 Mbps = 3 MB/s
	}
	if bps < (24_000_000 / 8) {
		sec = sec + sec/3 // +33% when slow swarm
	}
	target := bps * sec
	// Cap target to prevent insane prebuffer sizes
	maxTarget := config.TargetMaxBytes()
	if maxTarget > 0 && target > maxTarget {
		target = maxTarget
	}
	return target
}

func (c *Controller) TargetAheadSeconds() int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
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

func (c *Controller) warmState() (playState, int64, int64) {
	c.mu.RLock()
	state := c.state
	playhead := c.playhead
	c.mu.RUnlock()
	// TargetBytes takes the controller read lock itself, so it must be called
	// after releasing the snapshot lock.
	return state, playhead, c.TargetBytes()
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
	if c.state != StatePaused || c.warmCancel != nil {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	c.warmCancel = cancel
	c.warmDone = done
	c.mu.Unlock()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[buffer] StartWarm panic recovered: %v", r)
			}
			c.mu.Lock()
			if c.warmDone == done {
				c.warmCancel = nil
				c.warmDone = nil
			}
			c.mu.Unlock()
			close(done)
		}()

		rd := f.NewReader()
		readerDone := make(chan struct{})
		readerWatcherDone := make(chan struct{})
		defer func() {
			close(readerDone)
			<-readerWatcherDone
			rd.Close()
		}()
		go func() {
			defer close(readerWatcherDone)
			select {
			case <-ctx.Done():
				rd.Close()
			case <-readerDone:
			}
		}()

		for {
			st, pos, target := c.warmState()

			if st != StatePaused {
				return
			}

			if _, err := rd.Seek(pos, io.SeekStart); err != nil {
				if !waitWarm(ctx, 300*time.Millisecond) {
					return
				}
				continue
			}
			rd.SetResponsive()
			rd.SetReadahead(target)

			need := target - ContiguousAheadPieceExact(t, f, pos)
			if need <= 256<<10 {
				return
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

			if !waitWarm(ctx, 150*time.Millisecond) {
				return
			}
		}
	}()
}

func (c *Controller) StopWarm() {
	c.mu.Lock()
	cancel := c.warmCancel
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *Controller) stop() <-chan struct{} {
	c.mu.Lock()
	c.state = StateStopped
	cancel := c.warmCancel
	done := c.warmDone
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return done
}

func waitWarm(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
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
