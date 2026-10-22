package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

type deployReply struct {
	line string
	err  error
}

// This is the wizard's final input. Subsequent Pulumi commands are noninteractive,
// so a reader still waiting when the countdown expires cannot steal their input.
func confirmDeployment() (bool, error) {
	replies := make(chan deployReply, 1)
	go func() { line, err := input.ReadString('\n'); replies <- deployReply{line, err} }()
	return deploymentCountdown(replies, os.Stdout, 5*time.Second)
}

func deploymentCountdown(replies <-chan deployReply, out io.Writer, timeout time.Duration) (bool, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	remaining := int(timeout / time.Second)
	show := func() {
		fmt.Fprintf(out, "\rDeploy now? Enter confirms; n cancels [yes]: deploying in %d seconds… ", remaining)
	}
	show()
	for {
		select {
		case reply := <-replies:
			fmt.Fprintln(out)
			if reply.err != nil {
				return false, fmt.Errorf("could not read deployment response: %w", reply.err)
			}
			answer := strings.ToLower(strings.TrimSpace(reply.line))
			return answer == "" || answer == "yes" || answer == "y" || answer == "deploy", nil
		case <-ticker.C:
			if remaining > 1 {
				remaining--
				show()
			}
		case <-deadline.C:
			fmt.Fprintln(out, "\nNo response after 5 seconds. Proceeding with deployment.")
			return true, nil
		}
	}
}
