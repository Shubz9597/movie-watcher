package downloads

import "golang.org/x/sys/windows"

func availableSpace(path string) (uint64, error) {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var available uint64
	err = windows.GetDiskFreeSpaceEx(ptr, &available, nil, nil)
	return available, err
}
