package torrentx

import "testing"

func TestValidInfoHashRejectsNonHexFortyCharacterValue(t *testing.T) {
	if validInfoHash("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ") {
		t.Fatal("invalid 40-character hash was accepted")
	}
	if !validInfoHash("0123456789abcdef0123456789abcdef01234567") {
		t.Fatal("valid hexadecimal hash was rejected")
	}
}
