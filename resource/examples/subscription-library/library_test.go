package subscriptionlibrary_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	library "github.com/roster-framework/roster-node-client/resource/examples/subscription-library"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/components"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/httpcomponent"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"github.com/roster-framework/roster-node-client/resource/internal/interfaces/httpapi"
	"github.com/roster-framework/roster-node-client/resource/pkg/projectresource"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
)

type responseLoss struct {
	publisher projectresource.Publisher
	fail      bool
}

func (p *responseLoss) Head(ctx context.Context, id string) (projectresource.Head, error) {
	return p.publisher.Head(ctx, id)
}
func (p *responseLoss) Publish(ctx context.Context, command projectresource.Publication) (projectresource.Head, error) {
	head, err := p.publisher.Publish(ctx, command)
	if err == nil && p.fail {
		p.fail = false
		return head, errors.New("simulated response loss after commit")
	}
	return head, err
}

type registrationFailure struct {
	registrar library.Registrar
	fail      bool
}

func (r *registrationFailure) EnsureStream(ctx context.Context, id string) error {
	if r.fail {
		return errors.New("simulated registration outage")
	}
	return r.registrar.EnsureStream(ctx, id)
}

func TestExternalLibraryConfigurationAndPublicationRecoverOriginalCommands(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	registry, err := sqlite.NewRegistry(filepath.Join(directory, "resource-catalog.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close()
	documents, err := sqlite.NewResources(filepath.Join(directory, "resource-documents.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer documents.Close()
	token, admin, libraryToken := strings.Repeat("r", 32), strings.Repeat("a", 32), strings.Repeat("l", 32)
	service := &application.Service{Registry: registry, Documents: documents, Components: components.Factory{"http": httpcomponent.Factory{Credentials: func(string) string { return libraryToken }}}}
	native := httptest.NewServer((httpapi.API{Service: service, Token: token, AdminToken: admin}).Handler())
	defer native.Close()
	registrar, err := library.NewNativeRegistrar(native.URL, admin)
	if err != nil {
		t.Fatal(err)
	}
	publisher, err := projectresource.NewClient(native.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	registration := &registrationFailure{registrar: registrar, fail: true}
	publication := &responseLoss{publisher: publisher}
	path := filepath.Join(directory, "author-library.db")
	open := func() *sql.DB {
		db, e := sql.Open("sqlite", path)
		if e != nil {
			t.Fatal(e)
		}
		db.SetMaxOpenConns(1)
		if _, e = db.Exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"); e != nil {
			t.Fatal(e)
		}
		return db
	}
	db := open()
	instance, err := library.New(db, registration, publication)
	if err != nil {
		t.Fatal(err)
	}
	declaration := library.Declaration()
	command := subscriptioncontract.Command{Protocol: subscriptioncontract.Protocol, ID: "configure-development", ResourceID: "example-project", ExtensionID: declaration.ID, ExtensionRevision: declaration.Revision, ExpectedVersion: 1, Configuration: json.RawMessage(`{"label":"development"}`)}
	if _, err = instance.Configure(ctx, command); err == nil {
		t.Fatal("outage must not issue usable receipt")
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	db = open()
	defer db.Close()
	registration.fail = false
	instance, err = library.New(db, registration, publication)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(instance.Handler(libraryToken))
	defer server.Close()
	if _, err = service.Register(ctx, resource.Definition{ID: "example-project", Name: "Example project library", Component: "http", Endpoint: server.URL + "/invoke", CredentialEnv: "EXAMPLE_LIBRARY_TOKEN", Operations: []string{"configure", "options", "sync"}, Protocol: library.ServiceProtocol, Audience: "agent", SubscriptionExtensions: []subscriptioncontract.Declaration{declaration}}); err != nil {
		t.Fatal(err)
	}
	first, err := service.ConfigureSubscription(ctx, command)
	if err != nil || !first.Replayed {
		t.Fatal("durable registration retry", first, err)
	}
	if err = first.ValidateFor(command, declaration); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := service.ConfigureSubscription(ctx, command)
			if e != nil || !reflect.DeepEqual(r, first) {
				t.Errorf("concurrent replay changed original receipt: %v", e)
			}
		}()
	}
	wg.Wait()
	changed := command
	changed.Configuration = json.RawMessage(`{"label":"design"}`)
	if _, err = service.ConfigureSubscription(ctx, changed); !errors.Is(err, resource.ErrConflict) {
		t.Fatal("changed intent must conflict", err)
	}
	bad := command
	bad.ID = "bad"
	bad.Configuration = json.RawMessage(`{"label":"development","secret":"must-not-store"}`)
	if _, err = service.ConfigureSubscription(ctx, bad); err == nil {
		t.Fatal("author must enforce own schema")
	}
	items := []projectresource.Item{{ID: "1", Revision: "1", Title: "Build CLI", Body: "Implement task storage", Labels: []string{"development"}, State: "open"}, {ID: "private", Revision: "1", Title: "Excluded", Body: "not-for-selected-view", Labels: []string{"design"}, State: "open"}}
	publication.fail = true
	if _, err = instance.Sync(ctx, command.ID, items); err == nil {
		t.Fatal("response loss expected")
	}
	// Close/reopen the library while the exact publication remains pending.
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	db = open()
	defer db.Close()
	instance, err = library.New(db, registration, publication)
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := instance.Sync(ctx, command.ID, items); err != nil || !changed {
		t.Fatal("pending publication recovery", changed, err)
	}
	doc, err := service.Document(ctx, first.StreamResourceID, 0)
	if err != nil || doc.Version != 1 || strings.Contains(doc.Body, "not-for-selected-view") || !strings.Contains(doc.Body, "Implement task storage") {
		t.Fatal("selected stream body/version", doc, err)
	}
	if changed, err := instance.Sync(ctx, command.ID, items); err != nil || changed {
		t.Fatal("unchanged snapshot emitted event", changed, err)
	}
	items[1].Body = "irrelevant changed content"
	items[1].Revision = "2"
	if changed, err := instance.Sync(ctx, command.ID, items); err != nil || changed {
		t.Fatal("excluded item emitted event", changed, err)
	}
	items[0].Revision = "2"
	items[0].Body = "New selected requirement"
	if changed, err := instance.Sync(ctx, command.ID, items); err != nil || !changed {
		t.Fatal("selected change missing", changed, err)
	}
	changes, err := service.Changes(ctx, "example-observer", 10)
	if err != nil || len(changes) != 2 || changes[0].Type != "resource.created" || changes[1].Type != "resource.updated" {
		t.Fatal("original document journal", changes, err)
	}
	metadata, err := service.List(ctx)
	if err != nil || len(metadata) != 2 {
		t.Fatal("retry registered duplicate stream", metadata, err)
	}
}
