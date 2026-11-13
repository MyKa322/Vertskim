#include <iostream>

#include "legacy.h"
#include "shop/cart.hpp"

int main() {
  shop::Cart cart;
  cart.add(shop::Item{"tea", 300});
  std::cout << cart.total() << std::endl;
  log_total(cart.total());
  return 0;
}
