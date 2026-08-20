package bootstrap

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"

	_ "modernc.org/sqlite"
)

func TestRunMigratesLegacySetupAndEncryptsSecrets(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "usage.sqlite")
	legacyStore, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open legacy store: %v", err)
	}
	if err := legacyStore.SaveSetup(context.Background(), store.Setup{
		CPAUpstreamURL: "http://cpa.local:8317",
		ManagementKey:  "management-key",
		Queue:          "usage",
		PopSide:        "right",
	}); err != nil {
		t.Fatalf("save legacy setup: %v", err)
	}
	if err := legacyStore.Close(); err != nil {
		t.Fatalf("close legacy store: %v", err)
	}

	protector, err := security.NewProtector([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("create protector: %v", err)
	}
	st, err := store.Open(dbPath, protector)
	if err != nil {
		t.Fatalf("open protected store: %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
	})

	result, err := Run(context.Background(), config.Config{
		DBPath:        dbPath,
		Queue:         "usage",
		PopSide:       "right",
		BatchSize:     100,
		QueryLimit:    50000,
		CollectorMode: "auto",
	}, st, true)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if !result.AdminCreated || result.GeneratedAdminKey == "" {
		t.Fatalf("admin credential result = %#v", result)
	}
	if !result.MigratedLegacy || !result.HasHistoricalData || !result.State.ProjectInitialized {
		t.Fatalf("bootstrap result = %#v", result)
	}

	credential, ok, err := st.LoadAdminCredential(context.Background())
	if err != nil || !ok {
		t.Fatalf("load admin credential ok=%v err=%v", ok, err)
	}
	if !security.VerifyAdminKey(credential, result.GeneratedAdminKey) {
		t.Fatal("generated admin key does not verify")
	}
	if security.VerifyAdminKey(credential, "management-key") {
		t.Fatal("cpa management key should not verify as admin key")
	}

	managerCfg, ok, err := st.LoadManagerConfig(context.Background())
	if err != nil || !ok {
		t.Fatalf("load migrated manager config ok=%v err=%v", ok, err)
	}
	if managerCfg.CPAConnection.CPABaseURL != "http://cpa.local:8317" ||
		managerCfg.CPAConnection.ManagementKey != "management-key" {
		t.Fatalf("migrated manager config = %#v", managerCfg)
	}

	for _, key := range []string{"setup", "manager_config_v1"} {
		raw := rawBootstrapSettingValue(t, dbPath, key)
		if strings.Contains(raw, "management-key") || !strings.Contains(raw, "enc:v1:") {
			t.Fatalf("%s setting was not encrypted: %s", key, raw)
		}
	}
}

func TestMigrateLegacySetupRepairsPartialManagerConfig(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "usage.sqlite")
	legacyStore, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open legacy store: %v", err)
	}
	if err := legacyStore.SaveManagerConfig(context.Background(), store.ManagerConfig{
		CPAConnection: store.ManagerCPAConnectionConfig{CPABaseURL: "http://cpa.local:8317/"},
		Collector:     store.ManagerCollectorConfig{Queue: "manager-queue"},
	}); err != nil {
		_ = legacyStore.Close()
		t.Fatalf("save partial manager config: %v", err)
	}
	if err := legacyStore.SaveSetup(context.Background(), store.Setup{
		CPAUpstreamURL: "http://cpa.local:8317",
		ManagementKey:  "management-key",
		Queue:          "legacy-queue",
		PopSide:        "left",
	}); err != nil {
		_ = legacyStore.Close()
		t.Fatalf("save legacy setup: %v", err)
	}
	if err := legacyStore.Close(); err != nil {
		t.Fatalf("close legacy store: %v", err)
	}

	protector, err := security.NewProtector([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("create protector: %v", err)
	}
	st, err := store.Open(dbPath, protector)
	if err != nil {
		t.Fatalf("open protected store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	migrated, err := migrateLegacyConfig(context.Background(), config.Config{Queue: "usage", PopSide: "right"}, st)
	if err != nil {
		t.Fatalf("migrate legacy config: %v", err)
	}
	if !migrated {
		t.Fatal("migration was not reported")
	}
	managerCfg, ok, err := st.LoadManagerConfig(context.Background())
	if err != nil || !ok {
		t.Fatalf("load manager config ok=%v err=%v", ok, err)
	}
	if managerCfg.CPAConnection.CPABaseURL != "http://cpa.local:8317" ||
		managerCfg.CPAConnection.ManagementKey != "management-key" {
		t.Fatalf("repaired manager config = %#v", managerCfg.CPAConnection)
	}
	if managerCfg.Collector.Queue != "manager-queue" || managerCfg.Collector.PopSide != "left" {
		t.Fatalf("manager collector settings changed unexpectedly = %#v", managerCfg.Collector)
	}
	for _, key := range []string{"setup", "manager_config_v1"} {
		raw := rawBootstrapSettingValue(t, dbPath, key)
		if strings.Contains(raw, "management-key") || !strings.Contains(raw, "enc:v1:") {
			t.Fatalf("%s setting was not encrypted: %s", key, raw)
		}
	}
}

func TestMigrateLegacySetupKeepsCompleteManagerConfigAsAuthority(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "usage.sqlite")
	legacyStore, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open legacy store: %v", err)
	}
	if err := legacyStore.SaveManagerConfig(context.Background(), store.ManagerConfig{
		CPAConnection: store.ManagerCPAConnectionConfig{
			CPABaseURL:    "http://manager-cpa.local:8317",
			ManagementKey: "manager-key",
		},
	}); err != nil {
		_ = legacyStore.Close()
		t.Fatalf("save manager config: %v", err)
	}
	if err := legacyStore.SaveSetup(context.Background(), store.Setup{
		CPAUpstreamURL: "http://legacy-cpa.local:8317",
		ManagementKey:  "legacy-key",
	}); err != nil {
		_ = legacyStore.Close()
		t.Fatalf("save legacy setup: %v", err)
	}
	if err := legacyStore.Close(); err != nil {
		t.Fatalf("close legacy store: %v", err)
	}

	protector, err := security.NewProtector([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("create protector: %v", err)
	}
	st, err := store.Open(dbPath, protector)
	if err != nil {
		t.Fatalf("open protected store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if migrated, err := migrateLegacyConfig(context.Background(), config.Config{}, st); err != nil || !migrated {
		t.Fatalf("migration result migrated=%v err=%v", migrated, err)
	}
	managerCfg, ok, err := st.LoadManagerConfig(context.Background())
	if err != nil || !ok {
		t.Fatalf("load manager config ok=%v err=%v", ok, err)
	}
	if managerCfg.CPAConnection.CPABaseURL != "http://manager-cpa.local:8317" ||
		managerCfg.CPAConnection.ManagementKey != "manager-key" {
		t.Fatalf("manager config authority changed = %#v", managerCfg.CPAConnection)
	}
	managerRaw := rawBootstrapSettingValue(t, dbPath, "manager_config_v1")
	setupRaw := rawBootstrapSettingValue(t, dbPath, "setup")
	if !strings.Contains(managerRaw, "enc:v1:") || !strings.Contains(setupRaw, "enc:v1:") {
		t.Fatal("manager and legacy settings were not normalized to encrypted storage")
	}
	canonicalSetup, ok, err := st.LoadSetup(context.Background())
	if err != nil || !ok {
		t.Fatalf("load canonical setup ok=%v err=%v", ok, err)
	}
	if canonicalSetup.CPAUpstreamURL != managerCfg.CPAConnection.CPABaseURL ||
		canonicalSetup.ManagementKey != managerCfg.CPAConnection.ManagementKey {
		t.Fatalf("legacy setup did not follow manager config authority = %#v", canonicalSetup)
	}
}

func rawBootstrapSettingValue(t testing.TB, dbPath string, key string) string {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	defer db.Close()

	var raw string
	if err := db.QueryRow(`select value from settings where key = ?`, key).Scan(&raw); err != nil {
		t.Fatalf("load raw setting %s: %v", key, err)
	}
	return raw
}
