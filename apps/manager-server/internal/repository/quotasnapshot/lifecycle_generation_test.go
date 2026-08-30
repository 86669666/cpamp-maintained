package quotasnapshot

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestLifecycleQueriesFenceCurrentWindowGeneration(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, statement := range []string{
		`create table account_quota_windows (id integer primary key autoincrement, account_key text not null, provider text not null, provider_window_id text not null, window_kind text not null, window_mode text not null, model_scope_kind text not null, model_scope_key text, model_ids_json text, scope_fingerprint text not null, inventory_scope_key text not null, relationship_kind text, container_provider_window_id text, availability text not null, generation integer not null, absence_count integer not null default 0, first_seen_at_ms integer not null, last_seen_at_ms integer not null, missing_since_ms integer, deactivated_at_ms integer, last_observation_id integer, created_at_ms integer not null, updated_at_ms integer not null)`,
		`create table account_quota_window_activations (id integer primary key autoincrement, window_id integer not null, generation integer not null, status text not null, activated_at_ms integer not null, deactivated_at_ms integer, activation_accuracy text not null, deactivation_reason text, activate_observation_id integer, deactivate_observation_id integer, created_at_ms integer not null, updated_at_ms integer not null)`,
		`create table account_quota_cycles (id integer primary key autoincrement, activation_id integer not null, provider_cycle_key text not null, state text not null, scheduled_start_ms integer, scheduled_end_ms integer, actual_start_ms integer not null, actual_end_ms integer, duration_seconds integer, boundary_accuracy text not null, end_reason text, first_observation_id integer, last_observation_id integer, parent_cycle_id integer, created_at_ms integer not null, updated_at_ms integer not null)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create lifecycle schema: %v", err)
		}
	}
	result, err := db.Exec(`insert into account_quota_windows (
		account_key, provider, provider_window_id, window_kind, window_mode,
		model_scope_kind, scope_fingerprint, inventory_scope_key, availability,
		generation, first_seen_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms
	) values ('account-a', 'codex', 'primary', 'primary', 'rolling', 'all',
		'scope-a', 'inventory-a', 'active', 2, 1, 1, 1, 1)`)
	if err != nil {
		t.Fatalf("insert window: %v", err)
	}
	windowID, _ := result.LastInsertId()
	if _, err := db.Exec(`insert into account_quota_window_activations (
		window_id, generation, status, activated_at_ms, activation_accuracy, created_at_ms, updated_at_ms
	) values (?, 1, 'active', 1, 'exact', 1, 1), (?, 2, 'active', 2, 'exact', 2, 2)`, windowID, windowID); err != nil {
		t.Fatalf("insert activations: %v", err)
	}
	var oldActivationID, currentActivationID int64
	if err := db.QueryRow(`select id from account_quota_window_activations where window_id = ? and generation = 1`, windowID).Scan(&oldActivationID); err != nil {
		t.Fatalf("read old activation: %v", err)
	}
	if err := db.QueryRow(`select id from account_quota_window_activations where window_id = ? and generation = 2`, windowID).Scan(&currentActivationID); err != nil {
		t.Fatalf("read current activation: %v", err)
	}
	if _, err := db.Exec(`insert into account_quota_cycles (
		activation_id, provider_cycle_key, state, actual_start_ms, boundary_accuracy, created_at_ms, updated_at_ms
	) values (?, 'old', 'active', 200, 'exact', 1, 1), (?, 'current', 'active', 100, 'exact', 1, 1)`, oldActivationID, currentActivationID); err != nil {
		t.Fatalf("insert cycles: %v", err)
	}

	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	activationID, err := activeActivationID(context.Background(), tx, windowID)
	if err != nil {
		t.Fatalf("resolve active activation: %v", err)
	}
	if activationID != currentActivationID {
		t.Fatalf("active activation = %d, want current generation %d", activationID, currentActivationID)
	}
	cycleID, found, err := resolveContainerCycleID(
		context.Background(), tx, "account-a", "codex", "primary", "scope-a", "inventory-a", 300,
	)
	if err != nil || !found {
		t.Fatalf("resolve current container cycle: id=%d found=%v err=%v", cycleID, found, err)
	}
	var cycleActivationID int64
	if err := tx.QueryRow(`select activation_id from account_quota_cycles where id = ?`, cycleID).Scan(&cycleActivationID); err != nil {
		t.Fatalf("read resolved cycle: %v", err)
	}
	if cycleActivationID != currentActivationID {
		t.Fatalf("resolved cycle activation = %d, want current generation %d", cycleActivationID, currentActivationID)
	}
}
