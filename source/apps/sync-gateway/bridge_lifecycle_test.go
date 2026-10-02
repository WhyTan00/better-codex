package main

import (
	"os"
	"testing"
	"time"
)

// Opt-in wall-clock check: exercise real WebSocket ping/pong beyond the actual
// 45 second production deadline. The ordinary suite stays fast.
func TestBridgeHeartbeatSurvivesQuietTransport(t *testing.T) {
	if os.Getenv("DSH_LONG_TRANSPORT_TEST") != "1" {
		t.Skip("explicit real-time transport check")
	}
	g := testGateway(t)
	conn := priorityBridge(t, g)
	conn.SetReadDeadline(time.Now().Add(55 * time.Second))
	ended := make(chan error, 1)
	ack := make(chan bool, 1)
	go func() {
		for {
			var message map[string]any
			if err := conn.ReadJSON(&message); err != nil {
				ended <- err
				return
			}
			if message["type"] == "ack" && message["seq"] == float64(1) {
				ack <- true
			}
		}
	}()
	select {
	case err := <-ended:
		t.Fatalf("quiet bridge died before liveness deadline: %v", err)
	case <-time.After(46 * time.Second):
	}
	if !g.hasBridge() || !g.nativeOnlineNow() {
		t.Fatal("healthy idle bridge was marked offline")
	}
	if err := conn.WriteJSON(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ack:
	case err := <-ended:
		t.Fatal(err)
	case <-time.After(3 * time.Second):
		t.Fatal("publication after quiet interval did not commit")
	}
	conn.Close()
	<-ended
}
