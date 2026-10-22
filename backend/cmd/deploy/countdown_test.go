package main

import (
	"bytes"
	"io"
	"testing"
	"time"
)

func TestDeploymentCountdown(t *testing.T) {
	for _, tc := range []struct {
		line string
		want bool
	}{{"\n", true}, {"n\n", false}, {"yes\n", true}, {"other\n", false}} {
		replies := make(chan deployReply, 1)
		replies <- deployReply{line: tc.line}
		var out bytes.Buffer
		got, err := deploymentCountdown(replies, &out, time.Second)
		if err != nil || got != tc.want {
			t.Fatalf("%q got %v %v", tc.line, got, err)
		}
	}
	var out bytes.Buffer
	got, err := deploymentCountdown(make(chan deployReply), &out, time.Millisecond)
	if !got || err != nil {
		t.Fatal("timeout must deploy", got, err)
	}
	replies := make(chan deployReply, 1)
	replies <- deployReply{err: io.EOF}
	got, err = deploymentCountdown(replies, &out, time.Second)
	if got || err == nil {
		t.Fatal("input error must not deploy")
	}
}
