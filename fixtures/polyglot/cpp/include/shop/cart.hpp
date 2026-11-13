#pragma once
#include <vector>

#include "shop/item.hpp"

namespace shop {

/// A basket of items.
class Cart : public Priced {
 public:
  /// Puts an item in the basket.
  void add(const Item& item);
  int total() const override;
  bool empty() const { return items_.empty(); }

 private:
  void audit();
  std::vector<Item> items_;
};

}  // namespace shop
