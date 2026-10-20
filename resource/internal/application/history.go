package application

import (
	"context"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

// DocumentHistoryReader adds a read capability without widening every document writer.
type DocumentHistoryReader interface {
	History(context.Context, string, resource.HistoryQuery) (resource.HistoryPage, error)
}

func (s *Service) History(ctx context.Context, id string, q resource.HistoryQuery) (resource.HistoryPage, error) {
	q, err := q.Normalize()
	if err != nil {
		return resource.HistoryPage{}, err
	}
	d, err := s.Registry.Definition(ctx, id)
	if err != nil {
		if errors.Is(err, resource.ErrNotFound) {
			return resource.HistoryPage{}, resource.ErrNotFound
		}
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	if d.Component != "document" {
		return resource.HistoryPage{}, resource.ErrUnsupported
	}
	reader, ok := s.Documents.(DocumentHistoryReader)
	if !ok {
		return resource.HistoryPage{}, resource.ErrUnsupported
	}
	page, err := reader.History(ctx, id, q)
	if err != nil {
		if errors.Is(err, resource.ErrNotFound) {
			return resource.HistoryPage{}, resource.ErrNotFound
		}
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	if page.Validate(id, q) != nil {
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	return page, nil
}
