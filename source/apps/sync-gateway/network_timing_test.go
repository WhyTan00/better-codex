package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestAndroidNetworkTimingProducerContract(t *testing.T) {
	for _, name := range []string{"android-network-timing.json", "android-network-failure.json"} {
		raw, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err = json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		safe := safeClientDiagnostic(value)
		for key, want := range value {
			if key == "phase" {
				continue
			}
			if got, ok := safe[key]; !ok || got != want {
				t.Fatalf("%s: dropped or changed %s: got %#v want %#v", name, key, got, want)
			}
		}
	}
}
