package subscriptioncontract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReceiptBindsExactRequestAndPreservesLargeNumbers(t *testing.T) {
	d := Declaration{Protocol: Protocol, ID: "library", Revision: strings.Repeat("a", 64), ConfigurationSchema: json.RawMessage(`{}`), ConfigureOperation: Operation{Name: "configure"}, Events: []string{"changed"}}
	c := Command{Protocol: Protocol, ID: "request", ResourceID: "source", ExtensionID: d.ID, ExtensionRevision: d.Revision, ExpectedVersion: 1, Configuration: json.RawMessage(`{"cursor":9007199254740993,"x":true}`)}
	digest, err := c.Digest()
	if err != nil {
		t.Fatal(err)
	}
	r := Receipt{Protocol: Protocol, RequestID: c.ID, ResourceID: c.ResourceID, ExtensionID: c.ExtensionID, ExtensionRevision: c.ExtensionRevision, RequestDigest: digest, StreamResourceID: "stream", Events: []string{"changed"}, AcceptedAt: "2026-10-09T00:00:00Z"}
	if err = r.ValidateFor(c, d); err != nil {
		t.Fatal(err)
	}
	ordered := c
	ordered.Configuration = json.RawMessage(`{ "x":true, "cursor":9007199254740993 }`)
	if err = r.ValidateFor(ordered, d); err != nil {
		t.Fatal("object ordering changed receipt identity", err)
	}
	changed := c
	changed.Configuration = json.RawMessage(`{"cursor":9007199254740992,"x":true}`)
	if r.ValidateFor(changed, d) == nil {
		t.Fatal("large numbers rounded into same request")
	}
	r.Events = []string{"other"}
	if r.ValidateFor(c, d) == nil {
		t.Fatal("undeclared event accepted")
	}
}
