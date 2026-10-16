//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// Exec preserves the launcher PID as the session and process group identity.
func run(args []string) error {
	if len(args) == 3 && args[0] == "signal" {
		pid, err := strconv.Atoi(args[2])
		if err != nil || pid <= 1 { return errors.New("invalid process group") }
		var signal syscall.Signal
		switch args[1] { case "TERM": signal = syscall.SIGTERM; case "KILL": signal = syscall.SIGKILL; default: return errors.New("invalid signal") }
		err = syscall.Kill(-pid, signal)
		if err == syscall.ESRCH { return nil }
		return err
	}
	if len(args) < 2 || args[0] != "exec" || !filepath.IsAbs(args[1]) { return errors.New("exec requires an absolute executable") }
	if _, err := syscall.Setsid(); err != nil { return err }
	return syscall.Exec(args[1], args[1:], os.Environ())
}
