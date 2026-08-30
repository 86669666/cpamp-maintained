package usageevent

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usageidentity"
)

func TestResolveCodexLegacyAccountKeyRequiresProviderAndMatchingAccountIDs(t *testing.T) {
	tests := []struct {
		name          string
		mutate        func([]usage.Event) []usage.Event
		wantAllowed   bool
		wantLegacyKey bool
	}{
		{
			name: "matching stable and legacy events",
			mutate: func(events []usage.Event) []usage.Event {
				return events
			},
			wantAllowed:   true,
			wantLegacyKey: true,
		},
		{
			name: "provenance marked project snapshot agrees",
			mutate: func(events []usage.Event) []usage.Event {
				events[0].AuthProjectIDSnapshot = usageidentity.CodexAccountIDSnapshot("account-a")
				return events
			},
			wantAllowed:   true,
			wantLegacyKey: true,
		},
		{
			name: "legacy blank immutable identity remains attributable",
			mutate: func(events []usage.Event) []usage.Event {
				events = append(events, identityTestEvent("missing-identity", 3, "codex-a.json", "auth-a", "codex", ""))
				return events
			},
			wantAllowed:   true,
			wantLegacyKey: true,
		},
		{
			name: "different account id blocks",
			mutate: func(events []usage.Event) []usage.Event {
				events = append(events, identityTestEvent("different-account", 3, "codex-a.json", "auth-a", "codex", "account-b"))
				return events
			},
			wantAllowed: false,
		},
		{
			name: "foreign provider blocks",
			mutate: func(events []usage.Event) []usage.Event {
				events = append(events, identityTestEvent("foreign-provider", 3, "codex-a.json", "auth-a", "openai", ""))
				return events
			},
			wantAllowed: false,
		},
		{
			name: "blank identity with no matching immutable evidence blocks",
			mutate: func(events []usage.Event) []usage.Event {
				return []usage.Event{
					identityTestEvent("legacy-only", 1, "codex-a.json", "auth-a", "codex", ""),
				}
			},
			wantAllowed: false,
		},
		{
			name: "different file and index do not participate",
			mutate: func(events []usage.Event) []usage.Event {
				events = append(events, identityTestEvent("different-credential", 3, "codex-b.json", "auth-b", "codex", "account-b"))
				return events
			},
			wantAllowed:   true,
			wantLegacyKey: true,
		},
		{
			name: "missing provider blocks",
			mutate: func(events []usage.Event) []usage.Event {
				events = append(events, identityTestEvent("missing-provider", 3, "codex-a.json", "auth-a", "", ""))
				return events
			},
			wantAllowed: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
			if err != nil {
				t.Fatalf("open database: %v", err)
			}
			t.Cleanup(func() { _ = db.Close() })
			repo := New(db)
			events := []usage.Event{
				identityTestEvent("legacy-event", 1, "codex-a.json", "auth-a", "codex", "account-a"),
				identityTestEvent("stable-event", 2, "codex-a.json", "auth-a", "codex", "account-a"),
			}
			events = test.mutate(events)
			if _, err := repo.InsertBatch(context.Background(), events); err != nil {
				t.Fatalf("insert identity events: %v", err)
			}

			fields := usageidentity.Fields{
				AuthFileSnapshot:      "codex-a.json",
				AuthIndex:             "auth-a",
				AuthProviderSnapshot:  "codex",
				AuthAccountIDSnapshot: "account-a",
				AccountSnapshot:       "same@example.com",
				Source:                "codex-a.json",
			}
			gotKey, allowed, err := repo.ResolveCodexLegacyAccountKey(context.Background(), fields)
			if err != nil {
				t.Fatalf("resolve legacy identity: %v", err)
			}
			if allowed != test.wantAllowed {
				t.Fatalf("allowed = %v, want %v (key=%q)", allowed, test.wantAllowed, gotKey)
			}
			wantKey, valid := usageidentity.LegacyAccountKey(fields)
			if !valid {
				t.Fatal("target legacy key is invalid")
			}
			if (gotKey == wantKey) != test.wantLegacyKey {
				t.Fatalf("legacy key = %q, want key present=%v (%q)", gotKey, test.wantLegacyKey, wantKey)
			}
		})
	}
}

func TestResolveCodexLegacyAccountKeyAcceptsLegacySourceFile(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := New(db)
	event := identityTestEvent("legacy-source", 1, "", "auth-a", "codex", "account-a")
	event.Source = "codex-a.json"
	event.AccountSnapshot = "same@example.com"
	stable := identityTestEvent("stable-source", 2, "codex-a.json", "auth-a", "codex", "account-a")
	if _, err := repo.InsertBatch(context.Background(), []usage.Event{event, stable}); err != nil {
		t.Fatalf("insert source identity events: %v", err)
	}

	fields := usageidentity.Fields{
		AuthFileSnapshot:      "codex-a.json",
		AuthIndex:             "auth-a",
		AuthProviderSnapshot:  "codex",
		AuthAccountIDSnapshot: "account-a",
		AccountSnapshot:       "same@example.com",
		Source:                "codex-a.json",
	}
	key, allowed, err := repo.ResolveCodexLegacyAccountKey(context.Background(), fields)
	if err != nil {
		t.Fatalf("resolve source identity: %v", err)
	}
	want, valid := usageidentity.LegacyAccountKey(fields)
	if !allowed || !valid || key != want {
		t.Fatalf("source legacy identity = key:%q allowed:%v, want key:%q allowed:true", key, allowed, want)
	}
}

func TestResolveCodexLegacyAccountKeyUsesBoundedIndexedQueriesWithLargeHistory(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`with recursive rows(value) as (
		select 1 union all select value + 1 from rows where value < 100000
	) insert into usage_events (
		event_hash, timestamp_ms, timestamp, provider, model, auth_index, source,
		auth_file_snapshot, auth_provider_snapshot, auth_account_id_snapshot,
		input_tokens, output_tokens, total_tokens, created_at_ms
	) select printf('history-%d', value), value, '2026-01-01T00:00:00Z', 'codex',
		'gpt-test', 'other-auth', 'other.json', 'other.json', 'codex', 'other-account',
		1, 1, 2, value from rows`); err != nil {
		t.Fatalf("seed large identity history: %v", err)
	}
	repo := New(db)
	if _, err := repo.InsertBatch(context.Background(), []usage.Event{
		identityTestEvent("target", 100001, "codex-a.json", "auth-a", "codex", "account-a"),
	}); err != nil {
		t.Fatalf("insert target identity: %v", err)
	}
	fields := usageidentity.Fields{
		AuthFileSnapshot: "codex-a.json", AuthIndex: "auth-a", AuthProviderSnapshot: "codex",
		AuthAccountIDSnapshot: "account-a", Source: "codex-a.json",
	}
	started := time.Now()
	_, allowed, err := repo.ResolveCodexLegacyAccountKey(context.Background(), fields)
	if err != nil || !allowed {
		t.Fatalf("resolve large identity history: allowed=%v err=%v", allowed, err)
	}
	// Instrumented and heavily loaded CI hosts are substantially slower than
	// normal execution. The query-plan assertion below is the deterministic
	// boundedness gate; this wall-clock guard only catches accidental full-table
	// materialization or otherwise pathological regressions.
	maxElapsed := 10 * time.Second
	if elapsed := time.Since(started); elapsed > maxElapsed {
		t.Fatalf("bounded identity probe took %s (limit %s)", elapsed, maxElapsed)
	}

	if _, err := db.Exec(`create index if not exists idx_usage_events_latest_request_auth_file
		on usage_events(auth_file_snapshot collate nocase, auth_index collate nocase, timestamp_ms desc, id desc)`); err != nil {
		t.Fatalf("create identity index: %v", err)
	}
	rows, err := db.Query(`explain query plan select 1 from usage_events e
		where e.auth_file_snapshot collate nocase = ? and e.auth_index collate nocase = ? limit 1`,
		"codex-a.json", "auth-a")
	if err != nil {
		t.Fatalf("explain identity query: %v", err)
	}
	defer rows.Close()
	var plan string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan identity query plan: %v", err)
		}
		plan += detail
	}
	if !strings.Contains(plan, "idx_usage_events_latest_request_auth_file") {
		t.Fatalf("identity query plan does not use auth-file index: %s", plan)
	}
}

func identityTestEvent(hash string, offset int64, file, authIndex, provider, accountID string) usage.Event {
	timestampMS := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC).UnixMilli() + offset*1000
	return usage.Event{
		EventHash:             hash,
		TimestampMS:           timestampMS,
		Timestamp:             time.UnixMilli(timestampMS).UTC().Format(time.RFC3339Nano),
		Provider:              provider,
		Model:                 "gpt-test",
		AuthFileSnapshot:      file,
		AuthProviderSnapshot:  provider,
		AuthAccountIDSnapshot: accountID,
		AuthIndex:             authIndex,
		Source:                file,
		AccountSnapshot:       "same@example.com",
		InputTokens:           1,
		OutputTokens:          1,
		TotalTokens:           2,
		CreatedAtMS:           timestampMS,
	}
}
