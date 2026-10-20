// Package projectresource prepares provider-neutral filtered project resources.
// Providers own fetching and cursors; Core owns recipient authority and routing.
package projectresource

import (
	"errors"
	"net/url"
	"strings"
)

type Item struct {
	ID       string   `json:"id"`
	Revision string   `json:"revision"`
	Title    string   `json:"title"`
	Body     string   `json:"body"`
	URL      string   `json:"url,omitempty"`
	Labels   []string `json:"labels"`
	State    string   `json:"state"`
}

func (i Item) validate() error {
	if strings.TrimSpace(i.ID) == "" || len(i.ID) > 200 || i.Revision == "" || len(i.Revision) > 200 || strings.TrimSpace(i.Title) == "" || len(i.Title) > 200 || len(i.Body) > 100000 || len(i.Labels) > 100 || i.State == "" || len(i.State) > 100 {
		return errors.New("invalid project item")
	}
	if i.URL != "" {
		u, e := url.Parse(i.URL)
		if e != nil || u.User != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || len(i.URL) > 2000 {
			return errors.New("invalid item URL")
		}
	}
	seen := map[string]bool{}
	for _, label := range i.Labels {
		if strings.TrimSpace(label) == "" || len(label) > 100 || seen[label] {
			return errors.New("invalid item labels")
		}
		seen[label] = true
	}
	return nil
}
