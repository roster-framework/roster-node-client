// Package subscriptionlibrary is an optional author example, not a built-in
// Resource component. Its label selection and storage are library policy.
package subscriptionlibrary

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sync"
	"time"

	"github.com/roster-framework/roster-node-client/resource/pkg/projectresource"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
)

var ErrConflict = errors.New("subscription request identity already used")
var labelPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

type Configuration struct {
	Label string `json:"label"`
}

// Registrar owns Resource registration. A successful call must confirm that the
// existing stream has the same document identity and agent audience.
type Registrar interface {
	EnsureStream(context.Context, string) error
}

type Library struct {
	mu        sync.Mutex
	db        *sql.DB
	registrar Registrar
	publisher projectresource.Publisher
	outbox    *projectresource.SQLiteOutbox
}

func Declaration() subscriptioncontract.Declaration {
	schema := json.RawMessage(`{"type":"object","required":["label"],"additionalProperties":false,"properties":{"label":{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$"}}}`)
	d := subscriptioncontract.Declaration{Protocol: subscriptioncontract.Protocol, ID: "example-label", ConfigurationSchema: schema, ConfigureOperation: subscriptioncontract.Operation{Name: "configure"}, OptionsOperation: &subscriptioncontract.Operation{Name: "options"}, Events: []string{"resource.created", "resource.updated"}}
	raw, _ := json.Marshal(d)
	sum := sha256.Sum256(raw)
	d.Revision = hex.EncodeToString(sum[:])
	return d
}

// New uses a caller-owned SQLite connection. The caller selects the durable
// directory and driver; no Core database or credentials enter stored commands.
func New(db *sql.DB, registrar Registrar, publisher projectresource.Publisher) (*Library, error) {
	if db == nil || registrar == nil || publisher == nil {
		return nil, errors.New("library ports required")
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS example_subscriptions (id TEXT PRIMARY KEY, digest TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT NOT NULL)`); err != nil {
		return nil, err
	}
	outbox, err := projectresource.NewSQLiteOutbox(context.Background(), db)
	if err != nil {
		return nil, err
	}
	return &Library{db: db, registrar: registrar, publisher: publisher, outbox: outbox}, nil
}

func decodeConfiguration(raw json.RawMessage) (Configuration, error) {
	var c Configuration
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return c, err
	}
	if d.Decode(new(any)) != io.EOF || !labelPattern.MatchString(c.Label) {
		return c, errors.New("invalid example label configuration")
	}
	return c, nil
}

func (l *Library) load(ctx context.Context, id string) (subscriptioncontract.Command, subscriptioncontract.Receipt, error) {
	var c subscriptioncontract.Command
	var r subscriptioncontract.Receipt
	var command, receipt, digest string
	err := l.db.QueryRowContext(ctx, `SELECT command,receipt,digest FROM example_subscriptions WHERE id=?`, id).Scan(&command, &receipt, &digest)
	if err != nil {
		return c, r, err
	}
	if json.Unmarshal([]byte(command), &c) != nil || json.Unmarshal([]byte(receipt), &r) != nil || c.ID != id || r.RequestDigest != digest || r.Replayed || r.ValidateFor(c, Declaration()) != nil {
		return c, r, errors.New("invalid original library configuration")
	}
	if _, err = decodeConfiguration(c.Configuration); err != nil {
		return c, r, err
	}
	return c, r, nil
}

func (l *Library) Configure(ctx context.Context, c subscriptioncontract.Command) (subscriptioncontract.Receipt, error) {
	if c.ResourceID != "example-project" || c.Match(Declaration()) != nil {
		return subscriptioncontract.Receipt{}, errors.New("example subscription contract mismatch")
	}
	if _, err := decodeConfiguration(c.Configuration); err != nil {
		return subscriptioncontract.Receipt{}, err
	}
	digest, err := c.Digest()
	if err != nil {
		return subscriptioncontract.Receipt{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, r, err := l.load(ctx, c.ID)
	replayed := err == nil
	if errors.Is(err, sql.ErrNoRows) {
		r = subscriptioncontract.Receipt{Protocol: subscriptioncontract.Protocol, RequestID: c.ID, ResourceID: c.ResourceID, ExtensionID: c.ExtensionID, ExtensionRevision: c.ExtensionRevision, RequestDigest: digest, StreamResourceID: "example-stream-" + digest[:48], Events: append([]string(nil), Declaration().Events...), AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		command, _ := json.Marshal(c)
		receipt, _ := json.Marshal(r)
		// Commit intent BEFORE external registration. After a crash a retry uses
		// the same stream, timestamp and command, including response loss.
		var result sql.Result
		result, err = l.db.ExecContext(ctx, `INSERT INTO example_subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`, c.ID, digest, string(command), string(receipt))
		if err == nil {
			var affected int64
			affected, err = result.RowsAffected()
			if err == nil && affected == 0 {
				_, r, err = l.load(ctx, c.ID)
				replayed = true
			}
		}
	}
	if err != nil {
		return subscriptioncontract.Receipt{}, err
	}
	if r.RequestDigest != digest {
		return subscriptioncontract.Receipt{}, ErrConflict
	}
	if err = l.registrar.EnsureStream(ctx, r.StreamResourceID); err != nil {
		return subscriptioncontract.Receipt{}, err
	}
	r.Replayed = replayed
	return r, nil
}

type snapshot []projectresource.Item

func (s snapshot) Snapshot(context.Context) ([]projectresource.Item, error) { return s, nil }

// Sync is explicitly invoked by the author's collector. Resource/Core do not
// choose labels, poll a provider or synthesize collection changes.
func (l *Library) Sync(ctx context.Context, requestID string, items []projectresource.Item) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, r, err := l.load(ctx, requestID)
	if err != nil {
		return false, err
	}
	configuration, err := decodeConfiguration(c.Configuration)
	if err != nil {
		return false, err
	}
	if err = l.registrar.EnsureStream(ctx, r.StreamResourceID); err != nil {
		return false, err
	}
	return (projectresource.Synchronizer{View: projectresource.View{ID: r.StreamResourceID, Collection: "example-project", Name: "Example selected project items", Provider: "example", Project: "local", Selector: projectresource.Selector{AllLabels: []string{configuration.Label}}}, Source: snapshot(items), Publisher: l.publisher, Outbox: l.outbox}).Sync(ctx)
}
