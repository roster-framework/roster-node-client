// Package resource owns versioned work materials and their immutable changes.
package resource

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$`)

type Publish struct {
	ID              string `json:"id"`
	Collection      string `json:"collection"`
	SourceKind      string `json:"source_kind"`
	SourceURI       string `json:"source_uri"`
	SourceVersion   string `json:"source_version,omitempty"`
	MediaType       string `json:"media_type,omitempty"`
	Title           string `json:"title"`
	Body            string `json:"body"`
	ChangeID        string `json:"change_id"`
	ExpectedVersion int    `json:"expected_version"`
}

func (p Publish) Validate() error {
	if !identifier.MatchString(p.ID) || !identifier.MatchString(p.Collection) ||
		strings.TrimSpace(p.Title) == "" || len(p.Title) > 200 || strings.TrimSpace(p.Body) == "" && p.SourceURI == "" || len(p.Body) > 200000 || len(p.MediaType) > 200 || len(p.SourceVersion) > 200 ||
		strings.TrimSpace(p.ChangeID) == "" || len(p.ChangeID) > 200 || p.ExpectedVersion < 0 {
		return errors.New("자료 ID·소유 범위·묶음·제목·본문·변경 ID·기대 버전을 확인하세요")
	}
	switch p.SourceKind {
	case "upload", "file", "mcp", "external":
	default:
		return errors.New("잘못된 자료 출처 종류")
	}
	if p.SourceURI != "" {
		u, err := url.Parse(p.SourceURI)
		if err != nil || !u.IsAbs() || u.User != nil || len(p.SourceURI) > 2000 {
			return errors.New("원본 URI는 자격 증명 없는 절대 URI여야 합니다")
		}
	}
	return nil
}

type Document struct {
	ID            string `json:"id"`
	Collection    string `json:"collection"`
	SourceKind    string `json:"source_kind"`
	SourceURI     string `json:"source_uri"`
	SourceVersion string `json:"source_version,omitempty"`
	MediaType     string `json:"media_type,omitempty"`
	Title         string `json:"title"`
	Body          string `json:"body,omitempty"`
	Version       int    `json:"version"`
	Updated       string `json:"updated"`
}

func (d Document) Next(p Publish, at string) (Document, error) {
	if err := p.Validate(); err != nil {
		return Document{}, err
	}
	if d.Version != p.ExpectedVersion || d.Version > 0 && (d.ID != p.ID || d.Collection != p.Collection) {
		return Document{}, ErrConflict
	}
	uri := p.SourceURI
	if uri == "" {
		uri = "roster://resources/" + p.ID
	}
	return Document{ID: p.ID, Collection: p.Collection, SourceKind: p.SourceKind, SourceURI: uri, SourceVersion: p.SourceVersion, MediaType: p.MediaType, Title: p.Title, Body: p.Body, Version: d.Version + 1, Updated: at}, nil
}

type Change struct {
	ID         string `json:"id"`
	ResourceID string `json:"resource_id"`
	Collection string `json:"collection"`
	Version    int    `json:"version"`
	Type       string `json:"type"`
	At         string `json:"at"`
}

func ChangeKey(resourceID, changeID string) string {
	sum := sha256.Sum256([]byte(resourceID + "\x00" + changeID))
	return "resource-" + hex.EncodeToString(sum[:])
}

func (d Document) Changed(changeID string) Change {
	kind := "resource.updated"
	if d.Version == 1 {
		kind = "resource.created"
	}
	return Change{ID: ChangeKey(d.ID, changeID), ResourceID: d.ID, Collection: d.Collection, Version: d.Version, Type: kind, At: d.Updated}
}
