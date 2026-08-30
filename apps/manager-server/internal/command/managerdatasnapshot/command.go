package managerdatasnapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/processlock"
)

const manifestVersion = 1
const restoreIntentVersion = 1
const restorePhasePrepared = "prepared"
const restorePhaseCommitted = "committed"

var snapshotFiles = []snapshotFile{
	{Name: "database", DatabaseSuffix: ""},
	{Name: "database-wal", DatabaseSuffix: "-wal"},
	{Name: "database-shm", DatabaseSuffix: "-shm"},
	{Name: "database-journal", DatabaseSuffix: "-journal"},
	{Name: "data-key", DataKey: true},
}

type snapshotFile struct {
	Name           string
	DatabaseSuffix string
	DataKey        bool
}

type manifest struct {
	Version int                      `json:"version"`
	Files   map[string]manifestEntry `json:"files"`
}

type manifestEntry struct {
	Existed bool   `json:"existed"`
	Mode    uint32 `json:"mode,omitempty"`
	Size    int64  `json:"size,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
}

type options struct {
	Action      string
	DBPath      string
	DataKeyPath string
	SnapshotDir string
}

func Run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	opts, err := parseArgs(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	switch opts.Action {
	case "create":
		if err := withDatabaseLock(opts.DBPath, func(dbPath string) error {
			if err := Recover(dbPath, opts.DataKeyPath); err != nil {
				return err
			}
			return create(ctx, dbPath, opts.DataKeyPath, opts.SnapshotDir)
		}); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Manager data snapshot created at %s.\n", opts.SnapshotDir)
	case "restore":
		var outcome restoreOutcome
		if err := withDatabaseLock(opts.DBPath, func(dbPath string) error {
			var err error
			outcome, err = restoreWithWarnings(ctx, dbPath, opts.DataKeyPath, opts.SnapshotDir)
			return err
		}); err != nil {
			return err
		}
		for _, warning := range outcome.cleanupWarnings {
			_, _ = fmt.Fprintf(stderr, "Warning: %s\n", warning)
		}
		_, _ = fmt.Fprintf(stdout, "Manager data restored from %s.\n", opts.SnapshotDir)
	case "delete":
		if err := deleteSnapshot(opts.SnapshotDir); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Manager data snapshot deleted at %s.\n", opts.SnapshotDir)
	default:
		return fmt.Errorf("unsupported action %q", opts.Action)
	}
	return nil
}

func parseArgs(args []string, stderr io.Writer) (options, error) {
	if len(args) == 0 {
		return options{}, errors.New("snapshot action is required: create, restore, or delete")
	}
	opts := options{Action: args[0]}
	fs := flag.NewFlagSet("manager-data-snapshot "+opts.Action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.DBPath, "db-path", "", "SQLite database path")
	fs.StringVar(&opts.DataKeyPath, "data-key-path", "", "data.key path")
	fs.StringVar(&opts.SnapshotDir, "snapshot-dir", "", "private snapshot directory")
	fs.Usage = func() {
		_, _ = fmt.Fprintln(stderr, "Usage: cpa-manager-plus manager-data-snapshot <create|restore|delete> --snapshot-dir PATH [--db-path PATH --data-key-path PATH]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args[1:]); err != nil {
		return options{}, err
	}
	if fs.NArg() > 0 {
		return options{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	opts.DBPath = strings.TrimSpace(opts.DBPath)
	opts.DataKeyPath = strings.TrimSpace(opts.DataKeyPath)
	opts.SnapshotDir = strings.TrimSpace(opts.SnapshotDir)
	if opts.SnapshotDir == "" {
		return options{}, errors.New("--snapshot-dir is required")
	}
	if opts.Action == "create" || opts.Action == "restore" {
		if opts.DBPath == "" {
			return options{}, errors.New("--db-path is required")
		}
		if opts.DataKeyPath == "" {
			return options{}, errors.New("--data-key-path is required")
		}
	}
	return opts, nil
}

func withDatabaseLock(dbPath string, fn func(string) error) error {
	databaseLock, err := processlock.Acquire(dbPath)
	if err != nil {
		return fmt.Errorf("acquire Manager data snapshot lock; stop Manager Server and retry: %w", err)
	}
	defer func() { _ = databaseLock.Close() }()
	return fn(databaseLock.DatabasePath())
}

func create(ctx context.Context, dbPath string, dataKeyPath string, snapshotDir string) (returnErr error) {
	absSnapshotDir, err := filepath.Abs(snapshotDir)
	if err != nil {
		return fmt.Errorf("resolve snapshot directory: %w", err)
	}
	if _, err := os.Lstat(absSnapshotDir); err == nil {
		return fmt.Errorf("snapshot directory already exists: %s", absSnapshotDir)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect snapshot directory %s: %w", absSnapshotDir, err)
	}
	parent := filepath.Dir(absSnapshotDir)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create snapshot parent %s: %w", parent, err)
	}
	tempDir, err := os.MkdirTemp(parent, ".cpamp-manager-snapshot-tmp-")
	if err != nil {
		return fmt.Errorf("create temporary snapshot directory: %w", err)
	}
	defer func() {
		if returnErr != nil {
			_ = os.RemoveAll(tempDir)
		}
	}()
	if err := os.Chmod(tempDir, 0o700); err != nil {
		return fmt.Errorf("protect temporary snapshot directory: %w", err)
	}

	m := manifest{Version: manifestVersion, Files: make(map[string]manifestEntry, len(snapshotFiles))}
	for _, item := range snapshotFiles {
		source := sourcePath(item, dbPath, dataKeyPath)
		entry, err := snapshotOne(ctx, source, filepath.Join(tempDir, item.Name))
		if err != nil {
			return fmt.Errorf("snapshot %s: %w", source, err)
		}
		m.Files[item.Name] = entry
	}
	manifestData, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("encode snapshot manifest: %w", err)
	}
	manifestData = append(manifestData, '\n')
	if err := writeNewFile(filepath.Join(tempDir, "manifest.json"), manifestData, 0o600); err != nil {
		return fmt.Errorf("write snapshot manifest: %w", err)
	}
	beforeSnapshotPublishFn()
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("snapshot canceled before publish: %w", err)
	}
	if err := os.Rename(tempDir, absSnapshotDir); err != nil {
		return fmt.Errorf("publish snapshot directory %s: %w", absSnapshotDir, err)
	}
	return syncPathDir(absSnapshotDir)
}

func snapshotOne(ctx context.Context, source string, target string) (manifestEntry, error) {
	info, err := os.Lstat(source)
	if os.IsNotExist(err) {
		return manifestEntry{}, nil
	}
	if err != nil {
		return manifestEntry{}, err
	}
	if !info.Mode().IsRegular() {
		return manifestEntry{}, fmt.Errorf("source is not a regular file")
	}
	digest, size, err := copyFile(ctx, source, target, 0o600)
	if err != nil {
		return manifestEntry{}, err
	}
	return manifestEntry{
		Existed: true,
		Mode:    uint32(info.Mode().Perm()),
		Size:    size,
		SHA256:  digest,
	}, nil
}

// renameFn is a fault-injection seam for tests. Production restore commits
// use os.Rename; the rollback path always calls os.Rename directly so an
// injected forward failure still rolls back with real filesystem calls.
var renameFn = os.Rename

// removeFn is used only for post-commit rollback-slot cleanup. It is a test
// seam for proving that a cleanup failure cannot turn a committed restore into
// a business failure. Required rollback/removal paths continue to use os.Remove
// directly so fault injection cannot weaken recovery.
var removeFn = os.Remove

// These no-op hooks make cancellation at the two commit boundaries
// deterministic in tests without changing production behavior.
var beforeSnapshotPublishFn = func() {}
var beforeRestoreCommitFn = func() {}
var afterRestoreRenameFn = func(string, int) {}

type restoreOutcome struct {
	cleanupWarnings []string
}

type restoreIntent struct {
	Version int                  `json:"version"`
	Phase   string               `json:"phase"`
	Entries []restoreIntentEntry `json:"entries"`
}

type restoreIntentEntry struct {
	Name            string `json:"name"`
	Target          string `json:"target"`
	Staged          string `json:"staged,omitempty"`
	Rollback        string `json:"rollback"`
	SnapshotExisted bool   `json:"snapshot_existed"`
	LiveExisted     bool   `json:"live_existed"`
}

// restore swaps the whole Manager file-set (database, sidecars, data.key) as
// one logical transaction. A usage.sqlite restored without its matching
// data.key is unrecoverable, so the commit phase first moves every live file
// into a rollback slot next to it; any later failure reverses the whole set
// instead of leaving a half-restored state behind.
// restore keeps the historical package-local helper signature for callers
// that do not need to capture warnings. The command path uses
// restoreWithWarnings so it can report retained cleanup artifacts on stderr.
func restore(ctx context.Context, dbPath string, dataKeyPath string, snapshotDir string) error {
	outcome, err := restoreWithWarnings(ctx, dbPath, dataKeyPath, snapshotDir)
	for _, warning := range outcome.cleanupWarnings {
		_, _ = fmt.Fprintf(os.Stderr, "Warning: %s\n", warning)
	}
	return err
}

func restoreWithWarnings(ctx context.Context, dbPath string, dataKeyPath string, snapshotDir string) (restoreOutcome, error) {
	var outcome restoreOutcome
	if err := Recover(dbPath, dataKeyPath); err != nil {
		return outcome, err
	}
	absSnapshotDir, m, err := loadManifest(snapshotDir)
	if err != nil {
		return outcome, err
	}

	intent := restoreIntent{Version: restoreIntentVersion, Phase: restorePhasePrepared}
	staged := make([]string, 0, len(snapshotFiles))
	defer func() {
		for _, path := range staged {
			_ = os.Remove(path)
		}
	}()
	for _, item := range snapshotFiles {
		entry := m.Files[item.Name]
		target, err := filepath.Abs(sourcePath(item, dbPath, dataKeyPath))
		if err != nil {
			return outcome, fmt.Errorf("resolve restore target: %w", err)
		}
		if err := ensureRestorableTarget(target); err != nil {
			return outcome, err
		}
		_, liveErr := os.Lstat(target)
		liveExisted := liveErr == nil
		if liveErr != nil && !os.IsNotExist(liveErr) {
			return outcome, fmt.Errorf("inspect live file %s: %w", target, liveErr)
		}
		journalEntry := restoreIntentEntry{
			Name: item.Name, Target: target, SnapshotExisted: entry.Existed, LiveExisted: liveExisted,
			Rollback: restoreRollbackPath(target),
		}
		if _, err := os.Lstat(journalEntry.Rollback); err == nil {
			return outcome, fmt.Errorf("restore rollback slot already exists: %s", journalEntry.Rollback)
		} else if !os.IsNotExist(err) {
			return outcome, fmt.Errorf("inspect restore rollback slot %s: %w", journalEntry.Rollback, err)
		}
		if entry.Existed {
			journalEntry.Staged, err = stageRestoreFile(ctx, filepath.Join(absSnapshotDir, item.Name), target, entry)
			if err != nil {
				return outcome, err
			}
			staged = append(staged, journalEntry.Staged)
		}
		intent.Entries = append(intent.Entries, journalEntry)
	}
	beforeRestoreCommitFn()
	if err := ctx.Err(); err != nil {
		return outcome, fmt.Errorf("restore canceled before commit: %w", err)
	}
	if err := writeRestoreIntent(dbPath, intent); err != nil {
		return outcome, err
	}

	fail := func(cause error) (restoreOutcome, error) {
		recoveryErr := recoverRestoreIntent(dbPath, dataKeyPath)
		if recoveryErr != nil {
			return outcome, fmt.Errorf("%v; durable restore recovery failed: %w", cause, recoveryErr)
		}
		return outcome, fmt.Errorf("%w; restored pre-restore state", cause)
	}
	for index, entry := range intent.Entries {
		if !entry.LiveExisted {
			continue
		}
		if err := renameFn(entry.Target, entry.Rollback); err != nil {
			return fail(fmt.Errorf("move live file %s aside: %w", entry.Target, err))
		}
		if err := syncPathDir(entry.Target); err != nil {
			return fail(err)
		}
		afterRestoreRenameFn("live", index)
	}
	for index, entry := range intent.Entries {
		if !entry.SnapshotExisted {
			continue
		}
		if err := renameFn(entry.Staged, entry.Target); err != nil {
			return fail(fmt.Errorf("restore %s: %w", entry.Target, err))
		}
		if err := syncPathDir(entry.Target); err != nil {
			return fail(err)
		}
		afterRestoreRenameFn("snapshot", index)
	}
	intent.Phase = restorePhaseCommitted
	if err := writeRestoreIntent(dbPath, intent); err != nil {
		return fail(err)
	}
	warnings, err := finishCommittedRestore(restoreIntentPath(dbPath), intent, true)
	if err != nil {
		return outcome, err
	}
	outcome.cleanupWarnings = append(outcome.cleanupWarnings, warnings...)
	for _, entry := range intent.Entries {
		for index, value := range staged {
			if value == entry.Staged {
				staged[index] = ""
			}
		}
	}
	return outcome, nil
}

// ensureRestorableTarget rejects symlinked or special restore targets before
// anything is staged, so a restore never renames a link away and replaces it
// with attacker-controlled content.

func restoreIntentPath(dbPath string) string {
	return dbPath + ".restore-intent.json"
}

func restoreRollbackPath(target string) string {
	return filepath.Join(filepath.Dir(target), ".cpamp-restore-rollback-intent-"+filepath.Base(target))
}

// Recover deterministically completes or rolls back an interrupted restore.
// Callers must hold the Manager database process lock.
func Recover(dbPath string, dataKeyPath string) error {
	return recoverRestoreIntent(dbPath, dataKeyPath)
}

func recoverRestoreIntent(dbPath string, dataKeyPath string) error {
	journalPath := restoreIntentPath(dbPath)
	info, err := os.Lstat(journalPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect restore intent %s: %w", journalPath, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("restore intent %s is not a regular file", journalPath)
	}
	data, err := os.ReadFile(journalPath)
	if err != nil {
		return fmt.Errorf("read restore intent: %w", err)
	}
	var intent restoreIntent
	if err := json.Unmarshal(data, &intent); err != nil {
		return fmt.Errorf("decode restore intent: %w", err)
	}
	if err := validateRestoreIntent(intent, dbPath, dataKeyPath); err != nil {
		return err
	}
	if intent.Phase == restorePhaseCommitted {
		_, err := finishCommittedRestore(journalPath, intent, false)
		return err
	} else {
		for index := len(intent.Entries) - 1; index >= 0; index-- {
			entry := intent.Entries[index]
			if entry.LiveExisted {
				if _, err := os.Lstat(entry.Rollback); err == nil {
					if err := removeRegularFile(entry.Target); err != nil {
						return err
					}
					if err := os.Rename(entry.Rollback, entry.Target); err != nil {
						return fmt.Errorf("recover live file %s: %w", entry.Target, err)
					}
					if err := syncPathDir(entry.Target); err != nil {
						return err
					}
				} else if !os.IsNotExist(err) {
					return fmt.Errorf("inspect rollback slot %s: %w", entry.Rollback, err)
				} else if err := requireRegularFile(entry.Target); err != nil {
					return fmt.Errorf("original restore target missing: %w", err)
				}
			} else if err := removeRegularFile(entry.Target); err != nil {
				return err
			}
			if entry.Staged != "" {
				if err := removeRegularFile(entry.Staged); err != nil {
					return err
				}
			}
		}
	}
	if err := os.Remove(journalPath); err != nil {
		return fmt.Errorf("remove restore intent: %w", err)
	}
	return syncPathDir(journalPath)
}

func finishCommittedRestore(journalPath string, intent restoreIntent, warnOnRollbackCleanup bool) ([]string, error) {
	var warnings []string
	for _, entry := range intent.Entries {
		if entry.SnapshotExisted {
			if err := requireRegularFile(entry.Target); err != nil {
				return nil, fmt.Errorf("committed restore target invalid: %w", err)
			}
		} else if err := removeRegularFile(entry.Target); err != nil {
			return nil, err
		}
		if warnOnRollbackCleanup {
			if err := removeRestoreRollbackFile(entry.Rollback); err != nil {
				warnings = append(warnings, fmt.Sprintf("rollback slot %s retained for next-start recovery: %v", entry.Rollback, err))
			}
		} else if err := removeRegularFile(entry.Rollback); err != nil {
			return nil, err
		}
		if entry.Staged != "" {
			if err := removeRegularFile(entry.Staged); err != nil {
				return nil, err
			}
		}
	}
	if len(warnings) > 0 {
		return warnings, nil
	}
	if err := os.Remove(journalPath); err != nil {
		return nil, fmt.Errorf("remove restore intent: %w", err)
	}
	return nil, syncPathDir(journalPath)
}

func removeRestoreRollbackFile(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refuse to remove non-regular restore file %s", path)
	}
	if err := removeFn(path); err != nil {
		return err
	}
	return syncPathDir(path)
}

func validateRestoreIntent(intent restoreIntent, dbPath string, dataKeyPath string) error {
	if intent.Version != restoreIntentVersion || (intent.Phase != restorePhasePrepared && intent.Phase != restorePhaseCommitted) {
		return errors.New("unsupported restore intent")
	}
	expected := make(map[string]string, len(snapshotFiles))
	for _, item := range snapshotFiles {
		target, err := filepath.Abs(sourcePath(item, dbPath, dataKeyPath))
		if err != nil {
			return err
		}
		expected[item.Name] = target
	}
	if len(intent.Entries) != len(expected) {
		return errors.New("incomplete restore intent")
	}
	for _, entry := range intent.Entries {
		if expected[entry.Name] != entry.Target || entry.Rollback != restoreRollbackPath(entry.Target) {
			return fmt.Errorf("restore intent contains an unexpected target for %s", entry.Name)
		}
		if entry.SnapshotExisted && filepath.Dir(entry.Staged) != filepath.Dir(entry.Target) {
			return fmt.Errorf("restore intent staged path is outside target directory for %s", entry.Name)
		}
	}
	return nil
}

func writeRestoreIntent(dbPath string, intent restoreIntent) error {
	journalPath := restoreIntentPath(dbPath)
	if info, err := os.Lstat(journalPath); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("restore intent %s is not a regular file", journalPath)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect restore intent %s: %w", journalPath, err)
	}
	data, err := json.MarshalIndent(intent, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tempPath := journalPath + ".tmp"
	if err := removeRegularFile(tempPath); err != nil {
		return err
	}
	if err := writeNewFile(tempPath, data, 0o600); err != nil {
		return fmt.Errorf("write restore intent: %w", err)
	}
	if err := os.Rename(tempPath, journalPath); err != nil {
		return fmt.Errorf("publish restore intent: %w", err)
	}
	return syncPathDir(journalPath)
}

func requireRegularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is not a regular file", path)
	}
	return nil
}

func removeRegularFile(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect %s: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refuse to remove non-regular restore file %s", path)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return syncPathDir(path)
}

func syncPathDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open directory for fsync %s: %w", filepath.Dir(path), err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("fsync directory %s: %w", filepath.Dir(path), err)
	}
	return nil
}

func ensureRestorableTarget(target string) error {
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect restore target %s: %w", target, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("restore target %s is not a regular file", target)
	}
	return nil
}

func stageRestoreFile(ctx context.Context, source string, target string, entry manifestEntry) (string, error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", fmt.Errorf("create restore directory for %s: %w", target, err)
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".cpamp-restore-*")
	if err != nil {
		return "", fmt.Errorf("create restore file for %s: %w", target, err)
	}
	tempPath := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("close restore file for %s: %w", target, err)
	}
	if err := os.Remove(tempPath); err != nil {
		return "", fmt.Errorf("prepare restore file for %s: %w", target, err)
	}
	digest, size, err := copyFile(ctx, source, tempPath, os.FileMode(entry.Mode))
	if err != nil {
		return "", fmt.Errorf("stage restore for %s: %w", target, err)
	}
	if size != entry.Size || digest != entry.SHA256 {
		return "", fmt.Errorf("snapshot file %s failed integrity validation", filepath.Base(source))
	}
	return tempPath, nil
}

func reserveRollbackSlot(target string) (string, error) {
	temp, err := os.CreateTemp(filepath.Dir(target), ".cpamp-restore-rollback-*")
	if err != nil {
		return "", fmt.Errorf("create rollback slot for %s: %w", target, err)
	}
	slot := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(slot)
		return "", fmt.Errorf("close rollback slot for %s: %w", target, err)
	}
	if err := os.Remove(slot); err != nil {
		return "", fmt.Errorf("prepare rollback slot for %s: %w", target, err)
	}
	return slot, nil
}

// syncTargetDirs best-effort fsyncs the parent directories of the restored
// set so the commit survives a crash shortly after restore returns.
func syncTargetDirs(targets []string) {
	seen := make(map[string]bool)
	for _, target := range targets {
		dir := filepath.Dir(target)
		if seen[dir] {
			continue
		}
		seen[dir] = true
		file, err := os.Open(dir)
		if err != nil {
			continue
		}
		_ = file.Sync()
		_ = file.Close()
	}
}

func loadManifest(snapshotDir string) (string, manifest, error) {
	absSnapshotDir, err := filepath.Abs(snapshotDir)
	if err != nil {
		return "", manifest{}, fmt.Errorf("resolve snapshot directory: %w", err)
	}
	info, err := os.Lstat(absSnapshotDir)
	if err != nil {
		return "", manifest{}, fmt.Errorf("inspect snapshot directory %s: %w", absSnapshotDir, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", manifest{}, fmt.Errorf("snapshot path is not a directory: %s", absSnapshotDir)
	}
	data, err := os.ReadFile(filepath.Join(absSnapshotDir, "manifest.json"))
	if err != nil {
		return "", manifest{}, fmt.Errorf("read snapshot manifest: %w", err)
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return "", manifest{}, fmt.Errorf("decode snapshot manifest: %w", err)
	}
	if m.Version != manifestVersion || len(m.Files) != len(snapshotFiles) {
		return "", manifest{}, errors.New("unsupported or incomplete snapshot manifest")
	}
	for _, item := range snapshotFiles {
		entry, ok := m.Files[item.Name]
		if !ok {
			return "", manifest{}, fmt.Errorf("snapshot manifest is missing %s", item.Name)
		}
		if entry.Existed && (entry.SHA256 == "" || entry.Size < 0 || entry.Mode > 0o777) {
			return "", manifest{}, fmt.Errorf("snapshot manifest has invalid metadata for %s", item.Name)
		}
	}
	return absSnapshotDir, m, nil
}

func deleteSnapshot(snapshotDir string) error {
	absSnapshotDir, _, err := loadManifest(snapshotDir)
	if err != nil {
		// A missing manifest with the directory still present usually means an
		// earlier delete removed files but failed before the final rmdir.
		if info, statErr := os.Lstat(absSnapshotDir); statErr == nil && info.IsDir() {
			return fmt.Errorf("%w; snapshot directory %s is incomplete (possibly a partially failed earlier delete); verify it is no longer needed and remove the directory manually", err, absSnapshotDir)
		}
		return err
	}
	allowed := map[string]bool{"manifest.json": true}
	for _, item := range snapshotFiles {
		allowed[item.Name] = true
	}
	entries, err := os.ReadDir(absSnapshotDir)
	if err != nil {
		return fmt.Errorf("inspect snapshot directory %s: %w", absSnapshotDir, err)
	}
	for _, entry := range entries {
		if !allowed[entry.Name()] {
			return fmt.Errorf("snapshot directory contains unexpected entry %s", entry.Name())
		}
	}
	for _, item := range snapshotFiles {
		if err := os.Remove(filepath.Join(absSnapshotDir, item.Name)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("delete snapshot file %s: %w", item.Name, err)
		}
	}
	if err := os.Remove(filepath.Join(absSnapshotDir, "manifest.json")); err != nil {
		return fmt.Errorf("delete snapshot manifest: %w", err)
	}
	if err := os.Remove(absSnapshotDir); err != nil {
		return fmt.Errorf("delete snapshot directory %s: %w", absSnapshotDir, err)
	}
	return nil
}

func sourcePath(item snapshotFile, dbPath string, dataKeyPath string) string {
	if item.DataKey {
		return dataKeyPath
	}
	return dbPath + item.DatabaseSuffix
}

func copyFile(ctx context.Context, source string, target string, mode os.FileMode) (string, int64, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", 0, err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode.Perm())
	if err != nil {
		return "", 0, err
	}
	removeTarget := true
	defer func() {
		_ = output.Close()
		if removeTarget {
			_ = os.Remove(target)
		}
	}()
	hash := sha256.New()
	written, err := copyWithContext(ctx, io.MultiWriter(output, hash), input)
	if err != nil {
		return "", 0, err
	}
	if err := output.Sync(); err != nil {
		return "", 0, err
	}
	if err := output.Close(); err != nil {
		return "", 0, err
	}
	removeTarget = false
	return hex.EncodeToString(hash.Sum(nil)), written, nil
}

func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buffer := make([]byte, 1024*1024)
	var written int64
	for {
		select {
		case <-ctx.Done():
			return written, ctx.Err()
		default:
		}
		read, readErr := src.Read(buffer)
		if read > 0 {
			count, writeErr := dst.Write(buffer[:read])
			written += int64(count)
			if writeErr != nil {
				return written, writeErr
			}
			if count != read {
				return written, io.ErrShortWrite
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func writeNewFile(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
