package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func metadataReply(t *testing.T, request map[string]any) []byte {
	t.Helper()
	producer := os.Getenv("DSH_SOURCE_PAGE_PRODUCER")
	if producer == "" {
		producer = "../native-codex-web/test/fixtures/source-page-producer.mjs"
	}
	producer = filepath.Join(filepath.Dir(producer), "source-metadata-producer.mjs")
	input, _ := json.Marshal(map[string]any{"request": request})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", producer)
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("actual metadata producer failed: %v; %s", err, stderr.String())
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	if !scanner.Scan() {
		t.Fatal("metadata reply missing")
	}
	first := bytes.Clone(scanner.Bytes())
	if scanner.Scan() || scanner.Err() != nil {
		t.Fatal("metadata operation emitted more than its own reply")
	}
	return first
}

func TestStorageMetadataActualProducerWorksWithoutCloudCacheAndRejectsOtherScope(t *testing.T) {
	for _, endpoint := range []string{"native-catalog?after=900&generation=retired-source", "native-bootstrap", "native-cursors?threadId=" + threadID} {
		for _, wrongScope := range []bool{false, true} {
			t.Run(endpoint+map[bool]string{true: "/wrong-scope", false: "/source"}[wrongScope], func(t *testing.T) {
				g, server, bridge := readBridgeFixture(t)
				// Force actual read pool unavailability, not a mocked success.
				g.durable.reader.Close()
				done := make(chan *http.Response, 1)
				errors := make(chan error, 1)
				go func() {
					request, _ := http.NewRequest("GET", server.URL+"/sync/v1/w/ai/"+endpoint, nil)
					request.Header.Set("X-DSH-Authenticated", "1")
					response, err := http.DefaultClient.Do(request)
					if err != nil {
						errors <- err
					} else {
						done <- response
					}
				}()
				var request map[string]any
				if err := bridge.ReadJSON(&request); err != nil {
					t.Fatal(err)
				}
				reply := metadataReply(t, request)
				if wrongScope {
					// Change only source DTO scope; transport ownership remains AI.
					reply = bytes.ReplaceAll(reply, []byte(`"scope":"ai"`), []byte(`"scope":"zyy"`))
				}
				if err := bridge.WriteMessage(1, reply); err != nil {
					t.Fatal(err)
				}
				select {
				case response := <-done:
					defer response.Body.Close()
					var value map[string]any
					if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
						t.Fatal(err)
					}
					if wrongScope {
						if response.StatusCode < 400 {
							t.Fatal("foreign metadata was returned", value)
						}
					} else if response.StatusCode != 200 || value["source"] != "mac-cache" {
						t.Fatal("source metadata blocked by optional cache", response.StatusCode, value)
					}
				case err := <-errors:
					t.Fatal(err)
				case <-time.After(2 * time.Second):
					t.Fatal("metadata waited for unrelated projection")
				}
			})
		}
	}
}
