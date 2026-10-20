package application

import (
	"context"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

// DocumentOperations is the native use-case boundary shared by HTTP and component adapters.
type DocumentOperations interface {
	Document(context.Context, string, int) (resource.Document, error)
	Publish(context.Context, resource.Publish) (resource.Document, error)
}
