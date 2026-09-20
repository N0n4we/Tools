package main

import "time"

func main() {
	x := make([]byte, 4*1024*1024*1024)

	for {
		for i := 0; i < len(x); i += 4096 {
			x[i]++
		}
		time.Sleep(100 * time.Millisecond)
	}
}
