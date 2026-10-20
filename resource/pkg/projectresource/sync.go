package projectresource

import (
	"context"
	"errors"
)

// Source returns a complete snapshot. A provider's cursor is not committed here.
type Source interface {
	Snapshot(context.Context) ([]Item, error)
}
type Publisher interface {
	Head(context.Context, string) (Head, error)
	Publish(context.Context, Publication) (Head, error)
}

// Outbox implementations must preserve the exact original command durably before
// sending, and clear it only after a validated publication receipt.
type Outbox interface {
	Load(context.Context, string) (*Publication, error)
	Save(context.Context, string, Publication) error
	Clear(context.Context, string, string) error
}
type Synchronizer struct {
	View      View
	Source    Source
	Publisher Publisher
	Outbox    Outbox
}

func (s Synchronizer) Sync(ctx context.Context) (bool, error) {
	if s.Outbox == nil || s.Source == nil || s.Publisher == nil {
		return false, errors.New("project synchronizer ports required")
	}
	pending, e := s.Outbox.Load(ctx, s.View.ID)
	if e != nil {
		return false, e
	}
	if pending != nil {
		if pending.ID != s.View.ID || pending.Collection != s.View.Collection {
			return false, errors.New("pending publication belongs to another view")
		}
		if _, e = s.Publisher.Publish(ctx, *pending); e != nil {
			return false, e
		}
		if e = s.Outbox.Clear(ctx, s.View.ID, pending.ChangeID); e != nil {
			return false, e
		}
		// Do not lose changes which arrived while the previous command was pending.
	}
	items, e := s.Source.Snapshot(ctx)
	if e != nil {
		return pending != nil, e
	}
	head, e := s.Publisher.Head(ctx, s.View.ID)
	if e != nil {
		return pending != nil, e
	}
	command, e := s.View.Prepare(items, head)
	if e != nil || command == nil {
		return pending != nil, e
	}
	if e = s.Outbox.Save(ctx, s.View.ID, *command); e != nil {
		return pending != nil, e
	}
	if _, e = s.Publisher.Publish(ctx, *command); e != nil {
		return pending != nil, e
	}
	if e = s.Outbox.Clear(ctx, s.View.ID, command.ChangeID); e != nil {
		return true, e
	}
	return true, nil
}
