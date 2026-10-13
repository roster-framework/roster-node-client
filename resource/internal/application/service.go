package application

import (
	"context"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"time"
)

type Service struct {
	Registry   Registry
	Documents  Documents
	Components ComponentFactory
	Now        func() string
}

func (s *Service) Register(ctx context.Context, in resource.Definition) (resource.Metadata, error) {
	d, err := s.Registry.Register(ctx, in)
	return d.Metadata(), err
}
func (s *Service) List(ctx context.Context) ([]resource.Metadata, error) {
	defs, err := s.Registry.Definitions(ctx)
	if err != nil {
		return nil, err
	}
	out := []resource.Metadata{}
	for _, d := range defs {
		out = append(out, d.Metadata())
	}
	return out, nil
}
func (s *Service) Metadata(ctx context.Context, id string) (resource.Metadata, error) {
	d, e := s.Registry.Definition(ctx, id)
	return d.Metadata(), e
}
func (s *Service) Publish(ctx context.Context, in resource.Publish) (resource.Document, error) {
	d, err := s.Registry.Definition(ctx, in.ID)
	if err != nil {
		return resource.Document{}, err
	}
	if d.Component != "document" {
		return resource.Document{}, resource.ErrUnsupported
	}
	if in.Collection == "" {
		in.Collection = "documents"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if s.Now != nil {
		now = s.Now()
	}
	return s.Documents.Publish(ctx, in, now)
}
func (s *Service) Document(ctx context.Context, id string, version int) (resource.Document, error) {
	d, err := s.Registry.Definition(ctx, id)
	if err != nil {
		return resource.Document{}, err
	}
	if d.Component != "document" || version < 0 {
		return resource.Document{}, resource.ErrUnsupported
	}
	return s.Documents.Get(ctx, id, version)
}
func (s *Service) Invoke(ctx context.Context, id string, op resource.Operation) (any, error) {
	if err := op.Validate(); err != nil {
		return nil, err
	}
	d, err := s.Registry.Definition(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.Components == nil {
		return nil, resource.ErrUnsupported
	}
	if op.ExpectedVersion != nil && d.Version != *op.ExpectedVersion {
		return nil, resource.ErrConflict
	}
	if d.Component == "webhook" && op.ExpectedVersion == nil {
		return nil, resource.ErrConflict
	}
	return s.Components.Invoke(ctx, d, op)
}
func (s *Service) Changes(ctx context.Context, consumer string, limit int) ([]resource.Change, error) {
	if !resource.ValidConsumer(consumer) || limit < 1 || limit > 100 {
		return nil, errors.New("invalid consumer or limit")
	}
	return s.Documents.PendingChanges(ctx, consumer, limit)
}
func (s *Service) Ack(ctx context.Context, consumer, id string) error {
	if !resource.ValidConsumer(consumer) || len(id) != 73 {
		return errors.New("invalid acknowledgement")
	}
	return s.Documents.ConfirmChange(ctx, consumer, id)
}
