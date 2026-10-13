package documentcomponent

import (
	"context"
	"errors"
	"math"
	"reflect"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strings"
	"testing"
)

type documentUseCases struct {
	reads, writes int
	id            string
	version       int
	publish       resource.Publish
	err           error
}

func (d *documentUseCases) Document(_ context.Context, id string, version int) (resource.Document, error) {
	d.reads++
	d.id, d.version = id, version
	return resource.Document{ID: id, Version: version}, d.err
}
func (d *documentUseCases) Publish(_ context.Context, p resource.Publish) (resource.Document, error) {
	d.writes++
	d.publish = p
	return resource.Document{ID: p.ID, Version: p.ExpectedVersion + 1}, d.err
}

func TestDocumentOperationTranslationUsesSelectedOriginalAndNativeUseCases(t *testing.T) {
	ctx := context.Background()
	useCases := &documentUseCases{}
	factory := Factory{Documents: useCases}
	definition := resource.Definition{ID: "original", Component: "document", Version: 7}
	for _, args := range []map[string]any{nil, {}, {"version": float64(0)}, {"version": float64(2)}} {
		if _, err := factory.Invoke(ctx, definition, resource.Operation{Name: "read", Arguments: args}); err != nil {
			t.Fatal(err)
		}
	}
	if useCases.reads != 4 || useCases.id != "original" || useCases.version != 2 {
		t.Fatal("read did not use selected original/version")
	}
	args := map[string]any{"source_kind": "upload", "title": "First", "body": "content", "change_id": "stable", "expected_version": float64(0)}
	before := map[string]any{}
	for k, v := range args {
		before[k] = v
	}
	if _, err := factory.Invoke(ctx, definition, resource.Operation{Name: "publish", Arguments: args}); err != nil {
		t.Fatal(err)
	}
	if useCases.writes != 1 || useCases.publish.ID != "original" || useCases.publish.Collection != "documents" || useCases.publish.ExpectedVersion != 0 || !reflect.DeepEqual(args, before) {
		t.Fatal("publish translation mutated input or selected wrong identity/version")
	}
	useCases.err = resource.ErrConflict
	if _, err := factory.Invoke(ctx, definition, resource.Operation{Name: "publish", Arguments: args}); !errors.Is(err, resource.ErrConflict) {
		t.Fatal("native conflict was hidden", err)
	}
}

func TestDocumentOperationRejectsInvalidArgumentsBeforeNativeIO(t *testing.T) {
	valid := map[string]any{"source_kind": "upload", "title": "First", "body": "content", "change_id": "stable", "expected_version": float64(0)}
	patch := func(key string, value any) map[string]any {
		out := map[string]any{}
		for k, v := range valid {
			out[k] = v
		}
		out[key] = value
		return out
	}
	missing := patch("expected_version", float64(0))
	delete(missing, "expected_version")
	cases := []resource.Operation{
		{Name: "read", Tool: "other"}, {Name: "read", Arguments: map[string]any{"id": "other"}},
		{Name: "read", Arguments: map[string]any{"version": -1}}, {Name: "read", Arguments: map[string]any{"version": 1.5}},
		{Name: "read", Arguments: map[string]any{"version": "1"}}, {Name: "read", Arguments: map[string]any{"version": nil}},
		{Name: "read", Arguments: map[string]any{"version": math.Inf(1)}},
		{Name: "publish"}, {Name: "publish", Arguments: missing}, {Name: "publish", Arguments: patch("expected_version", nil)},
		{Name: "publish", Arguments: patch("expected_version", -1)}, {Name: "publish", Arguments: patch("expected_version", 1.1)},
		{Name: "publish", Arguments: patch("id", "other")}, {Name: "publish", Arguments: patch("unit_id", "other")},
		{Name: "publish", Arguments: patch("credential_env", "PRIVATE")}, {Name: "publish", Arguments: patch("source_kind", "unknown")},
		{Name: "publish", Arguments: patch("source_uri", "https://user:secret@example.invalid")},
		{Name: "publish", Arguments: patch("body", strings.Repeat("x", 200001))},
		{Name: "publish", Arguments: patch("body", strings.Repeat("x", 300001))},
		{Name: "publish", Tool: "other", Arguments: valid}, {Name: "unknown"},
	}
	for i, op := range cases {
		t.Run(strings.Join([]string{op.Name, string(rune('A' + i))}, "/"), func(t *testing.T) {
			useCases := &documentUseCases{}
			if _, err := (Factory{Documents: useCases}).Invoke(context.Background(), resource.Definition{ID: "original", Component: "document"}, op); !errors.Is(err, resource.ErrUnsupported) {
				t.Fatal("invalid arguments accepted", err)
			}
			if useCases.reads != 0 || useCases.writes != 0 {
				t.Fatal("invalid arguments reached native IO")
			}
		})
	}
	if _, err := (Factory{}).Invoke(context.Background(), resource.Definition{ID: "original", Component: "document"}, resource.Operation{Name: "read"}); !errors.Is(err, resource.ErrUnsupported) {
		t.Fatal("missing use cases accepted")
	}
}
