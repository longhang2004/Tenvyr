//go:build linux || darwin

package main

import "testing"

func TestRejectUntrustedArguments(t *testing.T) {
	for _, args := range [][]string{{}, {"exec", "relative"}, {"signal", "KILL", "0"}, {"signal", "KILL", "-20"}, {"signal", "OTHER", "20"}, {"signal", "TERM", "x"}} {
		if run(args) == nil { t.Fatalf("accepted invalid arguments %v", args) }
	}
}
