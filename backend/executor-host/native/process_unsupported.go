//go:build !linux && !darwin

package main

import "errors"

func run(_ []string) error { return errors.New("process isolation requires Linux or macOS") }
