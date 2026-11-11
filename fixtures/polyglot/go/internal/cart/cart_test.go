package cart

import "testing"

func TestTotal(t *testing.T) {
	c := New()
	c.Add(Item{Name: "tea", Cents: 100})
	if got := Total(c); got != 120 {
		t.Fatalf("got %d", got)
	}
}
