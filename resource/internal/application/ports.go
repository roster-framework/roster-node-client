package application

import (
	"context"
	"encoding/json"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

type Registry interface {
	Register(context.Context, resource.Definition) (resource.Definition, error)
	Definition(context.Context, string) (resource.Definition, error)
	Definitions(context.Context) ([]resource.Definition, error)
}
type Documents interface {
	Publish(context.Context, resource.Publish, string) (resource.Document, error)
	Get(context.Context, string, int) (resource.Document, error)
	PendingChanges(context.Context, string, int) ([]resource.Change, error)
	ConfirmChange(context.Context, string, string) error
}

// ComponentFactory chooses an implementation without provider logic in use cases.
type ComponentFactory interface {
	Invoke(context.Context, resource.Definition, resource.Operation) (any, error)
}

// Protocol adapters unwrap their own transport envelopes. The use case validates
// only the resulting public configuration receipt, not MCP content types.
type SubscriptionConfigurationDecoder interface {
	DecodeSubscriptionConfiguration(resource.Definition, any) (json.RawMessage, error)
}
