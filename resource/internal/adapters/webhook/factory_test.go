package webhook

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strings"
	"testing"
	"time"
)

func TestExactJSONSignatureAndPrivateResponse(t *testing.T) {
	key := strings.Repeat("k", 32)
	body := `{"body":{"message":"한글\n\"quoted\"","count":9007199254740993},"ready":true}`
	calls := 0
	status := 204
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != body {
			t.Error("exact JSON bytes lost")
		}
		digest := hmac.New(sha256.New, []byte(key))
		_, _ = io.WriteString(digest, "42.delivery-1."+body)
		if r.Header.Get("X-Roster-Signature") != "sha256="+hex.EncodeToString(digest.Sum(nil)) || r.Header.Get("X-Roster-Timestamp") != "42" || r.Header.Get("X-Roster-Delivery-ID") != "delivery-1" || r.Header.Get("Authorization") != "Bearer provider-private" {
			t.Error("signature/context missing")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, "provider-private response")
	}))
	defer server.Close()
	f := Factory{Now: func() time.Time { return time.Unix(42, 0) }, Credentials: func(name string) string {
		if name == "WEBHOOK_KEY" {
			return key
		}
		return "provider-private"
	}}
	d := resource.Definition{Component: "webhook", Audience: "service", Version: 1, Endpoint: server.URL, SigningKeyEnv: "WEBHOOK_KEY", CredentialEnv: "WEBHOOK_TOKEN"}
	version := 1
	op := resource.Operation{Name: "notification.send", ExpectedVersion: &version, Arguments: map[string]any{"delivery_id": "delivery-1", "body_json": body}}
	out, err := f.Invoke(context.Background(), d, op)
	if err != nil || out == nil || calls != 1 {
		t.Fatal(err, out, calls)
	}
	status = 503
	_, err = f.Invoke(context.Background(), d, op)
	if err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), server.URL) {
		t.Fatal("provider error leaked", err)
	}
	for _, mode := range []string{"version", "missing-version", "unknown-arg", "URL", "key", "operation", "invalid-json"} {
		bad := op
		bad.Arguments = map[string]any{"delivery_id": "delivery-1", "body_json": body}
		definition := d
		factory := f
		switch mode {
		case "version":
			v := 2
			bad.ExpectedVersion = &v
		case "missing-version":
			bad.ExpectedVersion = nil
		case "unknown-arg":
			bad.Arguments["endpoint"] = server.URL
		case "URL":
			definition.Endpoint = "http://example.com/webhook"
		case "key":
			factory.Credentials = func(string) string { return "short" }
		case "operation":
			bad.Name = "send"
		case "invalid-json":
			bad.Arguments["body_json"] = "{"
		}
		if _, err := factory.Invoke(context.Background(), definition, bad); err == nil || calls != 2 {
			t.Fatal("invalid invocation reached destination", mode, err, calls)
		}
	}
}

func TestRedirectAndCancellationDoNotFollowDestination(t *testing.T) {
	followed := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { followed++; w.WriteHeader(200) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	f := Factory{Credentials: func(string) string { return strings.Repeat("k", 32) }}
	version := 1
	d := resource.Definition{Component: "webhook", Audience: "service", Version: 1, Endpoint: redirect.URL, SigningKeyEnv: "KEY"}
	op := resource.Operation{Name: "notification.send", ExpectedVersion: &version, Arguments: map[string]any{"delivery_id": "d", "body_json": "{}"}}
	if _, err := f.Invoke(context.Background(), d, op); err == nil || followed != 0 {
		t.Fatal("redirect followed", err, followed)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d.Endpoint = target.URL
	if _, err := f.Invoke(ctx, d, op); err == nil || followed != 0 {
		t.Fatal("cancelled POST sent", err, followed)
	}
}
