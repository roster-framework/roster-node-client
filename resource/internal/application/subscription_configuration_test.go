package application

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
	"strings"
	"testing"
)

type configurationLibrary struct {
	receipt subscriptioncontract.Receipt
	calls   int
	last    resource.Operation
}

func (l *configurationLibrary) Invoke(_ context.Context, _ resource.Definition, op resource.Operation) (any, error) {
	l.calls++
	l.last = op
	out := l.receipt
	out.Replayed = l.calls > 1
	return out, nil
}

func TestSubscriptionDelegatesToLibraryAndValidatesRegisteredStream(t *testing.T) {
	ctx := context.Background()
	registry, err := sqlite.NewRegistry(filepath.Join(t.TempDir(), "registry.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close()
	d := subscriptioncontract.Declaration{Protocol: subscriptioncontract.Protocol, ID: "library", Revision: strings.Repeat("a", 64), ConfigurationSchema: json.RawMessage(`{}`), ConfigureOperation: subscriptioncontract.Operation{Name: "custom.configure"}, Events: []string{"resource.updated"}}
	definition, err := registry.Register(ctx, resource.Definition{ID: "source", Name: "Source", Component: "http", Endpoint: "http://127.0.0.1:9000", Protocol: "example/1", Operations: []string{"custom.configure"}, SubscriptionExtensions: []subscriptioncontract.Declaration{d}})
	if err != nil {
		t.Fatal(err)
	}
	command := subscriptioncontract.Command{Protocol: d.Protocol, ID: "request", ResourceID: definition.ID, ExtensionID: d.ID, ExtensionRevision: d.Revision, ExpectedVersion: definition.Version, Configuration: json.RawMessage(`{"my_library_option":9007199254740993}`)}
	digest, _ := command.Digest()
	library := &configurationLibrary{receipt: subscriptioncontract.Receipt{Protocol: d.Protocol, RequestID: command.ID, ResourceID: command.ResourceID, ExtensionID: d.ID, ExtensionRevision: d.Revision, RequestDigest: digest, StreamResourceID: "stream", Events: d.Events, AcceptedAt: "2026-10-09T00:00:00Z"}}
	s := Service{Registry: registry, Components: library}
	if _, err = s.ConfigureSubscription(ctx, command); err == nil {
		t.Fatal("unregistered stream fabricated")
	}
	if _, err = registry.Register(ctx, resource.Definition{ID: "stream", Name: "Stream", Component: "document"}); err != nil {
		t.Fatal(err)
	}
	receipt, err := s.ConfigureSubscription(ctx, command)
	if err != nil || !receipt.Replayed {
		t.Fatal("library receipt lost", err)
	}
	if library.last.Name != "custom.configure" || library.last.ExpectedVersion == nil || *library.last.ExpectedVersion != definition.Version {
		t.Fatal("library operation/version lost")
	}
	config := library.last.Arguments["configuration"].(map[string]any)
	if config["my_library_option"].(json.Number).String() != "9007199254740993" {
		t.Fatal("opaque configuration number altered")
	}
	command.ExtensionRevision = strings.Repeat("b", 64)
	before := library.calls
	if _, err = s.ConfigureSubscription(ctx, command); !errors.Is(err, resource.ErrConflict) || library.calls != before {
		t.Fatal("stale declaration invoked")
	}
}
