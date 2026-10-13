package introdetect

import (
	"encoding/binary"
	"errors"
	"math"
)

// codecVersion prefixes encoded fingerprints.
const codecVersion = 1

// EncodePoints packs a fingerprint run (4 bytes per point).
func EncodePoints(points []uint32) []byte {
	out := make([]byte, 4*len(points))
	for i, p := range points {
		binary.LittleEndian.PutUint32(out[4*i:], p)
	}
	return out
}

// DecodePoints unpacks EncodePoints.
func DecodePoints(data []byte) ([]uint32, error) {
	if len(data)%4 != 0 {
		return nil, errors.New("fingerprint length is not a multiple of 4")
	}
	points := make([]uint32, len(data)/4)
	for i := range points {
		points[i] = binary.LittleEndian.Uint32(data[4*i:])
	}
	return points, nil
}

// EncodeParts packs a file's head and tail parts.
func EncodeParts(head, tail []Part) []byte {
	out := []byte{codecVersion}
	for which, parts := range [][]Part{head, tail} {
		for _, part := range parts {
			header := make([]byte, 1+2+8+4)
			header[0] = byte(which)
			binary.LittleEndian.PutUint16(header[1:], uint16(part.Track))
			binary.LittleEndian.PutUint64(header[3:], math.Float64bits(part.Start))
			binary.LittleEndian.PutUint32(header[11:], uint32(len(part.Points)))
			out = append(out, header...)
			out = append(out, EncodePoints(part.Points)...)
		}
	}
	return out
}

// DecodeParts unpacks EncodeParts.
func DecodeParts(data []byte) (head, tail []Part, err error) {
	if len(data) == 0 || data[0] != codecVersion {
		return nil, nil, errors.New("unknown fingerprint encoding")
	}
	data = data[1:]
	for len(data) > 0 {
		if len(data) < 15 {
			return nil, nil, errors.New("truncated fingerprint part")
		}
		which := data[0]
		part := Part{
			Track: int(binary.LittleEndian.Uint16(data[1:])),
			Start: math.Float64frombits(binary.LittleEndian.Uint64(data[3:])),
		}
		n := int(binary.LittleEndian.Uint32(data[11:]))
		data = data[15:]
		if len(data) < 4*n {
			return nil, nil, errors.New("truncated fingerprint points")
		}
		if part.Points, err = DecodePoints(data[:4*n]); err != nil {
			return nil, nil, err
		}
		data = data[4*n:]
		if which == 0 {
			head = append(head, part)
		} else {
			tail = append(tail, part)
		}
	}
	return head, tail, nil
}
