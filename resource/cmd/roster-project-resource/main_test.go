package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCommandRejectsMalformedMissingAndOversizedInputs(t *testing.T) {
	if e := run(nil); e == nil {
		t.Fatal("missing args accepted")
	}
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "view.json"), filepath.Join(dir, "snapshot.json"), filepath.Join(dir, "head.json")}
	for _, p := range paths {
		if e := os.WriteFile(p, []byte("{}"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e := run(paths); e == nil {
		t.Fatal("invalid view accepted")
	}
	if e := os.WriteFile(paths[0], make([]byte, 2*1024*1024+1), 0600); e != nil {
		t.Fatal(e)
	}
	if e := run(paths); e == nil {
		t.Fatal("oversized file accepted")
	}
}
