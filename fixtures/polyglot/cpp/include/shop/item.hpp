#pragma once
#include <string>

namespace shop {

/// Anything with a price in cents.
class Priced {
 public:
  virtual ~Priced() = default;
  virtual int total() const = 0;
};

/// One product and its price in cents.
struct Item {
  std::string name;
  int cents;
};

/// Adds the sales tax to an amount in cents.
int with_tax(int cents);

}  // namespace shop
