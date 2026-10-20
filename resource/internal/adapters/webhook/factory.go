package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strconv"
	"strings"
	"time"
)

// Factory owns provider URL/authentication/signing, never organization routing.
type Factory struct {
	Credentials func(string) string
	Client      *http.Client
	Now         func() time.Time
}

func (f Factory) Invoke(ctx context.Context, d resource.Definition, op resource.Operation) (any, error) {
	if d.Component != "webhook" || d.Audience != "service" || op.Name != "notification.send" || op.Tool != "" || op.ExpectedVersion == nil || *op.ExpectedVersion != d.Version {
		return nil, resource.ErrUnsupported
	}
	if err := resource.ValidateEndpoint(d.Endpoint); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(op.Arguments)
	if err != nil {
		return nil, resource.ErrUnsupported
	}
	var input struct {
		DeliveryID string `json:"delivery_id"`
		Body       string `json:"body_json"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !resource.ValidConsumer(input.DeliveryID) || len(input.Body) == 0 || len(input.Body) > 65536 || !json.Valid([]byte(input.Body)) {
		return nil, resource.ErrUnsupported
	}
	if f.Credentials == nil {
		return nil, errors.New("webhook credentials unavailable")
	}
	key := f.Credentials(d.SigningKeyEnv)
	if len(key) < 32 {
		return nil, errors.New("webhook signing key unavailable")
	}
	token := ""
	if d.CredentialEnv != "" {
		token = f.Credentials(d.CredentialEnv)
		if token == "" {
			return nil, errors.New("webhook credential unavailable")
		}
	}
	now := time.Now()
	if f.Now != nil {
		now = f.Now()
	}
	timestamp := strconv.FormatInt(now.Unix(), 10)
	digest := hmac.New(sha256.New, []byte(key))
	_, _ = io.WriteString(digest, timestamp+"."+input.DeliveryID+"."+input.Body)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, d.Endpoint, strings.NewReader(input.Body))
	if err != nil {
		return nil, errors.New("webhook request invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Roster-Delivery-ID", input.DeliveryID)
	request.Header.Set("X-Roster-Timestamp", timestamp)
	request.Header.Set("X-Roster-Signature", "sha256="+hex.EncodeToString(digest.Sum(nil)))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	client := http.Client{}
	if f.Client != nil {
		client = *f.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("webhook redirect refused") }
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("webhook delivery unavailable")
	}
	defer response.Body.Close()
	// A successful HTTP status is acceptance; provider response bodies are private.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New("webhook delivery not accepted")
	}
	return struct {
		DeliveryID string `json:"delivery_id"`
		Accepted   bool   `json:"accepted"`
	}{input.DeliveryID, true}, nil
}
