package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The recent query view is deliberately small. Delivery receipts instead
// follow this private, metadata-only journal: seven days or 512 MiB per scope.
const diagnosticArchiveSegment = 4 * 1024 * 1024
const diagnosticArchiveSegments = 128

var diagnosticArchiveName = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$`)

// Caller owns clientDiagnosticsMu. Never includes raw prompts, URLs or errors.
func (g *Gateway) archiveClientDiagnostics(scope string, rows []map[string]any, now time.Time) error {
	if !validScope(scope) {
		return errors.New("invalid diagnostics scope")
	}
	var data bytes.Buffer
	for _, row := range rows {
		if err := json.NewEncoder(&data).Encode(row); err != nil {
			return err
		}
	}
	if data.Len() == 0 {
		return nil
	}
	if data.Len() > diagnosticArchiveSegment {
		return errors.New("diagnostic archive batch too large")
	}
	dir := filepath.Join(g.dir, "diagnostics-archive-"+scope)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	today := now.UTC().Format("2006-01-02")
	files := []string{}
	sequence := 0
	for _, entry := range entries {
		if entry.IsDir() || !diagnosticArchiveName.MatchString(entry.Name()) {
			continue
		}
		files = append(files, entry.Name())
		if strings.HasPrefix(entry.Name(), today+"-") {
			n, _ := strconv.Atoi(entry.Name()[11:17])
			if n > sequence {
				sequence = n
			}
		}
	}
	name := fmt.Sprintf("%s-%06d.jsonl", today, sequence)
	if info, err := os.Stat(filepath.Join(dir, name)); err == nil && info.Size()+int64(data.Len()) > diagnosticArchiveSegment {
		sequence++
		name = fmt.Sprintf("%s-%06d.jsonl", today, sequence)
	}
	file, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	offset := info.Size()
	if _, err = file.Write(data.Bytes()); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	readback := make([]byte, data.Len())
	if _, err = file.ReadAt(readback, offset); err != nil {
		return err
	}
	if !bytes.Equal(readback, data.Bytes()) {
		return errors.New("diagnostic archive readback mismatch")
	}
	found := false
	for _, existing := range files {
		found = found || existing == name
	}
	if !found {
		files = append(files, name)
	}
	sort.Strings(files)
	cutoff := now.UTC().Add(-diagnosticRetention).Format("2006-01-02")
	for i, existing := range files {
		if existing != name && (existing[:10] < cutoff || i < len(files)-diagnosticArchiveSegments) {
			if err := os.Remove(filepath.Join(dir, existing)); err != nil {
				return err
			}
		}
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err = directory.Sync(); err != nil {
		return err
	}
	parent, err := os.Open(g.dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}
