package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"testing"
)

func TestVersionsReplayAndConsumerAcknowledgementsSurviveRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "documents.db")
	store, err := NewResources(path)
	if err != nil {
		t.Fatal(err)
	}
	p := resource.Publish{ID: "brief", Collection: "docs", SourceKind: "upload", Title: "Brief", Body: "first", ChangeID: "c1"}
	first, err := store.Publish(ctx, p, "2026-10-03T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := store.Publish(ctx, p, "2026-10-04T00:00:00Z")
	if err != nil || replay != first {
		t.Fatalf("replay %+v %v", replay, err)
	}
	p.Body = "different"
	if _, err = store.Publish(ctx, p, "2026-10-03T00:00:00Z"); !errors.Is(err, resource.ErrConflict) {
		t.Fatalf("changed duplicate: %v", err)
	}
	p.ExpectedVersion = 1
	p.ChangeID = "c2"
	if _, err = store.Publish(ctx, p, "2026-10-03T00:00:01Z"); err != nil {
		t.Fatal(err)
	}
	pending, err := store.PendingChanges(ctx, "core-a", 50)
	if err != nil || len(pending) != 2 {
		t.Fatalf("pending %v %v", pending, err)
	}
	if err = store.ConfirmChange(ctx, "core-a", pending[0].ID); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = NewResources(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	a, err := store.PendingChanges(ctx, "core-a", 50)
	if err != nil || len(a) != 1 {
		t.Fatalf("consumer a %v %v", a, err)
	}
	b, err := store.PendingChanges(ctx, "core-b", 50)
	if err != nil || len(b) != 2 {
		t.Fatalf("consumer b %v %v", b, err)
	}
	old, err := store.Get(ctx, "brief", 1)
	if err != nil || old.Body != "first" {
		t.Fatalf("original %+v %v", old, err)
	}
}
