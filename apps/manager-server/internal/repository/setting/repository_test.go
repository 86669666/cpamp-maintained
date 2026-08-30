package setting

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
)

func TestHasHistoricalDataStopsAfterFirstRowWithLargeHistory(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`with recursive rows(value) as (
		select 1 union all select value + 1 from rows where value < 100000
	) insert into dead_letter_events(payload, error, created_at_ms)
		select printf('payload-%d', value), 'test', value from rows`); err != nil {
		t.Fatalf("seed large history: %v", err)
	}

	started := time.Now()
	present, err := New(db).HasHistoricalData(context.Background())
	if err != nil {
		t.Fatalf("detect historical data: %v", err)
	}
	if !present {
		t.Fatal("large historical dataset was not detected")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("bounded historical-data probe took %s", elapsed)
	}
}
