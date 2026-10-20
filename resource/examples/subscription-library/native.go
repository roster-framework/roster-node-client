package subscriptionlibrary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var regexpStream = regexp.MustCompile(`^example-stream-[a-f0-9]{48}$`)

// NativeRegistrar has separate registration authority. Its key is never passed
// to Core, an agent, a receipt or a document.
type NativeRegistrar struct {
	origin string
	token  string
	client *http.Client
}

func NewNativeRegistrar(origin, token string) (*NativeRegistrar, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || len(token) < 32 {
		return nil, errors.New("invalid registration connection")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, errors.New("registration requires HTTPS or loopback")
	}
	return &NativeRegistrar{strings.TrimSuffix(origin, "/"), token, &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (n *NativeRegistrar) request(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	r, err := http.NewRequestWithContext(ctx, method, n.origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	r.Header.Set("Authorization", "Bearer "+n.token)
	r.Header.Set("Content-Type", "application/json")
	response, err := n.client.Do(r)
	if err != nil {
		return nil, 0, errors.New("registration request failed")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 100001))
	if err != nil || len(raw) > 100000 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return nil, response.StatusCode, errors.New("invalid registration response")
	}
	return raw, response.StatusCode, nil
}

func (n *NativeRegistrar) EnsureStream(ctx context.Context, id string) error {
	if !regexpStream.MatchString(id) {
		return errors.New("invalid example stream ID")
	}
	raw, status, err := n.request(ctx, "GET", "/v1/resources/"+id, nil)
	if err != nil {
		return err
	}
	if status == 404 {
		body, _ := json.Marshal(map[string]any{"id": id, "name": "Example project stream", "component": "document", "audience": "agent", "version": 0})
		raw, status, err = n.request(ctx, "POST", "/v1/resources", body)
		if err != nil {
			return err
		}
		if status == 409 {
			raw, status, err = n.request(ctx, "GET", "/v1/resources/"+id, nil)
			if err != nil {
				return err
			}
		}
	}
	var metadata struct {
		ID         string   `json:"id"`
		Component  string   `json:"component"`
		Audience   string   `json:"audience"`
		Version    int      `json:"version"`
		Operations []string `json:"operations"`
	}
	if status != 200 || json.Unmarshal(raw, &metadata) != nil || metadata.ID != id || metadata.Component != "document" || metadata.Audience != "agent" || metadata.Version != 1 || len(metadata.Operations) != 2 || metadata.Operations[0] != "read" || metadata.Operations[1] != "publish" {
		return errors.New("registered stream differs from original intent")
	}
	return nil
}
