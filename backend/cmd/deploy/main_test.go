package main

import "testing"

func TestHostnameScope(t *testing.T) {
	for _, name := range []string{"audit.apexfission.com", "test.audit.apexfission.com"} {
		if !validDomain(name) {
			t.Errorf("rejected %s", name)
		}
	}
	for _, name := range []string{"apexfission.com", "audit.apexfission.com.evil.test", "-audit.apexfission.com", "audit..apexfission.com", "https://audit.apexfission.com", "audit.other.com", "audit*.apexfission.com"} {
		if validDomain(name) {
			t.Errorf("accepted %s", name)
		}
	}
}
