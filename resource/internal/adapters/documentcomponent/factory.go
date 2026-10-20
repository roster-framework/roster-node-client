// Package documentcomponent translates generic operations to the existing document use cases.
package documentcomponent

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

type Factory struct {
	Documents application.DocumentOperations
}

type readArguments struct {
	Version int `json:"version"`
}
type publishArguments struct {
	Collection      string `json:"collection"`
	SourceKind      string `json:"source_kind"`
	SourceURI       string `json:"source_uri"`
	SourceVersion   string `json:"source_version"`
	MediaType       string `json:"media_type"`
	Title           string `json:"title"`
	Body            string `json:"body"`
	ChangeID        string `json:"change_id"`
	ExpectedVersion *int   `json:"expected_version"`
}

func (f Factory) Invoke(ctx context.Context, d resource.Definition, op resource.Operation) (any, error) {
	if f.Documents == nil || d.Component != "document" || op.Tool != "" || op.Validate() != nil {
		return nil, resource.ErrUnsupported
	}
	switch op.Name {
	case "read":
		in, err := arguments[readArguments](op.Arguments)
		if err != nil || in.Version < 0 {
			return nil, resource.ErrUnsupported
		}
		return f.Documents.Document(ctx, d.ID, in.Version)
	case "publish":
		in, err := arguments[publishArguments](op.Arguments)
		if err != nil || in.ExpectedVersion == nil {
			return nil, resource.ErrUnsupported
		}
		collection := in.Collection
		if collection == "" {
			collection = "documents"
		}
		publish := resource.Publish{ID: d.ID, Collection: collection, SourceKind: in.SourceKind, SourceURI: in.SourceURI, SourceVersion: in.SourceVersion, MediaType: in.MediaType, Title: in.Title, Body: in.Body, ChangeID: in.ChangeID, ExpectedVersion: *in.ExpectedVersion}
		if publish.Validate() != nil {
			return nil, resource.ErrUnsupported
		}
		return f.Documents.Publish(ctx, publish)
	default:
		return nil, resource.ErrUnsupported
	}
}

func arguments[T any](in map[string]any) (T, error) {
	var out T
	if in == nil {
		in = map[string]any{}
	}
	for _, value := range in {
		if value == nil {
			return out, resource.ErrUnsupported
		}
	}
	raw, err := json.Marshal(in)
	if err != nil || len(raw) > 300000 {
		return out, resource.ErrUnsupported
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&out) != nil {
		return out, resource.ErrUnsupported
	}
	return out, nil
}
