package managerconfig

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func TestPublicConfigNeverSerializesManagementKey(t *testing.T) {
	const secret = "cpa-management-secret"
	public := PublicConfig(store.ManagerConfig{
		CPAConnection: store.ManagerCPAConnectionConfig{
			CPABaseURL:    "http://cpa.local:8317",
			ManagementKey: secret,
		},
	})

	data, err := json.Marshal(public)
	if err != nil {
		t.Fatalf("marshal public config: %v", err)
	}
	serialized := string(data)
	if strings.Contains(serialized, `"managementKey"`) || strings.Contains(serialized, secret) {
		t.Fatalf("public config leaked CPA management key: %s", serialized)
	}
	if !strings.Contains(serialized, `"managementKeyConfigured":true`) {
		t.Fatalf("public config lost configured-key state: %s", serialized)
	}
}

func TestMergeSubmittedManagerConfigPreservesWriteOnlyManagementKey(t *testing.T) {
	service := New(config.Config{}, nil, nil)
	base := service.DefaultManagerConfig()
	base.CPAConnection = store.ManagerCPAConnectionConfig{
		CPABaseURL:    "http://cpa.local:8317",
		ManagementKey: "saved-key",
	}

	tests := []struct {
		name      string
		submitted store.ManagerCPAConnectionConfig
		wantURL   string
		wantKey   string
	}{
		{
			name: "omitted key preserves existing key",
			submitted: store.ManagerCPAConnectionConfig{
				CPABaseURL: "http://next-cpa.local:8317",
			},
			wantURL: "http://next-cpa.local:8317",
			wantKey: "saved-key",
		},
		{
			name: "blank key fails closed by preserving existing key",
			submitted: store.ManagerCPAConnectionConfig{
				CPABaseURL:    "http://next-cpa.local:8317",
				ManagementKey: "   ",
			},
			wantURL: "http://next-cpa.local:8317",
			wantKey: "saved-key",
		},
		{
			name: "omitted URL does not clear the existing binding",
			submitted: store.ManagerCPAConnectionConfig{
				ManagementKey: "rotated-key",
			},
			wantURL: "http://cpa.local:8317",
			wantKey: "rotated-key",
		},
		{
			name: "blank connection does not clear the existing binding",
			submitted: store.ManagerCPAConnectionConfig{
				CPABaseURL:    "   ",
				ManagementKey: "   ",
			},
			wantURL: "http://cpa.local:8317",
			wantKey: "saved-key",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			submitted := base
			submitted.CPAConnection = tc.submitted
			got := service.MergeSubmittedManagerConfig(base, submitted)
			if got.CPAConnection.CPABaseURL != tc.wantURL ||
				got.CPAConnection.ManagementKey != tc.wantKey {
				t.Fatalf("merged connection = %#v, want URL=%q key=%q", got.CPAConnection, tc.wantURL, tc.wantKey)
			}
		})
	}
}

func TestMergeSubmittedManagerConfigKeepsEnvironmentBindingAuthoritative(t *testing.T) {
	service := New(config.Config{}, nil, nil)
	envConfig := service.DefaultManagerConfig()
	envConfig.CPAConnection = store.ManagerCPAConnectionConfig{
		CPABaseURL:    "http://env-cpa.local:8317",
		ManagementKey: "env-key",
	}

	omittedKeySubmission := envConfig
	omittedKeySubmission.CPAConnection = store.ManagerCPAConnectionConfig{CPABaseURL: "http://other.local:8317"}
	omittedKey := service.MergeSubmittedManagerConfig(envConfig, omittedKeySubmission)
	if !ManagerConfigConnectionDiffers(envConfig, omittedKey) {
		t.Fatal("URL rebind without a submitted key bypassed the env-managed boundary")
	}

	blankKeySubmission := envConfig
	blankKeySubmission.CPAConnection = store.ManagerCPAConnectionConfig{
		CPABaseURL:    "http://other.local:8317",
		ManagementKey: "   ",
	}
	blankKey := service.MergeSubmittedManagerConfig(envConfig, blankKeySubmission)
	if !ManagerConfigConnectionDiffers(envConfig, blankKey) {
		t.Fatal("URL rebind with a blank key bypassed the env-managed boundary")
	}
}
