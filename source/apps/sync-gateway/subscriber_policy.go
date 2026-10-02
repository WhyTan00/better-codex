package main

import "time"

type eventHeartbeatPolicy struct {
	mode     string
	interval time.Duration
}

func subscriberHeartbeat(mode string) (eventHeartbeatPolicy, bool) {
	switch mode {
	case "active":
		return eventHeartbeatPolicy{mode, 15 * time.Second}, true
	case "idle":
		return eventHeartbeatPolicy{mode, 120 * time.Second}, true
	default:
		return eventHeartbeatPolicy{}, false
	}
}
