package components

import (
	"context"
	"encoding/json"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

// Registry permits independently wired adapters without provider branches in use cases.
type Factory map[string]application.ComponentFactory

func (f Factory) Invoke(ctx context.Context, d resource.Definition, op resource.Operation) (any, error) {
	adapter := f[d.Component]
	if adapter == nil {
		return nil, resource.ErrUnsupported
	}
	return adapter.Invoke(ctx, d, op)
}

func (f Factory) DecodeSubscriptionConfiguration(d resource.Definition, result any) (json.RawMessage, error) {
	adapter := f[d.Component]
	if decoder, ok := adapter.(application.SubscriptionConfigurationDecoder); ok {
		return decoder.DecodeSubscriptionConfiguration(d, result)
	}
	return json.Marshal(result)
}
