#include "shop/cart.hpp"

namespace shop {

void Cart::add(const Item& item) {
  items_.push_back(item);
  audit();
}

/// What the basket costs, tax included.
int Cart::total() const {
  int sum = 0;
  for (const auto& item : items_) sum += item.cents;
  return with_tax(sum);
}

void Cart::audit() {}

int with_tax(int cents) { return cents * 120 / 100; }

}  // namespace shop
