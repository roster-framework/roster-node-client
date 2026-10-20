package application

import (
	"context"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"testing"
)

type webhookRegistry struct{ d resource.Definition }

func (r *webhookRegistry) Register(context.Context, resource.Definition) (resource.Definition, error) {
	return r.d, nil
}
func (r *webhookRegistry) Definition(context.Context, string) (resource.Definition, error) {
	return r.d, nil
}
func (r *webhookRegistry) Definitions(context.Context) ([]resource.Definition, error) {
	return []resource.Definition{r.d}, nil
}

type countingComponent struct{ calls int }

func (f *countingComponent) Invoke(context.Context, resource.Definition, resource.Operation) (any, error) {
	f.calls++
	return nil, nil
}

func TestWebhookRequiresExactProviderVersionBeforeDispatch(t *testing.T) {
	registry := &webhookRegistry{d: resource.Definition{ID: "hook", Name: "Webhook", Component: "webhook", Audience: "service", Version: 2}}
	component := &countingComponent{}
	s := &Service{Registry: registry, Components: component}
	for _, version := range []*int{nil, new(int)} {
		if _, err := s.Invoke(context.Background(), "hook", resource.Operation{Name: "notification.send", ExpectedVersion: version}); err == nil || component.calls != 0 {
			t.Fatal("unversioned/stale request reached destination", err)
		}
	}
	stale := 1
	if _, err := s.Invoke(context.Background(), "hook", resource.Operation{Name: "notification.send", ExpectedVersion: &stale}); !errors.Is(err, resource.ErrConflict) || component.calls != 0 {
		t.Fatal("CAS ignored", err)
	}
	current := 2
	if _, err := s.Invoke(context.Background(), "hook", resource.Operation{Name: "notification.send", ExpectedVersion: &current}); err != nil || component.calls != 1 {
		t.Fatal(err)
	}
}
