package main

import (
	"fmt"

	"example.com/shop/internal/cart"
	fmtx "example.com/shop/internal/format"
)

// main builds a small cart and prints what it costs.
func main() {
	c := cart.New()
	c.Add(cart.Item{Name: "tea", Cents: 450})
	total := cart.Total(c)
	fmt.Println(fmtx.Money(total))
}
