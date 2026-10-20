package projectresource

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)

type View struct {
	ID         string   `json:"id"`
	Collection string   `json:"collection"`
	Name       string   `json:"name"`
	Provider   string   `json:"provider"`
	Project    string   `json:"project"`
	Selector   Selector `json:"selector"`
}
type Head struct {
	Version       int    `json:"version"`
	SourceVersion string `json:"source_version"`
}

// Publication is the existing native Resource publish contract, not an MCP call.
type Publication struct {
	ID              string `json:"id"`
	Collection      string `json:"collection"`
	SourceKind      string `json:"source_kind"`
	SourceVersion   string `json:"source_version"`
	MediaType       string `json:"media_type"`
	Title           string `json:"title"`
	Body            string `json:"body"`
	ChangeID        string `json:"change_id"`
	ExpectedVersion int    `json:"expected_version"`
}

// Prepare requires a complete authoritative snapshot. Partial polling pages must
// first be combined by the provider adapter, or removed items would be fabricated.
// A nil command means the filtered snapshot is unchanged; do not emit another event.
func (v View) Prepare(items []Item, current Head) (*Publication, error) {
	if !identifier.MatchString(v.ID) || !identifier.MatchString(v.Collection) || v.Name == "" || len(v.Name) > 200 || v.Provider == "" || len(v.Provider) > 100 || v.Project == "" || len(v.Project) > 200 || len(items) > 1000 || current.Version < 0 {
		return nil, errors.New("invalid project view")
	}
	if err := v.Selector.validate(); err != nil {
		return nil, err
	}
	selected := []Item{}
	seen := map[string]bool{}
	for _, i := range items {
		if err := i.validate(); err != nil {
			return nil, err
		}
		if seen[i.ID] {
			return nil, errors.New("duplicate project item")
		}
		seen[i.ID] = true
		if !v.Selector.matches(i) {
			continue
		}
		i.Labels = append([]string{}, i.Labels...)
		sort.Strings(i.Labels)
		selected = append(selected, i)
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].ID < selected[j].ID })
	snapshot := struct {
		Version  int    `json:"version"`
		Provider string `json:"provider"`
		Project  string `json:"project"`
		Items    []Item `json:"items"`
	}{1, v.Provider, v.Project, selected}
	body, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	if len(body) > 200000 {
		return nil, errors.New("filtered snapshot exceeds resource body limit")
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	if current.Version > 0 && current.SourceVersion == digest {
		return nil, nil
	}
	// Include predecessor so returning to a previous snapshot remains a new change.
	change := sha256.Sum256([]byte(digest + ":" + stringMustJSON(current.Version)))
	return &Publication{v.ID, v.Collection, "external", digest, "application/json", v.Name, string(body), hex.EncodeToString(change[:]), current.Version}, nil
}
func stringMustJSON(value int) string { b, _ := json.Marshal(value); return string(b) }
