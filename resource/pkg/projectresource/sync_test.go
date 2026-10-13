package projectresource

import (
	"context"
	"errors"
	"testing"
)

type syncFixture struct {
	items    []Item
	pending  *Publication
	head     Head
	commands []Publication
	fail     bool
}

func (f *syncFixture) Snapshot(context.Context) ([]Item, error)           { return f.items, nil }
func (f *syncFixture) Load(context.Context, string) (*Publication, error) { return f.pending, nil }
func (f *syncFixture) Save(_ context.Context, _ string, p Publication) error {
	f.pending = &p
	return nil
}
func (f *syncFixture) Clear(context.Context, string, string) error { f.pending = nil; return nil }
func (f *syncFixture) Head(context.Context, string) (Head, error)  { return f.head, nil }
func (f *syncFixture) Publish(_ context.Context, p Publication) (Head, error) {
	f.commands = append(f.commands, p)
	if f.fail {
		return Head{}, errors.New("lost connection")
	}
	f.head = Head{p.ExpectedVersion + 1, p.SourceVersion}
	return f.head, nil
}
func TestSyncRetainsExactPendingCommandAndReadsLatestAfterRecovery(t *testing.T) {
	f := &syncFixture{items: []Item{itemFixture()}, fail: true}
	s := Synchronizer{viewFixture(), f, f, f}
	if _, e := s.Sync(context.Background()); e == nil || f.pending == nil {
		t.Fatal("lost failed publication")
	}
	original := *f.pending
	f.fail = false
	f.items[0].Revision = "new"
	changed, e := s.Sync(context.Background())
	if e != nil || !changed || f.pending != nil || len(f.commands) != 3 {
		t.Fatal("recovery failed", e)
	}
	if f.commands[1] != original || f.commands[2].ExpectedVersion != 1 {
		t.Fatal("recovery replaced command or missed latest snapshot")
	}
	changed, e = s.Sync(context.Background())
	if e != nil || changed || len(f.commands) != 3 {
		t.Fatal("unchanged polling repeated publication", e)
	}
}
