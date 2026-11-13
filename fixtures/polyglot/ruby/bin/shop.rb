require_relative "../lib/shop"

cart = Shop::Cart.open
cart.add(Shop::Item.new("tea", 300))
puts cart.total
