package downloads

import "fmt"

func checkPreparationSpace(sourceRoot, downloadRoot string, needed int64) error {
	if needed <= 0 {
		return fmt.Errorf("invalid preparation size")
	}
	for _, root := range []string{sourceRoot, downloadRoot} {
		available, err := availableSpace(root)
		if err != nil {
			return fmt.Errorf("check preparation space: %w", err)
		}
		if available < uint64(needed) {
			return fmt.Errorf("insufficient space for torrent source, prepared copy and reserve")
		}
	}
	return nil
}
