package resource

import (
	"encoding/json"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
	"strings"
	"testing"
)

func TestSubscriptionCapabilitiesBelongToLibrary(t *testing.T) {
	extension := subscriptioncontract.Declaration{Protocol: subscriptioncontract.Protocol, ID: "provider", Revision: strings.Repeat("a", 64), ConfigurationSchema: json.RawMessage(`{"properties":{"paths":{"type":"array"}}}`), ConfigureOperation: subscriptioncontract.Operation{Name: "configure"}, OptionsOperation: &subscriptioncontract.Operation{Name: "options"}, Events: []string{"resource.updated"}}
	in := Definition{ID: "resource", Name: "Provider", Component: "http", Endpoint: "http://127.0.0.1:9000", Operations: []string{"configure", "options"}, Protocol: "provider/1", SubscriptionExtensions: []subscriptioncontract.Declaration{extension}}
	next, err := (Definition{}).Next(in)
	if err != nil {
		t.Fatal(err)
	}
	meta := next.Metadata()
	if len(meta.SubscriptionExtensions) != 1 || string(meta.SubscriptionExtensions[0].ConfigurationSchema) != string(extension.ConfigurationSchema) {
		t.Fatal("library capability was lost or rewritten")
	}
	in.Operations = []string{"configure"}
	if _, err = (Definition{}).Next(in); err == nil {
		t.Fatal("unavailable options operation accepted")
	}
	in.Operations = []string{"configure", "options"}
	in.SubscriptionExtensions = append(in.SubscriptionExtensions, extension)
	if _, err = (Definition{}).Next(in); err == nil {
		t.Fatal("duplicate extension accepted")
	}
}
