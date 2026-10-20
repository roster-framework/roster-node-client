package resource

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWebhookDefinitionIsVersionedPrivateServiceConfiguration(t *testing.T) {
	valid := Definition{ID: "hook", Name: "Receiver", Component: "webhook", Audience: "service", Endpoint: "https://receiver.example/hook", SigningKeyEnv: "WEBHOOK_KEY"}
	next, err := (Definition{}).Next(valid)
	if err != nil || next.Version != 1 {
		t.Fatal(next, err)
	}
	data, _ := json.Marshal(next.Metadata())
	if strings.Contains(string(data), "receiver.example") || strings.Contains(string(data), "WEBHOOK_KEY") || !strings.Contains(string(data), "notification.send") {
		t.Fatal(string(data))
	}
	for _, change := range []func(*Definition){
		func(d *Definition) { d.Audience = "agent" }, func(d *Definition) { d.SigningKeyEnv = "" },
		func(d *Definition) { d.Endpoint = "http://receiver.example/hook" }, func(d *Definition) { d.Endpoint = "https://user:pass@receiver.example/hook" },
		func(d *Definition) { d.Endpoint = "https://receiver.example/hook?token=private" }, func(d *Definition) { d.Operations = []string{"notification.send"} },
	} {
		candidate := valid
		change(&candidate)
		if _, err := (Definition{}).Next(candidate); err == nil {
			t.Fatal("Invalid webhook accepted", candidate.ID)
		}
	}
	if _, err = next.Next(valid); err != ErrConflict {
		t.Fatal("stale configuration accepted", err)
	}
	valid.Version = 1
	valid.Endpoint = "https://receiver.example/new"
	updated, err := next.Next(valid)
	if err != nil || updated.Version != 2 {
		t.Fatal(updated, err)
	}
}
