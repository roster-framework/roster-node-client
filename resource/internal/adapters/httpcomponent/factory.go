package httpcomponent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"slices"
	"time"
)

// Factory invokes a versioned JSON service without importing provider domains.
type Factory struct {
	Credentials func(string) string
	Client      *http.Client
}

func (f Factory) Invoke(ctx context.Context, d resource.Definition, op resource.Operation) (any, error) {
	if d.Component != "http" || !slices.Contains(d.Operations, op.Name) || op.Tool != "" {
		return nil, resource.ErrUnsupported
	}
	if err := resource.ValidateEndpoint(d.Endpoint); err != nil {
		return nil, err
	}
	token := ""
	if d.CredentialEnv != "" {
		if f.Credentials == nil {
			return nil, errors.New("component credential unavailable")
		}
		token = f.Credentials(d.CredentialEnv)
		if token == "" {
			return nil, errors.New("component credential unavailable")
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	body, err := json.Marshal(op)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Roster-Service-Protocol", d.Protocol)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := http.Client{}
	if f.Client != nil {
		client = *f.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("component redirect refused") }
	response, err := client.Do(req)
	if err != nil {
		return nil, errors.New("component invocation failed")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 404:
		return nil, resource.ErrNotFound
	case 409:
		return nil, resource.ErrConflict
	case 422:
		return nil, resource.ErrUnsupported
	}
	if response.StatusCode != 200 {
		return nil, errors.New("component response failed")
	}
	if response.Header.Get("X-Roster-Service-Protocol") != d.Protocol {
		return nil, errors.New("component protocol mismatch")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 5_000_001))
	if err != nil || len(raw) > 5_000_000 {
		return nil, errors.New("component response limit")
	}
	var out any
	if err = json.Unmarshal(raw, &out); err != nil {
		return nil, errors.New("invalid component response")
	}
	return out, nil
}
