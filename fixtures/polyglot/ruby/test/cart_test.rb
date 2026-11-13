require "minitest/autorun"
require_relative "../lib/shop/cart"

class CartTest < Minitest::Test
  def test_total
    cart = Shop::Cart.new
    cart.add(Shop::Item.new("tea", 100))
    assert_equal 120, cart.total
  end
end
