require_relative "item"

module Shop
  # A basket of items.
  class Cart
    def initialize
      @items = []
    end

    # Puts an item in the basket.
    def add(item)
      @items << item
      audit
      self
    end

    # What the basket costs, tax included.
    def total
      @items.sum { |item| item.with_tax }
    end

    def self.open
      new
    end

    private

    def audit; end
  end
end
