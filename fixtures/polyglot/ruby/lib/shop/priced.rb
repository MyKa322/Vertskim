module Shop
  # Mixed into anything with a price in cents.
  module Priced
    # The price with sales tax added.
    def with_tax
      price * 120 / 100
    end
  end
end
