package subscriptioncontract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLibraryDefinesItsOwnSchemaAndConfiguration(t *testing.T) {
	for _, config := range []string{`{"labels":["design"]}`, `{"paths":["docs/**"]}`, `{"arbitrary_library_option":true}`, `{}`} {
		d := Declaration{Protocol: Protocol, ID: "library", Revision: strings.Repeat("a", 64), ConfigurationSchema: json.RawMessage(`{}`), ConfigureOperation: Operation{Name: "configure"}, Events: []string{"changed"}}
		c := Command{Protocol: Protocol, ID: "request", ResourceID: "resource", ExpectedVersion: 1, ExtensionID: d.ID, ExtensionRevision: d.Revision, Configuration: json.RawMessage(config)}
		if err := c.Match(d); err != nil {
			t.Fatal(err)
		}
		if string(c.Configuration) != config {
			t.Fatal("framework rewrote library configuration")
		}
	}
}

func TestEnvelopeMismatchAndMalformedDataRejected(t *testing.T) {
	d := Declaration{Protocol: Protocol, ID: "library", Revision: strings.Repeat("a", 64), ConfigurationSchema: json.RawMessage(`{}`), ConfigureOperation: Operation{Name: "tools.call", Tool: "configure"}, Events: []string{"changed"}}
	c := Command{Protocol: Protocol, ID: "request", ResourceID: "resource", ExpectedVersion: 1, ExtensionID: d.ID, ExtensionRevision: strings.Repeat("b", 64), Configuration: json.RawMessage(`{}`)}
	if c.Match(d) == nil {
		t.Fatal("stale declaration accepted")
	}
	c.ExtensionRevision = d.Revision
	for _, raw := range []string{`null`, `[]`, `{} {}`, strings.Repeat(" ", 64001) + `{}`} {
		c.Configuration = json.RawMessage(raw)
		if c.Validate() == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
	d.Events = []string{"changed", "changed"}
	if d.Validate() == nil {
		t.Fatal("duplicate events accepted")
	}
}
