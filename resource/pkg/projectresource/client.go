package projectresource

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client uses native Resource HTTP. Credentials belong to the adapter process,
// never the item, view, Core event or publication body.
type Client struct {
	origin string
	token  string
	http   *http.Client
}

func NewClient(origin, token string) (*Client, error) {
	u, e := url.Parse(origin)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Host == "" || len(token) < 32 {
		return nil, errors.New("invalid resource connection")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, errors.New("resource origin requires HTTPS or loopback HTTP")
	}
	return &Client{strings.TrimSuffix(origin, "/"), token, &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

type documentReceipt struct {
	ID            string `json:"id"`
	Version       int    `json:"version"`
	SourceVersion string `json:"source_version"`
}

func (c *Client) request(ctx context.Context, method, path string, input any) (documentReceipt, int, error) {
	var receipt documentReceipt
	var body []byte
	var e error
	if input != nil {
		body, e = json.Marshal(input)
		if e != nil {
			return receipt, 0, e
		}
	}
	request, e := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(body))
	if e != nil {
		return receipt, 0, e
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	response, e := c.http.Do(request)
	if e != nil {
		return receipt, 0, errors.New("resource request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return receipt, response.StatusCode, fmt.Errorf("resource status %d", response.StatusCode)
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 256000+1))
	if e != nil || len(raw) > 256000 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") || json.Unmarshal(raw, &receipt) != nil {
		return receipt, response.StatusCode, errors.New("invalid resource receipt")
	}
	return receipt, response.StatusCode, nil
}
func (c *Client) Head(ctx context.Context, id string) (Head, error) {
	if !identifier.MatchString(id) {
		return Head{}, errors.New("invalid resource ID")
	}
	r, status, e := c.request(ctx, "GET", "/v1/resources/"+id+"/document?version=0", nil)
	if status == 404 {
		return Head{}, nil
	}
	if e != nil {
		return Head{}, e
	}
	if r.ID != id || r.Version < 1 || r.SourceVersion == "" {
		return Head{}, errors.New("invalid project view head")
	}
	return Head{r.Version, r.SourceVersion}, nil
}
func (c *Client) Publish(ctx context.Context, p Publication) (Head, error) {
	if !identifier.MatchString(p.ID) || !identifier.MatchString(p.Collection) || p.ExpectedVersion < 0 || p.SourceKind != "external" || p.MediaType != "application/json" || p.SourceVersion == "" || p.ChangeID == "" || len(p.Body) > 200000 {
		return Head{}, errors.New("invalid publication")
	}
	r, _, e := c.request(ctx, "POST", "/v1/resources/"+p.ID+"/publish", p)
	if e != nil {
		return Head{}, e
	}
	if r.ID != p.ID || r.Version != p.ExpectedVersion+1 || r.SourceVersion != p.SourceVersion {
		return Head{}, errors.New("publication receipt differs from original command")
	}
	return Head{r.Version, r.SourceVersion}, nil
}
