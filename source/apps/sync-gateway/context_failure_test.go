package main

import (
	"context"
	"fmt"
	"testing"
)

func TestContextFailureClass(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{{context.Canceled, "canceled"}, {fmt.Errorf("wrapped: %w", context.DeadlineExceeded), "deadline"}, {nil, "unknown"}} {
		if got := contextFailureClass(c.err); got != c.want {
			t.Fatalf("got %s want %s", got, c.want)
		}
	}
}
