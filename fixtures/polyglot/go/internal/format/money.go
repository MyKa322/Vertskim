package format

import "strconv"

// Money renders cents as a decimal amount.
func Money(cents int) string {
	return strconv.Itoa(cents/100) + "." + pad(cents%100)
}

func pad(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}
